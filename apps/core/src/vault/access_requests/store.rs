//! Access request storage and state transitions. Every transition runs in a
//! transaction and changes a row only from the status it was read in, so two
//! concurrent decisions cannot both apply.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::super::policy::{self, Capability, Policy, PolicyRule};
use super::super::policy_ext::{ControlGroupApproval, ControlGroupFactor};
use super::super::VaultError;
use super::{
    list_policies, plan, read_may_be_gated, validate_capabilities, validate_glob, AccessRequest,
    AccessRequestStatus, GRANT_POLICY_PREFIX, MAX_DURATION_SECS, MAX_REASON_LEN, MIN_DURATION_SECS,
};

/// Open (pending) requests one requester may hold.
pub const MAX_OPEN_PER_REQUESTER: i64 = 16;
/// Requests returned by one listing.
const MAX_LISTED: usize = 100;
/// How long finished requests stay listed.
const HISTORY_MILLIS: i64 = 30 * 24 * 3600 * 1000;

/// Create the access-request tables. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_access_policies (
             name       TEXT PRIMARY KEY,
             body       TEXT NOT NULL,
             created_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS vault_access_requests (
             id         TEXT PRIMARY KEY,
             requester  TEXT NOT NULL,
             status     TEXT NOT NULL,
             body       TEXT NOT NULL,
             created_at INTEGER NOT NULL,
             ends_at    INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_vault_access_requests_requester
             ON vault_access_requests(requester);",
    )
    .context("initializing vault access-request schema")
}

/// What a requester asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewAccessRequest {
    pub path: String,
    pub capabilities: Vec<Capability>,
    pub duration_secs: i64,
    pub reason: String,
}

fn invalid(error: anyhow::Error) -> anyhow::Error {
    VaultError::Invalid(format!("{error:#}")).into()
}

fn not_found() -> anyhow::Error {
    VaultError::NotFound("access request not found".to_owned()).into()
}

/// When the row's current phase ends: a pending request's lifetime, or a
/// grant's expiry.
fn ends_at(request: &AccessRequest) -> i64 {
    request.grant_expires_at.unwrap_or(request.expires_at)
}

fn load(conn: &Connection, id: &str) -> Result<Option<AccessRequest>> {
    let body: Option<String> = conn
        .query_row(
            "SELECT body FROM vault_access_requests WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    body.map(|body| serde_json::from_str(&body).context("decoding access request"))
        .transpose()
}

/// Write `request` if its row is still in status `from`.
fn store(conn: &Connection, request: &AccessRequest, from: AccessRequestStatus) -> Result<()> {
    let changed = conn.execute(
        "UPDATE vault_access_requests SET status = ?1, body = ?2, ends_at = ?3
         WHERE id = ?4 AND status = ?5",
        params![
            request.status.as_str(),
            serde_json::to_string(request)?,
            ends_at(request),
            request.id,
            from.as_str()
        ],
    )?;
    if changed != 1 {
        return Err(VaultError::Conflict("access request changed".to_owned()).into());
    }
    Ok(())
}

/// One request, with lapsed status and its open step filled in.
pub fn get_request(conn: &Connection, id: &str, now: i64) -> Result<Option<AccessRequest>> {
    Ok(load(conn, id)?.map(|mut request| {
        request.refresh(now);
        request
    }))
}

/// Open a request as `requester` (`user:<id>`).
pub fn create_request(
    conn: &Connection,
    requester: &str,
    input: &NewAccessRequest,
    now: i64,
) -> Result<AccessRequest> {
    validate_glob(&input.path, true).map_err(invalid)?;
    validate_capabilities(&input.capabilities).map_err(invalid)?;
    if !(MIN_DURATION_SECS..=MAX_DURATION_SECS).contains(&input.duration_secs) {
        return Err(invalid(anyhow::anyhow!(
            "durationSecs must be between {MIN_DURATION_SECS} and {MAX_DURATION_SECS}"
        )));
    }
    let reason = input.reason.trim();
    if reason.is_empty() || reason.len() > MAX_REASON_LEN || reason.chars().any(char::is_control) {
        return Err(invalid(anyhow::anyhow!(
            "a reason of 1-{MAX_REASON_LEN} characters without control characters is required"
        )));
    }
    let mut capabilities = input.capabilities.clone();
    capabilities.sort();
    capabilities.dedup();
    let chain = plan(
        &list_policies(conn)?,
        &input.path,
        &capabilities,
        input.duration_secs,
    )?;
    if capabilities.contains(&Capability::Read)
        && read_may_be_gated(&policy::list_policies(conn)?, &input.path)
    {
        return Err(VaultError::Denied(format!(
            "a control group may gate `read` under `{}`; reveal those values through it instead",
            input.path
        ))
        .into());
    }
    let open: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vault_access_requests
         WHERE requester = ?1 AND status = 'pending' AND ends_at > ?2",
        params![requester, now],
        |row| row.get(0),
    )?;
    if open >= MAX_OPEN_PER_REQUESTER {
        return Err(VaultError::Conflict(format!(
            "too many open access requests (limit {MAX_OPEN_PER_REQUESTER})"
        ))
        .into());
    }
    let environment = input.path.split('/').next().unwrap_or_default().to_owned();
    let mut request = AccessRequest {
        id: uuid::Uuid::new_v4().simple().to_string(),
        requester: requester.to_owned(),
        environment,
        path: input.path.clone(),
        capabilities,
        duration_secs: input.duration_secs,
        reason: reason.to_owned(),
        policies: chain.policies,
        steps: chain.steps,
        approvals: Vec::new(),
        status: AccessRequestStatus::Pending,
        current_step: None,
        created_at: now,
        expires_at: now + chain.request_ttl_secs * 1000,
        decided_at: None,
        decided_by: None,
        decision_reason: None,
        grant_policy: None,
        granted_at: None,
        grant_expires_at: None,
    };
    conn.execute(
        "INSERT INTO vault_access_requests (id, requester, status, body, created_at, ends_at)
         VALUES (?1, ?2, 'pending', ?3, ?4, ?5)",
        params![
            request.id,
            request.requester,
            serde_json::to_string(&request)?,
            now,
            request.expires_at
        ],
    )?;
    request.refresh(now);
    Ok(request)
}

/// A pending request the caller may act on, with its open step.
fn pending(conn: &Connection, id: &str, now: i64) -> Result<AccessRequest> {
    let Some(request) = get_request(conn, id, now)? else {
        return Err(not_found());
    };
    if request.status != AccessRequestStatus::Pending {
        return Err(
            VaultError::Conflict(format!("access request is {}", request.status.as_str())).into(),
        );
    }
    Ok(request)
}

/// The open step `approver` (holding `subjects`) may decide, after the
/// separation-of-duty checks.
fn decidable_step(
    request: &AccessRequest,
    approver: &str,
    subjects: &[String],
) -> Result<ControlGroupFactor> {
    if approver == request.requester || subjects.iter().any(|s| s == &request.requester) {
        return Err(
            VaultError::Denied("requesters cannot decide their own request".to_owned()).into(),
        );
    }
    let Some(step) = request.open_step().cloned() else {
        return Err(VaultError::Conflict("access request has no open step".to_owned()).into());
    };
    if !step.approvers.iter().any(|a| subjects.contains(a)) {
        return Err(VaultError::Denied(format!(
            "not an approver for step `{}`, which the request is waiting on",
            step.name
        ))
        .into());
    }
    if request
        .approvals
        .iter()
        .any(|a| a.approver == approver && a.factor != step.name)
    {
        return Err(
            VaultError::Denied("one approver counts toward one step only".to_owned()).into(),
        );
    }
    Ok(step)
}

/// Whether the chain the request follows is still the one its path needs,
/// and `read` it asks for is still not gated by a control group.
fn chain_current(conn: &Connection, request: &AccessRequest) -> Result<()> {
    let current = plan(
        &list_policies(conn)?,
        &request.path,
        &request.capabilities,
        request.duration_secs,
    );
    match current {
        Ok(chain) if chain.policies == request.policies && chain.steps == request.steps => {}
        _ => {
            return Err(VaultError::Conflict(
                "access policy changed; the requester must open a new request".to_owned(),
            )
            .into())
        }
    }
    // A control group added after the request opened must not be bypassed
    // by the grant, so the creation-time refusal is checked again here.
    if request.capabilities.contains(&Capability::Read)
        && read_may_be_gated(&policy::list_policies(conn)?, &request.path)
    {
        return Err(VaultError::Conflict(format!(
            "a control group now may gate `read` under `{}`; the requester must open a new request",
            request.path
        ))
        .into());
    }
    Ok(())
}

/// Approve the open step as `approver`. When the last step is satisfied the
/// request is granted: a one-rule policy bound to the requester until the
/// duration ends.
pub fn approve(
    conn: &Connection,
    id: &str,
    approver: &str,
    subjects: &[String],
    now: i64,
) -> Result<AccessRequest> {
    let tx = conn.unchecked_transaction()?;
    let mut request = pending(&tx, id, now)?;
    let step = decidable_step(&request, approver, subjects)?;
    chain_current(&tx, &request)?;
    if !request
        .approvals
        .iter()
        .any(|a| a.factor == step.name && a.approver == approver)
    {
        request.approvals.push(ControlGroupApproval {
            factor: step.name.clone(),
            approver: approver.to_owned(),
            approved_at: now,
        });
    }
    if request.open_step().is_none() {
        let name = format!("{GRANT_POLICY_PREFIX}{}", request.id);
        policy::put_policy(
            &tx,
            &Policy {
                name: name.clone(),
                description: format!("Access request {}", request.id),
                rules: vec![PolicyRule {
                    path: request.path.clone(),
                    capabilities: request.capabilities.clone(),
                    ..Default::default()
                }],
            },
        )?;
        let expires = now + request.duration_secs * 1000;
        policy::bind(
            &tx,
            &name,
            &request.requester,
            Some(expires),
            Some(approver),
        )?;
        request.status = AccessRequestStatus::Granted;
        request.decided_at = Some(now);
        request.decided_by = Some(approver.to_owned());
        request.grant_policy = Some(name);
        request.granted_at = Some(now);
        request.grant_expires_at = Some(expires);
    }
    store(&tx, &request, AccessRequestStatus::Pending)?;
    tx.commit()?;
    request.refresh(now);
    Ok(request)
}

/// Deny the request as an approver of its open step.
pub fn deny(
    conn: &Connection,
    id: &str,
    approver: &str,
    subjects: &[String],
    reason: Option<&str>,
    now: i64,
) -> Result<AccessRequest> {
    let reason = reason.map(str::trim).filter(|text| !text.is_empty());
    if reason.is_some_and(|text| text.len() > MAX_REASON_LEN || text.chars().any(char::is_control))
    {
        return Err(invalid(anyhow::anyhow!(
            "reason must be at most {MAX_REASON_LEN} characters without control characters"
        )));
    }
    let tx = conn.unchecked_transaction()?;
    let mut request = pending(&tx, id, now)?;
    decidable_step(&request, approver, subjects)?;
    request.status = AccessRequestStatus::Denied;
    request.decided_at = Some(now);
    request.decided_by = Some(approver.to_owned());
    request.decision_reason = reason.map(str::to_owned);
    store(&tx, &request, AccessRequestStatus::Pending)?;
    tx.commit()?;
    request.refresh(now);
    Ok(request)
}

/// Withdraw a pending request (requester only).
pub fn cancel(conn: &Connection, id: &str, requester: &str, now: i64) -> Result<AccessRequest> {
    let tx = conn.unchecked_transaction()?;
    let mut request = pending(&tx, id, now)?;
    if request.requester != requester {
        return Err(not_found());
    }
    request.status = AccessRequestStatus::Cancelled;
    request.decided_at = Some(now);
    request.decided_by = Some(requester.to_owned());
    store(&tx, &request, AccessRequestStatus::Pending)?;
    tx.commit()?;
    request.refresh(now);
    Ok(request)
}

/// End an active grant now: its policy and binding are deleted. The caller
/// authorizes (the requester or an admin).
pub fn revoke(conn: &Connection, id: &str, by: &str, now: i64) -> Result<AccessRequest> {
    let tx = conn.unchecked_transaction()?;
    let Some(mut request) = get_request(&tx, id, now)? else {
        return Err(not_found());
    };
    if request.status != AccessRequestStatus::Granted {
        return Err(VaultError::Conflict(format!(
            "access request is {}, not granted",
            request.status.as_str()
        ))
        .into());
    }
    if let Some(name) = &request.grant_policy {
        policy::delete_policy(&tx, name)?;
    }
    request.status = AccessRequestStatus::Revoked;
    request.decided_at = Some(now);
    request.decided_by = Some(by.to_owned());
    request.grant_expires_at = Some(now);
    store(&tx, &request, AccessRequestStatus::Granted)?;
    tx.commit()?;
    request.refresh(now);
    Ok(request)
}

/// Requests opened by or awaiting `subjects` (every request when `all`),
/// newest first, at most 100.
pub fn list_requests(
    conn: &Connection,
    subjects: &[String],
    all: bool,
    now: i64,
) -> Result<Vec<AccessRequest>> {
    let mut stmt =
        conn.prepare("SELECT body FROM vault_access_requests ORDER BY created_at DESC")?;
    let bodies: Vec<String> = stmt
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::new();
    for body in bodies {
        let mut request: AccessRequest = serde_json::from_str(&body)?;
        if all || subjects.contains(&request.requester) || request.is_approver(subjects) {
            request.refresh(now);
            out.push(request);
            if out.len() == MAX_LISTED {
                break;
            }
        }
    }
    Ok(out)
}

/// Retire ended grants (delete their policies, mark them expired), lapse
/// pending requests, and forget requests that ended over 30 days ago.
pub fn prune(conn: &Connection, now: i64) -> Result<usize> {
    let tx = conn.unchecked_transaction()?;
    let mut stmt = tx.prepare(
        "SELECT id FROM vault_access_requests
         WHERE status IN ('pending', 'granted') AND ends_at <= ?1",
    )?;
    let ended: Vec<String> = stmt
        .query_map(params![now], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    drop(stmt);
    for id in &ended {
        let Some(mut request) = load(&tx, id)? else {
            continue;
        };
        let from = request.status;
        if let Some(name) = request
            .grant_policy
            .as_ref()
            .filter(|_| from == AccessRequestStatus::Granted)
        {
            policy::delete_policy(&tx, name)?;
        }
        request.status = AccessRequestStatus::Expired;
        store(&tx, &request, from)?;
    }
    let forgotten = tx.execute(
        "DELETE FROM vault_access_requests
         WHERE status NOT IN ('pending', 'granted') AND ends_at <= ?1",
        params![now - HISTORY_MILLIS],
    )?;
    tx.commit()?;
    Ok(ended.len() + forgotten)
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
