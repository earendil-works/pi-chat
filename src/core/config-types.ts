export type ChatService = "telegram" | "discord";

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

export interface GondolinConfig {
	/** Named groups of secrets. Defined at global or account level; referenced by channel activePresets. */
	presets?: Record<string, Record<string, GondolinSecretConfig>>;
	secrets?: Record<string, GondolinSecretConfig>;
	/** Channel-level: preset names from global/account gondolin to activate for this channel. */
	activePresets?: string[];
}

export type ChannelMode = "admin" | "community" | "mirror";

export interface ConfiguredChannel {
	id: string;
	name?: string;
	dm?: boolean;
	/** Channel behavior mode. Defaults to "admin". */
	mode?: ChannelMode;
	/** When false, tools run directly on the host filesystem — no Gondolin VM sandbox. Defaults to true. */
	sandbox?: boolean;
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

export type ChatAccountConfig = TelegramAccountConfig | DiscordAccountConfig;

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
