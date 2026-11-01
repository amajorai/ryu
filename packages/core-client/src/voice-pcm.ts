// packages/core-client/src/voice-pcm.ts
//
// Pure PCM helpers for the voice-mode uplink: resample the mic to the server's
// rate, encode PCM16, and turn a capture frame into a UI meter level.

/** Visual gain applied to the mic RMS before it reaches the UI (0..1). */
const AUDIO_LEVEL_GAIN = 5;

/** Downsample mono Float32 PCM to the target rate (linear interpolation). */
export function downsample(
	input: Float32Array,
	inRate: number,
	outRate: number
): Float32Array {
	if (outRate >= inRate) {
		return input;
	}
	const ratio = inRate / outRate;
	const outLength = Math.floor(input.length / ratio);
	const out = new Float32Array(outLength);
	for (let i = 0; i < outLength; i++) {
		const pos = i * ratio;
		const idx = Math.floor(pos);
		const frac = pos - idx;
		const a = input[idx] ?? 0;
		const b = input[idx + 1] ?? a;
		out[i] = a + (b - a) * frac;
	}
	return out;
}

/** Convert mono Float32 (−1..1) to little-endian PCM16 bytes. */
export function floatToPcm16(samples: Float32Array): ArrayBuffer {
	const buffer = new ArrayBuffer(samples.length * 2);
	const view = new DataView(buffer);
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
		view.setInt16(i * 2, s < 0 ? s * 0x80_00 : s * 0x7f_ff, true);
	}
	return buffer;
}

/** Convert one mono Float32 frame into a visual-friendly normalized RMS level. */
export function audioLevel(samples: Float32Array): number {
	let sumSquares = 0;
	for (const sample of samples) {
		sumSquares += sample * sample;
	}
	const rms = Math.sqrt(sumSquares / (samples.length || 1));
	return Math.min(1, rms * AUDIO_LEVEL_GAIN);
}
