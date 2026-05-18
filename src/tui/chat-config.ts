import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
	CHAT_CONFIG_PATH,
	loadChatConfig,
	removeAccountStorage,
	removeChannelStorage,
	saveChatConfig,
} from "../config.js";
import type {
	AccessPolicy,
	ChannelMode,
	ChatAccountConfig,
	ChatConfig,
	DiscordAccountConfig,
	GondolinConfig,
	GondolinSecretConfig,
	TelegramAccountConfig,
} from "../core/config-types.js";
import type { DiscoveredChannel, DiscoveredRole, DiscoveredUser, DiscoverySnapshot } from "../core/discovery-types.js";
import { makeChannelKey } from "../core/keys.js";
import { loadDiscoverySnapshot } from "../discovery-store.js";
import { refreshAccountSnapshot, updateAccountIdentityFromSnapshot } from "../services/index.js";
import { selectItem, showNotice, toggleItems } from "./dialogs.js";
import { createDiscordAccountWithGuidedSetup } from "./discord-setup.js";
import { addTelegramObservedTargetToAccount, createTelegramAccountWithGuidedSetup } from "./telegram-setup.js";

function serviceIcon(service: ChatAccountConfig["service"]): string {
	return service === "discord" ? "💬" : "✈️";
}

function accountDescription(account: ChatAccountConfig, snapshot: DiscoverySnapshot | undefined): string {
	const parts: string[] = [`${serviceIcon(account.service)} ${account.service}`];
	if (account.name) parts.push(account.name);
	if (account.service === "discord") parts.push(account.serverName);
	else if (snapshot?.identity.userName) parts.push(`@${snapshot.identity.userName}`);
	parts.push(
		`${Object.keys(account.channels).length} configured channel${Object.keys(account.channels).length === 1 ? "" : "s"}`,
	);
	return parts.join(" • ");
}

function toUserToggleItems(
	users: DiscoveredUser[],
	selectedIds: string[] = [],
): Array<{ id: string; label: string; description?: string }> {
	const items = new Map<string, { id: string; label: string; description?: string }>();
	for (const user of users) {
		items.set(user.id, {
			id: user.id,
			label: user.displayName || user.name,
			description: user.displayName && user.displayName !== user.name ? user.name : undefined,
		});
	}
	for (const id of selectedIds) if (!items.has(id)) items.set(id, { id, label: id, description: "stored id" });
	return [...items.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function toRoleToggleItems(
	roles: DiscoveredRole[],
	selectedIds: string[] = [],
): Array<{ id: string; label: string; description?: string }> {
	const items = new Map<string, { id: string; label: string; description?: string }>();
	for (const role of roles) items.set(role.id, { id: role.id, label: role.name });
	for (const id of selectedIds) if (!items.has(id)) items.set(id, { id, label: id, description: "stored id" });
	return [...items.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function defaultAccess(dm: boolean): AccessPolicy {
	return { trigger: dm ? "message" : "mention", ignoreBots: true };
}

function secretSummary(config: GondolinConfig | undefined): string {
	const count = Object.keys(config?.secrets ?? {}).length;
	return `${count} secret${count === 1 ? "" : "s"}`;
}

function presetSummary(config: GondolinConfig | undefined): string {
	const count = Object.keys(config?.presets ?? {}).length;
	return `${count} preset${count === 1 ? "" : "s"}`;
}

function modeLabel(mode: ChannelMode | undefined): string {
	if (mode === "community") return "community — Baldy public assistant";
	if (mode === "mirror") return "mirror — lightweight notification/response";
	return "admin — full pi-chat";
}

function channelSummary(channel: {
	dm?: boolean;
	mode?: ChannelMode;
	sandbox?: boolean;
	gondolin?: GondolinConfig;
}): string {
	return [
		channel.dm ? "DM" : "group",
		channel.mode ?? "admin",
		channel.sandbox === false ? "host tools" : "sandbox",
		secretSummary(channel.gondolin),
	]
		.filter(Boolean)
		.join(" • ");
}

function isValidEnvVarName(value: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

async function promptSecretDraft(
	ctx: ExtensionContext,
	name?: string,
	current?: GondolinSecretConfig,
): Promise<{ name: string; secret: GondolinSecretConfig } | undefined> {
	const secretName = (await ctx.ui.input("VM env var name", name ?? "GITHUB_TOKEN"))?.trim();
	if (!secretName) return undefined;
	if (!isValidEnvVarName(secretName)) {
		await showNotice(ctx, "Invalid secret", "VM env var name must look like GITHUB_TOKEN.", "error");
		return undefined;
	}
	const valueLabel = current ? "Secret value (leave empty to keep current)" : "Secret value";
	const inputValue = (await ctx.ui.input(valueLabel, "")) ?? "";
	const secretValue = inputValue.length > 0 ? inputValue : current?.value;
	if (!secretValue) return undefined;
	const hostsRaw = (
		await ctx.ui.input("Allowed hosts (comma separated)", (current?.hosts ?? ["api.github.com"]).join(", "))
	)?.trim();
	if (!hostsRaw) return undefined;
	const hosts = hostsRaw
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (hosts.length === 0) {
		await showNotice(ctx, "Invalid secret", "At least one host is required.", "error");
		return undefined;
	}
	return { name: secretName, secret: { value: secretValue, hosts } };
}

async function configureSecrets(
	ctx: ExtensionContext,
	title: string,
	config: GondolinConfig | undefined,
	onSave: (next: GondolinConfig | undefined) => Promise<void>,
): Promise<void> {
	let current: GondolinConfig = { secrets: { ...(config?.secrets ?? {}) } };
	while (true) {
		const secrets = current.secrets ?? {};
		const choice = await selectItem(ctx, title, [
			{ value: "__add__", label: "+ Add secret", description: "Expose a placeholder env var inside Gondolin" },
			...Object.entries(secrets)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([name, secret]) => ({
					value: name,
					label: name,
					description: secret.hosts.join(", "),
				})),
			{ value: "__save__", label: "Save" },
			{ value: "__back__", label: "Back" },
		]);
		if (!choice || choice === "__back__") return;
		if (choice === "__save__") {
			const next = Object.keys(current.secrets ?? {}).length > 0 ? current : undefined;
			await onSave(next);
			return;
		}
		if (choice === "__add__") {
			const draft = await promptSecretDraft(ctx);
			if (!draft) continue;
			current = { ...current, secrets: { ...(current.secrets ?? {}), [draft.name]: draft.secret } };
			continue;
		}
		const existing = current.secrets?.[choice];
		if (!existing) continue;
		const action = await selectItem(ctx, choice, [
			{ value: "edit", label: "Edit" },
			{ value: "delete", label: "Delete" },
			{ value: "back", label: "Back" },
		]);
		if (!action || action === "back") continue;
		if (action === "delete") {
			const nextSecrets = { ...(current.secrets ?? {}) };
			delete nextSecrets[choice];
			current = { ...current, secrets: nextSecrets };
			continue;
		}
		const draft = await promptSecretDraft(ctx, choice, existing);
		if (!draft) continue;
		const nextSecrets = { ...(current.secrets ?? {}) };
		if (draft.name !== choice) delete nextSecrets[choice];
		nextSecrets[draft.name] = draft.secret;
		current = { ...current, secrets: nextSecrets };
	}
}

async function configurePreset(
	ctx: ExtensionContext,
	presetName: string,
	current: Record<string, GondolinSecretConfig>,
): Promise<Record<string, GondolinSecretConfig> | undefined> {
	let secrets = { ...current };
	while (true) {
		const choice = await selectItem(ctx, `${presetName} preset`, [
			{ value: "__add__", label: "+ Add secret" },
			...Object.entries(secrets)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([name, secret]) => ({ value: name, label: name, description: secret.hosts.join(", ") })),
			{ value: "__save__", label: "Save" },
			{ value: "__back__", label: "Back" },
		]);
		if (!choice || choice === "__back__") return undefined;
		if (choice === "__save__") return secrets;
		if (choice === "__add__") {
			const draft = await promptSecretDraft(ctx);
			if (!draft) continue;
			secrets = { ...secrets, [draft.name]: draft.secret };
			continue;
		}
		const existing = secrets[choice];
		if (!existing) continue;
		const action = await selectItem(ctx, choice, [
			{ value: "edit", label: "Edit" },
			{ value: "delete", label: "Delete" },
			{ value: "back", label: "Back" },
		]);
		if (!action || action === "back") continue;
		if (action === "delete") {
			const next = { ...secrets };
			delete next[choice];
			secrets = next;
			continue;
		}
		const draft = await promptSecretDraft(ctx, choice, existing);
		if (!draft) continue;
		const next = { ...secrets };
		if (draft.name !== choice) delete next[choice];
		next[draft.name] = draft.secret;
		secrets = next;
	}
}

async function configurePresets(
	ctx: ExtensionContext,
	title: string,
	config: GondolinConfig | undefined,
	onSave: (next: GondolinConfig | undefined) => Promise<void>,
): Promise<void> {
	let presets: Record<string, Record<string, GondolinSecretConfig>> = { ...(config?.presets ?? {}) };
	while (true) {
		const choice = await selectItem(ctx, title, [
			{ value: "__add__", label: "+ Add preset", description: "Create a named group of secrets" },
			...Object.entries(presets)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([name, secrets]) => ({
					value: name,
					label: name,
					description: `${Object.keys(secrets).length} secret(s)`,
				})),
			{ value: "__save__", label: "Save" },
			{ value: "__back__", label: "Back" },
		]);
		if (!choice || choice === "__back__") return;
		if (choice === "__save__") {
			const next: GondolinConfig | undefined =
				Object.keys(presets).length > 0 || config?.secrets
					? { ...config, presets: Object.keys(presets).length > 0 ? presets : undefined }
					: undefined;
			await onSave(next);
			return;
		}
		if (choice === "__add__") {
			const name = (await ctx.ui.input("Preset name (e.g. admin, community)", ""))?.trim();
			if (!name) continue;
			if (presets[name]) {
				await showNotice(ctx, "Already exists", `Preset "${name}" already exists.`, "error");
				continue;
			}
			presets = { ...presets, [name]: {} };
			continue;
		}
		const action = await selectItem(ctx, choice, [
			{ value: "edit", label: "Edit secrets" },
			{ value: "rename", label: "Rename" },
			{ value: "delete", label: "Delete" },
			{ value: "back", label: "Back" },
		]);
		if (!action || action === "back") continue;
		if (action === "delete") {
			const ok = await ctx.ui.confirm("Delete preset", `Delete preset "${choice}"?`);
			if (!ok) continue;
			const { [choice]: _del, ...rest } = presets;
			presets = rest;
			continue;
		}
		if (action === "rename") {
			const newName = (await ctx.ui.input("New preset name", choice))?.trim();
			if (!newName || newName === choice) continue;
			if (presets[newName]) {
				await showNotice(ctx, "Already exists", `Preset "${newName}" already exists.`, "error");
				continue;
			}
			const { [choice]: existing, ...rest } = presets;
			presets = { ...rest, [newName]: existing };
			continue;
		}
		if (action === "edit") {
			const updated = await configurePreset(ctx, choice, presets[choice] ?? {});
			if (updated !== undefined) presets = { ...presets, [choice]: updated };
		}
	}
}

async function promptAccessPolicy(
	ctx: ExtensionContext,
	current: AccessPolicy,
	snapshot: DiscoverySnapshot | undefined,
	dm: boolean,
	sandbox?: boolean,
	availablePresets: Record<string, Record<string, GondolinSecretConfig>> = {},
	activePresetsIn: string[] = [],
	modeIn?: ChannelMode,
): Promise<{ policy: AccessPolicy; sandbox?: boolean; activePresets: string[]; mode?: ChannelMode } | undefined> {
	let policy: AccessPolicy = { ...current };
	let sandboxEnabled = sandbox !== false;
	let activePresets = [...activePresetsIn];
	let currentMode = modeIn;
	while (true) {
		const choice = await selectItem(ctx, "Access policy", [
			{ value: "trigger", label: `Trigger: ${policy.trigger ?? (dm ? "message" : "mention")}` },
			{ value: "bots", label: `Ignore bots: ${(policy.ignoreBots ?? true) ? "yes" : "no"}` },
			{ value: "users", label: `Allowed users: ${policy.allowedUserIds?.length ?? 0}` },
			{ value: "roles", label: `Allowed roles: ${policy.allowedRoleIds?.length ?? 0}` },
			{
				value: "secrets",
				label: `Secrets: ${activePresets.length > 0 ? activePresets.join(", ") : "none"}`,
				description: `${Object.keys(availablePresets).length} preset(s) available`,
			},
			{
				value: "sandbox",
				label: `Sandbox: ${sandboxEnabled ? "enabled" : "disabled"}`,
				description: sandboxEnabled ? "Tools run inside the Gondolin VM" : "Tools run directly on the host system",
			},
			{
				value: "mode",
				label: `Mode: ${currentMode ?? "admin"}`,
				description: modeLabel(currentMode),
			},
			{ value: "save", label: "Save" },
			{ value: "cancel", label: "Cancel" },
		]);
		if (!choice || choice === "cancel") return undefined;
		if (choice === "save")
			return { policy, sandbox: sandboxEnabled ? undefined : false, activePresets, mode: currentMode };
		if (choice === "mode") {
			const selected = await selectItem(ctx, "Channel mode", [
				{ value: "admin", label: "Admin", description: "Full pi-chat: job queue, VM sandbox, all tools" },
				{
					value: "community",
					label: "Community",
					description: "Baldy public assistant — limited tools, football/tactics",
				},
				{ value: "mirror", label: "Mirror", description: "Lightweight: send images, receive final output, respond" },
			]);
			if (selected) currentMode = selected === "admin" ? undefined : (selected as ChannelMode);
			continue;
		}
		if (choice === "secrets") {
			const presetNames = Object.keys(availablePresets);
			if (presetNames.length === 0) {
				await showNotice(
					ctx,
					"No presets",
					"No secret presets configured. Add presets via Secret presets in the main menu.",
					"warning",
				);
				continue;
			}
			const items = presetNames.map((name) => ({
				id: name,
				label: name,
				description: `${Object.keys(availablePresets[name] ?? {}).length} secret(s)`,
			}));
			const selected = await toggleItems(ctx, "Active secret presets", items, activePresets);
			if (selected != null) activePresets = selected;
			continue;
		}
		if (choice === "sandbox") {
			sandboxEnabled = await ctx.ui.confirm(
				"Sandbox",
				`Sandbox is currently ${sandboxEnabled ? "enabled" : "disabled"}. Enable sandbox (Gondolin VM)?`,
			);
			continue;
		}
		if (choice === "trigger") {
			const selected = await selectItem(ctx, "Trigger mode", [
				{ value: "mention", label: "Mention", description: "Only @mentions create jobs" },
				{
					value: "message",
					label: "Message",
					description: dm ? "Every DM message creates a job" : "Every matching message creates a job",
				},
			]);
			if (selected) policy = { ...policy, trigger: selected as AccessPolicy["trigger"] };
			continue;
		}
		if (choice === "bots") {
			policy = {
				...policy,
				ignoreBots: await ctx.ui.confirm(
					"Ignore bot messages",
					`Current value: ${(policy.ignoreBots ?? true) ? "yes" : "no"}`,
				),
			};
			continue;
		}
		if (choice === "users") {
			const items = toUserToggleItems(snapshot?.users ?? [], policy.allowedUserIds ?? []);
			if (items.length === 0) {
				await showNotice(ctx, "No discovered users", "No discovered users available for this account.", "warning");
				continue;
			}
			const selected = await toggleItems(ctx, "Allowed users", items, policy.allowedUserIds ?? []);
			if (selected) policy = { ...policy, allowedUserIds: selected.length > 0 ? selected : undefined };
			continue;
		}
		if (choice === "roles") {
			const items = toRoleToggleItems(snapshot?.roles ?? [], policy.allowedRoleIds ?? []);
			if (items.length === 0) {
				await showNotice(ctx, "No discovered roles", "No discovered roles available for this account.", "warning");
				continue;
			}
			const selected = await toggleItems(ctx, "Allowed roles", items, policy.allowedRoleIds ?? []);
			if (selected) policy = { ...policy, allowedRoleIds: selected.length > 0 ? selected : undefined };
		}
	}
}

async function configureDiscoveredChannel(
	ctx: ExtensionContext,
	config: ChatConfig,
	accountId: string,
	channel: DiscoveredChannel,
	snapshot: DiscoverySnapshot | undefined,
): Promise<void> {
	const account = config.accounts[accountId];
	if (!account) return;
	const existingKey = Object.entries(account.channels).find(([, item]) => item.id === channel.id)?.[0];
	const channelKey = existingKey ?? makeChannelKey(channel.name, channel.id);
	const current = account.channels[channelKey];
	const availablePresets = { ...(config.gondolin?.presets ?? {}), ...(account.gondolin?.presets ?? {}) };
	const access = await promptAccessPolicy(
		ctx,
		current?.access ?? defaultAccess(channel.dm ?? false),
		snapshot,
		channel.dm ?? false,
		current?.sandbox,
		availablePresets,
		current?.gondolin?.activePresets ?? [],
		current?.mode,
	);
	if (!access) return;
	const gondolinUpdate: GondolinConfig | undefined =
		access.activePresets.length > 0
			? { ...(current?.gondolin ?? {}), activePresets: access.activePresets }
			: current?.gondolin
				? (({ activePresets: _ap, ...rest }) => (Object.keys(rest).length > 0 ? (rest as GondolinConfig) : undefined))(
						current.gondolin,
					)
				: undefined;
	account.channels[channelKey] = {
		id: channel.id,
		name: channel.name,
		dm: channel.dm,
		...(access.mode ? { mode: access.mode } : {}),
		access: access.policy,
		...(access.sandbox === false ? { sandbox: false } : {}),
		...(gondolinUpdate ? { gondolin: gondolinUpdate } : {}),
	};
	await saveChatConfig(config);
	await showNotice(ctx, "Channel configured", `Configured ${accountId}/${channelKey}`, "info");
}

async function configureConfiguredChannel(
	ctx: ExtensionContext,
	config: ChatConfig,
	accountId: string,
	channelKey: string,
): Promise<void> {
	const account = config.accounts[accountId];
	const channel = account?.channels[channelKey];
	if (!account || !channel) return;
	const snapshot = await loadDiscoverySnapshot(accountId);
	while (true) {
		const choice = await selectItem(ctx, `${accountId}/${channelKey}`, [
			{ value: "access", label: "Edit access policy" },
			{ value: "secrets", label: "Secrets", description: secretSummary(channel.gondolin) },
			{ value: "delete", label: "Delete channel", description: "Remove this configured channel" },
			{ value: "back", label: "Back" },
		]);
		if (!choice || choice === "back") return;
		if (choice === "access") {
			const availablePresets = { ...(config.gondolin?.presets ?? {}), ...(account.gondolin?.presets ?? {}) };
			const result = await promptAccessPolicy(
				ctx,
				channel.access ?? defaultAccess(channel.dm ?? false),
				snapshot,
				channel.dm ?? false,
				channel.sandbox,
				availablePresets,
				channel.gondolin?.activePresets ?? [],
				channel.mode,
			);
			if (!result) continue;
			channel.access = result.policy;
			if (result.sandbox === false) channel.sandbox = false;
			else delete channel.sandbox;
			channel.mode = result.mode;
			if (result.activePresets.length > 0) {
				channel.gondolin = { ...(channel.gondolin ?? {}), activePresets: result.activePresets };
			} else if (channel.gondolin) {
				const { activePresets: _ap, ...rest } = channel.gondolin;
				channel.gondolin = Object.keys(rest).length > 0 ? (rest as GondolinConfig) : undefined;
			}
			account.channels[channelKey] = channel;
			await saveChatConfig(config);
			await showNotice(ctx, "Channel updated", `Updated ${accountId}/${channelKey}`, "info");
			continue;
		}
		if (choice === "sandbox") {
			const enable = await ctx.ui.confirm(
				"Sandbox",
				`Sandbox is currently ${channel.sandbox === false ? "disabled" : "enabled"}. Enable sandbox (Gondolin VM)?`,
			);
			const newValue = enable ? undefined : false;
			if (newValue !== channel.sandbox) {
				if (newValue === undefined) delete channel.sandbox;
				else channel.sandbox = newValue;
				account.channels[channelKey] = channel;
				await saveChatConfig(config);
				await showNotice(
					ctx,
					"Channel updated",
					`Sandbox ${enable ? "enabled" : "disabled"} for ${accountId}/${channelKey}`,
					"info",
				);
			}
			continue;
		}
		if (choice === "secrets") {
			await configureSecrets(ctx, `${accountId}/${channelKey} secrets`, channel.gondolin, async (next) => {
				channel.gondolin = next;
				account.channels[channelKey] = channel;
				await saveChatConfig(config);
			});
			continue;
		}
		if (choice === "delete") {
			const ok = await ctx.ui.confirm("Delete configured channel", `Delete ${accountId}/${channelKey}?`);
			if (!ok) continue;
			delete account.channels[channelKey];
			await saveChatConfig(config);
			await removeChannelStorage(accountId, channelKey, ctx.cwd);
			await showNotice(ctx, "Channel deleted", `Deleted ${accountId}/${channelKey}`, "info");
			return;
		}
	}
}

async function configureDiscordAccount(ctx: ExtensionContext, accountId: string): Promise<void> {
	while (true) {
		const config = await loadChatConfig();
		const account = config.accounts[accountId] as DiscordAccountConfig | undefined;
		if (!account || account.service !== "discord") return;
		const snapshot = await loadDiscoverySnapshot(accountId);
		const configuredIds = new Set(Object.values(account.channels).map((channel) => channel.id));
		const channelChoices = (snapshot?.channels ?? [])
			.map((channel) => {
				const configured = configuredIds.has(channel.id);
				return {
					value: channel.id,
					label: `${configured ? "✓" : "+"} # ${channel.name}`,
					description: configured ? "configured — enter to edit access" : "not configured — enter to add",
				};
			})
			.sort((a, b) => {
				const aConfigured = a.label.startsWith("✓") ? 0 : 1;
				const bConfigured = b.label.startsWith("✓") ? 0 : 1;
				return aConfigured - bConfigured || a.label.localeCompare(b.label);
			});
		const choice = await selectItem(ctx, `${accountId} (${account.serverName})`, [
			{ value: "secrets", label: "🔐 Secrets", description: secretSummary(account.gondolin) },
			{ value: "delete", label: "🗑 Delete account", description: "Remove account and all configured channels" },
			{
				value: "refresh",
				label: "↻ Refresh channels",
				description: snapshot?.fetchedAt ? `Last fetched ${snapshot.fetchedAt}` : "No snapshot yet",
			},
			...channelChoices,
			{ value: "back", label: "Back" },
		]);
		if (!choice || choice === "back") return;
		if (choice === "secrets") {
			await configureSecrets(ctx, `${accountId} secrets`, account.gondolin, async (next) => {
				account.gondolin = next;
				config.accounts[accountId] = account;
				await saveChatConfig(config);
			});
			continue;
		}
		if (choice === "delete") {
			const ok = await ctx.ui.confirm("Delete account", `Delete ${accountId} and all configured channels?`);
			if (!ok) continue;
			delete config.accounts[accountId];
			await saveChatConfig(config);
			await removeAccountStorage(accountId, ctx.cwd);
			await showNotice(ctx, "Account deleted", `Deleted ${accountId}`, "info");
			return;
		}
		if (choice === "refresh") {
			const fresh = await refreshAccountSnapshot(accountId, account);
			config.accounts[accountId] = updateAccountIdentityFromSnapshot(account, fresh);
			await saveChatConfig(config);
			if ((fresh.warnings?.length ?? 0) > 0) {
				await showNotice(ctx, "Refresh warnings", (fresh.warnings ?? []).join("\n"), "warning");
			}
			continue;
		}
		const selectedChannel = snapshot?.channels.find((channel) => channel.id === choice);
		if (selectedChannel) await configureDiscoveredChannel(ctx, config, accountId, selectedChannel, snapshot);
	}
}

async function configureTelegramAccount(ctx: ExtensionContext, accountId: string): Promise<void> {
	while (true) {
		const config = await loadChatConfig();
		const account = config.accounts[accountId] as TelegramAccountConfig | undefined;
		if (!account || account.service !== "telegram") return;
		const channelChoices = Object.entries(account.channels).map(([key, channel]) => ({
			value: key,
			label: `${channel.dm ? "✉" : "#"} ${key}`,
			description: `${channel.name ?? channel.id} • ${channelSummary(channel)}`,
		}));
		const choice = await selectItem(ctx, `${accountId} (@${account.botUsername ?? "bot"})`, [
			{ value: "secrets", label: "🔐 Secrets", description: secretSummary(account.gondolin) },
			{ value: "add-dm", label: "+ Add DM", description: "Pair a DM by sending /start to the bot" },
			{ value: "add-group", label: "+ Add group", description: "Observe activity after adding the bot to a group" },
			{ value: "refresh", label: "↻ Refresh bot info" },
			{ value: "delete", label: "🗑 Delete account", description: "Remove account and all configured channels" },
			...channelChoices,
			{ value: "back", label: "Back" },
		]);
		if (!choice || choice === "back") return;
		if (choice === "secrets") {
			await configureSecrets(ctx, `${accountId} secrets`, account.gondolin, async (next) => {
				account.gondolin = next;
				config.accounts[accountId] = account;
				await saveChatConfig(config);
			});
			continue;
		}
		if (choice === "add-dm") {
			await addTelegramObservedTargetToAccount(ctx, config, accountId, account, "dm");
			continue;
		}
		if (choice === "add-group") {
			await addTelegramObservedTargetToAccount(ctx, config, accountId, account, "group");
			continue;
		}
		if (choice === "refresh") {
			const fresh = await refreshAccountSnapshot(accountId, account);
			config.accounts[accountId] = updateAccountIdentityFromSnapshot(account, fresh);
			await saveChatConfig(config);
			continue;
		}
		if (choice === "delete") {
			const ok = await ctx.ui.confirm("Delete account", `Delete ${accountId} and all configured channels?`);
			if (!ok) continue;
			delete config.accounts[accountId];
			await saveChatConfig(config);
			await removeAccountStorage(accountId, ctx.cwd);
			await showNotice(ctx, "Account deleted", `Deleted ${accountId}`, "info");
			return;
		}
		await configureConfiguredChannel(ctx, config, accountId, choice);
	}
}

async function configureAccount(ctx: ExtensionContext, accountId: string): Promise<void> {
	const config = await loadChatConfig();
	const account = config.accounts[accountId];
	if (!account) return;
	if (account.service === "discord") return configureDiscordAccount(ctx, accountId);
	if (account.service === "telegram") return configureTelegramAccount(ctx, accountId);
}

export async function runChatConfigUI(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(CHAT_CONFIG_PATH, "info");
		return;
	}
	while (true) {
		const config = await loadChatConfig();
		const snapshots = await Promise.all(
			Object.keys(config.accounts)
				.sort()
				.map(async (accountId) => ({ accountId, snapshot: await loadDiscoverySnapshot(accountId) })),
		);
		const choice = await selectItem(ctx, "pi-chat accounts", [
			{ value: "__secrets__", label: "🔐 Global secrets", description: secretSummary(config.gondolin) },
			{ value: "__presets__", label: "🧰 Secret presets", description: presetSummary(config.gondolin) },
			...snapshots.map(({ accountId, snapshot }) => ({
				value: accountId,
				label: `${serviceIcon(config.accounts[accountId].service)} ${accountId}`,
				description: accountDescription(config.accounts[accountId], snapshot),
			})),
			{ value: "__create__", label: "+ Create account", description: "Create a Telegram or Discord account" },
		]);
		if (!choice) return;
		if (choice === "__secrets__") {
			await configureSecrets(ctx, "pi-chat secrets", config.gondolin, async (next) => {
				config.gondolin = next;
				await saveChatConfig(config);
			});
			continue;
		}
		if (choice === "__presets__") {
			await configurePresets(ctx, "Secret presets", config.gondolin, async (next) => {
				config.gondolin = next;
				await saveChatConfig(config);
			});
			continue;
		}
		if (choice === "__create__") {
			const serviceChoice = await selectItem(ctx, "Create account", [
				{ value: "telegram", label: "Telegram" },
				{ value: "discord", label: "Discord" },
			]);
			if (!serviceChoice) continue;
			if (serviceChoice === "telegram") {
				const accountId = await createTelegramAccountWithGuidedSetup(ctx, config);
				if (accountId) await configureAccount(ctx, accountId);
				continue;
			}
			const accountId = await createDiscordAccountWithGuidedSetup(ctx, config);
			if (accountId) await configureAccount(ctx, accountId);
			continue;
		}
		await configureAccount(ctx, choice);
	}
}
