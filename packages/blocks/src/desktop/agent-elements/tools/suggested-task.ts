import { z } from "zod";

/**
 * Pure helpers for the built-in suggested next task (`tasks.suggest`). Kept free
 * of React so parsing and "which suggestion is live" stay unit-testable.
 *
 * The agent proposes; it never starts anything. The card the host draws from
 * this only offers Start / Save to Drafts / Dismiss, and Start goes through the
 * ordinary send path as a NEW chat.
 */

export interface SuggestedTask {
	description: string;
	/** The tool call id, stable across reloads, so a dismissal sticks to it. */
	id: string;
	/** The self-contained instruction the new chat starts with. */
	prompt: string;
	title: string;
}

/** The fully qualified tool name Core registers. */
export const SUGGEST_TASK_TOOL = "tasks.suggest";

// Limits mirror Core's dispatch (`tasks_tool.rs`) so a call Core rejects never
// renders a card. Core counts Unicode scalar values, not UTF-16 code units.
function boundedText(max: number) {
	return z
		.string()
		.trim()
		.refine((value) => value.length > 0, { message: "required" })
		.refine((value) => [...value].length <= max, {
			message: `at most ${max} characters`,
		});
}

const suggestInputSchema = z.object({
	description: boundedText(400),
	prompt: boundedText(4000),
	title: boundedText(80),
});

/** Whether a tool part is a `tasks.suggest` call. Core surfaces it either as a
 *  typed `tool-tasks.suggest` part or as a `dynamic-tool` carrying the name. */
export function isSuggestTaskPart(
	partType: string,
	toolName: string | undefined
): boolean {
	if (partType === "dynamic-tool") {
		return toolName === SUGGEST_TASK_TOOL;
	}
	return partType === `tool-${SUGGEST_TASK_TOOL}`;
}

/** Parse a `tasks.suggest` input. Null while it is still streaming or when it
 *  is malformed. */
export function suggestedTaskFromInput(
	id: string,
	input: unknown
): SuggestedTask | null {
	const parsed = suggestInputSchema.safeParse(input);
	if (!parsed.success) {
		return null;
	}
	return { id, ...parsed.data };
}

interface SuggestPartObservation {
	errorText?: unknown;
	input?: unknown;
	state?: unknown;
	toolCallId?: unknown;
	toolName?: unknown;
	type?: unknown;
}

interface MessageObservation {
	parts?: readonly unknown[];
	role?: unknown;
}

/**
 * The suggestion to show, if any: the last accepted `tasks.suggest` call in the
 * NEWEST assistant message. Anything older is stale, because the conversation
 * has moved on, so a suggestion never outlives the turn that made it. A call
 * Core rejected (`output-error`) or one still streaming shows nothing.
 */
export function latestSuggestedTask(
	messages: readonly MessageObservation[],
	dismissed: ReadonlySet<string> = new Set()
): SuggestedTask | null {
	const newest = messages.at(-1);
	if (newest?.role !== "assistant") {
		return null;
	}
	const parts = newest.parts ?? [];
	for (let index = parts.length - 1; index >= 0; index -= 1) {
		const part = parts[index] as SuggestPartObservation | null | undefined;
		if (!part || typeof part.type !== "string") {
			continue;
		}
		const toolName =
			typeof part.toolName === "string" ? part.toolName : undefined;
		if (!isSuggestTaskPart(part.type, toolName)) {
			continue;
		}
		if (part.state !== "output-available") {
			continue;
		}
		const id =
			typeof part.toolCallId === "string" && part.toolCallId.length > 0
				? part.toolCallId
				: null;
		if (!id || dismissed.has(id)) {
			continue;
		}
		const task = suggestedTaskFromInput(id, part.input);
		if (task) {
			return task;
		}
	}
	return null;
}
