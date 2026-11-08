//! Control-group request storage: create, authorize, redeem, list, prune.

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::super::VaultError;
use super::*;

/// Create the control-group table. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_control_groups (
             id          TEXT PRIMARY KEY,
             token_hash  TEXT NOT NULL,
             requester   TEXT NOT NULL,
             policy_key  TEXT NOT NULL,
             target      TEXT NOT NULL,
             factors     TEXT NOT NULL,
             approvals   TEXT NOT NULL DEFAULT '[]',
             status      TEXT NOT NULL,
             created_at  INTEGER NOT NULL,
             expires_at  INTEGER NOT NULL,
             redeemed_at INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_vault_control_groups_requester
             ON vault_control_groups(requester);",
    )
    .context("initializing vault control-group schema")
}

pub(super) fn digest(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}

/// Constant-time byte comparison (length is not secret).
pub fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

pub(super) fn not_found() -> anyhow::Error {
    VaultError::NotFound("control-group request not found".to_owned()).into()
}

/// Open a request. Returns it with the one-time redemption token, which is
/// shown to the requester only now.
pub fn create_request(
    conn: &Connection,
    requester: &str,
    policy_key: &str,
    target: &Value,
    spec: &ControlGroupSpec,
    now: i64,
) -> Result<(ControlGroupRequest, String)> {
    use rand::RngCore;
    // Merged specs carry `policy/factor` names, so only the shape is rechecked;
    // every factor was validated when its policy was written.
    if spec.factors.is_empty() || spec.factors.iter().any(|f| f.approvals == 0) {
        bail!("control group has no satisfiable factors");
    }
    let open: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vault_control_groups
         WHERE requester = ?1 AND status IN ('pending', 'approved') AND expires_at > ?2",
        params![requester, now],
        |row| row.get(0),
    )?;
    if open >= MAX_OPEN_REQUESTS_PER_REQUESTER {
        return Err(VaultError::Conflict(format!(
            "too many open control-group requests (limit {MAX_OPEN_REQUESTS_PER_REQUESTER})"
        ))
        .into());
    }
    let mut secret = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut secret);
    let secret = hex::encode(secret);
    let id = uuid::Uuid::new_v4().simple().to_string();
    let request = ControlGroupRequest {
        id: id.clone(),
        requester: requester.to_owned(),
        policy_key: policy_key.to_owned(),
        target: target.clone(),
        factors: spec.factors.clone(),
        approvals: Vec::new(),
        status: ControlGroupStatus::Pending,
        created_at: now,
        expires_at: now + spec.ttl() * 1000,
        redeemed_at: None,
    };
    conn.execute(
        "INSERT INTO vault_control_groups
             (id, token_hash, requester, policy_key, target, factors, approvals, status,
              created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]', 'pending', ?7, ?8)",
        params![
            request.id,
            digest(&secret),
            request.requester,
            request.policy_key,
            serde_json::to_string(&request.target)?,
            serde_json::to_string(&request.factors)?,
            request.created_at,
            request.expires_at,
        ],
    )
    .context("writing control-group request")?;
    Ok((request, format!("{TOKEN_PREFIX}{id}.{secret}")))
}

pub(super) fn load_row(
    conn: &Connection,
    id: &str,
) -> Result<Option<(ControlGroupRequest, String)>> {
    conn.query_row(
        "SELECT id, token_hash, requester, policy_key, target, factors, approvals, status,
                created_at, expires_at, redeemed_at
         FROM vault_control_groups WHERE id = ?1",
        params![id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, Option<i64>>(10)?,
            ))
        },
    )
    .optional()?
    .map(
        |(
            id,
            hash,
            requester,
            policy_key,
            target,
            factors,
            approvals,
            status,
            created,
            expires,
            redeemed,
        )| {
            Ok((
                ControlGroupRequest {
                    id,
                    requester,
                    policy_key,
                    target: serde_json::from_str(&target).context("decoding target")?,
                    factors: serde_json::from_str(&factors).context("decoding factors")?,
                    approvals: serde_json::from_str(&approvals).context("decoding approvals")?,
                    status: ControlGroupStatus::parse(&status),
                    created_at: created,
                    expires_at: expires,
                    redeemed_at: redeemed,
                },
                hash,
            ))
        },
    )
    .transpose()
}

/// One request, with `expired` reported for a lapsed pending/approved one.
pub fn get_request(conn: &Connection, id: &str, now: i64) -> Result<Option<ControlGroupRequest>> {
    Ok(load_row(conn, id)?.map(|(mut request, _)| {
        if request.expires_at <= now
            && matches!(
                request.status,
                ControlGroupStatus::Pending | ControlGroupStatus::Approved
            )
        {
            request.status = ControlGroupStatus::Expired;
        }
        request
    }))
}

/// Record an approval by a caller holding `subjects`. The approver must be
/// named by a factor and must not be the requester. Idempotent per approver.
pub fn authorize(
    conn: &Connection,
    id: &str,
    approver: &str,
    subjects: &[String],
    now: i64,
) -> Result<ControlGroupRequest> {
    let tx = conn.unchecked_transaction()?;
    let Some(mut request) = get_request(&tx, id, now)? else {
        return Err(not_found());
    };
    if request.status != ControlGroupStatus::Pending
        && request.status != ControlGroupStatus::Approved
    {
        return Err(VaultError::Conflict(format!(
            "control-group request is {}",
            request.status.as_str()
        ))
        .into());
    }
    if approver == request.requester || subjects.iter().any(|s| s == &request.requester) {
        return Err(
            VaultError::Denied("requesters cannot approve their own request".into()).into(),
        );
    }
    let mut matched = false;
    for factor in &request.factors {
        if !factor.approvers.iter().any(|a| subjects.contains(a)) {
            continue;
        }
        matched = true;
        if !request
            .approvals
            .iter()
            .any(|a| a.factor == factor.name && a.approver == approver)
        {
            request.approvals.push(ControlGroupApproval {
                factor: factor.name.clone(),
                approver: approver.to_owned(),
                approved_at: now,
            });
        }
    }
    if !matched {
        return Err(VaultError::Denied("not an approver for this control group".into()).into());
    }
    if request.satisfied() {
        request.status = ControlGroupStatus::Approved;
    }
    let changed = tx.execute(
        "UPDATE vault_control_groups SET approvals = ?1, status = ?2
         WHERE id = ?3 AND status IN ('pending', 'approved') AND expires_at > ?4",
        params![
            serde_json::to_string(&request.approvals)?,
            request.status.as_str(),
            id,
            now
        ],
    )?;
    if changed != 1 {
        return Err(VaultError::Conflict("control-group request changed".into()).into());
    }
    tx.commit()?;
    Ok(request)
}

/// The request `token` names, when the token and `requester` both match.
/// Every failure that could reveal whether a token exists returns the same
/// not-found error. Does not change the request.
pub fn verify_token(
    conn: &Connection,
    token: &str,
    requester: &str,
) -> Result<(ControlGroupRequest, String)> {
    let Some((id, secret)) = token
        .strip_prefix(TOKEN_PREFIX)
        .and_then(|rest| rest.split_once('.'))
    else {
        return Err(not_found());
    };
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(not_found());
    }
    let Some((request, stored_hash)) = load_row(conn, id)? else {
        return Err(not_found());
    };
    let presented = digest(secret);
    let token_ok = constant_time_eq(presented.as_bytes(), stored_hash.as_bytes());
    let requester_ok = constant_time_eq(requester.as_bytes(), request.requester.as_bytes());
    if !(token_ok && requester_ok) {
        return Err(not_found());
    }
    Ok((request, stored_hash))
}

/// Redeem `token` for `requester`. Single use: the status flips from
/// `approved` to `redeemed` in one conditional `UPDATE`, so concurrent or
/// repeated redemptions of the same token fail. Every failure that could
/// reveal whether a token exists returns the same not-found error.
pub fn redeem(
    conn: &Connection,
    token: &str,
    requester: &str,
    now: i64,
) -> Result<ControlGroupRequest> {
    let (mut request, stored_hash) = verify_token(conn, token, requester)?;
    let changed = conn.execute(
        "UPDATE vault_control_groups SET status = 'redeemed', redeemed_at = ?1
         WHERE id = ?2 AND token_hash = ?3 AND status = 'approved' AND expires_at > ?1",
        params![now, request.id, stored_hash],
    )?;
    if changed != 1 {
        let status = if request.expires_at <= now {
            "expired".to_owned()
        } else {
            request.status.as_str().to_owned()
        };
        return Err(VaultError::Conflict(format!(
            "control-group request is {status}, not approved"
        ))
        .into());
    }
    request.status = ControlGroupStatus::Redeemed;
    request.redeemed_at = Some(now);
    Ok(request)
}

/// Undo a redemption whose value could not be released, so the approved
/// token stays usable until it expires.
pub fn unredeem(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "UPDATE vault_control_groups SET status = 'approved', redeemed_at = NULL
         WHERE id = ?1 AND status = 'redeemed'",
        params![id],
    )?;
    Ok(())
}

/// Requests opened by or awaiting `subjects` (newest first, at most 100).
/// Every stored row is considered (pruning and the per-requester cap keep the
/// table bounded), so a flood of newer requests cannot hide older ones.
pub fn list_requests(
    conn: &Connection,
    subjects: &[String],
    include_all: bool,
    now: i64,
) -> Result<Vec<ControlGroupRequest>> {
    let mut stmt = conn.prepare("SELECT id FROM vault_control_groups ORDER BY created_at DESC")?;
    let ids: Vec<String> = stmt
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::new();
    for id in ids {
        let Some(request) = get_request(conn, &id, now)? else {
            continue;
        };
        if include_all || subjects.contains(&request.requester) || request.is_approver(subjects) {
            out.push(request);
            if out.len() == MAX_LISTED_REQUESTS {
                break;
            }
        }
    }
    Ok(out)
}

/// Delete requests whose lifetime ended more than a day ago.
pub fn prune(conn: &Connection, now: i64) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM vault_control_groups WHERE expires_at <= ?1",
        params![now - 24 * 3600 * 1000],
    )?)
}
