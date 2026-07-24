import { describe, expect, it } from "bun:test";
import {
	DEFAULT_ISLAND_TTS_ENGINE,
	DEFAULT_ISLAND_TTS_PREFS,
	parseIslandTtsPrefs,
} from "./tts.ts";

describe("parseIslandTtsPrefs", () => {
	it("returns the default for null/empty/malformed input", () => {
		expect(parseIslandTtsPrefs(null)).toEqual(DEFAULT_ISLAND_TTS_PREFS);
		expect(parseIslandTtsPrefs("")).toEqual(DEFAULT_ISLAND_TTS_PREFS);
		expect(parseIslandTtsPrefs("{bad")).toEqual(DEFAULT_ISLAND_TTS_PREFS);
	});

	it("parses a fully specified blob", () => {
		expect(
			parseIslandTtsPrefs(
				JSON.stringify({ enabled: false, engine: "outetts", voice: "af_bella" })
			)
		).toEqual({ enabled: false, engine: "outetts", voice: "af_bella" });
	});

	it("only an explicit false disables playback", () => {
		expect(
			parseIslandTtsPrefs(JSON.stringify({ enabled: false })).enabled
		).toBe(false);
		expect(parseIslandTtsPrefs(JSON.stringify({})).enabled).toBe(true);
	});

	it("falls back to the default engine for a blank/non-string engine", () => {
		expect(parseIslandTtsPrefs(JSON.stringify({ engine: "" })).engine).toBe(
			DEFAULT_ISLAND_TTS_ENGINE
		);
		expect(
			parseIslandTtsPrefs(JSON.stringify({ engine: 5 as unknown })).engine
		).toBe(DEFAULT_ISLAND_TTS_ENGINE);
	});

	it("defaults voice to empty (engine default) when absent or non-string", () => {
		expect(parseIslandTtsPrefs(JSON.stringify({})).voice).toBe("");
		expect(
			parseIslandTtsPrefs(JSON.stringify({ voice: 7 as unknown })).voice
		).toBe("");
	});
});
