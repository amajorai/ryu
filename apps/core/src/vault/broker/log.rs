//! The broker request log.
//!
//! One row per brokered request: method, scheme, host, port, the path as the
//! agent sent it (placeholders, never substituted values; no query string),
//! the matched service, status, latency, outcome, and session. No header,
//! body, or credential value is ever written. Rows for hosts no service
//! matched double as "discovered hosts" an operator can turn into services.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// Hard cap on one listing page.
pub const MAX_PAGE: i64 = 200;
const MAX_PATH_LEN: usize = 512;
const HOUR_MILLIS: i64 = 3600 * 1000;

/// One request log row.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRow {
    #[serde(default)]
    pub id: i64,
    pub at: i64,
    pub session_id: Option<String>,
    pub environment: String,
    pub method: String,
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub path: String,
    pub service: Option<String>,
    pub status: u16,
    pub latency_ms: i64,
    /// `forwarded`, `tunneled`, `intercepted`, or an error code such as
    /// `forbidden`, `service_disabled`, `rate_limited`.
    pub outcome: String,
}

/// Listing filters.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFilter {
    pub environment: Option<String>,
    pub service: Option<String>,
    pub session_id: Option<String>,
    /// `2xx`, `3xx`, `4xx`, or `5xx`.
    pub status_bucket: Option<String>,
    /// Rows with an id below this (pagination).
    pub before: Option<i64>,
    pub limit: Option<i64>,
}

/// A host requested without a matching service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredHost {
    pub environment: String,
    pub host: String,
    pub port: u16,
    pub requests: i64,
    pub last_seen: i64,
    /// A catalog template whose host matches, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_template: Option<String>,
}

/// Create the log table. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_broker_log (
             id          INTEGER PRIMARY KEY AUTOINCREMENT,
             at          INTEGER NOT NULL,
             session_id  TEXT,
             environment TEXT NOT NULL,
             method      TEXT NOT NULL,
             scheme      TEXT NOT NULL,
             host        TEXT NOT NULL,
             port        INTEGER NOT NULL,
             path        TEXT NOT NULL,
             service     TEXT,
             status      INTEGER NOT NULL,
             latency_ms  INTEGER NOT NULL,
             outcome     TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS vault_broker_log_at ON vault_broker_log (at);",
    )
    .context("initializing broker log schema")
}

/// Truncate a path for storage (on a character boundary).
fn clip(path: &str) -> &str {
    if path.len() <= MAX_PATH_LEN {
        return path;
    }
    let mut end = MAX_PATH_LEN;
    while !path.is_char_boundary(end) {
        end -= 1;
    }
    &path[..end]
}

/// Append one row.
pub fn insert(conn: &Connection, row: &LogRow) -> Result<i64> {
    conn.execute(
        "INSERT INTO vault_broker_log
            (at, session_id, environment, method, scheme, host, port, path, service, status,
             latency_ms, outcome)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            row.at,
            row.session_id,
            row.environment,
            row.method,
            row.scheme,
            row.host,
            row.port,
            clip(&row.path),
            row.service,
            row.status,
            row.latency_ms,
            row.outcome
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Rows matching `filter`, newest first.
pub fn list(conn: &Connection, filter: &LogFilter) -> Result<Vec<LogRow>> {
    let (low, high) = match filter.status_bucket.as_deref() {
        Some("2xx") => (200, 299),
        Some("3xx") => (300, 399),
        Some("4xx") => (400, 499),
        Some("5xx") => (500, 599),
        _ => (0, 999),
    };
    let limit = filter.limit.unwrap_or(50).clamp(1, MAX_PAGE);
    let mut stmt = conn.prepare(
        "SELECT id, at, session_id, environment, method, scheme, host, port, path, service,
                status, latency_ms, outcome
         FROM vault_broker_log
         WHERE (?1 IS NULL OR environment = ?1) AND (?2 IS NULL OR service = ?2)
           AND (?3 IS NULL OR session_id = ?3) AND status BETWEEN ?4 AND ?5
           AND (?6 IS NULL OR id < ?6)
         ORDER BY id DESC LIMIT ?7",
    )?;
    let rows = stmt.query_map(
        params![
            filter.environment,
            filter.service,
            filter.session_id,
            low,
            high,
            filter.before,
            limit
        ],
        |row| {
            Ok(LogRow {
                id: row.get(0)?,
                at: row.get(1)?,
                session_id: row.get(2)?,
                environment: row.get(3)?,
                method: row.get(4)?,
                scheme: row.get(5)?,
                host: row.get(6)?,
                port: row.get(7)?,
                path: row.get(8)?,
                service: row.get(9)?,
                status: row.get(10)?,
                latency_ms: row.get(11)?,
                outcome: row.get(12)?,
            })
        },
    )?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Hosts requested without a matching service, busiest first.
pub fn discovered_hosts(
    conn: &Connection,
    environment: Option<&str>,
) -> Result<Vec<DiscoveredHost>> {
    let mut stmt = conn.prepare(
        "SELECT environment, host, port, COUNT(*), MAX(at) FROM vault_broker_log
         WHERE service IS NULL AND (?1 IS NULL OR environment = ?1)
         GROUP BY environment, host, port ORDER BY COUNT(*) DESC LIMIT 200",
    )?;
    let rows = stmt.query_map(params![environment], |row| {
        let host: String = row.get(1)?;
        Ok(DiscoveredHost {
            environment: row.get(0)?,
            suggested_template: super::catalog::suggest_for_host(&host).map(str::to_owned),
            host,
            port: row.get(2)?,
            requests: row.get(3)?,
            last_seen: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Drop rows older than `max_age_hours` (0 keeps all) and trim to `max_rows`
/// (0 keeps all). Returns rows removed.
pub fn prune(conn: &Connection, now: i64, max_age_hours: i64, max_rows: i64) -> Result<usize> {
    let mut removed = 0;
    if max_age_hours > 0 {
        removed += conn.execute(
            "DELETE FROM vault_broker_log WHERE at < ?1",
            params![now - max_age_hours * HOUR_MILLIS],
        )?;
    }
    if max_rows > 0 {
        removed += conn.execute(
            "DELETE FROM vault_broker_log WHERE id <= (
                 SELECT id FROM vault_broker_log ORDER BY id DESC LIMIT 1 OFFSET ?1
             )",
            params![max_rows],
        )?;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(at: i64, host: &str, service: Option<&str>, status: u16) -> LogRow {
        LogRow {
            at,
            environment: "default".into(),
            method: "GET".into(),
            scheme: "https".into(),
            host: host.into(),
            port: 443,
            path: "/v1".into(),
            service: service.map(str::to_owned),
            status,
            outcome: "forwarded".into(),
            ..LogRow::default()
        }
    }

    #[tokio::test]
    async fn rows_filter_page_and_prune() {
        let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
        let conn = store.conn.lock().await;
        let now = crate::vault::now_millis();
        insert(
            &conn,
            &row(now - 10 * HOUR_MILLIS, "old.example.com", None, 200),
        )
        .unwrap();
        insert(&conn, &row(now, "api.openai.com", Some("openai"), 200)).unwrap();
        insert(&conn, &row(now, "api.openai.com", None, 403)).unwrap();
        insert(&conn, &row(now, "api.github.com", None, 403)).unwrap();
        let all = list(&conn, &LogFilter::default()).unwrap();
        assert_eq!(all.len(), 4);
        assert!(all[0].id > all[1].id);
        let errors = LogFilter {
            status_bucket: Some("4xx".into()),
            ..LogFilter::default()
        };
        assert_eq!(list(&conn, &errors).unwrap().len(), 2);
        let by_service = LogFilter {
            service: Some("openai".into()),
            ..LogFilter::default()
        };
        assert_eq!(list(&conn, &by_service).unwrap().len(), 1);
        let page = LogFilter {
            before: Some(all[1].id),
            limit: Some(1),
            ..LogFilter::default()
        };
        assert_eq!(list(&conn, &page).unwrap()[0].id, all[2].id);

        let discovered = discovered_hosts(&conn, Some("default")).unwrap();
        assert_eq!(discovered.len(), 3);
        let openai = discovered
            .iter()
            .find(|h| h.host == "api.openai.com")
            .unwrap();
        assert_eq!(openai.suggested_template.as_deref(), Some("openai"));

        assert_eq!(prune(&conn, now, 1, 0).unwrap(), 1);
        assert_eq!(prune(&conn, now, 0, 2).unwrap(), 1);
        assert_eq!(list(&conn, &LogFilter::default()).unwrap().len(), 2);
    }

    #[test]
    fn long_paths_are_clipped_on_char_boundaries() {
        let path = format!("/{}", "é".repeat(400));
        let clipped = clip(&path);
        assert!(clipped.len() <= MAX_PATH_LEN);
        assert!(path.starts_with(clipped));
    }
}
