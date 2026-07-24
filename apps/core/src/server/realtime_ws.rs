//! Room-keyed realtime WebSocket gateway (`GET /api/realtime/ws`).
//!
//! This is stage 2 of Phase 1 of the multi-user collaboration epic: the WS
//! transport that drives the transport-agnostic [`ryu_realtime`] registry. A
//! client upgrades, sends a `join` control frame naming a room (`conversation` or
//! `document`), and — if access is granted — is bridged onto that room's
//! broadcast: room frames are forwarded to the socket, and the client's presence
//! / (Phase 3) doc-sync frames are published back into the room.
//!
//! ## Auth placement (auth-in-handler, mirroring `hardware_ws.rs`)
//!
//! This route lives on the **public** router, not behind `require_auth`. Two
//! reasons:
//!   - Browsers cannot set custom headers on a WS upgrade, so the node token and
//!     the user JWT both ride query params (`?token=` / `?jwt=`). The node token
//!     also accepts an `Authorization: Bearer` header (non-browser clients).
//!   - The access decision is per-resource, not per-route, so it must run inside
//!     the handler after the `join` frame names the room.
//!
//! Admittance vs identity are distinct, exactly as elsewhere in Core:
//!   - **Node admittance** — `RYU_TOKEN`. If configured, the upgrade is REJECTED
//!     unless the presented token matches (mirrors [`crate::server::require_auth`]).
//!     If not configured (loopback dev), the upgrade is allowed.
//!   - **User identity** — an OPTIONAL Better Auth JWT, verified OFFLINE via the
//!     Phase 0 path ([`crate::server::verified_caller_from_token`]). Absent /
//!     invalid ⇒ anonymous, never rejected at this layer.
//!
//! ## Access decision (fail-closed, but never lock out the single user)
//!
//! After `join`, the resource's tenancy quartet is loaded
//! ([`crate::identity_verify::ResourceTenancy`]) and resolved by
//! [`decide_access`]:
//!   - DB lookup error ⇒ DENY (never grant on an error).
//!   - Legacy untenanted row (`owner_user_id` AND `org_id` both NULL) ⇒ WRITE.
//!     This is the existing single-tenant / local-first data; it must keep working.
//!   - A scoped row (owned or org-scoped) with a verified caller ⇒ run
//!     [`crate::identity_verify::can_access`] verbatim (None ⇒ DENY).
//!   - A scoped row with an ANONYMOUS caller ⇒ DENY, unconditionally. A row is
//!     scoped only because someone authenticated to create it; genuine
//!     single-user local-first data is NULL-owner+NULL-org (the legacy clause
//!     above). Anonymity on a scoped row is therefore always a credential
//!     downgrade (drop the JWT, reconnect with the shared `RYU_TOKEN`) and must
//!     fail closed.
//!   - An unknown room id (not yet persisted) ⇒ GRANT WRITE only to a genuine
//!     loopback peer (the single local user's own fresh chat); a remote caller is
//!     DENIED (it could pre-subscribe to an id another user will later create).
//!
//! The discriminator for "this is the local single user" is a genuine loopback
//! peer ([`std::net::SocketAddr::ip`] `.is_loopback()`) — NOT the node's
//! org-binding ([`crate::sidecar::control_plane::registered_org`]), which is
//! `None` for every self-hosted MULTI-user node and would therefore treat such a
//! node as single-tenant, fail-OPEN, and hand any holder of the shared
//! `RYU_TOKEN` full access to other users' scoped resources.

use std::net::SocketAddr;

use axum::{
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};

use super::ServerState;
use crate::identity_verify::{can_access, Access, ResourceTenancy, VerifiedCaller};
use ryu_collab::{classify_doc_sync, DocSyncAction, DocSyncMessage};
use ryu_realtime::Frame;

/// Bounded buffer for the per-socket send task. Frames over this lag a slow
/// client; the broadcast layer already drops + signals `Lagged`, so a full mpsc
/// simply applies backpressure to the forward task.
const SEND_BUFFER: usize = 256;

/// WS close code for a policy/authorization denial (RFC 6455 §7.4.1, 1008).
const CLOSE_POLICY: u16 = 1008;
/// WS close code for an unsupported/invalid payload (1003).
const CLOSE_UNSUPPORTED: u16 = 1003;

/// How long a collaborative document must go without an applied CRDT update before
/// it is considered "quiescent" and its materialized projection is written back
/// through the spaces embed path (so RAG re-embeds ONCE per edit burst, not per
/// keystroke). Each applied update resets the timer.
const QUIESCE_DURATION: std::time::Duration = std::time::Duration::from_secs(3);

/// Query params on the upgrade URL. Both optional: `token` is the node-admittance
/// `RYU_TOKEN` (also accepted via `Authorization: Bearer`), `jwt` is the optional
/// user identity JWT (browsers cannot set custom headers on a WS upgrade).
#[derive(Debug, Default, Deserialize)]
pub struct RealtimeQuery {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    jwt: Option<String>,
}

/// The kind of resource a room maps to. Decides which store resolves the room's
/// tenancy.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RoomKind {
    Conversation,
    Document,
}

/// The first control frame: names the room to join and its kind.
#[derive(Debug, Deserialize)]
struct JoinFrame {
    room_id: String,
    kind: RoomKind,
}

/// `GET /api/realtime/ws` — upgrade to the room gateway. Node admittance + the
/// optional user identity are resolved here (pre-upgrade); the room access
/// decision happens inside the socket task after the `join` frame.
#[utoipa::path(
    get,
    path = "/api/realtime/ws",
    tag = "Core",
    summary = "upgrade to the room gateway. Node admittance + the",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn realtime_ws(
    ws: WebSocketUpgrade,
    State(state): State<ServerState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<RealtimeQuery>,
) -> Response {
    // ── Node admittance (mirror `require_auth`) ──────────────────────────────
    // Treat an empty/whitespace configured token as "not configured" (loopback
    // dev) — exactly like `require_auth`, which only enforces a non-empty token.
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

    // ── Optional user identity (Phase 0 verify path, reused) ─────────────────
    // Source order: `?jwt=` query (browser-friendly), then the REST header for
    // non-browser clients. Any failure resolves to anonymous (None), never an
    // error — `RYU_TOKEN` is the gate.
    let jwt = query
        .jwt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| super::header_str(&headers, "x-ryu-user-jwt"));
    let caller = match jwt {
        Some(token) => super::verified_caller_from_token(&token).await,
        None => None,
    };

    // Whether the upgrade came from a genuine loopback peer. This gates the
    // single-user local-allow for unpersisted (unknown) rooms — NOT the node's
    // org-binding, which is `None` for self-hosted multi-user nodes and so cannot
    // distinguish "the local single user" from "any holder of the shared
    // RYU_TOKEN". See `decide_access`.
    let peer_is_loopback = peer.ip().is_loopback();

    ws.on_upgrade(move |socket| handle_socket(socket, state, caller, peer_is_loopback))
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

/// The outcome of the per-room access decision.
enum AccessOutcome {
    /// Join is permitted at this access level (`Read` or `Write`).
    Grant(Access),
    /// Join is refused; the static reason is sent in the close frame.
    Deny(&'static str),
}

/// Resolve a caller's access to a room from its tenancy quartet. See the module
/// docs for the full matrix. Fail-closed on lookup error; never lock out the
/// single user on a genuine loopback peer, but never fail-open for a *scoped*
/// resource.
///
/// `peer_is_loopback` is the only "this is the local single user" signal we
/// trust. It deliberately does NOT use the node's org-binding
/// ([`crate::sidecar::control_plane::registered_org`]): that is `None` for every
/// self-hosted multi-user node, so an org-binding discriminator would treat such
/// a node as single-tenant and grant any holder of the shared `RYU_TOKEN` full
/// access to other users' scoped resources — the exact credential-downgrade
/// bypass this function must refuse.
///
/// Caveat: behind a reverse proxy the peer is the proxy (often `127.0.0.1`), so
/// the unknown-room loopback grant widens to all proxied clients. That window is
/// narrow (only unpersisted rooms; scoped rows are never affected) and is the
/// inherent cost of loopback-based local detection — documented, not gated here.
fn decide_access(
    meta: anyhow::Result<Option<ResourceTenancy>>,
    caller: Option<&VerifiedCaller>,
    peer_is_loopback: bool,
) -> AccessOutcome {
    let meta = match meta {
        Ok(meta) => meta,
        Err(e) => {
            tracing::warn!("realtime: resource access lookup failed: {e:#}");
            return AccessOutcome::Deny("resource-lookup-failed");
        }
    };

    let Some(tenancy) = meta else {
        // Unknown room id (e.g. a conversation not yet persisted). Grant ONLY to a
        // genuine loopback peer — the single local user's own fresh chat. A remote
        // caller (even an authenticated one) is refused: pre-subscribing it to an
        // id someone else may later create would leak that creator's first
        // messages into this room. Remote clients must persist-then-join (a
        // Phase-2 client concern).
        return if peer_is_loopback {
            AccessOutcome::Grant(Access::Write)
        } else {
            AccessOutcome::Deny("unknown-resource")
        };
    };

    // Legacy single-tenant row: untenanted data predates the multi-user columns
    // and must keep working with full access. This is the genuine local-first
    // path (no JWT ⇒ NULL `author_user_id` ⇒ NULL owner).
    if tenancy.owner_user_id.is_none() && tenancy.org_id.is_none() {
        return AccessOutcome::Grant(Access::Write);
    }

    // Scoped (owned or org-scoped) resource. A row is scoped ONLY because someone
    // authenticated to create it, so:
    //   - a verified caller is enforced verbatim by `can_access`;
    //   - an anonymous caller is ALWAYS denied. There is no legitimate
    //     single-user local-first path here (that is NULL-owner+NULL-org, handled
    //     above); anonymity on a scoped row is a credential downgrade — Bob drops
    //     his JWT and reconnects to read Alice's private room — and must fail
    //     closed regardless of node binding or loopback.
    match caller {
        Some(caller) => {
            let access = can_access(
                caller,
                tenancy.owner_user_id.as_deref(),
                tenancy.org_id.as_deref(),
                &tenancy.visibility,
                tenancy.team_id.as_deref(),
            );
            match access {
                Access::None => AccessOutcome::Deny("forbidden"),
                granted => AccessOutcome::Grant(granted),
            }
        }
        None => AccessOutcome::Deny("anonymous-on-scoped-resource"),
    }
}

/// Per-connection driver: read the `join` frame, enforce access, then bridge the
/// room broadcast to the socket and the socket's frames into the room.
async fn handle_socket(
    socket: WebSocket,
    state: ServerState,
    caller: Option<VerifiedCaller>,
    peer_is_loopback: bool,
) {
    use futures_util::{SinkExt, StreamExt};

    let (mut ws_tx, mut ws_rx) = socket.split();

    // ── Handshake: the first frame must be `join` ────────────────────────────
    let join = loop {
        match ws_rx.next().await {
            Some(Ok(Message::Text(text))) => match serde_json::from_str::<Value>(&text) {
                Ok(value) if value.get("type").and_then(Value::as_str) == Some("join") => {
                    match serde_json::from_value::<JoinFrame>(value) {
                        Ok(frame) => break frame,
                        Err(e) => {
                            let _ = ws_tx
                                .send(close(CLOSE_UNSUPPORTED, format!("malformed join: {e}")))
                                .await;
                            return;
                        }
                    }
                }
                Ok(_) => {
                    let _ = ws_tx
                        .send(close(
                            CLOSE_UNSUPPORTED,
                            "first frame must be `join`".into(),
                        ))
                        .await;
                    return;
                }
                Err(e) => {
                    let _ = ws_tx
                        .send(close(CLOSE_UNSUPPORTED, format!("bad json: {e}")))
                        .await;
                    return;
                }
            },
            // Ignore pings / binary before join.
            Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Binary(_))) => continue,
            Some(Ok(Message::Close(_))) | None => return,
            Some(Err(_)) => return,
        }
    };

    let room_id = join.room_id;
    if room_id.trim().is_empty() {
        let _ = ws_tx
            .send(close(CLOSE_UNSUPPORTED, "join.room_id is empty".into()))
            .await;
        return;
    }
    // Only `document` rooms drive the authoritative CRDT engine; a `conversation`
    // room keeps the pure event/presence relay (a stray binary frame on it must NOT
    // mint a spurious Y.Doc keyed by a conversation id). `RoomKind` is `Copy`.
    let is_document = matches!(join.kind, RoomKind::Document);

    // ── Access decision ──────────────────────────────────────────────────────
    let meta = match join.kind {
        RoomKind::Conversation => state.conversations.get_access_meta(&room_id).await,
        RoomKind::Document => super::spaces::doc_access_meta(&state.spaces, &room_id).await,
    };
    let access = match decide_access(meta, caller.as_ref(), peer_is_loopback) {
        AccessOutcome::Grant(access) => access,
        AccessOutcome::Deny(reason) => {
            // A denial on a scoped resource is an access-control signal (e.g. a
            // credential-downgrade attempt), not routine — log at warn.
            tracing::warn!(room_id, reason, "realtime: join denied");
            let _ = ws_tx.send(close(CLOSE_POLICY, reason.into())).await;
            return;
        }
    };
    let can_write = matches!(access, Access::Write);

    // Single-writer seed arbitration (document rooms only). The client seeds a
    // brand-new empty room from its local `source`; two clients opening the same
    // empty room concurrently would BOTH seed and corrupt the doc (duplicated body /
    // duplicated `col_name` columns). So the server decides exactly one seeder: this
    // caller may seed only if it can write, the doc is still empty, AND it wins the
    // atomic one-shot claim. `&&` short-circuits so a non-writer / non-empty doc
    // never consumes the claim, and only the first racer's `claim_seed` returns true.
    let may_seed = is_document
        && can_write
        && state.collab.is_empty(&room_id).unwrap_or(false)
        && state.collab.claim_seed(&room_id).unwrap_or(false);

    // ── Join the room ────────────────────────────────────────────────────────
    // A unique per-connection member id so presence reaping is per-socket (two
    // tabs of the same user each get their own awareness entry + leave).
    let member_id = format!("mem_{}", uuid::Uuid::new_v4().simple());
    // Race-safe join: get-or-create + member increment happen under the registry
    // lock, so a concurrent idle eviction can never orphan this membership.
    let membership = state.realtime.join(&room_id, member_id.clone());
    let mut room_rx = membership.subscribe();

    // Ack the join with the resolved access level — stage-2's client reads this to
    // know whether it may edit (write) or is a read-only viewer.
    let ack = json!({
        "type": "join_ack",
        "room_id": room_id,
        "member_id": member_id,
        "access": if can_write { "write" } else { "read" },
        // The client seeds an empty room ONLY when the server says it won the seed
        // claim — see `may_seed` above. This is the race-proof half of the
        // double-seed fix; the client side is the gate, this is the arbiter.
        "may_seed": may_seed,
    });
    if ws_tx.send(Message::Text(ack.to_string())).await.is_err() {
        return;
    }

    // ── Send task: drains an mpsc of ready-to-wire messages to the socket ─────
    let (out_tx, mut out_rx) = mpsc::channel::<Message>(SEND_BUFFER);
    let send_task = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if ws_tx.send(msg).await.is_err() {
                break;
            }
        }
    });

    // ── Forward task: room broadcast -> this client ──────────────────────────
    let forward_tx = out_tx.clone();
    let forward_task = tokio::spawn(async move {
        loop {
            match room_rx.recv().await {
                Ok(frame) => {
                    if forward_tx.send(frame_to_message(frame)).await.is_err() {
                        break;
                    }
                }
                // A slow consumer overflowed the bounded broadcast: skip the gap
                // and keep going (resync is a client concern).
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // ── Document rooms: drive the authoritative CRDT engine ──────────────────
    // Rehydrate the doc (this resolves/creates the in-memory `yrs` replica) and
    // send the server's `SyncStep1` (its state vector) so the client replies with
    // its diff. Also spawn the per-quiescence materialize debounce; each applied
    // update pokes it, and after `QUIESCE_DURATION` of silence it writes the
    // materialized projection back through the spaces embed path.
    let quiesce_tx = if is_document {
        match state.collab.state_vector(&room_id) {
            Ok(sv) => {
                let frame = DocSyncMessage::SyncStep1(sv).encode();
                // A send error here means the socket is already gone; the receive
                // loop's next read will return None and fall through to teardown.
                let _ = out_tx.send(Message::Binary(frame)).await;
            }
            Err(e) => tracing::warn!(room_id, "collab: rehydrate on join failed: {e:#}"),
        }

        let (q_tx, mut q_rx) = mpsc::channel::<()>(8);
        let collab = state.collab.clone();
        let spaces = state.spaces.clone();
        let q_doc = room_id.clone();
        tokio::spawn(async move {
            // Outer: wait for the first edit since the last materialize.
            while q_rx.recv().await.is_some() {
                // Inner debounce: reset the timer on every further edit; fire once
                // the burst settles. A closed channel (last socket gone) ends the
                // task — the last-leave path below does the final materialize.
                loop {
                    tokio::select! {
                        _ = tokio::time::sleep(QUIESCE_DURATION) => break,
                        again = q_rx.recv() => {
                            if again.is_none() {
                                return;
                            }
                        }
                    }
                }
                materialize_to_spaces(&collab, &spaces, &q_doc).await;
            }
        });
        Some(q_tx)
    } else {
        None
    };

    // ── Receive loop: client frames -> room ──────────────────────────────────
    while let Some(frame) = ws_rx.next().await {
        let frame = match frame {
            Ok(f) => f,
            Err(_) => break,
        };
        match frame {
            Message::Text(text) => {
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                match value.get("type").and_then(Value::as_str) {
                    Some("presence") => {
                        // Publish the client's awareness payload, stamping the
                        // member id so peers can attribute it. Presence is relayed
                        // for read-only viewers too (it is the viewer's own
                        // awareness, not a mutation of the resource).
                        let mut payload = value.get("data").cloned().unwrap_or_else(|| json!({}));
                        if let Some(obj) = payload.as_object_mut() {
                            obj.insert("member_id".into(), json!(member_id));
                        }
                        membership.publish_presence(payload);
                    }
                    Some("ping") => {
                        if out_tx
                            .send(Message::Text(json!({"type": "pong"}).to_string()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Some("leave") => break,
                    // Unknown control frames are ignored (forward-compatible).
                    _ => {}
                }
            }
            Message::Binary(bytes) => {
                // DocSync (Phase 3 authoritative CRDT). Conversation rooms have no
                // doc — ignore their binary frames (forward-compatible).
                if !is_document {
                    continue;
                }
                // Classify against the per-connection write-ACL. The drop for a
                // read-only mutation is FAIL-CLOSED and happens BEFORE any apply.
                match classify_doc_sync(&bytes, can_write) {
                    DocSyncAction::Apply(update) => {
                        // Authoritative: apply to Core's replica + persist to the
                        // append log, then rebroadcast the canonical bytes to the
                        // room (echo to sender is harmless — Yjs apply is idempotent).
                        match state.collab.apply_remote_update(&room_id, &update) {
                            Ok(rebroadcast) => {
                                membership
                                    .handle()
                                    .publish_doc_sync(DocSyncMessage::Update(rebroadcast).encode());
                                // Edits happened — poke the quiescence debounce.
                                if let Some(q) = &quiesce_tx {
                                    let _ = q.try_send(());
                                }
                            }
                            Err(e) => tracing::warn!(room_id, "collab: apply failed: {e:#}"),
                        }
                    }
                    DocSyncAction::ReplyDiff(client_sv) => {
                        // A client `SyncStep1`: unicast a `SyncStep2` diff for its
                        // state vector back to THIS socket (a read — ungated, so a
                        // read-only viewer syncs the doc down this way).
                        match state.collab.diff_since(&room_id, &client_sv) {
                            Ok(diff) => {
                                let frame = DocSyncMessage::SyncStep2(diff).encode();
                                if out_tx.send(Message::Binary(frame)).await.is_err() {
                                    break;
                                }
                            }
                            Err(e) => tracing::warn!(room_id, "collab: diff failed: {e:#}"),
                        }
                    }
                    DocSyncAction::Relay(awareness) => {
                        // Awareness (cursors/selections) is the member's own ephemeral
                        // presence, NOT a doc mutation: relay it to the room's other
                        // members as-is. It is NEVER applied to the authoritative doc
                        // and NEVER persisted, and it does not poke the quiescence
                        // debounce (no edit happened). Relayed for read-only viewers
                        // too — a viewer's cursor is its own state, not a mutation.
                        membership
                            .handle()
                            .publish_doc_sync(DocSyncMessage::Awareness(awareness).encode());
                    }
                    // Read-only mutation attempt or unparseable frame: dropped.
                    DocSyncAction::Drop => {}
                }
            }
            Message::Ping(_) | Message::Pong(_) => {}
            Message::Close(_) => break,
        }
    }

    // ── Teardown ─────────────────────────────────────────────────────────────
    // Dropping the membership decrements the room's member count, evicts this
    // member's presence, and broadcasts a `presence_leave` delta — the reap-on-
    // disconnect the registry guarantees, no manual leave frame required.
    // Capture the handle BEFORE the drop so we can read the post-decrement count.
    let room_handle = membership.handle().clone();
    drop(membership);

    // Last-leave hibernation for a document room: write a final materialized
    // projection (dormant until `source` decode lands) and flush a snapshot, then
    // drop the in-memory `yrs` replica. The next join rehydrates from persistence,
    // so a join racing this drop loses nothing (persistence is the source of truth).
    if is_document && room_handle.member_count() == 0 {
        materialize_to_spaces(&state.collab, &state.spaces, &room_id).await;
        // If the doc is STILL empty on last-leave, the seed never happened (the
        // claim winner left before its seed update landed). Release the claim BEFORE
        // dropping the replica so a future session can re-claim and seed — otherwise
        // a crashed-before-seed claim would lock the room out of seeding forever.
        if state.collab.is_empty(&room_id).unwrap_or(false) {
            if let Err(e) = state.collab.release_seed_claim(&room_id) {
                tracing::warn!(
                    room_id,
                    "collab: release seed claim on last-leave failed: {e:#}"
                );
            }
        }
        if let Err(e) = state.collab.flush_and_drop(&room_id) {
            tracing::warn!(
                room_id,
                "collab: flush_and_drop on last-leave failed: {e:#}"
            );
        }
    }

    // Dropping `quiesce_tx` closes the debounce channel, ending that task.
    drop(quiesce_tx);
    drop(out_tx);
    forward_task.abort();
    let _ = send_task.await;
}

/// Write a document's materialized CRDT projection back through the spaces embed
/// path so RAG re-embeds ONCE per quiescence (not per keystroke).
///
/// WIRED but DORMANT: [`ryu_collab::DocRegistry::materialize`] persists the
/// opaque snapshot + state vector but returns `source: None` until the
/// client-provider batch pins the canonical `Y.Doc -> source` decode (faking it
/// would feed wrong data into RAG). When `source` becomes `Some`, this fetches the
/// current title and routes the projection through the existing
/// [`super::spaces::SpaceStore::update_document`] embed-on-save path.
async fn materialize_to_spaces(
    collab: &ryu_collab::DocRegistry,
    spaces: &super::spaces::SpaceStore,
    doc_id: &str,
) {
    let mat = match collab.materialize(doc_id) {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!(doc_id, "collab: materialize failed: {e:#}");
            return;
        }
    };
    let Some(source) = mat.source else {
        return;
    };
    let title = match spaces.get_document(doc_id).await {
        Ok(Some(doc)) => doc.title,
        Ok(None) => return,
        Err(e) => {
            tracing::warn!(
                doc_id,
                "collab: title lookup for quiescence write-back failed: {e:#}"
            );
            return;
        }
    };
    if let Err(e) = spaces.update_document(doc_id, &title, &source).await {
        tracing::warn!(doc_id, "collab: quiescence embed write-back failed: {e:#}");
    }
}

/// Render a room [`Frame`] as a wire message. `Event`/`Presence` are JSON text
/// tagged with their channel so the client can route them; `DocSync` is opaque
/// binary passed through untouched.
///
/// This is the first real consumer of the typed named-event contract. A caller that
/// used [`ryu_realtime::RoomHandle::broadcast_event`] (e.g. the `conversation.message`
/// fan-out) publishes a self-describing `{__ryu_event, data}` envelope on the Events
/// channel; [`ryu_realtime::Event::decode`] recognises it and we forward only the
/// inner `data`, so the wire stays byte-identical to the legacy raw `publish_event`
/// shape (`{"channel":"events","data":<payload>}`). A non-envelope `Frame::Event`
/// (any surviving raw `publish_event`) decodes to `None` and passes through
/// unchanged. Presence/DocSync are never typed events and are untouched.
fn frame_to_message(frame: Frame) -> Message {
    if let Some(event) = ryu_realtime::Event::decode(&frame) {
        return Message::Text(json!({"channel": "events", "data": event.payload}).to_string());
    }
    match frame {
        Frame::Event(value) => {
            Message::Text(json!({"channel": "events", "data": value}).to_string())
        }
        Frame::Presence(value) => {
            Message::Text(json!({"channel": "presence", "data": value}).to_string())
        }
        Frame::DocSync(bytes) => Message::Binary(bytes),
    }
}

/// Build a WS close frame with a code + reason.
fn close(code: u16, reason: String) -> Message {
    Message::Close(Some(CloseFrame {
        code,
        reason: reason.into(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity_verify::OrgRole;

    fn scoped(owner: Option<&str>, org: Option<&str>, visibility: &str) -> ResourceTenancy {
        ResourceTenancy {
            owner_user_id: owner.map(str::to_owned),
            org_id: org.map(str::to_owned),
            visibility: visibility.to_owned(),
            team_id: None,
        }
    }

    fn caller(user_id: &str, org: Option<&str>, role: OrgRole) -> VerifiedCaller {
        VerifiedCaller {
            user_id: user_id.to_owned(),
            email: None,
            org_id: org.map(str::to_owned),
            role,
        }
    }

    fn is_grant(outcome: &AccessOutcome, expect: Access) -> bool {
        matches!(outcome, AccessOutcome::Grant(a) if *a == expect)
    }

    fn deny_reason(outcome: &AccessOutcome) -> Option<&'static str> {
        match outcome {
            AccessOutcome::Deny(r) => Some(r),
            AccessOutcome::Grant(_) => None,
        }
    }

    /// The exploit from the adversarial review: an anonymous caller (Bob dropped
    /// his JWT and reconnected with the shared node token) on a scoped row MUST be
    /// denied, regardless of node binding or peer. This is the blocker fix.
    #[test]
    fn anonymous_on_scoped_resource_is_denied() {
        let meta = Ok(Some(scoped(Some("alice"), None, "private")));
        // Even on a loopback peer (the most permissive case) — still denied.
        let outcome = decide_access(meta, None, true);
        assert_eq!(deny_reason(&outcome), Some("anonymous-on-scoped-resource"));
    }

    /// The "drop the JWT, reconnect anonymously" variant collapses to the case
    /// above; an org-scoped (not owner-scoped) row must deny anonymous too.
    #[test]
    fn anonymous_on_org_scoped_resource_is_denied() {
        let meta = Ok(Some(scoped(None, Some("org_acme"), "private")));
        let outcome = decide_access(meta, None, false);
        assert_eq!(deny_reason(&outcome), Some("anonymous-on-scoped-resource"));
    }

    /// An authenticated caller whom `can_access` denies (no membership, private
    /// row of another user) is denied — equivalently to the anonymous path.
    #[test]
    fn authenticated_outsider_on_scoped_resource_is_denied() {
        let meta = Ok(Some(scoped(Some("alice"), None, "private")));
        let bob = caller("bob", None, OrgRole::Member);
        let outcome = decide_access(meta, Some(&bob), true);
        assert_eq!(deny_reason(&outcome), Some("forbidden"));
    }

    /// Legacy single-tenant data (NULL owner + NULL org) keeps full access — the
    /// genuine local-first path that must never be locked out.
    #[test]
    fn legacy_untenanted_row_grants_write() {
        // True for any caller/peer combination (fresh `meta` per call — an
        // `anyhow::Result` is not `Clone`).
        assert!(is_grant(
            &decide_access(Ok(Some(scoped(None, None, "private"))), None, false),
            Access::Write
        ));
        assert!(is_grant(
            &decide_access(Ok(Some(scoped(None, None, "private"))), None, true),
            Access::Write
        ));
    }

    /// The resource owner gets write on their own scoped row.
    #[test]
    fn owner_on_scoped_resource_is_granted() {
        let meta = Ok(Some(scoped(Some("alice"), None, "private")));
        let alice = caller("alice", None, OrgRole::Member);
        let outcome = decide_access(meta, Some(&alice), false);
        assert!(is_grant(&outcome, Access::Write));
    }

    /// Unknown (unpersisted) room: granted on a loopback peer (the local single
    /// user's fresh chat).
    #[test]
    fn unknown_room_on_loopback_grants_write() {
        let outcome = decide_access(Ok(None), None, true);
        assert!(is_grant(&outcome, Access::Write));
    }

    /// Unknown room from a remote peer is denied — it could pre-subscribe to an id
    /// another user will later create.
    #[test]
    fn unknown_room_from_remote_is_denied() {
        // Denied even for an authenticated remote caller — ownership of a
        // not-yet-existing row cannot be verified.
        let bob = caller("bob", None, OrgRole::Member);
        assert_eq!(
            deny_reason(&decide_access(Ok(None), None, false)),
            Some("unknown-resource")
        );
        assert_eq!(
            deny_reason(&decide_access(Ok(None), Some(&bob), false)),
            Some("unknown-resource")
        );
    }

    /// A DB lookup error always denies — never grant on an error.
    #[test]
    fn lookup_error_is_denied() {
        let outcome = decide_access(Err(anyhow::anyhow!("db down")), None, true);
        assert_eq!(deny_reason(&outcome), Some("resource-lookup-failed"));
    }

    /// The typed named-event contract is transparent on the wire: a
    /// `broadcast_event` envelope (`{__ryu_event, data}` on the Events channel) must
    /// forward the exact same bytes as the legacy raw `publish_event` of the inner
    /// value — otherwise converting the `conversation.message` fan-out to the typed
    /// contract would silently break every existing realtime client. This is the
    /// empirical proof of the finish-the-slice back-compat claim.
    #[test]
    fn typed_event_frame_is_wire_identical_to_legacy_publish() {
        // The exact payload the conversations fan-out publishes.
        let payload = json!({
            "type": "message",
            "conversation_id": "c1",
            "message": { "id": "m1", "role": "assistant", "content": "hi" },
        });

        // Legacy: raw `publish_event(payload)` -> `Frame::Event(payload)`.
        let legacy = frame_to_message(Frame::Event(payload.clone()));

        // Typed: `broadcast_event("conversation.message", payload)` rides
        // `Frame::Event` as a `{__ryu_event, data}` envelope. Reproduce that envelope
        // exactly (the `__ryu_event`/`data` keys are the documented wire contract).
        let enveloped = Frame::Event(json!({
            "__ryu_event": "conversation.message",
            "data": payload,
        }));
        let typed = frame_to_message(enveloped);

        match (legacy, typed) {
            (Message::Text(a), Message::Text(b)) => assert_eq!(
                a, b,
                "typed broadcast_event must forward byte-identically to legacy publish_event"
            ),
            _ => panic!("expected text frames on the Events channel"),
        }
    }

    /// A non-envelope `Frame::Event` (a surviving raw `publish_event`) still passes
    /// through unchanged — the typed decode falls through to `None`.
    #[test]
    fn raw_event_frame_passes_through_unchanged() {
        let value = json!({"legacy": true, "id": 7});
        match frame_to_message(Frame::Event(value.clone())) {
            Message::Text(text) => {
                assert_eq!(
                    text,
                    json!({"channel": "events", "data": value}).to_string()
                );
            }
            _ => panic!("expected a text frame"),
        }
    }

    /// A presence frame is tagged onto the `presence` channel (distinct from
    /// `events`) so the client routes awareness updates separately.
    #[test]
    fn presence_frame_is_tagged_presence_channel() {
        let value = json!({"member": "mem_1", "cursor": 3});
        match frame_to_message(Frame::Presence(value.clone())) {
            Message::Text(text) => assert_eq!(
                text,
                json!({"channel": "presence", "data": value}).to_string()
            ),
            _ => panic!("expected a text frame"),
        }
    }

    /// A CRDT `DocSync` frame is opaque binary, passed through byte-for-byte — the
    /// server must never re-encode a Y.Doc update.
    #[test]
    fn docsync_frame_is_opaque_binary() {
        let bytes = vec![0u8, 1, 2, 255, 128];
        match frame_to_message(Frame::DocSync(bytes.clone())) {
            Message::Binary(out) => assert_eq!(out, bytes),
            _ => panic!("expected a binary frame"),
        }
    }

    /// `close` builds a WS Close with the given policy code + reason — the shape the
    /// handshake sends on every rejection (`malformed join`, `forbidden`, …).
    #[test]
    fn close_carries_code_and_reason() {
        match close(CLOSE_POLICY, "anonymous-on-scoped-resource".to_owned()) {
            Message::Close(Some(frame)) => {
                assert_eq!(frame.code, CLOSE_POLICY);
                assert_eq!(frame.reason.as_ref(), "anonymous-on-scoped-resource");
            }
            _ => panic!("expected a Close frame with a body"),
        }
    }

    /// `bearer_token` extracts a well-formed `Bearer <t>` from the upgrade headers and
    /// rejects a wrong scheme / empty token — the node-admittance fallback path.
    #[test]
    fn bearer_token_parses_authorization_header() {
        use axum::http::HeaderValue;
        let mut h = HeaderMap::new();
        h.insert("authorization", HeaderValue::from_static("Bearer node-tok"));
        assert_eq!(bearer_token(&h).as_deref(), Some("node-tok"));

        let mut bad = HeaderMap::new();
        bad.insert("authorization", HeaderValue::from_static("Bearer   "));
        assert_eq!(bearer_token(&bad), None);
        assert_eq!(bearer_token(&HeaderMap::new()), None);
    }

    /// The `join` frame deserializes the room id + kind (lowercase-tagged), so a
    /// `conversation` vs `document` room routes to the right access-meta store.
    #[test]
    fn join_frame_deserializes_kind() {
        let conv: JoinFrame =
            serde_json::from_value(json!({"room_id": "c1", "kind": "conversation"})).unwrap();
        assert_eq!(conv.room_id, "c1");
        assert!(matches!(conv.kind, RoomKind::Conversation));

        let doc: JoinFrame =
            serde_json::from_value(json!({"room_id": "d1", "kind": "document"})).unwrap();
        assert!(matches!(doc.kind, RoomKind::Document));

        // An unknown kind is rejected (fail-closed on the handshake).
        assert!(serde_json::from_value::<JoinFrame>(json!({"room_id": "x", "kind": "bogus"})).is_err());
    }
}
