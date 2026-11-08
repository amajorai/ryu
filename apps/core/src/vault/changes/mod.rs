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

mod authority;
mod store;

use authority::requester_still_authorized;

#[cfg(test)]
mod tests;
