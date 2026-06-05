import { describe, expect, it, vi } from "vitest";

import type { ResolvedConversation, SlackAccountConfig } from "../core/config-types.js";
import { formatMarkdownForService, maxMessageLength } from "../render/format.js";
import { SlackEventDeduplicator, sendSlackMessage, slackDedupeKey, slackMessageToInput } from "./slack.js";

const account: SlackAccountConfig = {
	service: "slack",
	name: "slack",
	botToken: "xoxb-test",
	appToken: "xapp-test",
	botUserId: "U-BOT",
	botUsername: "agent",
	channels: {},
};

const conversation = {
	service: "slack",
	account,
	channel: { id: "C1", name: "devops" },
	channelKey: "devops",
} as ResolvedConversation;

describe("Slack live adapter helpers", () => {
	it("converts a Slack message into an inbound pi-chat message", async () => {
		const input = await slackMessageToInput(conversation, account, {
			type: "app_mention",
			channel: "C1",
			user: "U1",
			username: "Ada",
			text: "<@U-BOT> run deploy",
			ts: "1710000000.000100",
		});

		expect(input).toMatchObject({
			messageId: "1710000000.000100",
			userId: "U1",
			userName: "Ada",
			text: "<@U-BOT> run deploy",
			mentionedBot: true,
			isBot: false,
			attachments: [],
		});
	});

	it("ignores non-target channels, edited/deleted messages, and bot loops", async () => {
		await expect(slackMessageToInput(conversation, account, { channel: "C2", user: "U1", text: "hi" })).resolves.toBe(
			undefined,
		);
		await expect(
			slackMessageToInput(conversation, account, { channel: "C1", subtype: "message_deleted", text: "hi" }),
		).resolves.toBe(undefined);
		await expect(
			slackMessageToInput(conversation, account, { channel: "C1", user: "U-BOT", text: "hi" }),
		).resolves.toBe(undefined);
		await expect(slackMessageToInput(conversation, account, { channel: "C1", bot_id: "B1", text: "hi" })).resolves.toBe(
			undefined,
		);
	});

	it("builds stable dedupe keys and suppresses duplicates", () => {
		expect(
			slackDedupeKey({ body: { event_id: "Ev1" } }, { channel: "C1", ts: "1710000000.000100", type: "message" }),
		).toBe("Ev1");
		expect(slackDedupeKey({}, { channel: "C1", ts: "1710000000.000100", type: "message" })).toBe(
			"C1:1710000000.000100:message",
		);

		const deduplicator = new SlackEventDeduplicator();
		expect(deduplicator.seenOrRecord("Ev1")).toBe(false);
		expect(deduplicator.seenOrRecord("Ev1")).toBe(true);
		expect(deduplicator.seenOrRecord(undefined)).toBe(false);
	});

	it("formats Slack mentions and uses Slack's long message limit", () => {
		expect(formatMarkdownForService("slack", "hello @U123").text).toBe("hello <@U123>");
		expect(maxMessageLength("slack")).toBe(40000);
	});

	it("sends Slack messages in a thread and uploads files to the created message thread", async () => {
		const client = {
			chat: {
				postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "1710000000.000100" }),
			},
			files: {
				uploadV2: vi.fn().mockResolvedValue({ ok: true }),
			},
		} as any;

		const messageId = await sendSlackMessage(client, conversation, "hello", [], undefined, "1710000000.000000");

		expect(messageId).toBe("1710000000.000100");
		expect(client.chat.postMessage).toHaveBeenCalledWith({
			channel: "C1",
			text: "hello",
			thread_ts: "1710000000.000000",
		});
	});

	it("throws when Slack message send fails", async () => {
		const client = {
			chat: {
				postMessage: vi.fn().mockResolvedValue({ ok: false, error: "not_in_channel" }),
			},
			files: {
				uploadV2: vi.fn(),
			},
		} as any;

		await expect(sendSlackMessage(client, conversation, "hello")).rejects.toThrow("not_in_channel");
	});
});
