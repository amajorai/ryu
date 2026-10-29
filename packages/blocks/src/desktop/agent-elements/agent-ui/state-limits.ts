// Size and nesting limits for saved generative-UI state. They mirror Core's
// `validate_widget_state`, which refuses a saved record whose JSON is larger
// than 64 KiB of UTF-8 or nests deeper than 32 levels (the record itself is
// level 0). Measuring the same way on the client lets a widget or page learn
// that a save would be refused, instead of the state looking saved until the
// chat reloads.

/** Largest saved record Core accepts, in UTF-8 bytes of its JSON. */
export const AGENT_UI_STATE_MAX_BYTES = 64 * 1024;
/** Deepest value Core accepts, counting the saved record itself as level 0. */
export const AGENT_UI_STATE_MAX_DEPTH = 32;

/** Longest title kept in a saved record, so the wrapper stays within the room
 *  reserved for it below. */
export const AGENT_UI_SAVED_TITLE_MAX_CHARS = 120;

/**
 * Budget for an artifact page's own `ryu.state` object. The host saves it as
 * `{ state, title }`, so 1 KiB is left for that wrapper (a clamped title
 * escapes to at most 6 bytes per character) and the page's object starts one
 * level down.
 */
export const ARTIFACT_PAGE_STATE_MAX_BYTES = AGENT_UI_STATE_MAX_BYTES - 1024;
export const ARTIFACT_PAGE_STATE_MAX_DEPTH = AGENT_UI_STATE_MAX_DEPTH - 1;

export type AgentUiStateLimitProblem = "depth" | "size";

export interface AgentUiStateLimits {
	maxBytes: number;
	maxDepth: number;
}

const RECORD_LIMITS: AgentUiStateLimits = {
	maxBytes: AGENT_UI_STATE_MAX_BYTES,
	maxDepth: AGENT_UI_STATE_MAX_DEPTH,
};

const encoder = new TextEncoder();

/** Whether any value in `root` sits deeper than `maxDepth` (`root` is level 0). */
function exceedsDepth(root: unknown, maxDepth: number): boolean {
	const pending: [unknown, number][] = [[root, 0]];
	let next = pending.pop();
	while (next) {
		const [value, depth] = next;
		if (depth > maxDepth) {
			return true;
		}
		if (value !== null && typeof value === "object") {
			for (const child of Object.values(value)) {
				pending.push([child, depth + 1]);
			}
		}
		next = pending.pop();
	}
	return false;
}

/**
 * Why Core would refuse `value` as saved state, or `null` when it fits. Measures
 * the JSON the client will send: UTF-8 bytes (not UTF-16 code units) and
 * container depth. A value that can't be serialized counts as too large.
 */
export function agentUiStateLimitProblem(
	value: unknown,
	limits: AgentUiStateLimits = RECORD_LIMITS
): AgentUiStateLimitProblem | null {
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch {
		return "size";
	}
	if (text === undefined || encoder.encode(text).length > limits.maxBytes) {
		return "size";
	}
	return exceedsDepth(JSON.parse(text), limits.maxDepth) ? "depth" : null;
}

/** A title clamped to what a saved record keeps. Cuts on code points, never
 *  inside a surrogate pair, since Core rejects JSON with a lone surrogate. */
export function clampSavedTitle(title: string): string {
	if (title.length <= AGENT_UI_SAVED_TITLE_MAX_CHARS) {
		return title;
	}
	return Array.from(title).slice(0, AGENT_UI_SAVED_TITLE_MAX_CHARS).join("");
}
