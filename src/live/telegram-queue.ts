import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAccountRuntimePath, listConfiguredConversationsForAccount, loadChatConfig } from "../config.js";
import type { ResolvedConversation, TelegramAccountConfig } from "../core/config-types.js";
import {
	callTelegram,
	createTelegramConversationConnection,
	mergeTelegramMediaGroup,
	type TelegramMessage,
	type TelegramUpdate,
	telegramMessageToInput,
} from "./telegram.js";
import type { LiveConnection, LiveConnectionHandlers, ResumeState } from "./types.js";

const TELEGRAM_QUEUE_DIR = "telegram-queue";
const TELEGRAM_DISPATCHER_LOCK_FILE = ".telegram-dispatcher.lock";
const TELEGRAM_DISPATCHER_CURSOR_FILE = "telegram-dispatcher-cursor.json";
const TELEGRAM_DISPATCHER_REFRESH_MS = 5000;
const TELEGRAM_QUEUE_POLL_MS = 750;

interface TelegramQueuedMessage {
	version: 1;
	accountId: string;
	channelKey: string;
	chatId: string;
	updateId: number;
	message: TelegramMessage;
}

export interface TelegramDispatcherConnection {
	accountId: string;
	disconnect(): Promise<void>;
}

function queuePendingDir(conversation: ResolvedConversation): string {
	return join(conversation.conversationDir, TELEGRAM_QUEUE_DIR, "pending");
}

function queueTmpDir(conversation: ResolvedConversation): string {
	return join(conversation.conversationDir, TELEGRAM_QUEUE_DIR, "tmp");
}

function sanitizeName(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function queueFileName(event: Pick<TelegramQueuedMessage, "updateId" | "message">): string {
	return `${String(event.updateId).padStart(20, "0")}-${sanitizeName(String(event.message.message_id))}.json`;
}

async function writeQueuedTelegramMessage(
	conversation: ResolvedConversation,
	updateId: number,
	message: TelegramMessage,
): Promise<void> {
	const event: TelegramQueuedMessage = {
		version: 1,
		accountId: conversation.accountId,
		channelKey: conversation.channelKey,
		chatId: conversation.channel.id,
		updateId,
		message,
	};
	const pendingDir = queuePendingDir(conversation);
	const tmpDir = queueTmpDir(conversation);
	await mkdir(pendingDir, { recursive: true });
	await mkdir(tmpDir, { recursive: true });
	const fileName = queueFileName(event);
	const tmpPath = join(tmpDir, `${fileName}.${process.pid}.${randomUUID()}.tmp`);
	await writeFile(tmpPath, `${JSON.stringify(event)}\n`, "utf8");
	await rename(tmpPath, join(pendingDir, fileName));
}

async function readQueuedEvent(path: string): Promise<TelegramQueuedMessage> {
	return JSON.parse(await readFile(path, "utf8")) as TelegramQueuedMessage;
}

async function listPendingQueueFiles(conversation: ResolvedConversation): Promise<string[]> {
	try {
		const pendingDir = queuePendingDir(conversation);
		const entries = await readdir(pendingDir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
			.map((entry) => join(pendingDir, entry.name))
			.sort();
	} catch {
		return [];
	}
}

export async function connectTelegramQueuedLive(
	conversation: ResolvedConversation,
	handlers: LiveConnectionHandlers,
	resumeState?: ResumeState,
): Promise<LiveConnection> {
	const account = conversation.account as TelegramAccountConfig;
	let abort = false;
	let processing = false;
	let lastCursor = resumeState?.cursor ? Number(resumeState.cursor) : 0;
	if (!Number.isFinite(lastCursor)) lastCursor = 0;
	let interval: ReturnType<typeof setInterval> | undefined;
	const processPending = async (): Promise<void> => {
		if (processing) return;
		processing = true;
		try {
			for (const path of await listPendingQueueFiles(conversation)) {
				if (abort) return;
				let event: TelegramQueuedMessage;
				try {
					event = await readQueuedEvent(path);
				} catch (error) {
					await handlers.onError(error instanceof Error ? error : new Error(String(error)));
					await unlink(path).catch(() => undefined);
					continue;
				}
				if (event.updateId <= lastCursor) {
					await unlink(path).catch(() => undefined);
					continue;
				}
				const input = await telegramMessageToInput(conversation, account, event.message);
				if (input) {
					await handlers.onMessage(input, {
						cursor: String(event.updateId),
						messageId: input.messageId,
					});
				}
				lastCursor = event.updateId;
				await unlink(path).catch(() => undefined);
			}
		} catch (error) {
			await handlers.onError(error instanceof Error ? error : new Error(String(error)));
		} finally {
			processing = false;
		}
	};
	await processPending();
	await handlers.onCaughtUp();
	interval = setInterval(() => {
		void processPending();
	}, TELEGRAM_QUEUE_POLL_MS);
	return createTelegramConversationConnection(conversation, account, async () => {
		abort = true;
		if (interval) clearInterval(interval);
	});
}

function extractOwnerPid(owner: string): number | undefined {
	const match = owner.match(/^pi-chat-(\d+)-/);
	if (!match) return undefined;
	const pid = Number(match[1]);
	return Number.isFinite(pid) ? pid : undefined;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code) : undefined;
		return code === "EPERM";
	}
}

async function acquireDispatcherLock(accountId: string, owner: string): Promise<() => Promise<void>> {
	const lockPath = getAccountRuntimePath(accountId, TELEGRAM_DISPATCHER_LOCK_FILE);
	await mkdir(dirname(lockPath), { recursive: true });
	try {
		const handle = await open(lockPath, "wx");
		try {
			await handle.writeFile(`${owner}\n`, "utf8");
		} finally {
			await handle.close();
		}
		return async () => {
			await unlink(lockPath).catch(() => undefined);
		};
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code) : undefined;
		if (code !== "EEXIST") throw error;
	}
	const existingOwner = (await readFile(lockPath, "utf8").catch(() => "")).trim();
	const existingPid = extractOwnerPid(existingOwner);
	if (existingPid !== undefined && !isPidAlive(existingPid)) {
		await unlink(lockPath).catch(() => undefined);
		return acquireDispatcherLock(accountId, owner);
	}
	throw new Error(
		`Telegram dispatcher is already running for this account in ${existingOwner || "another pi-chat session"}`,
	);
}

async function readDispatcherCursor(accountId: string): Promise<string | undefined> {
	try {
		const data = JSON.parse(
			await readFile(getAccountRuntimePath(accountId, TELEGRAM_DISPATCHER_CURSOR_FILE), "utf8"),
		) as {
			cursor?: string;
		};
		return typeof data.cursor === "string" ? data.cursor : undefined;
	} catch {
		return undefined;
	}
}

async function writeDispatcherCursor(accountId: string, cursor: string): Promise<void> {
	const cursorPath = getAccountRuntimePath(accountId, TELEGRAM_DISPATCHER_CURSOR_FILE);
	await mkdir(dirname(cursorPath), { recursive: true });
	await writeFile(
		cursorPath,
		`${JSON.stringify({ cursor, updatedAt: new Date().toISOString() }, null, "\t")}\n`,
		"utf8",
	);
}

function buildConversationChatMap(conversations: ResolvedConversation[]): Map<string, ResolvedConversation> {
	return new Map(conversations.map((conversation) => [conversation.channel.id, conversation]));
}

export async function connectTelegramDispatcher(
	accountId: string,
	ownerId: string,
	onError: (error: Error) => Promise<void>,
): Promise<TelegramDispatcherConnection> {
	let abort = false;
	let account: TelegramAccountConfig | undefined;
	let conversationsByChatId = new Map<string, ResolvedConversation>();
	const releaseLock = await acquireDispatcherLock(accountId, ownerId);
	const pollController = new AbortController();
	const mediaGroups = new Map<string, { updates: TelegramUpdate[]; timer?: ReturnType<typeof setTimeout> }>();
	const refreshConversations = async (): Promise<void> => {
		const config = await loadChatConfig();
		const nextAccount = config.accounts[accountId];
		if (!nextAccount || nextAccount.service !== "telegram") {
			abort = true;
			pollController.abort();
			throw new Error(`Telegram account removed: ${accountId}`);
		}
		if (account && nextAccount.botToken !== account.botToken) {
			abort = true;
			pollController.abort();
			throw new Error(`Telegram account token changed; restart dispatcher for ${accountId}`);
		}
		account = nextAccount;
		conversationsByChatId = buildConversationChatMap(listConfiguredConversationsForAccount(config, accountId));
	};
	try {
		await refreshConversations();
		if (!account) throw new Error(`Telegram account unavailable: ${accountId}`);
		await callTelegram<boolean>(account.botToken, "deleteWebhook", { drop_pending_updates: false });
	} catch (error) {
		await releaseLock().catch(() => undefined);
		throw error;
	}
	let lastWrittenCursor = 0;
	const noteCursor = async (updateId: number): Promise<void> => {
		if (updateId <= lastWrittenCursor) return;
		lastWrittenCursor = updateId;
		await writeDispatcherCursor(accountId, String(updateId));
	};
	const routeMessage = async (updateId: number, message: TelegramMessage): Promise<void> => {
		const conversation = conversationsByChatId.get(String(message.chat.id));
		if (conversation) await writeQueuedTelegramMessage(conversation, updateId, message);
		await noteCursor(updateId);
	};
	const flushMediaGroup = async (key: string): Promise<void> => {
		const state = mediaGroups.get(key);
		mediaGroups.delete(key);
		if (!state) return;
		const lastUpdateId = state.updates.at(-1)?.update_id;
		const merged = mergeTelegramMediaGroup(state.updates);
		if (merged && lastUpdateId !== undefined) {
			await routeMessage(lastUpdateId, merged);
			return;
		}
		if (lastUpdateId !== undefined) await noteCursor(lastUpdateId);
	};
	const processUpdate = async (update: TelegramUpdate): Promise<void> => {
		const message = update.message || update.edited_message;
		if (!message) {
			await noteCursor(update.update_id);
			return;
		}
		if (message.media_group_id) {
			const key = `${message.chat.id}:${message.media_group_id}`;
			const existing = mediaGroups.get(key) ?? { updates: [] };
			existing.updates.push(update);
			if (existing.timer) clearTimeout(existing.timer);
			existing.timer = setTimeout(() => void flushMediaGroup(key), 1200);
			mediaGroups.set(key, existing);
			return;
		}
		await routeMessage(update.update_id, message);
	};
	let offset = 0;
	const cursor = await readDispatcherCursor(accountId);
	if (cursor) {
		const parsed = Number(cursor);
		if (Number.isFinite(parsed)) {
			offset = parsed + 1;
			lastWrittenCursor = parsed;
		}
	}
	const refreshInterval = setInterval(() => {
		void refreshConversations().catch(onError);
	}, TELEGRAM_DISPATCHER_REFRESH_MS);
	const loop = (async () => {
		while (!abort) {
			try {
				if (!account) throw new Error(`Telegram account unavailable: ${accountId}`);
				const updates = await callTelegram<TelegramUpdate[]>(
					account.botToken,
					"getUpdates",
					{ offset: offset > 0 ? offset : undefined, timeout: 30, allowed_updates: ["message", "edited_message"] },
					{ signal: pollController.signal },
				);
				for (const update of updates) {
					offset = update.update_id + 1;
					await processUpdate(update);
				}
			} catch (error) {
				if (abort) break;
				if (error instanceof DOMException && error.name === "AbortError") break;
				await onError(error instanceof Error ? error : new Error(String(error)));
				await new Promise((resolve) => setTimeout(resolve, 3000));
			}
		}
	})();
	return {
		accountId,
		disconnect: async () => {
			abort = true;
			clearInterval(refreshInterval);
			pollController.abort();
			for (const key of [...mediaGroups.keys()]) await flushMediaGroup(key).catch(onError);
			await loop.catch(() => undefined);
			await releaseLock();
		},
	};
}
