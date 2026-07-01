//! Per-connection realtime session: the bridge from RHP frames to existing Core
//! seams (PROTOCOL.md §4).
//!
//! One [`HardwareSession`] exists per live WS connection. It owns the per-turn
//! state and routes work IN-PROCESS (never self-HTTP) to:
//!   - chat:    [`crate::sidecar::adapters::run_text_turn`] (the same non-stream
//!              text-turn primitive the off-chat `AgentRunner` uses) for the
//!              model turn, plus [`crate::server::voice`] for ASR/TTS.
//!   - ambient: [`crate::meetings::MeetingEngine::ingest_chunk`] feeding the
//!              long-running meeting that is the ambient session.
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

use super::codec::{self, DownlinkEncoder, UplinkDecoder, DOWNLINK_RATE, FRAME_MS, UPLINK_RATE};
use super::protocol::{AudioFormat, Caps, DeviceType, Emotion, Mode, RhpServerMsg};
use crate::agents::AgentStore;
use crate::meetings::MeetingEngine;
use crate::server::conversations::ConversationStore;
use crate::server::memory::MemoryStore;
use crate::server::trace::TraceStore;
use crate::sidecar::adapters::{run_text_turn, AcpAgentRegistry};
use crate::sidecar::mcp::McpRegistry;
use crate::sidecar::SidecarManager;
use crate::skills::SkillRegistry;

/// The store handles the session needs to run a model turn through the real chat
/// path. Cloned out of `ServerState` at connect (the same bundle `AgentRunner`
/// holds), so the session can drive the configured agent without a `ServerState`.
#[derive(Clone)]
pub struct SessionDeps {
    pub registry: Arc<AcpAgentRegistry>,
    pub conversations: ConversationStore,
    pub agent_store: AgentStore,
    pub manager: Arc<SidecarManager>,
    pub memory: MemoryStore,
    pub worktree_diffs: crate::server::WorktreeDiffStore,
    pub mcp: Arc<McpRegistry>,
    pub skills: SkillRegistry,
    pub traces: TraceStore,
    /// HTTP client for the in-process voice (TTS/ASR) calls.
    pub client: reqwest::Client,
    /// Meetings engine: the ambient capture path feeds chunks here.
    pub meetings: MeetingEngine,
    /// The agent that handles device chat turns (None = the default LLM path).
    pub agent_id: Option<String>,
}

/// Process-global registry of live device WS senders, so out-of-band producers
/// (the dashboard refresh loop, the ambient rolling-summary) can push a control
/// message to a connected device without holding its socket. Keyed by `device_id`;
/// the WS handler registers a clone of its outbound `mpsc::Sender` on connect and
/// removes it on disconnect (review gap #4: the desk e-ink got no content because
/// nothing ever told it to re-poll).
///
/// This is the hardware analog of [`crate::dashboard::store`]'s SSE broadcast: the
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
    conversation_id: String,
    deps: SessionDeps,
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
        deps: SessionDeps,
    ) -> Result<Self> {
        Ok(Self {
            conversation_id: format!("hw_{device_id}"),
            device_id,
            device_type,
            caps,
            mode: Mode::Idle,
            ambient_session_id,
            deps,
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
            .deps
            .meetings
            .ingest_chunk(&meeting_id, wav, "ambient.wav".to_string(), None)
            .await
        {
            Ok(segment) => Ok(vec![SessionOutput::control(RhpServerMsg::AmbientAck {
                segment_id: segment.id.to_string(),
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
    /// mono PCM (and the data needed to run the turn off the recv loop), or `None`
    /// when nothing was captured. The actual ASR → model → TTS runs in
    /// [`run_chat_turn`], spawned by the WS handler so the recv loop stays live
    /// for barge-in.
    pub fn take_voice_turn(&mut self) -> Option<ChatTurn> {
        let pcm = std::mem::take(&mut self.chat_pcm);
        if pcm.is_empty() {
            return None;
        }
        Some(ChatTurn {
            input: TurnInput::Voice(pcm),
            deps: self.deps.clone(),
            conversation_id: self.conversation_id.clone(),
        })
    }

    /// Build a `text`-fallback turn (skips ASR). `None` for empty input.
    pub fn take_text_turn(&mut self, content: &str) -> Option<ChatTurn> {
        let content = content.trim();
        if content.is_empty() {
            return None;
        }
        Some(ChatTurn {
            input: TurnInput::Text(content.to_string()),
            deps: self.deps.clone(),
            conversation_id: self.conversation_id.clone(),
        })
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

/// A self-contained chat turn, owning everything the model+TTS path needs so it
/// can be `tokio::spawn`ed off the recv loop (keeping barge-in responsive).
pub struct ChatTurn {
    pub input: TurnInput,
    pub deps: SessionDeps,
    pub conversation_id: String,
}

/// Run one chat turn end-to-end, streaming each output to `out_tx` as it is
/// produced: `stt` → `emotion:thinking` → `chat_delta`(s) → `chat_end` →
/// `emotion:speaking` → `tts_start` → audio… → `tts_end` → `emotion:neutral`.
///
/// `abort` is the shared barge-in flag. It is checked before TTS synthesis (skip
/// it entirely if already aborted) and before each audio frame is queued, so a
/// barge-in stops the spoken reply promptly. The send task additionally drops any
/// audio already queued, so the two layers together make `abort` meaningful even
/// though the model reply itself is non-streaming.
pub async fn run_chat_turn(
    turn: ChatTurn,
    abort: std::sync::Arc<std::sync::atomic::AtomicBool>,
    out_tx: tokio::sync::mpsc::Sender<SessionOutput>,
) {
    use std::sync::atomic::Ordering;

    let ChatTurn {
        input,
        deps,
        conversation_id,
    } = turn;

    // 1) Resolve the prompt text (ASR for voice; passthrough for text).
    let prompt = match input {
        TurnInput::Text(t) => t,
        TurnInput::Voice(pcm) => match transcribe_voice(&deps, &pcm).await {
            Ok(text) if !text.is_empty() => text,
            Ok(_) => {
                // Nothing intelligible — report an empty final transcript so the
                // device can clear its "listening" UI, then stop.
                let _ = out_tx
                    .send(SessionOutput::Control(RhpServerMsg::Stt {
                        text: String::new(),
                        final_: true,
                    }))
                    .await;
                return;
            }
            Err(e) => {
                let _ = out_tx
                    .send(SessionOutput::Control(RhpServerMsg::Error {
                        code: "asr_failed".to_string(),
                        message: format!("speech recognition failed: {e}"),
                    }))
                    .await;
                return;
            }
        },
    };

    // Echo the recognized/used text + a thinking face.
    if out_tx
        .send(SessionOutput::Control(RhpServerMsg::Stt {
            text: prompt.clone(),
            final_: true,
        }))
        .await
        .is_err()
    {
        return;
    }
    let _ = out_tx
        .send(SessionOutput::Control(RhpServerMsg::Emotion {
            value: Emotion::Thinking,
        }))
        .await;

    // 2) Model turn through the same primitive the off-chat AgentRunner uses: a
    // non-persisted single-message turn that respects the device's configured
    // agent binding. Every model call still routes via the Gateway.
    let reply = match run_text_turn(
        conversation_id.clone(),
        deps.agent_id.clone(),
        prompt,
        None,
        false,
        Arc::clone(&deps.registry),
        deps.conversations.clone(),
        deps.agent_store.clone(),
        Arc::clone(&deps.manager),
        deps.memory.clone(),
        Arc::clone(&deps.worktree_diffs),
        Arc::clone(&deps.mcp),
        deps.skills.clone(),
        deps.traces.clone(),
    )
    .await
    {
        Ok(r) => r.trim().to_string(),
        Err(e) => {
            let _ = out_tx
                .send(SessionOutput::Control(RhpServerMsg::Error {
                    code: "turn_failed".to_string(),
                    message: format!("{e:#}"),
                }))
                .await;
            return;
        }
    };

    // 3) Stream the reply as sentence-sized chat_delta chunks (v1: not per-token).
    for chunk in sentence_chunks(&reply) {
        if out_tx
            .send(SessionOutput::Control(RhpServerMsg::ChatDelta {
                text: chunk,
            }))
            .await
            .is_err()
        {
            return;
        }
    }
    let _ = out_tx
        .send(SessionOutput::Control(RhpServerMsg::ChatEnd {
            conversation_id,
        }))
        .await;

    // 4) Synthesize + Opus-encode the reply for the downlink — unless the user
    // barged in during generation (skip synth entirely) or the reply is empty.
    if reply.is_empty() || abort.load(Ordering::SeqCst) {
        let _ = out_tx
            .send(SessionOutput::Control(RhpServerMsg::Emotion {
                value: Emotion::Neutral,
            }))
            .await;
        return;
    }

    let _ = out_tx
        .send(SessionOutput::Control(RhpServerMsg::Emotion {
            value: Emotion::Speaking,
        }))
        .await;
    match synthesize_downlink(&reply).await {
        Ok(packets) => {
            let _ = out_tx
                .send(SessionOutput::Control(RhpServerMsg::TtsStart))
                .await;
            for packet in packets {
                if abort.load(Ordering::SeqCst) {
                    break;
                }
                if out_tx.send(SessionOutput::Audio(packet)).await.is_err() {
                    return;
                }
            }
            let _ = out_tx
                .send(SessionOutput::Control(RhpServerMsg::TtsEnd))
                .await;
        }
        Err(e) => {
            tracing::warn!("hardware: TTS synthesis failed: {e:#}");
            let _ = out_tx
                .send(SessionOutput::Control(RhpServerMsg::Error {
                    code: "tts_failed".to_string(),
                    message: format!("speech synthesis failed: {e}"),
                }))
                .await;
        }
    }
    let _ = out_tx
        .send(SessionOutput::Control(RhpServerMsg::Emotion {
            value: Emotion::Neutral,
        }))
        .await;
}

/// Transcribe captured turn PCM via the in-process whisper path.
async fn transcribe_voice(deps: &SessionDeps, pcm: &[i16]) -> Result<String> {
    let wav = codec::pcm16_to_wav(pcm, UPLINK_RATE)?;
    let text =
        crate::server::voice::transcribe_wav(&deps.client, wav, "turn.wav".to_string(), None)
            .await
            .map_err(|e| anyhow::anyhow!(e))?;
    Ok(text.trim().to_string())
}

/// Synthesize `text` to the 24 kHz Opus downlink: OuteTTS WAV → PCM → resample to
/// 24 kHz (no-op when already 24 kHz) → Opus packets. The encoder is created here
/// (after the synth await) and never held across an await, so the turn future
/// stays `Send`.
async fn synthesize_downlink(text: &str) -> Result<Vec<Vec<u8>>> {
    let wav = crate::sidecar::providers::outetts::synthesize(text).await?;
    let decoded = codec::wav_to_pcm16(&wav)?;
    let pcm = codec::resample_to(&decoded.samples, decoded.sample_rate, DOWNLINK_RATE);
    let mut encoder = DownlinkEncoder::new()?;
    encoder.encode_stream(&pcm)
}

/// Split a reply into sentence-ish chunks for incremental `chat_delta` framing.
/// Keeps the terminator with its sentence; never returns empty chunks. A reply
/// with no sentence boundary returns as a single chunk.
fn sentence_chunks(text: &str) -> Vec<String> {
    let text = text.trim();
    if text.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        current.push(ch);
        if matches!(ch, '.' | '!' | '?' | '\n') {
            let trimmed = current.trim();
            if !trimmed.is_empty() {
                chunks.push(trimmed.to_string());
            }
            current.clear();
        }
    }
    let tail = current.trim();
    if !tail.is_empty() {
        chunks.push(tail.to_string());
    }
    if chunks.is_empty() {
        chunks.push(text.to_string());
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sentence_chunks_split_on_terminators() {
        let chunks = sentence_chunks("Hello there. How are you? Good!");
        assert_eq!(chunks, vec!["Hello there.", "How are you?", "Good!"]);
    }

    #[test]
    fn sentence_chunks_single_when_no_boundary() {
        assert_eq!(sentence_chunks("just one clause"), vec!["just one clause"]);
        assert!(sentence_chunks("   ").is_empty());
    }
}
