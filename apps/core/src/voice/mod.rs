//! Realtime voice mode — the ChatGPT-style desktop/island voice loop.
//!
//! This is the Core half of the first-party voice mode served at
//! `/api/voice/ws` (handler in `server::voice_ws`). Distinct from
//! `crate::hardware` (the ESP32 device link): the peer is a renderer over
//! loopback, audio is uncompressed PCM/WAV (no Opus), and turn-taking is
//! automatic (server-side VAD + endpointing) rather than button-driven.
//!
//! ## Layout
//!
//! - [`protocol`] — the lean RVP wire contract (`VoiceClientMsg`/`VoiceServerMsg`),
//!   mirrored in `packages/protocol/src/voice.ts`.
//! - [`vad`] — voice activity detection: an endpointing/barge-in state machine over
//!   per-frame speech probabilities (energy backend now; TEN VAD ONNX behind the
//!   `voice-vad` feature).
//! - [`text`] — sentence segmentation shared by the streaming turn (incremental
//!   TTS) path.
//! - [`session`] — the per-connection [`session::VoiceSession`] + the STT → streaming
//!   LLM → per-sentence TTS turn ([`session::run_voice_turn`]).

pub mod protocol;
pub mod session;
pub mod text;
pub mod vad;
