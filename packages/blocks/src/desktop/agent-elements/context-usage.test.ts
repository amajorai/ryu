import { describe, expect, test } from "bun:test";
import {
	CONTEXT_CRITICAL_PCT,
	CONTEXT_WARN_PCT,
	contextRingColor,
} from "./context-usage.tsx";

describe("contextRingColor", () => {
	test("keeps usage below the warning threshold muted", () => {
		expect(contextRingColor(CONTEXT_WARN_PCT - 0.01)).toBe(
			"text-muted-foreground"
		);
	});

	test("uses the semantic warning token at the warning threshold", () => {
		expect(contextRingColor(CONTEXT_WARN_PCT)).toBe("text-warning");
	});

	test("keeps the semantic warning token before the critical threshold", () => {
		expect(
			contextRingColor((CONTEXT_WARN_PCT + CONTEXT_CRITICAL_PCT) / 2)
		).toBe("text-warning");
	});

	test("switches to the semantic destructive token at critical usage", () => {
		expect(contextRingColor(CONTEXT_CRITICAL_PCT)).toBe("text-destructive");
	});

	test("keeps over-limit usage destructive", () => {
		expect(contextRingColor(125)).toBe("text-destructive");
	});
});
