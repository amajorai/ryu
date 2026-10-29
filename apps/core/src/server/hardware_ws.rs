//! Ryu Hardware Protocol WebSocket handler (`GET /api/hardware/ws`).
//!
//! Implements PROTOCOL.md §2–4 and the RHP v1.1 secure session (design §4): the
//! realtime device link. A device (or the phone relay in Mode A) connects with a
//! `Bearer` token on the upgrade request and then either
//!
//! - **secure (v1.1):** sends a BINARY HS1 and runs a `Noise_XX_25519_AESGCM_SHA256`
//!   handshake ([`ryu_hardware::secure`]) whose HS3 carries the `hello`; every
//!   later message is a sealed DATA frame, so a relaying phone sees only
//!   ciphertext; or
//! - **legacy (v1):** sends a TEXT `hello` and streams plaintext control TEXT
//!   frames + Opus audio BINARY frames. Allowed only for protocol-level-1 rows and
//!   while the `hardware-legacy-v1-sessions` node pref is not `"false"`.
//!
//! Both codecs then run the same session pump: the per-connection
//! [`HardwareSession`] bridges every turn IN-PROCESS to the existing Core seams
//! (chat via `run_text_turn`, ASR/TTS via `voice`, ambient via the meetings
//! pipeline) — never self-HTTP.
//!
//! ## Auth placement
//!
//! This route lives on the **public** router, not behind `require_auth`. That
//! middleware compares a `Bearer` against the single global `RYU_TOKEN`, but a
//! device presents a *per-device* token, which would never match. The token is
//! required on every bind, loopback included:
//!
//! - secure: [`ryu_hardware::DeviceStore::authenticate_bearer`] resolves the row
//!   (device token or the phone's WS-only relay token) BEFORE any DH, so an
//!   unauthenticated peer costs no key agreement; the device_id never travels in
//!   the clear (it is bound in the Noise prologue from the row);
//! - legacy: the `hello` names the device, and the presented token must verify
//!   against that row's device token.
//!
//! A device obtains its token only through pairing (`POST /api/hardware/pair` or
//! pairing v2 `/api/hardware/pair/{begin,reveal,confirm}`), which is on the
//! PROTECTED router and needs the node's `RYU_TOKEN`.
//!
//! ## Concurrency / barge-in
//!
//! The socket is split: a dedicated send task drains a priority control channel
//! (capability invokes) and an `mpsc` of [`SessionOutput`] to the wire, sealing
//! each message on secure sessions, while the recv task reads frames and runs
//! turns. An [`AtomicBool`] abort flag (set on a `text`-frame `abort`) is checked
//! by the send task before each queued audio frame, so a barge-in stops TTS
//! within one frame instead of waiting for the whole reply to drain.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::HeaderMap,
    response::IntoResponse,
};
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use tokio::sync::mpsc;

use super::ServerState;
use crate::hardware::turn::{run_chat_turn, ChatTurn, SessionDeps};
use ryu_hardware::capability;
use ryu_hardware::pair_crypto;
use ryu_hardware::protocol::{
    parse_client_msg, CapLimits, Caps, DeviceType, RhpClientMsg, RhpServerMsg, PROTO_V1_1,
};
use ryu_hardware::secure::{self, codes, OutboundKind, RecvHalf, SecureError, SendHalf};
use ryu_hardware::session::live::{self, EndReason, LiveMeta};
use ryu_hardware::session::{HardwareSession, SessionOutput, TurnInput};
use ryu_hardware::store::{DeviceRecord, DeviceStore, TokenKind, PROTOCOL_LEVEL_SECURE};
use ryu_hardware::MeetingIngest;

/// Node pref that turns legacy (v1 plaintext) sessions off when set to `"false"`.
pub(crate) const LEGACY_SESSIONS_PREF: &str = "hardware-legacy-v1-sessions";

/// At most this many handshakes per device per [`HANDSHAKE_WINDOW`].
pub(crate) const HANDSHAKES_PER_DEVICE: usize = 10;
/// The per-device handshake rate window.
pub(crate) const HANDSHAKE_WINDOW: Duration = Duration::from_secs(60);
/// At most this many handshakes in flight node-wide.
pub(crate) const MAX_CONCURRENT_HANDSHAKES: usize = 64;

/// `GET /api/hardware/ws` — upgrade to the RHP WebSocket. The Bearer token (the
/// device token, or on a relayed v1.1 session the phone's relay token) rides on
/// the upgrade request headers; it is captured here and checked inside the
/// socket task, before any key agreement.
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

// ── First frame ─────────────────────────────────────────────────────────────

/// How the first data frame classifies the connection (design §4.1).
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum FirstFrame {
    /// A TEXT frame: the legacy v1 `hello` path.
    LegacyText(String),
    /// A BINARY frame whose byte0 is HS1 (`0x01`): the secure path.
    SecureHs1(Vec<u8>),
    /// The socket closed (or errored) before any data frame.
    Closed,
    /// Any other BINARY frame: PLAIN_ERROR `bad_frame` and close.
    Invalid,
}

/// Read the first data frame, skipping pings/pongs. The caller bounds the wait.
pub(crate) async fn read_first_frame<Rx, E>(rx: &mut Rx) -> FirstFrame
where
    Rx: Stream<Item = Result<Message, E>> + Unpin,
{
    loop {
        match rx.next().await {
            Some(Ok(Message::Text(text))) => return FirstFrame::LegacyText(text),
            Some(Ok(Message::Binary(bytes))) => {
                return if bytes.first() == Some(&secure::OUT_HS1) {
                    FirstFrame::SecureHs1(bytes)
                } else {
                    FirstFrame::Invalid
                };
            }
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            Some(Ok(Message::Close(_)) | Err(_)) | None => return FirstFrame::Closed,
        }
    }
}

// ── Handshake rate limiting ─────────────────────────────────────────────────

#[derive(Default)]
struct LimiterState {
    recent: HashMap<String, VecDeque<Instant>>,
    active: usize,
}

/// Bounds secure handshakes: [`HANDSHAKES_PER_DEVICE`] per device per
/// [`HANDSHAKE_WINDOW`] and [`MAX_CONCURRENT_HANDSHAKES`] in flight node-wide
/// (design §4.4 step 3). Checked after the Bearer resolved the row and before
/// any DH.
#[derive(Default)]
pub(crate) struct HandshakeLimiter {
    state: Mutex<LimiterState>,
}

/// One admitted handshake; releases its concurrency slot on drop.
pub(crate) struct HandshakePermit<'a> {
    limiter: &'a HandshakeLimiter,
}

impl Drop for HandshakePermit<'_> {
    fn drop(&mut self) {
        let mut state = self.limiter.lock();
        state.active = state.active.saturating_sub(1);
    }
}

impl HandshakeLimiter {
    /// The node-wide limiter the WS handler uses.
    pub(crate) fn global() -> &'static HandshakeLimiter {
        static LIMITER: OnceLock<HandshakeLimiter> = OnceLock::new();
        LIMITER.get_or_init(HandshakeLimiter::default)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, LimiterState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Admit one handshake for `device_id` at `now`, or `None` when the device
    /// is over its rate or the node is at its concurrency cap.
    pub(crate) fn try_acquire(&self, device_id: &str, now: Instant) -> Option<HandshakePermit<'_>> {
        let mut guard = self.lock();
        let state = &mut *guard;
        if state.active >= MAX_CONCURRENT_HANDSHAKES {
            return None;
        }
        // Prune every expired attempt so the map stays bounded by live devices.
        state.recent.retain(|_, attempts| {
            while attempts
                .front()
                .is_some_and(|at| now.saturating_duration_since(*at) >= HANDSHAKE_WINDOW)
            {
                attempts.pop_front();
            }
            !attempts.is_empty()
        });
        let attempts = state.recent.entry(device_id.to_string()).or_default();
        if attempts.len() >= HANDSHAKES_PER_DEVICE {
            return None;
        }
        attempts.push_back(now);
        state.active += 1;
        Some(HandshakePermit { limiter: self })
    }
}

// ── Secure handshake (design §4.4) ──────────────────────────────────────────

/// The parts of the encrypted `hello` the session needs.
#[derive(Clone, Debug)]
pub(crate) struct HelloInfo {
    pub device_type: DeviceType,
    pub caps: Caps,
    pub relay: bool,
}

/// A completed, authenticated secure handshake.
pub(crate) struct SecureStart {
    pub record: DeviceRecord,
    pub kind: TokenKind,
    pub hello: HelloInfo,
    pub send: SendHalf,
    pub recv: RecvHalf,
}

/// Why a secure handshake did not produce a session. The refusal frame (if any)
/// has already been sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HandshakeRefusal {
    /// A PLAIN_ERROR with this code was sent (pre-session).
    Plain(&'static str),
    /// An encrypted `error` with this code was sent (after HS3).
    Encrypted(&'static str),
    /// The peer went away mid-handshake.
    Closed,
}

/// Constant-time equality of two 32-byte keys.
fn keys_equal(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let diff = a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    std::hint::black_box(diff) == 0
}

async fn send_plain_error<Tx>(tx: &mut Tx, code: &'static str) -> HandshakeRefusal
where
    Tx: Sink<Message> + Unpin,
{
    let _ = tx.send(Message::Binary(secure::plain_error(code))).await;
    HandshakeRefusal::Plain(code)
}

/// Seal one control message into DATA frames.
fn seal_control(send: &mut SendHalf, msg: &RhpServerMsg) -> Result<Vec<Message>, SecureError> {
    let body = serde_json::to_vec(msg).unwrap_or_else(|_| b"{}".to_vec());
    Ok(send
        .seal(OutboundKind::Control, &body, Instant::now())?
        .into_iter()
        .map(Message::Binary)
        .collect())
}

async fn send_encrypted_error<Tx>(
    tx: &mut Tx,
    send: &mut SendHalf,
    code: &'static str,
    message: &str,
) -> HandshakeRefusal
where
    Tx: Sink<Message> + Unpin,
{
    let msg = RhpServerMsg::Error {
        code: code.to_string(),
        message: message.to_string(),
    };
    if let Ok(frames) = seal_control(send, &msg) {
        for frame in frames {
            if tx.send(frame).await.is_err() {
                break;
            }
        }
    }
    HandshakeRefusal::Encrypted(code)
}

/// What the HS3 wait produced.
enum Hs3Frame {
    Binary(Vec<u8>),
    Text,
    Closed,
}

async fn next_handshake_frame<Rx, E>(rx: &mut Rx) -> Hs3Frame
where
    Rx: Stream<Item = Result<Message, E>> + Unpin,
{
    loop {
        match rx.next().await {
            Some(Ok(Message::Binary(bytes))) => return Hs3Frame::Binary(bytes),
            Some(Ok(Message::Text(_))) => return Hs3Frame::Text,
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            Some(Ok(Message::Close(_)) | Err(_)) | None => return Hs3Frame::Closed,
        }
    }
}

/// Run the node side of the RHN handshake (design §4.4 steps 1–8) over any
/// message sink/stream. `hs1` is the first frame [`read_first_frame`] classified
/// as secure. Every pre-HS3 refusal is a PLAIN_ERROR; once HS3 authenticates,
/// refusals are sealed `error` messages. Nothing is sent before the Bearer
/// resolved a row (no HS2, no DH for unauthenticated peers).
pub(crate) async fn secure_handshake<Tx, Rx, E>(
    tx: &mut Tx,
    rx: &mut Rx,
    store: &DeviceStore,
    bearer: Option<&str>,
    hs1: &[u8],
    limiter: &HandshakeLimiter,
    now: Instant,
) -> Result<SecureStart, HandshakeRefusal>
where
    Tx: Sink<Message> + Unpin,
    Rx: Stream<Item = Result<Message, E>> + Unpin,
{
    // 1. HS1 shape: exactly 36 bytes, ver/suite/flags 01/01/00.
    if let Err(error) = secure::validate_hs1(hs1) {
        return Err(send_plain_error(tx, error.code()).await);
    }

    // 2. Bearer -> row, before any DH.
    let authenticated = match bearer.filter(|token| !token.is_empty()) {
        Some(token) => store.authenticate_bearer(token).await.unwrap_or_else(|e| {
            tracing::warn!(target: "hardware", "hardware: bearer lookup failed: {e:#}");
            None
        }),
        None => None,
    };
    let Some((record, kind)) = authenticated else {
        return Err(send_plain_error(tx, codes::UNAUTHORIZED).await);
    };
    let pinned = match record
        .noise_pubkey
        .as_deref()
        .and_then(pair_crypto::b64u_decode_array::<32>)
    {
        Some(pinned) if record.is_secure() => pinned,
        _ => return Err(send_plain_error(tx, codes::REPAIR_REQUIRED).await),
    };

    // 3. Rate limit (held until this function returns).
    let Some(_permit) = limiter.try_acquire(&record.device_id, now) else {
        return Err(send_plain_error(tx, codes::RATE_LIMITED).await);
    };

    // 4. Node identity.
    let identity = match store.node_identity().await {
        Ok(identity) => identity,
        Err(e) => {
            tracing::warn!(target: "hardware", "hardware: node identity unavailable: {e}");
            return Err(send_plain_error(tx, codes::NODE_IDENTITY_UNAVAILABLE).await);
        }
    };

    // 5. HS2, bound to the row's device_id through the prologue.
    let mut responder = match secure::ServerHandshake::new(&identity, &record.device_id) {
        Ok(responder) => responder,
        Err(error) => return Err(send_plain_error(tx, error.code()).await),
    };
    let hs2 = match responder.on_hs1(hs1) {
        Ok(hs2) => hs2,
        Err(error) => return Err(send_plain_error(tx, error.code()).await),
    };
    if tx.send(Message::Binary(hs2)).await.is_err() {
        return Err(HandshakeRefusal::Closed);
    }

    // 6. HS3 within the handshake timeout.
    let hs3 = match tokio::time::timeout(secure::HANDSHAKE_TIMEOUT, next_handshake_frame(rx)).await
    {
        Err(_) => return Err(send_plain_error(tx, codes::HANDSHAKE_TIMEOUT).await),
        Ok(Hs3Frame::Closed) => return Err(HandshakeRefusal::Closed),
        Ok(Hs3Frame::Text) => return Err(send_plain_error(tx, codes::BAD_FRAME).await),
        Ok(Hs3Frame::Binary(bytes)) => bytes,
    };
    let mut established = match responder.on_hs3(&hs3, Instant::now()) {
        Ok(established) => established,
        Err(error) => return Err(send_plain_error(tx, error.code()).await),
    };

    // 7. Pin check.
    if !keys_equal(&established.remote_static, &pinned) {
        tracing::warn!(
            target: "hardware.security",
            device_id = %record.device_id,
            "hardware: secure handshake refused: the device static key does not match the pinned key"
        );
        return Err(send_encrypted_error(
            tx,
            &mut established.send,
            codes::UNAUTHORIZED,
            "device key does not match the paired key",
        )
        .await);
    }

    // 8. Hello check: the encrypted hello's device_id and relay flag are
    // authoritative and must match the row and the token kind.
    let hello = match parse_client_msg(&established.hello) {
        Ok(RhpClientMsg::Hello {
            device_id,
            device_type,
            caps,
            relay,
            ..
        }) if device_id == record.device_id && relay == (kind == TokenKind::Relay) => HelloInfo {
            device_type,
            caps,
            relay,
        },
        _ => {
            tracing::warn!(
                target: "hardware.security",
                device_id = %record.device_id,
                "hardware: secure handshake refused: hello does not match the paired device or token"
            );
            return Err(send_encrypted_error(
                tx,
                &mut established.send,
                codes::UNAUTHORIZED,
                "hello does not match the paired device",
            )
            .await);
        }
    };

    Ok(SecureStart {
        record,
        kind,
        hello,
        send: established.send,
        recv: established.recv,
    })
}

// ── Legacy policy ───────────────────────────────────────────────────────────

/// Whether a legacy (v1 plaintext) session may run for `record`, given the
/// `hardware-legacy-v1-sessions` pref (design §4.1). A protocol-level-2 row never
/// downgrades (`noise_required`); legacy can be switched off node-wide
/// (`legacy_disabled`).
pub(crate) fn legacy_policy(
    record: &DeviceRecord,
    legacy_sessions_pref: Option<&str>,
) -> Result<(), &'static str> {
    if record.protocol_level >= PROTOCOL_LEVEL_SECURE {
        return Err("noise_required");
    }
    if legacy_sessions_pref.is_some_and(|value| value.trim().eq_ignore_ascii_case("false")) {
        return Err("legacy_disabled");
    }
    Ok(())
}

/// Authenticate a legacy TEXT `hello`. Sends the refusal frame and returns
/// `None` when the session may not start.
async fn legacy_handshake<Tx>(
    tx: &mut Tx,
    state: &ServerState,
    bearer: Option<&str>,
    text: &str,
) -> Option<(DeviceRecord, HelloInfo)>
where
    Tx: Sink<Message> + Unpin,
{
    let (device_id, hello) = match serde_json::from_str::<RhpClientMsg>(text) {
        Ok(RhpClientMsg::Hello {
            device_id,
            device_type,
            caps,
            relay,
            ..
        }) => (
            device_id,
            HelloInfo {
                device_type,
                caps,
                relay,
            },
        ),
        Ok(_) => {
            let _ = tx
                .send(error_frame("expected_hello", "first frame must be `hello`"))
                .await;
            return None;
        }
        Err(e) => {
            let _ = tx
                .send(error_frame("bad_json", &format!("malformed hello: {e}")))
                .await;
            return None;
        }
    };

    // ── Authenticate the device token against the registry ──────────────────
    // A device gets a token only by PAIRING first (`POST /api/hardware/pair` or
    // pairing v2), and those routes are PROTECTED by the node's `RYU_TOKEN`. So we
    // reject:
    //   - any device_id with no registry row (unpaired), and
    //   - a registered device whose presented Bearer is not its DEVICE token
    //     (a phone's WS-only relay token never opens a plaintext session).
    // This holds on every bind, loopback included, which is what makes the public
    // WS route safe on a mesh/non-loopback node where `require_auth` (global
    // RYU_TOKEN) can't gate a per-device token.
    let record = state.hardware.get(&device_id).await.ok().flatten();
    let token_ok = match (&record, bearer) {
        (Some(_), Some(token)) => state
            .hardware
            .verify_token(&device_id, token)
            .await
            .unwrap_or(false),
        _ => false,
    };
    let Some(record) = record.filter(|_| token_ok) else {
        let _ = tx
            .send(error_frame(
                "unauthorized",
                "unknown or unauthenticated device; pair it from the Ryu app first",
            ))
            .await;
        return None;
    };

    let pref = state
        .preferences
        .get(LEGACY_SESSIONS_PREF)
        .await
        .ok()
        .flatten();
    if let Err(code) = legacy_policy(&record, pref.as_deref()) {
        let message = match code {
            "noise_required" => "this device is paired for secure sessions; plaintext is refused",
            _ => "legacy plaintext sessions are disabled on this node; re-pair the device",
        };
        let _ = tx.send(error_frame(code, message)).await;
        return None;
    }
    Some((record, hello))
}

// ── Socket driver ───────────────────────────────────────────────────────────

/// Per-connection driver: classify the first frame, authenticate, then run the
/// shared session pump.
async fn handle_socket(socket: WebSocket, state: ServerState, bearer: Option<String>) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    let first =
        match tokio::time::timeout(secure::HANDSHAKE_TIMEOUT, read_first_frame(&mut ws_rx)).await {
            Ok(first) => first,
            Err(_) => {
                let _ = ws_tx
                    .send(error_frame(
                        "hello_timeout",
                        "hello frame was not received in time",
                    ))
                    .await;
                return;
            }
        };

    let start = match first {
        FirstFrame::Closed => return,
        FirstFrame::Invalid => {
            let _ = ws_tx
                .send(Message::Binary(secure::plain_error(codes::BAD_FRAME)))
                .await;
            return;
        }
        FirstFrame::LegacyText(text) => {
            match legacy_handshake(&mut ws_tx, &state, bearer.as_deref(), &text).await {
                Some((record, hello)) => SessionStart {
                    record,
                    hello,
                    secure: None,
                },
                None => return,
            }
        }
        FirstFrame::SecureHs1(hs1) => {
            match secure_handshake(
                &mut ws_tx,
                &mut ws_rx,
                &state.hardware,
                bearer.as_deref(),
                &hs1,
                HandshakeLimiter::global(),
                Instant::now(),
            )
            .await
            {
                Ok(start) => SessionStart {
                    record: start.record,
                    hello: start.hello,
                    secure: Some((start.send, start.recv)),
                },
                Err(_) => return,
            }
        }
    };

    run_session(ws_tx, ws_rx, state, start).await;
}

/// Everything the session pump needs from either handshake.
struct SessionStart {
    record: DeviceRecord,
    hello: HelloInfo,
    /// The transport halves of a secure session; `None` for legacy.
    secure: Option<(SendHalf, RecvHalf)>,
}

/// The `hello_ack`. Secure sessions add `proto` and `cap_limits`; the legacy ack
/// stays byte-identical to v1.
pub(crate) fn hello_ack(secure: bool, ambient_session_id: Option<String>) -> RhpServerMsg {
    RhpServerMsg::HelloAck {
        session_id: format!("hwses_{}", uuid::Uuid::new_v4().simple()),
        ambient_session_id,
        tts: HardwareSession::tts_format(),
        proto: secure.then(|| PROTO_V1_1.to_string()),
        cap_limits: secure.then_some(CapLimits::V1_1),
    }
}

/// What the device receives when its connection is ended from elsewhere: a
/// revoke sends `unpaired` on secure sessions (`error{device_revoked}` on legacy);
/// a newer connection or an identity reset sends `session_superseded`.
pub(crate) fn end_message(reason: EndReason, secure: bool) -> RhpServerMsg {
    match (reason, secure) {
        (EndReason::Revoked, true) => RhpServerMsg::Unpaired,
        (EndReason::Revoked, false) => RhpServerMsg::Error {
            code: "device_revoked".to_string(),
            message: "device access revoked; reconnect required".to_string(),
        },
        (EndReason::Superseded, _) => RhpServerMsg::Error {
            code: codes::SESSION_SUPERSEDED.to_string(),
            message: "a newer connection replaced this session".to_string(),
        },
    }
}

/// Encode one session output for the wire: TEXT/BINARY on legacy sessions, sealed
/// DATA frames on secure ones.
fn encode_output(
    send: Option<&mut SendHalf>,
    output: SessionOutput,
) -> Result<Vec<Message>, SecureError> {
    match (send, output) {
        (None, SessionOutput::Control(msg)) => Ok(vec![text_frame(&msg)]),
        (None, SessionOutput::Audio(bytes)) => Ok(vec![Message::Binary(bytes)]),
        (Some(send), SessionOutput::Control(msg)) => seal_control(send, &msg),
        (Some(send), SessionOutput::Audio(bytes)) => Ok(send
            .seal(OutboundKind::Audio, &bytes, Instant::now())?
            .into_iter()
            .map(Message::Binary)
            .collect()),
    }
}

/// One decoded inbound unit, independent of the codec.
enum Inbound {
    Control(String),
    Audio(Vec<u8>),
    /// A frame that needs no action (REKEY, KEEPALIVE, a fragment, a dropped BLOB).
    Nothing,
}

/// The encrypted `error` a secure session sends before it closes because the
/// device's DATA frame could not be opened: the device must rekey or reconnect
/// (design §4.7). Any other open failure closes the session without a message.
fn secure_open_failure_reply(error: &SecureError) -> Option<RhpServerMsg> {
    matches!(
        error,
        SecureError::RekeyOverdue | SecureError::NonceExhausted
    )
    .then(|| RhpServerMsg::Error {
        code: error.code().to_string(),
        message: error.to_string(),
    })
}

/// The shared session pump for both codecs, over the socket's halves (an
/// in-memory sink/stream in tests).
async fn run_session<Tx, Rx, E>(
    mut ws_tx: Tx,
    mut ws_rx: Rx,
    state: ServerState,
    start: SessionStart,
) where
    Tx: Sink<Message> + Unpin + Send + 'static,
    Rx: Stream<Item = Result<Message, E>> + Unpin,
{
    let SessionStart {
        record,
        hello,
        secure,
    } = start;
    let device_id = record.device_id.clone();
    let is_secure = secure.is_some();
    let (mut send_half, mut recv_half) = match secure {
        Some((send, recv)) => (Some(send), Some(recv)),
        None => (None, None),
    };

    // ── Meeting-ingest seam ─────────────────────────────────────────────────
    // The ambient audio path reaches meetings through the `MeetingIngest` trait
    // (not a direct engine field), so the kernel `ryu-hardware` crate links no
    // meetings code. The impl calls the `meetings.*` capabilities on whichever
    // enabled app provides them (`crate::meeting_capabilities`).
    let ingest: Arc<dyn MeetingIngest> =
        Arc::new(crate::meeting_capabilities::CapabilityMeetingIngest::new(
            crate::sidecar::capability_consumer::CapabilityConsumer::from_state(&state),
        ));

    // ── Open/resume the ambient session for ambient-capable devices ─────────
    let ambient_capable = hello.device_type.ambient_capable() && hello.caps.mic;
    let ambient_session_id = if ambient_capable {
        open_or_resume_ambient(&state, ingest.as_ref(), &device_id).await
    } else {
        None
    };

    // ── Build the session ───────────────────────────────────────────────────
    let agent_id = device_chat_agent(&state).await;
    let mut session = match HardwareSession::new(
        device_id.clone(),
        hello.device_type,
        hello.caps.clone(),
        ambient_session_id.clone(),
        Arc::clone(&ingest),
        agent_id,
    ) {
        Ok(s) => s,
        Err(e) => {
            let msg = RhpServerMsg::Error {
                code: "session_init".to_string(),
                message: format!("{e}"),
            };
            if let Ok(frames) = encode_output(send_half.as_mut(), SessionOutput::Control(msg)) {
                for frame in frames {
                    let _ = ws_tx.send(frame).await;
                }
            }
            return;
        }
    };

    // ── Ack ─────────────────────────────────────────────────────────────────
    let ack = hello_ack(is_secure, ambient_session_id.clone());
    let Ok(frames) = encode_output(send_half.as_mut(), SessionOutput::Control(ack)) else {
        return;
    };
    for frame in frames {
        if ws_tx.send(frame).await.is_err() {
            return;
        }
    }
    let _ = state.hardware.touch(&device_id, None).await;

    // ── Concurrent send task fed by the priority ctrl channel + session outputs ─
    let (out_tx, mut out_rx) = mpsc::channel::<SessionOutput>(256);
    // Register this device's outbound sender so out-of-band producers (the
    // dashboard nudge loop, the ambient rolling-summary, capability invokes) can
    // reach it without holding the socket.
    let live::LiveHandle {
        generation: connection_generation,
        mut ended,
        mut ctrl_rx,
    } = live::register(
        &device_id,
        out_tx.clone(),
        LiveMeta {
            name: record.name.clone(),
            device_type: record.device_type,
            secure: is_secure,
            relay: hello.relay,
        },
    )
    .await;
    // The opt-in cleartext emotion mirror for a relaying phone (design §4.9): the
    // phone may show coarse face state; it never forwards it to the device. Only a
    // secure relayed session can mirror; whether it does is re-read from the
    // device prefs per emotion frame, so a `PATCH relay_mirror: false` takes
    // effect on the live session instead of at the next reconnect.
    let mirror_possible = is_secure && hello.relay;
    let mirror_store = state.hardware.clone();
    let mirror_device_id = device_id.clone();
    // Shared barge-in flag: set by the recv side on `abort`, read by the send
    // side to drop queued TTS audio mid-stream.
    let abort = Arc::new(AtomicBool::new(false));
    let send_abort = Arc::clone(&abort);
    let mut send_task = tokio::spawn(async move {
        let mut ctrl_open = true;
        'pump: loop {
            // Capability invokes first: they must not queue behind TTS audio.
            let output = tokio::select! {
                biased;
                ctrl = ctrl_rx.recv(), if ctrl_open => match ctrl {
                    Some(msg) => SessionOutput::Control(msg),
                    None => {
                        ctrl_open = false;
                        continue;
                    }
                },
                out = out_rx.recv() => match out {
                    Some(output) => output,
                    None => break,
                },
            };
            // Barge-in: drop queued audio while aborting. The abort flag is reset
            // by the recv loop at the START of each new turn, so a fresh turn's
            // audio is never dropped by a stale abort.
            if matches!(output, SessionOutput::Audio(_)) && send_abort.load(Ordering::SeqCst) {
                continue;
            }
            let mirror_frame = match &output {
                SessionOutput::Control(RhpServerMsg::Emotion { value }) if mirror_possible => {
                    relay_mirror_on(&mirror_store, &mirror_device_id)
                        .await
                        .then(|| text_frame(&RhpServerMsg::Emotion { value: *value }))
                }
                _ => None,
            };
            let frames = match encode_output(send_half.as_mut(), output) {
                Ok(frames) => frames,
                Err(e) => {
                    // A send half that cannot seal (nonce exhausted, poisoned) ends
                    // the session; a sealed frame is never dropped silently.
                    tracing::debug!(target: "hardware", "hardware: closing session: {e}");
                    break;
                }
            };
            for frame in frames {
                if ws_tx.send(frame).await.is_err() {
                    break 'pump;
                }
            }
            if let Some(frame) = mirror_frame {
                if ws_tx.send(frame).await.is_err() {
                    break;
                }
            }
        }
        let _ = ws_tx.close().await;
    });
    let mut send_done = false;

    let mut capability_conn = CapabilityConn {
        device_id: device_id.clone(),
        generation: connection_generation,
        secure: is_secure,
        cap_generation: None,
    };

    // The in-flight chat turn (spawned off this loop so the loop stays responsive
    // to `abort`/audio while the model + TTS run). At most one runs at a time;
    // a new turn aborts and supersedes the old one (barge-in-then-speak).
    let mut turn_handle: Option<tokio::task::JoinHandle<()>> = None;

    // Liveness for secure sessions: 120 s without an inbound record, or 24 h of
    // session age, closes the session (design §4.7). Legacy sessions are unchanged.
    let session_expires = tokio::time::Instant::now() + secure::MAX_SESSION_AGE;
    let mut last_inbound = tokio::time::Instant::now();

    // ── Receive loop ────────────────────────────────────────────────────────
    loop {
        let idle_deadline = last_inbound + secure::NODE_IDLE_TIMEOUT;
        let frame = tokio::select! {
            _ = ended.changed() => {
                // A closed watch (our entry was dropped) still exposes the last
                // reason, so the device learns why either way.
                let reason = *ended.borrow();
                if let Some(reason) = reason {
                    let _ = out_tx
                        .send(SessionOutput::Control(end_message(reason, is_secure)))
                        .await;
                }
                break;
            }
            _ = &mut send_task, if !send_done => {
                send_done = true;
                break;
            }
            _ = tokio::time::sleep_until(idle_deadline), if is_secure => {
                tracing::debug!(target: "hardware", device_id = %device_id, "hardware: secure session idle; closing");
                break;
            }
            _ = tokio::time::sleep_until(session_expires), if is_secure => {
                let _ = out_tx
                    .send(SessionOutput::Control(RhpServerMsg::Error {
                        code: codes::SESSION_EXPIRED.to_string(),
                        message: "session reached its maximum age; reconnect".to_string(),
                    }))
                    .await;
                break;
            }
            frame = ws_rx.next() => frame,
        };
        let Some(Ok(frame)) = frame else { break };
        let ended_reason = *ended.borrow();
        if let Some(reason) = ended_reason {
            let _ = out_tx
                .send(SessionOutput::Control(end_message(reason, is_secure)))
                .await;
            break;
        }

        let inbound = match (frame, recv_half.as_mut()) {
            (Message::Ping(_) | Message::Pong(_), _) => continue,
            (Message::Close(_), _) => break,
            // Legacy: TEXT is control, BINARY is one Opus packet.
            (Message::Text(text), None) => Inbound::Control(text),
            (Message::Binary(bytes), None) => Inbound::Audio(bytes),
            // Secure: a TEXT frame after HS1 is a protocol violation.
            (Message::Text(_), Some(_)) => {
                tracing::debug!(target: "hardware", device_id = %device_id, "hardware: TEXT frame on a secure session; closing");
                break;
            }
            (Message::Binary(bytes), Some(recv)) => {
                last_inbound = tokio::time::Instant::now();
                match recv.open(&bytes, Instant::now()) {
                    Ok(None) => Inbound::Nothing,
                    Ok(Some(secure::Inbound::Control(text))) => Inbound::Control(text),
                    Ok(Some(secure::Inbound::Audio(packet))) => Inbound::Audio(packet),
                    Ok(Some(secure::Inbound::Blob(blob))) => {
                        // Camera bytes are dropped until the vision turn exists;
                        // they never reach the Opus decoder.
                        tracing::debug!(target: "hardware", "hardware: dropping {}-byte BLOB", blob.len());
                        Inbound::Nothing
                    }
                    Ok(Some(secure::Inbound::Keepalive)) => Inbound::Nothing,
                    Err(error) => {
                        if let Some(reply) = secure_open_failure_reply(&error) {
                            let _ = out_tx.send(SessionOutput::Control(reply)).await;
                        }
                        tracing::debug!(target: "hardware", device_id = %device_id, "hardware: secure session closed: {error}");
                        break;
                    }
                }
            }
        };

        match inbound {
            Inbound::Nothing => {}
            Inbound::Audio(bytes) => {
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
            Inbound::Control(text) => {
                let msg = match parse_client_msg(&text) {
                    Ok(m) => m,
                    Err(e) => {
                        // Unknown type: `unsupported_type`; malformed known type:
                        // `bad_json`. The session continues either way.
                        let _ = out_tx
                            .send(SessionOutput::Control(RhpServerMsg::Error {
                                code: e.code().to_string(),
                                message: e.to_string(),
                            }))
                            .await;
                        continue;
                    }
                };
                match handle_control(
                    &state,
                    &mut session,
                    &mut capability_conn,
                    msg,
                    text.len(),
                    &out_tx,
                    &abort,
                )
                .await
                {
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
        }
    }

    // Tear down: signal abort, drop the sender so the send task drains any final
    // message (`unpaired`, `session_superseded`, ...) and ends, and wait for any
    // in-flight turn + the send task to finish.
    live::unregister(&device_id, connection_generation).await;
    abort.store(true, Ordering::SeqCst);
    drop(out_tx);
    if let Some(handle) = turn_handle.take() {
        let _ = handle.await;
    }
    if !send_done {
        let _ = send_task.await;
    }
}

// ── Control dispatch ────────────────────────────────────────────────────────

/// What the recv loop should do after a control frame.
enum ControlOutcome {
    /// Keep looping.
    Continue,
    /// Spawn this chat turn (the loop owns the join handle for serialization).
    StartTurn(ChatTurn),
}

/// The per-connection state the capability messages need.
#[derive(Clone, Debug)]
pub(crate) struct CapabilityConn {
    pub device_id: String,
    /// The live-registry connection generation.
    pub generation: u64,
    /// Whether the session runs over the RHN secure layer.
    pub secure: bool,
    /// The last accepted `capabilities_register` generation in this session.
    pub cap_generation: Option<u32>,
}

async fn send_error(out_tx: &mpsc::Sender<SessionOutput>, code: &str, message: &str) {
    let _ = out_tx
        .send(SessionOutput::Control(RhpServerMsg::Error {
            code: code.to_string(),
            message: message.to_string(),
        }))
        .await;
}

/// Handle `capabilities_register` / `capability_result` (design §6.1). Both are
/// refused with `capabilities_require_secure_session` on a legacy session. A
/// register replaces the live capability table and is acknowledged with the
/// accepted names and per-descriptor rejections; an invalid register as a whole
/// gets `capabilities_rejected`. A result completes the pending invoke (stale or
/// unknown request ids are ignored).
///
/// `wire_len` is the byte length of the CONTROL message as received (before
/// parsing), so the register size cap (design §6.2) is enforced on what the
/// device actually sent, in lockstep with the firmware's `strlen` check, and
/// cannot be bypassed with fields the parser discards.
pub(crate) async fn handle_capability_msg(
    conn: &mut CapabilityConn,
    msg: RhpClientMsg,
    wire_len: usize,
    out_tx: &mpsc::Sender<SessionOutput>,
) {
    if !conn.secure {
        send_error(
            out_tx,
            codes::CAPABILITIES_REQUIRE_SECURE_SESSION,
            "device capabilities need a secure (v1.1) session",
        )
        .await;
        return;
    }
    match msg {
        RhpClientMsg::CapabilitiesRegister { .. } => {
            let RhpClientMsg::CapabilitiesRegister {
                generation,
                capabilities,
            } = msg
            else {
                return;
            };
            match capability::validate_register(
                generation,
                conn.cap_generation,
                &capabilities,
                wire_len,
            ) {
                Err(error) => send_error(out_tx, error.code(), error.message()).await,
                Ok((accepted, rejected)) => {
                    let names: Vec<String> = accepted.iter().map(|cap| cap.name.clone()).collect();
                    if !live::set_capabilities(
                        &conn.device_id,
                        conn.generation,
                        generation,
                        accepted,
                    )
                    .await
                    {
                        // The connection was superseded; its successor registers anew.
                        return;
                    }
                    conn.cap_generation = Some(generation);
                    let _ = out_tx
                        .send(SessionOutput::Control(RhpServerMsg::CapabilitiesAck {
                            generation,
                            accepted: names,
                            rejected,
                        }))
                        .await;
                }
            }
        }
        RhpClientMsg::CapabilityResult {
            request_id,
            ok,
            result,
            error,
        } => {
            let outcome = live::result_outcome(ok, result, error);
            if !live::complete(&conn.device_id, conn.generation, &request_id, outcome).await {
                tracing::debug!(target: "hardware", "hardware: ignoring a stale or unknown capability_result");
            }
        }
        _ => {}
    }
}

/// Dispatch one decoded control message. Side-effecting frames (mode, telemetry,
/// ping, abort, capabilities) are handled inline; a `listen:stop` / `text`
/// returns the turn to spawn so the recv loop can serialize and own its join
/// handle.
async fn handle_control(
    state: &ServerState,
    session: &mut HardwareSession,
    capability_conn: &mut CapabilityConn,
    msg: RhpClientMsg,
    wire_len: usize,
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
            // The next BINARY frame (legacy) or BLOB record (secure) is a JPEG.
            // Vision capture is firmware-complete but the node-side vision turn is
            // a documented follow-on; ack-free for now so the device isn't blocked.
        }
        RhpClientMsg::Telemetry {
            battery_pct,
            charging,
            ..
        } => {
            let _ = charging;
            let _ = state
                .hardware
                .touch(&capability_conn.device_id, Some(battery_pct))
                .await;
        }
        RhpClientMsg::Ping => {
            let _ = out_tx
                .send(SessionOutput::Control(RhpServerMsg::Pong))
                .await;
        }
        msg @ (RhpClientMsg::CapabilitiesRegister { .. }
        | RhpClientMsg::CapabilityResult { .. }) => {
            handle_capability_msg(capability_conn, msg, wire_len, out_tx).await;
        }
    }
    ControlOutcome::Continue
}

/// Whether the device currently opts in to the relay emotion mirror. Read from
/// the store each time so a prefs change applies to the live session; a missing
/// row or a store error fails closed (no cleartext mirror).
async fn relay_mirror_on(store: &DeviceStore, device_id: &str) -> bool {
    matches!(
        store.get(device_id).await,
        Ok(Some(record)) if capability::relay_mirror_enabled(&record.prefs)
    )
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

#[cfg(test)]
mod tests {
    use super::*;
    use ryu_hardware::identity::{NodeIdentity, PlaintextSealerForTests};
    use ryu_hardware::secure::ClientHandshake;
    use ryu_hardware::store::hash_token;
    use std::convert::Infallible;
    use tokio_util::sync::PollSender;

    /// The `error` frame is a `type`-tagged TEXT message carrying the code + message
    /// verbatim — the shape the legacy handshake rejects (`expected_hello`,
    /// `bad_json`, `unauthorized`, `noise_required`) rely on the device parsing.
    #[test]
    fn error_frame_is_tagged_and_carries_fields() {
        let Message::Text(text) = error_frame("unauthorized", "pair first") else {
            panic!("error_frame must produce a TEXT frame");
        };
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["type"], "error");
        assert_eq!(v["code"], "unauthorized");
        assert_eq!(v["message"], "pair first");
    }

    /// `text_frame` serializes a server control message to a routable `type`-tagged
    /// frame (Pong is the liveness reply the recv loop emits).
    #[test]
    fn text_frame_tags_control_messages() {
        let Message::Text(text) = text_frame(&RhpServerMsg::Pong) else {
            panic!("expected TEXT");
        };
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["type"], "pong");
    }

    fn hello_json(device_id: &str, relay: bool) -> String {
        serde_json::json!({
            "type": "hello",
            "device_id": device_id,
            "device_type": "necklace",
            "fw_version": "1.1.0",
            "relay": relay,
            "audio": { "codec": "opus", "sample_rate": 16000, "frame_ms": 60 },
            "caps": { "mic": true, "speaker": true, "camera": false, "display": false },
        })
        .to_string()
    }

    /// A `hello` control frame round-trips through the client-message parser the
    /// handshake uses — the first accepted frame must decode to `Hello`.
    #[test]
    fn hello_frame_parses_as_client_hello() {
        match parse_client_msg(&hello_json("dev-1", false)) {
            Ok(RhpClientMsg::Hello { device_id, .. }) => assert_eq!(device_id, "dev-1"),
            other => panic!("expected Hello, got {other:?}"),
        }
    }

    /// A non-hello first frame is parseable but is NOT `Hello`, so the legacy
    /// handshake rejects it with `expected_hello`.
    #[test]
    fn ping_frame_is_not_hello() {
        let frame = serde_json::json!({ "type": "ping" }).to_string();
        let msg = serde_json::from_str::<RhpClientMsg>(&frame).expect("ping decodes");
        assert!(
            !matches!(msg, RhpClientMsg::Hello { .. }),
            "a ping must not satisfy the hello handshake arm"
        );
    }

    // ── Harness ─────────────────────────────────────────────────────────────

    type NodeTx = PollSender<Message>;
    type NodeRx = std::pin::Pin<Box<dyn Stream<Item = Result<Message, Infallible>> + Send>>;

    /// In-memory socket: the node's sink/stream plus the device's ends.
    struct Wire {
        node_tx: NodeTx,
        node_rx: NodeRx,
        to_node: mpsc::Sender<Result<Message, Infallible>>,
        from_node: mpsc::Receiver<Message>,
    }

    fn wire() -> Wire {
        let (to_node, mut node_inbox) = mpsc::channel::<Result<Message, Infallible>>(16);
        let (node_outbox, from_node) = mpsc::channel::<Message>(16);
        let node_rx: NodeRx = Box::pin(futures_util::stream::poll_fn(move |cx| {
            node_inbox.poll_recv(cx)
        }));
        Wire {
            node_tx: PollSender::new(node_outbox),
            node_rx,
            to_node,
            from_node,
        }
    }

    fn temp_store() -> DeviceStore {
        let path = std::env::temp_dir()
            .join(format!("ryu-core-hw-ws-{}", uuid::Uuid::new_v4()))
            .join("hardware.db");
        let store = DeviceStore::open(path).unwrap();
        store.set_key_sealer(Arc::new(PlaintextSealerForTests));
        store
    }

    const DEVICE_SECRET: [u8; 32] = [0x11; 32];
    const OTHER_SECRET: [u8; 32] = [0x22; 32];

    fn public_of(secret: [u8; 32]) -> [u8; 32] {
        NodeIdentity::from_secret_bytes(secret).public()
    }

    /// A level-2 row pinned to `pinned_secret`'s public key.
    async fn secure_row(store: &DeviceStore, device_id: &str, pinned_secret: [u8; 32]) {
        let record = DeviceRecord {
            noise_pubkey: Some(pair_crypto::b64u_encode(&public_of(pinned_secret))),
            protocol_level: PROTOCOL_LEVEL_SECURE,
            key_verification: Some("sas".into()),
            key_source: Some("qr".into()),
            relay_token_hash: Some(hash_token("rhr_relay")),
            paired_at: Some(1),
            ..DeviceRecord::new_legacy(
                device_id,
                DeviceType::Necklace,
                "Necklace",
                hash_token("rht_device"),
                1,
            )
        };
        store.insert(record).await.unwrap();
    }

    fn unique_id(label: &str) -> String {
        format!(
            "rhn_{label}_{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        )
    }

    /// What the device side observed.
    #[derive(Debug, Default)]
    struct DeviceView {
        /// Every PLAIN_ERROR code received.
        plain_errors: Vec<String>,
        /// Whether an HS2 arrived.
        got_hs2: bool,
        /// Encrypted control messages received after HS3.
        encrypted: Vec<serde_json::Value>,
    }

    /// Play a device: send HS1, answer HS2 with HS3 carrying `hello`, then collect
    /// whatever the node sends until it stops.
    async fn play_device(
        to_node: mpsc::Sender<Result<Message, Infallible>>,
        mut from_node: mpsc::Receiver<Message>,
        device_secret: [u8; 32],
        node_pub: [u8; 32],
        prologue_id: &str,
        hello: String,
    ) -> DeviceView {
        let mut view = DeviceView::default();
        let mut device = ClientHandshake::new(device_secret, node_pub, prologue_id).unwrap();
        let hs1 = device.hs1().unwrap();
        to_node.send(Ok(Message::Binary(hs1))).await.unwrap();
        let mut device = Some(device);
        let mut recv: Option<RecvHalf> = None;
        while let Some(frame) = from_node.recv().await {
            let Message::Binary(bytes) = frame else {
                continue;
            };
            if let Some(code) = secure::parse_plain_error(&bytes) {
                view.plain_errors.push(code.to_string());
                continue;
            }
            match bytes.first() {
                Some(&secure::OUT_HS2) => {
                    view.got_hs2 = true;
                    let (hs3, _send, recv_half) = device
                        .take()
                        .unwrap()
                        .on_hs2(&bytes, &hello, Instant::now())
                        .unwrap();
                    recv = Some(recv_half);
                    to_node.send(Ok(Message::Binary(hs3))).await.unwrap();
                }
                Some(&secure::OUT_DATA) => {
                    if let Ok(Some(secure::Inbound::Control(text))) =
                        recv.as_mut().unwrap().open(&bytes, Instant::now())
                    {
                        view.encrypted.push(serde_json::from_str(&text).unwrap());
                    }
                }
                _ => {}
            }
        }
        // The device's sender lived until the node finished.
        drop(to_node);
        view
    }

    /// Run the node handshake against a scripted device.
    async fn run_handshake(
        store: &DeviceStore,
        limiter: &HandshakeLimiter,
        bearer: Option<&str>,
        device_secret: [u8; 32],
        prologue_id: &str,
        hello: String,
    ) -> (Result<SecureStart, HandshakeRefusal>, DeviceView) {
        let node_pub = store.node_identity().await.unwrap().public();
        let Wire {
            mut node_tx,
            mut node_rx,
            to_node,
            from_node,
        } = wire();
        let (hs1_tx, mut hs1_rx) = mpsc::channel::<Vec<u8>>(1);
        // The device's HS1 arrives through the node stream; the first-frame read
        // is reproduced here so the handshake gets it as `hs1`.
        let device = play_device(
            to_node,
            from_node,
            device_secret,
            node_pub,
            prologue_id,
            hello,
        );
        let node = async move {
            let FirstFrame::SecureHs1(hs1) = read_first_frame(&mut node_rx).await else {
                panic!("expected HS1");
            };
            let _ = hs1_tx.send(hs1.clone()).await;
            let result = secure_handshake(
                &mut node_tx,
                &mut node_rx,
                store,
                bearer,
                &hs1,
                limiter,
                Instant::now(),
            )
            .await;
            // Closing the node's sink ends the device loop.
            drop(node_tx);
            drop(node_rx);
            result
        };
        let (result, view) = tokio::join!(node, device);
        assert!(hs1_rx.recv().await.is_some());
        (result, view)
    }

    // ── Classification ──────────────────────────────────────────────────────

    async fn classify(frames: Vec<Message>) -> FirstFrame {
        let mut stream = futures_util::stream::iter(frames.into_iter().map(Ok::<_, Infallible>));
        read_first_frame(&mut stream).await
    }

    #[tokio::test]
    async fn first_frame_classification() {
        assert_eq!(
            classify(vec![Message::Ping(vec![]), Message::Text("{}".into())]).await,
            FirstFrame::LegacyText("{}".into())
        );
        assert_eq!(
            classify(vec![Message::Binary(vec![0x01, 0x01, 0x01, 0x00])]).await,
            FirstFrame::SecureHs1(vec![0x01, 0x01, 0x01, 0x00])
        );
        assert_eq!(
            classify(vec![Message::Binary(vec![0x04, 0x00])]).await,
            FirstFrame::Invalid
        );
        assert_eq!(
            classify(vec![Message::Binary(vec![])]).await,
            FirstFrame::Invalid
        );
        assert_eq!(
            classify(vec![Message::Close(None)]).await,
            FirstFrame::Closed
        );
        assert_eq!(classify(vec![]).await, FirstFrame::Closed);
    }

    // ── Handshake ───────────────────────────────────────────────────────────

    #[tokio::test]
    async fn secure_handshake_happy_path_device_and_relay() {
        let store = temp_store();
        let limiter = HandshakeLimiter::default();
        let id = unique_id("ok");
        secure_row(&store, &id, DEVICE_SECRET).await;

        let (result, view) = run_handshake(
            &store,
            &limiter,
            Some("rht_device"),
            DEVICE_SECRET,
            &id,
            hello_json(&id, false),
        )
        .await;
        let start = result.expect("handshake succeeds");
        assert_eq!(start.record.device_id, id);
        assert_eq!(start.kind, TokenKind::Device);
        assert!(!start.hello.relay);
        assert!(view.got_hs2);
        assert!(view.plain_errors.is_empty());
        assert!(view.encrypted.is_empty());

        let (result, _) = run_handshake(
            &store,
            &limiter,
            Some("rhr_relay"),
            DEVICE_SECRET,
            &id,
            hello_json(&id, true),
        )
        .await;
        let start = result.expect("relay handshake succeeds");
        assert_eq!(start.kind, TokenKind::Relay);
        assert!(start.hello.relay);
        // The concurrency slots were released.
        assert_eq!(limiter.lock().active, 0);
    }

    #[tokio::test]
    async fn secure_session_halves_interoperate_with_the_device() {
        let store = temp_store();
        let limiter = HandshakeLimiter::default();
        let id = unique_id("halves");
        secure_row(&store, &id, DEVICE_SECRET).await;
        let node_pub = store.node_identity().await.unwrap().public();

        let Wire {
            mut node_tx,
            mut node_rx,
            to_node,
            mut from_node,
        } = wire();
        let mut device = ClientHandshake::new(DEVICE_SECRET, node_pub, &id).unwrap();
        to_node
            .send(Ok(Message::Binary(device.hs1().unwrap())))
            .await
            .unwrap();
        let FirstFrame::SecureHs1(hs1) = read_first_frame(&mut node_rx).await else {
            panic!("expected HS1");
        };
        let hello = hello_json(&id, false);
        let device_side = async {
            let Some(Message::Binary(hs2)) = from_node.recv().await else {
                panic!("expected HS2");
            };
            let (hs3, send, recv) = device.on_hs2(&hs2, &hello, Instant::now()).unwrap();
            to_node.send(Ok(Message::Binary(hs3))).await.unwrap();
            (send, recv)
        };
        let node_side = secure_handshake(
            &mut node_tx,
            &mut node_rx,
            &store,
            Some("rht_device"),
            &hs1,
            &limiter,
            Instant::now(),
        );
        let (start, (mut device_send, mut device_recv)) = tokio::join!(node_side, device_side);
        let mut start = start.expect("handshake succeeds");

        // Node -> device: the secure hello_ack carries proto and cap_limits.
        let frames = encode_output(
            Some(&mut start.send),
            SessionOutput::Control(hello_ack(true, None)),
        )
        .unwrap();
        let Message::Binary(frame) = &frames[0] else {
            panic!("secure frames are BINARY");
        };
        let Some(secure::Inbound::Control(text)) = device_recv.open(frame, Instant::now()).unwrap()
        else {
            panic!("expected CONTROL");
        };
        let ack: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(ack["type"], "hello_ack");
        assert_eq!(ack["proto"], "1.1");
        assert_eq!(ack["cap_limits"]["max_inflight"], 4);

        // Device -> node.
        let frames = device_send
            .seal(OutboundKind::Control, br#"{"type":"ping"}"#, Instant::now())
            .unwrap();
        let opened = start.recv.open(&frames[0], Instant::now()).unwrap();
        assert_eq!(
            opened,
            Some(secure::Inbound::Control(r#"{"type":"ping"}"#.into()))
        );
    }

    #[tokio::test]
    async fn bad_or_missing_bearer_is_refused_before_any_dh() {
        let store = temp_store();
        let limiter = HandshakeLimiter::default();
        let id = unique_id("bearer");
        secure_row(&store, &id, DEVICE_SECRET).await;
        for bearer in [None, Some(""), Some("rht_wrong")] {
            let (result, view) = run_handshake(
                &store,
                &limiter,
                bearer,
                DEVICE_SECRET,
                &id,
                hello_json(&id, false),
            )
            .await;
            assert_eq!(result.err(), Some(HandshakeRefusal::Plain("unauthorized")));
            assert!(
                !view.got_hs2,
                "no HS2 may be sent to an unauthenticated peer"
            );
            assert_eq!(view.plain_errors, ["unauthorized"]);
        }
    }

    #[tokio::test]
    async fn a_level_one_row_needs_repair() {
        let store = temp_store();
        let limiter = HandshakeLimiter::default();
        let id = unique_id("legacy");
        store
            .insert(DeviceRecord::new_legacy(
                id.clone(),
                DeviceType::Necklace,
                "Necklace",
                hash_token("rht_device"),
                1,
            ))
            .await
            .unwrap();
        let (result, view) = run_handshake(
            &store,
            &limiter,
            Some("rht_device"),
            DEVICE_SECRET,
            &id,
            hello_json(&id, false),
        )
        .await;
        assert_eq!(
            result.err(),
            Some(HandshakeRefusal::Plain("repair_required"))
        );
        assert!(!view.got_hs2);
        assert_eq!(view.plain_errors, ["repair_required"]);
    }

    #[tokio::test]
    async fn bad_hs1_versions_and_shapes_get_plain_errors() {
        let store = temp_store();
        let limiter = HandshakeLimiter::default();
        let Wire {
            mut node_tx,
            mut node_rx,
            to_node: _to_node,
            mut from_node,
        } = wire();
        let mut wrong_version = vec![0x01, 0x02, 0x01, 0x00];
        wrong_version.extend([0u8; 32]);
        let result = secure_handshake(
            &mut node_tx,
            &mut node_rx,
            &store,
            Some("rht_device"),
            &wrong_version,
            &limiter,
            Instant::now(),
        )
        .await;
        assert_eq!(
            result.err(),
            Some(HandshakeRefusal::Plain("unsupported_version"))
        );
        let Some(Message::Binary(frame)) = from_node.recv().await else {
            panic!("expected PLAIN_ERROR");
        };
        assert_eq!(
            secure::parse_plain_error(&frame),
            Some("unsupported_version")
        );

        let result = secure_handshake(
            &mut node_tx,
            &mut node_rx,
            &store,
            Some("rht_device"),
            &[0x01, 0x01, 0x01, 0x00, 0xAA],
            &limiter,
            Instant::now(),
        )
        .await;
        assert_eq!(result.err(), Some(HandshakeRefusal::Plain("bad_frame")));
    }

    #[tokio::test]
    async fn pin_mismatch_gets_an_encrypted_unauthorized() {
        let store = temp_store();
        let limiter = HandshakeLimiter::default();
        let id = unique_id("pin");
        // The row pins a different key than the device presents.
        secure_row(&store, &id, OTHER_SECRET).await;
        let (result, view) = run_handshake(
            &store,
            &limiter,
            Some("rht_device"),
            DEVICE_SECRET,
            &id,
            hello_json(&id, false),
        )
        .await;
        assert_eq!(
            result.err(),
            Some(HandshakeRefusal::Encrypted("unauthorized"))
        );
        assert!(view.got_hs2);
        assert!(
            view.plain_errors.is_empty(),
            "post-HS3 refusals are encrypted"
        );
        assert_eq!(view.encrypted.len(), 1);
        assert_eq!(view.encrypted[0]["type"], "error");
        assert_eq!(view.encrypted[0]["code"], "unauthorized");
    }

    #[tokio::test]
    async fn hello_device_id_mismatch_gets_an_encrypted_unauthorized() {
        let store = temp_store();
        let limiter = HandshakeLimiter::default();
        let id = unique_id("idmis");
        secure_row(&store, &id, DEVICE_SECRET).await;
        let (result, view) = run_handshake(
            &store,
            &limiter,
            Some("rht_device"),
            DEVICE_SECRET,
            &id,
            hello_json("rhn_someone_else", false),
        )
        .await;
        assert_eq!(
            result.err(),
            Some(HandshakeRefusal::Encrypted("unauthorized"))
        );
        assert_eq!(view.encrypted[0]["code"], "unauthorized");
    }

    #[tokio::test]
    async fn a_prologue_for_another_device_fails_the_handshake() {
        let store = temp_store();
        let limiter = HandshakeLimiter::default();
        let id = unique_id("prol");
        secure_row(&store, &id, DEVICE_SECRET).await;
        // The device binds a different device_id into its prologue: HS2 does not
        // decrypt on the device side, so this test device panics on unwrap; drive
        // it manually instead and check that no session results.
        let node_pub = store.node_identity().await.unwrap().public();
        let Wire {
            mut node_tx,
            mut node_rx,
            to_node,
            mut from_node,
        } = wire();
        let mut device =
            ClientHandshake::new(DEVICE_SECRET, node_pub, "rhn_wrong_prologue").unwrap();
        to_node
            .send(Ok(Message::Binary(device.hs1().unwrap())))
            .await
            .unwrap();
        let FirstFrame::SecureHs1(hs1) = read_first_frame(&mut node_rx).await else {
            panic!("expected HS1");
        };
        let device_side = async {
            let Some(Message::Binary(hs2)) = from_node.recv().await else {
                panic!("expected HS2");
            };
            assert!(device
                .on_hs2(&hs2, &hello_json(&id, false), Instant::now())
                .is_err());
            drop(to_node);
        };
        let node_side = secure_handshake(
            &mut node_tx,
            &mut node_rx,
            &store,
            Some("rht_device"),
            &hs1,
            &limiter,
            Instant::now(),
        );
        let (result, ()) = tokio::join!(node_side, device_side);
        assert_eq!(result.err(), Some(HandshakeRefusal::Closed));
    }

    #[tokio::test]
    async fn relay_flag_must_match_the_token_kind() {
        let store = temp_store();
        let limiter = HandshakeLimiter::default();
        let id = unique_id("relay");
        secure_row(&store, &id, DEVICE_SECRET).await;
        // Relay token, but the hello claims a direct connection.
        let (result, view) = run_handshake(
            &store,
            &limiter,
            Some("rhr_relay"),
            DEVICE_SECRET,
            &id,
            hello_json(&id, false),
        )
        .await;
        assert_eq!(
            result.err(),
            Some(HandshakeRefusal::Encrypted("unauthorized"))
        );
        assert_eq!(view.encrypted[0]["code"], "unauthorized");
        // Device token, but the hello claims a relay.
        let (result, _) = run_handshake(
            &store,
            &limiter,
            Some("rht_device"),
            DEVICE_SECRET,
            &id,
            hello_json(&id, true),
        )
        .await;
        assert_eq!(
            result.err(),
            Some(HandshakeRefusal::Encrypted("unauthorized"))
        );
    }

    #[tokio::test]
    async fn handshakes_are_rate_limited_per_device() {
        let store = temp_store();
        let limiter = HandshakeLimiter::default();
        let id = unique_id("rate");
        secure_row(&store, &id, DEVICE_SECRET).await;
        let now = Instant::now();
        for _ in 0..HANDSHAKES_PER_DEVICE {
            drop(limiter.try_acquire(&id, now).expect("within the rate"));
        }
        let (result, view) = run_handshake(
            &store,
            &limiter,
            Some("rht_device"),
            DEVICE_SECRET,
            &id,
            hello_json(&id, false),
        )
        .await;
        assert_eq!(result.err(), Some(HandshakeRefusal::Plain("rate_limited")));
        assert!(!view.got_hs2);
        // Another device is unaffected, and the window slides.
        assert!(limiter.try_acquire("rhn_other", now).is_some());
        assert!(limiter.try_acquire(&id, now + HANDSHAKE_WINDOW).is_some());
    }

    #[test]
    fn concurrent_handshakes_are_capped_node_wide() {
        let limiter = HandshakeLimiter::default();
        let now = Instant::now();
        let permits: Vec<_> = (0..MAX_CONCURRENT_HANDSHAKES)
            .map(|i| limiter.try_acquire(&format!("rhn_dev{i}"), now).unwrap())
            .collect();
        assert!(limiter.try_acquire("rhn_late", now).is_none());
        drop(permits);
        assert!(limiter.try_acquire("rhn_late", now).is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn hs3_timeout_sends_handshake_timeout() {
        let store = temp_store();
        let limiter = HandshakeLimiter::default();
        let id = unique_id("timeout");
        secure_row(&store, &id, DEVICE_SECRET).await;
        let node_pub = store.node_identity().await.unwrap().public();
        let Wire {
            mut node_tx,
            mut node_rx,
            to_node,
            mut from_node,
        } = wire();
        let mut device = ClientHandshake::new(DEVICE_SECRET, node_pub, &id).unwrap();
        let hs1 = device.hs1().unwrap();
        // The device keeps its sender open but never sends HS3.
        let result = secure_handshake(
            &mut node_tx,
            &mut node_rx,
            &store,
            Some("rht_device"),
            &hs1,
            &limiter,
            Instant::now(),
        )
        .await;
        assert_eq!(
            result.err(),
            Some(HandshakeRefusal::Plain("handshake_timeout"))
        );
        let Some(Message::Binary(hs2)) = from_node.recv().await else {
            panic!("expected HS2");
        };
        assert_eq!(hs2.first(), Some(&secure::OUT_HS2));
        let Some(Message::Binary(error)) = from_node.recv().await else {
            panic!("expected PLAIN_ERROR");
        };
        assert_eq!(secure::parse_plain_error(&error), Some("handshake_timeout"));
        drop(to_node);
    }

    #[tokio::test]
    async fn a_garbled_hs3_fails_the_handshake() {
        let store = temp_store();
        let limiter = HandshakeLimiter::default();
        let id = unique_id("garbled");
        secure_row(&store, &id, DEVICE_SECRET).await;
        let node_pub = store.node_identity().await.unwrap().public();
        let Wire {
            mut node_tx,
            mut node_rx,
            to_node,
            mut from_node,
        } = wire();
        let mut device = ClientHandshake::new(DEVICE_SECRET, node_pub, &id).unwrap();
        let hs1 = device.hs1().unwrap();
        let mut garbage = vec![secure::OUT_HS3];
        garbage.extend([0x5Au8; 80]);
        to_node.send(Ok(Message::Binary(garbage))).await.unwrap();
        let result = secure_handshake(
            &mut node_tx,
            &mut node_rx,
            &store,
            Some("rht_device"),
            &hs1,
            &limiter,
            Instant::now(),
        )
        .await;
        assert_eq!(
            result.err(),
            Some(HandshakeRefusal::Plain("handshake_failed"))
        );
        let _hs2 = from_node.recv().await;
        let Some(Message::Binary(error)) = from_node.recv().await else {
            panic!("expected PLAIN_ERROR");
        };
        assert_eq!(secure::parse_plain_error(&error), Some("handshake_failed"));
    }

    /// Design §4.4 step 4: a node whose identity cannot be opened (here: no key
    /// sealer) refuses with PLAIN_ERROR `node_identity_unavailable` and never sends
    /// HS2, so no DH runs; the handshake slot is released.
    #[tokio::test]
    async fn an_unavailable_node_identity_is_refused_before_hs2() {
        let dir = tempfile::tempdir().unwrap();
        let store = DeviceStore::open(dir.path().join("hardware.db")).unwrap();
        let limiter = HandshakeLimiter::default();
        let id = unique_id("noidentity");
        secure_row(&store, &id, DEVICE_SECRET).await;
        let Wire {
            mut node_tx,
            mut node_rx,
            to_node,
            mut from_node,
        } = wire();
        let mut device = ClientHandshake::new(DEVICE_SECRET, public_of(OTHER_SECRET), &id).unwrap();
        let hs1 = device.hs1().unwrap();
        let result = secure_handshake(
            &mut node_tx,
            &mut node_rx,
            &store,
            Some("rht_device"),
            &hs1,
            &limiter,
            Instant::now(),
        )
        .await;
        assert_eq!(
            result.err(),
            Some(HandshakeRefusal::Plain("node_identity_unavailable"))
        );
        assert_eq!(limiter.lock().active, 0);
        drop(node_tx);
        let Some(Message::Binary(error)) = from_node.recv().await else {
            panic!("expected PLAIN_ERROR");
        };
        assert_eq!(
            secure::parse_plain_error(&error),
            Some("node_identity_unavailable")
        );
        assert!(
            from_node.recv().await.is_none(),
            "nothing else, in particular no HS2"
        );
        drop(to_node);
    }

    /// Design §4.4 step 6: once HS2 is out, the only acceptable frame is a BINARY
    /// HS3; a TEXT frame (for example a legacy hello) is PLAIN_ERROR `bad_frame`.
    #[tokio::test]
    async fn a_text_frame_instead_of_hs3_is_a_bad_frame() {
        let store = temp_store();
        let limiter = HandshakeLimiter::default();
        let id = unique_id("texths3");
        secure_row(&store, &id, DEVICE_SECRET).await;
        let node_pub = store.node_identity().await.unwrap().public();
        let Wire {
            mut node_tx,
            mut node_rx,
            to_node,
            mut from_node,
        } = wire();
        let mut device = ClientHandshake::new(DEVICE_SECRET, node_pub, &id).unwrap();
        let hs1 = device.hs1().unwrap();
        to_node
            .send(Ok(Message::Text(hello_json(&id, false).into())))
            .await
            .unwrap();
        let result = secure_handshake(
            &mut node_tx,
            &mut node_rx,
            &store,
            Some("rht_device"),
            &hs1,
            &limiter,
            Instant::now(),
        )
        .await;
        assert_eq!(result.err(), Some(HandshakeRefusal::Plain("bad_frame")));
        let Some(Message::Binary(hs2)) = from_node.recv().await else {
            panic!("expected HS2");
        };
        assert_eq!(hs2.first(), Some(&secure::OUT_HS2));
        let Some(Message::Binary(error)) = from_node.recv().await else {
            panic!("expected PLAIN_ERROR");
        };
        assert_eq!(secure::parse_plain_error(&error), Some("bad_frame"));
    }

    // ── Legacy policy ───────────────────────────────────────────────────────

    #[test]
    fn legacy_policy_refuses_level_two_and_disabled_legacy() {
        let legacy = DeviceRecord::new_legacy("rhn_l", DeviceType::Necklace, "N", "h", 1);
        assert_eq!(legacy_policy(&legacy, None), Ok(()));
        assert_eq!(legacy_policy(&legacy, Some("true")), Ok(()));
        assert_eq!(legacy_policy(&legacy, Some("")), Ok(()));
        assert_eq!(
            legacy_policy(&legacy, Some("false")),
            Err("legacy_disabled")
        );
        assert_eq!(
            legacy_policy(&legacy, Some(" FALSE ")),
            Err("legacy_disabled")
        );

        let secure = DeviceRecord {
            protocol_level: PROTOCOL_LEVEL_SECURE,
            noise_pubkey: Some(pair_crypto::b64u_encode(&[9u8; 32])),
            ..legacy
        };
        assert_eq!(legacy_policy(&secure, None), Err("noise_required"));
        assert_eq!(legacy_policy(&secure, Some("false")), Err("noise_required"));
    }

    #[test]
    fn hello_ack_extends_only_secure_sessions() {
        let legacy = serde_json::to_value(hello_ack(false, None)).unwrap();
        assert!(legacy.get("proto").is_none());
        assert!(legacy.get("cap_limits").is_none());
        assert_eq!(
            legacy["tts"],
            serde_json::to_value(HardwareSession::tts_format()).unwrap()
        );

        let secure = serde_json::to_value(hello_ack(true, Some("m1".into()))).unwrap();
        assert_eq!(secure["proto"], "1.1");
        assert_eq!(
            secure["cap_limits"],
            serde_json::json!({ "max_caps": 32, "max_inflight": 4, "max_result_bytes": 16384 })
        );
        assert_eq!(secure["ambient_session_id"], "m1");
    }

    #[test]
    fn end_messages_distinguish_revoke_from_supersede() {
        assert_eq!(
            end_message(EndReason::Revoked, true),
            RhpServerMsg::Unpaired
        );
        let RhpServerMsg::Error { code, .. } = end_message(EndReason::Revoked, false) else {
            panic!("legacy revoke is an error");
        };
        assert_eq!(code, "device_revoked");
        for secure in [true, false] {
            let RhpServerMsg::Error { code, .. } = end_message(EndReason::Superseded, secure)
            else {
                panic!("supersede is an error");
            };
            assert_eq!(code, "session_superseded");
        }
    }

    #[test]
    fn legacy_outputs_stay_plaintext() {
        let frames = encode_output(None, SessionOutput::Control(RhpServerMsg::Pong)).unwrap();
        assert!(matches!(&frames[..], [Message::Text(_)]));
        let frames = encode_output(None, SessionOutput::Audio(vec![1, 2, 3])).unwrap();
        assert_eq!(frames, vec![Message::Binary(vec![1, 2, 3])]);
    }

    // ── Capability arm ──────────────────────────────────────────────────────

    /// A plausible on-the-wire length for [`register_msg`], well under the cap.
    const REGISTER_LEN: usize = 256;

    fn register_msg(generation: u32) -> RhpClientMsg {
        RhpClientMsg::CapabilitiesRegister {
            generation,
            capabilities: vec![
                serde_json::json!({
                    "name": "device.status",
                    "description": "Report status",
                    "params": { "required": {}, "optional": {} },
                }),
                serde_json::json!({ "name": "ryu.secret", "description": "nope" }),
            ],
        }
    }

    fn next_control(rx: &mut mpsc::Receiver<SessionOutput>) -> RhpServerMsg {
        match rx.try_recv() {
            Ok(SessionOutput::Control(msg)) => msg,
            Ok(SessionOutput::Audio(_)) => panic!("unexpected audio"),
            Err(e) => panic!("no control message: {e}"),
        }
    }

    #[tokio::test]
    async fn capability_messages_need_a_secure_session() {
        let (out_tx, mut out_rx) = mpsc::channel(8);
        let mut conn = CapabilityConn {
            device_id: unique_id("capleg"),
            generation: 1,
            secure: false,
            cap_generation: None,
        };
        handle_capability_msg(&mut conn, register_msg(1), REGISTER_LEN, &out_tx).await;
        let RhpServerMsg::Error { code, .. } = next_control(&mut out_rx) else {
            panic!("expected an error");
        };
        assert_eq!(code, "capabilities_require_secure_session");
        assert_eq!(conn.cap_generation, None);
    }

    #[tokio::test]
    async fn capability_register_size_cap_uses_wire_length() {
        // A register whose parsed form is tiny but whose received bytes exceed the
        // cap (padding with fields the parser drops) is rejected as a whole.
        let (out_tx, mut out_rx) = mpsc::channel(8);
        let mut conn = CapabilityConn {
            device_id: unique_id("capbig"),
            generation: 1,
            secure: true,
            cap_generation: None,
        };
        handle_capability_msg(
            &mut conn,
            register_msg(1),
            capability::MAX_REGISTER_BYTES + 1,
            &out_tx,
        )
        .await;
        let RhpServerMsg::Error { code, .. } = next_control(&mut out_rx) else {
            panic!("expected an error");
        };
        assert_eq!(code, "capabilities_rejected");
        assert_eq!(conn.cap_generation, None);
    }

    #[tokio::test]
    async fn capability_register_and_result_round_trip() {
        let id = unique_id("caps");
        let (session_tx, _session_rx) = mpsc::channel(8);
        let mut handle = live::register(
            &id,
            session_tx,
            LiveMeta {
                name: "Necklace".into(),
                device_type: DeviceType::Necklace,
                secure: true,
                relay: false,
            },
        )
        .await;
        let (out_tx, mut out_rx) = mpsc::channel(8);
        let mut conn = CapabilityConn {
            device_id: id.clone(),
            generation: handle.generation,
            secure: true,
            cap_generation: None,
        };

        // A register is validated, stored and acknowledged.
        handle_capability_msg(&mut conn, register_msg(1), REGISTER_LEN, &out_tx).await;
        let RhpServerMsg::CapabilitiesAck {
            generation,
            accepted,
            rejected,
        } = next_control(&mut out_rx)
        else {
            panic!("expected capabilities_ack");
        };
        assert_eq!(generation, 1);
        assert_eq!(accepted, ["device.status"]);
        assert_eq!(rejected.len(), 1);
        assert_eq!(rejected[0].name, "ryu.secret");
        assert_eq!(conn.cap_generation, Some(1));
        let live_caps = live::capabilities_for(&id).await.unwrap();
        assert_eq!(live_caps.caps.len(), 1);

        // A non-increasing generation is rejected as a whole.
        handle_capability_msg(&mut conn, register_msg(1), REGISTER_LEN, &out_tx).await;
        let RhpServerMsg::Error { code, .. } = next_control(&mut out_rx) else {
            panic!("expected an error");
        };
        assert_eq!(code, "capabilities_rejected");

        // A result completes the pending invoke.
        let invoke_id = id.clone();
        let invoke = tokio::spawn(async move {
            live::invoke(
                &invoke_id,
                "device.status",
                serde_json::json!({}),
                Duration::from_secs(5),
            )
            .await
        });
        let RhpServerMsg::CapabilityInvoke { request_id, .. } =
            handle.ctrl_rx.recv().await.expect("invoke queued")
        else {
            panic!("expected capability_invoke");
        };
        handle_capability_msg(
            &mut conn,
            RhpClientMsg::CapabilityResult {
                request_id,
                ok: true,
                result: Some(serde_json::json!({ "uptime_s": 7 })),
                error: None,
            },
            0,
            &out_tx,
        )
        .await;
        let value = invoke.await.unwrap().expect("invoke succeeds");
        assert_eq!(value["uptime_s"], 7);

        // An unknown request id is ignored without an error reply.
        handle_capability_msg(
            &mut conn,
            RhpClientMsg::CapabilityResult {
                request_id: "inv_0_0".into(),
                ok: true,
                result: None,
                error: None,
            },
            0,
            &out_tx,
        )
        .await;
        assert!(out_rx.try_recv().is_err());
        live::unregister(&id, handle.generation).await;
    }

    // ── Session pump: liveness (design §4.7) and relay mirror (§4.9) ────────

    /// `run_session` on an in-memory wire, driven from the device's side.
    struct Pump {
        task: tokio::task::JoinHandle<()>,
        to_node: mpsc::Sender<Result<Message, Infallible>>,
        from_node: mpsc::Receiver<Message>,
        /// The device's transport halves; `None` on a legacy session.
        device: Option<(SendHalf, RecvHalf)>,
        device_id: String,
        store: DeviceStore,
        _dir: tempfile::TempDir,
    }

    /// Start `run_session` for a fresh level-2 row. A `secure` session first runs
    /// the RHN handshake in memory, so both ends hold real transport halves. The
    /// watch is not ambient-capable, so no meetings sidecar is involved. Returns
    /// once the `hello_ack` arrived and the session is live.
    async fn start_pump(secure: bool, relay: bool) -> Pump {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(dir.path());
        let store = state.hardware.clone();
        let device_id = unique_id("pump");
        secure_row(&store, &device_id, DEVICE_SECRET).await;
        let record = store.get(&device_id).await.unwrap().unwrap();
        let (node_halves, device) = if secure {
            let node = NodeIdentity::from_secret_bytes(OTHER_SECRET);
            let mut client =
                ClientHandshake::new(DEVICE_SECRET, node.public(), &device_id).unwrap();
            let mut server = secure::ServerHandshake::new(&node, &device_id).unwrap();
            let hs2 = server.on_hs1(&client.hs1().unwrap()).unwrap();
            let (hs3, device_send, device_recv) = client
                .on_hs2(&hs2, &hello_json(&device_id, relay), Instant::now())
                .unwrap();
            let established = server.on_hs3(&hs3, Instant::now()).unwrap();
            (
                Some((established.send, established.recv)),
                Some((device_send, device_recv)),
            )
        } else {
            (None, None)
        };
        let hello = HelloInfo {
            device_type: DeviceType::Watch,
            caps: Caps {
                display: true,
                camera: false,
                speaker: true,
                mic: false,
            },
            relay,
        };
        let Wire {
            node_tx,
            node_rx,
            to_node,
            from_node,
        } = wire();
        let task = tokio::spawn(run_session(
            node_tx,
            node_rx,
            state,
            SessionStart {
                record,
                hello,
                secure: node_halves,
            },
        ));
        let mut pump = Pump {
            task,
            to_node,
            from_node,
            device,
            device_id,
            store,
            _dir: dir,
        };
        let ack = if secure {
            pump.next_sealed().await
        } else {
            pump.next_plain().await
        };
        assert_eq!(ack["type"], "hello_ack");
        // The live registration follows the ack; wait for it without moving time.
        for _ in 0..10_000 {
            if live::is_connected(&pump.device_id).await {
                return pump;
            }
            tokio::task::yield_now().await;
        }
        panic!("the session never registered as live");
    }

    impl Pump {
        /// The next frame from the node; `None` once the node closed its side.
        async fn next_frame(&mut self) -> Option<Message> {
            self.from_node.recv().await
        }

        /// The next control message, which must arrive sealed (BINARY). REKEY
        /// records are skipped; a TEXT frame fails the test.
        async fn next_sealed(&mut self) -> serde_json::Value {
            loop {
                match self.next_frame().await {
                    Some(Message::Binary(bytes)) => {
                        let (_, recv) = self.device.as_mut().expect("a secure session");
                        if let Some(secure::Inbound::Control(text)) =
                            recv.open(&bytes, Instant::now()).unwrap()
                        {
                            return serde_json::from_str(&text).unwrap();
                        }
                    }
                    Some(Message::Text(text)) => panic!("expected a sealed frame, got TEXT {text}"),
                    Some(_) => {}
                    None => panic!("the node closed before a sealed control message"),
                }
            }
        }

        /// The next frame, which must be a cleartext TEXT control message.
        async fn next_plain(&mut self) -> serde_json::Value {
            match self.next_frame().await {
                Some(Message::Text(text)) => serde_json::from_str(&text).unwrap(),
                other => panic!("expected a TEXT frame, got {other:?}"),
            }
        }

        /// One KEEPALIVE record from the device.
        async fn keepalive(&mut self) {
            let (send, _) = self.device.as_mut().expect("a secure session");
            for frame in send.keepalive(Instant::now()).unwrap() {
                self.to_node.send(Ok(Message::Binary(frame))).await.unwrap();
            }
        }

        /// The session ends and the node closes its side without another frame.
        async fn assert_closes_silently(mut self) {
            if let Some(frame) = self.from_node.recv().await {
                panic!("the node sent {frame:?} instead of closing");
            }
            self.task.await.unwrap();
            assert!(!live::is_connected(&self.device_id).await);
        }

        /// The device goes away (its sender drops, so the node's stream ends); the
        /// session must end without another frame.
        async fn hang_up(mut self) {
            let (unused, _) = mpsc::channel(1);
            drop(std::mem::replace(&mut self.to_node, unused));
            self.assert_closes_silently().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn secure_session_idles_out_and_inbound_records_restart_the_timer() {
        let mut pump = start_pump(true, false).await;
        tokio::time::sleep(Duration::from_secs(100)).await;
        pump.keepalive().await;
        tokio::time::sleep(secure::NODE_IDLE_TIMEOUT - Duration::from_secs(1)).await;
        assert!(
            !pump.task.is_finished(),
            "an inbound record restarts the 120 s idle timer"
        );
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(
            pump.task.is_finished(),
            "120 s without an inbound record closes the session"
        );
        pump.assert_closes_silently().await;
    }

    #[tokio::test(start_paused = true)]
    async fn legacy_sessions_have_no_idle_timeout_or_max_age() {
        let pump = start_pump(false, false).await;
        tokio::time::sleep(secure::MAX_SESSION_AGE + secure::NODE_IDLE_TIMEOUT).await;
        assert!(!pump.task.is_finished(), "legacy liveness is unchanged");
        // The device going away still ends it.
        pump.hang_up().await;
    }

    #[tokio::test(start_paused = true)]
    async fn secure_session_expires_at_max_age_even_while_active() {
        let mut pump = start_pump(true, false).await;
        let started = tokio::time::Instant::now();
        // A KEEPALIVE every 100 s keeps the session from idling out...
        while started.elapsed() + Duration::from_secs(100) < secure::MAX_SESSION_AGE {
            tokio::time::sleep(Duration::from_secs(100)).await;
            pump.keepalive().await;
        }
        assert!(!pump.task.is_finished());
        // ...but at 24 h the node says why, sealed, and closes.
        let error = pump.next_sealed().await;
        assert_eq!(error["type"], "error");
        assert_eq!(error["code"], "session_expired");
        assert!(started.elapsed() >= secure::MAX_SESSION_AGE - Duration::from_secs(1));
        pump.assert_closes_silently().await;
    }

    #[tokio::test]
    async fn a_text_frame_closes_a_secure_session() {
        let pump = start_pump(true, false).await;
        pump.to_node
            .send(Ok(Message::Text(r#"{"type":"ping"}"#.into())))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), pump.assert_closes_silently())
            .await
            .expect("a TEXT frame after HS1 closes the session");
    }

    #[tokio::test]
    async fn a_data_frame_that_fails_to_open_closes_a_secure_session() {
        let pump = start_pump(true, false).await;
        let mut garbage = vec![secure::OUT_DATA];
        garbage.extend([0x5Au8; 40]);
        pump.to_node
            .send(Ok(Message::Binary(garbage)))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), pump.assert_closes_silently())
            .await
            .expect("an AEAD failure closes the session without a message");
    }

    #[test]
    fn open_failures_that_need_a_rekey_or_reconnect_tell_the_device_why() {
        let code_of = |error: SecureError| match secure_open_failure_reply(&error) {
            Some(RhpServerMsg::Error { code, .. }) => Some(code),
            Some(other) => panic!("expected an error, got {other:?}"),
            None => None,
        };
        assert_eq!(
            code_of(SecureError::RekeyOverdue).as_deref(),
            Some("rekey_overdue")
        );
        assert_eq!(
            code_of(SecureError::NonceExhausted).as_deref(),
            Some("session_expired")
        );
        for silent in [
            SecureError::Decrypt,
            SecureError::BadFrame,
            SecureError::Poisoned,
            SecureError::Protocol("x"),
            SecureError::Limit("x"),
        ] {
            assert_eq!(code_of(silent), None, "{silent:?} closes without a message");
        }
    }

    #[tokio::test]
    async fn relay_mirror_needs_a_secure_relayed_session_and_the_live_pref() {
        use ryu_hardware::protocol::Emotion;
        let emotion = |value| RhpServerMsg::Emotion { value };

        // Secure and relayed, pref unset: sealed for the device, and mirrored to
        // the phone as cleartext right after.
        let mut relayed = start_pump(true, true).await;
        assert!(live::send(&relayed.device_id, emotion(Emotion::Thinking)).await);
        let sealed = relayed.next_sealed().await;
        assert_eq!(
            sealed,
            serde_json::json!({ "type": "emotion", "value": "thinking" })
        );
        assert_eq!(relayed.next_plain().await, sealed);

        // `relay_mirror: false` applies to the live session (re-read per frame).
        relayed
            .store
            .update(
                &relayed.device_id,
                None,
                Some(serde_json::json!({ "relay_mirror": false })),
            )
            .await
            .unwrap();
        assert!(live::send(&relayed.device_id, emotion(Emotion::Listening)).await);
        assert!(live::send(&relayed.device_id, RhpServerMsg::Pong).await);
        assert_eq!(relayed.next_sealed().await["value"], "listening");
        assert_eq!(relayed.next_sealed().await["type"], "pong", "no mirror");

        // Secure but not relayed: never mirrored.
        let mut direct = start_pump(true, false).await;
        assert!(live::send(&direct.device_id, emotion(Emotion::Thinking)).await);
        assert!(live::send(&direct.device_id, RhpServerMsg::Pong).await);
        assert_eq!(direct.next_sealed().await["type"], "emotion");
        assert_eq!(direct.next_sealed().await["type"], "pong", "no mirror");

        // Legacy, even with relay set: the one plaintext frame, no second copy.
        let mut legacy = start_pump(false, true).await;
        assert!(live::send(&legacy.device_id, emotion(Emotion::Thinking)).await);
        assert!(live::send(&legacy.device_id, RhpServerMsg::Pong).await);
        assert_eq!(legacy.next_plain().await["type"], "emotion");
        assert_eq!(legacy.next_plain().await["type"], "pong", "no mirror");

        for pump in [relayed, direct, legacy] {
            pump.hang_up().await;
        }
    }
}
