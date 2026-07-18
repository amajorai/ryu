//! Ryu Hardware Protocol WebSocket handler (`GET /api/hardware/ws`).
//!
//! Implements PROTOCOL.md §2–4: the realtime device link. A device (or the phone
//! relay in Mode A) connects, sends `hello`, and then streams control TEXT frames
//! + Opus audio BINARY frames. This handler authenticates the device token, opens
//! the per-connection [`HardwareSession`], and bridges every turn IN-PROCESS to
//! the existing Core seams (chat via `run_text_turn`, ASR/TTS via `voice`,
//! ambient via the meetings pipeline) — never self-HTTP.
//!
//! ## Auth placement
//!
//! This route lives on the **public** router, not behind `require_auth`. That
//! middleware compares a `Bearer` against the single global `RYU_TOKEN`, but a
//! device presents a *per-device* token, which would never match. We instead
//! authenticate the device token against the registry here, after the `hello`
//! frame names the `device_id`: a connection is refused unless the device is
//! already paired AND presents the matching per-device token — on every bind,
//! loopback included (pair over loopback first via `POST /api/hardware/pair`).
//! That registry lookup also loads the device's saved ambient meeting + prefs.
//!
//! ## Concurrency / barge-in
//!
//! The socket is split: a dedicated send task drains an `mpsc` of
//! [`SessionOutput`] to the wire, while the recv task reads frames and runs
//! turns. An [`AtomicBool`] abort flag (set on a `text`-frame `abort`) is checked
//! by the send task before each queued audio frame, so a barge-in stops TTS
//! within one frame instead of waiting for the whole reply to drain.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::HeaderMap,
    response::IntoResponse,
};
use tokio::sync::mpsc;

use super::ServerState;
use crate::hardware::turn::{run_chat_turn, ChatTurn, SessionDeps};
use ryu_hardware::protocol::{RhpClientMsg, RhpServerMsg};
use ryu_hardware::session::{live, HardwareSession, SessionOutput, TurnInput};
use ryu_hardware::MeetingIngest;

/// `GET /api/hardware/ws` — upgrade to the RHP WebSocket. The Bearer device token
/// rides on the upgrade request headers; it is captured here and verified inside
/// the socket task once `hello` names the device.
#[utoipa::path(
    get,
    path = "/api/hardware/ws",
    tag = "Hardware",
    summary = "upgrade to the RHP WebSocket. The Bearer device token",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn hardware_ws(
    ws: WebSocketUpgrade,
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string);
    ws.on_upgrade(move |socket| handle_socket(socket, state, bearer))
}

/// Pick the agent that handles device chat turns. A device-chat-agent preference
/// lets the user route hardware through a specific persona; absent it, the
/// default LLM path is used (`agent_id = None`).
async fn device_chat_agent(state: &ServerState) -> Option<String> {
    state
        .preferences
        .get("hardware-chat-agent")
        .await
        .ok()
        .flatten()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Build the in-process seam bundle the chat turn drives, cloning the same store
/// handles `ServerState` already holds. The ambient meetings engine is no longer
/// part of this bundle — it moved to the crate's [`HardwareSession`] (the buffering
/// side); this bundle carries only what [`run_chat_turn`] consumes.
fn session_deps(state: &ServerState, agent_id: Option<String>) -> SessionDeps {
    SessionDeps {
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
        agent_id,
    }
}

/// Wrap a pure [`TurnInput`] (taken from the crate's session buffer) in the
/// kernel-welded [`ChatTurn`] the WS pump spawns. The session owns the stable
/// per-device `conversation_id` + the resolved `agent_id`; the deps come from
/// `ServerState`.
fn build_turn(state: &ServerState, session: &HardwareSession, input: TurnInput) -> ChatTurn {
    ChatTurn {
        input,
        deps: session_deps(state, session.agent_id.clone()),
        conversation_id: session.conversation_id.clone(),
    }
}

/// Open (or resume) the long-running ambient meeting for an ambient-capable
/// device. A device row persists its `ambient_meeting_id`; on reconnect we resume
/// the same meeting (so the 24/7 transcript is continuous) rather than spawning a
/// fresh one each `hello`. Returns the meeting id, or `None` on failure (the
/// device still works for chat).
async fn open_or_resume_ambient(
    state: &ServerState,
    ingest: &dyn MeetingIngest,
    device_id: &str,
) -> Option<String> {
    // Prefer the saved meeting if it still exists.
    if let Ok(Some(record)) = state.hardware.get(device_id).await {
        if let Some(prev) = record.ambient_meeting_id {
            if ingest.meeting_exists(&prev).await {
                return Some(prev);
            }
        }
    }
    // Otherwise start a new ambient meeting and remember it on the device row. The
    // ambient provenance (app = `ryu-hardware`, source = auto) is baked into the
    // `MeetingIngest` impl.
    let title = format!("Ambient — {device_id}");
    match ingest.start_meeting(title).await {
        Ok(meeting_id) => {
            let _ = state
                .hardware
                .set_ambient_meeting(device_id, &meeting_id)
                .await;
            Some(meeting_id)
        }
        Err(e) => {
            tracing::warn!("hardware: opening ambient meeting failed: {e}");
            None
        }
    }
}

/// Per-connection driver: handshake, then the concurrent send/recv pump.
async fn handle_socket(socket: WebSocket, state: ServerState, bearer: Option<String>) {
    use futures_util::{SinkExt, StreamExt};

    let (mut ws_tx, mut ws_rx) = socket.split();

    // ── Handshake: the first frame must be `hello` ──────────────────────────
    let hello = loop {
        match ws_rx.next().await {
            Some(Ok(Message::Text(text))) => match serde_json::from_str::<RhpClientMsg>(&text) {
                Ok(msg @ RhpClientMsg::Hello { .. }) => break msg,
                Ok(_) => {
                    let _ = ws_tx
                        .send(error_frame("expected_hello", "first frame must be `hello`"))
                        .await;
                    return;
                }
                Err(e) => {
                    let _ = ws_tx
                        .send(error_frame("bad_json", &format!("malformed hello: {e}")))
                        .await;
                    return;
                }
            },
            Some(Ok(Message::Close(_))) | None => return,
            // Ignore pings/binary before hello.
            Some(Ok(_)) => continue,
            Some(Err(_)) => return,
        }
    };

    let RhpClientMsg::Hello {
        device_id,
        device_type,
        caps,
        ..
    } = hello
    else {
        return;
    };

    // ── Authenticate the device token against the registry ──────────────────
    // The only path to a usable connection is to PAIR first
    // (`POST /api/hardware/pair`, public + nonce-gated), which registers the
    // device and mints its per-device token. So we reject:
    //   - any device_id with no registry row (unpaired), and
    //   - a registered device whose presented Bearer doesn't match its stored hash.
    // This holds on every bind (loopback included — pair over loopback first),
    // which is what makes the public WS route safe on a mesh/non-loopback node
    // where `require_auth` (global RYU_TOKEN) can't gate a per-device token.
    let registered = matches!(state.hardware.get(&device_id).await, Ok(Some(_)));
    let token_ok = match &bearer {
        Some(token) => state
            .hardware
            .verify_token(&device_id, token)
            .await
            .unwrap_or(false),
        None => false,
    };
    if !(registered && token_ok) {
        let _ = ws_tx
            .send(error_frame(
                "unauthorized",
                "unknown or unauthenticated device; pair first via POST /api/hardware/pair",
            ))
            .await;
        return;
    }

    // ── Meeting-ingest seam ─────────────────────────────────────────────────
    // The ambient audio path reaches meetings through the `MeetingIngest` trait
    // (not a direct engine field), so the kernel `ryu-hardware` crate links no
    // meetings code. Meetings is out-of-process; the `MeetingsClient` IS the
    // sidecar-backed impl (each call is one loopback hop to `ryu-meetings`).
    let ingest: Arc<dyn MeetingIngest> = Arc::new(state.meetings.clone());

    // ── Open/resume the ambient session for ambient-capable devices ─────────
    let ambient_capable = device_type.ambient_capable() && caps.mic;
    let ambient_session_id = if ambient_capable {
        open_or_resume_ambient(&state, ingest.as_ref(), &device_id).await
    } else {
        None
    };

    // ── Build the session ───────────────────────────────────────────────────
    let agent_id = device_chat_agent(&state).await;
    let mut session = match HardwareSession::new(
        device_id.clone(),
        device_type,
        caps,
        ambient_session_id.clone(),
        Arc::clone(&ingest),
        agent_id,
    ) {
        Ok(s) => s,
        Err(e) => {
            let _ = ws_tx
                .send(error_frame("session_init", &format!("{e}")))
                .await;
            return;
        }
    };

    // ── Ack ─────────────────────────────────────────────────────────────────
    let ack = RhpServerMsg::HelloAck {
        session_id: format!("hwses_{}", uuid::Uuid::new_v4().simple()),
        ambient_session_id: ambient_session_id.clone(),
        tts: HardwareSession::tts_format(),
    };
    if ws_tx.send(text_frame(&ack)).await.is_err() {
        return;
    }
    let _ = state.hardware.touch(&device_id, None).await;

    // ── Concurrent send task fed by an mpsc of session outputs ──────────────
    let (out_tx, mut out_rx) = mpsc::channel::<SessionOutput>(256);
    // Register this device's outbound sender so out-of-band producers (the
    // dashboard nudge loop, the ambient rolling-summary) can push a `display`
    // re-poll signal to it without holding the socket (review gap #4).
    live::register(&device_id, out_tx.clone()).await;
    // Shared barge-in flag: set by the recv side on `abort`, read by the send
    // side to drop queued TTS audio mid-stream.
    let abort = Arc::new(AtomicBool::new(false));
    let send_abort = Arc::clone(&abort);
    let send_task = tokio::spawn(async move {
        while let Some(output) = out_rx.recv().await {
            let msg = match output {
                SessionOutput::Control(ctrl) => text_frame(&ctrl),
                SessionOutput::Audio(bytes) => {
                    // Barge-in: drop queued audio while aborting. The abort flag is
                    // reset by the recv loop at the START of each new turn, so a
                    // fresh turn's audio is never dropped by a stale abort.
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

    // The in-flight chat turn (spawned off this loop so the loop stays responsive
    // to `abort`/audio while the model + TTS run). At most one runs at a time;
    // a new turn aborts and supersedes the old one (barge-in-then-speak).
    let mut turn_handle: Option<tokio::task::JoinHandle<()>> = None;

    // ── Receive loop ────────────────────────────────────────────────────────
    while let Some(frame) = ws_rx.next().await {
        let frame = match frame {
            Ok(f) => f,
            Err(_) => break,
        };
        match frame {
            Message::Text(text) => {
                let msg = match serde_json::from_str::<RhpClientMsg>(&text) {
                    Ok(m) => m,
                    Err(e) => {
                        let _ = out_tx
                            .send(SessionOutput::Control(RhpServerMsg::Error {
                                code: "bad_json".to_string(),
                                message: format!("{e}"),
                            }))
                            .await;
                        continue;
                    }
                };
                match handle_control(&state, &mut session, &device_id, msg, &out_tx, &abort).await {
                    ControlOutcome::Continue => {}
                    ControlOutcome::StartTurn(turn) => {
                        // Serialize turns: abort + drain any prior turn, then reset
                        // the flag so the new turn speaks, and spawn it.
                        abort.store(true, Ordering::SeqCst);
                        if let Some(prev) = turn_handle.take() {
                            let _ = prev.await;
                        }
                        abort.store(false, Ordering::SeqCst);
                        turn_handle = Some(tokio::spawn(run_chat_turn(
                            turn,
                            Arc::clone(&abort),
                            out_tx.clone(),
                        )));
                    }
                }
            }
            Message::Binary(bytes) => {
                // An Opus audio packet for the current mode.
                match session.on_audio(&bytes).await {
                    Ok(outputs) => {
                        for o in outputs {
                            if out_tx.send(o).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(e) => tracing::debug!("hardware: audio frame dropped: {e:#}"),
                }
            }
            Message::Ping(_) | Message::Pong(_) => {}
            Message::Close(_) => break,
        }
    }

    // Tear down: signal abort, drop the sender so the send task ends, and wait for
    // any in-flight turn + the send task to finish.
    live::unregister(&device_id).await;
    abort.store(true, Ordering::SeqCst);
    drop(out_tx);
    if let Some(handle) = turn_handle.take() {
        let _ = handle.await;
    }
    let _ = send_task.await;
}

/// What the recv loop should do after a control frame.
enum ControlOutcome {
    /// Keep looping.
    Continue,
    /// Spawn this chat turn (the loop owns the join handle for serialization).
    StartTurn(ChatTurn),
}

/// Dispatch one decoded control message. Side-effecting frames (mode, telemetry,
/// ping, abort) are handled inline; a `listen:stop` / `text` returns the turn to
/// spawn so the recv loop can serialize and own its join handle.
async fn handle_control(
    state: &ServerState,
    session: &mut HardwareSession,
    device_id: &str,
    msg: RhpClientMsg,
    out_tx: &mpsc::Sender<SessionOutput>,
    abort: &Arc<AtomicBool>,
) -> ControlOutcome {
    match msg {
        RhpClientMsg::Hello { .. } => {
            // A second hello is ignored (the session is already established).
        }
        RhpClientMsg::Mode { value } => {
            session.set_mode(value);
        }
        RhpClientMsg::Listen { state: listen } => match listen {
            ryu_hardware::protocol::ListenState::Start => {
                // Do NOT clear `abort` here: a `listen:start` arriving while an old
                // turn is still speaking (user talks over the assistant) must not
                // un-abort that turn. The flag is reset by the `StartTurn` path
                // after the prior turn is drained, which is the only safe point.
                session.on_listen_start();
                let _ = out_tx
                    .send(SessionOutput::Control(RhpServerMsg::Emotion {
                        value: ryu_hardware::protocol::Emotion::Listening,
                    }))
                    .await;
            }
            ryu_hardware::protocol::ListenState::Stop => {
                if let Some(input) = session.take_voice_turn() {
                    return ControlOutcome::StartTurn(build_turn(state, session, input));
                }
            }
        },
        RhpClientMsg::Text { content } => {
            if let Some(input) = session.take_text_turn(&content) {
                return ControlOutcome::StartTurn(build_turn(state, session, input));
            }
        }
        RhpClientMsg::Abort => {
            // Barge-in: tell the send task to drop queued TTS audio now.
            abort.store(true, Ordering::SeqCst);
            let _ = out_tx
                .send(SessionOutput::Control(RhpServerMsg::TtsEnd))
                .await;
        }
        RhpClientMsg::CameraMeta { .. } => {
            // The next BINARY frame is a JPEG. Vision capture is firmware-complete
            // but the node-side vision turn is a documented follow-on; ack-free for
            // now so the device isn't blocked.
        }
        RhpClientMsg::Telemetry {
            battery_pct,
            charging,
            ..
        } => {
            let _ = charging;
            let _ = state.hardware.touch(device_id, Some(battery_pct)).await;
        }
        RhpClientMsg::Ping => {
            let _ = out_tx
                .send(SessionOutput::Control(RhpServerMsg::Pong))
                .await;
        }
    }
    ControlOutcome::Continue
}

/// Serialize a server control message into a WS TEXT frame.
fn text_frame(msg: &RhpServerMsg) -> Message {
    Message::Text(serde_json::to_string(msg).unwrap_or_else(|_| "{}".to_string()))
}

/// Build an `error` TEXT frame.
fn error_frame(code: &str, message: &str) -> Message {
    text_frame(&RhpServerMsg::Error {
        code: code.to_string(),
        message: message.to_string(),
    })
}
