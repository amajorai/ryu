"use client";

import {
	type AvatarConversationState,
	resolveAvatarConversationState,
} from "@ryu/ui/components/avatar-conversation.tsx";
import {
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { createContext, useContext } from "react";
import {
	formatToolDisplayName,
	parseMcpToolType,
} from "./tools/tool-registry.ts";

/**
 * What the agent in this conversation is doing right now, for chrome that sits
 * outside the transcript (the Bot-mode contact header). `label` is null while
 * the agent is idle so hosts can collapse the line.
 */
export interface ConversationActivity {
	label: string | null;
	state: AvatarConversationState;
}

const IDLE_ACTIVITY: ConversationActivity = { label: null, state: "idle" };

const STATE_LABELS = {
	idle: null,
	thinking: "Thinking…",
	responding: "Typing…",
	working: "Working…",
	waiting: "Waiting for you",
	error: "Ran into a problem",
} as const satisfies Record<AvatarConversationState, string | null>;

/** Friendly verbs for the tools whose names alone read poorly in a status line. */
const TOOL_ACTIVITY_LABELS: Readonly<Record<string, string>> = {
	agent: "Delegating…",
	bash: "Running a command…",
	edit: "Editing files…",
	glob: "Searching files…",
	grep: "Searching files…",
	notebookedit: "Editing files…",
	planwrite: "Planning…",
	read: "Reading files…",
	task: "Delegating…",
	thinking: "Thinking…",
	todowrite: "Planning…",
	webfetch: "Reading a webpage…",
	websearch: "Searching the web…",
	write: "Editing files…",
};

const TOOL_KEY_SEPARATOR_RE = /[_\s-]+/g;

interface ToolPartObservation {
	state?: unknown;
	toolName?: unknown;
	type: string;
}

function isToolPart(part: unknown): part is ToolPartObservation {
	if (!(part && isNativeObjectLike(part))) {
		return false;
	}
	// SAFETY: isNativeObjectLike accepted this unchanged part as a non-null native object.
	const objectPart = part as object;
	if (!("type" in objectPart && isNativeText(objectPart.type))) {
		return false;
	}
	return (
		objectPart.type.startsWith("tool-") || objectPart.type === "dynamic-tool"
	);
}

/** The bare tool name a part calls, without the `tool-`/MCP server prefix. */
function toolNameOf(part: ToolPartObservation): string {
	if (part.type === "dynamic-tool") {
		return isNativeText(part.toolName) ? part.toolName : "";
	}
	return parseMcpToolType(part.type)?.toolName ?? part.type.slice(5);
}

/** Status-line copy for one in-flight tool call. */
export function toolActivityLabel(part: ToolPartObservation): string {
	const toolName = toolNameOf(part);
	const displayName = formatToolDisplayName(toolName);
	const key = displayName.toLowerCase().replace(TOOL_KEY_SEPARATOR_RE, "");
	const known = TOOL_ACTIVITY_LABELS[key];
	if (known) {
		return known;
	}
	return displayName ? `Using ${displayName}…` : STATE_LABELS.working;
}

function isSettledToolPart(part: ToolPartObservation): boolean {
	return part.state === "output-available" || part.state === "output-error";
}

/**
 * Resolve the live activity from the same signals as the avatar pose, then
 * name the in-flight tool when the agent is working so the header can say
 * "Searching the web…" instead of a generic "Working…".
 */
export function describeConversationActivity(
	input: Parameters<typeof resolveAvatarConversationState>[0]
): ConversationActivity {
	const state = resolveAvatarConversationState(input);
	if (state !== "working") {
		return { label: STATE_LABELS[state], state };
	}
	const last = input.messages.at(-1);
	const parts = last?.role === "assistant" ? (last.parts ?? []) : [];
	for (let index = parts.length - 1; index >= 0; index -= 1) {
		const part = parts[index];
		if (!isToolPart(part)) {
			continue;
		}
		// A finished call followed by nothing yet is the model deciding what to
		// do next, not that tool still running.
		return {
			label: isSettledToolPart(part)
				? STATE_LABELS.working
				: toolActivityLabel(part),
			state,
		};
	}
	return { label: STATE_LABELS.working, state };
}

const ConversationActivityContext =
	createContext<ConversationActivity>(IDLE_ACTIVITY);

/** Provided by AgentChat around its conversation header and transcript. */
export const ConversationActivityProvider =
	ConversationActivityContext.Provider;

/** The live activity of the enclosing AgentChat; idle outside one. */
export function useConversationActivity(): ConversationActivity {
	return useContext(ConversationActivityContext);
}
