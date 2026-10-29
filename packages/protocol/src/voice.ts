import { z } from "zod";

// Realtime Voice-Mode Protocol (RVP) — TS mirror of the wire contract.
//
// The client-side counterpart of the Rust `crate::voice::protocol`
// (apps/core/src/voice/protocol.rs) served at `GET /api/voice/ws`. Hand-written
// TypeScript contracts and native boundary codecs. Keep the complete message
// schemas in lockstep with the Rust source.
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
	/**
	 * Only `false` changes anything: Core then runs the session under its
	 * restricted tool profile for an unverified caller. Omit it (or send `true`)
	 * for the owner's own session; the field can only restrict, never widen.
	 * The Gateway sends `false` for phone callers a line does not list.
	 */
	caller_trusted?: boolean;
	/** Bind turns to an existing conversation, or omit for an ephemeral session. */
	conversation_id?: string;
	/** Sample rate (Hz) of the PCM16 BINARY frames the client will stream. */
	sample_rate: number;
	/** STT engine hint (`"whisper"` | `"audiocpp"` | `"parakeet"`). */
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

/** Internal post-call summary request; it produces text without TTS audio. */
export interface RvpSummary {
	type: "summary";
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
export type VoiceClientMsg =
	| RvpStart
	| RvpText
	| RvpSummary
	| RvpAbort
	| RvpPing
	| { type: "end" };

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

/** A persisted user-side call summary. Sent before the socket closes. */
export interface RvpCallEnded {
	content: string;
	conversationId: string;
	durationSeconds: number;
	messageId: string;
	type: "call_ended";
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
	| RvpCallEnded
	| RvpStopPlayback
	| RvpTtsStart
	| RvpTtsEnd
	| RvpError
	| RvpPong;

export type VoiceServerMsgType = VoiceServerMsg["type"];

const callEndedSchema = z.object({
	type: z.literal("call_ended"),
	content: z.string(),
	conversationId: z.string(),
	messageId: z.string(),
	durationSeconds: z.number().int().min(0),
});
const controlEnvelopeSchema = z.looseObject({ type: z.string() });
/** A transport envelope may contain a future message type, without claiming its payload. */
export type VoiceControlEnvelope = z.infer<typeof controlEnvelopeSchema>;
const admittedEnvelopeSchema = z.custom<VoiceControlEnvelope>((value) => {
	const result = controlEnvelopeSchema.safeParse(value);
	return (
		result.success &&
		(result.data.type !== "call_ended" ||
			callEndedSchema.safeParse(value).success)
	);
});
/** Validate the complete payload before dispatching a supported server message. */
const supportedMessagesSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("ready"),
		session_id: z.string(),
		tts_sample_rate: z.number(),
	}),
	z.object({
		type: z.literal("state"),
		value: z.enum(["idle", "listening", "thinking", "speaking"]),
	}),
	z.object({ type: z.literal("speech_start") }),
	z.object({ type: z.literal("stt"), text: z.string(), final: z.boolean() }),
	z.object({ type: z.literal("chat_delta"), text: z.string() }),
	z.object({ type: z.literal("chat_end"), conversation_id: z.string() }),
	callEndedSchema,
	z.object({ type: z.literal("stop_playback") }),
	z.object({ type: z.literal("tts_start") }),
	z.object({ type: z.literal("tts_end") }),
	z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
	z.object({ type: z.literal("pong") }),
]);
/** Preserve native JSON metadata and field order after full payload validation. */
export const voiceServerMsgSchema = z.custom<
	z.infer<typeof supportedMessagesSchema>
>((value) => supportedMessagesSchema.safeParse(value).success);
/** Preserve incoming control envelopes, including future types and native JSON metadata. */
export function parseVoiceServerMsg(raw: string) {
	try {
		const result = admittedEnvelopeSchema.safeParse(JSON.parse(raw));
		return result.success ? result.data : null;
	} catch {
		return null;
	}
}
