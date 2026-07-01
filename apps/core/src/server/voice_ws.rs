//! Realtime voice-mode WebSocket handler (`GET /api/voice/ws`).
//!
//! The node side of the ChatGPT-style desktop/island voice mode (see
//! `crate::voice`). A first-party renderer upgrades, sends a `start` frame, then
//! streams mic PCM16 as BINARY frames while the server runs the realtime loop
//! (VAD → STT → streaming LLM → per-sentence TTS) and streams control frames +
//! WAV audio back.
//!
//! ## Auth placement (auth-in-handler, mirroring `realtime_ws` / `hardware_ws`)
//!
//! On the **public** router, not behind `require_auth`: a browser WS upgrade can't
//! set the bearer header, so the node-admittance token rides `?token=` (or an
//! `Authorization: Bearer` for non-browser clients). If `RYU_TOKEN` is configured
//! the upgrade is rejected unless it matches; unconfigured (loopback dev) allows.
//! Voice mode is the single local user, so there is no per-resource access
//! decision here (unlike `realtime_ws`'s room ACL).
//!
//! ## Concurrency / barge-in
//!
//! The socket is split: a send task drains an `mpsc` of [`VoiceOutput`] to the wire
//! (control → TEXT, audio → BINARY), while the recv task reads frames and drives
//! the session. A shared [`AtomicBool`] abort flag is set when the VAD detects the
//! user talking over the reply (or on an explicit `abort`); the send task drops
//! queued TTS audio while it is set, so a barge-in stops playback within one frame.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use tokio::sync::mpsc;

use super::ServerState;
use crate::voice::protocol::{VoiceClientMsg, VoiceServerMsg, VoiceState};
use crate::voice::session::{
    run_voice_turn, VoiceConfig, VoiceEvent, VoiceOutput, VoiceSession, VoiceSessionDeps,
    TTS_SAMPLE_RATE,
};

/// Query params on the upgrade URL. `token` is the node-admittance `RYU_TOKEN`
/// (also accepted via `Authorization: Bearer`); `jwt` is accepted for parity with
/// the other WS routes but unused here (voice mode is the local user).
#[derive(Debug, Default, Deserialize)]
pub struct VoiceQuery {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    jwt: Option<String>,
}

/// `GET /api/voice/ws` — upgrade to the voice-mode socket. Node admittance is
/// resolved here (pre-upgrade); the session opens once the `start` frame arrives.
pub async fn voice_ws(
    ws: WebSocketUpgrade,
    State(state): State<ServerState>,
    headers: HeaderMap,
    Query(query): Query<VoiceQuery>,
) -> Response {
    // Node admittance (mirror `require_auth` / `realtime_ws`): enforce only a
    // non-empty configured token; empty/unset = loopback dev, allow.
    if let Some(expected) = state
        .node_token
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let provided = query
            .token
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .or_else(|| bearer_token(&headers));
        if provided.as_deref() != Some(expected) {
            return (StatusCode::UNAUTHORIZED, "missing or invalid node token").into_response();
        }
    }

    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

/// Extract a bearer token from the `Authorization` header.
fn bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// Build the in-process seam bundle a session drives (same handles `ServerState`
/// holds — the exact set the streaming chat path needs).
fn session_deps(state: &ServerState) -> VoiceSessionDeps {
    VoiceSessionDeps {
        registry: Arc::clone(&state.agents),
        conversations: state.conversations.clone(),
        agent_store: state.agent_store.clone(),
        manager: Arc::clone(&state.manager),
        memory: state.memory.clone(),
        worktree_diffs: Arc::clone(&state.worktree_diffs),
        mcp: Arc::clone(&state.mcp),
        skills: state.skills.clone(),
        traces: state.traces.clone(),
        client: state.client.clone(),
    }
}

/// Decode a BINARY frame of little-endian PCM16 into i16 samples.
fn pcm_from_bytes(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect()
}

/// Per-connection driver: handshake on `start`, then the concurrent send/recv pump.
async fn handle_socket(socket: WebSocket, state: ServerState) {
    use futures_util::{SinkExt, StreamExt};

    let (mut ws_tx, mut ws_rx) = socket.split();

    // ── Handshake: the first frame must be `start` ───────────────────────────
    let start = loop {
        match ws_rx.next().await {
            Some(Ok(Message::Text(text))) => match serde_json::from_str::<VoiceClientMsg>(&text) {
                Ok(msg @ VoiceClientMsg::Start { .. }) => break msg,
                Ok(_) => {
                    let _ = ws_tx
                        .send(error_frame("expected_start", "first frame must be `start`"))
                        .await;
                    return;
                }
                Err(e) => {
                    let _ = ws_tx
                        .send(error_frame("bad_json", &format!("malformed start: {e}")))
                        .await;
                    return;
                }
            },
            Some(Ok(Message::Close(_))) | None => return,
            Some(Ok(_)) => continue,
            Some(Err(_)) => return,
        }
    };

    let VoiceClientMsg::Start {
        conversation_id,
        sample_rate,
        agent_id,
        stt_engine,
        tts_engine,
        tts_voice,
    } = start
    else {
        return;
    };

    let session_id = format!("vs_{}", uuid::Uuid::new_v4().simple());
    let cfg = VoiceConfig {
        // Ephemeral sessions get a stable id so ChatEnd + persistence have a key.
        conversation_id: conversation_id.unwrap_or_else(|| format!("voice_{session_id}")),
        agent_id,
        stt_engine,
        tts_engine,
        tts_voice,
        client_rate: sample_rate.max(8_000),
    };
    let mut session = VoiceSession::new(cfg, session_deps(&state));

    // ── Ack ──────────────────────────────────────────────────────────────────
    let ready = VoiceServerMsg::Ready {
        session_id,
        tts_sample_rate: TTS_SAMPLE_RATE,
    };
    if ws_tx.send(text_frame(&ready)).await.is_err() {
        return;
    }

    // ── Send task fed by an mpsc of session outputs ──────────────────────────
    let (out_tx, mut out_rx) = mpsc::channel::<VoiceOutput>(256);
    // Shared barge-in flag: set on VAD onset over the reply (or explicit `abort`),
    // read by the send side to drop queued TTS audio mid-stream.
    let abort = Arc::new(AtomicBool::new(false));
    let send_abort = Arc::clone(&abort);
    let send_task = tokio::spawn(async move {
        while let Some(output) = out_rx.recv().await {
            let msg = match output {
                VoiceOutput::Control(ctrl) => text_frame(&ctrl),
                VoiceOutput::Audio(bytes) => {
                    // Barge-in: drop queued audio while aborting. The flag is reset
                    // by the recv loop when it spawns the next turn, so a fresh
                    // turn's audio is never dropped by a stale abort.
                    if send_abort.load(Ordering::SeqCst) {
                        continue;
                    }
                    Message::Binary(bytes)
                }
            };
            if ws_tx.send(msg).await.is_err() {
                break;
            }
        }
    });

    // The in-flight turn (spawned off this loop so the loop stays responsive to
    // audio + barge-in while the model + TTS run). At most one at a time.
    let mut turn_handle: Option<tokio::task::JoinHandle<()>> = None;

    // ── Receive loop ─────────────────────────────────────────────────────────
    while let Some(frame) = ws_rx.next().await {
        let frame = match frame {
            Ok(f) => f,
            Err(_) => break,
        };
        match frame {
            Message::Binary(bytes) => {
                let pcm = pcm_from_bytes(&bytes);
                if pcm.is_empty() {
                    continue;
                }
                for ev in session.on_audio(&pcm) {
                    match ev {
                        VoiceEvent::SpeechStart => {
                            let turn_active =
                                turn_handle.as_ref().is_some_and(|h| !h.is_finished());
                            // Barge-in: the user is talking over an in-flight reply.
                            if turn_active {
                                abort.store(true, Ordering::SeqCst);
                                let _ = out_tx
                                    .send(VoiceOutput::Control(VoiceServerMsg::StopPlayback))
                                    .await;
                            }
                            let _ = out_tx
                                .send(VoiceOutput::Control(VoiceServerMsg::State {
                                    value: VoiceState::Listening,
                                }))
                                .await;
                            let _ = out_tx
                                .send(VoiceOutput::Control(VoiceServerMsg::SpeechStart))
                                .await;
                        }
                        VoiceEvent::SpeechEnd => {
                            if let Some(turn) = session.take_utterance_turn() {
                                spawn_turn(turn, &abort, &out_tx, &mut turn_handle).await;
                            }
                        }
                    }
                }
            }
            Message::Text(text) => {
                let msg = match serde_json::from_str::<VoiceClientMsg>(&text) {
                    Ok(m) => m,
                    Err(e) => {
                        let _ = out_tx
                            .send(VoiceOutput::Control(VoiceServerMsg::Error {
                                code: "bad_json".to_string(),
                                message: format!("{e}"),
                            }))
                            .await;
                        continue;
                    }
                };
                match msg {
                    // A second `start` is ignored (session already established).
                    VoiceClientMsg::Start { .. } => {}
                    VoiceClientMsg::Text { content } => {
                        if let Some(turn) = session.make_text_turn(&content) {
                            spawn_turn(turn, &abort, &out_tx, &mut turn_handle).await;
                        }
                    }
                    VoiceClientMsg::Abort => {
                        abort.store(true, Ordering::SeqCst);
                        let _ = out_tx
                            .send(VoiceOutput::Control(VoiceServerMsg::StopPlayback))
                            .await;
                    }
                    VoiceClientMsg::Ping => {
                        let _ = out_tx
                            .send(VoiceOutput::Control(VoiceServerMsg::Pong))
                            .await;
                    }
                }
            }
            Message::Ping(_) | Message::Pong(_) => {}
            Message::Close(_) => break,
        }
    }

    // Teardown: signal abort, drop the sender so the send task ends, and await any
    // in-flight turn + the send task.
    abort.store(true, Ordering::SeqCst);
    drop(out_tx);
    if let Some(handle) = turn_handle.take() {
        let _ = handle.await;
    }
    let _ = send_task.await;
}

/// Serialize turns: abort + drain any prior turn, reset the flag so the new turn
/// speaks, then spawn it. Mirrors the hardware handler's barge-in-then-speak.
async fn spawn_turn(
    turn: crate::voice::session::VoiceTurn,
    abort: &Arc<AtomicBool>,
    out_tx: &mpsc::Sender<VoiceOutput>,
    turn_handle: &mut Option<tokio::task::JoinHandle<()>>,
) {
    abort.store(true, Ordering::SeqCst);
    if let Some(prev) = turn_handle.take() {
        let _ = prev.await;
    }
    abort.store(false, Ordering::SeqCst);
    *turn_handle = Some(tokio::spawn(run_voice_turn(
        turn,
        Arc::clone(abort),
        out_tx.clone(),
    )));
}

/// Serialize a server control message into a WS TEXT frame.
fn text_frame(msg: &VoiceServerMsg) -> Message {
    Message::Text(serde_json::to_string(msg).unwrap_or_else(|_| "{}".to_string()))
}

/// Build an `error` TEXT frame.
fn error_frame(code: &str, message: &str) -> Message {
    text_frame(&VoiceServerMsg::Error {
        code: code.to_string(),
        message: message.to_string(),
    })
}
