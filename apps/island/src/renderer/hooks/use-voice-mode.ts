// Island renderer hook for ChatGPT-style voice mode.
//
// The companion analog of the desktop `useVoiceMode`: it opens the Core
// `/api/voice/ws` session via the shared `VoiceSessionConnection`, mirroring the
// server's turn phase + live transcript/captions into React state for the
// voice-mode expanded surface. All realtime logic (VAD, endpointing, barge-in)
// is server-side; this only reflects it.
//
// Distinct from the existing push-to-talk voice INPUT (`use-voice-input.ts` +
// the global shortcut): that stays as-is. This is the separate continuous mode,
// launched from its own dock action.
//
// The island renderer can't hold the Core token, so the WS target (base URL +
// token) is fetched from the main process via `window.island.voice.target()`.

import type { ApiTarget } from "@ryuhq/core-client";
import { VoiceSessionConnection } from "@ryuhq/core-client/voice-session";
import type { VoiceState } from "@ryuhq/protocol/voice";
import { useCallback, useEffect, useRef, useState } from "react";

/** Overlay-facing phase: the server states plus a local `connecting` step. */
export type VoiceModePhase = VoiceState | "connecting";

export interface VoiceModeOptions {
	/** Route turns through the active agent/persona. */
	agentId?: string;
}

export interface VoiceMode {
	/** True while a voice-mode session is open (drives the surface). */
	active: boolean;
	/** The assistant's streaming caption for this turn. */
	caption: string;
	/** A transient error message, if the session hit one. */
	error: string | null;
	/** Manually interrupt the assistant (barge-in via a button). */
	interrupt: () => void;
	/** Rolling mic RMS history, oldest-to-newest, bounded to 24 samples. */
	levels: number[];
	/** Current turn phase. */
	phase: VoiceModePhase;
	/** Open the session + mic. */
	start: () => void;
	/** Close the session + mic. */
	stop: () => void;
	/** The user's latest (final) transcript for this turn. */
	transcript: string;
}

const AUDIO_LEVEL_HISTORY_SIZE = 24;
const SILENT_LEVELS = Array.from({ length: AUDIO_LEVEL_HISTORY_SIZE }, () => 0);

function clampAudioLevel(level: number): number {
	return Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
}

export function useVoiceMode(options: VoiceModeOptions = {}): VoiceMode {
	const [active, setActive] = useState(false);
	const [levels, setLevels] = useState<number[]>(() => SILENT_LEVELS.slice());
	const [phase, setPhase] = useState<VoiceModePhase>("idle");
	const [transcript, setTranscript] = useState("");
	const [caption, setCaption] = useState("");
	const [error, setError] = useState<string | null>(null);
	const levelsRef = useRef<number[]>(SILENT_LEVELS.slice());

	const resetLevels = useCallback(() => {
		const silent = SILENT_LEVELS.slice();
		levelsRef.current = silent;
		setLevels(silent);
	}, []);
	const pushAudioLevel = useCallback((level: number) => {
		const next = levelsRef.current.slice(-(AUDIO_LEVEL_HISTORY_SIZE - 1));
		next.push(clampAudioLevel(level));
		levelsRef.current = next;
		setLevels(next);
	}, []);

	const connRef = useRef<VoiceSessionConnection | null>(null);
	const optionsRef = useRef(options);
	optionsRef.current = options;
	// Bumped on every start/stop so an in-flight target fetch that resolves after a
	// stop (or a restart) knows it's stale and bails instead of opening a session.
	const genRef = useRef(0);

	const stop = useCallback(() => {
		genRef.current += 1;
		connRef.current?.close();
		connRef.current = null;
		setActive(false);
		setPhase("idle");
		resetLevels();
	}, [resetLevels]);

	const start = useCallback(() => {
		if (connRef.current) {
			return;
		}
		const gen = ++genRef.current;
		setError(null);
		setTranscript("");
		setCaption("");
		resetLevels();
		setPhase("connecting");
		setActive(true);

		// Fetch the Core target from main, then open the session.
		window.island.voice
			.target()
			.then((target: ApiTarget) => {
				// A `stop`/restart raced in before the target resolved — abandon this.
				if (genRef.current !== gen) {
					return;
				}
				const conn = new VoiceSessionConnection(target, {
					agentId: optionsRef.current.agentId,
					handlers: {
						onAudioLevel: pushAudioLevel,
						onState: (s) => setPhase(s),
						onSpeechStart: () => {
							// A new user turn — clear the previous turn's text.
							setTranscript("");
							setCaption("");
						},
						onTranscript: (text, final) => {
							if (final) {
								setTranscript(text);
							}
						},
						onDelta: (text) => setCaption((c) => c + text),
						onError: (_code, message) => setError(message),
						onClose: () => {
							connRef.current = null;
							setActive(false);
							setPhase("idle");
							resetLevels();
						},
					},
				});
				connRef.current = conn;
				return conn.start();
			})
			.catch((e) => {
				setError(
					e instanceof Error
						? e.message
						: "Couldn't start voice mode (check microphone permissions)."
				);
				stop();
			});
	}, [pushAudioLevel, resetLevels, stop]);

	const interrupt = useCallback(() => {
		connRef.current?.abort();
	}, []);

	// Tear down if the island unmounts.
	useEffect(() => () => connRef.current?.close(), []);

	return {
		active,
		caption,
		error,
		interrupt,
		levels,
		phase,
		start,
		stop,
		transcript,
	};
}
