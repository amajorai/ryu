//! Broker session history, statuses, and labels.
//!
//! Ended sessions stay in `vault_broker_sessions` (see [`super::prune`]), so
//! the history lists every session with a derived status: live, expired,
//! revoked, or ended (a machine-minted session whose token died). A session's
//! label is set at mint and may be changed later; listings filter on it. No
//! listing returns a token.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::{live_clause, row_to_session, BrokerSession, COLUMNS, MAX_LABEL_LEN, NEVER_EXPIRES_AT};
use crate::vault::{now_millis, VaultError};

/// Default and largest page of history.
pub const DEFAULT_LIMIT: i64 = 50;
pub const MAX_LIMIT: i64 = 200;

/// Where a session stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Live,
    Expired,
    Revoked,
    /// The machine token that minted it was revoked or expired, or its
    /// identity was disabled.
    Ended,
}

/// A session with its status, as listings return it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntry {
    #[serde(flatten)]
    pub session: BrokerSession,
    pub status: SessionStatus,
    pub never_expires: bool,
}

/// History filters (all optional).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryFilter {
    /// Exact label.
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub status: Option<SessionStatus>,
    #[serde(default)]
    pub environment: Option<String>,
    /// Sessions created before this time (milliseconds), for paging.
    #[serde(default)]
    pub before: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
}

fn status_of(session: &BrokerSession, live: bool, now: i64) -> SessionStatus {
    if session.revoked_at.is_some() {
        SessionStatus::Revoked
    } else if session.expires_at <= now {
        SessionStatus::Expired
    } else if live {
        SessionStatus::Live
    } else {
        SessionStatus::Ended
    }
}

fn entry(session: BrokerSession, live: bool, now: i64) -> SessionEntry {
    SessionEntry {
        status: status_of(&session, live, now),
        never_expires: session.expires_at >= NEVER_EXPIRES_AT,
        session,
    }
}

/// Every session matching `filter`, newest first.
pub fn list(conn: &Connection, filter: &HistoryFilter) -> Result<Vec<SessionEntry>> {
    let now = now_millis();
    let limit = filter.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS}, ({}) AS live FROM vault_broker_sessions
         WHERE (?2 IS NULL OR label = ?2)
           AND (?3 IS NULL OR environment = ?3)
           AND (?4 IS NULL OR created_at < ?4)
         ORDER BY created_at DESC, id DESC",
        live_clause("?1")
    ))?;
    let rows = stmt.query_map(
        params![now, filter.label, filter.environment, filter.before],
        |row| Ok((row_to_session(row)?, row.get::<_, bool>(10)?)),
    )?;
    let mut out = Vec::new();
    for row in rows {
        let (session, live) = row?;
        let entry = entry(session, live, now);
        if filter.status.is_none_or(|status| status == entry.status) {
            out.push(entry);
            if out.len() as i64 >= limit {
                break;
            }
        }
    }
    Ok(out)
}

/// Live sessions with their status, optionally with one label, newest first.
pub fn live(conn: &Connection, label: Option<&str>) -> Result<Vec<SessionEntry>> {
    let now = now_millis();
    Ok(super::list(conn)?
        .into_iter()
        .filter(|session| label.is_none_or(|label| session.label == label))
        .map(|session| entry(session, true, now))
        .collect())
}

/// Change a session's label (live or not). Returns whether it exists.
pub fn relabel(conn: &Connection, id: &str, label: &str) -> Result<bool> {
    if label.len() > MAX_LABEL_LEN || label.chars().any(char::is_control) {
        return Err(VaultError::Invalid(
            "label must be at most 128 bytes without control characters".to_owned(),
        )
        .into());
    }
    Ok(conn.execute(
        "UPDATE vault_broker_sessions SET label = ?2 WHERE id = ?1",
        params![id, label],
    )? > 0)
}

#[cfg(test)]
#[path = "session_history_tests.rs"]
mod tests;
