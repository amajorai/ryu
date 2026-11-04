//! Live re-authorization for realtime room sockets.
//!
//! The join frame decides a socket's access once, but the resource's ACL can
//! change while the socket stays open (a collaborator is removed, visibility is
//! narrowed, the resource is deleted). HTTP routes re-check on every request;
//! these helpers give live sockets the same guarantee:
//!
//! - every ACL mutation bumps a process-wide access epoch
//!   ([`notify_access_changed`]);
//! - before forwarding a room frame or applying a document update, a socket whose
//!   last decision predates the current epoch re-runs the join-time decision;
//! - a periodic re-check also catches indirect changes with no hook (org or team
//!   membership).
//!
//! A re-check that now denies cancels the socket's `revoked` token, which stops
//! the forward task before it relays the frame and makes the receive loop close
//! the socket with 1008. A downgrade from write to read takes effect for the
//! next document update.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::Message;
use ryu_realtime::Frame;
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;

use super::{close, decide_access, frame_to_message, AccessOutcome, RoomKind, CLOSE_POLICY};
use crate::identity_verify::{Access, VerifiedCaller};
use crate::server::ServerState;
use crate::sidecar::BoxFuture;

/// Fallback cadence for re-checking a live socket's access when no ACL hook
/// fired (for example an org or team membership change).
const ACCESS_RECHECK_INTERVAL: Duration = Duration::from_secs(30);

/// Close reason sent when a live socket's access is revoked.
pub(super) const ACCESS_REVOKED_REASON: &str = "access-revoked";

static ACCESS_EPOCH: AtomicU64 = AtomicU64::new(0);

/// Record that some realtime resource's ACL changed. Call it after the change
/// is persisted; every live socket re-authorizes before its next frame.
pub(crate) fn notify_access_changed() {
    ACCESS_EPOCH.fetch_add(1, Ordering::SeqCst);
}

/// The current access epoch. Read it before a decision so a change that races
/// the decision forces a re-check.
pub(super) fn access_epoch() -> u64 {
    ACCESS_EPOCH.load(Ordering::SeqCst)
}

/// Re-runs a socket's access decision against the current ACL.
pub(super) type AccessLookup = Arc<dyn Fn() -> BoxFuture<AccessOutcome> + Send + Sync>;

/// The join-time access decision for a room, shared by join and re-checks.
pub(super) async fn decide_room_access(
    state: &ServerState,
    kind: RoomKind,
    room_id: &str,
    caller: Option<&VerifiedCaller>,
    peer_is_loopback: bool,
) -> AccessOutcome {
    match kind {
        // `app:realtime` proves that the app may use the transport, not that it
        // owns the model-selected room id. Until the app host supplies a
        // Core-issued per-resource binding, fail closed instead of allowing one
        // granted app to join another app's room namespace.
        RoomKind::Application => AccessOutcome::Deny("application-resource-binding-required"),
        RoomKind::Conversation => decide_access(
            state.conversations.get_access_meta(room_id).await,
            caller,
            peer_is_loopback,
        ),
        RoomKind::Document => decide_access(
            super::super::spaces::doc_access_meta(&state.spaces, room_id).await,
            caller,
            peer_is_loopback,
        ),
    }
}

/// A lookup that re-runs [`decide_room_access`] for one socket's caller.
pub(super) fn room_access_lookup(
    state: ServerState,
    kind: RoomKind,
    room_id: String,
    caller: Option<VerifiedCaller>,
    peer_is_loopback: bool,
) -> AccessLookup {
    Arc::new(move || {
        let state = state.clone();
        let room_id = room_id.clone();
        let caller = caller.clone();
        Box::pin(async move {
            decide_room_access(&state, kind, &room_id, caller.as_ref(), peer_is_loopback).await
        })
    })
}

/// One socket's current access level, kept in step with the resource's ACL.
#[derive(Clone)]
pub(super) struct AccessGuard(Arc<GuardInner>);

struct GuardInner {
    lookup: AccessLookup,
    can_write: AtomicBool,
    checked_epoch: AtomicU64,
    recheck: tokio::sync::Mutex<()>,
    revoked: CancellationToken,
}

impl AccessGuard {
    /// `epoch` must be the [`access_epoch`] read before `granted` was decided.
    pub(super) fn new(lookup: AccessLookup, granted: Access, epoch: u64) -> Self {
        Self(Arc::new(GuardInner {
            lookup,
            can_write: AtomicBool::new(matches!(granted, Access::Write)),
            checked_epoch: AtomicU64::new(epoch),
            recheck: tokio::sync::Mutex::new(()),
            revoked: CancellationToken::new(),
        }))
    }

    pub(super) fn can_write(&self) -> bool {
        self.0.can_write.load(Ordering::SeqCst) && !self.0.revoked.is_cancelled()
    }

    /// Cancelled once a re-check denies access.
    pub(super) fn revoked(&self) -> CancellationToken {
        self.0.revoked.clone()
    }

    /// Re-authorize when an ACL changed since the last decision. Returns `false`
    /// once access is revoked.
    pub(super) async fn ensure_current(&self) -> bool {
        if self.0.revoked.is_cancelled() {
            return false;
        }
        if self.0.checked_epoch.load(Ordering::SeqCst) == access_epoch() {
            return true;
        }
        self.refresh(false).await
    }

    /// Re-run the access decision (always when `force`, otherwise only when the
    /// epoch moved). Returns `false` once access is revoked.
    pub(super) async fn refresh(&self, force: bool) -> bool {
        let _serialized = self.0.recheck.lock().await;
        if self.0.revoked.is_cancelled() {
            return false;
        }
        let epoch = access_epoch();
        if !force && self.0.checked_epoch.load(Ordering::SeqCst) == epoch {
            return true;
        }
        match (self.0.lookup)().await {
            AccessOutcome::Grant(access) => {
                self.0
                    .can_write
                    .store(matches!(access, Access::Write), Ordering::SeqCst);
                self.0.checked_epoch.store(epoch, Ordering::SeqCst);
                true
            }
            AccessOutcome::Deny(reason) => {
                tracing::warn!(reason, "realtime: live socket access revoked");
                self.0.can_write.store(false, Ordering::SeqCst);
                self.0.revoked.cancel();
                false
            }
        }
    }
}

/// The close frame a revoked socket receives.
pub(super) fn revoked_close() -> Message {
    close(CLOSE_POLICY, ACCESS_REVOKED_REASON.into())
}

/// Relay room frames to the socket's send queue, re-authorizing before each
/// frame after an ACL change and on a fixed cadence. Stops (without relaying
/// the pending frame) once access is revoked.
pub(super) fn spawn_forward_task(
    mut room_rx: broadcast::Receiver<Frame>,
    forward_tx: mpsc::Sender<Message>,
    application_room: bool,
    guard: AccessGuard,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut recheck = tokio::time::interval(ACCESS_RECHECK_INTERVAL);
        recheck.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        recheck.tick().await;
        loop {
            let received = tokio::select! {
                _ = recheck.tick() => {
                    if !guard.refresh(true).await {
                        break;
                    }
                    continue;
                }
                received = room_rx.recv() => received,
            };
            let frame = match received {
                Ok(frame) => frame,
                Err(broadcast::error::RecvError::Lagged(dropped)) => {
                    Frame::ResyncRequired { dropped }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            };
            if !guard.ensure_current().await {
                break;
            }
            if forward_tx
                .send(frame_to_message(frame, application_room))
                .await
                .is_err()
            {
                break;
            }
        }
    })
}

#[cfg(test)]
#[path = "realtime_ws_access_tests.rs"]
mod tests;
