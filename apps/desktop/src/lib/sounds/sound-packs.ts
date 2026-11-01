// Ryu sound packs. Each cue has one base pattern built from the Ryu motif
// (see sound-notes.ts); a pack only re-voices it (waveform, envelope, filter,
// timing grid), so "run complete" is the same rising D-A-E in every pack.

import type { SoundEventId } from "./sound-catalog.ts";
import { type ToneStep, tone } from "./sound-notes.ts";

export const SOUND_PACK_IDS = ["ryu", "soft", "retro"] as const;
export type SoundPackId = (typeof SOUND_PACK_IDS)[number];

export interface SoundPack {
	/** Seconds; notes this long or longer become a stepped arpeggio. */
	arpeggiateFromSec?: number;
	/** Seconds from silence to the peak. */
	attack: number;
	description: string;
	/** Multiplies every tone's length (a longer, gentler tail). */
	durScale: number;
	/** Notes above this pitch drop an octave (keeps a soft pack mellow). */
	foldAboveHz?: number;
	/** Multiplies every tone's gain; square waves are much louder than sines. */
	gainScale: number;
	harmonic?: { gain: number; ratio: number };
	id: SoundPackId;
	label: string;
	lowpassHz?: number;
	/** Timing grid in seconds (chiptune feel). */
	quantize?: number;
	/** `exp`: bell-like decay. `step`: hold, then a very short fade. */
	release: "exp" | "step";
	wave: OscillatorType;
}

export const SOUND_PACKS: Readonly<Record<SoundPackId, SoundPack>> = {
	ryu: {
		id: "ryu",
		label: "Ryu",
		description: "Bright bell tones built on Ryu's open fifths.",
		wave: "sine",
		attack: 0.004,
		release: "exp",
		harmonic: { ratio: 2, gain: 0.12 },
		gainScale: 1,
		durScale: 1,
	},
	soft: {
		id: "soft",
		label: "Soft",
		description: "Rounder, quieter tones with a longer fade.",
		wave: "sine",
		attack: 0.018,
		release: "exp",
		lowpassHz: 2200,
		gainScale: 0.6,
		durScale: 1.3,
		foldAboveHz: 1500,
	},
	retro: {
		id: "retro",
		label: "Retro",
		description: "8-bit square waves on a chiptune grid.",
		wave: "square",
		attack: 0.002,
		release: "step",
		lowpassHz: 5000,
		gainScale: 0.35,
		durScale: 1,
		quantize: 0.05,
		arpeggiateFromSec: 0.12,
	},
};

export const DEFAULT_SOUND_PACK: SoundPackId = "ryu";

/** The connecting ring repeats on this period, in seconds. */
export const RING_PERIOD_SEC = 2.4;

const PLAIN = { harmonic: { ratio: 2, gain: 0 } } as const;
const WARM = { wave: "triangle" } as const;

const QUEST_COMPLETE: readonly ToneStep[] = [
	tone("D5", 0, 140, 0.4),
	tone("A5", 55, 195, 0.4),
	tone("D6", 110, 250, 0.4),
	tone("F#6", 165, 305, 0.4),
	tone("D6", 220, 760, 0.3),
	tone("F#6", 220, 760, 0.3),
	tone("A6", 220, 760, 0.3),
];

const BASE_PATTERNS: Readonly<Record<SoundEventId, readonly ToneStep[]>> = {
	// The "Ryu ping": a quick rising fifth.
	message: [tone("A5", 0, 120, 0.5), tone("E6", 75, 360, 0.6)],
	// A soft tick that lifts a fourth.
	"message-sent": [
		tone("A5", 0, 80, 0.3, { ...PLAIN, glideTo: 1174.66, glideTime: 0.05 }),
	],
	// The full motif, D -> A -> E, with a long tail.
	"run-complete": [
		tone("D5", 0, 130, 0.45),
		tone("A5", 70, 220, 0.5),
		tone("E6", 140, 560, 0.6),
	],
	// The motif falling a fifth, slightly sour on the landing.
	"run-failed": [
		tone("E5", 0, 160, 0.5, WARM),
		tone("A4", 130, 460, 0.5, { ...WARM, detune: 8 }),
	],
	// Knock-knock on an open fifth.
	"approval-needed": [
		tone("A5", 0, 110, 0.4),
		tone("E6", 0, 110, 0.4),
		tone("A5", 180, 380, 0.45),
		tone("E6", 180, 380, 0.45),
	],
	alert: [
		tone("E6", 0, 90, 0.45),
		tone("E6", 120, 210, 0.45),
		tone("B4", 220, 480, 0.5, WARM),
	],
	"credit-alert": [
		tone("B4", 0, 130, 0.5, WARM),
		tone("B4", 160, 310, 0.5, WARM),
		tone("E5", 320, 560, 0.35),
	],
	"quest-suggest": [tone("D6", 0, 320, 0.35)],
	"quest-complete": QUEST_COMPLETE,
	achievement: [
		...QUEST_COMPLETE,
		tone("E6", 720, 860, 0.3),
		tone("A6", 800, 1000, 0.3),
	],
	// One ring period: two soft D-A dyads, then silence until RING_PERIOD_SEC.
	"call-ring": [
		tone("D5", 0, 350, 0.35),
		tone("A5", 0, 350, 0.35),
		tone("D5", 500, 850, 0.35),
		tone("A5", 500, 850, 0.35),
	],
	"call-join": [tone("D5", 0, 110, 0.45), tone("A5", 90, 320, 0.5)],
	"call-leave": [tone("A5", 0, 110, 0.45), tone("D5", 90, 320, 0.5)],
	"call-error": [
		tone("A5", 0, 120, 0.45),
		tone("D5", 110, 230, 0.45),
		tone("B4", 210, 460, 0.5, WARM),
	],
	mute: [tone("E5", 0, 70, 0.4, PLAIN), tone("A4", 50, 160, 0.4, PLAIN)],
	unmute: [tone("A4", 0, 70, 0.4, PLAIN), tone("E5", 50, 160, 0.4, PLAIN)],
	"meeting-detected": [tone("D6", 0, 180, 0.3), tone("A6", 160, 420, 0.3)],
};

/** A cue ready for the synth: resolved steps plus the pack's envelope. */
export interface RenderedSound {
	attack: number;
	lowpassHz?: number;
	release: "exp" | "step";
	steps: ToneStep[];
}

export function basePattern(id: SoundEventId): readonly ToneStep[] {
	return BASE_PATTERNS[id];
}

export function isSoundPackId(value: unknown): value is SoundPackId {
	return (
		typeof value === "string" &&
		(SOUND_PACK_IDS as readonly string[]).includes(value)
	);
}

function snap(seconds: number, grid: number): number {
	const gridMs = Math.round(grid * 1000);
	return (Math.round((seconds * 1000) / gridMs) * gridMs) / 1000;
}

/**
 * Arpeggios flutter by octaves, so every pitch keeps a motif pitch class. A
 * rising cue flutters up, a falling (negative) cue flutters down, so the
 * contour that tells good news from bad survives the retro pack.
 */
const RISING_ARPEGGIO = [1, 2] as const;
const FALLING_ARPEGGIO = [1, 0.5] as const;
/** Square waves above this get shrill; an arpeggio step drops an octave instead. */
export const ARPEGGIO_CEILING_HZ = 2000;

function arpeggiate(
	step: ToneStep,
	grid: number,
	falling: boolean
): ToneStep[] {
	const ratios = falling ? FALLING_ARPEGGIO : RISING_ARPEGGIO;
	const gridMs = Math.round(grid * 1000);
	const count = Math.max(1, Math.round((step.dur * 1000) / gridMs));
	const startMs = Math.round(step.at * 1000);
	const out: ToneStep[] = [];
	for (let index = 0; index < count; index++) {
		const ratio = ratios[index % ratios.length] ?? 1;
		const raised = step.freq * ratio;
		out.push({
			...step,
			at: (startMs + index * gridMs) / 1000,
			dur: gridMs / 1000,
			freq: raised > ARPEGGIO_CEILING_HZ ? step.freq / 2 : raised,
			glideTo: undefined,
			glideTime: undefined,
		});
	}
	return out;
}

/** A cue whose last note is lower than its first is a falling (negative) cue. */
function isFallingPattern(pattern: readonly ToneStep[]): boolean {
	const first = pattern[0];
	const last = pattern.at(-1);
	return first !== undefined && last !== undefined && last.freq < first.freq;
}

/**
 * Snapping to the grid can close a deliberate gap between two notes of the
 * same pitch (a double knock). Shorten the earlier one so at least one grid
 * step of silence stays between them.
 */
function keepRepeatGaps(
	base: readonly ToneStep[],
	steps: ToneStep[],
	grid: number
): void {
	for (let later = 1; later < steps.length; later++) {
		const next = steps[later];
		const nextBase = base[later];
		if (!(next && nextBase)) {
			continue;
		}
		for (let earlier = 0; earlier < later; earlier++) {
			const prior = steps[earlier];
			const priorBase = base[earlier];
			if (!(prior && priorBase) || priorBase.freq !== nextBase.freq) {
				continue;
			}
			const hadGap = priorBase.at + priorBase.dur < nextBase.at;
			const latestEnd = next.at - grid;
			if (hadGap && prior.at + prior.dur > latestEnd + 1e-9) {
				prior.dur = Math.max(grid, snap(latestEnd - prior.at, grid));
			}
		}
	}
}

function voice(step: ToneStep, pack: SoundPack): ToneStep {
	const folded = pack.foldAboveHz !== undefined && step.freq > pack.foldAboveHz;
	const voiced: ToneStep = {
		...step,
		dur: step.dur * pack.durScale,
		freq: folded ? step.freq / 2 : step.freq,
		gain: step.gain * pack.gainScale,
		wave: pack.id === "retro" ? pack.wave : (step.wave ?? pack.wave),
	};
	if (folded && step.glideTo !== undefined) {
		voiced.glideTo = step.glideTo / 2;
	}
	const harmonic = step.harmonic ?? pack.harmonic;
	if (harmonic && harmonic.gain > 0) {
		voiced.harmonic = harmonic;
	} else {
		voiced.harmonic = undefined;
	}
	return voiced;
}

/** Re-voice a cue's base pattern for a pack. */
export function renderPattern(
	pack: SoundPack,
	id: SoundEventId
): RenderedSound {
	const base = BASE_PATTERNS[id];
	const voiced = base.map((step) => voice(step, pack));
	const grid = pack.quantize;
	if (grid === undefined) {
		return {
			attack: pack.attack,
			release: pack.release,
			steps: voiced,
			...(pack.lowpassHz === undefined ? {} : { lowpassHz: pack.lowpassHz }),
		};
	}
	const snapped = voiced.map((step) => ({
		...step,
		at: snap(step.at, grid),
		dur: Math.max(grid, snap(step.dur, grid)),
	}));
	keepRepeatGaps(base, snapped, grid);
	const falling = isFallingPattern(base);
	const steps: ToneStep[] = [];
	for (const step of snapped) {
		if (
			pack.arpeggiateFromSec !== undefined &&
			step.dur > pack.arpeggiateFromSec
		) {
			steps.push(...arpeggiate(step, grid, falling));
		} else {
			steps.push(step);
		}
	}
	return {
		attack: pack.attack,
		release: pack.release,
		steps,
		...(pack.lowpassHz === undefined ? {} : { lowpassHz: pack.lowpassHz }),
	};
}
