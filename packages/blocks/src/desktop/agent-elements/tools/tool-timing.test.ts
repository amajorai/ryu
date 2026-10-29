import { describe, expect, test } from "bun:test";
import type { ToolUIPart } from "ai";
import { formatToolDuration, readToolTiming } from "./tool-timing.tsx";

describe("formatToolDuration", () => {
	// The whole reason this exists instead of reusing message-stats'
	// `formatDuration`: that one rounds to whole seconds, so every sub-second
	// tool call — which is most of them — renders as "0s".
	test("keeps sub-second calls readable", () => {
		expect(formatToolDuration(0)).toBe("0ms");
		expect(formatToolDuration(7)).toBe("7ms");
		expect(formatToolDuration(420)).toBe("420ms");
		expect(formatToolDuration(999)).toBe("999ms");
	});

	test("switches to one decimal at a second", () => {
		expect(formatToolDuration(1000)).toBe("1.0s");
		expect(formatToolDuration(3240)).toBe("3.2s");
		expect(formatToolDuration(9949)).toBe("9.9s");
	});

	test("drops the decimal past ten seconds so the column stays narrow", () => {
		expect(formatToolDuration(10_000)).toBe("10s");
		expect(formatToolDuration(45_400)).toBe("45s");
	});

	test("uses minutes past a minute", () => {
		expect(formatToolDuration(60_000)).toBe("1m 0s");
		expect(formatToolDuration(83_000)).toBe("1m 23s");
	});

	test("renders nothing for a value that cannot be a duration", () => {
		expect(formatToolDuration(-1)).toBe("");
		expect(formatToolDuration(Number.NaN)).toBe("");
		expect(formatToolDuration(Number.POSITIVE_INFINITY)).toBe("");
	});
});

/** A part shaped the way the AI SDK lands Core's `providerMetadata`. */
function stampedPart(
	ryu: NonNullable<ToolUIPart["callProviderMetadata"]>[string]
) {
	return { type: "tool-Bash", callProviderMetadata: { ryu } };
}

describe("readToolTiming", () => {
	test("reads a completed call's full timing", () => {
		expect(
			readToolTiming(
				stampedPart({ startedAt: 1000, completedAt: 4000, durationMs: 3000 })
			)
		).toEqual({ startedAt: 1000, completedAt: 4000, durationMs: 3000 });
	});

	test("reports an opened-but-never-closed call as start-only", () => {
		// The hang case: this is what lets the badge render a start clock instead
		// of a duration, which is the only thing separating a hang from a failure.
		expect(readToolTiming(stampedPart({ startedAt: 1000 }))).toEqual({
			startedAt: 1000,
		});
	});

	test("derives a missing durationMs from the pair", () => {
		expect(
			readToolTiming(stampedPart({ startedAt: 1000, completedAt: 2500 }))
		).toEqual({ startedAt: 1000, completedAt: 2500, durationMs: 1500 });
	});

	test("drops a completion that precedes the start", () => {
		// A wall clock can step backwards mid-call (NTP correction). Degrading to
		// start-only beats rendering a negative duration.
		expect(
			readToolTiming(stampedPart({ startedAt: 5000, completedAt: 4000 }))
		).toEqual({ startedAt: 5000 });
	});

	test("returns null for an unstamped part so the mount clock takes over", () => {
		expect(readToolTiming({ type: "tool-Bash" })).toBeNull();
		expect(
			readToolTiming({ type: "tool-Bash", callProviderMetadata: {} })
		).toBeNull();
		expect(readToolTiming(undefined)).toBeNull();
		expect(readToolTiming(null)).toBeNull();
	});

	test("rejects a non-numeric or negative start", () => {
		expect(readToolTiming(stampedPart({ startedAt: "1000" }))).toBeNull();
		expect(readToolTiming(stampedPart({ startedAt: Number.NaN }))).toBeNull();
		expect(readToolTiming(stampedPart({ startedAt: -1 }))).toBeNull();
	});
});
