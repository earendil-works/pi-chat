import { describe, expect, it } from "vitest";
import { fetchSlackChannels, fetchSlackUsers, requireSlackAppToken } from "./slack.js";
import type { AccountDraft } from "./types.js";

function mockClient(overrides: Record<string, unknown>) {
	return overrides as any;
}

describe("Slack discovery helpers", () => {
	it("requires an app token for Socket Mode", () => {
		const draft: AccountDraft = { service: "slack", botToken: "xoxb-test" };

		expect(() => requireSlackAppToken(draft)).toThrow("Slack app-level token is required");
		expect(requireSlackAppToken({ ...draft, appToken: " xapp-test " })).toBe("xapp-test");
	});

	it("maps Slack conversations into sorted discovered channels and skips archived entries", async () => {
		const client = mockClient({
			conversations: {
				list: async () => ({
					channels: [
						{ id: "C2", name: "z-dev", is_archived: false },
						{ id: "C0", name: "old", is_archived: true },
						{ id: "D1", user: "U1", is_im: true },
						{ id: "C1", name: "a-prod", is_archived: false },
					],
					response_metadata: {},
				}),
			},
		});

		await expect(fetchSlackChannels(client)).resolves.toEqual([
			{ id: "C1", name: "a-prod", dm: false },
			{ id: "D1", name: "U1", dm: true },
			{ id: "C2", name: "z-dev", dm: false },
		]);
	});

	it("follows Slack channel pagination", async () => {
		const pages = [
			{ channels: [{ id: "C2", name: "second" }], response_metadata: { next_cursor: "next" } },
			{ channels: [{ id: "C1", name: "first" }], response_metadata: {} },
		];
		const client = mockClient({
			conversations: {
				list: async () => pages.shift(),
			},
		});

		await expect(fetchSlackChannels(client)).resolves.toEqual([
			{ id: "C1", name: "first", dm: false },
			{ id: "C2", name: "second", dm: false },
		]);
	});

	it("maps Slack users and skips deleted users", async () => {
		const client = mockClient({
			users: {
				list: async () => ({
					members: [
						{ id: "U2", name: "bot", is_bot: true, profile: { display_name: "Build Bot" } },
						{ id: "U0", name: "deleted", deleted: true },
						{ id: "U1", name: "ada", real_name: "Ada Lovelace", profile: { display_name: "Ada" } },
					],
					response_metadata: {},
				}),
			},
		});

		await expect(fetchSlackUsers(client)).resolves.toEqual([
			{ id: "U1", name: "Ada Lovelace", displayName: "Ada", isBot: false },
			{ id: "U2", name: "bot", displayName: "Build Bot", isBot: true },
		]);
	});
});
