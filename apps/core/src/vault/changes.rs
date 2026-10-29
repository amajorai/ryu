//! Change requests for protected environments.
//!
//! When an environment is `protected`, a write or delete there by a principal
//! without the `admin` capability does not take effect. It becomes a pending
//! change request holding the sealed proposed value. Principals with the
//! `approve` capability approve or reject it; it applies once it has the
//! environment's `requiredApprovals`. A requester cannot approve their own
//! request, and the same approver counts once.
//!
//! A request expires [`CHANGE_REQUEST_TTL_MS`] after it was made, matching the
//! longest control-group TTL. Approving an expired request rejects it instead
//! of applying it. The approval threshold is the larger of the snapshot taken
//! at request time and the environment's current `requiredApprovals`, so
//! raising the bar also covers requests already pending.
//!
//! The requester's authority is re-checked at every approval. The request
//! keeps the requester's policy-binding subjects and their pre-policy
//! baseline on the target, and approval re-evaluates the policies bound to
//! those subjects now. A binding that expired or was removed, or a new deny
//! rule, rejects the request instead of applying it. A request made before
//! this was recorded cannot be re-checked and is rejected the same way.
//! Changes to the requester's role or team membership are not visible here
//! (Core only learns them from the requester's own verified session).

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::audit::{AuditActor, AuditEntry};
use super::policy::{Capability, CapabilitySet};
use super::policy_ext::{TemplateContext, MAX_CONTROL_GROUP_TTL_SECS};
use super::{now_millis, VaultError};
use crate::plugin_secrets::{
    PluginSecretStore, SecretCoords, SecretMetadataPatch, VaultSecretInfo, VersionSource,
    WriteRequest,
};

/// How long a change request stays approvable after it was made.
pub const CHANGE_REQUEST_TTL_MS: i64 = MAX_CONTROL_GROUP_TTL_SECS * 1000;

/// Reason recorded when approval finds the requester no longer holds the
/// capability the request needs.
pub const REQUESTER_NO_LONGER_AUTHORIZED: &str = "requester_no_longer_authorized";

/// The authority a requester held when they made a change request, kept so
/// each approval can re-check it against the policy bindings in force then.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RequesterAuthority {
    /// Policy-binding subjects (`user:`, `role:`, `team:`).
    pub subjects: Vec<String>,
    /// The requester's capabilities on the target before policies apply.
    pub baseline: CapabilitySet,
}

/// What the requester last saw of the secret (optimistic concurrency).
/// When set, the request is refused at creation unless the secret is still
/// there, exactly as a direct write checks `expectedVersion`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ChangeBase {
    /// The value version the caller edited from (`0` to create).
    pub version: Option<i64>,
    /// The `metadataVersion` the caller edited from.
    pub metadata_version: Option<i64>,
}

/// What a change request does when applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeOperation {
    Write,
    Delete,
}

/// Lifecycle of a change request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeStatus {
    Pending,
    Applied,
    Rejected,
    Canceled,
}

impl ChangeStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Applied => "applied",
            Self::Rejected => "rejected",
            Self::Canceled => "canceled",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "applied" => Self::Applied,
            "rejected" => Self::Rejected,
            "canceled" => Self::Canceled,
            _ => Self::Pending,
        }
    }
}

/// One approval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub by: String,
    pub at: i64,
}

/// A change request projection (never the proposed value).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRequest {
    pub id: String,
    pub status: ChangeStatus,
    pub operation: ChangeOperation,
    pub coords: SecretCoords,
    pub has_value: bool,
    pub patch: Value,
    pub requested_by: String,
    pub requested_at: i64,
    /// `requested_at` + [`CHANGE_REQUEST_TTL_MS`]; approval after this rejects it.
    pub expires_at: i64,
    pub approvals: Vec<Approval>,
    pub required_approvals: u8,
    /// The secret version the request was made against (0 when it did not
    /// exist). Approval applies only while the secret is still at this
    /// version, with the same metadata version and deleted state, so it never
    /// overwrites a change made in between. `None` on requests made before
    /// the base version was recorded.
    pub base_version: Option<i64>,
    pub decided_by: Option<String>,
    pub decided_at: Option<i64>,
    pub reason: Option<String>,
}

/// Create the change-request table. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_change_requests (
             id                 TEXT PRIMARY KEY,
             status             TEXT NOT NULL,
             operation          TEXT NOT NULL,
             coords             TEXT NOT NULL,
             patch              TEXT NOT NULL DEFAULT '{}',
             nonce              BLOB,
             ciphertext         BLOB,
             key_version        INTEGER NOT NULL DEFAULT 0,
             requested_by       TEXT NOT NULL,
             requested_at       INTEGER NOT NULL,
             approvals          TEXT NOT NULL DEFAULT '[]',
             required_approvals INTEGER NOT NULL DEFAULT 1,
             decided_by         TEXT,
             decided_at         INTEGER,
             reason             TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_vault_change_requests_status
             ON vault_change_requests(status, requested_at DESC);",
    )
    .context("initializing vault change-request schema")?;
    // NULL on requests made before the requester's authority was recorded;
    // approval rejects those because it cannot re-check them.
    super::ensure_columns(
        conn,
        "vault_change_requests",
        &[
            ("requester_subjects", "TEXT"),
            ("requester_baseline", "TEXT"),
            ("base_version", "INTEGER"),
            // The rest of the state approval pins: changes that keep the
            // value version (a metadata-only write, a delete or a restore).
            ("base_metadata_version", "INTEGER"),
            ("base_deleted", "INTEGER"),
        ],
    )
}

const COLUMNS: &str = "id, status, operation, coords, patch, nonce IS NOT NULL, requested_by,
    requested_at, approvals, required_approvals, decided_by, decided_at, reason, base_version";

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChangeRequest> {
    let coords: String = row.get(3)?;
    let patch: String = row.get(4)?;
    let approvals: String = row.get(8)?;
    let operation: String = row.get(2)?;
    Ok(ChangeRequest {
        id: row.get(0)?,
        status: ChangeStatus::parse(&row.get::<_, String>(1)?),
        operation: if operation == "delete" {
            ChangeOperation::Delete
        } else {
            ChangeOperation::Write
        },
        coords: serde_json::from_str(&coords).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        has_value: row.get(5)?,
        patch: serde_json::from_str(&patch).unwrap_or(Value::Null),
        requested_by: row.get(6)?,
        requested_at: row.get(7)?,
        expires_at: row.get::<_, i64>(7)?.saturating_add(CHANGE_REQUEST_TTL_MS),
        approvals: serde_json::from_str(&approvals).unwrap_or_default(),
        required_approvals: row.get::<_, i64>(9)?.clamp(1, 5) as u8,
        decided_by: row.get(10)?,
        decided_at: row.get(11)?,
        reason: row.get(12)?,
        base_version: row.get(13)?,
    })
}

fn load(conn: &Connection, id: &str) -> Result<ChangeRequest> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM vault_change_requests WHERE id = ?1"),
        params![id],
        from_row,
    )
    .optional()?
    .ok_or_else(|| VaultError::NotFound(format!("change request {id}")).into())
}

/// Whether the requester still holds the capability `request` needs, under
/// the policy bindings in force now. Fails closed: a request without a
/// recorded authority (made by an earlier release) is not authorized.
fn requester_still_authorized(conn: &Connection, request: &ChangeRequest) -> Result<bool> {
    let recorded: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT requester_subjects, requester_baseline FROM vault_change_requests
             WHERE id = ?1",
            params![request.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((Some(subjects), Some(baseline))) = recorded else {
        return Ok(false);
    };
    let (Ok(subjects), Ok(baseline)) = (
        serde_json::from_str::<Vec<String>>(&subjects),
        serde_json::from_str::<CapabilitySet>(&baseline),
    ) else {
        return Ok(false);
    };
    let policies = super::policy::policies_for(conn, &subjects)?;
    let capabilities = super::policy::evaluate_with(
        &baseline,
        &policies,
        &request.coords.policy_key(),
        &TemplateContext::from_subjects(&subjects),
    );
    let needed = match request.operation {
        ChangeOperation::Write => Capability::Write,
        ChangeOperation::Delete => Capability::Delete,
    };
    Ok(capabilities.contains(&needed))
}

/// The secret state a change request is pinned to: every field a change made
/// in between would move (a value write bumps `version`, a metadata-only
/// write bumps `metadata_version`, a delete or restore flips `deleted`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BaseState {
    version: i64,
    metadata_version: i64,
    deleted: bool,
}

impl BaseState {
    /// The state of `info`, or of a secret that does not exist yet.
    fn of(info: Option<&VaultSecretInfo>) -> Self {
        info.map_or(
            Self {
                version: 0,
                metadata_version: 0,
                deleted: false,
            },
            |info| Self {
                version: info.version,
                metadata_version: info.metadata_version,
                deleted: info.deleted_at.is_some(),
            },
        )
    }

    /// The conflict a direct write would raise for `expected` against this
    /// state (see `write_secret_with`).
    fn conflict_with_expected(self, expected: ChangeBase) -> Option<anyhow::Error> {
        if let Some(version) = expected.version.filter(|version| *version != self.version) {
            let message = if self.version == 0 {
                "the secret no longer exists".to_owned()
            } else {
                format!("the secret is at version {}, not {version}", self.version)
            };
            return Some(VaultError::Conflict(message).into());
        }
        expected
            .metadata_version
            .filter(|version| *version != self.metadata_version)
            .map(|version| {
                anyhow::Error::from(VaultError::Conflict(format!(
                    "the secret metadata is at version {}, not {version}",
                    self.metadata_version
                )))
            })
    }
}

pub(crate) fn subject_of(actor: &AuditActor) -> String {
    match &actor.id {
        Some(id) => format!("{}:{id}", actor.kind),
        None => actor.kind.clone(),
    }
}

impl PluginSecretStore {
    /// Record a pending change. `patch` is the raw metadata patch JSON.
    pub async fn create_change_request(
        &self,
        coords: SecretCoords,
        operation: ChangeOperation,
        value: Option<&str>,
        patch: Value,
        required_approvals: u8,
        actor: &AuditActor,
        authority: &RequesterAuthority,
    ) -> Result<ChangeRequest> {
        self.create_change_request_from(
            ChangeBase::default(),
            coords,
            operation,
            value,
            patch,
            required_approvals,
            actor,
            authority,
        )
        .await
    }

    /// [`Self::create_change_request`] against the state the caller edited
    /// from: a stale `expected` is refused with a conflict now, instead of
    /// pinning the request to a version the caller never saw.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_change_request_from(
        &self,
        expected: ChangeBase,
        coords: SecretCoords,
        operation: ChangeOperation,
        value: Option<&str>,
        patch: Value,
        required_approvals: u8,
        actor: &AuditActor,
        authority: &RequesterAuthority,
    ) -> Result<ChangeRequest> {
        let coords = coords.normalize()?;
        // Validate the patch now so an approver never applies a bad request.
        serde_json::from_value::<SecretMetadataPatch>(patch.clone())
            .map_err(|error| VaultError::Invalid(format!("invalid metadata: {error}")))?;
        if operation == ChangeOperation::Write && value.is_none() && patch == json!({}) {
            bail!("a write change request needs a value or metadata");
        }
        let sealed = value
            .map(|value| self.seal_row(value.as_bytes()))
            .transpose()?;
        let id = format!("vcr_{}", uuid::Uuid::new_v4().simple());
        // Pin the state this request is reviewed against; approval refuses
        // to apply it over a later change.
        let base = BaseState::of(self.secret_info(&coords).await?.as_ref());
        if let Some(conflict) = base.conflict_with_expected(expected) {
            return Err(conflict);
        }
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO vault_change_requests
                (id, status, operation, coords, patch, nonce, ciphertext, key_version,
                 requested_by, requested_at, required_approvals, requester_subjects,
                 requester_baseline, base_version, base_metadata_version, base_deleted)
             VALUES (?1, 'pending', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                     ?14, ?15)",
            params![
                id,
                match operation {
                    ChangeOperation::Write => "write",
                    ChangeOperation::Delete => "delete",
                },
                serde_json::to_string(&coords)?,
                patch.to_string(),
                sealed.as_ref().map(|(_, nonce, _)| nonce.clone()),
                sealed.as_ref().map(|(_, _, ciphertext)| ciphertext.clone()),
                sealed.as_ref().map(|(version, _, _)| *version).unwrap_or(0),
                subject_of(actor),
                now_millis(),
                required_approvals.clamp(1, 5) as i64,
                serde_json::to_string(&authority.subjects)?,
                serde_json::to_string(&authority.baseline)?,
                base.version,
                base.metadata_version,
                base.deleted,
            ],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "change.request", "ok")
                .secret(
                    coords.scope.as_str(),
                    &coords.scope_id,
                    &coords.environment,
                    &coords.path,
                    &coords.name,
                )
                .details(json!({ "id": id, "operation": operation })),
        );
        load(&conn, &id)
    }

    /// List change requests, newest first, optionally by status.
    pub async fn list_change_requests(
        &self,
        status: Option<ChangeStatus>,
    ) -> Result<Vec<ChangeRequest>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM vault_change_requests
             WHERE (?1 IS NULL OR status = ?1)
             ORDER BY requested_at DESC LIMIT 500"
        ))?;
        let rows = stmt.query_map(params![status.map(ChangeStatus::as_str)], from_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub async fn change_request(&self, id: &str) -> Result<ChangeRequest> {
        let conn = self.conn.lock().await;
        load(&conn, id)
    }

    /// Approve a pending request; applies it once enough approvals exist.
    ///
    /// `current_required` is the environment's `requiredApprovals` now (`None`
    /// when it is no longer protected); the larger of it and the request's
    /// snapshot applies. An expired request is rejected, never applied.
    pub async fn approve_change_request(
        &self,
        id: &str,
        actor: &AuditActor,
        current_required: Option<u8>,
    ) -> Result<ChangeRequest> {
        let approver = subject_of(actor);
        let (request, ready, value) = {
            let conn = self.conn.lock().await;
            let mut request = load(&conn, id)?;
            if request.status != ChangeStatus::Pending {
                return Err(VaultError::Conflict(format!(
                    "change request is {}",
                    request.status.as_str()
                ))
                .into());
            }
            if request.requested_by == approver {
                return Err(VaultError::Denied(
                    "requesters cannot approve their own change".into(),
                )
                .into());
            }
            if request
                .approvals
                .iter()
                .any(|approval| approval.by == approver)
            {
                return Err(
                    VaultError::Conflict("already approved by this principal".into()).into(),
                );
            }
            if now_millis() >= request.expires_at {
                self.reject_stale_locked(&conn, &request, actor, &approver, "expired")?;
                return Err(VaultError::Conflict(
                    "change request expired; it was rejected and must be requested again".into(),
                )
                .into());
            }
            if !requester_still_authorized(&conn, &request)? {
                self.reject_stale_locked(
                    &conn,
                    &request,
                    actor,
                    &approver,
                    REQUESTER_NO_LONGER_AUTHORIZED,
                )?;
                return Err(VaultError::Conflict(
                    "the requester no longer holds the access this change needs; it was rejected"
                        .into(),
                )
                .into());
            }
            let required = request
                .required_approvals
                .max(current_required.unwrap_or(0).min(5));
            request.approvals.push(Approval {
                by: approver.clone(),
                at: now_millis(),
            });
            let ready = request.approvals.len() >= required as usize;
            if ready {
                // Claim the request under the same lock as the threshold
                // approval, so a later approver sees it as no longer pending
                // and the change can never be applied twice.
                conn.execute(
                    "UPDATE vault_change_requests SET approvals = ?1, status = 'applied',
                         decided_by = ?2, decided_at = ?3
                     WHERE id = ?4",
                    params![
                        serde_json::to_string(&request.approvals)?,
                        approver,
                        now_millis(),
                        id
                    ],
                )?;
            } else {
                conn.execute(
                    "UPDATE vault_change_requests SET approvals = ?1 WHERE id = ?2",
                    params![serde_json::to_string(&request.approvals)?, id],
                )?;
            }
            self.audit_locked(
                &conn,
                &AuditEntry::new(actor, "change.approve", "ok")
                    .secret(
                        request.coords.scope.as_str(),
                        &request.coords.scope_id,
                        &request.coords.environment,
                        &request.coords.path,
                        &request.coords.name,
                    )
                    .details(json!({ "id": id })),
            );
            let value = if ready {
                let sealed: Option<(Option<Vec<u8>>, Option<Vec<u8>>, u32)> = conn
                    .query_row(
                        "SELECT nonce, ciphertext, key_version FROM vault_change_requests WHERE id = ?1",
                        params![id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()?;
                match sealed {
                    Some((Some(nonce), Some(ciphertext), key_version)) => Some(
                        String::from_utf8(self.open_row(key_version, &nonce, &ciphertext)?)
                            .context("proposed value is not UTF-8")?,
                    ),
                    _ => None,
                }
            } else {
                None
            };
            (request, ready, value)
        };
        if !ready {
            return Ok(request);
        }
        // Errors here (including a conflict) release the claim below.
        let base_conflict = self.base_version_conflict(&request).await;
        let applied: Result<()> = match (request.operation, base_conflict) {
            (_, Err(error)) | (_, Ok(Some(error))) => Err(error),
            (ChangeOperation::Write, Ok(None)) => {
                match serde_json::from_value::<SecretMetadataPatch>(request.patch.clone()) {
                    Ok(patch) => self
                        .write_secret(WriteRequest {
                            coords: request.coords.clone(),
                            value: value.as_deref(),
                            patch,
                            actor,
                            source: VersionSource::Approval,
                            expected_version: request.base_version,
                        })
                        .await
                        .map(|_| ()),
                    Err(error) => Err(error.into()),
                }
            }
            (ChangeOperation::Delete, Ok(None)) => self
                .soft_delete(request.coords.clone(), actor)
                .await
                .map(|_| ()),
        };
        let conn = self.conn.lock().await;
        if let Err(error) = applied {
            // Release the claim and drop this approval, so the request can be
            // approved again or rejected; the proposed value is still sealed.
            let previous = &request.approvals[..request.approvals.len() - 1];
            conn.execute(
                "UPDATE vault_change_requests SET status = 'pending', decided_by = NULL,
                     decided_at = NULL, approvals = ?1
                 WHERE id = ?2",
                params![serde_json::to_string(previous)?, id],
            )?;
            self.audit_locked(
                &conn,
                &AuditEntry::new(actor, "change.apply", "error")
                    .secret(
                        request.coords.scope.as_str(),
                        &request.coords.scope_id,
                        &request.coords.environment,
                        &request.coords.path,
                        &request.coords.name,
                    )
                    .details(json!({ "id": id, "error": error.to_string() })),
            );
            return Err(error);
        }
        conn.execute(
            "UPDATE vault_change_requests SET nonce = NULL, ciphertext = NULL WHERE id = ?1",
            params![id],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "change.apply", "ok")
                .secret(
                    request.coords.scope.as_str(),
                    &request.coords.scope_id,
                    &request.coords.environment,
                    &request.coords.path,
                    &request.coords.name,
                )
                .details(json!({ "id": id })),
        );
        load(&conn, id)
    }

    /// A conflict when the secret has changed since `request` was made: a
    /// new value version, a metadata-only write, a delete or a restore.
    /// `write_secret` re-checks the value version atomically through
    /// `expected_version`. Requests made before the base metadata version and
    /// deleted state were recorded are checked on the value version only.
    async fn base_version_conflict(
        &self,
        request: &ChangeRequest,
    ) -> Result<Option<anyhow::Error>> {
        let Some(base) = request.base_version else {
            return Ok(None);
        };
        // The lock guard is a temporary, released at the end of the statement.
        let pinned: Option<(Option<i64>, Option<bool>)> = self
            .conn
            .lock()
            .await
            .query_row(
                "SELECT base_metadata_version, base_deleted FROM vault_change_requests
                 WHERE id = ?1",
                params![request.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (base_metadata_version, base_deleted) = pinned.unwrap_or((None, None));
        let current = BaseState::of(self.secret_info(&request.coords).await?.as_ref());
        let message = if current.version != base {
            format!("the secret is at version {}, not {base}", current.version)
        } else if base_metadata_version.is_some_and(|pinned| pinned != current.metadata_version) {
            "the secret metadata changed after this request was made".to_owned()
        } else if base_deleted.is_some_and(|pinned| pinned != current.deleted) {
            if current.deleted {
                "the secret was deleted after this request was made".to_owned()
            } else {
                "the secret was restored after this request was made".to_owned()
            }
        } else {
            return Ok(None);
        };
        Ok(Some(VaultError::Conflict(message).into()))
    }

    /// Close a pending request that can no longer be applied, dropping its
    /// sealed proposal. The caller holds the connection lock.
    fn reject_stale_locked(
        &self,
        conn: &Connection,
        request: &ChangeRequest,
        actor: &AuditActor,
        approver: &str,
        reason: &str,
    ) -> Result<()> {
        conn.execute(
            "UPDATE vault_change_requests SET status = 'rejected', decided_by = ?1,
                 decided_at = ?2, reason = ?3, nonce = NULL, ciphertext = NULL
             WHERE id = ?4 AND status = 'pending'",
            params![approver, now_millis(), reason, request.id],
        )?;
        self.audit_locked(
            conn,
            &AuditEntry::new(actor, "change.reject", "ok")
                .secret(
                    request.coords.scope.as_str(),
                    &request.coords.scope_id,
                    &request.coords.environment,
                    &request.coords.path,
                    &request.coords.name,
                )
                .details(json!({ "id": request.id, "reason": reason })),
        );
        Ok(())
    }

    /// Reject (by an approver) or cancel (by the requester) a pending request.
    pub async fn close_change_request(
        &self,
        id: &str,
        actor: &AuditActor,
        reason: Option<&str>,
        cancel: bool,
    ) -> Result<ChangeRequest> {
        let subject = subject_of(actor);
        let conn = self.conn.lock().await;
        let request = load(&conn, id)?;
        if request.status != ChangeStatus::Pending {
            return Err(VaultError::Conflict("change request is not pending".into()).into());
        }
        if cancel && request.requested_by != subject {
            return Err(VaultError::Denied("only the requester can cancel".into()).into());
        }
        let status = if cancel {
            ChangeStatus::Canceled
        } else {
            ChangeStatus::Rejected
        };
        conn.execute(
            "UPDATE vault_change_requests SET status = ?1, decided_by = ?2, decided_at = ?3,
                 reason = ?4, nonce = NULL, ciphertext = NULL
             WHERE id = ?5",
            params![
                status.as_str(),
                subject,
                now_millis(),
                reason.map(|r| r.chars().take(512).collect::<String>()),
                id
            ],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(
                actor,
                if cancel {
                    "change.cancel"
                } else {
                    "change.reject"
                },
                "ok",
            )
            .secret(
                request.coords.scope.as_str(),
                &request.coords.scope_id,
                &request.coords.environment,
                &request.coords.path,
                &request.coords.name,
            )
            .details(json!({ "id": id })),
        );
        load(&conn, id).map_err(|error| anyhow!(error))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_secrets::{SecretResolutionContext, SecretScope};

    fn coords() -> SecretCoords {
        SecretCoords {
            scope: SecretScope::Node,
            scope_id: "node-1".into(),
            environment: "prod".into(),
            path: "/".into(),
            binding: None,
            name: "API_KEY".into(),
        }
    }

    /// A requester whose own baseline grants the change (a personal value).
    fn authority() -> RequesterAuthority {
        RequesterAuthority {
            subjects: vec!["user:dev".into(), "role:member".into()],
            baseline: [Capability::Write, Capability::Delete]
                .into_iter()
                .collect(),
        }
    }

    #[tokio::test]
    async fn requests_apply_after_enough_distinct_approvals() {
        let store = PluginSecretStore::in_memory().unwrap();
        let requester = AuditActor::new("user", Some("dev"));
        let request = store
            .create_change_request(
                coords(),
                ChangeOperation::Write,
                Some("new"),
                json!({}),
                2,
                &requester,
                &authority(),
            )
            .await
            .unwrap();
        assert!(request.has_value);
        assert!(store
            .approve_change_request(&request.id, &requester, None)
            .await
            .is_err());
        let first = AuditActor::new("user", Some("lead"));
        let pending = store
            .approve_change_request(&request.id, &first, None)
            .await
            .unwrap();
        assert_eq!(pending.status, ChangeStatus::Pending);
        assert!(store
            .approve_change_request(&request.id, &first, None)
            .await
            .is_err());
        let applied = store
            .approve_change_request(&request.id, &AuditActor::new("user", Some("cto")), None)
            .await
            .unwrap();
        assert_eq!(applied.status, ChangeStatus::Applied);
        assert!(
            !applied.has_value,
            "the sealed proposal is cleared once applied"
        );
        let context = SecretResolutionContext::node_only("node-1", Vec::new());
        assert_eq!(
            store
                .resolve_vault_secret("prod:API_KEY", &context)
                .await
                .unwrap()
                .as_deref(),
            Some("new")
        );
    }

    #[tokio::test]
    async fn only_the_requester_can_cancel_and_closed_requests_are_final() {
        let store = PluginSecretStore::in_memory().unwrap();
        let requester = AuditActor::new("user", Some("dev"));
        let request = store
            .create_change_request(
                coords(),
                ChangeOperation::Delete,
                None,
                json!({}),
                1,
                &requester,
                &authority(),
            )
            .await
            .unwrap();
        let other = AuditActor::new("user", Some("lead"));
        assert!(store
            .close_change_request(&request.id, &other, None, true)
            .await
            .is_err());
        let rejected = store
            .close_change_request(&request.id, &other, Some("not now"), false)
            .await
            .unwrap();
        assert_eq!(rejected.status, ChangeStatus::Rejected);
        assert!(store
            .approve_change_request(&request.id, &other, None)
            .await
            .is_err());
        assert_eq!(
            store
                .list_change_requests(Some(ChangeStatus::Rejected))
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn expired_requests_are_rejected_instead_of_applied() {
        let store = PluginSecretStore::in_memory().unwrap();
        let requester = AuditActor::new("user", Some("dev"));
        let request = store
            .create_change_request(
                coords(),
                ChangeOperation::Write,
                Some("stale"),
                json!({}),
                1,
                &requester,
                &authority(),
            )
            .await
            .unwrap();
        assert_eq!(
            request.expires_at,
            request.requested_at + CHANGE_REQUEST_TTL_MS
        );
        store
            .conn
            .lock()
            .await
            .execute(
                "UPDATE vault_change_requests SET requested_at = ?1 WHERE id = ?2",
                params![now_millis() - CHANGE_REQUEST_TTL_MS - 1, request.id],
            )
            .unwrap();
        let lead = AuditActor::new("user", Some("lead"));
        let error = store
            .approve_change_request(&request.id, &lead, Some(1))
            .await
            .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<VaultError>(),
            Some(VaultError::Conflict(_))
        ));
        let closed = store.change_request(&request.id).await.unwrap();
        assert_eq!(closed.status, ChangeStatus::Rejected);
        assert_eq!(closed.reason.as_deref(), Some("expired"));
        assert!(!closed.has_value, "the sealed proposal is dropped");
        let context = SecretResolutionContext::node_only("node-1", Vec::new());
        assert_eq!(
            store
                .resolve_vault_secret("prod:API_KEY", &context)
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn a_raised_environment_threshold_covers_pending_requests() {
        let store = PluginSecretStore::in_memory().unwrap();
        let requester = AuditActor::new("user", Some("dev"));
        let request = store
            .create_change_request(
                coords(),
                ChangeOperation::Write,
                Some("new"),
                json!({}),
                1,
                &requester,
                &authority(),
            )
            .await
            .unwrap();
        let pending = store
            .approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(2))
            .await
            .unwrap();
        assert_eq!(pending.status, ChangeStatus::Pending);
        let applied = store
            .approve_change_request(&request.id, &AuditActor::new("user", Some("cto")), Some(2))
            .await
            .unwrap();
        assert_eq!(applied.status, ChangeStatus::Applied);
    }

    /// A requester whose `write` came from a temporary policy binding.
    async fn request_through_binding(
        store: &PluginSecretStore,
        expires_at: Option<i64>,
    ) -> (ChangeRequest, String) {
        let binding = {
            let conn = store.conn.lock().await;
            super::super::policy::put_policy(
                &conn,
                &super::super::policy::Policy {
                    name: "prod-writers".into(),
                    description: String::new(),
                    rules: vec![super::super::policy::PolicyRule {
                        path: "prod/**".into(),
                        capabilities: vec![Capability::Write],
                        ..Default::default()
                    }],
                },
            )
            .unwrap();
            super::super::policy::bind(&conn, "prod-writers", "user:dev", expires_at, None).unwrap()
        };
        let request = store
            .create_change_request(
                coords(),
                ChangeOperation::Write,
                Some("new"),
                json!({}),
                1,
                &AuditActor::new("user", Some("dev")),
                &RequesterAuthority {
                    subjects: vec!["user:dev".into(), "role:member".into()],
                    baseline: [Capability::List, Capability::Use].into_iter().collect(),
                },
            )
            .await
            .unwrap();
        (request, binding.id)
    }

    async fn assert_rejected_unapplied(store: &PluginSecretStore, id: &str, reason: &str) {
        let closed = store.change_request(id).await.unwrap();
        assert_eq!(closed.status, ChangeStatus::Rejected);
        assert_eq!(closed.reason.as_deref(), Some(reason));
        assert!(!closed.has_value, "the sealed proposal is dropped");
        let context = SecretResolutionContext::node_only("node-1", Vec::new());
        assert_eq!(
            store
                .resolve_vault_secret("prod:API_KEY", &context)
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn a_requester_whose_binding_expired_is_not_applied() {
        let store = PluginSecretStore::in_memory().unwrap();
        let (request, binding) = request_through_binding(&store, Some(now_millis() + 60_000)).await;
        store
            .conn
            .lock()
            .await
            .execute(
                "UPDATE vault_policy_bindings SET expires_at = 1 WHERE id = ?1",
                params![binding],
            )
            .unwrap();
        let error = store
            .approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(1))
            .await
            .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<VaultError>(),
            Some(VaultError::Conflict(_))
        ));
        assert_rejected_unapplied(&store, &request.id, REQUESTER_NO_LONGER_AUTHORIZED).await;
    }

    #[tokio::test]
    async fn a_requester_who_was_unbound_is_not_applied() {
        let store = PluginSecretStore::in_memory().unwrap();
        let (request, binding) = request_through_binding(&store, None).await;
        assert!(super::super::policy::unbind(&*store.conn.lock().await, &binding).unwrap());
        assert!(store
            .approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(1))
            .await
            .is_err());
        assert_rejected_unapplied(&store, &request.id, REQUESTER_NO_LONGER_AUTHORIZED).await;
    }

    #[tokio::test]
    async fn a_requester_who_still_holds_the_binding_is_applied() {
        let store = PluginSecretStore::in_memory().unwrap();
        let (request, _) = request_through_binding(&store, Some(now_millis() + 60_000)).await;
        let applied = store
            .approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(1))
            .await
            .unwrap();
        assert_eq!(applied.status, ChangeStatus::Applied);
    }

    #[tokio::test]
    async fn a_request_without_a_recorded_authority_fails_closed() {
        let store = PluginSecretStore::in_memory().unwrap();
        let request = store
            .create_change_request(
                coords(),
                ChangeOperation::Delete,
                None,
                json!({}),
                1,
                &AuditActor::new("user", Some("dev")),
                &authority(),
            )
            .await
            .unwrap();
        store
            .conn
            .lock()
            .await
            .execute(
                "UPDATE vault_change_requests
                 SET requester_subjects = NULL, requester_baseline = NULL WHERE id = ?1",
                params![request.id],
            )
            .unwrap();
        assert!(store
            .approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(1))
            .await
            .is_err());
        assert_rejected_unapplied(&store, &request.id, REQUESTER_NO_LONGER_AUTHORIZED).await;
    }

    async fn write_direct(store: &PluginSecretStore, value: &str) -> i64 {
        store
            .write_secret(WriteRequest {
                coords: coords(),
                value: Some(value),
                patch: SecretMetadataPatch::default(),
                actor: &AuditActor::new("user", Some("admin")),
                source: VersionSource::Write,
                expected_version: None,
            })
            .await
            .unwrap()
            .version
    }

    async fn current_value(store: &PluginSecretStore) -> Option<String> {
        let context = SecretResolutionContext::node_only("node-1", Vec::new());
        store
            .resolve_vault_secret("prod:API_KEY", &context)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn approval_does_not_overwrite_a_change_made_after_the_request() {
        let store = PluginSecretStore::in_memory().unwrap();
        let base = write_direct(&store, "v1").await;
        let request = store
            .create_change_request(
                coords(),
                ChangeOperation::Write,
                Some("proposed"),
                json!({}),
                1,
                &AuditActor::new("user", Some("dev")),
                &authority(),
            )
            .await
            .unwrap();
        assert_eq!(request.base_version, Some(base));
        // An urgent rotation lands while the request waits.
        write_direct(&store, "rotated").await;
        let error = store
            .approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(1))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("version"), "{error}");
        assert_eq!(current_value(&store).await.as_deref(), Some("rotated"));
        let reverted = store.change_request(&request.id).await.unwrap();
        assert_eq!(reverted.status, ChangeStatus::Pending);
        assert!(reverted.approvals.is_empty());
        assert!(reverted.has_value);
    }

    #[tokio::test]
    async fn approval_applies_while_the_secret_is_still_at_the_base_version() {
        let store = PluginSecretStore::in_memory().unwrap();
        write_direct(&store, "v1").await;
        let request = store
            .create_change_request(
                coords(),
                ChangeOperation::Write,
                Some("proposed"),
                json!({}),
                1,
                &AuditActor::new("user", Some("dev")),
                &authority(),
            )
            .await
            .unwrap();
        let applied = store
            .approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(1))
            .await
            .unwrap();
        assert_eq!(applied.status, ChangeStatus::Applied);
        assert_eq!(current_value(&store).await.as_deref(), Some("proposed"));
    }

    #[tokio::test]
    async fn a_delete_approval_does_not_remove_a_value_rotated_after_the_request() {
        let store = PluginSecretStore::in_memory().unwrap();
        write_direct(&store, "v1").await;
        let request = store
            .create_change_request(
                coords(),
                ChangeOperation::Delete,
                None,
                json!({}),
                1,
                &AuditActor::new("user", Some("dev")),
                &authority(),
            )
            .await
            .unwrap();
        write_direct(&store, "rotated").await;
        assert!(store
            .approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(1))
            .await
            .is_err());
        assert_eq!(current_value(&store).await.as_deref(), Some("rotated"));
        assert_eq!(
            store.change_request(&request.id).await.unwrap().status,
            ChangeStatus::Pending
        );
    }

    fn is_conflict(error: &anyhow::Error) -> bool {
        matches!(
            error.downcast_ref::<VaultError>(),
            Some(VaultError::Conflict(_))
        )
    }

    async fn request_write(
        store: &PluginSecretStore,
        expected: ChangeBase,
    ) -> Result<ChangeRequest> {
        store
            .create_change_request_from(
                expected,
                coords(),
                ChangeOperation::Write,
                Some("proposed"),
                json!({}),
                1,
                &AuditActor::new("user", Some("dev")),
                &authority(),
            )
            .await
    }

    #[tokio::test]
    async fn a_stale_expected_version_is_refused_when_the_request_is_made() {
        let store = PluginSecretStore::in_memory().unwrap();
        let seen = write_direct(&store, "v1").await;
        // An admin rotates the value after the requester loaded it.
        let rotated = write_direct(&store, "rotated").await;
        let stale = ChangeBase {
            version: Some(seen),
            metadata_version: None,
        };
        let error = request_write(&store, stale).await.unwrap_err();
        assert!(is_conflict(&error), "{error}");
        assert!(store.list_change_requests(None).await.unwrap().is_empty());

        let current = ChangeBase {
            version: Some(rotated),
            metadata_version: None,
        };
        let request = request_write(&store, current).await.unwrap();
        assert_eq!(request.base_version, Some(rotated));
    }

    #[tokio::test]
    async fn a_stale_expected_metadata_version_is_refused_when_the_request_is_made() {
        let store = PluginSecretStore::in_memory().unwrap();
        write_direct(&store, "v1").await;
        let seen = store
            .secret_info(&coords())
            .await
            .unwrap()
            .unwrap()
            .metadata_version;
        let stale = ChangeBase {
            version: None,
            metadata_version: Some(seen + 1),
        };
        assert!(is_conflict(
            &request_write(&store, stale).await.unwrap_err()
        ));
        let current = ChangeBase {
            version: None,
            metadata_version: Some(seen),
        };
        assert!(request_write(&store, current).await.is_ok());
    }

    #[tokio::test]
    async fn a_write_approval_does_not_bring_back_a_value_deleted_after_the_request() {
        let store = PluginSecretStore::in_memory().unwrap();
        write_direct(&store, "v1").await;
        let request = request_write(&store, ChangeBase::default()).await.unwrap();
        // Deleted during an incident: the value version stays the same.
        assert!(store
            .soft_delete(coords(), &AuditActor::new("user", Some("admin")))
            .await
            .unwrap());
        let error = store
            .approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(1))
            .await
            .unwrap_err();
        assert!(is_conflict(&error), "{error}");
        let info = store.secret_info(&coords()).await.unwrap().unwrap();
        assert!(info.deleted_at.is_some());
        assert_eq!(info.version, request.base_version.unwrap());
        assert_eq!(
            store.change_request(&request.id).await.unwrap().status,
            ChangeStatus::Pending
        );
    }

    #[tokio::test]
    async fn a_write_approval_does_not_overwrite_a_metadata_only_change() {
        let store = PluginSecretStore::in_memory().unwrap();
        write_direct(&store, "v1").await;
        let request = store
            .create_change_request(
                coords(),
                ChangeOperation::Write,
                None,
                json!({ "description": "requested" }),
                1,
                &AuditActor::new("user", Some("dev")),
                &authority(),
            )
            .await
            .unwrap();
        store
            .write_secret(WriteRequest {
                coords: coords(),
                value: None,
                patch: SecretMetadataPatch {
                    description: Some("admin".into()),
                    ..SecretMetadataPatch::default()
                },
                actor: &AuditActor::new("user", Some("admin")),
                source: VersionSource::Write,
                expected_version: None,
            })
            .await
            .unwrap();
        let error = store
            .approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(1))
            .await
            .unwrap_err();
        assert!(is_conflict(&error), "{error}");
        let info = store.secret_info(&coords()).await.unwrap().unwrap();
        assert_eq!(info.metadata.description, "admin");
    }

    #[tokio::test]
    async fn a_write_approval_does_not_overwrite_a_value_restored_after_the_request() {
        let store = PluginSecretStore::in_memory().unwrap();
        write_direct(&store, "v1").await;
        let admin = AuditActor::new("user", Some("admin"));
        store.soft_delete(coords(), &admin).await.unwrap();
        let request = request_write(&store, ChangeBase::default()).await.unwrap();
        store.restore(coords(), &admin).await.unwrap();
        let error = store
            .approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(1))
            .await
            .unwrap_err();
        assert!(is_conflict(&error), "{error}");
        assert_eq!(current_value(&store).await.as_deref(), Some("v1"));
    }
}
