// Shared PCM → WAV helpers for renderer audio capture.
//
// Both push-to-talk voice input and system-wide dictation capture raw Float32 PCM
// via the Web Audio graph (not MediaRecorder, whose webm/opus the bundled
// whisper.cpp cannot decode) and ship a 16 kHz mono 16-bit WAV — the exact format
// Core's `/api/voice/transcribe` expects. These pure functions do the downsample
// and WAV encode; the capture graph itself stays in each hook.

/** Target sample rate for transcription (whisper/parakeet expect 16 kHz mono). */
export const TARGET_SAMPLE_RATE = 16_000;

/** Linear-interpolation downsample of mono PCM to the target rate. */
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

/** Encode mono Float32 PCM as a 16-bit WAV ArrayBuffer. */
export function encodeWav(
	samples: Float32Array,
	sampleRate: number
): ArrayBuffer {
	const buffer = new ArrayBuffer(44 + samples.length * 2);
	const view = new DataView(buffer);

	const writeStr = (offset: number, str: string) => {
		for (let i = 0; i < str.length; i++) {
			view.setUint8(offset + i, str.charCodeAt(i));
		}
	};

	writeStr(0, "RIFF");
	view.setUint32(4, 36 + samples.length * 2, true);
	writeStr(8, "WAVE");
	writeStr(12, "fmt ");
	view.setUint32(16, 16, true); // PCM chunk size
	view.setUint16(20, 1, true); // PCM format
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	writeStr(36, "data");
	view.setUint32(40, samples.length * 2, true);

	let offset = 44;
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(offset, s < 0 ? s * 0x80_00 : s * 0x7f_ff, true);
		offset += 2;
	}

	return buffer;
}
