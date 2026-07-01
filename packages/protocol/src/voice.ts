// Realtime Voice-Mode Protocol (RVP) — TS mirror of the wire contract.
//
// The client-side counterpart of the Rust `crate::voice::protocol`
// (apps/core/src/voice/protocol.rs) served at `GET /api/voice/ws`. Hand-written
// TypeScript types + tiny narrowing guards — no zod, no runtime deps — matching
// the style of `./hardware.ts`. Keep in lockstep with the Rust source.
//
// Audio itself rides out-of-band as BINARY frames (not modeled here):
//   - uplink:   raw PCM16 mono (client resamples to 16 kHz)
//   - downlink: WAV, one BINARY frame per synthesized sentence
//
// New message types: add the interface + extend the union here AND mirror in
// apps/core/src/voice/protocol.rs.

// ── Enums ────────────────────────────────────────────────────────────────────

/** The assistant's turn phase; drives the voice-mode UI (orb/waveform/spinner). */
export type VoiceState = "idle" | "listening" | "thinking" | "speaking";

// ── Client -> Server ───────────────────────────────────────────────────────────

/** First frame on connect: opens the voice session + its config. */
export interface RvpStart {
	/** Route turns through a specific agent/persona. */
	agent_id?: string;
	/** Bind turns to an existing conversation, or omit for an ephemeral session. */
	conversation_id?: string;
	/** Sample rate (Hz) of the PCM16 BINARY frames the client will stream. */
	sample_rate: number;
	/** STT engine hint (`"whisper"` default | `"parakeet"`). */
	stt_engine?: string;
	/** TTS engine hint (`"outetts"` | a RyuTTS engine id). */
	tts_engine?: string;
	/** TTS voice id (engine-specific). */
	tts_voice?: string;
	type: "start";
}

/** Typed text input (fallback path); runs a turn without STT. */
export interface RvpText {
	content: string;
	type: "text";
}

/** Manual barge-in / stop button: abort the in-flight turn + TTS now. */
export interface RvpAbort {
	type: "abort";
}

/** Liveness probe. */
export interface RvpPing {
	type: "ping";
}

/** Every control message the client sends (audio rides out-of-band as binary). */
export type VoiceClientMsg = RvpStart | RvpText | RvpAbort | RvpPing;

export type VoiceClientMsgType = VoiceClientMsg["type"];

// ── Server -> Client ───────────────────────────────────────────────────────────

/** Acknowledges `start`; carries the session id + TTS downlink rate. */
export interface RvpReady {
	session_id: string;
	tts_sample_rate: number;
	type: "ready";
}

/** Turn-phase change; drives the voice-mode UI. */
export interface RvpStateMsg {
	type: "state";
	value: VoiceState;
}

/** VAD detected the user's speech onset (also the barge-in precursor). */
export interface RvpSpeechStart {
	type: "speech_start";
}

/** Live/partial or final transcript of the user's speech. */
export interface RvpStt {
	final: boolean;
	text: string;
	type: "stt";
}

/** One streamed assistant-text chunk (per-token, for live captions). */
export interface RvpChatDelta {
	text: string;
	type: "chat_delta";
}

/** End of the streamed assistant turn. */
export interface RvpChatEnd {
	conversation_id: string;
	type: "chat_end";
}

/** Barge-in: drop any queued/playing TTS audio immediately. */
export interface RvpStopPlayback {
	type: "stop_playback";
}

/** TTS audio is about to stream as BINARY WAV frames. */
export interface RvpTtsStart {
	type: "tts_start";
}

/** End of the TTS audio stream for this turn. */
export interface RvpTtsEnd {
	type: "tts_end";
}

/** Protocol or processing error. */
export interface RvpError {
	code: string;
	message: string;
	type: "error";
}

/** Liveness response. */
export interface RvpPong {
	type: "pong";
}

/** Every control message the server sends (audio rides out-of-band as binary). */
export type VoiceServerMsg =
	| RvpReady
	| RvpStateMsg
	| RvpSpeechStart
	| RvpStt
	| RvpChatDelta
	| RvpChatEnd
	| RvpStopPlayback
	| RvpTtsStart
	| RvpTtsEnd
	| RvpError
	| RvpPong;

export type VoiceServerMsgType = VoiceServerMsg["type"];

/** Narrowing guard: parse an inbound text frame to a typed server message. */
export function parseVoiceServerMsg(raw: string): VoiceServerMsg | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const type = (value as { type?: unknown }).type;
	return typeof type === "string" ? (value as VoiceServerMsg) : null;
}
