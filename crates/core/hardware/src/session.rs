//! Per-connection realtime session: the bridge from RHP frames to existing Core
//! seams (PROTOCOL.md §4).
//!
//! One [`HardwareSession`] exists per live WS connection. It owns the per-turn
//! state and routes work IN-PROCESS (never self-HTTP) to:
//!   - chat:    [`crate::sidecar::adapters::run_text_turn`] (the same non-stream
//!              text-turn primitive the off-chat `AgentRunner` uses) for the
//!              model turn, plus [`crate::server::voice`] for ASR/TTS.
//!   - ambient: the [`crate::ingest::MeetingIngest`] seam
//!              ([`MeetingIngest::append_segment`]) feeding the long-running
//!              meeting that is the ambient session — inverted so this crate never
//!              links `ryu_meetings`.
//!
//! Opus decode/encode happens at the codec edge ([`super::codec`]) so the rest of
//! Core sees PCM/WAV. The WS upgrade + frame pump lives in
//! `server::hardware_ws`; this type holds the logic the pump drives.
//!
//! ## Streaming model
//!
//! [`run_text_turn`] is non-streaming (it returns the full reply text). For v1 we
//! emit the reply as sentence-chunked `chat_delta`s + a `chat_end`, then
//! synthesize the whole reply to TTS. True per-token deltas would require
//! consuming the SSE chat adapter — out of scope for the device link.

use std::sync::Arc;

use anyhow::Result;

use super::codec::{self, UplinkDecoder, DOWNLINK_RATE, FRAME_MS, UPLINK_RATE};
use super::protocol::{AudioFormat, Caps, DeviceType, Emotion, Mode, RhpServerMsg};
use crate::ingest::MeetingIngest;

/// Process-global registry of live device WS senders, so out-of-band producers
/// (the dashboard refresh loop, the ambient rolling-summary) can push a control
/// message to a connected device without holding its socket. Keyed by `device_id`;
/// the WS handler registers a clone of its outbound `mpsc::Sender` on connect and
/// removes it on disconnect (review gap #4: the desk e-ink got no content because
/// nothing ever told it to re-poll).
///
/// This is the hardware analog of `ryu_dashboards::store`'s SSE broadcast: the
/// desktop learns of fresh widget data over SSE; a device learns over its RHP WS.
pub mod live {
    use super::{RhpServerMsg, SessionOutput};
    use std::collections::HashMap;
    use std::sync::OnceLock;
    use tokio::sync::{mpsc, Mutex};

    static REGISTRY: OnceLock<Mutex<HashMap<String, mpsc::Sender<SessionOutput>>>> =
        OnceLock::new();

    fn registry() -> &'static Mutex<HashMap<String, mpsc::Sender<SessionOutput>>> {
        REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// Register a connected device's outbound sender. Replaces any prior entry (a
    /// reconnect supersedes the stale socket).
    pub async fn register(device_id: &str, tx: mpsc::Sender<SessionOutput>) {
        registry().lock().await.insert(device_id.to_string(), tx);
    }

    /// Remove a device's sender on disconnect. Idempotent.
    pub async fn unregister(device_id: &str) {
        registry().lock().await.remove(device_id);
    }

    /// Whether a device currently has a live socket (so a producer can skip work
    /// for offline devices — the device will re-poll on its own cadence anyway).
    pub async fn is_connected(device_id: &str) -> bool {
        registry().lock().await.contains_key(device_id)
    }

    /// Push one control message to a connected device. Returns `true` if it was
    /// queued (the device is connected and its channel is not full/closed). A closed
    /// channel is pruned so it isn't retried.
    pub async fn send(device_id: &str, msg: RhpServerMsg) -> bool {
        let tx = {
            let map = registry().lock().await;
            map.get(device_id).cloned()
        };
        match tx {
            Some(tx) => match tx.try_send(SessionOutput::Control(msg)) {
                Ok(()) => true,
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    unregister(device_id).await;
                    false
                }
                // Full: the device is busy draining; the nudge is best-effort.
                Err(mpsc::error::TrySendError::Full(_)) => false,
            },
            None => false,
        }
    }
}

/// What the session wants the WS pump to send back to the device. The pump
/// serializes control variants to TEXT frames and audio to BINARY frames.
pub enum SessionOutput {
    /// A control message to serialize and send.
    Control(RhpServerMsg),
    /// One Opus packet of TTS audio (24 kHz, 60 ms) to send as a BINARY frame.
    Audio(Vec<u8>),
}

impl SessionOutput {
    fn control(msg: RhpServerMsg) -> Self {
        SessionOutput::Control(msg)
    }
}

/// Live state for one connected device.
pub struct HardwareSession {
    pub device_id: String,
    pub device_type: DeviceType,
    pub caps: Caps,
    pub mode: Mode,
    /// The ambient long-running meeting id, if this device is ambient-capable.
    pub ambient_session_id: Option<String>,
    /// Stable per-device conversation id used for each chat turn's trace + (future)
    /// history binding. NOTE: v1 hardware chat is per-turn STATELESS — the turn
    /// runs `run_text_turn(persist=false)` with only the current user message, so
    /// prior turns are not replayed into the model. The stable id is here so a
    /// later `persist=true` / history-prefill upgrade has a durable key to hang on.
    /// Public so the Core WS pump (which owns the kernel-welded chat turn) can build
    /// the turn's key without reaching into the session.
    pub conversation_id: String,
    /// The agent that handles device chat turns (None = the default LLM path).
    /// Resolved once at connect by the Core WS handler and carried here so the
    /// pump can build the kernel-welded `ChatTurn` from a pure [`TurnInput`].
    pub agent_id: Option<String>,
    /// Meeting-ingest seam: the ambient capture path feeds WAV segments here. Held
    /// as a trait object ([`MeetingIngest`]) so this crate links neither the
    /// in-process engine nor the sidecar — Core injects the concrete impl.
    meetings: Arc<dyn MeetingIngest>,
    /// Opus decoder for the mic uplink (stateful across frames).
    uplink: UplinkDecoder,
    /// PCM accumulated for the current chat turn (decoded uplink, 16 kHz mono).
    chat_pcm: Vec<i16>,
    /// PCM accumulated for the ambient pipeline since the last flush (16 kHz mono).
    ambient_pcm: Vec<i16>,
}

/// ~1 s of 16 kHz mono audio — the ambient flush granularity (PROTOCOL.md §4.2).
const AMBIENT_FLUSH_SAMPLES: usize = UPLINK_RATE as usize;

impl HardwareSession {
    /// Create a session from the device's `hello`. `ambient_session_id` is the
    /// resumed/opened long-running meeting (set by the WS handler when the device
    /// is ambient-capable); `None` for interactive-only devices.
    pub fn new(
        device_id: String,
        device_type: DeviceType,
        caps: Caps,
        ambient_session_id: Option<String>,
        meetings: Arc<dyn MeetingIngest>,
        agent_id: Option<String>,
    ) -> Result<Self> {
        Ok(Self {
            conversation_id: format!("hw_{device_id}"),
            device_id,
            device_type,
            caps,
            mode: Mode::Idle,
            ambient_session_id,
            agent_id,
            meetings,
            uplink: UplinkDecoder::new()?,
            chat_pcm: Vec::new(),
            ambient_pcm: Vec::new(),
        })
    }

    /// The TTS downlink format advertised back to the device in `hello_ack`.
    pub fn tts_format() -> AudioFormat {
        AudioFormat {
            codec: "opus".to_string(),
            sample_rate: DOWNLINK_RATE,
            frame_ms: FRAME_MS,
        }
    }

    /// Switch operating mode. On entering chat we clear any stale turn buffer.
    pub fn set_mode(&mut self, mode: Mode) {
        if mode == Mode::Chat {
            self.chat_pcm.clear();
        }
        self.mode = mode;
    }

    /// Begin a chat turn: drop any buffered audio so the turn starts clean.
    pub fn on_listen_start(&mut self) {
        self.chat_pcm.clear();
    }

    /// Handle a decoded uplink Opus packet for the current mode.
    ///
    /// In `chat` it accumulates the turn (the model runs on `listen:stop`). In
    /// `ambient` it buffers ~1 s then feeds a WAV chunk to the meetings pipeline,
    /// returning `ambient_ack`/`ambient_skip`. Idle mode ignores audio.
    pub async fn on_audio(&mut self, opus_packet: &[u8]) -> Result<Vec<SessionOutput>> {
        let pcm = self.uplink.decode(opus_packet)?;
        match self.mode {
            Mode::Chat => {
                self.chat_pcm.extend_from_slice(&pcm);
                Ok(Vec::new())
            }
            Mode::Ambient => {
                self.ambient_pcm.extend_from_slice(&pcm);
                if self.ambient_pcm.len() >= AMBIENT_FLUSH_SAMPLES {
                    self.flush_ambient().await
                } else {
                    Ok(Vec::new())
                }
            }
            Mode::Idle => Ok(Vec::new()),
        }
    }

    /// Feed the buffered ambient PCM to the meetings chunk pipeline as one WAV
    /// chunk, emitting `ambient_ack` (a segment was transcribed) or `ambient_skip`
    /// (silence / no meeting bound).
    async fn flush_ambient(&mut self) -> Result<Vec<SessionOutput>> {
        let pcm = std::mem::take(&mut self.ambient_pcm);
        let Some(meeting_id) = self.ambient_session_id.clone() else {
            return Ok(vec![SessionOutput::control(RhpServerMsg::AmbientSkip {
                reason: "no ambient session".to_string(),
            })]);
        };
        let wav = codec::pcm16_to_wav(&pcm, UPLINK_RATE)?;
        match self
            .meetings
            .append_segment(&meeting_id, wav, "ambient.wav".to_string())
            .await
        {
            Ok(segment_id) => Ok(vec![SessionOutput::control(RhpServerMsg::AmbientAck {
                segment_id,
            })]),
            // A silent chunk is the common case, not an error worth surfacing.
            Err(e) if e.contains("silence") || e.contains("empty") => {
                Ok(vec![SessionOutput::control(RhpServerMsg::AmbientSkip {
                    reason: "silence".to_string(),
                })])
            }
            Err(e) => Ok(vec![SessionOutput::control(RhpServerMsg::AmbientSkip {
                reason: e,
            })]),
        }
    }

    /// Take the buffered chat turn on `listen:stop`. Returns the captured 16 kHz
    /// mono PCM as a pure [`TurnInput`], or `None` when nothing was captured. The
    /// Core WS pump wraps this in its kernel-welded `ChatTurn` (with the session
    /// deps + `conversation_id`) and spawns the ASR → model → TTS turn off the recv
    /// loop so the loop stays live for barge-in.
    pub fn take_voice_turn(&mut self) -> Option<TurnInput> {
        let pcm = std::mem::take(&mut self.chat_pcm);
        if pcm.is_empty() {
            return None;
        }
        Some(TurnInput::Voice(pcm))
    }

    /// Build a `text`-fallback turn input (skips ASR). `None` for empty input.
    pub fn take_text_turn(&mut self, content: &str) -> Option<TurnInput> {
        let content = content.trim();
        if content.is_empty() {
            return None;
        }
        Some(TurnInput::Text(content.to_string()))
    }

    /// Map a chat/processing phase to the face emotion to push. Used by the WS
    /// handler when it wants to nudge the face outside a full turn.
    pub fn emotion_for_phase(&self) -> Emotion {
        match self.mode {
            Mode::Chat => Emotion::Listening,
            Mode::Ambient => Emotion::Neutral,
            Mode::Idle => Emotion::Neutral,
        }
    }
}

/// The user input that opens a chat turn.
pub enum TurnInput {
    /// Captured mic PCM (16 kHz mono) to transcribe before the model turn.
    Voice(Vec<i16>),
    /// Already-text input (the `text` fallback frame) — skips ASR.
    Text(String),
}
