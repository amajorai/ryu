// The Ryu sonic signature: every cue is built from one motif in D, the "Ryu
// interval" D -> A -> E (two rising open fifths). Positive cues rise through
// it, negative cues fall back down it, so the family stays recognisable across
// sound packs.

/** Equal-tempered pitches (A4 = 440 Hz) used by the Ryu cues. */
export const RYU_NOTES = {
	A4: 440,
	B4: 493.88,
	D5: 587.33,
	E5: 659.25,
	A5: 880,
	D6: 1174.66,
	E6: 1318.51,
	"F#6": 1479.98,
	A6: 1760,
} as const;

export type RyuNoteName = keyof typeof RYU_NOTES;

/** Every pitch the `ryu` pack may use: the D-major-pentatonic motif set. */
export const RYU_MOTIF_FREQUENCIES: readonly number[] =
	Object.values(RYU_NOTES);

export function note(name: RyuNoteName): number {
	return RYU_NOTES[name];
}

/** One scheduled tone. Times are seconds from the start of the cue. */
export interface ToneStep {
	/** Seconds from the cue start. */
	at: number;
	/** Pitch offset in cents (a slightly sour second note on failures). */
	detune?: number;
	/** Seconds the tone sounds, envelope included. */
	dur: number;
	freq: number;
	/** Relative loudness, 0..1, before pack, volume and headroom scaling. */
	gain: number;
	glideTime?: number;
	/** Glide the pitch to this frequency over `glideTime`. */
	glideTo?: number;
	/** An overtone oscillator layered on the tone (a bell shimmer). */
	harmonic?: { gain: number; ratio: number };
	wave?: OscillatorType;
}

/** Shorthand for authoring patterns in milliseconds. */
export function tone(
	name: RyuNoteName,
	startMs: number,
	endMs: number,
	gain: number,
	extra: Omit<ToneStep, "at" | "dur" | "freq" | "gain"> = {}
): ToneStep {
	return {
		...extra,
		at: startMs / 1000,
		dur: (endMs - startMs) / 1000,
		freq: note(name),
		gain,
	};
}

/** The end of the last tone, in seconds. */
export function patternDuration(steps: readonly ToneStep[]): number {
	let end = 0;
	for (const step of steps) {
		end = Math.max(end, step.at + step.dur);
	}
	return end;
}
