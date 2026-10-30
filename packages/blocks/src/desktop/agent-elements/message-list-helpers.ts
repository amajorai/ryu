import { formatCount } from "@ryu/ui/lib/number-format.ts";
import type { UIMessage } from "ai";
import type { ChatTocFileChange } from "./chat-toc.tsx";
import { hasVisibleContentAtNoDetail } from "./tool-detail-visibility.ts";
import { isAgentMessageToolPart } from "./tools/agent-message-tool-logic.ts";
import { deriveEditedFiles } from "./turn-end-cards.ts";
import { isTextPart } from "./utils/live-media-observations.ts";
import type { RenderedMessage } from "./utils/native-sdk-observation.ts";
import {
	isV5SdkToolPart as isV5ToolPart,
	type RenderedSdkPart,
	type SdkToolPart,
} from "./utils/sdk-tool-observations.ts";

// `hideToolDetail` is not a cosmetic argument here. At Detail level "None" a
// turn made only of tool calls renders NOTHING, so asking "does the last
// assistant message have content" against the raw parts would answer yes, drop
// the live "Thinking" row, and leave the transcript looking idle for the whole
// time the agent is actually working. The question has to be asked at the same
// detail level the transcript is drawing at.
export function getLastAssistantHasContent(
	messages: RenderedMessage[],
	hideToolDetail: boolean
) {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg?.role !== "assistant") {
			continue;
		}
		const parts = msg.parts ?? [];
		if (hideToolDetail) {
			return hasVisibleContentAtNoDetail(parts);
		}
		return parts.some((part) => {
			if (isTextPart(part)) {
				return part.text.trim().length > 0;
			}
			return isV5ToolPart(part);
		});
	}
	return false;
}

/** What the live status row says the agent is doing right now. */
type PlanningActivity = "thinking" | "working" | "typing";

export const PLANNING_LABELS = {
	thinking: "Assistant is thinking",
	working: "Assistant is working",
	typing: "Assistant is typing",
} satisfies Record<PlanningActivity, string>;

/**
 * Read the current activity off the last assistant message.
 *
 * The LAST part wins, because that is what the agent is doing NOW: a tool part
 * in final position means a call is the most recent thing it did ("Working"),
 * and text in final position means tokens are landing ("Typing"). An opened turn
 * with neither is still "Thinking".
 *
 * Deliberately not keyed on a tool part's `state`: a completed call followed by
 * nothing else still reads as work in progress, since the turn has not settled —
 * the row only exists while `isStreaming`.
 */
export function getPlanningActivity(
	messages: RenderedMessage[]
): PlanningActivity {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg?.role !== "assistant") {
			continue;
		}
		const parts = msg.parts ?? [];
		for (let p = parts.length - 1; p >= 0; p -= 1) {
			// `unknown`, deliberately: `isV5ToolPart` narrows the union so far that
			// the following `isTextPart` sees `never` and its guard stops compiling.
			// Both predicates already validate the shape they claim.
			const part = parts[p];
			if (isV5ToolPart(part)) {
				return "working";
			}
			if (isTextPart(part) && part.text.trim().length > 0) {
				return "typing";
			}
		}
		return "thinking";
	}
	return "thinking";
}

/** `https://www.example.com/x` → `example.com`, for a citation's domain line. */
/** A Switchboard send/ask call; MCP parts carry the name in their type, the
 * AI SDK's dynamic-tool form in `toolName`. */
export function isAgentMessageSdkPart(part: SdkToolPart): boolean {
	return isAgentMessageToolPart(
		part.type,
		part.type === "dynamic-tool" ? part.toolName : undefined
	);
}

export function hostnameOfCitation(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

export function getTextFromParts(
	parts: RenderedSdkPart[],
	joiner: string
): string {
	return parts
		.filter(isTextPart)
		.map((part) => part.text)
		.join(joiner);
}

/** Collect the edit summary used by the message-navigation preview rail. */
export function getChangedFilesFromParts(
	parts: unknown[]
): ChatTocFileChange[] {
	return deriveEditedFiles(parts).map((file) => {
		const stats = [
			file.insertions > 0 ? `+${formatCount(file.insertions) ?? "0"}` : "",
			file.deletions > 0 ? `-${formatCount(file.deletions) ?? "0"}` : "",
		]
			.filter(Boolean)
			.join(" ");
		return { name: file.path, stats: stats || undefined };
	});
}

/** One user message plus every assistant message that answered it. */
export interface AssistantTurn {
	assistantMsgs: RenderedMessage[];
	userMsg?: UIMessage;
}

/**
 * Module-level so the "nothing is hidden" branch hands back a stable identity —
 * a fresh empty Set would change the memo's result on every render and defeat
 * it.
 */
export const EMPTY_TURN_SET: ReadonlySet<AssistantTurn> =
	new Set<AssistantTurn>();

/** Group flat messages into turns (user message + following assistant messages) */
export function groupMessagesIntoTurns(
	messages: RenderedMessage[]
): AssistantTurn[] {
	const turns: AssistantTurn[] = [];
	let current: AssistantTurn | null = null;

	for (const msg of messages) {
		if (msg.role === "user") {
			if (current) {
				turns.push(current);
			}
			current = { userMsg: msg, assistantMsgs: [] };
		} else if (msg.role === "assistant") {
			if (!current) {
				current = { assistantMsgs: [] };
			}
			current.assistantMsgs.push(msg);
		}
	}
	if (current) {
		turns.push(current);
	}
	return turns;
}

/**
 * Hand back the previous render's turn object for every turn whose messages
 * are the very same objects, so a memoised turn row can bail out on identity
 * while a reply streams. The AI SDK keeps settled message identities and swaps
 * only the message being written, so only the live turn comes back new.
 */
export function reuseSettledTurns(
	previous: readonly AssistantTurn[],
	next: AssistantTurn[]
): AssistantTurn[] {
	return next.map((turn, index) => {
		const before = previous[index];
		if (
			before &&
			before.userMsg === turn.userMsg &&
			before.assistantMsgs.length === turn.assistantMsgs.length &&
			before.assistantMsgs.every((msg, i) => msg === turn.assistantMsgs[i])
		) {
			return before;
		}
		return turn;
	});
}
