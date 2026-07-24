import { describe, expect, it } from "bun:test";
import {
	DEFAULT_VOICE_PREFS,
	DEFAULT_VOICE_SHORTCUT,
	parseVoicePrefs,
	VOICE_ENGINE_MODELS,
} from "./voice.ts";

describe("parseVoicePrefs", () => {
	it("returns the default for null/empty input", () => {
		expect(parseVoicePrefs(null)).toEqual(DEFAULT_VOICE_PREFS);
		expect(parseVoicePrefs("")).toEqual(DEFAULT_VOICE_PREFS);
	});

	it("returns the default for malformed JSON", () => {
		expect(parseVoicePrefs("{not json")).toEqual(DEFAULT_VOICE_PREFS);
	});

	it("parses a fully specified blob", () => {
		const prefs = parseVoicePrefs(
			JSON.stringify({
				enabled: false,
				engine: "whisper",
				mode: "push-to-talk",
				model: "custom-model",
				shortcut: "Alt+Space",
			})
		);
		expect(prefs).toEqual({
			enabled: false,
			engine: "whisper",
			mode: "push-to-talk",
			model: "custom-model",
			shortcut: "Alt+Space",
		});
	});

	it("only an explicit false disables; any other value keeps it enabled", () => {
		expect(parseVoicePrefs(JSON.stringify({ enabled: false })).enabled).toBe(
			false
		);
		expect(parseVoicePrefs(JSON.stringify({})).enabled).toBe(true);
		expect(
			parseVoicePrefs(JSON.stringify({ enabled: "no" as unknown })).enabled
		).toBe(true);
	});

	it("coerces an unknown engine to parakeet and picks its bundled model", () => {
		const prefs = parseVoicePrefs(JSON.stringify({ engine: "bogus" }));
		expect(prefs.engine).toBe("parakeet");
		expect(prefs.model).toBe(VOICE_ENGINE_MODELS.parakeet);
	});

	it("defaults the model per-engine when the blob omits it", () => {
		const prefs = parseVoicePrefs(JSON.stringify({ engine: "whisper" }));
		expect(prefs.model).toBe(VOICE_ENGINE_MODELS.whisper);
	});

	it("coerces an unknown mode to toggle", () => {
		expect(parseVoicePrefs(JSON.stringify({ mode: "double-tap" })).mode).toBe(
			"toggle"
		);
	});

	it("trims a shortcut and falls back on blank/whitespace/non-string", () => {
		expect(
			parseVoicePrefs(JSON.stringify({ shortcut: "  Ctrl+B  " })).shortcut
		).toBe("Ctrl+B");
		expect(parseVoicePrefs(JSON.stringify({ shortcut: "   " })).shortcut).toBe(
			DEFAULT_VOICE_SHORTCUT
		);
		expect(
			parseVoicePrefs(JSON.stringify({ shortcut: 42 as unknown })).shortcut
		).toBe(DEFAULT_VOICE_SHORTCUT);
	});
});
