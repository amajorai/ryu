//! Kernel-welded chat-turn orchestration for the RHP device link.
//!
//! The per-connection buffering state machine, the device registry, the codec
//! edge, the live sender registry, and the display nudge loop all live in the
//! extracted [`ryu_hardware`] crate. This module is the **irreducible kernel
//! remainder**: running one captured turn end-to-end through Core's own session
//! seams — [`run_text_turn`] (the same non-stream text-turn primitive the off-chat
//! `AgentRunner` uses), the voice ASR path ([`crate::server::voice`]), and OuteTTS
//! ([`crate::sidecar::providers::outetts`]). Every one of those is an `apps/core`
//! kernel type, so — exactly like the teams `@team`-orchestration precedent — this
//! orchestration stays Core-side as a consumer of the crate's
//! [`ryu_hardware::TurnInput`] / [`ryu_hardware::SessionOutput`] /
//! [`ryu_hardware::protocol`] types.

use std::sync::Arc;

use anyhow::Result;

use crate::agents::AgentStore;
use crate::server::conversations::ConversationStore;
use crate::server::memory::MemoryStore;
use crate::sidecar::adapters::{run_text_turn, AcpAgentRegistry};
use crate::sidecar::mcp::McpRegistry;
use crate::sidecar::SidecarManager;
use ryu_hardware::codec::{self, DownlinkEncoder, DOWNLINK_RATE, UPLINK_RATE};
use ryu_hardware::protocol::{Emotion, RhpServerMsg};
use ryu_hardware::session::{SessionOutput, TurnInput};
use ryu_skills::SkillRegistry;
use ryu_tracing::TraceStore;

/// The store handles the chat turn needs to run a model turn through the real chat
/// path. Cloned out of `ServerState` at connect (the same bundle `AgentRunner`
/// holds), so the turn can drive the configured agent without a `ServerState`.
///
/// Holds only what [`run_text_turn`] consumes; the ambient meetings engine moved to
/// the crate's [`ryu_hardware::HardwareSession`] (the buffering side), so it is no
/// longer part of this bundle.
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
    /// The agent that handles device chat turns (None = the default LLM path).
    pub agent_id: Option<String>,
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

    #[test]
    fn sentence_chunks_splits_on_newline_and_keeps_trailing_tail() {
        // Newline is a terminator; the terminator-less tail is still emitted.
        let chunks = sentence_chunks("line one\nline two. tail no dot");
        assert_eq!(chunks, vec!["line one", "line two.", "tail no dot"]);
    }

    #[test]
    fn sentence_chunks_drops_whitespace_only_segments_between_terminators() {
        // The blank lines between the two sentences are whitespace-only segments
        // that must not produce empty chunks.
        let chunks = sentence_chunks("One.\n\n\nTwo.");
        assert_eq!(chunks, vec!["One.", "Two."]);
    }
}
