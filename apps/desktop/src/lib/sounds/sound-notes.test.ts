import { describe, expect, it } from "bun:test";
import {
	note,
	patternDuration,
	RYU_MOTIF_FREQUENCIES,
	RYU_NOTES,
	tone,
} from "./sound-notes.ts";

describe("Ryu notes", () => {
	it("tunes the D-A-E motif as rising perfect fifths", () => {
		expect(RYU_NOTES.A5 / RYU_NOTES.D5).toBeCloseTo(1.4983, 3);
		expect(RYU_NOTES.E6 / RYU_NOTES.A5).toBeCloseTo(1.4983, 3);
		expect(note("A4")).toBe(440);
		expect(RYU_MOTIF_FREQUENCIES).toContain(RYU_NOTES["F#6"]);
	});

	it("authors tones in milliseconds and measures pattern length", () => {
		const step = tone("D5", 70, 220, 0.5, { detune: 8 });
		expect(step).toEqual({
			at: 0.07,
			dur: 0.15,
			freq: 587.33,
			gain: 0.5,
			detune: 8,
		});
		expect(patternDuration([step, tone("A5", 0, 100, 1)])).toBeCloseTo(0.22, 6);
		expect(patternDuration([])).toBe(0);
	});
});
