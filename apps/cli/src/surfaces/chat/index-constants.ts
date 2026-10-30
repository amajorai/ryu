// Chat surface constants and pure helpers, split out of index.tsx.

import type { KeyBinding } from "@opentui/core";
import type { MentionTargetUser } from "@ryuhq/core-client/notifications";
import type { AppInfo } from "@ryuhq/core-client/plugins";
import type { Workflow } from "@ryuhq/core-client/workflows";
import type { ChatStreamOptions } from "../../core/chatStream.ts";
import {
	type ChatPart,
	chatPartsSchema,
	settleRunningToolParts,
} from "../../core/chatTranscript.ts";
import type { AgentSlashCommand } from "../../core/contributions.ts";
import type {
	ConversationRow,
	ResumedConversationMessage,
} from "../../core/conversations.ts";

export const EMPTY_APPS: AppInfo[] = [];
export const EMPTY_AGENT_COMMANDS: AgentSlashCommand[] = [];
export const EMPTY_MENTION_USERS: MentionTargetUser[] = [];
export const EMPTY_WORKFLOWS: Workflow[] = [];
export const EMPTY_RECENTS: ConversationRow[] = [];
/** Recent conversations offered on the empty state (Alt+1..3 resumes one). */
export const RECENT_CONVERSATION_LIMIT = 3;
/** Typing pause before an `@path` directory listing runs. */
export const FILE_SEARCH_DEBOUNCE_MS = 80;

// Enter sends; Shift+Enter and Alt+Enter (where the terminal reports the
// modifier) and Ctrl+J (always: it arrives as a line feed) insert a newline.
export const COMPOSER_KEY_BINDINGS: KeyBinding[] = [
	{ name: "return", action: "submit" },
	{ name: "kpenter", action: "submit" },
	{ name: "return", shift: true, action: "newline" },
	{ name: "return", meta: true, action: "newline" },
	{ name: "kpenter", meta: true, action: "newline" },
	{ name: "linefeed", action: "newline" },
	{ name: "j", ctrl: true, action: "newline" },
];
const COMPOSER_MIN_MAX_ROWS = 6;

/**
 * The composer grows with its draft up to a third of the terminal (at least
 * six rows), but never past half of it so the transcript keeps some room.
 */
export function composerMaxHeight(terminalHeight: number): number {
	const preferred = Math.max(
		COMPOSER_MIN_MAX_ROWS,
		Math.floor(terminalHeight / 3)
	);
	return Math.max(1, Math.min(preferred, Math.floor(terminalHeight / 2) - 2));
}
/**
 * Real starter tasks for the empty Console/OS composer, one per conversation
 * (no timer). Each keeps the "Message ·" lead the idle composer always shows.
 */
const STARTER_PLACEHOLDERS = [
	"Message · e.g. plan a feature, then hand it off",
	"Message · e.g. explain an error you're stuck on",
	"Message · e.g. draft a workflow from a goal",
	"Message · e.g. summarise recent changes",
] as const;
let starterCounter = 0;
export function nextStarterPlaceholder(): string {
	const starter =
		STARTER_PLACEHOLDERS[starterCounter % STARTER_PLACEHOLDERS.length] ??
		STARTER_PLACEHOLDERS[0];
	starterCounter += 1;
	return starter;
}

/** The model a configured agent runs, so "default" can name a real model. */
export interface ConfiguredModel {
	agentId: string;
	model: string;
}

/** Receipt label for the turn's route: the agent or group it went to. */
export function receiptRouteLabel(
	options: ChatStreamOptions
): string | undefined {
	if (options.teamId) {
		return `team:${options.teamId}`;
	}
	return options.agentId;
}

/** Permission prompt navigation: arrows and vim keys in both orientations. */
export const PERMISSION_PREVIOUS_KEYS = new Set(["up", "k", "left", "h"]);
export const PERMISSION_NEXT_KEYS = new Set(["down", "j", "right", "l"]);
export const PERMISSION_DIGIT = /^[1-9]$/;
/** Rows a page key moves the permission prompt's detail body. */
export const PERMISSION_BODY_PAGE_ROWS = 5;

let nextMessageId = 1;
/** Allocates the next transcript message id. */
export function takeMessageId(): number {
	return nextMessageId++;
}
export const BOT_ROUTING_NOTICE =
	"Bot chats are pinned to Ryu; agent and group routing is available in Agent or OS.";

export function commandRouteKey(options: ChatStreamOptions): string {
	return options.teamId
		? `team:${options.teamId}`
		: `agent:${options.agentId ?? "ryu"}`;
}

/** Chat's contribution to the shell status bar (Ctrl+A opens the agent picker). */
export const CHAT_AGENT_HINT = { keys: "^A", label: "agent" };

/** The unfocused queue bar's second hint: Esc pauses mid-turn, clears when
 * paused. While unfocused, `c` types into the composer, so it is not shown. */
export function queueBarClearHint(paused: boolean, streaming: boolean): string {
	if (paused) {
		return "Esc clear queue";
	}
	return streaming ? "Esc interrupt (queue pauses)" : "";
}

export function resumedChatParts(
	message: ResumedConversationMessage
): ChatPart[] {
	const parsed = chatPartsSchema.safeParse(message.parts);
	// A resumed turn is never streaming live, so a tool persisted mid-call
	// can only have been cut off; show it as interrupted instead of spinning.
	return parsed.success && parsed.data.length > 0
		? settleRunningToolParts(parsed.data, "interrupted")
		: [{ type: "text", text: message.content }];
}
