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
//! Normal voice turns are real user turns, so they also run the plugin
//! turn-boundary hooks the typed chat path runs: `pre_user_turn` before the model
//! and `post_assistant_turn` once the reply drains. Internal call-summary turns
//! use the default, tool-free model path and skip both hooks. A session opened
//! for an unverified phone caller (`caller_trusted: false` on `start`) skips
//! both hooks on every turn and marks each chat request `untrusted_caller`, so
//! `route_chat_stream` runs it under the untrusted-caller tool profile. See
//! `sidecar::adapters`'s off-HTTP turn-hook section for why the directives a
//! realtime spoken surface cannot honour are dropped rather than half-applied.
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
use crate::server::voice::{check_tts_engine_id, UnknownTtsEngine};
use crate::sidecar::adapters::{
    stream_text_reply, AcpAgentRegistry, ChatStreamRequest, PreUserTurn, UiContent, UiMessage,
};
use crate::sidecar::mcp::McpRegistry;
use crate::sidecar::SidecarManager;
use ryu_skills::SkillRegistry;
use ryu_tracing::TraceStore;

/// TTS downlink sample rate advertised to the client (informational — WAV frames
/// are self-describing). RyuTTS/OuteTTS emit 24 kHz.
pub const TTS_SAMPLE_RATE: u32 = 24_000;
pub const PHONE_CALL_SUMMARY_PROMPT: &str = "RYU_PHONE_CALL_SUMMARY: The call ended. Summarize the transcript concisely with the outcome, important details, and next steps. Use only the conversation. Do not place another call, send a message, or take any new action.";

/// Pre-roll kept before a confirmed onset so the VAD debounce (~120 ms) doesn't
/// clip the first word. ~300 ms of 16 kHz mono.
const PREROLL_SAMPLES: usize = (VAD_RATE as usize * 300) / 1000;
const MAX_CAPTURE_SAMPLES: usize = VAD_RATE as usize * 60;

/// The bounded 16 kHz capture for the current utterance.
///
/// A client that never produces `SpeechEnd` (a long monologue, a noisy room)
/// must not grow one connection's PCM buffer without bound. When the capture
/// reaches [`MAX_CAPTURE_SAMPLES`], the audio captured so far is *flushed* as a
/// complete utterance (transcribed like any other turn, never discarded) and a
/// new capture continues from the incoming chunk without resetting the VAD, so
/// ongoing speech keeps being recorded.
#[derive(Default)]
struct UtteranceCapture {
    /// PCM for the utterance currently being recorded.
    capture: Vec<i16>,
    /// Whether we are actively accumulating an utterance.
    capturing: bool,
    /// A full-length segment flushed at the cap, waiting to be taken as a turn.
    flushed: Option<Vec<i16>>,
}

impl UtteranceCapture {
    /// Begin a new utterance seeded with the pre-roll.
    fn start(&mut self, preroll: impl IntoIterator<Item = i16>) {
        self.capture.clear();
        self.capture.extend(preroll);
        self.capturing = true;
    }

    /// Append one 16 kHz chunk while capturing. Returns `true` when the cap was
    /// reached and the previous audio was flushed as a ready utterance.
    fn append(&mut self, pcm16: &[i16]) -> bool {
        if !self.capturing {
            return false;
        }
        let flushed = if !self.capture.is_empty()
            && self.capture.len().saturating_add(pcm16.len()) > MAX_CAPTURE_SAMPLES
        {
            let segment = std::mem::take(&mut self.capture);
            // At most one segment waits: the WS handler takes it on the
            // `SpeechEnd` we emit, long before another 60 s accumulates.
            match &mut self.flushed {
                Some(pending) => pending.extend_from_slice(&segment),
                None => self.flushed = Some(segment),
            }
            true
        } else {
            false
        };
        self.capture.extend_from_slice(pcm16);
        flushed
    }

    /// The VAD reported end of speech: stop accumulating (keep the audio).
    fn stop(&mut self) {
        self.capturing = false;
    }

    /// Drop everything (a typed or summary turn supersedes the capture).
    fn clear(&mut self) {
        self.capture.clear();
        self.capturing = false;
        self.flushed = None;
    }

    /// Take the next ready utterance. A segment flushed at the cap comes first
    /// and leaves the in-progress capture running; otherwise the current
    /// capture is drained and capturing ends. The `bool` says whether the
    /// capture is still running (so the caller must not reset the VAD).
    fn take(&mut self) -> (Option<Vec<i16>>, bool) {
        if let Some(segment) = self.flushed.take() {
            return (Some(segment).filter(|pcm| !pcm.is_empty()), true);
        }
        let pcm = std::mem::take(&mut self.capture);
        self.capturing = false;
        (Some(pcm).filter(|pcm| !pcm.is_empty()), false)
    }
}

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
    pub subscription_costs: Option<crate::server::subscription_costs::SubscriptionCostStore>,
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
    /// Verified human on the call, from the WebSocket ticket. Stamped onto every
    /// turn exactly as `chat_stream` stamps it, so a member's voice turns run
    /// with that member's identity, never as the anonymous owner. `None` is the
    /// node owner's own session.
    pub caller: Option<crate::identity_verify::VerifiedCaller>,
    /// The caller's verified managed user JWT, carried to each turn as
    /// `user_jwt` exactly as `chat_stream` carries it (Gateway attribution and
    /// per-user budgets). `None` for the owner and for delegation credentials.
    pub user_jwt: Option<String>,
    /// The final post-routing agent ACL for a verified caller, as
    /// `route_single_turn` attaches it to typed chat. `None` for the owner.
    pub agent_authorization: Option<Arc<crate::sidecar::adapters::AgentResourceAuthorization>>,
    pub agent_id: Option<String>,
    pub stt_engine: Option<String>,
    pub tts_engine: Option<String>,
    pub tts_voice: Option<String>,
    /// Sample rate of the client's PCM16 uplink frames.
    pub client_rate: u32,
    /// The speaker is an unverified outside party (the Gateway sent
    /// `caller_trusted: false`). Fixed for the life of the session: every turn,
    /// including the post-call summary, runs under the untrusted-caller tool
    /// profile and skips plugin turn hooks. `false` is the owner's session.
    pub untrusted_caller: bool,
}

impl VoiceConfig {
    /// Plugin turn hooks run only for the owner's own turns. A hook may fold
    /// private context into the prompt or act after the reply, so an unverified
    /// caller's turns skip them, just as the internal summary turn does.
    fn runs_turn_hooks(&self) -> bool {
        !self.untrusted_caller
    }

    /// The configuration of the post-call summary turn: the default agent
    /// instead of the call-specific one, with the session's caller trust kept.
    fn for_summary(&self) -> Self {
        Self {
            agent_id: None,
            ..self.clone()
        }
    }
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
    /// Bounded 16 kHz mono capture for the current utterance.
    capture: UtteranceCapture,
}

impl VoiceSession {
    pub fn new(cfg: VoiceConfig, deps: VoiceSessionDeps) -> Self {
        Self {
            cfg,
            deps,
            vad: Vad::new(),
            preroll: VecDeque::with_capacity(PREROLL_SAMPLES + VAD_RATE as usize),
            capture: UtteranceCapture::default(),
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
        let mut events = Vec::new();
        // At the cap, flush the captured audio as its own utterance (the WS
        // handler turns this `SpeechEnd` into a turn) and keep recording.
        if self.capture.append(&pcm16) {
            tracing::info!(
                "voice capture reached {} s; flushing it as an utterance and continuing",
                MAX_CAPTURE_SAMPLES / VAD_RATE as usize
            );
            events.push(VoiceEvent::SpeechEnd);
        }

        for ev in self.vad.push(&pcm16) {
            match ev {
                VadEvent::SpeechStart => {
                    // Seed capture with the pre-roll so the first word isn't clipped.
                    self.capture.start(self.preroll.iter().copied());
                    events.push(VoiceEvent::SpeechStart);
                }
                VadEvent::SpeechEnd => {
                    self.capture.stop();
                    events.push(VoiceEvent::SpeechEnd);
                }
            }
        }
        events
    }

    /// Take the captured utterance as a turn (drains the buffer). `None` when
    /// nothing was captured. A segment flushed at the capture cap is taken
    /// first, leaving the still-running capture and the VAD untouched.
    pub fn take_utterance_turn(&mut self) -> Option<VoiceTurn> {
        let (pcm, still_capturing) = self.capture.take();
        if !still_capturing {
            self.vad.reset();
        }
        let pcm = pcm?;
        Some(VoiceTurn {
            input: TurnInput::Voice(pcm),
            deps: self.deps.clone(),
            cfg: self.cfg.clone(),
            render_audio: true,
            run_turn_hooks: self.cfg.runs_turn_hooks(),
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
        self.vad.reset();
        Some(VoiceTurn {
            input: TurnInput::Text(content.to_string()),
            deps: self.deps.clone(),
            cfg: self.cfg.clone(),
            render_audio: true,
            run_turn_hooks: self.cfg.runs_turn_hooks(),
        })
    }

    /// Create a tool-free, text-only turn that summarizes the conversation after
    /// a phone caller disconnects. It uses the default Ryu agent, not the
    /// call-specific agent, and never synthesizes more audio. An unverified
    /// caller's session keeps its restriction here too: the transcript being
    /// summarized is the caller's own words.
    pub fn make_summary_turn(&mut self) -> VoiceTurn {
        self.capture.clear();
        self.vad.reset();
        VoiceTurn {
            input: TurnInput::Text(PHONE_CALL_SUMMARY_PROMPT.to_owned()),
            deps: self.deps.clone(),
            cfg: self.cfg.for_summary(),
            render_audio: false,
            run_turn_hooks: false,
        }
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
    pub render_audio: bool,
    pub run_turn_hooks: bool,
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
    let VoiceTurn {
        input,
        deps,
        cfg,
        render_audio,
        run_turn_hooks,
    } = turn;

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

    // 2) Plugin `pre_user_turn` hooks. A normal voice turn is a real user turn —
    //    someone spoke a prompt — so it gets the same pre-model treatment the typed
    //    chat path gets: a plugin may rewrite it, fold context into it, or answer it
    //    outright. Fired AFTER the transcript echo above on purpose: that echo is a
    //    caption of what the user actually said, and showing them a plugin's
    //    rewrite of their own words back as their speech would be a lie.
    let spoken = prompt.clone();
    let pre = if run_turn_hooks {
        crate::sidecar::adapters::run_pre_user_turn_hooks(
            prompt,
            Some(&cfg.conversation_id),
            cfg.agent_id.as_deref(),
        )
        .await
    } else {
        PreUserTurn::Prompt(prompt)
    };

    // 3) Kick off the reply and consume it as per-token deltas. A hook-`Handled`
    //    turn makes NO model call, and feeds its text through the SAME delta
    //    channel, so captions, sentence segmentation, TTS and barge-in behave
    //    identically — a plugin that owns a spoken command is indistinguishable
    //    from the model answering it. It also persists both rows itself, because
    //    `route_chat_stream` (the only site that writes the user row) is skipped.
    let (delta_tx, mut delta_rx) = mpsc::channel::<String>(64);
    let streamer = match pre {
        PreUserTurn::Handled {
            reply,
            interactive_markup: _,
        } => {
            let _ = crate::sidecar::adapters::persist_handled_turn(
                &deps.conversations,
                &cfg.conversation_id,
                &spoken,
                &reply,
                cfg.agent_id.as_deref(),
                cfg.caller.as_ref().map(|caller| caller.user_id.as_str()),
                None,
            )
            .await;
            tokio::spawn(async move {
                // A closed receiver (client gone) is not an error, exactly as in
                // `stream_text_reply`.
                let _ = delta_tx.send(reply).await;
                Ok::<(), anyhow::Error>(())
            })
        }
        PreUserTurn::Prompt(prompt) => {
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
                // Voice turns are spoken as they stream; a silent reroute mid-
                // utterance has no surface to announce itself on.
                crate::routing_policy::reactive::TurnWatch::off(),
                deps.subscription_costs.clone(),
            )
            .await;
            tokio::spawn(stream_text_reply(response, delta_tx))
        }
    };

    let mut acc = SentenceAccumulator::new();
    let mut aborted = false;

    // Sentences are synthesized on their own task, in order, so a multi-second
    // synth never stalls captions or backs the model stream up behind a full
    // delta channel: sentence N is being voiced while N+1 is still generating.
    // `spoke` is shared rather than returned so a barge-in that aborts the
    // speaker mid-synth still closes the audio it already started with `tts_end`.
    let (sentence_tx, mut sentence_rx) = mpsc::channel::<String>(32);
    let spoke = Arc::new(AtomicBool::new(false));
    let speaker = {
        let (deps, cfg, abort, out_tx, spoke) = (
            deps.clone(),
            cfg.clone(),
            Arc::clone(&abort),
            out_tx.clone(),
            Arc::clone(&spoke),
        );
        tokio::spawn(async move {
            let mut started = false;
            // Set once the engine is reported unknown: keep draining sentences
            // (so captions never stall) but stop retrying a misconfiguration.
            let mut engine_unknown = false;
            while let Some(sentence) = sentence_rx.recv().await {
                if abort.load(Ordering::SeqCst) {
                    break;
                }
                if engine_unknown {
                    continue;
                }
                engine_unknown =
                    speak_sentence(&deps, &cfg, &sentence, &abort, &out_tx, &mut started).await;
                if started {
                    spoke.store(true, Ordering::SeqCst);
                }
            }
        })
    };

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
        // Queue synthesis without stalling captions, only when audio is enabled.
        if render_audio {
            for sentence in acc.push(&delta) {
                if abort.load(Ordering::SeqCst) || sentence_tx.send(sentence).await.is_err() {
                    aborted = true;
                    break;
                }
            }
        }
        if aborted {
            break;
        }
    }

    // Flush the trailing partial sentence (if any) once the stream ends clean.
    if render_audio && !aborted && !abort.load(Ordering::SeqCst) {
        if let Some(tail) = acc.flush() {
            let _ = sentence_tx.send(tail).await;
        }
    }
    drop(sentence_tx);

    // Reap the streamer: abort it on barge-in, else surface an error frame.
    let mut completed = false;
    if aborted {
        streamer.abort();
        speaker.abort();
    } else {
        match streamer.await {
            Ok(Ok(())) => completed = true,
            Ok(Err(e)) => {
                let _ = out_tx
                    .send(VoiceOutput::Control(VoiceServerMsg::Error {
                        code: "turn_failed".to_string(),
                        message: format!("{e:#}"),
                    }))
                    .await;
            }
            // Join error (the task panicked or was cancelled): nothing to report
            // that the client can act on, and the turn still closes below.
            Err(_) => {}
        }
        // Let queued sentences finish voicing before the turn closes. The
        // speaker stops early on its own if a barge-in lands meanwhile.
        let _ = speaker.await;
    }
    let spoke = spoke.load(Ordering::SeqCst);

    // Plugin `post_assistant_turn` hooks, fired ONLY for a turn that drained
    // cleanly. A barge-in truncates the reply mid-sentence, so firing there would
    // hand a `stop`-phase observer half an answer as if it were the turn's result —
    // and would let a hook act on a turn the user deliberately interrupted. By this
    // point the stream has finished, so the reply is already persisted and the
    // hook's transcript read sees the turn it is being fired for.
    if run_turn_hooks && completed && !abort.load(Ordering::SeqCst) {
        crate::sidecar::adapters::fire_voice_post_turn_hooks(
            deps.conversations.clone(),
            cfg.conversation_id.clone(),
            cfg.agent_id.clone(),
        );
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
) -> bool {
    if abort.load(Ordering::SeqCst) {
        return false;
    }
    match synthesize_sentence(deps, cfg, text).await {
        Ok(wav) => {
            if abort.load(Ordering::SeqCst) {
                return false;
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
            false
        }
        Err(e) => {
            tracing::warn!("voice: sentence TTS failed: {e:#}");
            // A misconfigured engine is not a transient failure: tell the client
            // (once per turn — the caller stops synthesizing) instead of going
            // silent sentence after sentence. The text reply still streams.
            let Some(unknown) = e.downcast_ref::<UnknownTtsEngine>() else {
                return false;
            };
            let _ = out_tx
                .send(VoiceOutput::Control(VoiceServerMsg::Error {
                    code: "tts_engine_unknown".to_string(),
                    message: unknown.to_string(),
                }))
                .await;
            true
        }
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

/// Synthesize one sentence to WAV bytes. An engine id that is neither built in
/// nor known to RyuTTS fails with [`UnknownTtsEngine`] instead of degrading to
/// OuteTTS (outages and render failures still degrade). Uses OuteTTS (built-in), audio.cpp, the
/// Gateway's cloud TTS slot for `gateway`, or, for any other engine id, the
/// resident RyuTTS sidecar `/generate` — the low-latency path for repeated
/// per-sentence synthesis (engine routing mirrors `server::voice::speak`; the
/// OuteTTS fallback is broader, see below).
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
    check_tts_engine_id(&engine)?;
    if engine == "outetts" {
        return crate::sidecar::providers::outetts::synthesize(text).await;
    }

    // Native audio.cpp is an explicit runtime choice. Its server returns WAV by
    // default, so it can use the same binary voice frame protocol as the other
    // local engines without changing the websocket client.
    if engine == "audiocpp" {
        let request = crate::server::voice::SpeakRequest {
            text: text.to_string(),
            engine: Some(engine),
            voice: cfg.tts_voice.clone(),
            speed: None,
            language: None,
            reference_audio: None,
            reference_audio_data_url: None,
            ..Default::default()
        };
        return crate::server::voice::synth_via_audio_cpp(&deps.client, &request, text)
            .await
            .map_err(anyhow::Error::msg);
    }

    // The cloud slot, so picking "Cloud (via gateway)" in settings works in
    // realtime voice mode too and not just in read-aloud. `VoiceOutput::Audio`
    // carries raw WAV to the client, so a provider that hands back anything
    // else (fal/replicate return a hosted mp3) is treated as a failure and
    // degrades to OuteTTS rather than streaming bytes the client cannot decode.
    if engine == "gateway" {
        match crate::server::voice::synth_via_gateway(
            &deps.client,
            cfg.tts_voice.as_deref(),
            None,
            text,
            crate::server::voice::GATEWAY_TTS_FORMAT_VOICE_SESSION,
        )
        .await
        {
            Ok((audio, content_type)) if content_type.starts_with("audio/wav") => return Ok(audio),
            Ok((_, content_type)) => {
                tracing::warn!(
                    "voice-session gateway TTS returned {content_type}, not audio/wav; \
                     falling back to OuteTTS"
                );
                return crate::sidecar::providers::outetts::synthesize(text).await;
            }
            Err(e) => {
                tracing::warn!("voice-session gateway TTS failed ({e}); falling back to OuteTTS");
                return crate::sidecar::providers::outetts::synthesize(text).await;
            }
        }
    }

    let mut body = serde_json::json!({ "text": text, "engine": engine });
    if let Some(v) = &cfg.tts_voice {
        body["voice"] = serde_json::json!(v);
    }
    // Degrade to OuteTTS if the sidecar is unreachable or the engine can't render,
    // so a voice turn never goes silent; an unknown engine (RyuTTS 404) is a
    // configuration error and is surfaced, as in `server::voice::speak`. Unlike
    // read-aloud, this degrades for *any* configured engine, not only the node
    // default: a live call carries no sample or studio option that OuteTTS
    // would ignore, and dropping a sentence mid-call is worse than a voice change.
    let sidecar_result = crate::server::voice::ryutts_generate_at(
        &deps.client,
        &crate::sidecar::providers::ryutts::tts_base_url(),
        &engine,
        &body,
    )
    .await;

    match sidecar_result {
        Ok(wav) => Ok(wav),
        Err(e) if e.is::<UnknownTtsEngine>() => {
            tracing::warn!(engine = %engine, "voice-session TTS engine is unknown: {e:#}");
            Err(e)
        }
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
            metadata: None,
            role: "user".to_owned(),
            content: UiContent::Text(prompt),
            parts: vec![],
        }],
        agent_id: cfg.agent_id.clone(),
        conversation_id: Some(cfg.conversation_id.clone()),
        // Voice mode is a user-facing chat surface — persist + interactive priority.
        persist: true,
        background: false,
        // Server-only: the request JSON cannot carry this flag, so the session's
        // start-frame trust is the one source for it.
        untrusted_caller: cfg.untrusted_caller,
        author_user_id: cfg.caller.as_ref().map(|caller| caller.user_id.clone()),
        verified_caller: cfg.caller.clone(),
        user_jwt: cfg.user_jwt.clone(),
        agent_resource_authorization: cfg.agent_authorization.clone(),
        ..ChatStreamRequest::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> VoiceConfig {
        VoiceConfig {
            conversation_id: "conv-1".into(),
            caller: None,
            user_jwt: None,
            agent_authorization: None,
            agent_id: Some("agent-x".into()),
            stt_engine: None,
            tts_engine: None,
            tts_voice: None,
            client_rate: 48_000,
            untrusted_caller: false,
        }
    }

    #[test]
    fn build_chat_request_is_persisted_interactive_single_user_turn() {
        let req = build_chat_request(&cfg(), "hello there".into());
        assert!(req.persist, "voice turns persist to conversation history");
        assert!(
            !req.background,
            "voice is interactive, not a background run"
        );
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

    /// A member's call stamps that member onto every turn, including the summary,
    /// exactly as `chat_stream` does; the owner's session stays anonymous.
    #[test]
    fn verified_caller_is_stamped_on_every_turn() {
        assert!(build_chat_request(&cfg(), "hi".into())
            .author_user_id
            .is_none());

        let mut member = cfg();
        member.caller = Some(crate::identity_verify::VerifiedCaller {
            user_id: "user-7".into(),
            email: None,
            email_verified: false,
            org_id: Some("org-1".into()),
            role: crate::identity_verify::OrgRole::Member,
            teams: vec![],
        });
        for request in [
            build_chat_request(&member, "hi".into()),
            build_chat_request(&member.for_summary(), "sum".into()),
        ] {
            assert_eq!(request.author_user_id.as_deref(), Some("user-7"));
            assert_eq!(
                request.verified_caller.as_ref().map(|c| c.user_id.as_str()),
                Some("user-7")
            );
        }
    }

    /// An owner session is unchanged: its requests are not restricted and its
    /// turns run plugin hooks, as before caller trust existed.
    #[test]
    fn owner_session_turns_are_unrestricted() {
        let owner = cfg();
        assert!(!build_chat_request(&owner, "hi".into()).untrusted_caller);
        assert!(owner.runs_turn_hooks());
        assert!(!build_chat_request(&owner.for_summary(), "sum".into()).untrusted_caller);
    }

    /// An unverified caller's session marks every request it builds, including
    /// the post-call summary, and skips plugin turn hooks.
    #[test]
    fn untrusted_caller_session_restricts_every_turn() {
        let mut caller = cfg();
        caller.untrusted_caller = true;
        let request = build_chat_request(&caller, "what's on the calendar?".into());
        assert!(request.untrusted_caller);
        assert!(!caller.runs_turn_hooks());
        let summary = caller.for_summary();
        assert!(summary.agent_id.is_none(), "summary uses the default agent");
        assert!(build_chat_request(&summary, "sum".into()).untrusted_caller);
    }

    #[test]
    fn tts_engine_ids_are_checked_before_synthesis() {
        for engine in [
            "outetts",
            "audiocpp",
            "gateway",
            "kokoro",
            "pocket",
            "audio_cpp",
        ] {
            assert!(check_tts_engine_id(engine).is_ok(), "{engine}");
        }
        for engine in ["Kokoro", "kokoro ", "../pocket", ""] {
            let error = check_tts_engine_id(engine).expect_err(engine);
            assert!(error.to_string().contains("unknown TTS engine"), "{error}");
        }
    }

    #[test]
    fn capture_cap_flushes_the_utterance_and_keeps_recording() {
        let mut capture = UtteranceCapture::default();
        capture.start([1_i16; 10]);
        let chunk = vec![7_i16; VAD_RATE as usize / 10];
        let mut flushes = 0;
        // 61 s of continuous speech with no VAD end-of-speech.
        for _ in 0..610 {
            if capture.append(&chunk) {
                flushes += 1;
                let (segment, still_capturing) = capture.take();
                let segment = segment.expect("the capped audio is kept, not discarded");
                assert!(still_capturing, "recording continues after a flush");
                assert!(segment.len() <= MAX_CAPTURE_SAMPLES);
                assert!(segment.len() > MAX_CAPTURE_SAMPLES - chunk.len());
                assert_eq!(
                    &segment[..10],
                    &[1_i16; 10],
                    "pre-roll is part of the first segment"
                );
            }
        }
        assert_eq!(flushes, 1);
        // The remainder (~1 s) is the next utterance when speech ends.
        capture.stop();
        let (rest, still_capturing) = capture.take();
        assert!(!still_capturing);
        let rest = rest.expect("speech after the flush is kept");
        assert!(rest.len() >= VAD_RATE as usize && rest.len() < 2 * VAD_RATE as usize);
        assert_eq!(capture.take().0, None);
    }

    #[test]
    fn capture_ignores_audio_when_not_recording_and_clear_drops_flushed() {
        let mut capture = UtteranceCapture::default();
        assert!(!capture.append(&[1, 2, 3]));
        assert_eq!(capture.take().0, None);
        capture.start([]);
        capture.append(&vec![0_i16; MAX_CAPTURE_SAMPLES]);
        assert!(capture.append(&[5]));
        capture.clear();
        assert_eq!(capture.take().0, None);
    }

    /// A member's session carries their identity into every turn (including the
    /// summary) so the chat path applies their authorization, not node authority.
    #[test]
    fn member_session_turns_carry_the_verified_caller() {
        assert!(build_chat_request(&cfg(), "hi".into())
            .verified_caller
            .is_none());
        let mut member = cfg();
        member.caller = Some(crate::identity_verify::VerifiedCaller {
            user_id: "user-1".into(),
            email: None,
            email_verified: false,
            org_id: Some("org-1".into()),
            role: crate::identity_verify::OrgRole::Member,
            teams: Vec::new(),
        });
        for config in [member.clone(), member.for_summary()] {
            let req = build_chat_request(&config, "hi".into());
            assert_eq!(req.author_user_id.as_deref(), Some("user-1"));
            assert_eq!(
                req.verified_caller.map(|caller| caller.user_id).as_deref(),
                Some("user-1")
            );
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
