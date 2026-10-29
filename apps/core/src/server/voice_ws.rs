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
//! On the **public** router because a browser WebSocket constructor cannot set an
//! authorization header. Clients first exchange normal HTTP credentials for a
//! short-lived, one-use ticket at `/api/ws/ticket`; the ticket carries the
//! verified caller and node-token generation without putting credentials in the
//! upgrade URL. A managed member's session credential can mint a voice ticket
//! too (see `ws_ticket`); such a ticket names the verified member, who then gets
//! the same `agent.run` RBAC, agent ACL and conversation gate as typed chat, and
//! whose identity is stamped on every voice turn.
//!
//! ## Per-conversation ACL
//!
//! The `start` frame carries a CLIENT-SUPPLIED `conversation_id` that flows
//! straight into the chat path (history as context, turns appended). That made this
//! route an exact re-open of the `POST /api/chat/stream` bypass the conversation
//! ACL closed: a user could name someone else's conversation id and have that
//! thread read back and written to. It is now gated by
//! [`crate::server::gate_and_claim_conversation`] — the SAME create-or-use gate
//! `chat_stream` uses — before the session is built. An unbound personal node is
//! unaffected (the gate is a no-op there).
//!
//! ## Agent-run ACL
//!
//! A member ticket (one minted with a forwarded user JWT) also gets the
//! `chat_stream` agent gates before `ready`: `agent.run`, and the exact-agent
//! ACL when `start` names a concrete agent. The verified caller and its agent
//! ACL ride on every turn's `ChatStreamRequest`, so `route_chat_stream` applies
//! the member's own authorization instead of node authority.
//!
//! ## Caller trust
//!
//! The Gateway's PSTN bridge opens a session for each phone call and sends
//! `caller_trusted: false` on `start` for a caller the line does not list as
//! trusted. That session's turns then run under the untrusted-caller tool
//! profile (see `sidecar::adapters::UNTRUSTED_CALLER_TOOL_ALLOWLIST`). The flag
//! can only restrict: absent or `true` is the owner's normal session, and the
//! value is read once from the first `start` frame, so a later frame cannot
//! lift it.
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
use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
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

/// Query params on the upgrade URL. The opaque one-use ticket is the only
/// accepted credential; node/user credentials must be exchanged over HTTP first.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VoiceQuery {
    #[serde(default)]
    ticket: Option<String>,
}

/// `GET /api/voice/ws` — upgrade to the voice-mode socket. Node admittance is
/// resolved here (pre-upgrade); the session opens once the `start` frame arrives.
#[utoipa::path(
    get,
    path = "/api/voice/ws",
    tag = "Voice",
    summary = "upgrade to the voice-mode socket. Node admittance is",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn voice_ws(
    ws: WebSocketUpgrade,
    State(state): State<ServerState>,
    Query(query): Query<VoiceQuery>,
) -> Response {
    let ticket = match crate::server::ws_ticket::consume(
        query.ticket.as_deref(),
        crate::server::ws_ticket::WsTicketRoute::Voice,
        None,
    ) {
        Some(ticket) => ticket,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                "missing or invalid WebSocket ticket",
            )
                .into_response();
        }
    };
    let caller = ticket.caller.clone();
    if ticket
        .jwt_expires_at
        .is_some_and(|expires_at| expires_at <= chrono::Utc::now().timestamp())
    {
        return (
            StatusCode::UNAUTHORIZED,
            "WebSocket ticket user identity expired",
        )
            .into_response();
    }
    // A voice turn is a chat turn: a verified caller gets the same `agent.run`
    // RBAC `chat_stream` applies, checked before the upgrade so a refused member
    // gets a plain 403. A ticket with no caller is the node owner's own session
    // (Desktop, Island, the Gateway phone bridge) and keeps its existing trust.
    if caller.is_some()
        && super::enforce_permission(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_RUN,
        )
        .await
        .is_err()
    {
        return (StatusCode::FORBIDDEN, "insufficient permissions: agent.run").into_response();
    }
    let token_generation = ticket.node_generation;
    ws.on_upgrade(move |socket| handle_socket(socket, state, caller, token_generation, ticket))
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
        subscription_costs: state.subscription_costs.clone(),
        mcp: Arc::clone(&state.mcp),
        skills: state.skills.clone(),
        traces: state.traces.clone(),
        client: state.client.clone(),
    }
}

/// Map the `start` frame's `caller_trusted` to the session restriction. Only an
/// explicit `false` restricts; absent and `true` both mean the owner's session,
/// so sending `true` grants nothing a client did not already have.
fn restricts_to_untrusted_caller(caller_trusted: Option<bool>) -> bool {
    caller_trusted == Some(false)
}

/// The `chat_stream` agent-run gates for a voice session: the collection-level
/// `agent.run` permission, then the exact-agent ACL when the `start` frame names
/// a concrete agent (the auto sentinel is resolved, and re-checked, per turn).
async fn enforce_voice_agent_run(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    agent_id: Option<&str>,
) -> Result<(), String> {
    let permission = crate::identity_verify::permissions::AGENT_RUN;
    if super::enforce_permission(state, caller, permission)
        .await
        .is_err()
    {
        return Err(format!("insufficient permissions: {permission}"));
    }
    let Some(agent_id) = agent_id.filter(|id| *id != crate::agent_routing::AUTO_AGENT_ID) else {
        return Ok(());
    };
    if !crate::fleet::is_agent_available(agent_id) {
        return Err(format!(
            "agent '{agent_id}' is unavailable under organization policy"
        ));
    }
    super::enforce_agent_resource_permission(state, caller, permission, agent_id)
        .await
        .map_err(|_| format!("insufficient permissions: {permission}"))
}

/// Concurrent voice calls one managed member may hold open.
const MAX_CALLS_PER_MEMBER: usize = 2;

/// How long a fresh socket may stay silent before its `start` frame. Bounds
/// sockets that upgrade and then never speak.
const START_FRAME_TIMEOUT: Duration = Duration::from_secs(10);

/// Cadence at which the server sends a WebSocket `Ping` control frame. Not every
/// client sends its own `ping` (the shared desktop/island client sends none, and
/// stops sending audio while muted), but every WebSocket stack answers a control
/// ping with a `Pong` on its own, so a silent-but-healthy peer stays live.
const SERVER_PING_INTERVAL: Duration = Duration::from_secs(25);

/// A call whose peer sends nothing (no audio, text, ping, pong or close) for
/// this long is treated as a half-open socket and torn down, so an unclean drop
/// releases the member's [`MemberCallSlot`]. Any inbound frame counts as
/// liveness; two missed server pings plus slack.
const CLIENT_LIVENESS_TIMEOUT: Duration =
    Duration::from_secs(2 * SERVER_PING_INTERVAL.as_secs() + 10);

/// A managed member may not use the node's Gateway audio (no per-member
/// attribution or budget). Checks the STT and TTS selectors the `start` frame
/// carries, including an unset one that resolves to a Gateway node default.
fn member_requests_gateway_audio(stt_engine: Option<&str>, tts_engine: Option<&str>) -> bool {
    super::voice::stt_engine_uses_gateway(stt_engine)
        || super::voice::tts_engine_uses_gateway(tts_engine)
}

fn member_calls() -> &'static std::sync::Mutex<std::collections::HashMap<String, usize>> {
    static CALLS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, usize>>> =
        std::sync::OnceLock::new();
    CALLS.get_or_init(Default::default)
}

/// One of a member's live voice calls; released when the call's handler ends.
struct MemberCallSlot(String);

impl MemberCallSlot {
    fn acquire(user_id: &str) -> Option<Self> {
        let mut calls = member_calls().lock().ok()?;
        let open = calls.entry(user_id.to_owned()).or_default();
        if *open >= MAX_CALLS_PER_MEMBER {
            return None;
        }
        *open += 1;
        Some(Self(user_id.to_owned()))
    }
}

impl Drop for MemberCallSlot {
    fn drop(&mut self) {
        let Ok(mut calls) = member_calls().lock() else {
            return;
        };
        if let Some(open) = calls.get_mut(&self.0) {
            *open = open.saturating_sub(1);
            if *open == 0 {
                calls.remove(&self.0);
            }
        }
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
async fn handle_socket(
    socket: WebSocket,
    state: ServerState,
    caller: Option<crate::identity_verify::VerifiedCaller>,
    token_generation: u64,
    ticket: crate::server::ws_ticket::WsTicketClaims,
) {
    use futures_util::{SinkExt, StreamExt};

    let (mut ws_tx, mut ws_rx) = socket.split();
    let jwt_expiry = crate::server::ws_ticket::wait_for_jwt_expiry(ticket.jwt_expires_at);
    tokio::pin!(jwt_expiry);

    // ── Handshake: the first frame must be `start` ───────────────────────────
    // One deadline for the whole handshake (not reset by ignored frames), so a
    // socket that never sends `start` cannot linger.
    let start_deadline = tokio::time::sleep(START_FRAME_TIMEOUT);
    tokio::pin!(start_deadline);
    let start = loop {
        let frame = tokio::select! {
            _ = &mut jwt_expiry => return,
            _ = &mut start_deadline => return,
            frame = ws_rx.next() => frame,
        };
        match frame {
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
        caller_trusted,
    } = start
    else {
        return;
    };
    let untrusted_caller = restricts_to_untrusted_caller(caller_trusted);

    let session_id = format!("vs_{}", uuid::Uuid::new_v4().simple());
    // Ephemeral sessions get a stable id so ChatEnd + persistence have a key. A
    // client-supplied id is a REUSE of an existing conversation and must be gated;
    // a minted `voice_…` id is brand new and cannot collide with anyone's row.
    let conversation_id = conversation_id.unwrap_or_else(|| format!("voice_{session_id}"));
    if ticket
        .room_id
        .as_deref()
        .is_some_and(|room_id| room_id != conversation_id.as_str())
    {
        let _ = ws_tx
            .send(error_frame(
                "forbidden",
                "WebSocket ticket is not bound to this conversation",
            ))
            .await;
        return;
    }
    if !crate::sidecar::adapters::acp::is_safe_host_conversation_id(&conversation_id) {
        let _ = ws_tx
            .send(error_frame(
                "bad_conversation_id",
                "conversation_id must be 1-128 ASCII letters, digits, '.', '_' or '-'",
            ))
            .await;
        return;
    }

    // ── Agent-run gates ──────────────────────────────────────────────────────
    // A voice turn runs an agent exactly like `POST /api/chat/stream`, so a member
    // ticket gets the same `agent.run` and exact-agent ACL checks before anything
    // (including the conversation claim below) happens. A node-token-only ticket
    // (no verified caller: the Gateway PSTN bridge) keeps node authority, which
    // is the trust that token already carries; org policy still applies to every
    // turn inside `route_chat_stream`.
    if caller.is_some() {
        if let Err(message) = enforce_voice_agent_run(&state, &caller, agent_id.as_deref()).await {
            let _ = ws_tx.send(error_frame("forbidden", &message)).await;
            return;
        }
    }

    // The Gateway audio slots are owner-only: they spend the node's shared
    // Gateway credential with no per-member attribution or budget. Refused
    // before the call slot and conversation claim so nothing is taken.
    if ticket.member && member_requests_gateway_audio(stt_engine.as_deref(), tts_engine.as_deref())
    {
        let _ = ws_tx
            .send(error_frame(
                "forbidden",
                super::voice::MEMBER_GATEWAY_AUDIO_REFUSAL,
            ))
            .await;
        return;
    }

    // Unredeemed tickets are capped in `ws_ticket`; live calls are capped here,
    // so one member can't hold many concurrent STT/LLM/TTS pipelines. Taken
    // before the conversation claim so a refused call claims nothing.
    let _member_call = match ticket.member.then(|| {
        caller
            .as_ref()
            .and_then(|caller| MemberCallSlot::acquire(&caller.user_id))
    }) {
        Some(None) => {
            let _ = ws_tx
                .send(error_frame(
                    "too_many_calls",
                    "you already have the most voice calls open on this workspace",
                ))
                .await;
            return;
        }
        Some(Some(slot)) => Some(slot),
        None => None,
    };

    // ── THE GATE ─────────────────────────────────────────────────────────────
    // The same create-or-use gate `chat_stream` uses: an EXISTING row gets the full
    // write check (this is what closes the bypass — user B naming user A's
    // conversation id and having A's history streamed back as context and B's turns
    // appended into A's thread); a NEW id is claimed for this caller so nobody else
    // can take it. No-op on an unbound personal node.
    if let Err(_resp) = super::gate_and_claim_conversation(&state, &caller, &conversation_id).await
    {
        let _ = ws_tx
            .send(error_frame(
                "forbidden",
                "you do not have access to that conversation",
            ))
            .await;
        return;
    }

    // A member may only name one of an engine's built-in voices. A path or URL
    // here is a cloning prompt for some engines (and a fetch from the speech
    // sidecar), which is an owner-only capability.
    if ticket.member
        && tts_voice
            .as_deref()
            .is_some_and(|voice| !super::voice::is_plain_voice_id(voice))
    {
        let _ = ws_tx
            .send(error_frame(
                "forbidden",
                "only built-in voices are available on this workspace",
            ))
            .await;
        return;
    }

    let history_conversation_id = conversation_id.clone();
    // The final, post-routing agent ACL typed chat applies (see
    // `route_single_turn`): auto-routing, the lane default, a handoff or the
    // summary turn may land on an agent other than the one named in `start`.
    let agent_authorization = caller.as_ref().map(|_| {
        Arc::new(crate::sidecar::adapters::AgentResourceAuthorization {
            state: state.clone(),
            caller: caller.clone(),
        })
    });
    let cfg = VoiceConfig {
        conversation_id,
        caller: caller.clone(),
        user_jwt: ticket.user_jwt.clone(),
        agent_authorization,
        agent_id,
        stt_engine,
        tts_engine,
        tts_voice,
        client_rate: sample_rate.max(8_000),
        untrusted_caller,
    };
    if untrusted_caller {
        tracing::info!(
            session_id = %session_id,
            "voice session opened for an unverified caller; turns use the restricted tool profile"
        );
    }
    let mut session = VoiceSession::new(cfg, session_deps(&state));

    // ── Ack ──────────────────────────────────────────────────────────────────
    let ready = VoiceServerMsg::Ready {
        session_id: session_id.clone(),
        tts_sample_rate: TTS_SAMPLE_RATE,
    };
    if ws_tx.send(text_frame(&ready)).await.is_err() {
        return;
    }
    let connected_at = std::time::Instant::now();

    // ── Send task fed by an mpsc of session outputs ──────────────────────────
    let (out_tx, mut out_rx) = mpsc::channel::<VoiceOutput>(256);
    // Shared barge-in flag: set on VAD onset over the reply (or explicit `abort`),
    // read by the send side to drop queued TTS audio mid-stream.
    let abort = Arc::new(AtomicBool::new(false));
    let send_abort = Arc::clone(&abort);
    let send_task = tokio::spawn(async move {
        let mut keepalive = tokio::time::interval(SERVER_PING_INTERVAL);
        keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        keepalive.tick().await; // the first tick completes at once
        loop {
            let output = tokio::select! {
                output = out_rx.recv() => match output {
                    Some(output) => output,
                    None => break,
                },
                _ = keepalive.tick() => {
                    // Prompts a `Pong` from a peer that is otherwise silent
                    // (muted mic, no typed turn), proving it is still there.
                    if ws_tx.send(Message::Ping(Vec::new())).await.is_err() {
                        break;
                    }
                    continue;
                }
            };
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
    let mut token_updates = crate::node_token::subscribe_generation();
    if *token_updates.borrow() != token_generation {
        let _ = out_tx
            .send(VoiceOutput::Control(VoiceServerMsg::Error {
                code: "node_token_rotated".to_string(),
                message: "node token rotated; reconnect required".to_string(),
            }))
            .await;
        drop(out_tx);
        let _ = send_task.await;
        return;
    }
    let mut requested_end = false;
    let mut timed_out = false;
    // Half-open sockets never deliver a close, so without this a member's call
    // slot would be held until the OS gives up on the connection.
    let liveness = tokio::time::sleep(CLIENT_LIVENESS_TIMEOUT);
    tokio::pin!(liveness);
    loop {
        let frame = tokio::select! {
            _ = &mut liveness => {
                tracing::info!(
                    "voice socket silent for {}s; closing the half-open call",
                    CLIENT_LIVENESS_TIMEOUT.as_secs()
                );
                timed_out = true;
                break;
            }
            _ = &mut jwt_expiry => {
                let _ = out_tx
                    .send(VoiceOutput::Control(VoiceServerMsg::Error {
                        code: "user_identity_expired".to_string(),
                        message: "user identity expired; reconnect required".to_string(),
                    }))
                    .await;
                break;
            }
            changed = token_updates.changed() => {
                if changed.is_ok() && *token_updates.borrow() != token_generation {
                    let _ = out_tx
                        .send(VoiceOutput::Control(VoiceServerMsg::Error {
                            code: "node_token_rotated".to_string(),
                            message: "node token rotated; reconnect required".to_string(),
                        }))
                        .await;
                }
                break;
            }
            frame = ws_rx.next() => frame,
        };
        let Some(frame) = frame else { break };
        // Any inbound frame (audio, text, ping, pong, close) proves the peer is alive.
        liveness
            .as_mut()
            .reset(tokio::time::Instant::now() + CLIENT_LIVENESS_TIMEOUT);
        if crate::node_token::active_generation() != token_generation {
            let _ = out_tx
                .send(VoiceOutput::Control(VoiceServerMsg::Error {
                    code: "node_token_rotated".to_string(),
                    message: "node token rotated; reconnect required".to_string(),
                }))
                .await;
            break;
        }
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
                    // A second `start` is ignored (session already established),
                    // including any `caller_trusted` it carries: trust is fixed
                    // by the first frame and cannot be raised mid-session.
                    VoiceClientMsg::Start { .. } => {}
                    VoiceClientMsg::Text { content } => {
                        if let Some(turn) = session.make_text_turn(&content) {
                            spawn_turn(turn, &abort, &out_tx, &mut turn_handle).await;
                        }
                    }
                    VoiceClientMsg::Summary => {
                        let turn = session.make_summary_turn();
                        spawn_turn(turn, &abort, &out_tx, &mut turn_handle).await;
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
                    VoiceClientMsg::End => {
                        requested_end = true;
                        break;
                    }
                }
            }
            Message::Ping(_) | Message::Pong(_) => {}
            Message::Close(_) => break,
        }
    }

    // Teardown: signal abort, drop the sender so the send task ends, and await any
    // in-flight turn + the send task.
    let duration_seconds = connected_at.elapsed().as_secs();
    abort.store(true, Ordering::SeqCst);
    if timed_out {
        // The peer is unreachable, so a send blocked on its socket would never
        // finish and would pin the call slot. Stop the writer; later outputs
        // fail fast instead of queueing behind it.
        send_task.abort();
    }
    if let Some(handle) = turn_handle.take() {
        let _ = handle.await;
    }
    match persist_call_ended(
        &state.conversations,
        &history_conversation_id,
        &session_id,
        duration_seconds,
        caller.as_ref().map(|caller| caller.user_id.as_str()),
    )
    .await
    {
        Ok(summary) if requested_end => {
            let _ = out_tx.send(VoiceOutput::Control(summary)).await;
        }
        Ok(_) => {}
        Err(error) => {
            tracing::error!(%error, "could not save voice call summary");
            let _ = out_tx
                .send(VoiceOutput::Control(VoiceServerMsg::Error {
                    code: "call_history_failed".into(),
                    message: "The call ended, but its summary could not be saved.".into(),
                }))
                .await;
        }
    }
    drop(out_tx);
    let _ = send_task.await;
}

async fn persist_call_ended(
    store: &super::conversations::ConversationStore,
    conversation_id: &str,
    session_id: &str,
    duration_seconds: u64,
    author_user_id: Option<&str>,
) -> anyhow::Result<VoiceServerMsg> {
    let content = format!(
        "Call ended · {:02}:{:02}",
        duration_seconds / 60,
        duration_seconds % 60
    );
    let message_id = store
        .append_message_as(
            conversation_id,
            "user",
            &content,
            None,
            author_user_id,
            None,
            super::conversations::Tenancy::Unattributed,
        )
        .await?;
    tracing::debug!(session_id, duration_seconds, "voice call ended and saved");
    Ok(VoiceServerMsg::CallEnded {
        conversation_id: conversation_id.to_owned(),
        message_id,
        duration_seconds,
        content,
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn call_summary_is_a_durable_user_message_with_verified_author() {
        let store = super::super::conversations::ConversationStore::open_in_memory().unwrap();
        store
            .ensure_conversation(
                "voice-test",
                None,
                None,
                super::super::conversations::Tenancy::Unattributed,
            )
            .await
            .unwrap();
        let summary = persist_call_ended(&store, "voice-test", "session-1", 84, Some("user-1"))
            .await
            .unwrap();
        let VoiceServerMsg::CallEnded {
            content,
            message_id,
            duration_seconds,
            ..
        } = summary
        else {
            panic!("expected saved call summary");
        };
        assert_eq!(content, "Call ended · 01:24");
        assert_eq!(duration_seconds, 84);
        let messages = store.get_messages("voice-test").await.unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, message_id);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, content);
        assert_eq!(messages[0].author_user_id.as_deref(), Some("user-1"));
    }

    #[tokio::test]
    async fn zero_duration_and_long_calls_keep_their_duration() {
        let store = super::super::conversations::ConversationStore::open_in_memory().unwrap();
        for (seconds, expected) in [(0, "Call ended · 00:00"), (3601, "Call ended · 60:01")] {
            let summary = persist_call_ended(&store, "voice-test", "session", seconds, None)
                .await
                .unwrap();
            let VoiceServerMsg::CallEnded { content, .. } = summary else {
                panic!("expected summary")
            };
            assert_eq!(content, expected);
        }
        assert_eq!(store.get_messages("voice-test").await.unwrap().len(), 2);
    }

    /// Little-endian PCM16 decode: bytes pair into i16 samples LSB-first, including
    /// negative samples (the mic sends signed audio).
    #[test]
    fn pcm_decodes_little_endian_signed_samples() {
        // 0x0001 LE = 1; 0xFFFF LE = -1; 0x0080 -> 0x8000 is i16::MIN when high byte
        // set: [0x00, 0x80] = 0x8000 = -32768.
        let bytes = [0x01, 0x00, 0xFF, 0xFF, 0x00, 0x80];
        assert_eq!(pcm_from_bytes(&bytes), vec![1_i16, -1, i16::MIN]);
    }

    /// A trailing odd byte (a torn frame boundary) is dropped, never panics — the
    /// realtime mic path must survive a half-delivered sample.
    #[test]
    fn pcm_drops_trailing_odd_byte() {
        // Three bytes: one full sample + a dangling byte.
        let bytes = [0x10, 0x27, 0x42];
        assert_eq!(pcm_from_bytes(&bytes), vec![0x2710_i16]); // 10000
    }

    #[test]
    fn pcm_empty_slice_is_empty() {
        assert!(pcm_from_bytes(&[]).is_empty());
        // A lone byte yields no samples (no half-sample emitted).
        assert!(pcm_from_bytes(&[0x42]).is_empty());
    }

    /// `caller_trusted` can only restrict. A client that sends `true` gets the
    /// same owner session as one that omits the field; only the Gateway's
    /// explicit `false` restricts the session.
    #[test]
    fn caller_trust_flag_only_restricts() {
        let start_trust = |raw: &str| match serde_json::from_str::<VoiceClientMsg>(raw).unwrap() {
            VoiceClientMsg::Start { caller_trusted, .. } => {
                restricts_to_untrusted_caller(caller_trusted)
            }
            _ => panic!("expected start"),
        };
        let absent = start_trust(r#"{"type":"start","sample_rate":16000}"#);
        let claimed = start_trust(r#"{"type":"start","sample_rate":16000,"caller_trusted":true}"#);
        let unverified =
            start_trust(r#"{"type":"start","sample_rate":8000,"caller_trusted":false}"#);
        assert!(!absent, "existing clients keep the owner's session");
        assert_eq!(claimed, absent, "claiming trust grants nothing extra");
        assert!(
            unverified,
            "the Gateway's explicit false restricts the session"
        );
    }

    /// The upgrade query accepts only the opaque ticket field; bearer credentials
    /// are exchanged over HTTP before the socket is opened.
    #[test]
    fn voice_query_contains_only_a_ticket() {
        let query: VoiceQuery =
            serde_json::from_value(serde_json::json!({ "ticket": "opaque-ticket" })).unwrap();
        assert_eq!(query.ticket.as_deref(), Some("opaque-ticket"));
        assert!(
            serde_json::from_value::<VoiceQuery>(serde_json::json!({ "jwt": "legacy" })).is_err()
        );
    }

    /// The error frame is a tagged-union TEXT message the client can route by
    /// `type`; it carries the code + message verbatim.
    #[test]
    fn a_member_holds_at_most_two_live_calls() {
        let first = super::MemberCallSlot::acquire("slot-test-member").expect("first call");
        let second = super::MemberCallSlot::acquire("slot-test-member").expect("second call");
        assert!(super::MemberCallSlot::acquire("slot-test-member").is_none());
        assert!(super::MemberCallSlot::acquire("slot-test-other").is_some());
        drop(first);
        let third = super::MemberCallSlot::acquire("slot-test-member");
        assert!(third.is_some(), "hanging up frees a slot");
        drop((second, third));
    }

    #[test]
    fn error_frame_is_tagged_error_text() {
        let Message::Text(text) = error_frame("expected_start", "first frame must be `start`")
        else {
            panic!("error_frame must produce a TEXT frame");
        };
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["type"], "error");
        assert_eq!(v["code"], "expected_start");
        assert_eq!(v["message"], "first frame must be `start`");
    }

    /// `text_frame` serializes a control message to a routable `type`-tagged frame.
    #[test]
    fn text_frame_tags_control_messages() {
        let Message::Text(text) = text_frame(&VoiceServerMsg::Pong) else {
            panic!("expected TEXT");
        };
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["type"], "pong");
    }

    #[test]
    fn a_member_start_naming_gateway_audio_is_flagged() {
        assert!(member_requests_gateway_audio(Some("gateway"), None));
        assert!(member_requests_gateway_audio(None, Some("gateway")));
        assert!(member_requests_gateway_audio(
            Some(" Gateway "),
            Some("kokoro")
        ));
        assert!(!member_requests_gateway_audio(
            Some("whisper"),
            Some("outetts")
        ));
    }

    #[test]
    fn socket_deadlines_leave_room_for_the_client_ping() {
        assert_eq!(SERVER_PING_INTERVAL, Duration::from_secs(25));
        assert_eq!(CLIENT_LIVENESS_TIMEOUT, Duration::from_secs(60));
        assert!(
            CLIENT_LIVENESS_TIMEOUT >= SERVER_PING_INTERVAL * 2,
            "one lost ping must not drop a healthy call"
        );
        assert!(START_FRAME_TIMEOUT <= Duration::from_secs(30));
    }
}
