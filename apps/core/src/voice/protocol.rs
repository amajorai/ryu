//! Realtime Voice-Mode Protocol (RVP) — the wire contract for the ChatGPT-style
//! desktop/island voice mode (`/api/voice/ws`).
//!
//! This is a LEAN sibling of the Ryu Hardware Protocol (`ryu_hardware::protocol`):
//! same tagged-union style (`#[serde(tag = "type", rename_all = "snake_case")]`),
//! but with none of the device baggage (no camera/telemetry/ambient/pairing) because
//! the peer is a first-party renderer over loopback, not an ESP32.
//!
//! Unlike the hardware link (which speaks Opus so a battery device saves bandwidth),
//! voice mode runs over loopback, so audio is uncompressed:
//!   - **Uplink** mic: raw PCM16 mono BINARY frames (the client resamples to 16 kHz).
//!   - **Downlink** TTS: WAV BINARY frames, one per synthesized sentence
//!     (self-describing, so the client can `decodeAudioData` each without a codec).
//!
//! Keep this in lockstep with the TS mirror `packages/protocol/src/voice.ts`.

use serde::{Deserialize, Serialize};

/// The assistant's turn phase, mirrored to the client so it can drive the voice-mode
/// UI (orb / waveform / spinner). Wire: `idle` | `listening` | `thinking` | `speaking`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceState {
    /// No active turn; mic open, waiting for speech.
    Idle,
    /// The user is speaking (VAD detected onset); capturing the utterance.
    Listening,
    /// End-of-turn detected; running STT + the model turn.
    Thinking,
    /// Streaming the spoken reply.
    Speaking,
}

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

/// Every control message the renderer sends, tagged on `type`. Audio itself rides
/// out-of-band as BINARY PCM16 frames (not modeled here).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VoiceClientMsg {
    /// First frame on connect: opens the voice session and its config.
    Start {
        /// Bind the turns to an existing conversation (so history persists), or
        /// `None` for an ephemeral voice session.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        conversation_id: Option<String>,
        /// Sample rate (Hz) of the PCM16 BINARY frames the client will stream. The
        /// server resamples to 16 kHz for VAD + STT when this differs.
        sample_rate: u32,
        /// Route turns through a specific agent/persona; `None` = the default path.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<String>,
        /// STT engine hint (`"parakeet"` default | `"whisper"`); `None` uses the
        /// cross-surface default from `server::voice::default_stt_engine`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stt_engine: Option<String>,
        /// TTS engine hint forwarded to the synth path (`"outetts"` | a RyuTTS id).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tts_engine: Option<String>,
        /// TTS voice id (engine-specific).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tts_voice: Option<String>,
        /// Whether the person speaking is the owner or someone the owner
        /// trusts. Only `Some(false)` changes anything: every turn of the
        /// session then runs under Core's untrusted-caller tool profile. Absent
        /// (the desktop and mobile voice UI) or `true` keeps the owner's normal
        /// session, so a client can use this field only to restrict itself.
        /// The Gateway sends `false` for each inbound phone caller that the
        /// line does not list as trusted.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        caller_trusted: Option<bool>,
    },
    /// Typed text input (fallback path); runs a turn without STT.
    Text { content: String },
    /// Internal post-call summarization turn. Uses the default Core agent with
    /// audio synthesis disabled so a disconnected caller cannot receive another
    /// response and agent-specific call tools are not re-entered.
    Summary,
    /// Manual barge-in / stop button: abort the in-flight turn + TTS now. (VAD-based
    /// barge-in is automatic and server-side; this is the explicit user action.)
    Abort,
    /// End the call and receive its persisted summary before disconnecting.
    End,
    /// Liveness probe.
    Ping,
}

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

/// Every control message the server sends, tagged on `type`. TTS audio rides
/// out-of-band as BINARY WAV frames (not modeled here).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VoiceServerMsg {
    /// Acknowledges `start`; carries the session id and the TTS downlink rate.
    Ready {
        session_id: String,
        tts_sample_rate: u32,
    },
    /// Turn-phase change; drives the client's voice-mode UI.
    State { value: VoiceState },
    /// The VAD detected the user's speech onset. Sent on entering `listening` and,
    /// during `speaking`, as the barge-in signal that precedes `stop_playback`.
    SpeechStart,
    /// Live/partial or final transcript of the user's speech (display it). `final_`
    /// serializes as the wire name `final` (a Rust keyword).
    Stt {
        text: String,
        #[serde(rename = "final")]
        final_: bool,
    },
    /// One streamed assistant-text chunk (per-token, for live captions).
    ChatDelta { text: String },
    /// End of the streamed assistant turn.
    ChatEnd { conversation_id: String },
    /// A user-side history entry, acknowledged only after persistence succeeds.
    CallEnded {
        #[serde(rename = "conversationId")]
        conversation_id: String,
        #[serde(rename = "messageId")]
        message_id: String,
        #[serde(rename = "durationSeconds")]
        duration_seconds: u64,
        content: String,
    },
    /// Barge-in: the client must drop any queued/playing TTS audio immediately.
    StopPlayback,
    /// TTS audio is about to stream as BINARY WAV frames.
    TtsStart,
    /// End of the TTS audio stream for this turn.
    TtsEnd,
    /// Protocol or processing error.
    Error { code: String, message: String },
    /// Liveness response.
    Pong,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn call_end_wire_contract_matches_typescript() {
        assert_eq!(
            serde_json::from_str::<VoiceClientMsg>(r#"{"type":"end"}"#).unwrap(),
            VoiceClientMsg::End
        );
        let frame = VoiceServerMsg::CallEnded {
            conversation_id: "conversation-1".into(),
            message_id: "message-1".into(),
            duration_seconds: 84,
            content: "Call ended · 01:24".into(),
        };
        assert_eq!(
            serde_json::to_value(frame).unwrap(),
            serde_json::json!({
                "type": "call_ended", "conversationId": "conversation-1", "messageId": "message-1",
                "durationSeconds": 84, "content": "Call ended · 01:24"
            })
        );
    }

    #[test]
    fn state_wire_strings() {
        assert_eq!(
            serde_json::to_string(&VoiceState::Listening).unwrap(),
            "\"listening\""
        );
        assert_eq!(
            serde_json::to_string(&VoiceState::Speaking).unwrap(),
            "\"speaking\""
        );
    }

    #[test]
    fn client_start_roundtrips_and_defaults() {
        let raw = r#"{"type":"start","sample_rate":48000}"#;
        let msg: VoiceClientMsg = serde_json::from_str(raw).unwrap();
        match msg {
            VoiceClientMsg::Start {
                sample_rate,
                conversation_id,
                agent_id,
                ..
            } => {
                assert_eq!(sample_rate, 48_000);
                assert!(conversation_id.is_none());
                assert!(agent_id.is_none());
            }
            _ => panic!("expected start"),
        }
    }

    /// Existing clients omit `caller_trusted`; the Gateway's phone path sends an
    /// explicit `false`. Both parse, and the field round-trips by its wire name.
    #[test]
    fn client_start_caller_trust_is_optional_and_explicit() {
        let owner: VoiceClientMsg =
            serde_json::from_str(r#"{"type":"start","sample_rate":16000}"#).unwrap();
        assert!(matches!(
            owner,
            VoiceClientMsg::Start {
                caller_trusted: None,
                ..
            }
        ));
        let caller: VoiceClientMsg =
            serde_json::from_str(r#"{"type":"start","sample_rate":8000,"caller_trusted":false}"#)
                .unwrap();
        assert!(matches!(
            caller,
            VoiceClientMsg::Start {
                caller_trusted: Some(false),
                ..
            }
        ));
        let wire = serde_json::to_value(&caller).unwrap();
        assert_eq!(wire["caller_trusted"], false);
        assert!(serde_json::to_value(&owner)
            .unwrap()
            .get("caller_trusted")
            .is_none());
    }

    #[test]
    fn server_stt_final_renames_to_keyword() {
        let msg = VoiceServerMsg::Stt {
            text: "hello".into(),
            final_: true,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"stt\""), "{json}");
        assert!(json.contains("\"final\":true"), "{json}");
    }

    #[test]
    fn server_marker_frames_have_no_payload() {
        assert_eq!(
            serde_json::to_string(&VoiceServerMsg::StopPlayback).unwrap(),
            "{\"type\":\"stop_playback\"}"
        );
        assert_eq!(
            serde_json::to_string(&VoiceServerMsg::SpeechStart).unwrap(),
            "{\"type\":\"speech_start\"}"
        );
        assert_eq!(
            serde_json::to_string(&VoiceServerMsg::TtsStart).unwrap(),
            "{\"type\":\"tts_start\"}"
        );
    }

    #[test]
    fn client_abort_parses() {
        let msg: VoiceClientMsg = serde_json::from_str(r#"{"type":"abort"}"#).unwrap();
        assert_eq!(msg, VoiceClientMsg::Abort);
    }

    #[test]
    fn internal_call_summary_control_has_no_user_payload() {
        let msg: VoiceClientMsg = serde_json::from_str(r#"{"type":"summary"}"#).unwrap();
        assert_eq!(msg, VoiceClientMsg::Summary);
    }
}
