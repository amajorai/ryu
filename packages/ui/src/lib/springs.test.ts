// Unit tests for the motion tokens: the exit-fallback timer derives its ms from
// a tier's exit duration (exit-duration * 1000, rounded, + 100ms safety buffer)
// so deferred-unmount timers stay in step with the spring tokens.

import { describe, expect, test } from "bun:test";
import { exitFallbackMs, spring } from "./springs.ts";

describe("exitFallbackMs", () => {
	test("derives ms from each tier's exit duration plus a 100ms buffer", () => {
		expect(exitFallbackMs(spring.fast)).toBe(160); // 0.06s -> 60 + 100
		expect(exitFallbackMs(spring.moderate)).toBe(220); // 0.12s -> 120 + 100
		expect(exitFallbackMs(spring.slow)).toBe(260); // 0.16s -> 160 + 100
	});

	test("rounds a fractional millisecond result before adding the buffer", () => {
		// 0.0155s -> 15.5ms -> round to 16 -> +100
		expect(exitFallbackMs({ exit: { duration: 0.0155 } })).toBe(116);
	});

	test("a bigger tier never resolves faster than a smaller one", () => {
		expect(exitFallbackMs(spring.fast)).toBeLessThan(
			exitFallbackMs(spring.moderate)
		);
		expect(exitFallbackMs(spring.moderate)).toBeLessThan(
			exitFallbackMs(spring.slow)
		);
	});
});
