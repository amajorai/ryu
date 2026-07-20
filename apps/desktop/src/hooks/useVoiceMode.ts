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

import { VoiceSessionConnection } from "@ryuhq/core-client/voice-session";
import type { VoiceState } from "@ryuhq/protocol/voice";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";

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
	/** Bind turns to the active conversation (so history persists). */
	conversationId?: string;
	/** TTS engine + voice (from the user's TTS prefs). */
	ttsEngine?: string;
	ttsVoice?: string;
}

export interface VoiceMode {
	/** True while a voice-mode session is open (drives overlay visibility). */
	active: boolean;
	/** The assistant's streaming caption for this turn. */
	caption: string;
	/** A transient error message, if the session hit one. */
	error: string | null;
	/** Manually interrupt the assistant (barge-in via a button). */
	interrupt: () => void;
	/** Current turn phase. */
	phase: VoiceModePhase;
	/** Open the session + mic. */
	start: () => void;
	/** Close the session + mic. */
	stop: () => void;
	/** The user's latest (final) transcript for this turn. */
	transcript: string;
	/** The running chat-style transcript of the whole session (both roles). */
	turns: VoiceTurnLog[];
}

export function useVoiceMode(
	target: ApiTarget,
	options: VoiceModeOptions = {}
): VoiceMode {
	const [active, setActive] = useState(false);
	const [phase, setPhase] = useState<VoiceModePhase>("idle");
	const [transcript, setTranscript] = useState("");
	const [caption, setCaption] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [turns, setTurns] = useState<VoiceTurnLog[]>([]);

	// Id of the assistant transcript line currently streaming deltas, or null when
	// the next delta should open a fresh line.
	const assistantIdRef = useRef<string | null>(null);
	// Monotonic id source for transcript lines (avoids Date.now/random churn).
	const turnSeqRef = useRef(0);

	const connRef = useRef<VoiceSessionConnection | null>(null);
	// Keep the latest target/options reachable without re-subscribing handlers.
	const targetRef = useRef(target);
	targetRef.current = target;
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const stop = useCallback(() => {
		connRef.current?.close();
		connRef.current = null;
		setActive(false);
		setPhase("idle");
	}, []);

	const start = useCallback(() => {
		if (connRef.current) {
			return;
		}
		setError(null);
		setTranscript("");
		setCaption("");
		setTurns([]);
		assistantIdRef.current = null;
		turnSeqRef.current = 0;
		setPhase("connecting");
		setActive(true);

		const conn = new VoiceSessionConnection(targetRef.current, {
			conversationId: optionsRef.current.conversationId,
			agentId: optionsRef.current.agentId,
			ttsEngine: optionsRef.current.ttsEngine,
			ttsVoice: optionsRef.current.ttsVoice,
			handlers: {
				onState: (s) => setPhase(s),
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
				onError: (_code, message) => setError(message),
				onClose: () => {
					connRef.current = null;
					setActive(false);
					setPhase("idle");
				},
			},
		});
		connRef.current = conn;
		conn.start().catch((e: unknown) => {
			setError(
				e instanceof Error
					? e.message
					: "Couldn't start voice mode (check microphone permissions)."
			);
			stop();
		});
	}, [stop]);

	const interrupt = useCallback(() => {
		connRef.current?.abort();
	}, []);

	// Tear down if the component using voice mode unmounts.
	useEffect(() => () => connRef.current?.close(), []);

	return {
		active,
		phase,
		transcript,
		caption,
		error,
		start,
		stop,
		interrupt,
		turns,
	};
}
