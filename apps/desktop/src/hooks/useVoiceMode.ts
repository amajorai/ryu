// Desktop hook for ChatGPT-style voice mode.
//
// A thin React wrapper over the shared `VoiceSessionConnection`
// (@ryuhq/core-client/voice-session): it opens the `/api/voice/ws` session on
// `start`, mirrors the server's turn phase + live transcript/captions into React
// state for the overlay UI, and tears everything down on `stop`. All the realtime
// logic (VAD, endpointing, barge-in) is server-side — this just reflects it.
//
// Distinct from the existing push-to-talk voice INPUT (useVoiceRecorder /
// /api/voice/transcribe): that stays as-is; this is the separate continuous mode.

import { VoiceSessionConnection } from "@ryuhq/core-client/voice-session.ts";
import type { RvpCallEnded, VoiceState } from "@ryuhq/protocol/voice";
import { useCallback, useEffect, useRef, useState } from "react";
import { voiceErrorCopy } from "@/src/components/voice/voice-error-copy.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	playSound,
	setVoiceCallActive,
	startLoopingSound,
} from "@/src/lib/sounds/play-sound.ts";

/** Overlay-facing phase: the server states plus a local `connecting` step. */
export type VoiceModePhase = VoiceState | "connecting";

/** One line of the running voice transcript (chat-style log). */
export interface VoiceTurnLog {
	id: string;
	role: "user" | "assistant";
	text: string;
}

export interface VoiceModeOptions {
	/** Route turns through the active agent/persona. */
	agentId?: string;
	/** Display name shown on the call screen. */
	agentName?: string;
	/** Bind turns to the active conversation (so history persists). */
	conversationId?: string;
	/** Insert Core's saved call summary without sending another agent turn. */
	onCallEnded?: (summary: RvpCallEnded) => void;
	/** Voice Recognition engine (from the shared voice-input preference). */
	sttEngine?: string;
	/** Audio engine + voice (from the user's Audio preferences). */
	ttsEngine?: string;
	ttsVoice?: string;
}

export interface VoiceMode {
	/** True while a voice-mode session is open (drives overlay visibility). */
	active: boolean;
	/** Display name of the agent on the call screen. */
	agentName: string;
	/** The assistant's streaming caption for this turn. */
	caption: string;
	/** Seconds since this voice session started. */
	elapsedSeconds: number;
	/** A transient error message, if the session hit one. */
	error: string | null;
	/** Manually interrupt the assistant (barge-in via a button). */
	interrupt: () => void;
	/** Rolling mic RMS history, oldest-to-newest, bounded to 24 samples. */
	levels: number[];
	/** Whether microphone frames are currently paused. */
	muted: boolean;
	/** Current turn phase. */
	phase: VoiceModePhase;
	/** Open the session + mic. */
	start: () => void;
	/** Close the session + mic. */
	stop: () => void;
	/** Toggle the microphone without ending the call. */
	toggleMute: () => void;
	/** The user's latest (final) transcript for this turn. */
	transcript: string;
	/** The running chat-style transcript of the whole session (both roles). */
	turns: VoiceTurnLog[];
}

const AUDIO_LEVEL_HISTORY_SIZE = 24;
const SILENT_LEVELS = Array.from({ length: AUDIO_LEVEL_HISTORY_SIZE }, () => 0);

function clampAudioLevel(level: number): number {
	return Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
}

export function useVoiceMode(
	target: ApiTarget,
	options: VoiceModeOptions = {}
): VoiceMode {
	const [active, setActive] = useState(false);
	const [elapsedSeconds, setElapsedSeconds] = useState(0);
	const [levels, setLevels] = useState<number[]>(() => SILENT_LEVELS.slice());
	const [phase, setPhase] = useState<VoiceModePhase>("idle");
	const [transcript, setTranscript] = useState("");
	const [caption, setCaption] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [turns, setTurns] = useState<VoiceTurnLog[]>([]);
	const [muted, setMuted] = useState(false);

	// Id of the assistant transcript line currently streaming deltas, or null when
	// the next delta should open a fresh line.
	const assistantIdRef = useRef<string | null>(null);
	// Monotonic id source for transcript lines (avoids Date.now/random churn).
	const turnSeqRef = useRef(0);
	const levelsRef = useRef<number[]>(SILENT_LEVELS.slice());
	const callStartedAtRef = useRef<number | null>(null);
	// Whether THIS instance holds the engine's call-ducking count. The hook is
	// mounted per chat tab and in the composer, so only the instance whose call
	// went live may release it (another tab unmounting must not un-duck).
	const holdsCallDuckRef = useRef(false);
	const setCallDucking = useCallback((live: boolean) => {
		if (holdsCallDuckRef.current === live) {
			return;
		}
		holdsCallDuckRef.current = live;
		setVoiceCallActive(live);
	}, []);
	// Mirrors `muted` so `toggleMute` decides (and cues) outside a state updater,
	// which StrictMode runs twice.
	const mutedRef = useRef(false);

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
	const mountedRef = useRef(true);
	// Keep the latest target/options reachable without re-subscribing handlers.
	const targetRef = useRef(target);
	targetRef.current = target;
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const stop = useCallback(() => {
		// Only a call that connected says goodbye; a never-ready one stays silent.
		const wasLive = callStartedAtRef.current !== null;
		const conn = connRef.current;
		// Detach before closing so its `onClose` sees a hang-up, not a remote end.
		connRef.current = null;
		callStartedAtRef.current = null;
		conn?.close();
		setCallDucking(false);
		if (wasLive) {
			playSound("call-leave");
		}
		setActive(false);
		setElapsedSeconds(0);
		setPhase("idle");
		mutedRef.current = false;
		setMuted(false);
		resetLevels();
	}, [resetLevels, setCallDucking]);

	const start = useCallback(() => {
		if (connRef.current) {
			return;
		}
		setError(null);
		setTranscript("");
		setCaption("");
		setTurns([]);
		setElapsedSeconds(0);
		mutedRef.current = false;
		setMuted(false);
		callStartedAtRef.current = null;
		resetLevels();
		assistantIdRef.current = null;
		turnSeqRef.current = 0;
		setPhase("connecting");
		setActive(true);

		const callOptions = optionsRef.current;
		// One failure cue per attempt: an error frame, the socket closing and
		// `start()` rejecting can all report the same failed connect.
		let failureCued = false;
		const cueConnectFailure = () => {
			if (failureCued || callStartedAtRef.current !== null) {
				return;
			}
			failureCued = true;
			playSound("call-error");
		};
		const conn = new VoiceSessionConnection(targetRef.current, {
			conversationId: optionsRef.current.conversationId,
			agentId: optionsRef.current.agentId,
			sttEngine: optionsRef.current.sttEngine,
			ttsEngine: optionsRef.current.ttsEngine,
			ttsVoice: optionsRef.current.ttsVoice,
			// The Ryu ring replaces the built-in one; muted or disabled sounds give
			// a silent connect rather than falling back to the default ring.
			ringback: () => startLoopingSound("call-ring"),
			handlers: {
				onCallEnded: (summary) => {
					if (mountedRef.current) {
						callOptions.onCallEnded?.(summary);
					}
				},
				onReady: () => {
					if (connRef.current === conn) {
						callStartedAtRef.current = Date.now();
						setCallDucking(true);
						playSound("call-join");
					}
				},
				onAudioLevel: pushAudioLevel,
				onState: (s) => {
					if (connRef.current === conn) {
						setPhase(s);
					}
				},
				onSpeechStart: () => {
					// A new user turn — clear the previous turn's live text and close
					// any still-open assistant line so the next delta starts fresh.
					setTranscript("");
					setCaption("");
					assistantIdRef.current = null;
				},
				onTranscript: (text, final) => {
					if (!final) {
						return;
					}
					setTranscript(text);
					// Log the user's final utterance as a transcript line.
					const trimmed = text.trim();
					if (trimmed.length > 0) {
						assistantIdRef.current = null;
						turnSeqRef.current += 1;
						const id = `u-${turnSeqRef.current}`;
						setTurns((prev) => [...prev, { id, role: "user", text: trimmed }]);
					}
				},
				onDelta: (text) => {
					setCaption((c) => c + text);
					// Stream into the transcript log: append to the open assistant line
					// or open a fresh one. Ref bookkeeping stays outside the updater.
					const openId = assistantIdRef.current;
					if (openId !== null) {
						setTurns((prev) =>
							prev.map((t) =>
								t.id === openId ? { ...t, text: t.text + text } : t
							)
						);
						return;
					}
					turnSeqRef.current += 1;
					const id = `a-${turnSeqRef.current}`;
					assistantIdRef.current = id;
					setTurns((prev) => [...prev, { id, role: "assistant", text }]);
				},
				onChatEnd: () => {
					// The assistant turn is done — the next delta opens a new line.
					assistantIdRef.current = null;
				},
				onError: (code, message) => {
					setError(voiceErrorCopy(code, message));
					if (connRef.current === conn) {
						cueConnectFailure();
					}
				},
				onClose: () => {
					// A hang-up already detached this connection (and cued the leave).
					if (connRef.current !== conn) {
						return;
					}
					if (callStartedAtRef.current === null) {
						cueConnectFailure();
					} else {
						playSound("call-leave");
					}
					connRef.current = null;
					setCallDucking(false);
					setActive(false);
					setElapsedSeconds(0);
					setPhase("idle");
					mutedRef.current = false;
					setMuted(false);
					callStartedAtRef.current = null;
					resetLevels();
				},
			},
		});
		connRef.current = conn;
		conn.start().catch((e) => {
			if (connRef.current !== conn) {
				return;
			}
			cueConnectFailure();
			setError(
				e instanceof Error
					? e.message
					: "Couldn't start voice mode (check microphone permissions)."
			);
			stop();
		});
	}, [pushAudioLevel, resetLevels, setCallDucking, stop]);

	const interrupt = useCallback(() => {
		connRef.current?.abort();
	}, []);

	const toggleMute = useCallback(() => {
		const next = !mutedRef.current;
		mutedRef.current = next;
		connRef.current?.setMuted(next);
		playSound(next ? "mute" : "unmute", { gesture: true });
		if (next) {
			resetLevels();
		}
		setMuted(next);
	}, [resetLevels]);

	useEffect(() => {
		if (!active) {
			return;
		}
		const updateElapsed = () => {
			const startedAt = callStartedAtRef.current;
			setElapsedSeconds(
				startedAt === null ? 0 : Math.floor((Date.now() - startedAt) / 1000)
			);
		};
		updateElapsed();
		const timer = window.setInterval(updateElapsed, 1000);
		return () => window.clearInterval(timer);
	}, [active]);

	// Tear down if the component using voice mode unmounts.
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			connRef.current?.close();
			connRef.current = null;
			setCallDucking(false);
		};
	}, [setCallDucking]);

	return {
		agentName: options.agentName?.trim() || "Ryu",
		active,
		phase,
		elapsedSeconds,
		levels,
		transcript,
		caption,
		error,
		start,
		stop,
		interrupt,
		muted,
		turns,
		toggleMute,
	};
}
