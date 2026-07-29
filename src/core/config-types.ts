export type ChatService = "telegram" | "discord" | "feishu" | "weixin";

export type TriggerMode = "mention" | "message";

export interface AccessPolicy {
	trigger?: TriggerMode;
	ignoreBots?: boolean;
	allowedUserIds?: string[];
	allowedRoleIds?: string[];
}

export interface GondolinSecretConfig {
	value: string;
	hosts: string[];
}

export interface GondolinMountConfig {
	/** Host directory to expose inside the VM. "~" is expanded to the home directory. */
	hostPath: string;
	/** Absolute path inside the VM. Defaults to /mnt/<host directory name>. */
	guestPath?: string;
	/** Mount read-only when true. */
	readOnly?: boolean;
}

export interface GondolinConfig {
	secrets?: Record<string, GondolinSecretConfig>;
	mounts?: GondolinMountConfig[];
}

export interface ResolvedGondolinMount {
	hostPath: string;
	guestPath: string;
	readOnly: boolean;
}

export interface ConfiguredChannel {
	id: string;
	name?: string;
	dm?: boolean;
	access?: AccessPolicy;
	gondolin?: GondolinConfig;
}

export interface BaseAccountConfig {
	service: ChatService;
	name?: string;
	access?: AccessPolicy;
	gondolin?: GondolinConfig;
	channels: Record<string, ConfiguredChannel>;
}

export interface TelegramAccountConfig extends BaseAccountConfig {
	service: "telegram";
	botToken: string;
	botUsername?: string;
	botUserId?: string;
}

export interface DiscordAccountConfig extends BaseAccountConfig {
	service: "discord";
	botToken: string;
	applicationId: string;
	serverId: string;
	serverName: string;
	botUserId?: string;
	botUsername?: string;
}

export interface FeishuAccountConfig extends BaseAccountConfig {
	service: "feishu";
	appId: string;
	appSecret: string;
	receiveMode?: "auto" | "websocket" | "polling";
	botUserId?: string;
	botUsername?: string;
}

export interface WeixinAccountConfig extends BaseAccountConfig {
	service: "weixin";
	/** iLink bot access token issued after scanning the WeChat QR code. */
	botToken: string;
	/** iLink bot identifier used to filter the bot's own echoed messages. */
	botUserId: string;
	/** WeChat user identifier returned by the QR login flow. */
	userId?: string;
}

export type ChatAccountConfig =
	| TelegramAccountConfig
	| DiscordAccountConfig
	| FeishuAccountConfig
	| WeixinAccountConfig;

export interface ChatConfig {
	botName?: string;
	gondolin?: GondolinConfig;
	accounts: Record<string, ChatAccountConfig>;
}

export interface ResolvedConversation {
	service: ChatService;
	botName: string;
	accountId: string;
	account: ChatAccountConfig;
	channelKey: string;
	channel: ConfiguredChannel;
	conversationId: string;
	conversationName: string;
	access: AccessPolicy;
	gondolinSecrets: Record<string, GondolinSecretConfig>;
	gondolinMounts: ResolvedGondolinMount[];
	accountDir: string;
	sharedDir: string;
	conversationDir: string;
	workspaceDir: string;
	gondolinDir: string;
	accountMemoryPath: string;
	channelMemoryPath: string;
	logPath: string;
	filesDir: string;
	lockPath: string;
}
