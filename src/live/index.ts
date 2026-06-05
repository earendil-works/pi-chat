import type { ResolvedConversation } from "../core/config-types.js";
import { connectDiscordLive } from "./discord.js";
import { connectSlackLive } from "./slack.js";
import { connectTelegramLive } from "./telegram.js";
import type { LiveConnection, LiveConnectionHandlers, ResumeState } from "./types.js";

export async function connectLive(
	conversation: ResolvedConversation,
	handlers: LiveConnectionHandlers,
	resumeState?: ResumeState,
): Promise<LiveConnection> {
	if (conversation.service === "telegram") return connectTelegramLive(conversation, handlers, resumeState);
	if (conversation.service === "slack") return connectSlackLive(conversation, handlers, resumeState);
	return connectDiscordLive(conversation, handlers, resumeState?.messageId);
}
