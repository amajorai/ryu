import { describe, expect, it } from "bun:test";
import {
	FakeAudioContext,
	FakeClock,
	type FakeGain,
	type FakeParam,
} from "./sound-audio-context.fixture.ts";
import { tone } from "./sound-notes.ts";
import type { RenderedSound } from "./sound-packs.ts";
import { createLoop, SILENT_GAIN, scheduleTones } from "./sound-synth.ts";

const bell = (overrides: Partial<RenderedSound> = {}): RenderedSound => ({
	attack: 0.004,
	release: "exp",
	steps: [
		tone("A5", 0, 120, 0.5, { harmonic: { ratio: 2, gain: 0.12 } }),
		tone("E6", 75, 360, 0.6),
	],
	...overrides,
});

const kinds = (param: FakeParam) => param.calls.map((call) => call.kind);

/** The gain node an oscillator feeds (its envelope). */
function envelopeOf(ctx: FakeAudioContext, index: number): FakeGain {
	const target = ctx.oscillators[index]?.connections[0];
	const gain = ctx.gains.find((node) => node === target);
	if (!gain) {
		throw new Error(`oscillator ${index} has no envelope`);
	}
	return gain;
}

describe("scheduleTones", () => {
	it("creates one oscillator per step plus a harmonic, wired to the output", () => {
		const ctx = new FakeAudioContext();
		const out = ctx.createGain();
		scheduleTones(ctx, out, bell(), 1, 1);
		expect(ctx.oscillators).toHaveLength(3);
		const [fundamental, harmonic, second] = ctx.oscillators;
		expect(fundamental?.frequency.calls[0]).toEqual({
			kind: "set",
			value: 880,
			time: 1,
		});
		expect(harmonic?.frequency.calls[0]?.kind).toBe("set");
		expect(harmonic?.frequency.value).toBe(1760);
		expect(second?.startedAt).toBeCloseTo(1.075, 6);
		for (const oscillator of ctx.oscillators) {
			const gain = oscillator.connections[0];
			expect(ctx.gains).toContain(gain as never);
			expect(ctx.gains.find((node) => node === gain)?.connections).toEqual([
				out,
			]);
		}
	});

	it("envelopes from silence, peaks at gain x scale, decays exponentially", () => {
		const ctx = new FakeAudioContext();
		scheduleTones(ctx, ctx.createGain(), bell(), 0.5, 2);
		const envelope = envelopeOf(ctx, 0);
		expect(kinds(envelope.gain)).toEqual(["set", "linear", "exp"]);
		expect(envelope.gain.calls[0]).toEqual({
			kind: "set",
			value: SILENT_GAIN,
			time: 2,
		});
		expect(envelope.gain.calls[1]).toEqual({
			kind: "linear",
			value: 0.25,
			time: 2.004,
		});
		const release = envelope.gain.calls[2];
		expect(release?.kind).toBe("exp");
		expect(release && "value" in release ? release.value : -1).toBe(
			SILENT_GAIN
		);
		expect(release?.time).toBeCloseTo(2.12, 6);
		expect(ctx.oscillators[0]?.stops[0]).toBeCloseTo(2.15, 6);
		const harmonicEnvelope = envelopeOf(ctx, 1);
		expect(harmonicEnvelope.gain.peak()).toBeCloseTo(0.25 * 0.12, 6);
	});

	it("holds then fades briefly for the step release, never cutting at full gain", () => {
		const ctx = new FakeAudioContext();
		scheduleTones(
			ctx,
			ctx.createGain(),
			bell({ release: "step", steps: [tone("A5", 0, 100, 0.4)] }),
			1,
			0
		);
		const envelope = ctx.voiceGains()[0];
		const calls = envelope?.gain.calls ?? [];
		expect(calls.map((call) => call.kind)).toEqual([
			"set",
			"linear",
			"set",
			"linear",
		]);
		const last = calls.at(-1);
		expect(last && "value" in last ? last.value : -1).toBe(SILENT_GAIN);
		expect(last?.time).toBeCloseTo(0.1, 6);
	});

	it("adds a lowpass between the voices and the output when the pack has one", () => {
		const ctx = new FakeAudioContext();
		const out = ctx.createGain();
		scheduleTones(ctx, out, bell({ lowpassHz: 2200 }), 1, 0);
		expect(ctx.filters).toHaveLength(1);
		const filter = ctx.filters[0];
		expect(filter?.frequency.value).toBe(2200);
		expect(filter?.connections).toEqual([out]);
		expect(ctx.voiceGains()[0]?.connections).toEqual([filter as never]);
	});

	it("applies glides and detune", () => {
		const ctx = new FakeAudioContext();
		scheduleTones(
			ctx,
			ctx.createGain(),
			bell({
				steps: [
					tone("A5", 0, 80, 0.3, { glideTo: 1174.66, glideTime: 0.05 }),
					tone("A4", 100, 300, 0.5, { detune: 8 }),
				],
			}),
			1,
			0
		);
		expect(ctx.oscillators[0]?.frequency.calls[1]).toEqual({
			kind: "exp",
			value: 1174.66,
			time: 0.05,
		});
		expect(ctx.oscillators[1]?.detune.value).toBe(8);
	});

	it("skips inaudible tones and disconnects everything once it ends", () => {
		const silentCtx = new FakeAudioContext();
		scheduleTones(silentCtx, silentCtx.createGain(), bell(), 0, 0);
		expect(silentCtx.oscillators).toHaveLength(0);

		const ctx = new FakeAudioContext();
		scheduleTones(ctx, ctx.createGain(), bell({ lowpassHz: 5000 }), 1, 0);
		for (const oscillator of ctx.oscillators) {
			oscillator.end();
			expect(oscillator.disconnected).toBe(true);
		}
		expect(ctx.voiceGains().every((gain) => gain.disconnected)).toBe(true);
		expect(ctx.filters[0]?.disconnected).toBe(true);
	});

	it("cancels with a short fade from the current level, once", () => {
		const ctx = new FakeAudioContext();
		const scheduled = scheduleTones(ctx, ctx.createGain(), bell(), 1, 0);
		ctx.currentTime = 0.05;
		scheduled.cancel(0.03);
		scheduled.cancel(0.03);
		const envelope = ctx.voiceGains()[0];
		const tail = envelope?.gain.calls.slice(-3).map((call) => call.kind);
		expect(tail).toEqual(["cancel", "set", "target"]);
		expect(ctx.oscillators[0]?.stops).toHaveLength(2);
		expect(ctx.oscillators[0]?.stops[1]).toBeCloseTo(0.11, 6);
		expect(scheduled.endAt).toBeCloseTo(0.39, 6);
	});

	it("silences each new gain before its envelope, not the default of 1", () => {
		const ctx = new FakeAudioContext();
		const valueBeforeEnvelope: number[] = [];
		const createGain = ctx.createGain.bind(ctx);
		ctx.createGain = () => {
			const gain = createGain();
			const setValueAtTime = gain.gain.setValueAtTime.bind(gain.gain);
			gain.gain.setValueAtTime = (value: number, time: number) => {
				if (gain.gain.calls.length === 0) {
					valueBeforeEnvelope.push(gain.gain.value);
				}
				setValueAtTime(value, time);
			};
			return gain;
		};
		scheduleTones(ctx, new FakeAudioContext().createGain(), bell(), 1, 0.5);
		expect(valueBeforeEnvelope).toEqual([0, 0, 0]);
	});

	it("stops a not-yet-started tone at the cancel without fading from 1", () => {
		const ctx = new FakeAudioContext();
		const scheduled = scheduleTones(ctx, ctx.createGain(), bell(), 1, 0);
		// The second step (E6) starts at 0.075; cancel 20 ms before it.
		ctx.currentTime = 0.055;
		scheduled.cancel(0.03);
		const later = envelopeOf(ctx, 2);
		const afterCancel = later.gain.calls.slice(
			later.gain.calls.findIndex((call) => call.kind === "cancel")
		);
		expect(afterCancel).toEqual([
			{ kind: "cancel", time: 0.055 },
			{ kind: "set", value: 0, time: 0.055 },
		]);
		expect(later.gain.calls.some((call) => call.kind === "target")).toBe(false);
		expect(later.gain.value).toBe(0);
		const oscillator = ctx.oscillators[2];
		expect(oscillator?.stops.at(-1)).toBeCloseTo(0.055, 6);
		expect(oscillator?.stops.at(-1)).toBeLessThan(oscillator?.startedAt ?? 0);
		// The tone already sounding still fades out from where it is.
		expect(envelopeOf(ctx, 0).gain.calls.at(-1)?.kind).toBe("target");
	});
});

describe("createLoop", () => {
	it("repeats on the period ahead of time and stops idempotently", () => {
		const ctx = new FakeAudioContext();
		const clock = new FakeClock();
		const ring = bell({ steps: [tone("D5", 0, 350, 0.35)] });
		const stop = createLoop(ctx, ctx.createGain(), ring, 1, 2.4, clock.timers);
		expect(ctx.oscillators).toHaveLength(1);
		expect(ctx.oscillators[0]?.startedAt).toBeCloseTo(0.02, 6);
		ctx.currentTime = 2.2;
		clock.advance(2200);
		expect(ctx.oscillators).toHaveLength(2);
		expect(ctx.oscillators[1]?.startedAt).toBeCloseTo(2.42, 6);
		ctx.currentTime = 2.5;
		stop();
		stop();
		expect(clock.pending.size).toBe(0);
		const fadeKinds = ctx.voiceGains()[1]?.gain.calls.map((call) => call.kind);
		expect(fadeKinds?.at(-1)).toBe("target");
		clock.advance(10_000);
		expect(ctx.oscillators).toHaveLength(2);
		ctx.oscillators[1]?.end();
		expect(ctx.oscillators[1]?.disconnected).toBe(true);
	});
});
