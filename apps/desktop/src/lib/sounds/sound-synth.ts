// Web Audio scheduling for rendered cues. Every tone gets its own oscillator
// and gain envelope that starts and ends at near-silence, so nothing clicks:
// gain rises from SILENT_GAIN to the peak over the attack, then decays
// exponentially (or holds and fades very briefly for the retro pack) back to
// SILENT_GAIN before the oscillator stops.
//
// The structural types below are the slice of Web Audio the synth uses, so a
// real AudioContext satisfies them and tests can pass a recording fake.

import type { ToneStep } from "./sound-notes.ts";
import type { RenderedSound } from "./sound-packs.ts";

export interface SoundAudioParam {
	cancelAndHoldAtTime?: (time: number) => unknown;
	cancelScheduledValues(time: number): unknown;
	exponentialRampToValueAtTime(value: number, time: number): unknown;
	linearRampToValueAtTime(value: number, time: number): unknown;
	setTargetAtTime(target: number, time: number, constant: number): unknown;
	setValueAtTime(value: number, time: number): unknown;
	value: number;
}

export interface SoundAudioNode {
	connect(destination: SoundAudioNode): unknown;
	disconnect(): void;
}

export interface SoundOscillator extends SoundAudioNode {
	detune: SoundAudioParam;
	frequency: SoundAudioParam;
	onended: ((event: Event) => void) | null;
	start(when?: number): void;
	stop(when?: number): void;
	type: OscillatorType;
}

export interface SoundGain extends SoundAudioNode {
	gain: SoundAudioParam;
}

export interface SoundFilter extends SoundAudioNode {
	frequency: SoundAudioParam;
	Q: SoundAudioParam;
	type: BiquadFilterType;
}

export interface SoundAudioContext {
	createBiquadFilter(): SoundFilter;
	createGain(): SoundGain;
	createOscillator(): SoundOscillator;
	readonly currentTime: number;
	readonly destination: SoundAudioNode;
	resume(): Promise<void>;
	readonly state: string;
}

/** Exponential ramps cannot reach 0; this is inaudible (-80 dB). */
export const SILENT_GAIN = 0.0001;

/** The retro pack's hold-then-fade release, in seconds. */
const STEP_RELEASE_SEC = 0.008;
/** Oscillators run a little past the envelope so the tail is never cut. */
const STOP_PADDING_SEC = 0.03;
/** The harmonic shimmer fades faster than the fundamental. */
const HARMONIC_DECAY_RATIO = 0.6;
const DEFAULT_CANCEL_FADE_SEC = 0.03;

export interface ScheduledSound {
	/** Fade everything out quickly (no click) and stop. Idempotent. */
	cancel(fadeSec?: number): void;
	/** Context time when the last tone has finished. */
	endAt: number;
	startAt: number;
}

interface Voice {
	gain: SoundGain;
	oscillator: SoundOscillator;
	/** Context time the tone starts sounding. */
	start: number;
}

function applyEnvelope(
	param: SoundAudioParam,
	peak: number,
	start: number,
	dur: number,
	sound: RenderedSound
): void {
	const end = start + dur;
	const attackEnd = start + Math.min(sound.attack, dur / 2);
	param.setValueAtTime(SILENT_GAIN, start);
	param.linearRampToValueAtTime(peak, attackEnd);
	if (sound.release === "step") {
		const fade = Math.min(STEP_RELEASE_SEC, dur / 4);
		param.setValueAtTime(peak, Math.max(attackEnd, end - fade));
		param.linearRampToValueAtTime(SILENT_GAIN, end);
		return;
	}
	param.exponentialRampToValueAtTime(SILENT_GAIN, end);
}

function startOscillator(
	ctx: SoundAudioContext,
	destination: SoundAudioNode,
	options: {
		freq: number;
		glideTo?: number;
		glideTime?: number;
		detune?: number;
		wave: OscillatorType;
		peak: number;
		start: number;
		dur: number;
		sound: RenderedSound;
	}
): Voice {
	const oscillator = ctx.createOscillator();
	const gain = ctx.createGain();
	// A new GainNode defaults to 1. Silence it until the envelope's first event
	// so a cancel before a later tone starts never holds (and leaks) full scale.
	gain.gain.value = 0;
	oscillator.type = options.wave;
	oscillator.frequency.setValueAtTime(options.freq, options.start);
	if (options.glideTo !== undefined && options.glideTo > 0) {
		const glideEnd =
			options.start + Math.min(options.glideTime ?? options.dur, options.dur);
		oscillator.frequency.exponentialRampToValueAtTime(
			options.glideTo,
			glideEnd
		);
	}
	if (options.detune) {
		oscillator.detune.setValueAtTime(options.detune, options.start);
	}
	applyEnvelope(
		gain.gain,
		options.peak,
		options.start,
		options.dur,
		options.sound
	);
	oscillator.connect(gain);
	gain.connect(destination);
	oscillator.start(options.start);
	oscillator.stop(options.start + options.dur + STOP_PADDING_SEC);
	return { gain, oscillator, start: options.start };
}

function scheduleStep(
	ctx: SoundAudioContext,
	destination: SoundAudioNode,
	step: ToneStep,
	sound: RenderedSound,
	peak: number,
	start: number
): Voice[] {
	const wave = step.wave ?? "sine";
	const voices = [
		startOscillator(ctx, destination, {
			...step,
			wave,
			peak,
			start,
			dur: step.dur,
			sound,
		}),
	];
	const harmonic = step.harmonic;
	const harmonicPeak = harmonic ? peak * harmonic.gain : 0;
	if (harmonic && harmonicPeak > SILENT_GAIN * 2) {
		voices.push(
			startOscillator(ctx, destination, {
				freq: step.freq * harmonic.ratio,
				glideTo:
					step.glideTo === undefined
						? undefined
						: step.glideTo * harmonic.ratio,
				glideTime: step.glideTime,
				detune: step.detune,
				wave: "sine",
				peak: harmonicPeak,
				start,
				dur: Math.max(step.dur * HARMONIC_DECAY_RATIO, sound.attack * 2),
				sound,
			})
		);
	}
	return voices;
}

function fadeOut(param: SoundAudioParam, at: number, fadeSec: number): void {
	if (param.cancelAndHoldAtTime) {
		param.cancelAndHoldAtTime(at);
	} else {
		const current = param.value;
		param.cancelScheduledValues(at);
		param.setValueAtTime(Math.max(current, SILENT_GAIN), at);
	}
	param.setTargetAtTime(SILENT_GAIN, at, fadeSec / 3);
}

function silence(param: SoundAudioParam, at: number): void {
	param.cancelScheduledValues(at);
	param.setValueAtTime(0, at);
}

function safely(action: () => void): void {
	try {
		action();
	} catch {
		// Nodes that already stopped or disconnected throw; nothing to undo.
	}
}

/**
 * Schedule a rendered cue at `startAt` (context time). `gainScale` multiplies
 * every tone's gain (volume, ducking, headroom).
 */
export function scheduleTones(
	ctx: SoundAudioContext,
	out: SoundAudioNode,
	sound: RenderedSound,
	gainScale: number,
	startAt: number
): ScheduledSound {
	let destination: SoundAudioNode = out;
	let filter: SoundFilter | null = null;
	if (sound.lowpassHz !== undefined) {
		filter = ctx.createBiquadFilter();
		filter.type = "lowpass";
		filter.frequency.setValueAtTime(sound.lowpassHz, startAt);
		filter.Q.setValueAtTime(0.7, startAt);
		filter.connect(out);
		destination = filter;
	}
	const voices: Voice[] = [];
	let endAt = startAt;
	for (const step of sound.steps) {
		const peak = step.gain * gainScale;
		if (peak <= SILENT_GAIN * 2) {
			continue;
		}
		const start = startAt + step.at;
		voices.push(...scheduleStep(ctx, destination, step, sound, peak, start));
		endAt = Math.max(endAt, start + step.dur + STOP_PADDING_SEC);
	}
	let remaining = voices.length;
	const releaseFilter = () => {
		if (filter) {
			const node = filter;
			filter = null;
			safely(() => node.disconnect());
		}
	};
	for (const voice of voices) {
		voice.oscillator.onended = () => {
			safely(() => voice.oscillator.disconnect());
			safely(() => voice.gain.disconnect());
			remaining -= 1;
			if (remaining <= 0) {
				releaseFilter();
			}
		};
	}
	if (voices.length === 0) {
		releaseFilter();
	}
	let cancelled = false;
	return {
		startAt,
		endAt,
		cancel(fadeSec = DEFAULT_CANCEL_FADE_SEC) {
			if (cancelled) {
				return;
			}
			cancelled = true;
			const at = ctx.currentTime;
			for (const voice of voices) {
				if (voice.start > at) {
					// Not sounding yet: drop its envelope and stop it before it starts.
					safely(() => silence(voice.gain.gain, at));
					safely(() => voice.oscillator.stop(at));
					continue;
				}
				safely(() => fadeOut(voice.gain.gain, at, fadeSec));
				safely(() => voice.oscillator.stop(at + fadeSec + STOP_PADDING_SEC));
			}
		},
	};
}

export interface SoundTimers {
	clearTimeout(handle: unknown): void;
	setTimeout(callback: () => void, ms: number): unknown;
}

export const DEFAULT_SOUND_TIMERS: SoundTimers = {
	setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
	clearTimeout: (handle) => {
		globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
};

/** How far ahead of a ring period the next one is scheduled, in seconds. */
const LOOP_LOOKAHEAD_SEC = 0.3;

/**
 * Repeat a cue every `periodSec` until the returned stop function runs. The
 * stop function is idempotent and fades out whatever is still sounding.
 */
export function createLoop(
	ctx: SoundAudioContext,
	out: SoundAudioNode,
	sound: RenderedSound,
	gainScale: number,
	periodSec: number,
	timers: SoundTimers = DEFAULT_SOUND_TIMERS
): () => void {
	let stopped = false;
	let timer: unknown = null;
	let active: ScheduledSound[] = [];
	let nextAt = ctx.currentTime + 0.02;
	const scheduleNext = () => {
		timer = null;
		if (stopped) {
			return;
		}
		const now = ctx.currentTime;
		active = active.filter((scheduled) => scheduled.endAt > now);
		active.push(scheduleTones(ctx, out, sound, gainScale, nextAt));
		nextAt += periodSec;
		const delayMs = Math.max(0, (nextAt - now - LOOP_LOOKAHEAD_SEC) * 1000);
		timer = timers.setTimeout(scheduleNext, delayMs);
	};
	scheduleNext();
	return () => {
		if (stopped) {
			return;
		}
		stopped = true;
		if (timer !== null) {
			timers.clearTimeout(timer);
			timer = null;
		}
		for (const scheduled of active) {
			scheduled.cancel(0.04);
		}
		active = [];
	};
}
