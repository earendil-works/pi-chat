import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import qrcode from "qrcode-terminal";

import { CHAT_CACHE_DIR, saveChatConfig } from "../config.js";
import type { AccessPolicy, ChatConfig, ConfiguredChannel, WeixinAccountConfig } from "../core/config-types.js";
import { makeAccountKey, makeChannelKey } from "../core/keys.js";
import { refreshAccountSnapshot } from "../services/index.js";
import { getWeixinQRCode, getWeixinQRCodeStatus, getWeixinUpdates, type WeixinLogin } from "../services/weixin.js";
import { runWithLoader, showNotice } from "./dialogs.js";

interface WeixinObservedMessage {
	from_user_id?: string;
	message_type?: number | string;
}

function ensureUniqueKey(existing: Record<string, unknown>, base: string): string {
	if (!existing[base]) return base;
	let index = 2;
	while (existing[`${base}-${index}`]) index += 1;
	return `${base}-${index}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMessages(response: Record<string, unknown>): WeixinObservedMessage[] {
	const data =
		response.data && typeof response.data === "object" && !Array.isArray(response.data)
			? (response.data as Record<string, unknown>)
			: response;
	const messages = response.msgs ?? response.messages ?? data.msgs ?? data.messages;
	return Array.isArray(messages) ? (messages as WeixinObservedMessage[]) : [];
}

async function saveQRCodeImage(content: string | undefined): Promise<string | undefined> {
	if (!content) return undefined;
	const base64 = content.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
	if (!base64 || (base64 === content && !/^[A-Za-z0-9+/=\r\n]+$/.test(content))) return undefined;
	try {
		await mkdir(CHAT_CACHE_DIR, { recursive: true });
		const path = join(CHAT_CACHE_DIR, `weixin-qrcode-${randomUUID()}.png`);
		await writeFile(path, Buffer.from(base64, "base64"));
		return path;
	} catch {
		return undefined;
	}
}

function renderQRCode(value: string): string | undefined {
	let rendered: string | undefined;
	try {
		qrcode.generate(value, { small: true }, (output) => {
			rendered = output.trimEnd();
		});
		return rendered;
	} catch {
		return undefined;
	}
}

async function waitForWeixinLogin(ctx: ExtensionContext): Promise<WeixinLogin | undefined> {
	const qr = await runWithLoader(ctx, "Requesting Weixin login QR code...", () => getWeixinQRCode());
	if (qr.error) {
		await showNotice(ctx, "Weixin setup error", qr.error, "error");
		return undefined;
	}
	if (!qr.value) return undefined;
	const qrCode = qr.value;
	const imagePath = await saveQRCodeImage(qrCode.imageContent);
	const imageUrl = qrCode.imageContent?.startsWith("http") ? qrCode.imageContent : undefined;
	const terminalQRCode = renderQRCode(qrCode.imageContent || qrCode.qrcode);
	return ctx.ui.custom<WeixinLogin | undefined>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(
			tui,
			theme,
			[
				"Weixin login",
				"",
				"Use WeChat's Scan action to scan the QR code.",
				terminalQRCode,
				imagePath ? `QR image: ${imagePath}` : undefined,
				imageUrl ? `QR image URL: ${imageUrl}` : undefined,
				`QR payload: ${qrCode.qrcode}`,
				"",
				"Waiting for scan confirmation...",
			]
				.filter(Boolean)
				.join("\n"),
			{ cancellable: true },
		);
		loader.onAbort = () => done(undefined);
		void (async () => {
			try {
				while (!loader.signal.aborted) {
					const login = await getWeixinQRCodeStatus(undefined, qrCode.qrcode);
					if (login) {
						done(login);
						return;
					}
					await sleep(2000);
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				done(undefined);
			}
		})();
		return loader;
	});
}

export async function createWeixinAccountWithGuidedSetup(
	ctx: ExtensionContext,
	config: ChatConfig,
): Promise<string | undefined> {
	const login = await waitForWeixinLogin(ctx);
	if (!login) return undefined;
	const label = await ctx.ui.input("Account label", "weixin");
	if (label === undefined) return undefined;
	const accountId = ensureUniqueKey(config.accounts, makeAccountKey("weixin", label.trim() || login.botUserId));
	const account: WeixinAccountConfig = {
		service: "weixin",
		name: label.trim() || undefined,
		botToken: login.botToken,
		botUserId: login.botUserId,
		userId: login.userId,
		channels: {},
		access: { ignoreBots: true },
	};
	const snapshot = await runWithLoader(ctx, "Saving Weixin account...", () =>
		refreshAccountSnapshot(accountId, account),
	);
	if (snapshot.error) {
		await showNotice(ctx, "Weixin setup error", snapshot.error, "error");
		return undefined;
	}
	config.accounts[accountId] = account;
	await saveChatConfig(config);
	await showNotice(
		ctx,
		"Weixin account created",
		`Created ${accountId}. Pair a direct chat by choosing Add DM.`,
		"info",
	);
	return accountId;
}

export async function addWeixinObservedTargetToAccount(
	ctx: ExtensionContext,
	config: ChatConfig,
	accountId: string,
	account: WeixinAccountConfig,
): Promise<string | undefined> {
	const observed = await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(
			tui,
			theme,
			[
				"Weixin DM pairing",
				"",
				"Send a new message to the connected Weixin bot from the direct chat you want to pair.",
				"Waiting for the message...",
			].join("\n"),
			{ cancellable: true },
		);
		const controller = new AbortController();
		loader.onAbort = () => {
			controller.abort();
			done(undefined);
		};
		void (async () => {
			let cursor = "";
			try {
				while (!controller.signal.aborted) {
					const response = await getWeixinUpdates(account, cursor, controller.signal);
					const data = response as Record<string, unknown>;
					const nested =
						data.data && typeof data.data === "object" && !Array.isArray(data.data)
							? (data.data as Record<string, unknown>)
							: data;
					const nextCursor = data.get_updates_buf ?? nested.get_updates_buf;
					if (typeof nextCursor === "string") cursor = nextCursor;
					for (const message of getMessages(data)) {
						if (
							typeof message.from_user_id === "string" &&
							message.from_user_id !== account.botUserId &&
							(message.message_type === undefined || String(message.message_type) === "1")
						) {
							done(message.from_user_id);
							return;
						}
					}
				}
			} catch (error) {
				if (!controller.signal.aborted) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				done(undefined);
			}
		})();
		return loader;
	});
	if (!observed) return undefined;
	const access: AccessPolicy = { trigger: "message", ignoreBots: true, allowedUserIds: [observed] };
	const baseKey = makeChannelKey(`dm-${observed}`, observed);
	const existing = Object.entries(account.channels).find(([, channel]) => channel.id === observed)?.[0];
	const channelKey = existing ?? ensureUniqueKey(account.channels, baseKey);
	const channel: ConfiguredChannel = { id: observed, name: observed, dm: true, access };
	account.channels[channelKey] = channel;
	config.accounts[accountId] = account;
	await saveChatConfig(config);
	await showNotice(ctx, "Weixin DM configured", `Configured ${accountId}/${channelKey}`, "info");
	return channelKey;
}
