import { randomBytes } from "node:crypto";

import type { WeixinAccountConfig } from "../core/config-types.js";
import type { AccountValidationResult, DiscoverySnapshot } from "../core/discovery-types.js";
import type { AccountDraft, DiscoveryProvider } from "./types.js";

export const DEFAULT_WEIXIN_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

export interface WeixinApiResponse {
	ret?: number;
	errcode?: number;
	errmsg?: string;
	message?: string;
	[key: string]: unknown;
}

export class WeixinApiError extends Error {
	constructor(
		message: string,
		readonly code?: number,
	) {
		super(message);
		this.name = "WeixinApiError";
	}
}

export interface WeixinQRCode {
	qrcode: string;
	imageContent?: string;
}

export interface WeixinLogin {
	botToken: string;
	botUserId: string;
	userId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function responseData(response: WeixinApiResponse): Record<string, unknown> {
	return asRecord(response.data) ?? asRecord(response) ?? {};
}

function stringField(value: Record<string, unknown>, ...names: string[]): string | undefined {
	for (const name of names) {
		const field = value[name];
		if (typeof field === "string" && field.trim()) return field;
	}
	return undefined;
}

export function normalizeWeixinBaseUrl(value?: string): string {
	return (value?.trim() || DEFAULT_WEIXIN_BASE_URL).replace(/\/+$/, "");
}

export function normalizeWeixinCdnBaseUrl(value?: string): string {
	return (value?.trim() || DEFAULT_WEIXIN_CDN_BASE_URL).replace(/\/+$/, "");
}

function requestHeaders(botToken?: string): Record<string, string> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"iLink-App-Id": "bot",
		"iLink-App-ClientVersion": "65536",
		"X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64"),
	};
	if (botToken) {
		headers.Authorization = `Bearer ${botToken}`;
		headers.AuthorizationType = "ilink_bot_token";
	}
	return headers;
}

function apiError(response: WeixinApiResponse): WeixinApiError | undefined {
	const code =
		typeof response.ret === "number"
			? response.ret
			: typeof response.errcode === "number"
				? response.errcode
				: undefined;
	if (code === undefined || code === 0) return undefined;
	const message =
		(typeof response.errmsg === "string" && response.errmsg) ||
		(typeof response.message === "string" && response.message) ||
		`Weixin iLink API failed (${code})`;
	return new WeixinApiError(message, code);
}

export async function callWeixin<T extends WeixinApiResponse>(
	baseUrl: string | undefined,
	path: string,
	body: Record<string, unknown>,
	options?: { botToken?: string; signal?: AbortSignal },
): Promise<T> {
	const response = await fetch(`${normalizeWeixinBaseUrl(baseUrl)}${path}`, {
		method: "POST",
		headers: requestHeaders(options?.botToken),
		body: JSON.stringify(body),
		signal: options?.signal,
	});
	let data: T;
	try {
		data = (await response.json()) as T;
	} catch {
		throw new WeixinApiError(`Weixin iLink API returned HTTP ${response.status}`);
	}
	if (!response.ok) {
		throw new WeixinApiError(
			(typeof data.errmsg === "string" && data.errmsg) || `Weixin iLink API returned HTTP ${response.status}`,
			typeof data.ret === "number" ? data.ret : undefined,
		);
	}
	const error = apiError(data);
	if (error) throw error;
	return data;
}

export async function getWeixin<T extends WeixinApiResponse>(
	baseUrl: string | undefined,
	path: string,
	options?: { botToken?: string; signal?: AbortSignal },
): Promise<T> {
	const response = await fetch(`${normalizeWeixinBaseUrl(baseUrl)}${path}`, {
		headers: requestHeaders(options?.botToken),
		signal: options?.signal,
	});
	let data: T;
	try {
		data = (await response.json()) as T;
	} catch {
		throw new WeixinApiError(`Weixin iLink API returned HTTP ${response.status}`);
	}
	if (!response.ok) {
		throw new WeixinApiError(
			(typeof data.errmsg === "string" && data.errmsg) || `Weixin iLink API returned HTTP ${response.status}`,
			typeof data.ret === "number" ? data.ret : undefined,
		);
	}
	const error = apiError(data);
	if (error) throw error;
	return data;
}

export async function getWeixinQRCode(baseUrl?: string): Promise<WeixinQRCode> {
	const response = await getWeixin<WeixinApiResponse>(baseUrl, "/ilink/bot/get_bot_qrcode?bot_type=3");
	const data = responseData(response);
	const qrcode = stringField(data, "qrcode", "qr_code");
	if (!qrcode) throw new WeixinApiError("Weixin QR code response did not include a qrcode");
	return {
		qrcode,
		imageContent: stringField(data, "qrcode_img_content", "qrcode_image_content", "qr_code_img_content"),
	};
}

export async function getWeixinQRCodeStatus(
	baseUrl: string | undefined,
	qrcode: string,
): Promise<WeixinLogin | undefined> {
	const response = await getWeixin<WeixinApiResponse>(
		baseUrl,
		`/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
	);
	const data = responseData(response);
	const botToken = stringField(data, "bot_token", "ilink_bot_token", "token");
	if (!botToken) return undefined;
	const botUserId = stringField(data, "ilink_bot_id", "bot_user_id", "bot_id", "user_id");
	if (!botUserId) throw new WeixinApiError("Weixin login response did not include an iLink bot id");
	return {
		botToken,
		botUserId,
		userId: stringField(data, "ilink_user_id", "weixin_user_id", "wechat_user_id"),
	};
}

export function weixinBaseInfo(): Record<string, string> {
	return { channel_version: "0.1.0", bot_agent: "pi-chat/0.1.0" };
}

export async function getWeixinUpdates(
	account: Pick<WeixinAccountConfig, "botToken">,
	getUpdatesBuf?: string,
	signal?: AbortSignal,
): Promise<WeixinApiResponse> {
	return callWeixin(
		undefined,
		"/ilink/bot/getupdates",
		{ get_updates_buf: getUpdatesBuf ?? "", base_info: weixinBaseInfo() },
		{ botToken: account.botToken, signal },
	);
}

export const weixinDiscoveryProvider: DiscoveryProvider = {
	service: "weixin",
	async validate(draft: AccountDraft): Promise<AccountValidationResult> {
		if (draft.service !== "weixin") throw new Error("Invalid Weixin account draft");
		if (!draft.botToken.trim() || !draft.botUserId.trim()) throw new Error("Weixin login is incomplete");
		return {
			identity: { id: draft.botUserId, name: draft.name || "weixin-ilink-bot", userName: draft.botUserId },
			warnings: [
				"Weixin iLink only exposes direct conversations. Pair each direct conversation by observing a new message.",
			],
		};
	},
	async fetchSnapshot(accountId: string, account: WeixinAccountConfig): Promise<DiscoverySnapshot> {
		const validation = await this.validate({
			service: "weixin",
			botToken: account.botToken,
			botUserId: account.botUserId,
			userId: account.userId,
			name: account.name,
		});
		return {
			accountId,
			service: "weixin",
			fetchedAt: new Date().toISOString(),
			identity: validation.identity,
			channels: [],
			users: [],
			roles: [],
			warnings: validation.warnings,
			capabilities: {
				canListChannels: false,
				canListUsers: false,
				canListRoles: false,
			},
		};
	},
};
