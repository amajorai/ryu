//! Agent proposals: an agent that hits an unbrokered host (or lacks a
//! credential) asks for a service and/or credentials, with instructions for
//! obtaining them. A human with `admin` on `sys/broker` approves (optionally
//! supplying the values) or rejects. Pending proposals expire after
//! [`EXPIRY_MILLIS`] and are capped per environment and per accountable
//! principal.
//!
//! A **credential-use** proposal ([`CredentialUse`]) is the approval request
//! for the first use of a password-manager reference by one consumer (see
//! [`crate::vault::password_managers`]). It carries no services or
//! credentials; approving it records a grant instead.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::services::ServiceInput;
use super::substitute;
use crate::vault::{now_millis, random_token, VaultError};

/// Items per proposal, per kind.
pub const MAX_ITEMS: usize = 10;
/// Pending proposals per environment.
pub const MAX_PENDING_PER_ENVIRONMENT: i64 = 20;
/// Pending proposals per accountable principal (a machine identity, or the
/// minter of the broker session that filed it), so one agent cannot fill an
/// environment's queue.
pub const MAX_PENDING_PER_REQUESTER: i64 = 3;
/// Pending lifetime (7 days).
pub const EXPIRY_MILLIS: i64 = 7 * 24 * 3600 * 1000;
const MAX_MESSAGE_LEN: usize = 4096;
const MAX_TEXT_LEN: usize = 2048;

/// A credential the agent asks a human to provide.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRequest {
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub obtain_instructions: String,
}

/// What an agent submits.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalInput {
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub services: Vec<ServiceInput>,
    #[serde(default)]
    pub credentials: Vec<CredentialRequest>,
}

/// Proposal lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalStatus {
    Pending,
    Approved,
    Rejected,
    Expired,
}

impl ProposalStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
            Self::Expired => "expired",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "approved" => Self::Approved,
            "rejected" => Self::Rejected,
            "expired" => Self::Expired,
            _ => Self::Pending,
        }
    }
}

/// The first use of a password-manager reference by one consumer, awaiting a
/// human decision. Never carries a value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialUse {
    /// Account-qualified reference (`op://work@vault/item/field`).
    #[serde(rename = "ref")]
    pub reference: String,
    pub account_id: String,
    /// Account name.
    pub account: String,
    /// `1password-connect`, `1password-service-account`, or `bitwarden-sm`.
    pub provider: String,
    /// The channel-scoped consumer an approval grants:
    /// `broker:<minter>`, `read:<principal>`, or `runtime:<mcp>:<owner>`
    /// (see [`crate::vault::password_managers::broker_subject`]).
    pub subject: String,
}

/// A stored proposal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub environment: String,
    pub status: ProposalStatus,
    pub message: String,
    pub services: Vec<ServiceInput>,
    pub credentials: Vec<CredentialRequest>,
    /// `machine:<id>` or `broker_session:<id>`.
    pub requested_by: String,
    pub created_at: i64,
    pub expires_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<i64>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub note: String,
    /// Set on a password-manager credential-use request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_use: Option<CredentialUse>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    message: String,
    services: Vec<ServiceInput>,
    credentials: Vec<CredentialRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credential_use: Option<CredentialUse>,
}

/// Create the proposals table. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_broker_proposals (
             id           TEXT PRIMARY KEY,
             environment  TEXT NOT NULL,
             status       TEXT NOT NULL,
             record       TEXT NOT NULL,
             requested_by TEXT NOT NULL,
             created_at   INTEGER NOT NULL,
             expires_at   INTEGER NOT NULL,
             decided_by   TEXT,
             decided_at   INTEGER,
             note         TEXT NOT NULL DEFAULT '',
             accountable  TEXT
         );",
    )
    .context("initializing broker proposals schema")?;
    let has_accountable = conn
        .prepare(
            "SELECT 1 FROM pragma_table_info('vault_broker_proposals') WHERE name = 'accountable'",
        )?
        .exists([])?;
    if !has_accountable {
        conn.execute_batch("ALTER TABLE vault_broker_proposals ADD COLUMN accountable TEXT;")
            .context("adding broker proposal accountable")?;
    }
    Ok(())
}

fn invalid(message: impl Into<String>) -> anyhow::Error {
    VaultError::Invalid(message.into()).into()
}

fn validate(input: ProposalInput, environment: &str) -> Result<Record> {
    if input.services.is_empty() && input.credentials.is_empty() {
        return Err(invalid(
            "a proposal needs at least one service or credential",
        ));
    }
    if input.services.len() > MAX_ITEMS || input.credentials.len() > MAX_ITEMS {
        return Err(invalid(format!(
            "at most {MAX_ITEMS} services and {MAX_ITEMS} credentials"
        )));
    }
    if input.message.len() > MAX_MESSAGE_LEN {
        return Err(invalid("message is too long"));
    }
    let mut services = Vec::with_capacity(input.services.len());
    for mut service in input.services {
        // A proposal targets one environment; the agent cannot aim a service
        // elsewhere.
        service.environment = environment.to_owned();
        services.push(service.normalize()?);
    }
    for credential in &input.credentials {
        substitute::validate_ref(&credential.reference).map_err(|e| invalid(format!("{e:#}")))?;
        if credential.description.len() > MAX_TEXT_LEN
            || credential.obtain_instructions.len() > MAX_TEXT_LEN
        {
            return Err(invalid("credential description or instructions too long"));
        }
    }
    Ok(Record {
        message: input.message,
        services,
        credentials: input.credentials,
        credential_use: None,
    })
}

/// Store a pending proposal. `requested_by` is the filing subject (who may
/// poll it); `accountable` is the principal its pending quota counts against
/// (the machine, or the minter behind a broker session).
pub fn create(
    conn: &Connection,
    input: ProposalInput,
    environment: &str,
    requested_by: &str,
    accountable: &str,
) -> Result<Proposal> {
    let record = validate(input, environment)?;
    insert_pending(conn, &record, environment, requested_by, accountable)
}

/// Store a pending credential-use request (see [`CredentialUse`]), or return
/// the pending one that already exists for the same consumer, account, and
/// reference, so retries do not queue duplicates.
pub fn create_credential_use(
    conn: &Connection,
    credential_use: CredentialUse,
    environment: &str,
    requested_by: &str,
) -> Result<Proposal> {
    if let Some(existing) = pending_credential_use(conn, &credential_use)? {
        return Ok(existing);
    }
    let record = Record {
        message: format!(
            "{} asks to use {} ({} account `{}`)",
            crate::vault::password_managers::describe_subject(&credential_use.subject),
            credential_use.reference,
            credential_use.provider,
            credential_use.account
        ),
        services: Vec::new(),
        credentials: Vec::new(),
        credential_use: Some(credential_use.clone()),
    };
    insert_pending(
        conn,
        &record,
        environment,
        requested_by,
        &credential_use.subject,
    )
}

/// The pending, unexpired request for this consumer, account, and reference.
pub fn pending_credential_use(
    conn: &Connection,
    credential_use: &CredentialUse,
) -> Result<Option<Proposal>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM vault_broker_proposals
         WHERE status = 'pending' AND expires_at > ?1 AND accountable = ?2
         ORDER BY created_at DESC"
    ))?;
    let rows = stmt.query_map(
        params![now_millis(), credential_use.subject],
        row_to_proposal,
    )?;
    for proposal in rows {
        let proposal = proposal?;
        if proposal.credential_use.as_ref().is_some_and(|pending| {
            pending.account_id == credential_use.account_id
                && pending.reference == credential_use.reference
        }) {
            return Ok(Some(proposal));
        }
    }
    Ok(None)
}

fn insert_pending(
    conn: &Connection,
    record: &Record,
    environment: &str,
    requested_by: &str,
    accountable: &str,
) -> Result<Proposal> {
    let now = now_millis();
    let pending: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vault_broker_proposals
         WHERE environment = ?1 AND status = 'pending' AND expires_at > ?2",
        params![environment, now],
        |row| row.get(0),
    )?;
    if pending >= MAX_PENDING_PER_ENVIRONMENT {
        return Err(VaultError::Conflict(format!(
            "at most {MAX_PENDING_PER_ENVIRONMENT} pending proposals per environment"
        ))
        .into());
    }
    let mine: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vault_broker_proposals
         WHERE COALESCE(accountable, requested_by) = ?1 AND status = 'pending'
           AND expires_at > ?2",
        params![accountable, now],
        |row| row.get(0),
    )?;
    if mine >= MAX_PENDING_PER_REQUESTER {
        return Err(VaultError::Conflict(format!(
            "at most {MAX_PENDING_PER_REQUESTER} pending proposals per agent; wait for a decision"
        ))
        .into());
    }
    let id = random_token("bpr_");
    conn.execute(
        "INSERT INTO vault_broker_proposals
            (id, environment, status, record, requested_by, created_at, expires_at, accountable)
         VALUES (?1, ?2, 'pending', ?3, ?4, ?5, ?6, ?7)",
        params![
            id,
            environment,
            serde_json::to_string(record)?,
            requested_by,
            now,
            now + EXPIRY_MILLIS,
            accountable
        ],
    )?;
    get(conn, &id)?.ok_or_else(|| anyhow::anyhow!("proposal did not persist"))
}

const COLUMNS: &str = "id, environment, status, record, requested_by, created_at, expires_at,
                       decided_by, decided_at, note";

fn row_to_proposal(row: &rusqlite::Row<'_>) -> rusqlite::Result<Proposal> {
    let status: String = row.get(2)?;
    let record: String = row.get(3)?;
    let record: Record = serde_json::from_str(&record).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(Proposal {
        id: row.get(0)?,
        environment: row.get(1)?,
        status: ProposalStatus::parse(&status),
        message: record.message,
        services: record.services,
        credentials: record.credentials,
        requested_by: row.get(4)?,
        created_at: row.get(5)?,
        expires_at: row.get(6)?,
        decided_by: row.get(7)?,
        decided_at: row.get(8)?,
        note: row.get(9)?,
        credential_use: record.credential_use,
    })
}

/// One proposal.
pub fn get(conn: &Connection, id: &str) -> Result<Option<Proposal>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM vault_broker_proposals WHERE id = ?1"),
            params![id],
            row_to_proposal,
        )
        .optional()?)
}

/// Proposals, newest first, optionally by status.
pub fn list(conn: &Connection, status: Option<ProposalStatus>) -> Result<Vec<Proposal>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM vault_broker_proposals
         WHERE ?1 IS NULL OR status = ?1 ORDER BY created_at DESC LIMIT 200"
    ))?;
    let rows = stmt.query_map(params![status.map(ProposalStatus::as_str)], row_to_proposal)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// A pending, unexpired proposal or a typed error.
pub fn pending(conn: &Connection, id: &str) -> Result<Proposal> {
    let proposal =
        get(conn, id)?.ok_or_else(|| VaultError::NotFound(format!("proposal `{id}`")))?;
    if proposal.status != ProposalStatus::Pending || proposal.expires_at <= now_millis() {
        return Err(VaultError::Conflict(format!("proposal `{id}` is no longer pending")).into());
    }
    Ok(proposal)
}

/// Mark a pending proposal decided. Returns whether it was still pending.
pub fn decide(
    conn: &Connection,
    id: &str,
    status: ProposalStatus,
    decided_by: &str,
    note: &str,
) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE vault_broker_proposals
         SET status = ?2, decided_by = ?3, decided_at = ?4, note = ?5
         WHERE id = ?1 AND status = 'pending'",
        params![id, status.as_str(), decided_by, now_millis(), note],
    )? > 0)
}

/// Mark pending proposals past their expiry as expired.
pub fn expire(conn: &Connection, now: i64) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE vault_broker_proposals SET status = 'expired'
         WHERE status = 'pending' AND expires_at <= ?1",
        params![now],
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::broker::services::test_service;

    fn input() -> ProposalInput {
        let mut service = test_service("linear", "api.linear.app", None, "/");
        service.environment = "elsewhere".into();
        ProposalInput {
            environment: None,
            message: "I need Linear to file the bug".into(),
            services: vec![service],
            credentials: vec![CredentialRequest {
                reference: "secret:LINEAR_API_KEY".into(),
                description: "Linear personal API key".into(),
                obtain_instructions: "Settings > API > Personal API keys".into(),
            }],
        }
    }

    #[tokio::test]
    async fn proposals_are_pinned_to_their_environment_and_decided_once() {
        let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
        let conn = store.conn.lock().await;
        let proposal = create(&conn, input(), "default", "machine:m1", "machine:m1").unwrap();
        assert_eq!(proposal.status, ProposalStatus::Pending);
        assert_eq!(proposal.services[0].environment, "default");
        assert_eq!(pending(&conn, &proposal.id).unwrap().id, proposal.id);
        assert!(decide(
            &conn,
            &proposal.id,
            ProposalStatus::Rejected,
            "operator:",
            "no"
        )
        .unwrap());
        assert!(!decide(
            &conn,
            &proposal.id,
            ProposalStatus::Approved,
            "operator:",
            ""
        )
        .unwrap());
        assert!(pending(&conn, &proposal.id).is_err());
        assert_eq!(
            list(&conn, Some(ProposalStatus::Rejected)).unwrap().len(),
            1
        );
    }

    #[tokio::test]
    async fn proposals_validate_and_respect_limits() {
        let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
        let conn = store.conn.lock().await;
        let file = |env: &str, who: &str| create(&conn, input(), env, who, who);
        assert!(create(
            &conn,
            ProposalInput::default(),
            "default",
            "machine:m1",
            "machine:m1"
        )
        .is_err());
        let mut bad = input();
        bad.credentials[0].reference = "LINEAR".into();
        assert!(create(&conn, bad, "default", "machine:m1", "machine:m1").is_err());
        for index in 0..MAX_PENDING_PER_ENVIRONMENT {
            file("default", &format!("machine:m{index}")).unwrap();
        }
        assert!(file("default", "machine:fresh").is_err());
        assert!(file("prod", "machine:fresh").is_ok());
        assert_eq!(expire(&conn, now_millis() + EXPIRY_MILLIS + 1).unwrap(), 21);
        assert!(file("default", "machine:m1").is_ok());
    }

    #[tokio::test]
    async fn one_agent_cannot_fill_the_queue() {
        let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
        let conn = store.conn.lock().await;
        // Sessions minted by the same machine share that machine's quota.
        for index in 0..MAX_PENDING_PER_REQUESTER {
            create(
                &conn,
                input(),
                "default",
                &format!("broker_session:s{index}"),
                "machine:m1",
            )
            .unwrap();
        }
        let error =
            create(&conn, input(), "default", "broker_session:s9", "machine:m1").unwrap_err();
        assert_eq!(
            error.downcast_ref::<VaultError>().unwrap().code(),
            "vault_conflict"
        );
        assert!(create(&conn, input(), "default", "machine:m1", "machine:m1").is_err());
        assert!(create(&conn, input(), "default", "machine:m2", "machine:m2").is_ok());
        let first = list(&conn, Some(ProposalStatus::Pending)).unwrap();
        let mine = first
            .iter()
            .find(|p| p.requested_by == "broker_session:s0")
            .unwrap();
        assert!(decide(&conn, &mine.id, ProposalStatus::Rejected, "operator", "").unwrap());
        assert!(create(&conn, input(), "default", "machine:m1", "machine:m1").is_ok());
    }
}
