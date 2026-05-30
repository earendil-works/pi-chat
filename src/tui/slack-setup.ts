import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { saveChatConfig } from "../config.js";
import type { ChatConfig, SlackAccountConfig } from "../core/config-types.js";
import { makeAccountKey } from "../core/keys.js";
import { refreshAccountSnapshot, updateAccountIdentityFromSnapshot, validateAccountDraft } from "../services/index.js";
import { runWithLoader, showNotice } from "./dialogs.js";

interface SlackDraft {
	name: string;
	botToken: string;
	appToken: string;
}

function ensureUniqueKey(existing: Record<string, unknown>, base: string): string {
	if (!existing[base]) return base;
	let index = 2;
	while (existing[`${base}-${index}`]) index += 1;
	return `${base}-${index}`;
}

async function promptSlackDraft(ctx: ExtensionContext): Promise<SlackDraft | undefined> {
	const label = await ctx.ui.input("Slack account label", "slack-bot");
	if (label === undefined) return undefined;
	const botToken = await ctx.ui.input("Slack bot token (xoxb-...)", "");
	if (botToken === undefined || !botToken.trim()) return undefined;
	const appToken = await ctx.ui.input("Slack app token (xapp-...)", "");
	if (appToken === undefined || !appToken.trim()) return undefined;
	return {
		name: label.trim() || "slack-bot",
		botToken: botToken.trim(),
		appToken: appToken.trim(),
	};
}

export async function createSlackAccountWithGuidedSetup(
	ctx: ExtensionContext,
	config: ChatConfig,
): Promise<string | undefined> {
	const draft = await promptSlackDraft(ctx);
	if (!draft) return undefined;
	const validation = await runWithLoader(ctx, "Validating Slack app credentials...", () =>
		validateAccountDraft({
			service: "slack",
			botToken: draft.botToken,
			appToken: draft.appToken,
			name: draft.name,
		}),
	);
	if (validation.error) {
		await showNotice(ctx, "Slack setup error", validation.error, "error");
		return undefined;
	}
	if (!validation.value) return undefined;
	const key = ensureUniqueKey(config.accounts, makeAccountKey("slack", draft.name));
	let account: SlackAccountConfig = {
		service: "slack",
		name: draft.name,
		botToken: draft.botToken,
		appToken: draft.appToken,
		channels: {},
		access: { ignoreBots: true },
	};
	const snapshot = await runWithLoader(ctx, "Discovering Slack channels and users...", () =>
		refreshAccountSnapshot(key, account),
	);
	if (snapshot.error) {
		await showNotice(ctx, "Slack setup error", snapshot.error, "error");
		return undefined;
	}
	if (!snapshot.value) return undefined;
	account = updateAccountIdentityFromSnapshot(account, snapshot.value) as SlackAccountConfig;
	config.accounts[key] = account;
	await saveChatConfig(config);
	await showNotice(ctx, "Slack account created", `Created ${key}`, "info");
	return key;
}
