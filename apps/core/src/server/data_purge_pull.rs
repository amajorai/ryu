//! Pending-purge pull: how a managed node behind NAT (or one that never
//! advertises a URL) still receives the control plane's per-member purges.
//!
//! The control plane pushes a purge with a short-lived purge delegation
//! (`POST /api/data/purge-user`, see [`super::data_purge_delegation`]). A node
//! the push cannot reach would otherwise wait until the row ages out, so a
//! node bound to the control plane also pulls:
//!
//! - `GET /api/control-plane/gateway/data-purges` with `x-gateway-key` returns
//!   `{ purges: [{ id, user_id, reason, delegation }] }`, at most 50, only for
//!   the node bound to that credential (the cloud keys a row
//!   `<node id>:<user id>`, so the id is percent-encoded as one path segment);
//! - `POST /api/control-plane/gateway/data-purges/:id/ack` `{ status }` with
//!   `done` (the fan-out reported `complete: true`) or `incomplete`.
//!
//! Each pulled row runs exactly like the pushed route: revoke the member's app
//! route delegations, then [`super::data_user_purge::purge_user_app_data`].
//!
//! # Fail closed
//!
//! A row runs only when it passes the purge delegation's own rules
//! ([`super::data_purge_delegation::purge_delegation_admits`]): a well-formed
//! id, a well-formed `user_id`, and a reason of `account_deleted` or
//! `member_removed`. Every row must also carry a `delegation` that verifies
//! as a control-plane purge delegation (client
//! `ryu-control-plane:data-purge`) bound to this node, through the same
//! Ed25519 verifier and node binding the pushed route uses, whose subject is
//! that `user_id`. The transport alone is never trusted: a row without a
//! delegation is not run. Every row of one response is admitted against the
//! single instant the response arrived, before any purge runs, so a long
//! fan-out cannot expire the later rows' 60 s delegations.
//!
//! Malformed rows are dropped. A row with a bad `user_id` or reason is
//! acknowledged `incomplete` so the cloud backs it off. A row whose
//! delegation is missing, expired or invalid is neither run nor acknowledged:
//! it stays pending, and the next pull hands it out with a fresh token. That
//! is the safe side both ways: nothing runs without the control plane's
//! signature, and an expired token (clock skew, a slow cycle) never spends
//! the cloud's retry budget for a purge that must still happen. Only a
//! complete fan-out is acknowledged `done`.
//!
//! The pull client never follows redirects, so the node credential is never
//! forwarded to another origin; a `3xx` fails the cycle.
//!
//! # Idempotent
//!
//! Re-running a purge deletes nothing more. A purge that completed but whose
//! acknowledgement failed is remembered ([`PendingAcks`]) and only re-acked
//! on the next cycle, never re-run. No member id is ever logged.

use std::collections::{BTreeMap, HashSet};
use std::future::Future;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use super::data_purge_delegation::{is_purge_delegation, purge_delegation_admits};
use super::data_user_purge::PurgeReason;

/// The node-facing pull route on the control plane.
pub(crate) const PULL_ROUTE: &str = "/api/control-plane/gateway/data-purges";
/// The most rows one cycle runs, matching the cloud's page size.
pub(crate) const MAX_ROWS_PER_CYCLE: usize = 50;
/// The most completed-but-unacknowledged purges remembered between cycles.
pub(crate) const MAX_PENDING_ACKS: usize = 256;
const MAX_USER_ID_BYTES: usize = 256;
/// A row id is `<node id>:<user id>`; leave room for both.
const MAX_ID_BYTES: usize = 64 + 1 + MAX_USER_ID_BYTES;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// One row as the control plane sends it.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct PulledPurge {
    pub id: String,
    pub user_id: String,
    pub reason: String,
    /// The per-row purge delegation; required to run the row. Optional only
    /// in the wire shape so a row without one is refused, not dropped.
    #[serde(default)]
    pub delegation: Option<String>,
}

/// Why a well-formed row was not run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Refusal {
    InvalidUserId,
    InvalidReason,
    /// No `delegation`: left pending, never run.
    MissingDelegation,
    /// A `delegation` that does not verify for this node and member at the
    /// pull time: left pending, never run.
    InvalidDelegation,
}

impl Refusal {
    /// The acknowledgement a refused row gets: `incomplete` for a row the
    /// cloud itself got wrong, none (left pending) for an unauthorized one.
    pub(crate) fn ack(self) -> Option<AckStatus> {
        match self {
            Self::InvalidUserId | Self::InvalidReason => Some(AckStatus::Incomplete),
            Self::MissingDelegation | Self::InvalidDelegation => None,
        }
    }
}

/// What Core reports back for one row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AckStatus {
    Done,
    Incomplete,
}

impl AckStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Incomplete => "incomplete",
        }
    }
}

/// Why a whole cycle failed (and the worker should back off).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CycleError {
    /// The request did not complete.
    Network,
    /// The control plane answered with a non-success status.
    Status(u16),
    /// The body was not `{ purges: [...] }`.
    Decode,
}

/// Counts from one cycle; never member ids.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct CycleReport {
    pub pulled: usize,
    pub completed: usize,
    pub incomplete: usize,
    pub refused: usize,
    /// Refused for a missing or invalid delegation and left pending.
    pub unauthorized: usize,
    pub malformed: usize,
    pub reacked: usize,
    pub ack_failed: usize,
}

/// Whether `id` can be acknowledged: non-empty, bounded, free of control
/// characters, and not a dot segment (which a URL path would collapse). Any
/// other character is percent-encoded into one path segment by [`ack_url`].
pub(crate) fn valid_row_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_BYTES
        && id != "."
        && id != ".."
        && !id.chars().any(char::is_control)
}

/// `POST <base>/api/control-plane/gateway/data-purges/<id>/ack`, with `id`
/// percent-encoded as a single path segment (`/`, `?`, `#`, `%` included).
pub(crate) fn ack_url(base: &str, id: &str) -> Option<reqwest::Url> {
    let mut url =
        reqwest::Url::parse(&format!("{}{PULL_ROUTE}", base.trim_end_matches('/'))).ok()?;
    url.path_segments_mut().ok()?.push(id).push("ack");
    Some(url)
}

/// The client the pull loop uses: it never follows a redirect, so the
/// `x-gateway-key` header cannot be forwarded to another origin.
pub(crate) fn pull_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
}

fn valid_user_id(user_id: &str) -> bool {
    !user_id.is_empty()
        && user_id.len() <= MAX_USER_ID_BYTES
        && user_id.trim() == user_id
        && !user_id.chars().any(char::is_control)
}

/// The rows of a pull body. Rows that do not parse, or whose id is unsafe,
/// are dropped and counted; a body that is not `{ purges: [...] }` is an error.
pub(crate) fn parse_pull_body(body: &Value) -> Result<(Vec<PulledPurge>, usize), CycleError> {
    let rows = body
        .get("purges")
        .and_then(Value::as_array)
        .ok_or(CycleError::Decode)?;
    let mut seen = HashSet::new();
    let mut parsed = Vec::new();
    let mut malformed = 0;
    for row in rows {
        match serde_json::from_value::<PulledPurge>(row.clone()) {
            Ok(purge) if valid_row_id(&purge.id) => {
                if seen.insert(purge.id.clone()) && parsed.len() < MAX_ROWS_PER_CYCLE {
                    parsed.push(purge);
                }
            }
            _ => malformed += 1,
        }
    }
    Ok((parsed, malformed))
}

/// Maps a delegation token and a Unix time to the subject of a purge
/// delegation for this node that is valid at that time, or `None`.
pub(crate) type Verify = dyn Fn(&str, u64) -> Option<String> + Sync;

/// Whether the purge rules admit `row` at `now`: a valid member id and
/// departure reason, and a delegation that `verify` accepts for that member.
pub(crate) fn admit(row: &PulledPurge, verify: &Verify, now: u64) -> Result<PurgeReason, Refusal> {
    if !valid_user_id(&row.user_id) {
        return Err(Refusal::InvalidUserId);
    }
    let reason = PurgeReason::parse(&row.reason);
    if !purge_delegation_admits(&row.user_id, &row.user_id, reason) {
        return Err(Refusal::InvalidReason);
    }
    let Some(token) = row.delegation.as_deref() else {
        return Err(Refusal::MissingDelegation);
    };
    let admitted = verify(token, now)
        .is_some_and(|subject| purge_delegation_admits(&subject, &row.user_id, reason));
    if !admitted {
        return Err(Refusal::InvalidDelegation);
    }
    Ok(reason)
}

/// The subject of `token` when it verifies as the control plane's purge
/// delegation bound to this registered node.
pub(crate) fn verified_purge_subject(token: &str, now: u64) -> Option<String> {
    let verified = crate::authorization::delegation::verify(token, now).ok()?;
    if !is_purge_delegation(&verified.context) {
        return None;
    }
    verified.context.constraints.subject_id
}

/// Purges that ran to completion but whose `done` acknowledgement has not
/// been recorded yet. Bounded; the oldest entry is dropped first (the row is
/// then simply re-run, which is harmless).
#[derive(Debug, Default)]
pub(crate) struct PendingAcks {
    order: Vec<String>,
    statuses: BTreeMap<String, AckStatus>,
}

impl PendingAcks {
    pub(crate) fn insert(&mut self, id: &str, status: AckStatus) {
        if self.statuses.insert(id.to_owned(), status).is_none() {
            self.order.push(id.to_owned());
        }
        while self.order.len() > MAX_PENDING_ACKS {
            let oldest = self.order.remove(0);
            self.statuses.remove(&oldest);
        }
    }

    pub(crate) fn remove(&mut self, id: &str) {
        if self.statuses.remove(id).is_some() {
            self.order.retain(|entry| entry != id);
        }
    }

    pub(crate) fn contains(&self, id: &str) -> bool {
        self.statuses.contains_key(id)
    }

    pub(crate) fn len(&self) -> usize {
        self.order.len()
    }

    fn snapshot(&self) -> Vec<(String, AckStatus)> {
        self.order
            .iter()
            .filter_map(|id| self.statuses.get(id).map(|status| (id.clone(), *status)))
            .collect()
    }
}

/// How an acknowledgement went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AckOutcome {
    /// Recorded, or the row no longer exists for this node (404): settled.
    Settled,
    Failed,
}

async fn send_ack(
    client: &reqwest::Client,
    base: &str,
    key: &str,
    id: &str,
    status: AckStatus,
) -> AckOutcome {
    let Some(url) = ack_url(base, id) else {
        return AckOutcome::Failed;
    };
    let response = client
        .post(url)
        .header("x-gateway-key", key)
        .timeout(REQUEST_TIMEOUT)
        .json(&json!({ "status": status.as_str() }))
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => AckOutcome::Settled,
        Ok(response) if response.status() == reqwest::StatusCode::NOT_FOUND => AckOutcome::Settled,
        _ => AckOutcome::Failed,
    }
}

async fn fetch(client: &reqwest::Client, base: &str, key: &str) -> Result<Value, CycleError> {
    let url = format!("{}{PULL_ROUTE}", base.trim_end_matches('/'));
    let response = client
        .get(url)
        .header("x-gateway-key", key)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| CycleError::Network)?;
    if !response.status().is_success() {
        return Err(CycleError::Status(response.status().as_u16()));
    }
    response
        .json::<Value>()
        .await
        .map_err(|_| CycleError::Decode)
}

/// One pull cycle against the control plane at `base`.
///
/// Re-acknowledges remembered purges first, then pulls and admits every row
/// against one `clock()` reading taken when the response arrived, then runs
/// the admitted rows (through `execute`, which returns whether the fan-out was
/// complete) and acknowledges each row, except an unauthorized one, which is
/// left pending. A failed acknowledgement is remembered
/// in `pending` and retried next cycle without re-running the purge.
pub(crate) async fn run_cycle<Exec, Fut>(
    client: &reqwest::Client,
    base: &str,
    key: &str,
    pending: &mut PendingAcks,
    verify: &Verify,
    clock: &(dyn Fn() -> u64 + Sync),
    mut execute: Exec,
) -> Result<CycleReport, CycleError>
where
    Exec: FnMut(String, PurgeReason) -> Fut,
    Fut: Future<Output = bool>,
{
    let mut report = CycleReport::default();
    for (id, status) in pending.snapshot() {
        if send_ack(client, base, key, &id, status).await == AckOutcome::Settled {
            pending.remove(&id);
            report.reacked += 1;
        }
    }
    let body = fetch(client, base, key).await?;
    let fetched_at = clock();
    let (rows, malformed) = parse_pull_body(&body)?;
    report.pulled = rows.len();
    report.malformed = malformed;
    let admitted: Vec<_> = rows
        .into_iter()
        // A row already run is only waiting for its acknowledgement.
        .filter(|row| !pending.contains(&row.id))
        .map(|row| {
            let decision = admit(&row, verify, fetched_at);
            (row, decision)
        })
        .collect();
    for (row, decision) in admitted {
        let status = match decision {
            Ok(reason) => {
                if execute(row.user_id.clone(), reason).await {
                    report.completed += 1;
                    AckStatus::Done
                } else {
                    report.incomplete += 1;
                    AckStatus::Incomplete
                }
            }
            Err(refusal) => {
                report.refused += 1;
                match refusal.ack() {
                    Some(status) => status,
                    None => {
                        // Unauthorized: stays pending for a freshly signed pull.
                        report.unauthorized += 1;
                        continue;
                    }
                }
            }
        };
        if send_ack(client, base, key, &row.id, status).await == AckOutcome::Failed {
            report.ack_failed += 1;
            if status == AckStatus::Done {
                pending.insert(&row.id, status);
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
#[path = "data_purge_pull_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "data_purge_pull_cycle_tests.rs"]
mod cycle_tests;
