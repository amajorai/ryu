import { expect, test } from "bun:test";
import {
	formatHistoryTokens,
	historyCounterDisplay,
} from "./history-format.ts";

test("uses readable billion totals and exact integer details", () => {
	expect(formatHistoryTokens(6_979_600_123)).toBe("6.98B");
	expect(formatHistoryTokens(6_979_600_123, false)).toBe("6,979,600,123");
});

test("distinguishes unknown counters, explicit zero and partial known sums", () => {
	expect(historyCounterDisplay(0, 2, 2)).toEqual({
		value: "Unknown",
		detail: "Not reported",
	});
	expect(historyCounterDisplay(0, 0, 2)).toEqual({ value: "0", detail: "0" });
	expect(historyCounterDisplay(2_500_000, 1, 2)).toEqual({
		value: "2.5M",
		detail: "2,500,000 · Partial",
	});
	expect(historyCounterDisplay(100, [0, 0, 0, 1], 1)).toEqual({
		value: "100",
		detail: "100 · Partial",
	});
	expect(historyCounterDisplay(0, [1, 1, 1, 1], 1)).toEqual({
		value: "Unknown",
		detail: "Not reported",
	});
});
