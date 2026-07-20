// apps/desktop/src/hooks/useVoiceRecorder.ts
//
// Microphone capture for voice input. Records from the user's chosen default mic
// (lib/audio/devices.ts), drives a live scrolling waveform off an AnalyserNode, and
// on stop encodes 16 kHz mono PCM WAV — the format whisper-server decodes — then
// uploads it to Core (lib/api/voice.ts) and hands back the transcript.
//
// We deliberately capture raw PCM via the Web Audio graph (not MediaRecorder):
// MediaRecorder yields webm/opus in WebView2, which the bundled whisper.cpp build
// does not decode. Building the WAV ourselves also reuses the same audio graph we
// need for the waveform, so there is one capture path, not two.

import { useCallback, useEffect, useRef, useState } from "react";
import { getDefaultMicId } from "@/src/lib/audio/devices.ts";

export type RecorderState = "idle" | "recording" | "transcribing";

/** Number of bars in the scrolling waveform (each is one moment in time). */
const BAR_COUNT = 24;
/** Target sample rate for whisper (it expects 16 kHz mono). */
const TARGET_SAMPLE_RATE = 16_000;
/** Visual gain so normal speech rises to a readable height without clipping. */
const LEVEL_GAIN = 5;
/** How often (ms) a new amplitude sample is pushed — sets the scroll speed. */
const SAMPLE_INTERVAL_MS = 50;

interface UseVoiceRecorderOptions {
	/** Called with the transcribed text once a recording finishes. */
	onTranscript: (text: string) => void;
	/** Uploads the recorded WAV and resolves with the transcribed text. */
	transcribe: (audio: Blob) => Promise<string>;
}

interface UseVoiceRecorder {
	cancel: () => void;
	error: string | null;
	/** Amplitude history (0..1), oldest-to-newest, updated live while recording. */
	levels: number[];
	start: () => Promise<void>;
	state: RecorderState;
	stop: () => void;
}

const SILENT_LEVELS = new Array<number>(BAR_COUNT).fill(0);

/** RMS loudness (0..1) of one time-domain frame — a single point on the timeline. */
function computeAmplitude(data: Uint8Array): number {
	let sumSquares = 0;
	for (let i = 0; i < data.length; i++) {
		// getByteTimeDomainData is centered at 128; map to -1..1.
		const v = (data[i] - 128) / 128;
		sumSquares += v * v;
	}
	const rms = Math.sqrt(sumSquares / (data.length || 1));
	return Math.min(1, rms * LEVEL_GAIN);
}

/** Linear-interpolation downsample of mono PCM to the target rate. */
function downsample(
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

/** Encode mono Float32 PCM as a 16-bit WAV blob. */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
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

	return new Blob([buffer], { type: "audio/wav" });
}

export function useVoiceRecorder({
	transcribe,
	onTranscript,
}: UseVoiceRecorderOptions): UseVoiceRecorder {
	const [state, setState] = useState<RecorderState>("idle");
	const [levels, setLevels] = useState<number[]>(SILENT_LEVELS);
	const [error, setError] = useState<string | null>(null);

	const streamRef = useRef<MediaStream | null>(null);
	const ctxRef = useRef<AudioContext | null>(null);
	const analyserRef = useRef<AnalyserNode | null>(null);
	const processorRef = useRef<ScriptProcessorNode | null>(null);
	const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
	const chunksRef = useRef<Float32Array[]>([]);
	const rafRef = useRef<number | null>(null);
	// Keep the latest callbacks reachable without re-creating start/stop.
	const onTranscriptRef = useRef(onTranscript);
	onTranscriptRef.current = onTranscript;
	const transcribeRef = useRef(transcribe);
	transcribeRef.current = transcribe;

	/** Tear down the audio graph and release the mic. */
	const teardown = useCallback((): {
		samples: Float32Array;
		rate: number;
	} | null => {
		if (rafRef.current !== null) {
			cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
		}
		const ctx = ctxRef.current;
		const rate = ctx?.sampleRate ?? TARGET_SAMPLE_RATE;

		processorRef.current?.disconnect();
		analyserRef.current?.disconnect();
		sourceRef.current?.disconnect();
		processorRef.current = null;
		analyserRef.current = null;
		sourceRef.current = null;

		for (const track of streamRef.current?.getTracks() ?? []) {
			track.stop();
		}
		streamRef.current = null;

		if (ctx && ctx.state !== "closed") {
			ctx.close().catch(() => undefined);
		}
		ctxRef.current = null;
		setLevels(SILENT_LEVELS);

		const chunks = chunksRef.current;
		chunksRef.current = [];
		if (chunks.length === 0) {
			return null;
		}
		const total = chunks.reduce((n, c) => n + c.length, 0);
		const merged = new Float32Array(total);
		let offset = 0;
		for (const c of chunks) {
			merged.set(c, offset);
			offset += c.length;
		}
		return { samples: merged, rate };
	}, []);

	const start = useCallback(async () => {
		setError(null);
		if (!navigator.mediaDevices?.getUserMedia) {
			setError("Microphone is not available in this environment.");
			return;
		}
		try {
			const micId = getDefaultMicId();
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: micId ? { deviceId: { exact: micId } } : true,
			});
			streamRef.current = stream;

			const ctx = new AudioContext();
			ctxRef.current = ctx;
			const source = ctx.createMediaStreamSource(stream);
			sourceRef.current = source;

			const analyser = ctx.createAnalyser();
			analyser.fftSize = 256;
			analyserRef.current = analyser;

			const processor = ctx.createScriptProcessor(4096, 1, 1);
			processorRef.current = processor;
			chunksRef.current = [];
			processor.onaudioprocess = (e) => {
				// Copy — the underlying buffer is reused across callbacks.
				chunksRef.current.push(
					new Float32Array(e.inputBuffer.getChannelData(0))
				);
			};

			source.connect(analyser);
			source.connect(processor);
			// ScriptProcessor only fires while connected to a destination.
			processor.connect(ctx.destination);

			// Scrolling timeline: sample loudness on a fixed cadence and push it into
			// a rolling history (newest on the right, oldest dropped on the left) so
			// the bars flow across the timeline rather than tracking the spectrum.
			const time = new Uint8Array(analyser.fftSize);
			const history = SILENT_LEVELS.slice();
			let lastSample = performance.now();
			const tick = () => {
				const a = analyserRef.current;
				if (!a) {
					return;
				}
				a.getByteTimeDomainData(time);
				const now = performance.now();
				if (now - lastSample >= SAMPLE_INTERVAL_MS) {
					lastSample = now;
					history.push(computeAmplitude(time));
					history.shift();
					setLevels(history.slice());
				}
				rafRef.current = requestAnimationFrame(tick);
			};
			rafRef.current = requestAnimationFrame(tick);

			setState("recording");
		} catch {
			teardown();
			setState("idle");
			setError(
				"Could not access the microphone. Check the selected device and OS permissions."
			);
		}
	}, [teardown]);

	const stop = useCallback(() => {
		if (state !== "recording") {
			return;
		}
		const captured = teardown();
		if (!captured || captured.samples.length === 0) {
			setState("idle");
			return;
		}
		setState("transcribing");
		const pcm = downsample(captured.samples, captured.rate, TARGET_SAMPLE_RATE);
		const wav = encodeWav(pcm, TARGET_SAMPLE_RATE);
		transcribeRef
			.current(wav)
			.then((text) => {
				if (text) {
					onTranscriptRef.current(text);
				}
			})
			.catch((e: unknown) => {
				setError(e instanceof Error ? e.message : "Transcription failed.");
			})
			.finally(() => {
				setState("idle");
			});
	}, [state, teardown]);

	const cancel = useCallback(() => {
		teardown();
		setState("idle");
		setError(null);
	}, [teardown]);

	// Release the mic if the component unmounts mid-recording.
	useEffect(() => {
		return () => {
			teardown();
		};
	}, [teardown]);

	return { state, levels, error, start, stop, cancel };
}
