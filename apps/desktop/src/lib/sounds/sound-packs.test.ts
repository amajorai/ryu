import { describe, expect, it } from "bun:test";
import { SOUND_EVENT_IDS } from "./sound-catalog.ts";
import { patternDuration, RYU_MOTIF_FREQUENCIES } from "./sound-notes.ts";
import {
	ARPEGGIO_CEILING_HZ,
	basePattern,
	isSoundPackId,
	RING_PERIOD_SEC,
	renderPattern,
	SOUND_PACK_IDS,
	SOUND_PACKS,
} from "./sound-packs.ts";

const isMotifPitch = (freq: number) =>
	RYU_MOTIF_FREQUENCIES.some((pitch) => Math.abs(pitch - freq) < 0.01);

/** Same pitch class as a motif note (any octave). */
const isMotifPitchClass = (freq: number) =>
	RYU_MOTIF_FREQUENCIES.some((pitch) => {
		const octaves = Math.log2(freq / pitch);
		return Math.abs(octaves - Math.round(octaves)) < 0.001;
	});

const onGrid = (seconds: number) =>
	Math.abs(Math.round(seconds * 1000) % 50) === 0;

describe("sound packs", () => {
	it("renders every cue in every pack within sane bounds", () => {
		for (const packId of SOUND_PACK_IDS) {
			for (const id of SOUND_EVENT_IDS) {
				const sound = renderPattern(SOUND_PACKS[packId], id);
				expect(sound.steps.length).toBeGreaterThan(0);
				const limit = id === "call-ring" ? RING_PERIOD_SEC : 1.2;
				expect(patternDuration(sound.steps)).toBeLessThanOrEqual(limit);
				for (const step of sound.steps) {
					expect(step.freq).toBeGreaterThanOrEqual(100);
					expect(step.freq).toBeLessThanOrEqual(8000);
					expect(step.gain).toBeGreaterThan(0);
					expect(step.gain).toBeLessThanOrEqual(1);
					expect(step.dur).toBeGreaterThan(0);
					expect(step.at).toBeGreaterThanOrEqual(0);
				}
			}
		}
	});

	it("keeps every ryu cue on the D motif (the signature invariant)", () => {
		for (const id of SOUND_EVENT_IDS) {
			for (const step of renderPattern(SOUND_PACKS.ryu, id).steps) {
				expect(isMotifPitch(step.freq)).toBe(true);
				if (step.glideTo !== undefined) {
					expect(isMotifPitch(step.glideTo)).toBe(true);
				}
			}
		}
	});

	it("makes positive cues rise and negative cues fall", () => {
		const first = (id: "run-complete" | "run-failed" | "call-leave") => {
			const steps = basePattern(id);
			return [steps[0]?.freq ?? 0, steps.at(-1)?.freq ?? 0];
		};
		const [completeStart, completeEnd] = first("run-complete");
		expect(completeEnd).toBeGreaterThan(completeStart ?? 0);
		const [failStart, failEnd] = first("run-failed");
		expect(failEnd).toBeLessThan(failStart ?? 0);
		const [leaveStart, leaveEnd] = first("call-leave");
		expect(leaveEnd).toBeLessThan(leaveStart ?? 0);
	});

	it("gives the ryu pack its bell shimmer except on plain ticks", () => {
		const message = renderPattern(SOUND_PACKS.ryu, "message");
		expect(message.steps[0]?.harmonic).toEqual({ ratio: 2, gain: 0.12 });
		expect(message.release).toBe("exp");
		expect(message.lowpassHz).toBeUndefined();
		const tick = renderPattern(SOUND_PACKS.ryu, "message-sent");
		expect(tick.steps[0]?.harmonic).toBeUndefined();
	});

	it("softens the soft pack: lowpass, quieter, longer, folded high notes", () => {
		const ryu = renderPattern(SOUND_PACKS.ryu, "quest-complete");
		const soft = renderPattern(SOUND_PACKS.soft, "quest-complete");
		expect(soft.lowpassHz).toBe(2200);
		expect(soft.attack).toBeGreaterThan(ryu.attack);
		for (const [index, step] of soft.steps.entries()) {
			const original = ryu.steps[index];
			expect(step.freq).toBeLessThanOrEqual(1500);
			expect(step.gain).toBeCloseTo((original?.gain ?? 0) * 0.6, 6);
			expect(step.dur).toBeCloseTo((original?.dur ?? 0) * 1.3, 6);
			expect(step.harmonic).toBeUndefined();
		}
		expect(soft.steps.some((step) => step.freq === 880)).toBe(true);
	});

	it("makes retro square, quantized to 50 ms, with arpeggiated long notes", () => {
		for (const id of SOUND_EVENT_IDS) {
			const sound = renderPattern(SOUND_PACKS.retro, id);
			expect(sound.release).toBe("step");
			expect(sound.lowpassHz).toBe(5000);
			for (const step of sound.steps) {
				expect(step.wave).toBe("square");
				expect(onGrid(step.at)).toBe(true);
				expect(onGrid(step.dur)).toBe(true);
				expect(step.gain).toBeLessThanOrEqual(0.6 * 0.35 + 1e-9);
			}
		}
		const quest = renderPattern(SOUND_PACKS.retro, "quest-suggest").steps;
		// D6 flutters by octaves; D7 would pass the ceiling, so it drops to D5.
		expect(quest.map((step) => Math.round(step.freq))).toEqual([
			1175, 587, 1175, 587, 1175, 587,
		]);
		expect(quest.map((step) => Math.round(step.at * 1000))).toEqual([
			0, 50, 100, 150, 200, 250,
		]);
	});

	it("keeps retro inside the motif, under the ceiling, and falling cues falling", () => {
		for (const id of SOUND_EVENT_IDS) {
			for (const step of renderPattern(SOUND_PACKS.retro, id).steps) {
				expect(isMotifPitchClass(step.freq)).toBe(true);
				expect(step.freq).toBeLessThanOrEqual(ARPEGGIO_CEILING_HZ);
			}
		}
		for (const id of ["run-failed", "call-leave", "call-error"] as const) {
			const steps = renderPattern(SOUND_PACKS.retro, id).steps;
			const first = steps[0]?.freq ?? 0;
			// No step climbs above where the cue began, and it ends lower.
			expect(steps.every((step) => step.freq <= first)).toBe(true);
			expect(steps.at(-1)?.freq ?? first).toBeLessThan(first);
		}
	});

	it("keeps a grid step of silence between retro double knocks", () => {
		const alert = renderPattern(SOUND_PACKS.retro, "alert").steps;
		const knocks = alert.filter((step) => Math.round(step.freq) === 1319);
		expect(knocks).toHaveLength(2);
		const [firstKnock, secondKnock] = knocks;
		expect(
			(secondKnock?.at ?? 0) - ((firstKnock?.at ?? 0) + (firstKnock?.dur ?? 0))
		).toBeGreaterThanOrEqual(0.05 - 1e-9);
		const credit = renderPattern(SOUND_PACKS.retro, "credit-alert").steps;
		const firstB4 = credit[0];
		const secondB4Start = credit.find(
			(step, index) => index > 0 && Math.round(step.freq) === 494
		);
		expect(firstB4?.dur).toBeCloseTo(0.1, 6);
		expect(secondB4Start?.at).toBeCloseTo(0.15, 6);
	});

	it("recognises pack ids", () => {
		expect(isSoundPackId("retro")).toBe(true);
		expect(isSoundPackId("classic")).toBe(false);
		expect(isSoundPackId(undefined)).toBe(false);
	});
});
