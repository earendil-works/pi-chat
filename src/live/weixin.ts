import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { extname } from "node:path";

import type { ResolvedConversation, WeixinAccountConfig } from "../core/config-types.js";
import type { InboundMessageInput } from "../core/runtime-types.js";
import { chunkText } from "../render/chunking.js";
import { formatMarkdownForService, maxMessageLength } from "../render/format.js";
import {
	callWeixin,
	getWeixinUpdates,
	normalizeWeixinCdnBaseUrl,
	WeixinApiError,
	type WeixinApiResponse,
	weixinBaseInfo,
} from "../services/weixin.js";
import { guessAttachmentKind, guessMimeType, readLocalAttachment, storeDownloadedAttachment } from "./common.js";
import type { LiveConnection, LiveConnectionHandlers, ResumeState } from "./types.js";

interface WeixinMedia {
	encrypt_query_param?: string;
	aes_key?: string;
	aeskey?: string;
	filekey?: string;
	media_id?: string;
	download_url?: string;
	url?: string;
	full_url?: string;
}

interface WeixinMessageItem {
	type?: number | string;
	text_item?: { text?: string };
	image_item?: { media?: WeixinMedia; aeskey?: string };
	file_item?: { media?: WeixinMedia; file_name?: string; file_size?: number | string; aeskey?: string };
	video_item?: { media?: WeixinMedia; aeskey?: string };
	voice_item?: { media?: WeixinMedia; aeskey?: string };
}

interface WeixinMessage {
	message_id?: string;
	msg_id?: string;
	client_id?: string;
	from_user_id?: string;
	to_user_id?: string;
	create_time?: number | string;
	context_token?: string;
	message_type?: number | string;
	item_list?: WeixinMessageItem[];
}

interface WeixinUpdatesResponse extends WeixinApiResponse {
	get_updates_buf?: string;
	msgs?: WeixinMessage[];
	messages?: WeixinMessage[];
}

function responseRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function updatesFromResponse(response: WeixinUpdatesResponse): {
	cursor?: string;
	messages: WeixinMessage[];
} {
	const data = responseRecord(response.data);
	const cursor =
		stringValue(response.get_updates_buf) ??
		stringValue(data?.get_updates_buf) ??
		stringValue(data?.getUpdatesBuf) ??
		stringValue(response.getUpdatesBuf);
	const messages =
		response.msgs ??
		response.messages ??
		(Array.isArray(data?.msgs) ? (data.msgs as WeixinMessage[]) : undefined) ??
		(Array.isArray(data?.messages) ? (data.messages as WeixinMessage[]) : []);
	return { cursor, messages };
}

function messageId(message: WeixinMessage): string {
	const known = message.message_id || message.msg_id || message.client_id;
	if (known) return known;
	return createHash("sha256")
		.update(
			JSON.stringify({
				from: message.from_user_id,
				to: message.to_user_id,
				time: message.create_time,
				context: message.context_token,
				items: message.item_list,
			}),
		)
		.digest("hex");
}

function mediaKey(value?: string): Buffer | undefined {
	if (!value) return undefined;
	try {
		const decoded = Buffer.from(value, "base64");
		if (decoded.length === 16) return decoded;
		const text = decoded.toString("utf8");
		if (/^[0-9a-f]{32}$/i.test(text)) return Buffer.from(text, "hex");
		if (/^[0-9a-f]{32}$/i.test(value)) return Buffer.from(value, "hex");
	} catch {
		return undefined;
	}
	return undefined;
}

function decryptMedia(data: Uint8Array, key?: Buffer): Uint8Array {
	if (!key) return data;
	const decipher = createDecipheriv("aes-128-ecb", key, null);
	decipher.setAutoPadding(true);
	return new Uint8Array(Buffer.concat([decipher.update(data), decipher.final()]));
}

function mediaDownloadUrl(media: WeixinMedia): string | undefined {
	if (media.download_url) return media.download_url;
	if (media.url) return media.url;
	if (media.full_url) return media.full_url;
	if (!media.encrypt_query_param) return undefined;
	const endpoint = new URL("download", `${normalizeWeixinCdnBaseUrl()}/`);
	endpoint.searchParams.set("encrypted_query_param", media.encrypt_query_param);
	return endpoint.toString();
}

function mediaItem(
	item: WeixinMessageItem,
): { kind: "image" | "file" | "video" | "audio"; name: string; media: WeixinMedia; aesKey?: string } | undefined {
	if (item.image_item?.media)
		return {
			kind: "image",
			name: `image-${item.image_item.media.media_id || item.image_item.media.filekey || "attachment"}.jpg`,
			media: item.image_item.media,
			aesKey: item.image_item.aeskey ?? item.image_item.media.aes_key ?? item.image_item.media.aeskey,
		};
	if (item.file_item?.media)
		return {
			kind: "file",
			name: item.file_item.file_name || `file-${item.file_item.media.filekey || "attachment"}`,
			media: item.file_item.media,
			aesKey: item.file_item.aeskey ?? item.file_item.media.aes_key ?? item.file_item.media.aeskey,
		};
	if (item.video_item?.media)
		return {
			kind: "video",
			name: `video-${item.video_item.media.media_id || item.video_item.media.filekey || "attachment"}.mp4`,
			media: item.video_item.media,
			aesKey: item.video_item.aeskey ?? item.video_item.media.aes_key ?? item.video_item.media.aeskey,
		};
	if (item.voice_item?.media)
		return {
			kind: "audio",
			name: `voice-${item.voice_item.media.media_id || item.voice_item.media.filekey || "attachment"}.silk`,
			media: item.voice_item.media,
			aesKey: item.voice_item.aeskey ?? item.voice_item.media.aes_key ?? item.voice_item.media.aeskey,
		};
	return undefined;
}

async function downloadMessageAttachments(
	conversation: ResolvedConversation,
	message: WeixinMessage,
): Promise<NonNullable<InboundMessageInput["attachments"]>> {
	const attachments: NonNullable<InboundMessageInput["attachments"]> = [];
	for (const item of message.item_list ?? []) {
		const media = mediaItem(item);
		if (!media) continue;
		const url = mediaDownloadUrl(media.media);
		if (!url) continue;
		try {
			const response = await fetch(url);
			if (!response.ok) throw new Error(`Weixin media download failed (${response.status})`);
			const encrypted = new Uint8Array(await response.arrayBuffer());
			const data = decryptMedia(encrypted, mediaKey(media.aesKey));
			attachments.push(
				await storeDownloadedAttachment(
					conversation,
					messageId(message),
					attachments.length + 1,
					media.name,
					data,
					media.kind === "audio" ? "audio/silk" : guessMimeType(media.name),
					url,
				),
			);
		} catch {
			// Keep the inbound message even when an expired CDN URL cannot be materialized.
		}
	}
	return attachments;
}

function messageText(message: WeixinMessage): string {
	const parts: string[] = [];
	for (const item of message.item_list ?? []) {
		const text = item.text_item?.text;
		if (text?.trim()) parts.push(text.trim());
		else if (item.image_item) parts.push("[image]");
		else if (item.file_item) parts.push(`[file: ${item.file_item.file_name || "attachment"}]`);
		else if (item.video_item) parts.push("[video]");
		else if (item.voice_item) parts.push("[voice]");
	}
	return parts.join("\n").trim();
}

async function messageToInput(
	conversation: ResolvedConversation,
	account: WeixinAccountConfig,
	message: WeixinMessage,
): Promise<InboundMessageInput | undefined> {
	if (!message.from_user_id || message.from_user_id !== conversation.channel.id) return undefined;
	if (message.from_user_id === account.botUserId) return undefined;
	if (message.message_type !== undefined && String(message.message_type) !== "1") return undefined;
	return {
		messageId: messageId(message),
		userId: message.from_user_id,
		userName: message.from_user_id,
		text: messageText(message),
		mentionedBot: true,
		isBot: false,
		attachments: await downloadMessageAttachments(conversation, message),
	};
}

function generatedClientId(): string {
	return randomUUID().replace(/-/g, "");
}

function sendMessageBody(
	toUserId: string,
	contextToken: string,
	itemList: Record<string, unknown>[],
	clientId = generatedClientId(),
): Record<string, unknown> {
	return {
		msg: {
			to_user_id: toUserId,
			client_id: clientId,
			message_type: 2,
			message_state: 2,
			context_token: contextToken,
			item_list: itemList,
		},
		base_info: weixinBaseInfo(),
	};
}

function remoteMessageId(response: WeixinApiResponse, fallback: string): string {
	const data = responseRecord(response.data);
	return (
		stringValue(response.message_id) ??
		stringValue(response.msg_id) ??
		stringValue(data?.message_id) ??
		stringValue(data?.msg_id) ??
		fallback
	);
}

async function sendText(
	account: WeixinAccountConfig,
	toUserId: string,
	contextToken: string,
	text: string,
	signal?: AbortSignal,
): Promise<string> {
	const clientId = generatedClientId();
	const response = await callWeixin(
		undefined,
		"/ilink/bot/sendmessage",
		sendMessageBody(toUserId, contextToken, [{ type: 1, text_item: { text } }], clientId),
		{ botToken: account.botToken, signal },
	);
	return remoteMessageId(response, clientId);
}

function uploadType(kind: ReturnType<typeof guessAttachmentKind>): number {
	if (kind === "image") return 1;
	if (kind === "video") return 2;
	return 3;
}

function encodedAesKey(kind: ReturnType<typeof guessAttachmentKind>, key: Buffer): string {
	if (kind === "image") return key.toString("base64");
	return Buffer.from(key.toString("hex"), "utf8").toString("base64");
}

async function uploadMedia(
	account: WeixinAccountConfig,
	toUserId: string,
	path: string,
	signal?: AbortSignal,
): Promise<{ item: Record<string, unknown>; clientId: string }> {
	const file = await readLocalAttachment(path);
	const kind = guessAttachmentKind(file.name, file.mimeType);
	const aesKey = randomBytes(16);
	const cipher = createCipheriv("aes-128-ecb", aesKey, null);
	cipher.setAutoPadding(true);
	const encrypted = Buffer.concat([cipher.update(file.data), cipher.final()]);
	const fileKey = `pi-chat-${generatedClientId()}`;
	const uploadInfo = await callWeixin(
		undefined,
		"/ilink/bot/getuploadurl",
		{
			to_user_id: toUserId,
			filekey: fileKey,
			media_type: uploadType(kind),
			aeskey: aesKey.toString("hex"),
			rawfilemd5: createHash("md5").update(file.data).digest("hex"),
			rawsize: file.data.length,
			filesize: encrypted.length,
			no_need_thumb: true,
			base_info: weixinBaseInfo(),
		},
		{ botToken: account.botToken, signal },
	);
	const data = responseRecord(uploadInfo.data) ?? uploadInfo;
	const uploadUrl = stringValue(data.upload_full_url) ?? stringValue(data.upload_url);
	const uploadParam = stringValue(data.upload_param);
	const target = uploadUrl ? new URL(uploadUrl) : new URL("upload", `${normalizeWeixinCdnBaseUrl()}/`);
	if (!uploadUrl && uploadParam) {
		target.searchParams.set("encrypted_query_param", uploadParam);
		target.searchParams.set("filekey", fileKey);
	}
	if (!uploadUrl && !uploadParam) throw new Error("Weixin upload response did not include an upload URL");
	const uploaded = await fetch(target, {
		method: "POST",
		headers: {
			"content-type": "application/octet-stream",
		},
		body: encrypted,
		signal,
	});
	if (!uploaded.ok) throw new Error(`Weixin media upload failed (${uploaded.status})`);
	const encryptedQueryParam = uploaded.headers.get("x-encrypted-param");
	if (!encryptedQueryParam) throw new Error("Weixin media upload response did not include x-encrypted-param");
	const media: Record<string, unknown> = {
		encrypt_query_param: encryptedQueryParam,
		aes_key: encodedAesKey(kind, aesKey),
		filekey: fileKey,
	};
	const clientId = generatedClientId();
	if (kind === "image") return { clientId, item: { type: 2, image_item: { media, mid_size: encrypted.length } } };
	if (kind === "video") return { clientId, item: { type: 5, video_item: { media, video_size: encrypted.length } } };
	return {
		clientId,
		item: {
			type: 4,
			file_item: {
				media,
				file_name: file.name,
				len: file.data.length,
				file_ext: extname(file.name).replace(/^\./, ""),
			},
		},
	};
}

async function sendUploadedMedia(
	account: WeixinAccountConfig,
	toUserId: string,
	contextToken: string,
	path: string,
	signal?: AbortSignal,
): Promise<string> {
	const uploaded = await uploadMedia(account, toUserId, path, signal);
	const response = await callWeixin(
		undefined,
		"/ilink/bot/sendmessage",
		sendMessageBody(toUserId, contextToken, [uploaded.item], uploaded.clientId),
		{ botToken: account.botToken, signal },
	);
	return remoteMessageId(response, uploaded.clientId);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
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

export async function connectWeixinLive(
	conversation: ResolvedConversation,
	handlers: LiveConnectionHandlers,
	resumeState?: ResumeState,
): Promise<LiveConnection> {
	const account = conversation.account as WeixinAccountConfig;
	let disconnected = false;
	let contextToken: string | undefined;
	let typingTicket: string | undefined;
	let cursor = resumeState?.cursor;
	const controller = new AbortController();
	const processUpdates = async (): Promise<void> => {
		const response = (await getWeixinUpdates(account, cursor, controller.signal)) as WeixinUpdatesResponse;
		const updates = updatesFromResponse(response);
		cursor = updates.cursor ?? cursor;
		for (const message of updates.messages) {
			const input = await messageToInput(conversation, account, message);
			if (!input) continue;
			if (message.context_token) contextToken = message.context_token;
			await handlers.onMessage(input, { cursor, messageId: input.messageId });
		}
	};
	await processUpdates();
	await handlers.onCaughtUp();
	const loop = (async () => {
		while (!disconnected) {
			try {
				await processUpdates();
			} catch (error) {
				if (disconnected || (error instanceof DOMException && error.name === "AbortError")) break;
				await handlers.onError(error instanceof Error ? error : new Error(String(error)));
				if (error instanceof WeixinApiError && error.code === -14) {
					await handlers.onDisconnect?.();
					break;
				}
				await wait(3000, controller.signal);
			}
		}
	})();
	const requireContext = (): string => {
		if (!contextToken)
			throw new Error(
				"Weixin replies require a context token from an inbound message. Send a new message to the paired Weixin contact first.",
			);
		return contextToken;
	};
	return {
		conversation,
		disconnect: async () => {
			disconnected = true;
			controller.abort();
			await loop.catch(() => undefined);
		},
		sendImmediate: async (text) => sendText(account, conversation.channel.id, requireContext(), text),
		send: async (text, attachmentPaths = [], signal) => {
			const rendered = formatMarkdownForService("weixin", text);
			const context = requireContext();
			let firstId = "";
			for (const chunk of chunkText(rendered.text, maxMessageLength("weixin")).filter(Boolean)) {
				if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
				const id = await sendText(account, conversation.channel.id, context, chunk, signal);
				firstId ||= id;
			}
			for (const path of attachmentPaths) {
				if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
				const id = await sendUploadedMedia(account, conversation.channel.id, context, path, signal);
				firstId ||= id;
			}
			return firstId;
		},
		startTyping: async () => {
			if (!contextToken) return;
			const response = await callWeixin(
				undefined,
				"/ilink/bot/getconfig",
				{
					ilink_user_id: conversation.channel.id,
					context_token: contextToken,
					base_info: weixinBaseInfo(),
				},
				{ botToken: account.botToken },
			);
			const data = responseRecord(response.data) ?? response;
			typingTicket = stringValue(data.typing_ticket) ?? stringValue(data.ticket);
			if (!typingTicket) return;
			await callWeixin(
				undefined,
				"/ilink/bot/sendtyping",
				{
					ilink_user_id: conversation.channel.id,
					typing_ticket: typingTicket,
					status: 1,
					base_info: weixinBaseInfo(),
				},
				{ botToken: account.botToken },
			);
		},
		stopTyping: async () => {
			if (!typingTicket) return;
			await callWeixin(
				undefined,
				"/ilink/bot/sendtyping",
				{
					ilink_user_id: conversation.channel.id,
					typing_ticket: typingTicket,
					status: 2,
					base_info: weixinBaseInfo(),
				},
				{ botToken: account.botToken },
			);
			typingTicket = undefined;
		},
		syncPreview: async () => [],
		clearPreview: async () => {},
		setReplyTo: () => {},
	};
}
