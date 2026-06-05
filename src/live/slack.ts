import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

import type { ResolvedConversation, SlackAccountConfig } from "../core/config-types.js";
import type { InboundMessageInput } from "../core/runtime-types.js";
import { chunkText } from "../render/chunking.js";
import { formatMarkdownForService, maxMessageLength } from "../render/format.js";
import { StreamingPreview } from "../render/streaming.js";
import { fetchBinary, readLocalAttachment, storeDownloadedAttachment, textMentionsBot } from "./common.js";
import type { LiveConnection, LiveConnectionHandlers, ResumeState } from "./types.js";

export interface SlackEventEnvelope {
	ack?: () => Promise<void> | void;
	body?: { event_id?: string; event?: SlackMessageEvent };
	event?: SlackMessageEvent;
}

export interface SlackFile {
	id?: string;
	name?: string;
	title?: string;
	mimetype?: string;
	url_private_download?: string;
	url_private?: string;
}

export interface SlackMessageEvent {
	type?: string;
	subtype?: string;
	channel?: string;
	channel_type?: string;
	user?: string;
	username?: string;
	bot_id?: string;
	text?: string;
	ts?: string;
	thread_ts?: string;
	files?: SlackFile[];
}

export class SlackEventDeduplicator {
	private readonly seen = new Map<string, number>();

	constructor(private readonly ttlMs = 5 * 60 * 1000) {}

	seenOrRecord(key: string | undefined): boolean {
		if (!key) return false;
		const now = Date.now();
		for (const [storedKey, storedAt] of this.seen.entries()) {
			if (now - storedAt > this.ttlMs) this.seen.delete(storedKey);
		}
		if (this.seen.has(key)) return true;
		this.seen.set(key, now);
		return false;
	}
}

function isTargetChannel(conversation: ResolvedConversation, event: SlackMessageEvent): boolean {
	return event.channel === conversation.channel.id;
}

export function slackDedupeKey(payload: SlackEventEnvelope, event: SlackMessageEvent): string | undefined {
	return (
		payload.body?.event_id || (event.channel && event.ts ? `${event.channel}:${event.ts}:${event.type}` : undefined)
	);
}

export async function slackMessageToInput(
	conversation: ResolvedConversation,
	account: SlackAccountConfig,
	event: SlackMessageEvent,
): Promise<InboundMessageInput | undefined> {
	if (!isTargetChannel(conversation, event)) return undefined;
	if (event.subtype === "message_deleted" || event.subtype === "message_changed") return undefined;
	if (event.bot_id || event.subtype === "bot_message" || event.user === account.botUserId) return undefined;
	const messageId = event.ts || `${Date.now()}`;
	const text = event.text || "";
	const attachments: NonNullable<InboundMessageInput["attachments"]> = [];
	let index = 0;
	for (const file of event.files ?? []) {
		const url = file.url_private_download || file.url_private;
		if (!url) continue;
		const data = await fetchBinary(url, { Authorization: `Bearer ${account.botToken}` });
		attachments.push(
			await storeDownloadedAttachment(
				conversation,
				messageId,
				++index,
				file.name || file.title || `slack-file-${index}`,
				data,
				file.mimetype,
				url,
			),
		);
	}
	return {
		messageId,
		userId: event.user || event.bot_id || "unknown",
		userName: event.username,
		text,
		mentionedBot: textMentionsBot(text, account.botUsername, account.botUserId),
		isBot: Boolean(event.bot_id || event.subtype === "bot_message"),
		attachments,
	};
}

export async function sendSlackMessage(
	client: WebClient,
	conversation: ResolvedConversation,
	text: string,
	attachmentPaths: string[] = [],
	signal?: AbortSignal,
	replyToMessageId?: string,
): Promise<string> {
	const rendered = formatMarkdownForService("slack", text);
	const chunks = chunkText(rendered.text, maxMessageLength("slack"));
	let firstMessageTs: string | undefined;
	for (let i = 0; i < chunks.length; i++) {
		const response = await client.chat.postMessage({
			channel: conversation.channel.id,
			text: chunks[i],
			thread_ts: i === 0 ? replyToMessageId : firstMessageTs || replyToMessageId,
		});
		if (!response.ok || !response.ts) throw new Error(response.error || "Slack send failed");
		firstMessageTs ??= response.ts;
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	}
	for (const path of attachmentPaths) {
		const file = await readLocalAttachment(path);
		const threadTs = firstMessageTs || replyToMessageId;
		if (threadTs) {
			await client.files.uploadV2({
				channel_id: conversation.channel.id,
				thread_ts: threadTs,
				filename: file.name,
				file: Buffer.from(file.data),
			});
		} else {
			await client.files.uploadV2({
				channel_id: conversation.channel.id,
				filename: file.name,
				file: Buffer.from(file.data),
			});
		}
	}
	return firstMessageTs || "";
}

async function catchUp(
	client: WebClient,
	conversation: ResolvedConversation,
	account: SlackAccountConfig,
	handlers: LiveConnectionHandlers,
	cursor?: string,
): Promise<void> {
	const response = await client.conversations.history({
		channel: conversation.channel.id,
		oldest: cursor,
		limit: 100,
		inclusive: false,
	});
	const messages = [...((response.messages ?? []) as SlackMessageEvent[])].reverse();
	for (const message of messages) {
		const input = await slackMessageToInput(conversation, account, message);
		if (!input) continue;
		await handlers.onMessage(input, { cursor: input.messageId, messageId: input.messageId });
	}
}

export async function connectSlackLive(
	conversation: ResolvedConversation,
	handlers: LiveConnectionHandlers,
	resumeState?: ResumeState,
): Promise<LiveConnection> {
	const account = conversation.account as SlackAccountConfig;
	const web = new WebClient(account.botToken);
	const socket = new SocketModeClient({ appToken: account.appToken });
	const deduplicator = new SlackEventDeduplicator();
	const preview = new StreamingPreview(conversation.service, {
		create: async (text, _parseMode, replyToMessageId) =>
			sendSlackMessage(web, conversation, text, [], undefined, replyToMessageId),
		edit: async (id, text) => {
			await web.chat.update({ channel: conversation.channel.id, ts: id, text });
		},
		delete: async (id) => {
			await web.chat.delete({ channel: conversation.channel.id, ts: id });
		},
	});
	await catchUp(web, conversation, account, handlers, resumeState?.cursor);
	await handlers.onCaughtUp();
	socket.on("slack_event", async (payload: SlackEventEnvelope) => {
		try {
			await payload.ack?.();
			const event = payload.event || payload.body?.event;
			if (!event) return;
			if (deduplicator.seenOrRecord(slackDedupeKey(payload, event))) return;
			const input = await slackMessageToInput(conversation, account, event);
			if (!input) return;
			await handlers.onMessage(input, { cursor: input.messageId, messageId: input.messageId });
		} catch (error) {
			await handlers.onError(error instanceof Error ? error : new Error(String(error)));
		}
	});
	socket.on("error", (error) => {
		void handlers.onError(error instanceof Error ? error : new Error(String(error)));
	});
	socket.on("disconnect", () => {
		void handlers.onDisconnect?.();
	});
	await socket.start();
	return {
		conversation,
		disconnect: async () => {
			await socket.disconnect();
		},
		sendImmediate: async (text, replyToMessageId) =>
			sendSlackMessage(web, conversation, text, [], undefined, replyToMessageId),
		send: async (text, attachmentPaths = [], signal, replyToMessageId) =>
			sendSlackMessage(web, conversation, text, attachmentPaths, signal, replyToMessageId),
		startTyping: async () => {},
		stopTyping: async () => {},
		syncPreview: async (markdown, done = false) => preview.update(markdown, done),
		clearPreview: async () => preview.clear(),
		setReplyTo: (messageId) => preview.setReplyTo(messageId),
	};
}
