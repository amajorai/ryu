// System-wide dictation capture for the island companion.
//
// Distinct from `use-voice-input.ts`: that hook drops the transcript into the
// island chat to run an agent. This one captures on a SEPARATE global shortcut and
// hands the WAV to the main process, which transcribes, optionally post-processes,
// and types/pastes the text into whatever native app currently has OS focus. It
// therefore never opens chat and never steals focus.
//
// Capture mirrors the voice hook: raw Float32 PCM via the Web Audio graph (not
// MediaRecorder), downsampled to 16 kHz mono and encoded as WAV — the format
// Core's transcribe endpoint expects. The shared encode helpers live in
// `renderer/lib/wav.ts`.

import { useCallback, useEffect, useRef } from "react";
import {
	DEFAULT_DICTATION_PREFS,
	parseDictationPrefs,
} from "../../shared/dictation.ts";
import { downsample, encodeWav, TARGET_SAMPLE_RATE } from "../lib/wav.ts";
import { useIslandState } from "../store/island-state.ts";

/** Sidecar name (for `sidecarStart`) per transcription engine. */
const ENGINE_SIDECARS: Record<string, string> = {
	whisper: "whispercpp",
	parakeet: "parakeet",
};

/**
 * Wire the dictation shortcut to mic capture + insertion. The renderer only
 * captures; the main process runs transcription and inserts the text into the
 * focused app. Returns nothing — dictation has no in-island UI beyond a brief
 * recording indicator on the pill.
 */
export function useDictation(): void {
	const setIslandState = useIslandState((s) => s.setState);
	const setIslandStateRef = useRef(setIslandState);
	setIslandStateRef.current = setIslandState;

	const engineRef = useRef<string>(DEFAULT_DICTATION_PREFS.engine);
	const recordingRef = useRef(false);

	const streamRef = useRef<MediaStream | null>(null);
	const ctxRef = useRef<AudioContext | null>(null);
	const processorRef = useRef<ScriptProcessorNode | null>(null);
	const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
	const chunksRef = useRef<Float32Array[]>([]);

	// Track the dictation engine from the shared preference so a captured turn is
	// transcribed with the configured engine (parsing stays in the main process for
	// the pipeline; here we only need the engine name for the cold-start recovery).
	useEffect(() => {
		let cancelled = false;
		window.island.dictation.get().then((raw) => {
			if (!cancelled) {
				engineRef.current = parseDictationPrefs(raw).engine;
			}
		});
		const off = window.island.dictation.onChanged((raw) => {
			engineRef.current = parseDictationPrefs(raw).engine;
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
		const ctx = ctxRef.current;
		const rate = ctx?.sampleRate ?? TARGET_SAMPLE_RATE;

		processorRef.current?.disconnect();
		sourceRef.current?.disconnect();
		processorRef.current = null;
		sourceRef.current = null;

		for (const track of streamRef.current?.getTracks() ?? []) {
			track.stop();
		}
		streamRef.current = null;

		if (ctx && ctx.state !== "closed") {
			ctx.close().catch(() => undefined);
		}
		ctxRef.current = null;

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

	const startRecording = useCallback(async (): Promise<void> => {
		if (recordingRef.current || !navigator.mediaDevices?.getUserMedia) {
			return;
		}
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			streamRef.current = stream;

			const ctx = new AudioContext();
			ctxRef.current = ctx;
			const source = ctx.createMediaStreamSource(stream);
			sourceRef.current = source;

			const processor = ctx.createScriptProcessor(4096, 1, 1);
			processorRef.current = processor;
			chunksRef.current = [];
			processor.onaudioprocess = (e) => {
				chunksRef.current.push(
					new Float32Array(e.inputBuffer.getChannelData(0))
				);
			};

			source.connect(processor);
			processor.connect(ctx.destination);

			recordingRef.current = true;
			window.island.dictation.setRecording(true);
			// A brief recording indicator on the pill; dictation has no other UI.
			setIslandStateRef.current("recording");
		} catch {
			teardown();
			recordingRef.current = false;
			window.island.dictation.setRecording(false);
		}
	}, [teardown]);

	const stopRecording = useCallback((): void => {
		if (!recordingRef.current) {
			return;
		}
		recordingRef.current = false;
		window.island.dictation.setRecording(false);
		setIslandStateRef.current("collapsed");
		const captured = teardown();
		if (!captured || captured.samples.length === 0) {
			return;
		}
		const pcm = downsample(captured.samples, captured.rate, TARGET_SAMPLE_RATE);
		const wav = encodeWav(pcm, TARGET_SAMPLE_RATE);
		window.island.dictation
			.submit(wav)
			.then((result) => {
				if (result.ok) {
					return;
				}
				// The engine sidecar likely isn't running (voice engines are opt-in to
				// start). Kick it off so the next attempt works.
				const sidecar = ENGINE_SIDECARS[engineRef.current];
				if (sidecar) {
					window.island.core.sidecarStart(sidecar).catch(() => {
						// Best-effort cold start; the next dictation will transcribe.
					});
				}
			})
			.catch(() => {
				// `submit` never rejects; guard anyway.
			});
	}, [teardown]);

	const toggle = useCallback((): void => {
		if (recordingRef.current) {
			stopRecording();
		} else {
			startRecording().catch(() => undefined);
		}
	}, [startRecording, stopRecording]);

	// Wire the three activation signals from the main process (mirrors voice input):
	//  - toggle: shortcut press toggles capture (toggle mode).
	//  - start/stop: push-to-talk key-down / key-release (hold-to-talk mode), where
	//    the release is seen through the main process's global key hook.
	useEffect(() => {
		const offToggle = window.island.dictation.onToggle(toggle);
		const offStart = window.island.dictation.onStart(() => {
			startRecording().catch(() => undefined);
		});
		const offStop = window.island.dictation.onStop(stopRecording);
		return () => {
			offToggle();
			offStart();
			offStop();
			teardown();
		};
	}, [toggle, startRecording, stopRecording, teardown]);
}
