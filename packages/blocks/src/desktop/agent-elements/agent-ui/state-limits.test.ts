import { describe, expect, test } from "bun:test";
import {
	AGENT_UI_SAVED_TITLE_MAX_CHARS,
	AGENT_UI_STATE_MAX_BYTES,
	ARTIFACT_PAGE_STATE_MAX_BYTES,
	ARTIFACT_PAGE_STATE_MAX_DEPTH,
	agentUiStateLimitProblem,
	clampSavedTitle,
} from "./state-limits.ts";

/** `{ a: { a: … } }` with `levels` objects below the root (root is level 0). */
function nested(levels: number): Record<string, unknown> {
	let value: Record<string, unknown> = {};
	for (let level = 0; level < levels; level++) {
		value = { a: value };
	}
	return value;
}

describe("agentUiStateLimitProblem", () => {
	test("measures UTF-8 bytes like Core, not UTF-16 code units", () => {
		// 22,000 CJK characters are 22,000 code units but 66,000 UTF-8 bytes.
		const cjk = { note: "中".repeat(22_000) };
		expect(JSON.stringify(cjk).length).toBeLessThan(AGENT_UI_STATE_MAX_BYTES);
		expect(agentUiStateLimitProblem(cjk)).toBe("size");
		expect(agentUiStateLimitProblem({ note: "中".repeat(20_000) })).toBe(null);
	});

	test("accepts a record exactly at the byte limit and refuses one past it", () => {
		const overhead = JSON.stringify({ note: "" }).length;
		const atLimit = { note: "x".repeat(AGENT_UI_STATE_MAX_BYTES - overhead) };
		expect(agentUiStateLimitProblem(atLimit)).toBe(null);
		const pastLimit = {
			note: "x".repeat(AGENT_UI_STATE_MAX_BYTES - overhead + 1),
		};
		expect(agentUiStateLimitProblem(pastLimit)).toBe("size");
	});

	test("matches Core's nesting limit with the record at level 0", () => {
		// The innermost `{}` sits at level 32 for nested(32): allowed.
		expect(agentUiStateLimitProblem(nested(32))).toBe(null);
		expect(agentUiStateLimitProblem(nested(33))).toBe("depth");
	});

	test("a page state within its budget still fits once wrapped", () => {
		const title = clampSavedTitle("\u0001".repeat(500));
		const pageState = {
			blob: "x".repeat(
				ARTIFACT_PAGE_STATE_MAX_BYTES - JSON.stringify({ blob: "" }).length
			),
			deep: nested(ARTIFACT_PAGE_STATE_MAX_DEPTH - 1),
		};
		// Trim the blob so the page state itself is exactly at its byte budget.
		const excess =
			new TextEncoder().encode(JSON.stringify(pageState)).length -
			ARTIFACT_PAGE_STATE_MAX_BYTES;
		pageState.blob = pageState.blob.slice(excess);
		expect(
			agentUiStateLimitProblem(pageState, {
				maxBytes: ARTIFACT_PAGE_STATE_MAX_BYTES,
				maxDepth: ARTIFACT_PAGE_STATE_MAX_DEPTH,
			})
		).toBe(null);
		// The host saves it as `{ state, title }`, which Core must accept.
		expect(agentUiStateLimitProblem({ state: pageState, title })).toBe(null);
	});

	test("a value that cannot be serialized is refused", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(agentUiStateLimitProblem(cyclic)).toBe("size");
	});
});

describe("clampSavedTitle", () => {
	test("keeps short titles and never splits a surrogate pair", () => {
		expect(clampSavedTitle("Packing list")).toBe("Packing list");
		const emoji = "\u{1F600}".repeat(AGENT_UI_SAVED_TITLE_MAX_CHARS);
		const clamped = clampSavedTitle(emoji);
		expect(Array.from(clamped)).toHaveLength(AGENT_UI_SAVED_TITLE_MAX_CHARS);
		expect(clamped).toBe(emoji);
		const long = clampSavedTitle(`a${"\u{1F600}".repeat(200)}`);
		expect(Array.from(long)).toHaveLength(AGENT_UI_SAVED_TITLE_MAX_CHARS);
		expect(/[\uD800-\uDBFF]$/.test(long)).toBe(false);
	});
});
