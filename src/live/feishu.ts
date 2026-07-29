import { extname } from "node:path";

import * as Lark from "@larksuiteoapi/node-sdk";

import type { FeishuAccountConfig, ResolvedConversation } from "../core/config-types.js";
import type { InboundMessageInput } from "../core/runtime-types.js";
import { chunkText } from "../render/chunking.js";
import { formatMarkdownForService, maxMessageLength } from "../render/format.js";
import { StreamingPreview } from "../render/streaming.js";
import { createFeishuClient } from "../services/feishu.js";
import { guessAttachmentKind, readLocalAttachment, storeDownloadedAttachment } from "./common.js";
import type { LiveConnection, LiveConnectionHandlers, ResumeState } from "./types.js";

interface FeishuMention {
	key: string;
	id?: { open_id?: string; user_id?: string; union_id?: string };
	name?: string;
}

interface FeishuMessage {
	messageId: string;
	chatId: string;
	chatType: string;
	messageType: string;
	content: string;
	createTime: string;
	senderId: string;
	senderName?: string;
	senderType?: string;
	mentions?: FeishuMention[];
}

interface FeishuReceiveEvent {
	sender: {
		sender_id?: { open_id?: string; user_id?: string; union_id?: string };
		sender_type?: string;
	};
	message: {
		message_id: string;
		create_time: string;
		chat_id: string;
		chat_type: string;
		message_type: string;
		content: string;
		mentions?: FeishuMention[];
	};
}

interface CursorState {
	time: number;
	ids: string[];
}

function parseCursor(cursor?: string): CursorState {
	if (!cursor) return { time: 0, ids: [] };
	try {
		const parsed = JSON.parse(cursor) as Partial<CursorState>;
		return {
			time: typeof parsed.time === "number" ? parsed.time : 0,
			ids: Array.isArray(parsed.ids) ? parsed.ids.filter((id): id is string => typeof id === "string") : [],
		};
	} catch {
		const legacy = Number(cursor);
		return { time: Number.isFinite(legacy) ? legacy : 0, ids: [] };
	}
}

function updateCursor(state: CursorState, message: FeishuMessage): string {
	const time = Number(message.createTime) || Date.now();
	if (time > state.time) {
		state.time = time;
		state.ids = [message.messageId];
	} else if (time === state.time && !state.ids.includes(message.messageId)) {
		state.ids.push(message.messageId);
		if (state.ids.length > 100) state.ids = state.ids.slice(-100);
	}
	return JSON.stringify(state);
}

function rememberMessage(seen: Set<string>, messageId: string): void {
	seen.add(messageId);
	while (seen.size > 5000) {
		const oldest = seen.values().next().value;
		if (typeof oldest !== "string") break;
		seen.delete(oldest);
	}
}

function waitForDelay(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
	});
}

function parseJson(content: string): unknown {
	try {
		return JSON.parse(content);
	} catch {
		return content;
	}
}

function collectText(value: unknown, parts: string[]): void {
	if (typeof value === "string") {
		if (value.trim()) parts.push(value.trim());
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectText(item, parts);
		return;
	}
	if (!value || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	for (const key of ["text", "content", "title", "name", "href", "url"]) {
		if (typeof record[key] === "string" && String(record[key]).trim()) parts.push(String(record[key]).trim());
	}
	for (const [key, nested] of Object.entries(record)) {
		if (["text", "content", "title", "name", "href", "url", "image_key", "file_key"].includes(key)) continue;
		collectText(nested, parts);
	}
}

function messageText(message: FeishuMessage, parsed: unknown): string {
	if (message.messageType === "text" && parsed && typeof parsed === "object") {
		let text = String((parsed as { text?: unknown }).text ?? "");
		for (const mention of message.mentions ?? []) {
			if (mention.name) text = text.split(mention.key).join(`@${mention.name}`);
		}
		return text.trim();
	}
	if (message.messageType === "image") return "[image]";
	if (message.messageType === "file") {
		const name = parsed && typeof parsed === "object" ? (parsed as { file_name?: unknown }).file_name : undefined;
		return name ? `[file: ${String(name)}]` : "[file]";
	}
	if (message.messageType === "audio") return "[audio]";
	if (message.messageType === "media") return "[video]";
	const parts: string[] = [];
	collectText(parsed, parts);
	return [...new Set(parts)].join("\n").trim() || `[${message.messageType}]`;
}

function collectResources(
	value: unknown,
	resources: Array<{ key: string; type: "image" | "file"; name: string; mimeType?: string }>,
	messageId: string,
): void {
	if (Array.isArray(value)) {
		for (const item of value) collectResources(item, resources, messageId);
		return;
	}
	if (!value || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	if (typeof record.image_key === "string") {
		resources.push({ key: record.image_key, type: "image", name: `image-${messageId}.png`, mimeType: "image/png" });
	}
	if (typeof record.file_key === "string") {
		const rawName = typeof record.file_name === "string" ? record.file_name : `file-${messageId}`;
		resources.push({ key: record.file_key, type: "file", name: rawName });
	}
	for (const nested of Object.values(record)) collectResources(nested, resources, messageId);
}

async function readableToBytes(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return new Uint8Array(Buffer.concat(chunks));
}

async function messageToInput(
	conversation: ResolvedConversation,
	account: FeishuAccountConfig,
	client: Lark.Client,
	message: FeishuMessage,
): Promise<InboundMessageInput | undefined> {
	if (message.chatId !== conversation.channel.id) return undefined;
	if (account.botUserId && message.senderId === account.botUserId) return undefined;
	const parsed = parseJson(message.content);
	const resources: Array<{ key: string; type: "image" | "file"; name: string; mimeType?: string }> = [];
	collectResources(parsed, resources, message.messageId);
	const attachments: NonNullable<InboundMessageInput["attachments"]> = [];
	const seenKeys = new Set<string>();
	for (const resource of resources) {
		if (seenKeys.has(resource.key)) continue;
		seenKeys.add(resource.key);
		try {
			const response = await client.im.v1.messageResource.get({
				path: { message_id: message.messageId, file_key: resource.key },
				params: { type: resource.type },
			});
			const data = await readableToBytes(response.getReadableStream());
			attachments.push(
				await storeDownloadedAttachment(
					conversation,
					message.messageId,
					attachments.length + 1,
					resource.name,
					data,
					resource.mimeType,
				),
			);
		} catch {
			// Preserve the text event even when a resource is unavailable or too large.
		}
	}
	const mentionedBot = (message.mentions ?? []).some((mention) => {
		const id = mention.id?.open_id || mention.id?.user_id || mention.id?.union_id;
		return Boolean(account.botUserId && id === account.botUserId);
	});
	return {
		messageId: message.messageId,
		userId: message.senderId || "unknown",
		userName: message.senderName || message.senderId || "unknown",
		text: messageText(message, parsed),
		mentionedBot,
		isBot: message.senderType === "app" || message.senderType === "bot",
		attachments,
	};
}

function eventToMessage(event: FeishuReceiveEvent): FeishuMessage {
	const senderId =
		event.sender.sender_id?.open_id || event.sender.sender_id?.user_id || event.sender.sender_id?.union_id || "unknown";
	return {
		messageId: event.message.message_id,
		chatId: event.message.chat_id,
		chatType: event.message.chat_type,
		messageType: event.message.message_type,
		content: event.message.content,
		createTime: event.message.create_time,
		senderId,
		senderType: event.sender.sender_type,
		mentions: event.message.mentions,
	};
}

async function catchUpMessages(
	conversation: ResolvedConversation,
	account: FeishuAccountConfig,
	client: Lark.Client,
	handlers: LiveConnectionHandlers,
	cursorState: CursorState,
	seenMessageIds: Set<string>,
): Promise<void> {
	let pageToken: string | undefined;
	const messages: FeishuMessage[] = [];
	do {
		const response = await client.im.v1.message.list({
			params: {
				container_id_type: "chat",
				container_id: conversation.channel.id,
				start_time: cursorState.time > 0 ? String(Math.floor(cursorState.time / 1000)) : undefined,
				sort_type: cursorState.time > 0 ? "ByCreateTimeAsc" : "ByCreateTimeDesc",
				page_size: cursorState.time > 0 ? 50 : 25,
				page_token: pageToken,
				with_sender_name: true,
			},
		});
		if (response.code && response.code !== 0) throw new Error(response.msg || `Feishu API failed (${response.code})`);
		for (const item of response.data?.items ?? []) {
			if (!item.message_id || !item.chat_id || !item.msg_type || !item.body?.content) continue;
			messages.push({
				messageId: item.message_id,
				chatId: item.chat_id,
				chatType: conversation.channel.dm ? "p2p" : "group",
				messageType: item.msg_type,
				content: item.body.content,
				createTime: item.create_time || "0",
				senderId: item.sender?.id || "unknown",
				senderName: item.sender?.sender_name,
				senderType: item.sender?.sender_type,
				mentions: item.mentions?.map((mention) => ({
					key: mention.key,
					id: { [mention.id_type === "open_id" ? "open_id" : "user_id"]: mention.id },
					name: mention.name,
				})),
			});
		}
		pageToken = cursorState.time > 0 && response.data?.has_more ? response.data.page_token : undefined;
	} while (pageToken);
	messages.sort((a, b) => Number(a.createTime) - Number(b.createTime));
	for (const message of messages) {
		const time = Number(message.createTime) || 0;
		if (time < cursorState.time || (time === cursorState.time && cursorState.ids.includes(message.messageId))) continue;
		if (seenMessageIds.has(message.messageId)) continue;
		rememberMessage(seenMessageIds, message.messageId);
		const input = await messageToInput(conversation, account, client, message);
		if (!input) continue;
		await handlers.onMessage(input, { cursor: updateCursor(cursorState, message), messageId: message.messageId });
	}
}

function fileType(name: string): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
	const ext = extname(name).toLowerCase();
	if (ext === ".opus") return "opus";
	if (ext === ".mp4") return "mp4";
	if (ext === ".pdf") return "pdf";
	if (ext === ".doc" || ext === ".docx") return "doc";
	if (ext === ".xls" || ext === ".xlsx") return "xls";
	if (ext === ".ppt" || ext === ".pptx") return "ppt";
	return "stream";
}

async function sendFeishuPayload(
	client: Lark.Client,
	chatId: string,
	msgType: string,
	content: Record<string, unknown>,
	replyToMessageId?: string,
): Promise<string> {
	const serialized = JSON.stringify(content);
	const response = replyToMessageId
		? await client.im.v1.message.reply({
				path: { message_id: replyToMessageId },
				data: { msg_type: msgType, content: serialized },
			})
		: await client.im.v1.message.create({
				params: { receive_id_type: "chat_id" },
				data: { receive_id: chatId, msg_type: msgType, content: serialized },
			});
	if (response.code && response.code !== 0) throw new Error(response.msg || `Feishu send failed (${response.code})`);
	const messageId = response.data?.message_id;
	if (!messageId) throw new Error("Feishu send response did not include a message_id");
	return messageId;
}

async function sendFeishuText(
	client: Lark.Client,
	chatId: string,
	text: string,
	replyToMessageId?: string,
	signal?: AbortSignal,
): Promise<string> {
	const rendered = formatMarkdownForService("feishu", text);
	const chunks = chunkText(rendered.text, maxMessageLength("feishu")).filter((chunk) => chunk.length > 0);
	let firstId = "";
	for (let index = 0; index < chunks.length; index++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const id = await sendFeishuPayload(
			client,
			chatId,
			"text",
			{ text: chunks[index] },
			index === 0 ? replyToMessageId : undefined,
		);
		firstId ||= id;
	}
	return firstId;
}

function buildFeishuConnection(
	conversation: ResolvedConversation,
	client: Lark.Client,
	disconnect: () => Promise<void>,
): LiveConnection {
	const preview = new StreamingPreview(conversation.service, {
		create: async (text, _parseMode, replyToMessageId) =>
			sendFeishuText(client, conversation.channel.id, text, replyToMessageId),
		edit: async (id, text) => {
			const response = await client.im.v1.message.update({
				path: { message_id: id },
				data: { msg_type: "text", content: JSON.stringify({ text }) },
			});
			if (response.code && response.code !== 0)
				throw new Error(response.msg || `Feishu update failed (${response.code})`);
		},
		delete: async (id) => {
			const response = await client.im.v1.message.delete({ path: { message_id: id } });
			if (response.code && response.code !== 0)
				throw new Error(response.msg || `Feishu delete failed (${response.code})`);
		},
	});
	return {
		conversation,
		disconnect,
		sendImmediate: async (text, replyToMessageId) =>
			sendFeishuText(client, conversation.channel.id, text, replyToMessageId),
		send: async (text, attachmentPaths = [], signal, replyToMessageId) => {
			let firstId = text.trim()
				? await sendFeishuText(client, conversation.channel.id, text, replyToMessageId, signal)
				: "";
			let replyTo = firstId ? undefined : replyToMessageId;
			for (const path of attachmentPaths) {
				if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
				const file = await readLocalAttachment(path);
				const kind = guessAttachmentKind(file.name, file.mimeType);
				let id: string;
				if (kind === "image") {
					const uploaded = await client.im.v1.image.create({
						data: { image_type: "message", image: Buffer.from(file.data) },
					});
					if (!uploaded?.image_key) throw new Error("Feishu image upload did not return an image_key");
					id = await sendFeishuPayload(
						client,
						conversation.channel.id,
						"image",
						{ image_key: uploaded.image_key },
						replyTo,
					);
				} else {
					const type = fileType(file.name);
					const uploaded = await client.im.v1.file.create({
						data: { file_type: type, file_name: file.name, file: Buffer.from(file.data) },
					});
					if (!uploaded?.file_key) throw new Error("Feishu file upload did not return a file_key");
					const msgType =
						kind === "audio" && type === "opus" ? "audio" : kind === "video" && type === "mp4" ? "media" : "file";
					id = await sendFeishuPayload(
						client,
						conversation.channel.id,
						msgType,
						{ file_key: uploaded.file_key },
						replyTo,
					);
				}
				firstId ||= id;
				replyTo = undefined;
			}
			return firstId;
		},
		startTyping: async () => {},
		stopTyping: async () => {},
		syncPreview: async (markdown, done = false) => preview.update(markdown, done),
		clearPreview: async () => preview.clear(),
		setReplyTo: (messageId) => preview.setReplyTo(messageId),
	};
}

async function connectFeishuPollingLive(
	conversation: ResolvedConversation,
	handlers: LiveConnectionHandlers,
	resumeState?: ResumeState,
): Promise<LiveConnection> {
	const account = conversation.account as FeishuAccountConfig;
	const client = createFeishuClient(account);
	const cursorState = parseCursor(resumeState?.cursor);
	const seenMessageIds = new Set<string>(resumeState?.messageId ? [resumeState.messageId] : []);
	let disconnected = false;
	const controller = new AbortController();
	await catchUpMessages(conversation, account, client, handlers, cursorState, seenMessageIds);
	await handlers.onCaughtUp();
	const loop = (async () => {
		while (!disconnected) {
			try {
				await waitForDelay(5000, controller.signal);
				if (disconnected) break;
				await catchUpMessages(conversation, account, client, handlers, cursorState, seenMessageIds);
			} catch (error) {
				if (disconnected) break;
				await handlers.onError(error instanceof Error ? error : new Error(String(error)));
			}
		}
	})();
	return buildFeishuConnection(conversation, client, async () => {
		disconnected = true;
		controller.abort();
		await loop;
	});
}

async function connectFeishuWebSocketLive(
	conversation: ResolvedConversation,
	handlers: LiveConnectionHandlers,
	resumeState?: ResumeState,
): Promise<LiveConnection> {
	const account = conversation.account as FeishuAccountConfig;
	const client = createFeishuClient(account);
	const cursorState = parseCursor(resumeState?.cursor);
	const seenMessageIds = new Set<string>(resumeState?.messageId ? [resumeState.messageId] : []);
	let disconnected = false;
	let caughtUp = false;
	const buffered: FeishuMessage[] = [];
	let queue = Promise.resolve();
	const enqueue = (message: FeishuMessage) => {
		queue = queue
			.then(async () => {
				if (disconnected || seenMessageIds.has(message.messageId)) return;
				rememberMessage(seenMessageIds, message.messageId);
				const input = await messageToInput(conversation, account, client, message);
				if (!input) return;
				await handlers.onMessage(input, { cursor: updateCursor(cursorState, message), messageId: message.messageId });
			})
			.catch(async (error) => {
				await handlers.onError(error instanceof Error ? error : new Error(String(error)));
			});
	};
	const dispatcher = new Lark.EventDispatcher({}).register({
		"im.message.receive_v1": (event) => {
			const message = eventToMessage(event as FeishuReceiveEvent);
			if (!caughtUp) buffered.push(message);
			else enqueue(message);
		},
		// Feishu emits this when a user reads a bot DM. pi-chat does not need read receipts.
		"im.message.message_read_v1": () => undefined,
	});
	let connectedOnce = false;
	const wsClient = new Lark.WSClient({
		appId: account.appId,
		appSecret: account.appSecret,
		domain: Lark.Domain.Feishu,
		loggerLevel: Lark.LoggerLevel.warn,
		autoReconnect: true,
		handshakeTimeoutMs: 15000,
		onReady: () => {
			connectedOnce = true;
		},
		onError: (error) => {
			void handlers.onError(error);
			if (connectedOnce) void handlers.onDisconnect?.();
		},
		onReconnecting: () => void handlers.onError(new Error("Feishu connection lost; reconnecting")),
		onReconnected: () => undefined,
	});
	await wsClient.start({ eventDispatcher: dispatcher });
	try {
		await catchUpMessages(conversation, account, client, handlers, cursorState, seenMessageIds);
	} catch (error) {
		await handlers.onError(
			new Error(
				`Feishu history catch-up unavailable; continuing with live events: ${
					error instanceof Error ? error.message : String(error)
				}`,
			),
		);
	}
	caughtUp = true;
	for (const message of buffered.sort((a, b) => Number(a.createTime) - Number(b.createTime))) enqueue(message);
	buffered.length = 0;
	await queue;
	await handlers.onCaughtUp();
	return buildFeishuConnection(conversation, client, async () => {
		disconnected = true;
		wsClient.close({ force: true });
		await queue;
	});
}

export async function connectFeishuLive(
	conversation: ResolvedConversation,
	handlers: LiveConnectionHandlers,
	resumeState?: ResumeState,
): Promise<LiveConnection> {
	const account = conversation.account as FeishuAccountConfig;
	const configuredChannels = Object.keys(account.channels).length;
	const mode = account.receiveMode ?? "auto";
	if (mode === "polling" || (mode === "auto" && configuredChannels > 1)) {
		return connectFeishuPollingLive(conversation, handlers, resumeState);
	}
	return connectFeishuWebSocketLive(conversation, handlers, resumeState);
}
