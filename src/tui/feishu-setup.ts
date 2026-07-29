import * as Lark from "@larksuiteoapi/node-sdk";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";

import { saveChatConfig } from "../config.js";
import type { AccessPolicy, ChatConfig, ConfiguredChannel, FeishuAccountConfig } from "../core/config-types.js";
import { makeAccountKey, makeChannelKey } from "../core/keys.js";
import { refreshAccountSnapshot, updateAccountIdentityFromSnapshot, validateAccountDraft } from "../services/index.js";
import { runWithLoader, showNotice } from "./dialogs.js";

interface ObservedFeishuTarget {
	chatId: string;
	chatName: string;
	dm: boolean;
	userId?: string;
	userName?: string;
}

function ensureUniqueKey(existing: Record<string, unknown>, base: string): string {
	if (!existing[base]) return base;
	let index = 2;
	while (existing[`${base}-${index}`]) index += 1;
	return `${base}-${index}`;
}

async function observeFeishuTarget(
	ctx: ExtensionContext,
	account: FeishuAccountConfig,
	mode: "dm" | "group",
): Promise<ObservedFeishuTarget | undefined> {
	return ctx.ui.custom<ObservedFeishuTarget | undefined>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(
			tui,
			theme,
			[
				mode === "dm" ? "Feishu DM setup" : "Feishu group setup",
				"",
				mode === "dm"
					? "Open a direct chat with the bot and send any message."
					: "Add the bot to the target group and send a message that the app is permitted to receive.",
				"",
				"The app must use long-connection event delivery and subscribe to im.message.receive_v1.",
			].join("\n"),
			{ cancellable: true },
		);
		let finished = false;
		const finish = (value?: ObservedFeishuTarget) => {
			if (finished) return;
			finished = true;
			done(value);
		};
		const wsClient = new Lark.WSClient({
			appId: account.appId,
			appSecret: account.appSecret,
			domain: Lark.Domain.Feishu,
			loggerLevel: Lark.LoggerLevel.warn,
			handshakeTimeoutMs: 15000,
			onError: (error) => {
				ctx.ui.notify(error.message, "error");
				finish(undefined);
			},
		});
		loader.onAbort = () => {
			wsClient.close({ force: true });
			finish(undefined);
		};
		const dispatcher = new Lark.EventDispatcher({}).register({
			"im.message.receive_v1": (event) => {
				const chatType = event.message.chat_type;
				const isDm = chatType === "p2p";
				if ((mode === "dm") !== isDm) return;
				const senderId =
					event.sender.sender_id?.open_id || event.sender.sender_id?.user_id || event.sender.sender_id?.union_id;
				const mentionName = event.message.mentions?.find((mention) => {
					const id = mention.id.open_id || mention.id.user_id || mention.id.union_id;
					return id === senderId;
				})?.name;
				wsClient.close({ force: true });
				finish({
					chatId: event.message.chat_id,
					chatName: isDm ? mentionName || senderId || event.message.chat_id : event.message.chat_id,
					dm: isDm,
					userId: senderId,
					userName: mentionName,
				});
			},
		});
		void wsClient.start({ eventDispatcher: dispatcher }).catch((error) => {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			finish(undefined);
		});
		return loader;
	});
}

export async function createFeishuAccountWithGuidedSetup(
	ctx: ExtensionContext,
	config: ChatConfig,
): Promise<string | undefined> {
	const appId = (await ctx.ui.input("Feishu app ID", "cli_..."))?.trim();
	if (!appId) return undefined;
	const appSecret = (await ctx.ui.input("Feishu app secret", ""))?.trim();
	if (!appSecret) return undefined;
	const validation = await runWithLoader(ctx, "Validating Feishu application...", () =>
		validateAccountDraft({ service: "feishu", appId, appSecret }),
	);
	if (validation.error) {
		await showNotice(ctx, "Feishu setup error", validation.error, "error");
		return undefined;
	}
	if (!validation.value) return undefined;
	const label = await ctx.ui.input("Account label", validation.value.identity.name || "feishu");
	if (label === undefined) return undefined;
	const accountId = ensureUniqueKey(
		config.accounts,
		makeAccountKey("feishu", label.trim() || validation.value.identity.name),
	);
	let account: FeishuAccountConfig = {
		service: "feishu",
		name: label.trim() || validation.value.identity.name,
		appId,
		appSecret,
		receiveMode: "auto",
		channels: {},
		access: { ignoreBots: true },
	};
	const snapshot = await runWithLoader(ctx, "Discovering Feishu group chats...", () =>
		refreshAccountSnapshot(accountId, account),
	);
	if (snapshot.error) {
		await showNotice(ctx, "Feishu setup error", snapshot.error, "error");
		return undefined;
	}
	if (!snapshot.value) return undefined;
	account = updateAccountIdentityFromSnapshot(account, snapshot.value) as FeishuAccountConfig;
	config.accounts[accountId] = account;
	await saveChatConfig(config);
	await showNotice(ctx, "Feishu account created", `Created ${accountId}`, "info");
	return accountId;
}

export async function addFeishuObservedTargetToAccount(
	ctx: ExtensionContext,
	config: ChatConfig,
	accountId: string,
	account: FeishuAccountConfig,
	mode: "dm" | "group",
): Promise<string | undefined> {
	const observed = await observeFeishuTarget(ctx, account, mode);
	if (!observed) return undefined;
	const access: AccessPolicy = {
		trigger: observed.dm ? "message" : "mention",
		ignoreBots: true,
		allowedUserIds: observed.dm && observed.userId ? [observed.userId] : undefined,
	};
	const baseKey = makeChannelKey(
		observed.dm ? `dm-${observed.userName || observed.chatName}` : observed.chatName,
		observed.chatId,
	);
	const existing = Object.entries(account.channels).find(([, channel]) => channel.id === observed.chatId)?.[0];
	const channelKey = existing ?? ensureUniqueKey(account.channels, baseKey);
	const channel: ConfiguredChannel = {
		id: observed.chatId,
		name: observed.chatName,
		dm: observed.dm,
		access,
	};
	account.channels[channelKey] = channel;
	config.accounts[accountId] = account;
	await saveChatConfig(config);
	await showNotice(ctx, "Feishu channel configured", `Configured ${accountId}/${channelKey}`, "info");
	return channelKey;
}
