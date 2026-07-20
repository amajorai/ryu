// Push-to-talk voice capture for the island companion.
//
// Listens for the global shortcut (forwarded by the main process on
// `voice:toggle`): the first press starts recording, the second stops it. While
// recording it drives a live scrolling waveform off an AnalyserNode and, on stop,
// encodes 16 kHz mono PCM WAV — the format whisper-server decodes — ships the
// bytes to the main process (which posts them to Core's transcribe endpoint with
// the configured engine), and drops the transcript into the island chat.
//
// We capture raw PCM via the Web Audio graph (not MediaRecorder): MediaRecorder
// yields webm/opus, which the bundled whisper.cpp build does not decode. Building
// the WAV ourselves also reuses the same graph that powers the waveform.

import { useCallback, useEffect, useRef, useState } from "react";
import { parseVoicePrefs, type VoiceInputPrefs } from "../../shared/voice.ts";
import { useIslandState } from "../store/island-state.ts";

/** Number of bars in the scrolling waveform (each is one moment in time). */
const BAR_COUNT = 24;
/** Target sample rate for whisper (it expects 16 kHz mono). */
const TARGET_SAMPLE_RATE = 16_000;
/** Visual gain so normal speech rises to a readable height without clipping. */
const LEVEL_GAIN = 5;
/** How often (ms) a new amplitude sample is pushed — sets the scroll speed. */
const SAMPLE_INTERVAL_MS = 50;

const SILENT_LEVELS = new Array<number>(BAR_COUNT).fill(0);

/** Sidecar name (for `sidecarStart`) per transcription engine. */
const ENGINE_SIDECARS: Record<string, string> = {
	whisper: "whispercpp",
	parakeet: "parakeet",
};

/** How long a transient error message stays on the pill before collapsing. */
const ERROR_DISPLAY_MS = 4000;

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

/** Encode mono Float32 PCM as a 16-bit WAV ArrayBuffer. */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
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

interface UseVoiceInput {
	/** Transient error to show on the recording pill (mic/engine/transcribe). */
	error: string | null;
	/** Amplitude history (0..1), oldest-to-newest, updated live while recording. */
	levels: number[];
	/** True while capturing audio. */
	recording: boolean;
	/**
	 * Start capture if idle, stop + transcribe if recording — the same toggle the
	 * push-to-talk shortcut fires. Exposed so the mic action island can drive voice
	 * mode by tap as well as by hotkey.
	 */
	toggle: () => void;
}

/**
 * Wire the push-to-talk shortcut to mic capture + transcription. Returns the live
 * waveform levels and recording flag for the recording-state UI. Drives the
 * island state machine: `recording` while listening, then `expanded` (with the
 * transcript prefilled) once transcription returns.
 */
export function useVoiceInput(): UseVoiceInput {
	const [recording, setRecording] = useState(false);
	const [levels, setLevels] = useState<number[]>(SILENT_LEVELS);
	const [error, setError] = useState<string | null>(null);
	const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const setIslandState = useIslandState((s) => s.setState);
	const openChatWithPrefill = useIslandState((s) => s.openChatWithPrefill);
	// Keep store actions reachable from event handlers without re-subscribing.
	const setIslandStateRef = useRef(setIslandState);
	setIslandStateRef.current = setIslandState;
	const openChatWithPrefillRef = useRef(openChatWithPrefill);
	openChatWithPrefillRef.current = openChatWithPrefill;

	const prefsRef = useRef<VoiceInputPrefs | null>(null);
	const recordingRef = useRef(false);

	const streamRef = useRef<MediaStream | null>(null);
	const ctxRef = useRef<AudioContext | null>(null);
	const analyserRef = useRef<AnalyserNode | null>(null);
	const processorRef = useRef<ScriptProcessorNode | null>(null);
	const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
	const chunksRef = useRef<Float32Array[]>([]);
	const rafRef = useRef<number | null>(null);

	// Load the voice prefs and keep them current (engine choice etc.).
	useEffect(() => {
		let cancelled = false;
		window.island.voice.get().then((raw) => {
			if (!cancelled) {
				prefsRef.current = parseVoicePrefs(raw);
			}
		});
		const off = window.island.voice.onChanged((raw) => {
			prefsRef.current = parseVoicePrefs(raw);
		});
		return () => {
			cancelled = true;
			off();
		};
	}, []);

	/** Tear down the audio graph and return the captured mono PCM, if any. */
	const teardown = useCallback((): {
		rate: number;
		samples: Float32Array;
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

	/** Clear any pending error + its auto-collapse timer. */
	const clearError = useCallback((): void => {
		if (errorTimerRef.current) {
			clearTimeout(errorTimerRef.current);
			errorTimerRef.current = null;
		}
		setError(null);
	}, []);

	/**
	 * Show a transient error on the recording pill, then fold the island back to
	 * its resting state. Used for every failure path (mic denied, engine not
	 * running, empty/failed transcription) so a miss is never silent.
	 */
	const flashError = useCallback((message: string): void => {
		setError(message);
		setIslandStateRef.current("recording");
		if (errorTimerRef.current) {
			clearTimeout(errorTimerRef.current);
		}
		errorTimerRef.current = setTimeout(() => {
			errorTimerRef.current = null;
			setError(null);
			if (!recordingRef.current) {
				setIslandStateRef.current("collapsed");
			}
		}, ERROR_DISPLAY_MS);
	}, []);

	const startRecording = useCallback(async (): Promise<void> => {
		if (recordingRef.current || !navigator.mediaDevices?.getUserMedia) {
			return;
		}
		clearError();
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
				chunksRef.current.push(
					new Float32Array(e.inputBuffer.getChannelData(0))
				);
			};

			source.connect(analyser);
			source.connect(processor);
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

			recordingRef.current = true;
			setRecording(true);
			setIslandStateRef.current("recording");
		} catch {
			teardown();
			recordingRef.current = false;
			setRecording(false);
			flashError("Couldn't access the microphone. Check OS permissions.");
		}
	}, [teardown, clearError, flashError]);

	const stopRecording = useCallback((): void => {
		if (!recordingRef.current) {
			return;
		}
		recordingRef.current = false;
		setRecording(false);
		const captured = teardown();
		if (!captured || captured.samples.length === 0) {
			flashError("Didn't catch any audio.");
			return;
		}
		const pcm = downsample(captured.samples, captured.rate, TARGET_SAMPLE_RATE);
		const wav = encodeWav(pcm, TARGET_SAMPLE_RATE);
		const engine = prefsRef.current?.engine ?? "whisper";
		window.island.core
			.transcribe(wav, engine)
			.then((result) => {
				if (result.available) {
					const text = result.text.trim();
					if (text.length > 0) {
						clearError();
						openChatWithPrefillRef.current(text);
					} else {
						flashError("Didn't catch that — try again.");
					}
					return;
				}
				// The engine sidecar likely isn't running (voice engines are opt-in
				// to start). Kick it off so the next attempt works, and say so.
				const sidecar = ENGINE_SIDECARS[engine];
				if (sidecar) {
					window.island.core.sidecarStart(sidecar).catch(() => {
						// Best-effort; the error message already tells the user to retry.
					});
				}
				flashError("Voice engine wasn't running — starting it, try again.");
			})
			.catch(() => {
				flashError("Transcription failed.");
			});
	}, [teardown, clearError, flashError]);

	// Start when idle, stop when recording — shared by the hotkey and the mic
	// action island so both drive the exact same capture path.
	const toggle = useCallback((): void => {
		if (recordingRef.current) {
			stopRecording();
		} else {
			startRecording().catch(() => undefined);
		}
	}, [startRecording, stopRecording]);

	// Wire the three activation signals from the main process:
	//  - toggle: the shortcut press toggles capture (toggle mode — same key starts
	//    then stops).
	//  - start/stop: push-to-talk key-down / key-release (hold-to-talk mode), where
	//    the release is seen through the main process's global key hook.
	useEffect(() => {
		const offToggle = window.island.voice.onToggle(toggle);
		const offStart = window.island.voice.onStart(() => {
			startRecording().catch(() => undefined);
		});
		const offStop = window.island.voice.onStop(stopRecording);
		return () => {
			offToggle();
			offStart();
			offStop();
			teardown();
		};
	}, [toggle, startRecording, stopRecording, teardown]);

	// Mirror capture state to the main process so it arms the global key hook
	// (hold-to-talk release + Tab agent-cycling) only while recording.
	useEffect(() => {
		window.island.voice.setRecording(recording);
	}, [recording]);

	// Clear the error auto-collapse timer on unmount.
	useEffect(
		() => () => {
			if (errorTimerRef.current) {
				clearTimeout(errorTimerRef.current);
			}
		},
		[]
	);

	return { error, levels, recording, toggle };
}
