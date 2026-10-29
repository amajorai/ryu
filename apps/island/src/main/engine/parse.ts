import { z } from "zod";
// Defensive parsing of the local model's suggestion JSON.
//
// We ask Gemma 4 E2B (via Core's `/v1/chat/completions`) for STRICT JSON, but a
// small local model will sometimes wrap it in prose, fences, or trailing text.
// `extractJsonObject` pulls the first balanced `{...}` block from arbitrary
// model output; `parseModelSuggestion` validates the fields and drops anything
// irrelevant or low-confidence. Everything here is pure and unit-tested.

/** The strict JSON shape we request from the local model. */
export interface ModelSuggestion {
	action: "chat" | "dismiss";
	body: string;
	confidence: number;
	relevant: boolean;
	title: string;
}

/** Suggestions below this confidence are dropped as noise. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Extract the first balanced top-level JSON object substring from `text`.
 * Tolerates leading prose, ```json fences, and trailing commentary by scanning
 * for the first `{` and matching braces (ignoring braces inside strings).
 * Returns `null` when no balanced object is found.
 */
/** Mutable scan state for `extractJsonObject`. */
interface ScanState {
	depth: number;
	escaped: boolean;
	inString: boolean;
}

/** Advance the in-string sub-state; returns whether we are still in a string. */
function advanceString(state: ScanState, ch: string): void {
	if (state.escaped) {
		state.escaped = false;
		return;
	}
	if (ch === "\\") {
		state.escaped = true;
		return;
	}
	if (ch === '"') {
		state.inString = false;
	}
}

export function extractJsonObject(text: string): string | null {
	const start = text.indexOf("{");
	if (start === -1) {
		return null;
	}
	const state: ScanState = { depth: 0, inString: false, escaped: false };
	for (let i = start; i < text.length; i += 1) {
		const ch = text[i];
		if (state.inString) {
			advanceString(state, ch);
			continue;
		}
		if (ch === '"') {
			state.inString = true;
		} else if (ch === "{") {
			state.depth += 1;
		} else if (ch === "}") {
			state.depth -= 1;
			if (state.depth === 0) {
				return text.slice(start, i + 1);
			}
		}
	}
	return null;
}

const modelSuggestionSchema = z.object({
	relevant: z.literal(true),
	title: z.string().trim().min(1),
	body: z.string().trim().catch(""),
	confidence: z
		.number()
		.transform((value) => Math.max(0, Math.min(1, value)))
		.catch(0),
	action: z.enum(["chat", "dismiss"]).catch("chat"),
});

/**
 * Parse and validate raw model output into a `ModelSuggestion`, or `null` when
 * the output is malformed, marked `relevant:false`, or below `threshold`
 * confidence. Never throws.
 */
export function parseModelSuggestion(
	raw: string,
	threshold: number = DEFAULT_CONFIDENCE_THRESHOLD
): ModelSuggestion | null {
	const json = extractJsonObject(raw);
	if (!json) {
		return null;
	}
	try {
		const parsed = modelSuggestionSchema.safeParse(JSON.parse(json));
		if (!parsed.success || parsed.data.confidence < threshold) {
			return null;
		}
		return parsed.data;
	} catch {
		return null;
	}
}
