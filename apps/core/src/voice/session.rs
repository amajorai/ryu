//! Per-connection voice-mode session: the ChatGPT-style realtime loop.
//!
//! One [`VoiceSession`] exists per live `/api/voice/ws` connection. It owns the
//! VAD + capture state and routes each turn IN-PROCESS (never self-HTTP) to the
//! same Core seams the hardware session uses:
//!   - STT: [`crate::server::voice::transcribe_wav`]
//!   - LLM: [`crate::sidecar::adapters::route_chat_stream`] consumed incrementally
//!     via [`crate::sidecar::adapters::stream_text_reply`] (per-token deltas)
//!   - TTS: per-sentence synthesis (RyuTTS `/generate`, resident + warm; OuteTTS
//!     otherwise) streamed back sentence-by-sentence.
//!
//! ## Loop
//!
//! The client streams mic PCM continuously. [`on_audio`] resamples it to 16 kHz,
//! feeds the [`Vad`], and reports [`VoiceEvent`]s: `SpeechStart` (onset) and
//! `SpeechEnd` (end-of-turn). The WS handler (`server::voice_ws`) owns turn
//! lifecycle + barge-in: on `SpeechStart` while a turn is in flight it aborts and
//! tells the client to stop playback; on `SpeechEnd` it spawns [`run_voice_turn`].
//!
//! [`on_audio`]: VoiceSession::on_audio

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::mpsc;

use super::protocol::{VoiceServerMsg, VoiceState};
use super::text::SentenceAccumulator;
use super::vad::{Vad, VadEvent, VAD_RATE};
use crate::agents::AgentStore;
use crate::server::conversations::ConversationStore;
use crate::server::memory::MemoryStore;
use crate::sidecar::adapters::{
    stream_text_reply, AcpAgentRegistry, ChatStreamRequest, UiContent, UiMessage,
};
use crate::sidecar::mcp::McpRegistry;
use crate::sidecar::SidecarManager;
use ryu_skills::SkillRegistry;
use ryu_tracing::TraceStore;

/// TTS downlink sample rate advertised to the client (informational — WAV frames
/// are self-describing). RyuTTS/OuteTTS emit 24 kHz.
pub const TTS_SAMPLE_RATE: u32 = 24_000;

/// Pre-roll kept before a confirmed onset so the VAD debounce (~120 ms) doesn't
/// clip the first word. ~300 ms of 16 kHz mono.
const PREROLL_SAMPLES: usize = (VAD_RATE as usize * 300) / 1000;

/// The store bundle a turn needs to run through the real streaming chat path.
/// Cloned out of `ServerState` at connect (the same handles the chat handler
/// holds). Mirrors the hardware `SessionDeps` minus the ambient/meetings path.
#[derive(Clone)]
pub struct VoiceSessionDeps {
    pub registry: Arc<AcpAgentRegistry>,
    pub conversations: ConversationStore,
    pub agent_store: AgentStore,
    pub manager: Arc<SidecarManager>,
    pub memory: MemoryStore,
    pub worktree_diffs: crate::server::WorktreeDiffStore,
    pub mcp: Arc<McpRegistry>,
    pub skills: SkillRegistry,
    pub traces: TraceStore,
    /// HTTP client for the in-process STT/TTS calls.
    pub client: reqwest::Client,
}

/// Per-session TTS/STT/agent configuration from the client's `start` frame.
#[derive(Clone)]
pub struct VoiceConfig {
    pub conversation_id: String,
    pub agent_id: Option<String>,
    pub stt_engine: Option<String>,
    pub tts_engine: Option<String>,
    pub tts_voice: Option<String>,
    /// Sample rate of the client's PCM16 uplink frames.
    pub client_rate: u32,
}

/// What the VAD reported after consuming an uplink chunk. The WS handler maps
/// these to control frames + turn lifecycle (it owns barge-in).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoiceEvent {
    /// The user began speaking (onset confirmed).
    SpeechStart,
    /// End-of-turn: the buffered utterance is ready via [`VoiceSession::take_utterance_turn`].
    SpeechEnd,
}

/// Live state for one connected voice-mode client.
pub struct VoiceSession {
    cfg: VoiceConfig,
    deps: VoiceSessionDeps,
    vad: Vad,
    /// Rolling pre-roll of the most recent 16 kHz samples (seeds capture on onset).
    preroll: VecDeque<i16>,
    /// 16 kHz mono PCM captured for the current utterance.
    capture: Vec<i16>,
    /// Whether we are actively accumulating an utterance.
    capturing: bool,
}

impl VoiceSession {
    pub fn new(cfg: VoiceConfig, deps: VoiceSessionDeps) -> Self {
        Self {
            cfg,
            deps,
            vad: Vad::new(),
            preroll: VecDeque::with_capacity(PREROLL_SAMPLES + VAD_RATE as usize),
            capture: Vec::new(),
            capturing: false,
        }
    }

    /// Feed one uplink PCM16 chunk (at the client's sample rate); return VAD events.
    /// Resamples to 16 kHz, drives the VAD, and manages the pre-roll + capture
    /// buffers so a completed utterance is ready on `SpeechEnd`.
    pub fn on_audio(&mut self, pcm_client: &[i16]) -> Vec<VoiceEvent> {
        let pcm16 = ryu_hardware::codec::resample_to(pcm_client, self.cfg.client_rate, VAD_RATE);

        // Maintain the pre-roll ring and, when capturing, append the utterance.
        for &s in &pcm16 {
            if self.preroll.len() >= PREROLL_SAMPLES {
                self.preroll.pop_front();
            }
            self.preroll.push_back(s);
        }
        if self.capturing {
            self.capture.extend_from_slice(&pcm16);
        }

        let mut events = Vec::new();
        for ev in self.vad.push(&pcm16) {
            match ev {
                VadEvent::SpeechStart => {
                    // Seed capture with the pre-roll so the first word isn't clipped.
                    self.capture.clear();
                    self.capture.extend(self.preroll.iter().copied());
                    self.capturing = true;
                    events.push(VoiceEvent::SpeechStart);
                }
                VadEvent::SpeechEnd => {
                    self.capturing = false;
                    events.push(VoiceEvent::SpeechEnd);
                }
            }
        }
        events
    }

    /// Take the captured utterance as a turn (drains the buffer). `None` when
    /// nothing was captured.
    pub fn take_utterance_turn(&mut self) -> Option<VoiceTurn> {
        let pcm = std::mem::take(&mut self.capture);
        self.capturing = false;
        self.vad.reset();
        if pcm.is_empty() {
            return None;
        }
        Some(VoiceTurn {
            input: TurnInput::Voice(pcm),
            deps: self.deps.clone(),
            cfg: self.cfg.clone(),
        })
    }

    /// Build a text-input turn (typed fallback; skips STT). `None` for empty input.
    pub fn make_text_turn(&mut self, content: &str) -> Option<VoiceTurn> {
        let content = content.trim();
        if content.is_empty() {
            return None;
        }
        // A typed turn supersedes any in-progress capture.
        self.capture.clear();
        self.capturing = false;
        self.vad.reset();
        Some(VoiceTurn {
            input: TurnInput::Text(content.to_string()),
            deps: self.deps.clone(),
            cfg: self.cfg.clone(),
        })
    }

    pub fn conversation_id(&self) -> &str {
        &self.cfg.conversation_id
    }
}

/// The user input that opens a turn.
pub enum TurnInput {
    /// Captured 16 kHz mono mic PCM to transcribe before the model turn.
    Voice(Vec<i16>),
    /// Already-text input (typed fallback) — skips STT.
    Text(String),
}

/// A self-contained turn, owning everything the STT→LLM→TTS path needs so it can
/// be `tokio::spawn`ed off the recv loop (keeping the loop responsive to audio +
/// barge-in while the model + TTS run).
pub struct VoiceTurn {
    pub input: TurnInput,
    pub deps: VoiceSessionDeps,
    pub cfg: VoiceConfig,
}

/// What the session wants the WS pump to send. The pump serializes `Control` to a
/// TEXT frame and `Audio` (one sentence's WAV) to a BINARY frame.
pub enum VoiceOutput {
    Control(VoiceServerMsg),
    Audio(Vec<u8>),
}

/// Run one turn end-to-end, streaming outputs to `out_tx` as they are produced:
/// `stt` → `state:thinking` → per-token `chat_delta`s while, in parallel,
/// completed sentences are synthesized and streamed (`state:speaking` → `tts_start`
/// → audio… ) → `chat_end` → `tts_end` → `state:idle`.
///
/// `abort` is the shared barge-in flag (set by the WS handler when the VAD detects
/// the user talking over the reply). It is checked before each caption, each
/// sentence synth, and each audio frame, so a barge-in stops the reply promptly.
pub async fn run_voice_turn(
    turn: VoiceTurn,
    abort: Arc<AtomicBool>,
    out_tx: mpsc::Sender<VoiceOutput>,
) {
    let VoiceTurn { input, deps, cfg } = turn;

    // 1) Resolve the prompt (STT for voice; passthrough for text).
    let prompt = match input {
        TurnInput::Text(t) => t,
        TurnInput::Voice(pcm) => match transcribe(&deps, &cfg, &pcm).await {
            Ok(text) if !text.is_empty() => text,
            Ok(_) => {
                // Nothing intelligible — clear the client's listening UI and stop.
                let _ = out_tx
                    .send(VoiceOutput::Control(VoiceServerMsg::Stt {
                        text: String::new(),
                        final_: true,
                    }))
                    .await;
                let _ = out_tx
                    .send(VoiceOutput::Control(VoiceServerMsg::State {
                        value: VoiceState::Idle,
                    }))
                    .await;
                return;
            }
            Err(e) => {
                let _ = out_tx
                    .send(VoiceOutput::Control(VoiceServerMsg::Error {
                        code: "asr_failed".to_string(),
                        message: format!("speech recognition failed: {e}"),
                    }))
                    .await;
                let _ = out_tx
                    .send(VoiceOutput::Control(VoiceServerMsg::State {
                        value: VoiceState::Idle,
                    }))
                    .await;
                return;
            }
        },
    };

    // Echo the transcript + move to thinking.
    if out_tx
        .send(VoiceOutput::Control(VoiceServerMsg::Stt {
            text: prompt.clone(),
            final_: true,
        }))
        .await
        .is_err()
    {
        return;
    }
    let _ = out_tx
        .send(VoiceOutput::Control(VoiceServerMsg::State {
            value: VoiceState::Thinking,
        }))
        .await;

    // 2) Kick off the streaming model turn and consume its per-token deltas.
    let response = crate::sidecar::adapters::route_chat_stream(
        build_chat_request(&cfg, prompt),
        Arc::clone(&deps.registry),
        deps.conversations.clone(),
        deps.agent_store.clone(),
        Arc::clone(&deps.manager),
        deps.memory.clone(),
        Arc::clone(&deps.worktree_diffs),
        Arc::clone(&deps.mcp),
        deps.skills.clone(),
        deps.traces.clone(),
        None,
        None,
    )
    .await;

    let (delta_tx, mut delta_rx) = mpsc::channel::<String>(64);
    let streamer = tokio::spawn(stream_text_reply(response, delta_tx));

    let mut acc = SentenceAccumulator::new();
    let mut spoke = false;
    let mut aborted = false;

    while let Some(delta) = delta_rx.recv().await {
        if abort.load(Ordering::SeqCst) {
            aborted = true;
            break;
        }
        // Live caption.
        if out_tx
            .send(VoiceOutput::Control(VoiceServerMsg::ChatDelta {
                text: delta.clone(),
            }))
            .await
            .is_err()
        {
            aborted = true;
            break;
        }
        // Synthesize + stream each completed sentence as it lands.
        for sentence in acc.push(&delta) {
            if abort.load(Ordering::SeqCst) {
                aborted = true;
                break;
            }
            speak_sentence(&deps, &cfg, &sentence, &abort, &out_tx, &mut spoke).await;
        }
        if aborted {
            break;
        }
    }

    // Flush the trailing partial sentence (if any) once the stream ends clean.
    if !aborted && !abort.load(Ordering::SeqCst) {
        if let Some(tail) = acc.flush() {
            speak_sentence(&deps, &cfg, &tail, &abort, &out_tx, &mut spoke).await;
        }
    }

    // Reap the streamer: abort it on barge-in, else surface an error frame.
    if aborted {
        streamer.abort();
    } else if let Ok(Err(e)) = streamer.await {
        let _ = out_tx
            .send(VoiceOutput::Control(VoiceServerMsg::Error {
                code: "turn_failed".to_string(),
                message: format!("{e:#}"),
            }))
            .await;
    }

    if spoke {
        let _ = out_tx
            .send(VoiceOutput::Control(VoiceServerMsg::TtsEnd))
            .await;
    }
    let _ = out_tx
        .send(VoiceOutput::Control(VoiceServerMsg::ChatEnd {
            conversation_id: cfg.conversation_id.clone(),
        }))
        .await;
    let _ = out_tx
        .send(VoiceOutput::Control(VoiceServerMsg::State {
            value: VoiceState::Idle,
        }))
        .await;
}

/// Synthesize one sentence and stream it as a WAV BINARY frame. On the first
/// sentence it emits `state:speaking` + `tts_start`. Best-effort: a synth failure
/// is logged, not fatal (the captions still convey the reply).
async fn speak_sentence(
    deps: &VoiceSessionDeps,
    cfg: &VoiceConfig,
    text: &str,
    abort: &Arc<AtomicBool>,
    out_tx: &mpsc::Sender<VoiceOutput>,
    spoke: &mut bool,
) {
    if abort.load(Ordering::SeqCst) {
        return;
    }
    match synthesize_sentence(deps, cfg, text).await {
        Ok(wav) => {
            if abort.load(Ordering::SeqCst) {
                return;
            }
            if !*spoke {
                *spoke = true;
                let _ = out_tx
                    .send(VoiceOutput::Control(VoiceServerMsg::State {
                        value: VoiceState::Speaking,
                    }))
                    .await;
                let _ = out_tx
                    .send(VoiceOutput::Control(VoiceServerMsg::TtsStart))
                    .await;
            }
            let _ = out_tx.send(VoiceOutput::Audio(wav)).await;
        }
        Err(e) => tracing::warn!("voice: sentence TTS failed: {e:#}"),
    }
}

/// Transcribe captured 16 kHz PCM via the in-process STT path (whisper default,
/// parakeet when configured).
async fn transcribe(
    deps: &VoiceSessionDeps,
    cfg: &VoiceConfig,
    pcm: &[i16],
) -> Result<String, String> {
    let wav = ryu_hardware::codec::pcm16_to_wav(pcm, VAD_RATE).map_err(|e| e.to_string())?;
    crate::server::voice::transcribe_wav(
        &deps.client,
        wav,
        "turn.wav".to_string(),
        cfg.stt_engine.as_deref(),
    )
    .await
    .map(|t| t.trim().to_string())
}

/// Synthesize one sentence to WAV bytes. Uses OuteTTS (built-in) or, for any other
/// engine id, the resident RyuTTS sidecar `/generate` — the low-latency path for
/// repeated per-sentence synthesis (mirrors `server::voice::speak`).
async fn synthesize_sentence(
    deps: &VoiceSessionDeps,
    cfg: &VoiceConfig,
    text: &str,
) -> anyhow::Result<Vec<u8>> {
    // Default engine is the swappable cross-surface default (Kokoro 82M), not a
    // hardcoded literal. OuteTTS is the built-in fallback.
    let engine = cfg
        .tts_engine
        .clone()
        .unwrap_or_else(crate::sidecar::providers::ryutts::default_tts_engine);
    if engine == "outetts" {
        return crate::sidecar::providers::outetts::synthesize(text).await;
    }

    let url = format!(
        "{}/generate",
        crate::sidecar::providers::ryutts::tts_base_url()
    );
    let mut body = serde_json::json!({ "text": text, "engine": engine });
    if let Some(v) = &cfg.tts_voice {
        body["voice"] = serde_json::json!(v);
    }
    // Degrade to OuteTTS if the sidecar is unreachable or the engine can't render,
    // so a voice turn never goes silent (mirrors `server::voice::speak`).
    let sidecar_result = async {
        let resp = deps
            .client
            .post(&url)
            .bearer_auth(crate::sidecar::providers::ryutts::bearer())
            .json(&body)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("RyuTTS not reachable at {url}: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let detail = resp.text().await.unwrap_or_default();
            anyhow::bail!("RyuTTS engine '{engine}' returned {status}: {detail}");
        }
        Ok::<Vec<u8>, anyhow::Error>(resp.bytes().await?.to_vec())
    }
    .await;

    match sidecar_result {
        Ok(wav) => Ok(wav),
        Err(e) => {
            tracing::warn!(
                engine = %engine,
                "voice-session TTS failed ({e:#}); falling back to OuteTTS"
            );
            crate::sidecar::providers::outetts::synthesize(text).await
        }
    }
}

/// Build the streaming chat request for a voice turn — an interactive, persisted,
/// single-message turn on the session's conversation (so history + memory work).
fn build_chat_request(cfg: &VoiceConfig, prompt: String) -> ChatStreamRequest {
    ChatStreamRequest {
        messages: vec![UiMessage {
            role: "user".to_owned(),
            content: UiContent::Text(prompt),
            parts: vec![],
        }],
        agent_id: cfg.agent_id.clone(),
        conversation_id: Some(cfg.conversation_id.clone()),
        // Voice mode is a user-facing chat surface — persist + interactive priority.
        persist: true,
        background: false,
        ..ChatStreamRequest::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> VoiceConfig {
        VoiceConfig {
            conversation_id: "conv-1".into(),
            agent_id: Some("agent-x".into()),
            stt_engine: None,
            tts_engine: None,
            tts_voice: None,
            client_rate: 48_000,
        }
    }

    #[test]
    fn build_chat_request_is_persisted_interactive_single_user_turn() {
        let req = build_chat_request(&cfg(), "hello there".into());
        assert!(req.persist, "voice turns persist to conversation history");
        assert!(!req.background, "voice is interactive, not a background run");
        assert_eq!(req.conversation_id.as_deref(), Some("conv-1"));
        assert_eq!(req.agent_id.as_deref(), Some("agent-x"));
        assert_eq!(req.messages.len(), 1);
        let msg = &req.messages[0];
        assert_eq!(msg.role, "user");
        match &msg.content {
            UiContent::Text(t) => assert_eq!(t, "hello there"),
            _ => panic!("expected text content"),
        }
    }

    #[test]
    fn build_chat_request_without_agent_uses_default_path() {
        let mut c = cfg();
        c.agent_id = None;
        let req = build_chat_request(&c, "hi".into());
        assert!(req.agent_id.is_none(), "None agent = default LLM path");
    }
}
