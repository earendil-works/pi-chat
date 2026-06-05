import { WebClient } from "@slack/web-api";

import type { SlackAccountConfig } from "../core/config-types.js";
import type {
	AccountValidationResult,
	DiscoveredChannel,
	DiscoveredUser,
	DiscoverySnapshot,
} from "../core/discovery-types.js";
import type { AccountDraft, DiscoveryProvider } from "./types.js";

interface SlackConversation {
	id?: string;
	name?: string;
	is_channel?: boolean;
	is_group?: boolean;
	is_im?: boolean;
	is_archived?: boolean;
	user?: string;
}

interface SlackUser {
	id?: string;
	name?: string;
	real_name?: string;
	deleted?: boolean;
	is_bot?: boolean;
	profile?: {
		display_name?: string;
		real_name?: string;
		email?: string;
	};
}

function slackClient(botToken: string): WebClient {
	return new WebClient(botToken);
}

export function requireSlackAppToken(draft: AccountDraft): string {
	if (!draft.appToken?.trim()) throw new Error("Slack app-level token is required for Socket Mode.");
	return draft.appToken.trim();
}

export async function fetchSlackChannels(client: WebClient): Promise<DiscoveredChannel[]> {
	const channels: DiscoveredChannel[] = [];
	let cursor: string | undefined;
	do {
		const response = await client.conversations.list({
			cursor,
			limit: 200,
			types: "public_channel,private_channel,im",
			exclude_archived: true,
		});
		for (const conversation of (response.channels ?? []) as SlackConversation[]) {
			if (!conversation.id || conversation.is_archived) continue;
			channels.push({
				id: conversation.id,
				name: conversation.name || conversation.user || conversation.id,
				dm: Boolean(conversation.is_im),
			});
		}
		cursor = response.response_metadata?.next_cursor || undefined;
	} while (cursor);
	return channels.sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchSlackUsers(client: WebClient): Promise<DiscoveredUser[]> {
	const users: DiscoveredUser[] = [];
	let cursor: string | undefined;
	do {
		const response = await client.users.list({ cursor, limit: 200 });
		for (const user of (response.members ?? []) as SlackUser[]) {
			if (!user.id || user.deleted) continue;
			users.push({
				id: user.id,
				name: user.profile?.real_name || user.real_name || user.name || user.id,
				displayName: user.profile?.display_name || user.profile?.real_name || user.real_name || user.name,
				isBot: Boolean(user.is_bot),
			});
		}
		cursor = response.response_metadata?.next_cursor || undefined;
	} while (cursor);
	return users.sort((a, b) => a.name.localeCompare(b.name));
}

export const slackDiscoveryProvider: DiscoveryProvider = {
	service: "slack",
	async validate(draft: AccountDraft): Promise<AccountValidationResult> {
		requireSlackAppToken(draft);
		const client = slackClient(draft.botToken);
		const auth = await client.auth.test();
		if (!auth.ok || !auth.user_id) throw new Error("Slack bot token validation failed.");
		return {
			identity: {
				id: auth.user_id,
				name: String(auth.user || auth.user_id),
				userName: auth.user ? String(auth.user) : undefined,
				workspaceId: auth.team_id ? String(auth.team_id) : undefined,
				workspaceName: auth.team ? String(auth.team) : undefined,
			},
			warnings: [
				"Slack Socket Mode requires an app-level xapp token with connections:write and a bot token with chat/channel scopes.",
			],
		};
	},
	async fetchSnapshot(accountId: string, account: SlackAccountConfig): Promise<DiscoverySnapshot> {
		const validation = await this.validate({
			service: "slack",
			botToken: account.botToken,
			appToken: account.appToken,
			name: account.name,
		});
		const client = slackClient(account.botToken);
		const [channels, users] = await Promise.all([fetchSlackChannels(client), fetchSlackUsers(client)]);
		return {
			accountId,
			service: "slack",
			fetchedAt: new Date().toISOString(),
			identity: validation.identity,
			channels,
			users,
			roles: [],
			warnings: validation.warnings,
			capabilities: {
				canListChannels: channels.length > 0,
				canListUsers: users.length > 0,
				canListRoles: false,
			},
		};
	},
};
