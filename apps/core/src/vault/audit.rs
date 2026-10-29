//! Append-only, HMAC-chained vault audit log.
//!
//! Every vault operation (write, delete, rollback, reveal, runtime resolution,
//! unseal attempt, policy change, engine call) appends one row. Rows never hold
//! a value, ciphertext, token, or private key: only who, what, which secret
//! coordinates, the outcome, and bounded redacted details.
//!
//! Each row's `hmac` is `HMAC-SHA256(key, canonical(row) || prev_hmac)` with a
//! random audit key sealed by the Core master key in `vault_meta`. Editing,
//! reordering, or deleting a row breaks every later link, which
//! [`verify`] reports. Retention pruning records the last pruned link as the
//! chain anchor so verification still starts from a known value.

use anyhow::{Context, Result};
use hmac::{Hmac, Mac};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_crypto::FieldCipher;
use serde::Serialize;
use serde_json::Value;
use sha2::Sha256;

use super::keyring::{meta_get, meta_set};
use super::{now_millis, random_bytes};

const META_AUDIT_KEY: &str = "audit_key";
const META_AUDIT_ANCHOR: &str = "audit_anchor";
/// `<seq>:<hmac>:<tag>` of the newest row, tagged with the audit key. Deleting
/// trailing rows leaves an otherwise valid chain, so `verify` also requires
/// the chain to end at this head.
const META_AUDIT_HEAD: &str = "audit_head";
/// Hard cap on one listing page.
pub const MAX_AUDIT_PAGE: usize = 500;
/// Upper bound on serialized details per row.
const MAX_DETAILS_BYTES: usize = 4 * 1024;

/// Who performed an audited operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditActor {
    /// `operator`, `user`, `machine`, `agent`, or `system`.
    pub kind: String,
    pub id: Option<String>,
}

impl AuditActor {
    pub fn system() -> Self {
        Self {
            kind: "system".into(),
            id: None,
        }
    }

    pub fn new(kind: &str, id: Option<&str>) -> Self {
        Self {
            kind: kind.to_owned(),
            id: id.map(str::to_owned),
        }
    }
}

/// One entry to append.
#[derive(Debug, Clone, Default)]
pub struct AuditEntry {
    pub actor_kind: String,
    pub actor_id: Option<String>,
    pub action: String,
    /// `ok`, `denied`, `error`, or `not_found`.
    pub outcome: String,
    pub scope: Option<String>,
    pub scope_id: Option<String>,
    pub environment: Option<String>,
    pub path: Option<String>,
    pub name: Option<String>,
    pub details: Value,
    pub request_id: Option<String>,
}

impl AuditEntry {
    pub fn new(actor: &AuditActor, action: &str, outcome: &str) -> Self {
        Self {
            actor_kind: actor.kind.clone(),
            actor_id: actor.id.clone(),
            action: action.to_owned(),
            outcome: outcome.to_owned(),
            details: Value::Object(Default::default()),
            ..Self::default()
        }
    }

    pub fn secret(
        mut self,
        scope: &str,
        scope_id: &str,
        environment: &str,
        path: &str,
        name: &str,
    ) -> Self {
        self.scope = Some(scope.to_owned());
        self.scope_id = Some(scope_id.to_owned());
        self.environment = Some(environment.to_owned());
        self.path = Some(path.to_owned());
        self.name = Some(name.to_owned());
        self
    }

    pub fn details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }
}

/// One stored audit row.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditRow {
    pub seq: i64,
    pub at: String,
    pub actor: AuditActor,
    pub action: String,
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub details: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

/// Filters for [`list`].
#[derive(Debug, Clone, Default)]
pub struct AuditFilter {
    pub before_seq: Option<i64>,
    pub limit: usize,
    pub name: Option<String>,
    pub action: Option<String>,
    pub actor_id: Option<String>,
    pub environment: Option<String>,
}

/// Result of [`verify`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    pub ok: bool,
    pub rows: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_bad_seq: Option<i64>,
}

/// Create the audit table. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_audit (
             seq         INTEGER PRIMARY KEY AUTOINCREMENT,
             at          INTEGER NOT NULL,
             actor_kind  TEXT NOT NULL,
             actor_id    TEXT,
             action      TEXT NOT NULL,
             outcome     TEXT NOT NULL,
             scope       TEXT,
             scope_id    TEXT,
             environment TEXT,
             path        TEXT,
             name        TEXT,
             details     TEXT NOT NULL,
             request_id  TEXT,
             hmac        TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_vault_audit_name ON vault_audit(name, seq DESC);
         CREATE INDEX IF NOT EXISTS idx_vault_audit_at ON vault_audit(at);",
    )
    .context("initializing vault audit schema")
}

/// Load the audit HMAC key, creating it (sealed by `master`) on first use.
pub fn load_or_create_key(conn: &Connection, master: &FieldCipher) -> Result<Vec<u8>> {
    if let Some(sealed) = meta_get(conn, META_AUDIT_KEY)? {
        let encoded = master
            .open(&sealed)
            .context("opening the vault audit key")?;
        return hex::decode(encoded).context("decoding the vault audit key");
    }
    let key = random_bytes(32);
    meta_set(conn, META_AUDIT_KEY, &master.seal(&hex::encode(&key))?)?;
    Ok(key)
}

#[allow(clippy::too_many_arguments)]
fn link(
    key: &[u8],
    seq: i64,
    at: i64,
    actor_kind: &str,
    actor_id: Option<&str>,
    action: &str,
    outcome: &str,
    coords: [Option<&str>; 5],
    details: &str,
    request_id: Option<&str>,
    prev: &str,
) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    let mut field = |value: &str| {
        mac.update(&(value.len() as u64).to_be_bytes());
        mac.update(value.as_bytes());
    };
    field(&seq.to_string());
    field(&at.to_string());
    field(actor_kind);
    field(actor_id.unwrap_or("\u{0}"));
    field(action);
    field(outcome);
    for coordinate in coords {
        field(coordinate.unwrap_or("\u{0}"));
    }
    field(details);
    field(request_id.unwrap_or("\u{0}"));
    field(prev);
    hex::encode(mac.finalize().into_bytes())
}

fn head_tag(key: &[u8], seq: i64, hmac: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(b"ryu-vault-audit-head\0");
    mac.update(&seq.to_be_bytes());
    mac.update(hmac.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// The recorded head `(seq, hmac)`, or `None` before the first append that
/// recorded one. A head whose tag does not verify is an error.
fn read_head(conn: &Connection, key: &[u8]) -> Result<Option<(i64, String)>> {
    let Some(raw) = meta_get(conn, META_AUDIT_HEAD)? else {
        return Ok(None);
    };
    let mut parts = raw.splitn(3, ':');
    let (Some(seq), Some(hmac), Some(tag)) = (parts.next(), parts.next(), parts.next()) else {
        anyhow::bail!("malformed audit head");
    };
    let seq: i64 = seq.parse().context("malformed audit head")?;
    if head_tag(key, seq, hmac) != tag {
        anyhow::bail!("audit head failed authentication");
    }
    Ok(Some((seq, hmac.to_owned())))
}

fn bounded_details(details: &Value) -> String {
    let serialized = serde_json::to_string(details).unwrap_or_else(|_| "{}".to_owned());
    if serialized.len() <= MAX_DETAILS_BYTES {
        serialized
    } else {
        "{\"truncated\":true}".to_owned()
    }
}

fn last_link(conn: &Connection) -> Result<String> {
    let last: Option<String> = conn
        .query_row(
            "SELECT hmac FROM vault_audit ORDER BY seq DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .context("reading the last audit link")?;
    match last {
        Some(link) => Ok(link),
        None => Ok(meta_get(conn, META_AUDIT_ANCHOR)?.unwrap_or_default()),
    }
}

/// Append one row and return its sequence number.
pub fn append(conn: &Connection, key: &[u8], entry: &AuditEntry) -> Result<i64> {
    append_row(conn, key, entry).map(|(row, _)| row.seq)
}

/// Append one row and return the stored row with its chain link, so audit
/// devices and the event bus can emit exactly what the chain recorded.
pub fn append_row(conn: &Connection, key: &[u8], entry: &AuditEntry) -> Result<(AuditRow, String)> {
    let at = now_millis();
    let details = bounded_details(&entry.details);
    let prev = last_link(conn)?;
    let next_seq: i64 = conn
        .query_row(
            "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'vault_audit'), 0) + 1",
            [],
            |row| row.get(0),
        )
        .context("reading the next audit sequence")?;
    let hmac = link(
        key,
        next_seq,
        at,
        &entry.actor_kind,
        entry.actor_id.as_deref(),
        &entry.action,
        &entry.outcome,
        [
            entry.scope.as_deref(),
            entry.scope_id.as_deref(),
            entry.environment.as_deref(),
            entry.path.as_deref(),
            entry.name.as_deref(),
        ],
        &details,
        entry.request_id.as_deref(),
        &prev,
    );
    conn.execute(
        "INSERT INTO vault_audit
            (seq, at, actor_kind, actor_id, action, outcome, scope, scope_id, environment,
             path, name, details, request_id, hmac)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            next_seq,
            at,
            entry.actor_kind,
            entry.actor_id,
            entry.action,
            entry.outcome,
            entry.scope,
            entry.scope_id,
            entry.environment,
            entry.path,
            entry.name,
            details,
            entry.request_id,
            hmac,
        ],
    )
    .context("appending vault audit row")?;
    meta_set(
        conn,
        META_AUDIT_HEAD,
        &format!("{next_seq}:{hmac}:{}", head_tag(key, next_seq, &hmac)),
    )?;
    let row = AuditRow {
        seq: next_seq,
        at: rfc3339(at),
        actor: AuditActor {
            kind: entry.actor_kind.clone(),
            id: entry.actor_id.clone(),
        },
        action: entry.action.clone(),
        outcome: entry.outcome.clone(),
        scope: entry.scope.clone(),
        scope_id: entry.scope_id.clone(),
        environment: entry.environment.clone(),
        path: entry.path.clone(),
        name: entry.name.clone(),
        details: serde_json::from_str(&details).unwrap_or(Value::Null),
        request_id: entry.request_id.clone(),
    };
    Ok((row, hmac))
}

fn rfc3339(millis: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(millis)
        .unwrap_or_default()
        .to_rfc3339()
}

/// List rows newest first, bounded by `filter.limit` (≤ [`MAX_AUDIT_PAGE`]).
pub fn list(conn: &Connection, filter: &AuditFilter) -> Result<Vec<AuditRow>> {
    let limit = filter.limit.clamp(1, MAX_AUDIT_PAGE) as i64;
    let mut stmt = conn
        .prepare(
            "SELECT seq, at, actor_kind, actor_id, action, outcome, scope, scope_id, environment,
                    path, name, details, request_id
             FROM vault_audit
             WHERE (?1 IS NULL OR seq < ?1)
               AND (?2 IS NULL OR name = ?2)
               AND (?3 IS NULL OR action = ?3)
               AND (?4 IS NULL OR actor_id = ?4)
               AND (?5 IS NULL OR environment = ?5)
             ORDER BY seq DESC
             LIMIT ?6",
        )
        .context("preparing audit listing")?;
    let rows = stmt
        .query_map(
            params![
                filter.before_seq,
                filter.name,
                filter.action,
                filter.actor_id,
                filter.environment,
                limit
            ],
            |row| {
                let details: String = row.get(11)?;
                Ok(AuditRow {
                    seq: row.get(0)?,
                    at: rfc3339(row.get(1)?),
                    actor: AuditActor {
                        kind: row.get(2)?,
                        id: row.get(3)?,
                    },
                    action: row.get(4)?,
                    outcome: row.get(5)?,
                    scope: row.get(6)?,
                    scope_id: row.get(7)?,
                    environment: row.get(8)?,
                    path: row.get(9)?,
                    name: row.get(10)?,
                    details: serde_json::from_str(&details).unwrap_or(Value::Null),
                    request_id: row.get(12)?,
                })
            },
        )
        .context("querying audit listing")?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.context("reading audit row")?);
    }
    Ok(out)
}

/// Recompute the chain from the anchor and report the first broken link.
pub fn verify(conn: &Connection, key: &[u8]) -> Result<VerifyReport> {
    let mut prev = meta_get(conn, META_AUDIT_ANCHOR)?.unwrap_or_default();
    let mut stmt = conn
        .prepare(
            "SELECT seq, at, actor_kind, actor_id, action, outcome, scope, scope_id, environment,
                    path, name, details, request_id, hmac
             FROM vault_audit ORDER BY seq ASC",
        )
        .context("preparing audit verification")?;
    let mut rows = stmt.query([]).context("querying audit verification")?;
    let mut count = 0;
    let mut expected_seq: Option<i64> = None;
    while let Some(row) = rows.next()? {
        count += 1;
        let seq: i64 = row.get(0)?;
        let stored: String = row.get(13)?;
        let scope: Option<String> = row.get(6)?;
        let scope_id: Option<String> = row.get(7)?;
        let environment: Option<String> = row.get(8)?;
        let path: Option<String> = row.get(9)?;
        let name: Option<String> = row.get(10)?;
        let actor_id: Option<String> = row.get(3)?;
        let request_id: Option<String> = row.get(12)?;
        let computed = link(
            key,
            seq,
            row.get(1)?,
            &row.get::<_, String>(2)?,
            actor_id.as_deref(),
            &row.get::<_, String>(4)?,
            &row.get::<_, String>(5)?,
            [
                scope.as_deref(),
                scope_id.as_deref(),
                environment.as_deref(),
                path.as_deref(),
                name.as_deref(),
            ],
            &row.get::<_, String>(11)?,
            request_id.as_deref(),
            &prev,
        );
        // Sequence numbers must be contiguous after the first retained row; a
        // deleted middle row breaks the chain even if the HMAC were forged.
        let contiguous = expected_seq.is_none_or(|expected| expected == seq);
        if computed != stored || !contiguous {
            return Ok(VerifyReport {
                ok: false,
                rows: count,
                first_bad_seq: Some(seq),
            });
        }
        expected_seq = Some(seq + 1);
        prev = stored;
    }
    // The chain must end at the recorded head; otherwise trailing rows were
    // removed. A head that fails authentication is itself tampering.
    let head = read_head(conn, key);
    let last_seq = expected_seq.map(|next| next - 1);
    let truncated = match &head {
        Ok(Some((head_seq, head_hmac))) => {
            *head_hmac != prev || last_seq.is_some_and(|seq| seq != *head_seq)
        }
        Ok(None) => false,
        Err(_) => true,
    };
    if truncated {
        return Ok(VerifyReport {
            ok: false,
            rows: count,
            first_bad_seq: Some(last_seq.map_or(1, |seq| seq + 1)),
        });
    }
    Ok(VerifyReport {
        ok: true,
        rows: count,
        first_bad_seq: None,
    })
}

/// Delete rows older than `before_millis`, recording the last deleted link as
/// the new chain anchor. Returns the number of rows removed.
pub fn prune(conn: &Connection, before_millis: i64) -> Result<usize> {
    let tx = conn.unchecked_transaction()?;
    let last: Option<String> = tx
        .query_row(
            "SELECT hmac FROM vault_audit WHERE at < ?1 ORDER BY seq DESC LIMIT 1",
            params![before_millis],
            |row| row.get(0),
        )
        .optional()?;
    let Some(anchor) = last else {
        return Ok(0);
    };
    let removed = tx.execute(
        "DELETE FROM vault_audit WHERE seq <= (SELECT seq FROM vault_audit WHERE hmac = ?1)",
        params![anchor],
    )?;
    meta_set(&tx, META_AUDIT_ANCHOR, &anchor)?;
    tx.commit()?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn setup() -> (Connection, Vec<u8>) {
        let conn = Connection::open_in_memory().unwrap();
        super::super::keyring::init_schema(&conn).unwrap();
        init_schema(&conn).unwrap();
        let key = load_or_create_key(&conn, &FieldCipher::new(&[1u8; 32])).unwrap();
        (conn, key)
    }

    fn entry(name: &str) -> AuditEntry {
        AuditEntry::new(&AuditActor::new("user", Some("u1")), "secret.write", "ok")
            .secret("user", "u1", "default", "/", name)
            .details(json!({ "version": 1 }))
    }

    #[test]
    fn appended_rows_list_newest_first_and_verify() {
        let (conn, key) = setup();
        for name in ["A", "B", "C"] {
            append(&conn, &key, &entry(name)).unwrap();
        }
        let rows = list(
            &conn,
            &AuditFilter {
                limit: 10,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].name.as_deref(), Some("C"));
        assert!(verify(&conn, &key).unwrap().ok);

        let filtered = list(
            &conn,
            &AuditFilter {
                limit: 10,
                name: Some("B".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(filtered.len(), 1);
    }

    #[test]
    fn tampering_with_a_row_breaks_verification() {
        let (conn, key) = setup();
        for name in ["A", "B", "C"] {
            append(&conn, &key, &entry(name)).unwrap();
        }
        conn.execute(
            "UPDATE vault_audit SET outcome = 'denied' WHERE seq = 2",
            [],
        )
        .unwrap();
        let report = verify(&conn, &key).unwrap();
        assert!(!report.ok);
        assert_eq!(report.first_bad_seq, Some(2));
    }

    #[test]
    fn deleting_the_newest_rows_breaks_verification() {
        let (conn, key) = setup();
        for name in ["A", "B", "C"] {
            append(&conn, &key, &entry(name)).unwrap();
        }
        assert!(verify(&conn, &key).unwrap().ok);
        conn.execute("DELETE FROM vault_audit WHERE seq = 3", [])
            .unwrap();
        let report = verify(&conn, &key).unwrap();
        assert!(!report.ok);
        assert_eq!(report.first_bad_seq, Some(3));
    }

    #[test]
    fn deleting_a_middle_row_breaks_verification() {
        let (conn, key) = setup();
        for name in ["A", "B", "C"] {
            append(&conn, &key, &entry(name)).unwrap();
        }
        conn.execute("DELETE FROM vault_audit WHERE seq = 2", [])
            .unwrap();
        assert!(!verify(&conn, &key).unwrap().ok);
    }

    #[test]
    fn pruning_keeps_the_remaining_chain_verifiable() {
        let (conn, key) = setup();
        for name in ["A", "B", "C"] {
            append(&conn, &key, &entry(name)).unwrap();
        }
        conn.execute("UPDATE vault_audit SET at = 1 WHERE seq <= 2", [])
            .unwrap();
        // Rewrite the HMACs of the backdated rows so the fixture stays valid.
        let mut prev = String::new();
        for seq in 1..=3 {
            let (at, name): (i64, String) = conn
                .query_row(
                    "SELECT at, name FROM vault_audit WHERE seq = ?1",
                    params![seq],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            let details = bounded_details(&json!({ "version": 1 }));
            let h = link(
                &key,
                seq,
                at,
                "user",
                Some("u1"),
                "secret.write",
                "ok",
                [
                    Some("user"),
                    Some("u1"),
                    Some("default"),
                    Some("/"),
                    Some(&name),
                ],
                &details,
                None,
                &prev,
            );
            conn.execute(
                "UPDATE vault_audit SET hmac = ?1 WHERE seq = ?2",
                params![h, seq],
            )
            .unwrap();
            prev = h;
        }
        // The rewritten fixture also moves the authenticated head.
        meta_set(
            &conn,
            META_AUDIT_HEAD,
            &format!("3:{prev}:{}", head_tag(&key, 3, &prev)),
        )
        .unwrap();
        assert!(verify(&conn, &key).unwrap().ok);
        assert_eq!(prune(&conn, 2).unwrap(), 2);
        let report = verify(&conn, &key).unwrap();
        assert!(report.ok, "{report:?}");
        assert_eq!(report.rows, 1);
        append(&conn, &key, &entry("D")).unwrap();
        assert!(verify(&conn, &key).unwrap().ok);
    }

    #[test]
    fn oversized_details_are_truncated_not_stored() {
        let (conn, key) = setup();
        let big = "x".repeat(MAX_DETAILS_BYTES * 2);
        append(&conn, &key, &entry("A").details(json!({ "blob": big }))).unwrap();
        let rows = list(
            &conn,
            &AuditFilter {
                limit: 1,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(rows[0].details, json!({ "truncated": true }));
    }
}
