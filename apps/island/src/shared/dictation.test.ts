import { describe, expect, it } from "bun:test";
import {
	DEFAULT_DICTATION_POSTPROCESS_PROMPT,
	DEFAULT_DICTATION_PREFS,
	DEFAULT_DICTATION_SHORTCUT,
	parseDictationPrefs,
} from "./dictation.ts";

describe("parseDictationPrefs", () => {
	it("returns the default for null/empty/malformed input", () => {
		expect(parseDictationPrefs(null)).toEqual(DEFAULT_DICTATION_PREFS);
		expect(parseDictationPrefs("")).toEqual(DEFAULT_DICTATION_PREFS);
		expect(parseDictationPrefs("{bad")).toEqual(DEFAULT_DICTATION_PREFS);
	});

	it("parses a fully specified blob", () => {
		const prefs = parseDictationPrefs(
			JSON.stringify({
				autoSend: true,
				enabled: false,
				engine: "whisper",
				insertMode: "paste",
				mode: "toggle",
				pasteKeys: "cmd+shift+v",
				postProcess: { agent: "ryu", enabled: true, prompt: "Fix it." },
				restoreClipboard: false,
				shortcut: "Alt+D",
			})
		);
		expect(prefs).toEqual({
			autoSend: true,
			enabled: false,
			engine: "whisper",
			insertMode: "paste",
			mode: "toggle",
			pasteKeys: "cmd+shift+v",
			postProcess: { agent: "ryu", enabled: true, prompt: "Fix it." },
			restoreClipboard: false,
			shortcut: "Alt+D",
		});
	});

	it("uses opinionated defaults: ptt, parakeet, type, keep-clipboard, no auto-send", () => {
		// An empty object exercises every coercion default (mode default is ptt,
		// which is the opposite of the voice-input toggle default).
		const prefs = parseDictationPrefs(JSON.stringify({}));
		expect(prefs.mode).toBe("push-to-talk");
		expect(prefs.engine).toBe("parakeet");
		expect(prefs.insertMode).toBe("type");
		expect(prefs.enabled).toBe(true);
		expect(prefs.restoreClipboard).toBe(true);
		expect(prefs.autoSend).toBe(false);
		expect(prefs.shortcut).toBe(DEFAULT_DICTATION_SHORTCUT);
	});

	it("coerces unknown engine/mode/insertMode to their defaults", () => {
		const prefs = parseDictationPrefs(
			JSON.stringify({ engine: "x", mode: "y", insertMode: "z" })
		);
		expect(prefs.engine).toBe("parakeet");
		expect(prefs.mode).toBe("push-to-talk");
		expect(prefs.insertMode).toBe("type");
	});

	it("only an explicit false flips enabled/restoreClipboard; only true flips autoSend", () => {
		expect(
			parseDictationPrefs(JSON.stringify({ enabled: false })).enabled
		).toBe(false);
		expect(
			parseDictationPrefs(JSON.stringify({ restoreClipboard: false }))
				.restoreClipboard
		).toBe(false);
		expect(
			parseDictationPrefs(JSON.stringify({ autoSend: true })).autoSend
		).toBe(true);
		// Non-boolean autoSend stays false (guards accidental sends).
		expect(
			parseDictationPrefs(JSON.stringify({ autoSend: "yes" as unknown }))
				.autoSend
		).toBe(false);
	});

	it("trims shortcut + pasteKeys and falls back on blank shortcut", () => {
		expect(
			parseDictationPrefs(JSON.stringify({ shortcut: "  Ctrl+E " })).shortcut
		).toBe("Ctrl+E");
		expect(
			parseDictationPrefs(JSON.stringify({ shortcut: "   " })).shortcut
		).toBe(DEFAULT_DICTATION_SHORTCUT);
		expect(
			parseDictationPrefs(JSON.stringify({ pasteKeys: "  ctrl+v " })).pasteKeys
		).toBe("ctrl+v");
		expect(
			parseDictationPrefs(JSON.stringify({ pasteKeys: 9 as unknown })).pasteKeys
		).toBe("");
	});

	describe("postProcess block", () => {
		it("fills defaults when the block is absent or non-object", () => {
			const prefs = parseDictationPrefs(JSON.stringify({}));
			expect(prefs.postProcess).toEqual({
				agent: "",
				enabled: false,
				prompt: DEFAULT_DICTATION_POSTPROCESS_PROMPT,
			});
		});

		it("enables cleanup only for an explicit true and keeps a custom prompt", () => {
			const prefs = parseDictationPrefs(
				JSON.stringify({
					postProcess: { agent: "coder", enabled: true, prompt: "Tidy." },
				})
			);
			expect(prefs.postProcess).toEqual({
				agent: "coder",
				enabled: true,
				prompt: "Tidy.",
			});
		});

		it("falls back to the default prompt for a blank/whitespace prompt", () => {
			const prefs = parseDictationPrefs(
				JSON.stringify({ postProcess: { prompt: "   " } })
			);
			expect(prefs.postProcess.prompt).toBe(
				DEFAULT_DICTATION_POSTPROCESS_PROMPT
			);
			expect(prefs.postProcess.enabled).toBe(false);
			expect(prefs.postProcess.agent).toBe("");
		});
	});
});
