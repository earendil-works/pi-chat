import * as Lark from "@larksuiteoapi/node-sdk";

import type { FeishuAccountConfig } from "../core/config-types.js";
import type {
	AccountValidationResult,
	DiscoveredChannel,
	DiscoveredUser,
	DiscoverySnapshot,
} from "../core/discovery-types.js";
import type { AccountDraft, DiscoveryProvider } from "./types.js";

interface FeishuBotInfo {
	code?: number;
	msg?: string;
	bot?: {
		open_id?: string;
		app_name?: string;
	};
}

export function createFeishuClient(credentials: { appId: string; appSecret: string }): Lark.Client {
	return new Lark.Client({
		appId: credentials.appId,
		appSecret: credentials.appSecret,
		appType: Lark.AppType.SelfBuild,
		domain: Lark.Domain.Feishu,
		loggerLevel: Lark.LoggerLevel.warn,
	});
}

export async function getFeishuBotInfo(credentials: {
	appId: string;
	appSecret: string;
}): Promise<{ id: string; name: string }> {
	const client = createFeishuClient(credentials);
	const response = (await client.request({
		method: "GET",
		url: "/open-apis/bot/v3/info",
	})) as FeishuBotInfo;
	if (response.code && response.code !== 0) throw new Error(response.msg || `Feishu API failed (${response.code})`);
	if (!response.bot?.open_id) throw new Error("Feishu bot info response did not include an open_id");
	return { id: response.bot.open_id, name: response.bot.app_name || "feishu-bot" };
}

async function listFeishuChats(account: FeishuAccountConfig): Promise<DiscoveredChannel[]> {
	const client = createFeishuClient(account);
	const channels: DiscoveredChannel[] = [];
	let pageToken: string | undefined;
	do {
		const response = await client.im.v1.chat.list({
			params: { page_size: 100, page_token: pageToken, sort_type: "ByActiveTimeDesc" },
		});
		if (response.code && response.code !== 0) throw new Error(response.msg || `Feishu API failed (${response.code})`);
		for (const chat of response.data?.items ?? []) {
			if (!chat.chat_id || chat.chat_status === "dissolved") continue;
			channels.push({
				id: chat.chat_id,
				name: chat.name || chat.chat_id,
				dm: chat.chat_mode === "p2p",
			});
		}
		pageToken = response.data?.has_more ? response.data.page_token : undefined;
	} while (pageToken);
	return channels;
}

async function listFeishuUsers(
	account: FeishuAccountConfig,
	channels: DiscoveredChannel[],
): Promise<{ users: DiscoveredUser[]; warnings: string[] }> {
	const client = createFeishuClient(account);
	const users = new Map<string, DiscoveredUser>();
	const warnings: string[] = [];
	for (const channel of channels) {
		let pageToken: string | undefined;
		try {
			do {
				const response = await client.im.v1.chatMembers.get({
					path: { chat_id: channel.id },
					params: { member_id_type: "open_id", page_size: 100, page_token: pageToken },
				});
				if (response.code && response.code !== 0)
					throw new Error(response.msg || `Feishu API failed (${response.code})`);
				for (const member of response.data?.items ?? []) {
					if (!member.member_id) continue;
					users.set(member.member_id, {
						id: member.member_id,
						name: member.name || member.member_id,
						displayName: member.name,
						isBot: false,
					});
				}
				pageToken = response.data?.has_more ? response.data.page_token : undefined;
			} while (pageToken);
		} catch (error) {
			warnings.push(
				`Could not list members for ${channel.name}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return { users: [...users.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings };
}

export const feishuDiscoveryProvider: DiscoveryProvider = {
	service: "feishu",
	async validate(draft: AccountDraft): Promise<AccountValidationResult> {
		if (draft.service !== "feishu") throw new Error("Invalid Feishu account draft");
		const bot = await getFeishuBotInfo(draft);
		return {
			identity: { id: bot.id, name: bot.name, userName: bot.name },
			warnings: [
				"Feishu group chats can be discovered automatically. P2P chats must be paired by observing a message after account creation.",
			],
		};
	},
	async fetchSnapshot(accountId: string, rawAccount): Promise<DiscoverySnapshot> {
		const account = rawAccount as FeishuAccountConfig;
		const bot = await getFeishuBotInfo(account);
		const channels = await listFeishuChats(account);
		const discovered = await listFeishuUsers(
			account,
			channels.filter((channel) => !channel.dm),
		);
		return {
			accountId,
			service: "feishu",
			fetchedAt: new Date().toISOString(),
			identity: { id: bot.id, name: bot.name, userName: bot.name },
			channels: channels.sort((a, b) => a.name.localeCompare(b.name)),
			users: discovered.users,
			roles: [],
			warnings: discovered.warnings.length > 0 ? discovered.warnings : undefined,
			capabilities: {
				canListChannels: true,
				canListUsers: discovered.users.length > 0,
				canListRoles: false,
			},
		};
	},
};
