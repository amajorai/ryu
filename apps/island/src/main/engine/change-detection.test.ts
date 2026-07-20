import { describe, expect, it } from "bun:test";
import type { ShadowContext } from "../../shared/ipc.ts";
import {
	type ContextSnapshot,
	detectChange,
	ocrSimilarity,
	toSnapshot,
} from "./change-detection.ts";

function snap(partial: Partial<ContextSnapshot>): ContextSnapshot {
	return {
		appName: "Code",
		windowTitle: "main.ts",
		ocrText: "hello world",
		selectedText: null,
		...partial,
	};
}

describe("ocrSimilarity", () => {
	it("treats two empty texts as identical", () => {
		expect(ocrSimilarity(null, "")).toBe(1);
	});

	it("treats one empty + one non-empty as fully different", () => {
		expect(ocrSimilarity("hello", null)).toBe(0);
	});

	it("returns 1 for identical token sets regardless of order", () => {
		expect(ocrSimilarity("a b c", "c b a")).toBe(1);
	});

	it("computes jaccard for partial overlap", () => {
		// {a,b} vs {b,c}: intersection 1, union 3 -> 1/3
		expect(ocrSimilarity("a b", "b c")).toBeCloseTo(1 / 3, 5);
	});
});

describe("detectChange", () => {
	it("flags the first snapshot as a change", () => {
		const result = detectChange(null, snap({}));
		expect(result.changed).toBe(true);
		expect(result.reason).toBe("first");
	});

	it("detects an app change", () => {
		const result = detectChange(snap({}), snap({ appName: "Slack" }));
		expect(result.reason).toBe("app_changed");
	});

	it("detects a window-title change", () => {
		const result = detectChange(snap({}), snap({ windowTitle: "other.ts" }));
		expect(result.reason).toBe("title_changed");
	});

	it("detects a large OCR delta below the similarity threshold", () => {
		const result = detectChange(
			snap({ ocrText: "alpha beta gamma" }),
			snap({ ocrText: "completely different words here" })
		);
		expect(result.changed).toBe(true);
		expect(result.reason).toBe("ocr_delta");
	});

	it("reports no change for the same app, title, and similar OCR", () => {
		const result = detectChange(
			snap({ ocrText: "the quick brown fox jumps" }),
			snap({ ocrText: "the quick brown fox jumps over" })
		);
		expect(result.changed).toBe(false);
		expect(result.reason).toBeNull();
	});
});

describe("toSnapshot", () => {
	it("projects the relevant fields", () => {
		const context: ShadowContext = {
			app_name: "Firefox",
			window_title: "Tab",
			ocr_text: "page",
			selected_text: "sel",
			capture_active: true,
			paused: false,
			ocr_timestamp_us: 1,
			timestamp_us: 2,
		};
		expect(toSnapshot(context)).toEqual({
			appName: "Firefox",
			windowTitle: "Tab",
			ocrText: "page",
			selectedText: "sel",
		});
	});
});
