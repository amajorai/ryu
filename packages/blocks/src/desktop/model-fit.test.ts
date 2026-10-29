import { describe, expect, test } from "bun:test";
import {
	FIT_RANK,
	fitBlockReason,
	fitRank,
	isBlockedFit,
	isBlockedRepoFit,
	isSlowFit,
	pickBestFit,
} from "./model-fit.ts";

describe("model fit ranking", () => {
	test("orders every verdict with blocked options last", () => {
		const ordered = Object.entries(FIT_RANK)
			.sort(([, a], [, b]) => a - b)
			.map(([fit]) => fit);
		expect(ordered).toEqual([
			"great",
			"ok",
			"partial",
			"cpu",
			"unknown",
			"too_big",
			"no_space",
		]);
		expect(fitRank("something-new")).toBe(FIT_RANK.unknown);
	});

	test("classifies blocked and slow verdicts; unknown never blocks", () => {
		expect(isBlockedFit("too_big")).toBe(true);
		expect(isBlockedFit("no_space")).toBe(true);
		expect(isBlockedFit("unknown")).toBe(false);
		expect(isSlowFit("cpu")).toBe(true);
		expect(isSlowFit("partial")).toBe(true);
		expect(isSlowFit("ok")).toBe(false);
	});

	test("picks the best non-blocked file, then the smaller one", () => {
		const best = pickBestFit([
			{ fit: "no_space", sizeBytes: 1 },
			{ fit: "cpu", sizeBytes: 9 },
			{ fit: "cpu", sizeBytes: 5 },
			{ fit: "too_big", sizeBytes: 2 },
		]);
		expect(best).toEqual({ fit: "cpu", sizeBytes: 5 });
		expect(pickBestFit([])).toBeNull();
	});
});

describe("fitBlockReason", () => {
	test("quotes memory for too_big and free disk for no_space", () => {
		expect(
			fitBlockReason("too_big", "", {
				ramHuman: "8 GB",
				unifiedMemory: false,
				vramHuman: "4 GB",
			})
		).toBe(
			"Too large for your device's memory. This device has 8 GB of RAM and 4 GB of GPU memory."
		);
		expect(
			fitBlockReason("no_space", "No room", { diskFreeHuman: "3 GB" })
		).toBe("No room. Only 3 GB is free on the models drive.");
	});

	test("never doubles the period of a sentence-style label", () => {
		expect(
			fitBlockReason("too_big", "This 20 GB model may not fit.", {
				ramHuman: "8 GB",
			})
		).toBe("This 20 GB model may not fit. This device has 8 GB of RAM.");
	});

	test("returns null for verdicts that do not block", () => {
		expect(fitBlockReason("cpu", "Runs on your CPU", null)).toBeNull();
		expect(fitBlockReason("unknown", "", null)).toBeNull();
	});
});

describe("isBlockedRepoFit", () => {
	test("an older Core's soft too_big (no disk numbers) does not block a snapshot", () => {
		expect(isBlockedRepoFit("too_big", {})).toBe(false);
		expect(isBlockedRepoFit("too_big", undefined)).toBe(false);
	});

	test("a Core that reports free disk, even unknown, blocks too_big and no_space", () => {
		expect(isBlockedRepoFit("too_big", { diskFreeBytes: null })).toBe(true);
		expect(isBlockedRepoFit("too_big", { diskFreeBytes: 10 })).toBe(true);
		expect(isBlockedRepoFit("no_space", {})).toBe(true);
		expect(isBlockedRepoFit("ok", { diskFreeBytes: 10 })).toBe(false);
	});
});
