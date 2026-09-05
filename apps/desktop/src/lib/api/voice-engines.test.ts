import { describe, expect, test } from "bun:test";
import { isVoiceEngine, VOICE_ENGINES } from "@/src/lib/api/preferences.ts";

describe("voice engines", () => {
	test("the cloud slot is selectable", () => {
		// Core has routed `engine=gateway` to the gateway's STT modality for some
		// time (`crates/core/stt`). It was unreachable purely because this list and
		// the coercion below omitted it.
		expect(VOICE_ENGINES.map((e) => e.engine)).toContain("gateway");
	});

	test("audio.cpp is selectable as a local runtime", () => {
		const engine = VOICE_ENGINES.find((entry) => entry.engine === "audiocpp");
		expect(engine).toMatchObject({
			label: "audio.cpp",
			model: "parakeet-tdt-0.6b-v3-q8_0",
			sidecar: "audiocpp",
		});
	});

	test("only the cloud engine has no sidecar", () => {
		// The install/run row keys off `sidecar`; a local engine without one would
		// render as permanently stopped.
		for (const engine of VOICE_ENGINES) {
			if (engine.engine === "gateway") {
				expect(engine.sidecar).toBeNull();
			} else {
				expect(typeof engine.sidecar).toBe("string");
			}
		}
	});

	test("the cloud engine pins no model", () => {
		// The gateway picks the model from its STT modality mapping, so Core sends
		// none. A hardcoded name here would be a claim this side cannot honour.
		expect(VOICE_ENGINES.find((e) => e.engine === "gateway")?.model).toBe("");
	});

	test("recognises every listed engine and rejects anything else", () => {
		for (const engine of VOICE_ENGINES) {
			expect(isVoiceEngine(engine.engine)).toBe(true);
		}
		expect(isVoiceEngine("deepgram")).toBe(false);
		expect(isVoiceEngine("")).toBe(false);
		expect(isVoiceEngine(null)).toBe(false);
		expect(isVoiceEngine(undefined)).toBe(false);
		expect(isVoiceEngine(3)).toBe(false);
	});

	test("the guard is derived from the list, not hand-written", () => {
		// The regression this replaces: `value === "whisper" ? "whisper" :
		// "parakeet"` mapped EVERY unrecognised value onto parakeet, so adding an
		// engine left it unselectable AND silently rewrote a saved pick for it.
		// Anything in the list must pass; that is the property a hardcoded pair
		// cannot keep.
		const unknownToTheOldForm = VOICE_ENGINES.filter(
			(e) => e.engine !== "whisper" && e.engine !== "parakeet"
		);
		expect(unknownToTheOldForm.length).toBeGreaterThan(0);
		for (const engine of unknownToTheOldForm) {
			expect(isVoiceEngine(engine.engine)).toBe(true);
		}
	});
});
