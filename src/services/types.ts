import type { ChatAccountConfig, ChatService } from "../core/config-types.js";
import type { AccountValidationResult, DiscoverySnapshot } from "../core/discovery-types.js";

export type AccountDraft =
	| { service: "telegram" | "discord"; botToken: string; name?: string }
	| { service: "feishu"; appId: string; appSecret: string; name?: string }
	| { service: "weixin"; botToken: string; botUserId: string; userId?: string; name?: string };

export interface DiscoveryProvider {
	service: ChatService;
	validate(draft: AccountDraft): Promise<AccountValidationResult>;
	fetchSnapshot(accountId: string, account: ChatAccountConfig): Promise<DiscoverySnapshot>;
}
