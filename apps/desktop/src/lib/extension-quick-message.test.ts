import { describe, expect, it } from "bun:test";
import {
	extensionQuickMessageSeedFromEvent,
	extensionQuickMessageTab,
	takeExtensionQuickMessageSeed,
} from "./extension-quick-message.ts";

describe("extension quick-message handoff", () => {
	it("consumes a one-shot seed without trimming its prompt", () => {
		let stored: string | null = "  Summarize this page  ";
		let removals = 0;
		const storage = {
			getItem: () => stored,
			removeItem: () => {
				stored = null;
				removals += 1;
			},
		};

		expect(takeExtensionQuickMessageSeed(storage)).toBe(
			"  Summarize this page  "
		);
		expect(takeExtensionQuickMessageSeed(storage)).toBeUndefined();
		expect(removals).toBe(1);
	});

	it("discards empty seeds and tolerates unavailable extension storage", () => {
		const emptyStorage = {
			getItem: () => " \n ",
			removeItem: () => undefined,
		};
		const unavailableStorage = {
			getItem: () => {
				throw new Error("storage is unavailable");
			},
			removeItem: () => undefined,
		};

		expect(takeExtensionQuickMessageSeed(emptyStorage)).toBeUndefined();
		expect(takeExtensionQuickMessageSeed(unavailableStorage)).toBeUndefined();
	});

	it("accepts only a nonempty string from the dashboard seed event", () => {
		const valid = new CustomEvent("ryu:extension-quick-message-seed", {
			detail: { seed: "Continue the draft" },
		});
		const empty = new CustomEvent("ryu:extension-quick-message-seed", {
			detail: { seed: "  " },
		});
		const malformed = new CustomEvent("ryu:extension-quick-message-seed", {
			detail: { seed: 7 },
		});

		expect(extensionQuickMessageSeedFromEvent(valid)).toBe(
			"Continue the draft"
		);
		expect(extensionQuickMessageSeedFromEvent(empty)).toBeUndefined();
		expect(extensionQuickMessageSeedFromEvent(malformed)).toBeUndefined();
		expect(
			extensionQuickMessageSeedFromEvent(
				new Event("ryu:extension-quick-message-seed")
			)
		).toBeUndefined();
	});

	it("opens a new chat with a reviewable prefill and never auto-sends it", () => {
		expect(extensionQuickMessageTab("Summarize this page")).toEqual({
			options: {
				forceNew: true,
				initialPrompt: "Summarize this page",
				title: "New chat",
			},
			path: "/chat",
		});
		expect(extensionQuickMessageTab(" \t ")).toBeUndefined();
	});
});
