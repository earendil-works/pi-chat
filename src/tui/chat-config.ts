import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
	CHAT_CONFIG_PATH,
	defaultMountGuestPath,
	loadChatConfig,
	removeAccountStorage,
	removeChannelStorage,
	resolveGondolinMounts,
	saveChatConfig,
} from "../config.js";
import type {
	AccessPolicy,
	ChatAccountConfig,
	ChatConfig,
	DiscordAccountConfig,
	FeishuAccountConfig,
	GondolinConfig,
	GondolinMountConfig,
	GondolinSecretConfig,
	TelegramAccountConfig,
	WeixinAccountConfig,
} from "../core/config-types.js";
import type { DiscoveredChannel, DiscoveredRole, DiscoveredUser, DiscoverySnapshot } from "../core/discovery-types.js";
import { makeChannelKey } from "../core/keys.js";
import { loadDiscoverySnapshot } from "../discovery-store.js";
import { refreshAccountSnapshot, updateAccountIdentityFromSnapshot } from "../services/index.js";
import { selectItem, showNotice, toggleItems } from "./dialogs.js";
import { createDiscordAccountWithGuidedSetup } from "./discord-setup.js";
import { addFeishuObservedTargetToAccount, createFeishuAccountWithGuidedSetup } from "./feishu-setup.js";
import { addTelegramObservedTargetToAccount, createTelegramAccountWithGuidedSetup } from "./telegram-setup.js";
import { addWeixinObservedTargetToAccount, createWeixinAccountWithGuidedSetup } from "./weixin-setup.js";

function accountDescription(account: ChatAccountConfig, snapshot: DiscoverySnapshot | undefined): string {
	const parts: string[] = [account.service];
	if (account.name) parts.push(account.name);
	if (account.service === "discord") parts.push(account.serverName);
	else if (snapshot?.identity.userName)
		parts.push(account.service === "telegram" ? `@${snapshot.identity.userName}` : snapshot.identity.userName);
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

function mountSummary(config: GondolinConfig | undefined): string {
	const count = (config?.mounts ?? []).length;
	return `${count} mount${count === 1 ? "" : "s"}`;
}

function mountLabel(mount: GondolinMountConfig): string {
	const guestPath = mount.guestPath?.trim() || defaultMountGuestPath(mount.hostPath);
	return `${guestPath} ← ${mount.hostPath}`;
}

function isEmptyGondolinConfig(config: GondolinConfig): boolean {
	return Object.keys(config.secrets ?? {}).length === 0 && (config.mounts ?? []).length === 0;
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
	let current: GondolinConfig = { ...config, secrets: { ...(config?.secrets ?? {}) } };
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
			const base: GondolinConfig = { ...current };
			delete base.secrets;
			const next = Object.keys(secrets).length > 0 ? { ...base, secrets } : base;
			await onSave(isEmptyGondolinConfig(next) ? undefined : next);
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

async function promptMountDraft(
	ctx: ExtensionContext,
	current?: GondolinMountConfig,
): Promise<GondolinMountConfig | undefined> {
	const hostPath = (await ctx.ui.input("Host directory to mount", current?.hostPath ?? "~/"))?.trim();
	if (!hostPath) return undefined;
	const guestPathInput = (
		await ctx.ui.input(`Guest path (empty = ${defaultMountGuestPath(hostPath)})`, current?.guestPath ?? "")
	)?.trim();
	const mode = await selectItem(ctx, "Mount mode", [
		{ value: "ro", label: "Read-only", description: "The agent can read files but cannot modify them" },
		{
			value: "rw",
			label: "Read-write",
			description: "The agent can create, modify, and delete files in the host directory",
		},
	]);
	if (!mode) return undefined;
	return { hostPath, guestPath: guestPathInput || undefined, readOnly: mode === "ro" };
}

async function configureMounts(
	ctx: ExtensionContext,
	title: string,
	config: GondolinConfig | undefined,
	onSave: (next: GondolinConfig | undefined) => Promise<void>,
): Promise<void> {
	let current: GondolinConfig = { ...config, mounts: [...(config?.mounts ?? [])] };
	while (true) {
		const mounts = current.mounts ?? [];
		const choice = await selectItem(ctx, title, [
			{ value: "__add__", label: "+ Add mount", description: "Expose a host directory inside the VM" },
			...mounts.map((mount, index) => ({
				value: String(index),
				label: mountLabel(mount),
				description: mount.readOnly ? "read-only" : "read-write",
			})),
			{ value: "__save__", label: "Save" },
			{ value: "__back__", label: "Back" },
		]);
		if (!choice || choice === "__back__") return;
		if (choice === "__save__") {
			try {
				resolveGondolinMounts(current);
			} catch (error) {
				await showNotice(ctx, "Invalid mounts", error instanceof Error ? error.message : String(error), "error");
				continue;
			}
			const base: GondolinConfig = { ...current };
			delete base.mounts;
			const next = mounts.length > 0 ? { ...base, mounts } : base;
			await onSave(isEmptyGondolinConfig(next) ? undefined : next);
			return;
		}
		if (choice === "__add__") {
			const draft = await promptMountDraft(ctx);
			if (!draft) continue;
			current = { ...current, mounts: [...mounts, draft] };
			continue;
		}
		const index = Number(choice);
		const existing = mounts[index];
		if (!existing) continue;
		const action = await selectItem(ctx, mountLabel(existing), [
			{ value: "edit", label: "Edit" },
			{ value: "delete", label: "Delete" },
			{ value: "back", label: "Back" },
		]);
		if (!action || action === "back") continue;
		if (action === "delete") {
			current = { ...current, mounts: mounts.filter((_, itemIndex) => itemIndex !== index) };
			continue;
		}
		const draft = await promptMountDraft(ctx, existing);
		if (!draft) continue;
		current = { ...current, mounts: mounts.map((mount, itemIndex) => (itemIndex === index ? draft : mount)) };
	}
}

async function promptAccessPolicy(
	ctx: ExtensionContext,
	current: AccessPolicy,
	snapshot: DiscoverySnapshot | undefined,
	dm: boolean,
): Promise<AccessPolicy | undefined> {
	let policy: AccessPolicy = { ...current };
	while (true) {
		const choice = await selectItem(ctx, "Access policy", [
			{ value: "trigger", label: `Trigger: ${policy.trigger ?? (dm ? "message" : "mention")}` },
			{ value: "bots", label: `Ignore bots: ${(policy.ignoreBots ?? true) ? "yes" : "no"}` },
			{ value: "users", label: `Allowed users: ${policy.allowedUserIds?.length ?? 0}` },
			{ value: "roles", label: `Allowed roles: ${policy.allowedRoleIds?.length ?? 0}` },
			{ value: "save", label: "Save" },
			{ value: "cancel", label: "Cancel" },
		]);
		if (!choice || choice === "cancel") return undefined;
		if (choice === "save") return policy;
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
	const access = await promptAccessPolicy(
		ctx,
		current?.access ?? defaultAccess(channel.dm ?? false),
		snapshot,
		channel.dm ?? false,
	);
	if (!access) return;
	account.channels[channelKey] = {
		id: channel.id,
		name: channel.name,
		dm: channel.dm,
		access,
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
			{ value: "mounts", label: "Mounts", description: mountSummary(channel.gondolin) },
			{ value: "delete", label: "Delete channel", description: "Remove this configured channel" },
			{ value: "back", label: "Back" },
		]);
		if (!choice || choice === "back") return;
		if (choice === "access") {
			const access = await promptAccessPolicy(
				ctx,
				channel.access ?? defaultAccess(channel.dm ?? false),
				snapshot,
				channel.dm ?? false,
			);
			if (!access) continue;
			channel.access = access;
			account.channels[channelKey] = channel;
			await saveChatConfig(config);
			await showNotice(ctx, "Channel updated", `Updated ${accountId}/${channelKey}`, "info");
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
		if (choice === "mounts") {
			await configureMounts(ctx, `${accountId}/${channelKey} mounts`, channel.gondolin, async (next) => {
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
			.map((channel) => ({
				value: channel.id,
				label: `${configuredIds.has(channel.id) ? "●" : "○"} ${channel.name}`,
				description: configuredIds.has(channel.id) ? "configured" : undefined,
			}))
			.sort((a, b) => {
				const aConfigured = a.label.startsWith("●") ? 0 : 1;
				const bConfigured = b.label.startsWith("●") ? 0 : 1;
				return aConfigured - bConfigured || a.label.localeCompare(b.label);
			});
		const choice = await selectItem(ctx, `${accountId} (${account.serverName})`, [
			{ value: "secrets", label: "Secrets", description: secretSummary(account.gondolin) },
			{ value: "mounts", label: "Mounts", description: mountSummary(account.gondolin) },
			{ value: "delete", label: "Delete account", description: "Remove account and all configured channels" },
			{
				value: "refresh",
				label: "Refresh channels",
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
		if (choice === "mounts") {
			await configureMounts(ctx, `${accountId} mounts`, account.gondolin, async (next) => {
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
			label: key,
			description: `${channel.name ?? channel.id}${channel.dm ? " • dm" : " • group"}`,
		}));
		const choice = await selectItem(ctx, `${accountId} (@${account.botUsername ?? "bot"})`, [
			{ value: "secrets", label: "Secrets", description: secretSummary(account.gondolin) },
			{ value: "mounts", label: "Mounts", description: mountSummary(account.gondolin) },
			{ value: "add-dm", label: "Add DM", description: "Pair a DM by sending /start to the bot" },
			{ value: "add-group", label: "Add group", description: "Observe activity after adding the bot to a group" },
			{ value: "refresh", label: "Refresh bot info" },
			{ value: "delete", label: "Delete account", description: "Remove account and all configured channels" },
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
		if (choice === "mounts") {
			await configureMounts(ctx, `${accountId} mounts`, account.gondolin, async (next) => {
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

async function configureFeishuAccount(ctx: ExtensionContext, accountId: string): Promise<void> {
	while (true) {
		const config = await loadChatConfig();
		const account = config.accounts[accountId] as FeishuAccountConfig | undefined;
		if (!account || account.service !== "feishu") return;
		const snapshot = await loadDiscoverySnapshot(accountId);
		const configuredIds = new Set(Object.values(account.channels).map((channel) => channel.id));
		const discoveredChoices = (snapshot?.channels ?? [])
			.map((channel) => ({
				value: channel.id,
				label: `${configuredIds.has(channel.id) ? "●" : "○"} ${channel.name}`,
				description: configuredIds.has(channel.id) ? "configured" : channel.dm ? "dm" : "group",
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
		const configuredOnlyChoices = Object.entries(account.channels)
			.filter(([, channel]) => !(snapshot?.channels ?? []).some((item) => item.id === channel.id))
			.map(([key, channel]) => ({
				value: `configured:${key}`,
				label: `● ${channel.name ?? key}`,
				description: channel.dm ? "configured dm" : "configured channel",
			}));
		const choice = await selectItem(ctx, `${accountId} (${account.botUsername ?? account.appId})`, [
			{ value: "secrets", label: "Secrets", description: secretSummary(account.gondolin) },
			{ value: "mounts", label: "Mounts", description: mountSummary(account.gondolin) },
			{
				value: "receive-mode",
				label: `Receive mode: ${account.receiveMode ?? "auto"}`,
				description: "Auto uses WebSocket for one channel and history polling for multiple channels",
			},
			{ value: "add-dm", label: "Add DM", description: "Observe a direct message sent to the bot" },
			{ value: "add-group", label: "Observe group", description: "Pair a group not returned by discovery" },
			{
				value: "refresh",
				label: "Refresh chats and members",
				description: snapshot?.fetchedAt ? `Last fetched ${snapshot.fetchedAt}` : "No snapshot yet",
			},
			{ value: "delete", label: "Delete account", description: "Remove account and all configured channels" },
			...configuredOnlyChoices,
			...discoveredChoices,
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
		if (choice === "mounts") {
			await configureMounts(ctx, `${accountId} mounts`, account.gondolin, async (next) => {
				account.gondolin = next;
				config.accounts[accountId] = account;
				await saveChatConfig(config);
			});
			continue;
		}
		if (choice === "receive-mode") {
			const receiveMode = await selectItem(ctx, "Feishu receive mode", [
				{
					value: "auto",
					label: "Auto",
					description: "WebSocket for one configured channel; polling for multiple channel workers",
				},
				{
					value: "websocket",
					label: "WebSocket",
					description: "Lowest latency; only one active client per Feishu application receives each event",
				},
				{
					value: "polling",
					label: "History polling",
					description: "Works across multiple workers; requires permission to read chat history",
				},
			]);
			if (!receiveMode) continue;
			account.receiveMode = receiveMode as FeishuAccountConfig["receiveMode"];
			config.accounts[accountId] = account;
			await saveChatConfig(config);
			continue;
		}
		if (choice === "add-dm" || choice === "add-group") {
			await addFeishuObservedTargetToAccount(ctx, config, accountId, account, choice === "add-dm" ? "dm" : "group");
			continue;
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
		if (choice === "delete") {
			const ok = await ctx.ui.confirm("Delete account", `Delete ${accountId} and all configured channels?`);
			if (!ok) continue;
			delete config.accounts[accountId];
			await saveChatConfig(config);
			await removeAccountStorage(accountId, ctx.cwd);
			await showNotice(ctx, "Account deleted", `Deleted ${accountId}`, "info");
			return;
		}
		if (choice.startsWith("configured:")) {
			await configureConfiguredChannel(ctx, config, accountId, choice.slice("configured:".length));
			continue;
		}
		const channel = snapshot?.channels.find((item) => item.id === choice);
		if (channel) await configureDiscoveredChannel(ctx, config, accountId, channel, snapshot);
	}
}

async function configureWeixinAccount(ctx: ExtensionContext, accountId: string): Promise<void> {
	while (true) {
		const config = await loadChatConfig();
		const account = config.accounts[accountId] as WeixinAccountConfig | undefined;
		if (!account || account.service !== "weixin") return;
		const channelChoices = Object.entries(account.channels).map(([key, channel]) => ({
			value: key,
			label: key,
			description: `${channel.name ?? channel.id} • direct message`,
		}));
		const choice = await selectItem(ctx, `${accountId} (${account.botUserId})`, [
			{ value: "secrets", label: "Secrets", description: secretSummary(account.gondolin) },
			{ value: "mounts", label: "Mounts", description: mountSummary(account.gondolin) },
			{ value: "add-dm", label: "Add DM", description: "Pair a direct chat by observing a new message" },
			{ value: "refresh", label: "Refresh account info" },
			{
				value: "delete",
				label: "Delete account",
				description: "Remove account and all configured direct-message channels",
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
		if (choice === "mounts") {
			await configureMounts(ctx, `${accountId} mounts`, account.gondolin, async (next) => {
				account.gondolin = next;
				config.accounts[accountId] = account;
				await saveChatConfig(config);
			});
			continue;
		}
		if (choice === "add-dm") {
			await addWeixinObservedTargetToAccount(ctx, config, accountId, account);
			continue;
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
	if (account.service === "feishu") return configureFeishuAccount(ctx, accountId);
	if (account.service === "weixin") return configureWeixinAccount(ctx, accountId);
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
			{ value: "__secrets__", label: "Secrets", description: secretSummary(config.gondolin) },
			{ value: "__mounts__", label: "Mounts", description: mountSummary(config.gondolin) },
			...snapshots.map(({ accountId, snapshot }) => ({
				value: accountId,
				label: accountId,
				description: accountDescription(config.accounts[accountId], snapshot),
			})),
			{
				value: "__create__",
				label: "+ Create account",
				description: "Create a Telegram, Discord, Feishu, or Weixin account",
			},
		]);
		if (!choice) return;
		if (choice === "__secrets__") {
			await configureSecrets(ctx, "pi-chat secrets", config.gondolin, async (next) => {
				config.gondolin = next;
				await saveChatConfig(config);
			});
			continue;
		}
		if (choice === "__mounts__") {
			await configureMounts(ctx, "pi-chat mounts", config.gondolin, async (next) => {
				config.gondolin = next;
				await saveChatConfig(config);
			});
			continue;
		}
		if (choice === "__create__") {
			const serviceChoice = await selectItem(ctx, "Create account", [
				{ value: "telegram", label: "Telegram" },
				{ value: "discord", label: "Discord" },
				{ value: "feishu", label: "Feishu" },
				{ value: "weixin", label: "Weixin", description: "Personal WeChat direct messages via iLink QR login" },
			]);
			if (!serviceChoice) continue;
			if (serviceChoice === "telegram") {
				const accountId = await createTelegramAccountWithGuidedSetup(ctx, config);
				if (accountId) await configureAccount(ctx, accountId);
				continue;
			}
			if (serviceChoice === "feishu") {
				const accountId = await createFeishuAccountWithGuidedSetup(ctx, config);
				if (accountId) await configureAccount(ctx, accountId);
				continue;
			}
			if (serviceChoice === "weixin") {
				const accountId = await createWeixinAccountWithGuidedSetup(ctx, config);
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
