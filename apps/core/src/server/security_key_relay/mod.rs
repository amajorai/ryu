//! Security-key relay: a browser on this node (a VM, cloud node or hidden Bot
//! lane of the Browser sidecar) asks the user's desktop to answer a site's
//! WebAuthn ceremony with the hardware key plugged into it.
//!
//! The sidecar calls the `securityKey.request` kernel capability (grant
//! `security-key:relay`, owner-exclusive to the Browser app). Core reads the
//! node's live `computer_use.security_key` setting (off or unreadable answers
//! `disabled`), re-runs [`validate_relay`], and holds the call on a per-request
//! [`Notify`] until the owning user's desktop answers through
//! `POST /api/security-key/requests/:id/response` or the request's deadline
//! passes. The desktop finds waiting requests by polling
//! `GET /api/security-key/requests` (see [`api`]). The capability always
//! answers `200` with a [`RelayOutcome`]; anything but `ok` makes the page's
//! promise reject.
//!
//! Requests live only in memory: a restart drops them, and the waiting page
//! then times out like an unanswered request.

mod api;
#[cfg(test)]
mod tests;

pub(crate) use api::routes;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::Json;
use ryu_webauthn_relay::{
    validate_relay, PendingRelayRequest, RelayDecision, RelayOutcome, RelayRequest,
};
use serde_json::json;
use tokio::sync::Notify;

use super::ServerState;

/// Most requests one owner may have waiting at once.
pub(crate) const MAX_PENDING_PER_OWNER: usize = 8;
/// Most requests the node holds at once, across owners.
pub(crate) const MAX_PENDING: usize = 256;
/// Owner key of a node no personal account owns: only the node token holder.
pub(crate) const NODE_OWNER: &str = "node-owner";

/// Why a request could not be stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpenError {
    /// The owner, or the node, already has the most requests waiting.
    Full,
}

/// Why an answer was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AnswerError {
    /// No such request, it expired, or it belongs to another owner.
    NotFound,
    /// The request was already answered.
    AlreadyAnswered,
    /// The credential answers the other ceremony (an assertion for `create`).
    KindMismatch,
}

struct Entry {
    owner: String,
    request: PendingRelayRequest,
    answer: Option<RelayDecision>,
    notify: Arc<Notify>,
}

/// The requests waiting for their owner's desktop.
#[derive(Default)]
pub(crate) struct RelayStore {
    entries: Mutex<HashMap<String, Entry>>,
}

/// Removes a request from the store when its waiting call ends, however it
/// ends (answered, timed out, or the sidecar's connection dropped).
struct Ticket<'a> {
    store: &'a RelayStore,
    id: String,
    notify: Arc<Notify>,
}

impl Drop for Ticket<'_> {
    fn drop(&mut self) {
        self.store.lock().remove(&self.id);
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

impl RelayStore {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Store `request` for `owner`, expiring `timeout_ms` after `now`.
    fn open(
        &self,
        owner: &str,
        request: RelayRequest,
        timeout_ms: u64,
        now: u64,
    ) -> Result<Ticket<'_>, OpenError> {
        let mut entries = self.lock();
        entries.retain(|_, entry| entry.request.expires_at_ms > now);
        let owned = entries.values().filter(|e| e.owner == owner).count();
        if entries.len() >= MAX_PENDING || owned >= MAX_PENDING_PER_OWNER {
            return Err(OpenError::Full);
        }
        let id = format!("skr_{}", uuid::Uuid::new_v4().simple());
        let notify = Arc::new(Notify::new());
        let pending = PendingRelayRequest {
            id: id.clone(),
            kind: request.kind,
            agent_id: request.agent_id,
            page_url: request.page_url,
            origin: request.origin,
            rp_id: request.rp_id,
            client_data_json: request.client_data_json,
            options: request.options,
            created_at_ms: now,
            expires_at_ms: now.saturating_add(timeout_ms),
        };
        entries.insert(
            id.clone(),
            Entry {
                owner: owner.to_owned(),
                request: pending,
                answer: None,
                notify: Arc::clone(&notify),
            },
        );
        Ok(Ticket {
            store: self,
            id,
            notify,
        })
    }

    fn answer_of(&self, id: &str) -> Option<RelayDecision> {
        self.lock().get(id).and_then(|entry| entry.answer.clone())
    }

    /// Hold until the ticket's request is answered or `deadline` passes.
    async fn wait(
        &self,
        ticket: &Ticket<'_>,
        deadline: tokio::time::Instant,
    ) -> Option<RelayDecision> {
        loop {
            let notified = ticket.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(answer) = self.answer_of(&ticket.id) {
                return Some(answer);
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return self.answer_of(&ticket.id);
            }
        }
    }

    /// The unanswered, unexpired requests whose owner `may_see` accepts,
    /// oldest first.
    pub(crate) fn pending_for(
        &self,
        may_see: impl Fn(&str) -> bool,
        now: u64,
    ) -> Vec<PendingRelayRequest> {
        let mut requests: Vec<PendingRelayRequest> = self
            .lock()
            .values()
            .filter(|e| e.answer.is_none() && e.request.expires_at_ms > now && may_see(&e.owner))
            .map(|e| e.request.clone())
            .collect();
        requests.sort_by(|a, b| {
            a.created_at_ms
                .cmp(&b.created_at_ms)
                .then_with(|| a.id.cmp(&b.id))
        });
        requests
    }

    /// Record the answer to request `id` and wake its waiting call. Each
    /// request is answered once; another owner's request reads as unknown.
    pub(crate) fn answer(
        &self,
        id: &str,
        may_answer: impl Fn(&str) -> bool,
        decision: RelayDecision,
        now: u64,
    ) -> Result<(), AnswerError> {
        let mut entries = self.lock();
        let Some(entry) = entries.get_mut(id) else {
            return Err(AnswerError::NotFound);
        };
        if !may_answer(&entry.owner) || entry.request.expires_at_ms <= now {
            return Err(AnswerError::NotFound);
        }
        if entry.answer.is_some() {
            return Err(AnswerError::AlreadyAnswered);
        }
        if let RelayDecision::Approve { credential } = &decision {
            if !credential.matches(entry.request.kind) {
                return Err(AnswerError::KindMismatch);
            }
        }
        entry.answer = Some(decision);
        entry.notify.notify_waiters();
        Ok(())
    }
}

/// The process-wide store the capability and the routes share.
pub(crate) fn store() -> &'static RelayStore {
    static STORE: OnceLock<RelayStore> = OnceLock::new();
    STORE.get_or_init(RelayStore::default)
}

/// Run one relayed ceremony for `owner`: validate it, hold it until the owner
/// answers or its deadline passes, and turn the answer into an outcome.
/// `enabled` is the node's live `computer_use.security_key` setting.
pub(crate) async fn relay(
    store: &RelayStore,
    owner: &str,
    request: RelayRequest,
    enabled: bool,
) -> RelayOutcome {
    if !enabled {
        return RelayOutcome::Disabled;
    }
    let validated = match validate_relay(&request) {
        Ok(validated) => validated,
        Err(error) => {
            return RelayOutcome::Invalid {
                message: error.to_string(),
            }
        }
    };
    let kind = request.kind;
    let ticket = match store.open(owner, request, validated.timeout_ms, now_ms()) {
        Ok(ticket) => ticket,
        Err(OpenError::Full) => {
            return RelayOutcome::Denied {
                reason: Some("too many security-key requests are waiting".to_owned()),
            }
        }
    };
    let deadline = tokio::time::Instant::now() + Duration::from_millis(validated.timeout_ms);
    match store.wait(&ticket, deadline).await {
        Some(RelayDecision::Approve { credential }) if credential.matches(kind) => {
            RelayOutcome::Ok { credential }
        }
        Some(RelayDecision::Approve { .. }) => RelayOutcome::Denied {
            reason: Some("the credential does not answer this ceremony".to_owned()),
        },
        Some(RelayDecision::Deny { reason }) => RelayOutcome::Denied { reason },
        None => RelayOutcome::Timeout,
    }
}

/// Whether a Gateway config allows the relay: `computer_use.security_key` is
/// exactly `true`. Anything else (missing, not a bool) is off.
pub(crate) fn security_key_enabled_in(config: &serde_json::Value) -> bool {
    config
        .get("computer_use")
        .and_then(|section| section.get("security_key"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

/// The node's live setting, read from the running Gateway on every request so
/// a toggle applies at once. A read failure is off.
async fn security_key_allowed(state: &ServerState) -> bool {
    match crate::sidecar::gateway::fetch_config(&state.client).await {
        Ok(config) => security_key_enabled_in(&config),
        Err(error) => {
            tracing::warn!(error = %error, "security-key relay: gateway config unavailable");
            false
        }
    }
}

/// The owner key of a node registered as `node`: its personal owner's account,
/// else the node token holder. A team or org node has no personal owner, so
/// only the node token may answer there.
pub(crate) fn owner_key_for(
    node: Option<&crate::sidecar::control_plane::RegisteredNode>,
) -> String {
    use crate::sidecar::control_plane::NodeScope;
    node.filter(|node| node.scope == NodeScope::Personal)
        .and_then(|node| node.owner_user_id.as_deref())
        .map_or_else(|| NODE_OWNER.to_owned(), |user| format!("user:{user}"))
}

/// The owner every request on this node is held for. Bot lanes run on the
/// node for its owner, so a lane's request goes to the same person; the card
/// names the Bot.
pub(crate) fn node_owner_key() -> String {
    owner_key_for(crate::sidecar::control_plane::registered_node().as_ref())
}

fn outcome(outcome: &RelayOutcome) -> Response {
    Json(outcome).into_response()
}

/// `POST /api/host/capability/securityKey.request`. The broker has already
/// checked the `security-key:relay` grant; this re-authenticates the sidecar,
/// then answers `200` with a [`RelayOutcome`] once the ceremony ends.
pub(crate) async fn host_security_key_request(
    state: ServerState,
    headers: HeaderMap,
    body: &[u8],
) -> Response {
    let plugin_id = match crate::sidecar::ext_proxy::authenticate_sidecar(&state, &headers).await {
        Ok((plugin_id, _)) => plugin_id,
        Err((status, message)) => {
            return (status, Json(json!({ "error": message }))).into_response()
        }
    };
    if !security_key_allowed(&state).await {
        return outcome(&RelayOutcome::Disabled);
    }
    let request: RelayRequest = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(error) => {
            return outcome(&RelayOutcome::Invalid {
                message: format!("invalid request body: {error}"),
            })
        }
    };
    // As for an agent account fill: the lane's agent is looked up, and a
    // store failure refuses rather than reading as an unknown lane.
    if let Some(agent_id) = request.agent_id.as_deref() {
        if let Err(error) = state.agent_store.get(agent_id).await {
            tracing::warn!("security-key relay agent lookup failed: {error:#}");
            return outcome(&RelayOutcome::Denied {
                reason: Some("agent lookup unavailable".to_owned()),
            });
        }
    }
    let origin = request.origin.clone();
    let result = relay(store(), &node_owner_key(), request, true).await;
    let status = serde_json::to_value(&result)
        .ok()
        .and_then(|v| v.get("status").and_then(|s| s.as_str()).map(str::to_owned))
        .unwrap_or_default();
    tracing::info!(plugin_id, origin, status, "security-key relay finished");
    outcome(&result)
}
