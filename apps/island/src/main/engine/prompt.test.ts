import { describe, expect, it } from "bun:test";
import type { ContextSnapshot } from "./change-detection.ts";
import {
	BROWSER_TRUNCATE_CHARS,
	buildSuggestionMessages,
	OCR_TRUNCATE_CHARS,
	SELECTION_TRUNCATE_CHARS,
} from "./prompt.ts";

function snapshot(over: Partial<ContextSnapshot> = {}): ContextSnapshot {
	return {
		appName: "Ryu",
		windowTitle: "Home",
		ocrText: null,
		selectedText: null,
		...over,
	};
}

function userContent(snap: ContextSnapshot): string {
	const messages = buildSuggestionMessages(snap);
	const user = messages.find((m) => m.role === "user");
	return user?.content ?? "";
}

describe("buildSuggestionMessages", () => {
	it("emits a system message then a user message", () => {
		const messages = buildSuggestionMessages(snapshot());
		expect(messages).toHaveLength(2);
		expect(messages[0].role).toBe("system");
		expect(messages[1].role).toBe("user");
		// The strict-JSON contract must be in the system prompt.
		expect(messages[0].content).toContain("STRICT JSON");
	});

	it("falls back to 'unknown' app/window and marks OCR as (none)", () => {
		const content = userContent(
			snapshot({ appName: null, windowTitle: null, ocrText: null })
		);
		expect(content).toContain("App: unknown");
		expect(content).toContain("Window: unknown");
		expect(content).toContain("On-screen text: (none)");
	});

	it("includes selection and OCR lines only when present", () => {
		const withData = userContent(
			snapshot({ selectedText: "some selection", ocrText: "screen words" })
		);
		expect(withData).toContain("Selected text: some selection");
		expect(withData).toContain("On-screen text:\nscreen words");

		const withoutSelection = userContent(snapshot({ ocrText: "x" }));
		expect(withoutSelection).not.toContain("Selected text:");
	});

	it("includes the browser url and full page content when bridged", () => {
		const content = userContent(
			snapshot({
				browserUrl: "https://example.com/article",
				browserContent: "full page body",
			})
		);
		expect(content).toContain("Browser page: https://example.com/article");
		expect(content).toContain("Full page content:\nfull page body");
	});

	it("omits the browser lines when the bridge sent nothing", () => {
		const content = userContent(snapshot({ ocrText: "x" }));
		expect(content).not.toContain("Browser page:");
		expect(content).not.toContain("Full page content:");
	});

	it("truncates OCR, selection, and browser text to their budgets with an ellipsis", () => {
		const content = userContent(
			snapshot({
				ocrText: "o".repeat(OCR_TRUNCATE_CHARS + 500),
				selectedText: "s".repeat(SELECTION_TRUNCATE_CHARS + 500),
				browserContent: "b".repeat(BROWSER_TRUNCATE_CHARS + 500),
				browserUrl: "https://x.test",
			})
		);
		expect(content).toContain(`${"o".repeat(OCR_TRUNCATE_CHARS)}…`);
		expect(content).toContain(`${"s".repeat(SELECTION_TRUNCATE_CHARS)}…`);
		expect(content).toContain(`${"b".repeat(BROWSER_TRUNCATE_CHARS)}…`);
		// Never longer than budget + ellipsis for OCR.
		expect(content).not.toContain("o".repeat(OCR_TRUNCATE_CHARS + 1));
	});

	it("trims surrounding whitespace before applying the budget", () => {
		const content = userContent(
			snapshot({ ocrText: "   trimmed screen text   " })
		);
		expect(content).toContain("On-screen text:\ntrimmed screen text");
	});

	it("has a larger budget for browser content than for OCR", () => {
		// The bridge sees off-screen text OCR can't, so it earns more room.
		expect(BROWSER_TRUNCATE_CHARS).toBeGreaterThan(OCR_TRUNCATE_CHARS);
	});
});
