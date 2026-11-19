//! Per-session request logs, sealed at rest.
//!
//! Every brokered request of a session appends one metadata entry: the
//! request-log row fields (method, host, path as sent, service, status,
//! latency, outcome), the JSON-RPC calls of an MCP request ([`super::jsonrpc`]),
//! and the member a delegated session acts for. Never a header, body, or
//! credential value. Entries are stored in chunks of [`CHUNK_ENTRIES`] in
//! `plugin_secrets` under the owner `vault-broker-session-log:<session>`, so
//! each chunk is sealed with the vault keyring (and covered by its rotation
//! and rewrap). A session keeps at most [`MAX_CHUNKS`] chunks, oldest dropped
//! first; chunks older than the request-log retention are pruned.
//!
//! [`ENV_SESSION_LOG`] set to `off` (`0`, `false`) stops recording.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::jsonrpc::RpcCall;
use super::log::LogRow;
use crate::plugin_secrets::PluginSecretStore;

/// `off` turns per-session logs off (default on).
pub const ENV_SESSION_LOG: &str = "RYU_VAULT_BROKER_SESSION_LOG";
/// Entries per sealed chunk.
pub const CHUNK_ENTRIES: usize = 64;
/// Chunks kept per session.
pub const MAX_CHUNKS: usize = 32;
/// Most entries one read returns.
pub const MAX_READ: usize = CHUNK_ENTRIES * MAX_CHUNKS;
const OWNER_PREFIX: &str = "vault-broker-session-log:";
const HOUR_MILLIS: i64 = 3600 * 1000;

/// One sealed entry.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLogEntry {
    pub at: i64,
    pub method: String,
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    pub status: u16,
    pub latency_ms: i64,
    pub outcome: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rpc: Vec<RpcCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_behalf_of: Option<String>,
}

impl SessionLogEntry {
    pub fn from_row(row: &LogRow, rpc: Vec<RpcCall>, on_behalf_of: Option<String>) -> Self {
        Self {
            at: row.at,
            method: row.method.clone(),
            scheme: row.scheme.clone(),
            host: row.host.clone(),
            port: row.port,
            path: row.path.chars().take(512).collect(),
            service: row.service.clone(),
            status: row.status,
            latency_ms: row.latency_ms,
            outcome: row.outcome.clone(),
            rpc,
            on_behalf_of,
        }
    }
}

/// Whether per-session logs are recorded.
pub fn enabled() -> bool {
    !matches!(
        std::env::var(ENV_SESSION_LOG)
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "off" | "0" | "false" | "disabled"
    )
}

fn owner(session_id: &str) -> String {
    format!("{OWNER_PREFIX}{session_id}")
}

fn chunk_key(index: u64) -> String {
    format!("chunk-{index:010}")
}

fn chunk_index(key: &str) -> Option<u64> {
    key.strip_prefix("chunk-")?.parse().ok()
}

/// Serializes appends, so concurrent requests of one session never lose an
/// entry to a read-modify-write race.
fn append_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

async fn chunk_indexes(store: &PluginSecretStore, session_id: &str) -> Result<Vec<u64>> {
    let mut indexes: Vec<u64> = store
        .list_keys(&owner(session_id))
        .await?
        .iter()
        .filter_map(|info| chunk_index(&info.key))
        .collect();
    indexes.sort_unstable();
    Ok(indexes)
}

async fn read_chunk(
    store: &PluginSecretStore,
    session_id: &str,
    index: u64,
) -> Result<Vec<SessionLogEntry>> {
    Ok(store
        .get(&owner(session_id), &chunk_key(index))
        .await?
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default())
}

/// Append one entry to the session's sealed log.
pub async fn append(
    store: &PluginSecretStore,
    session_id: &str,
    entry: SessionLogEntry,
) -> Result<()> {
    let _guard = append_lock().lock().await;
    let indexes = chunk_indexes(store, session_id).await?;
    let (index, mut entries) = match indexes.last() {
        Some(&last) => {
            let entries = read_chunk(store, session_id, last).await?;
            if entries.len() < CHUNK_ENTRIES {
                (last, entries)
            } else {
                (last + 1, Vec::new())
            }
        }
        None => (0, Vec::new()),
    };
    entries.push(entry);
    let owner = owner(session_id);
    store
        .set(&owner, &chunk_key(index), &serde_json::to_string(&entries)?)
        .await?;
    let kept: Vec<u64> = indexes
        .into_iter()
        .chain(std::iter::once(index))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    if kept.len() > MAX_CHUNKS {
        for stale in &kept[..kept.len() - MAX_CHUNKS] {
            store.delete(&owner, &chunk_key(*stale)).await?;
        }
    }
    Ok(())
}

/// The session's newest entries, newest first (at most `limit`).
pub async fn read(
    store: &PluginSecretStore,
    session_id: &str,
    limit: usize,
) -> Result<Vec<SessionLogEntry>> {
    let limit = limit.clamp(1, MAX_READ);
    let mut out = Vec::new();
    for index in chunk_indexes(store, session_id).await?.into_iter().rev() {
        let mut entries = read_chunk(store, session_id, index).await?;
        entries.reverse();
        out.extend(entries);
        if out.len() >= limit {
            break;
        }
    }
    out.truncate(limit);
    Ok(out)
}

/// Drop chunks last written more than `max_age_hours` ago (0 keeps all).
pub fn prune(conn: &Connection, now: i64, max_age_hours: i64) -> Result<usize> {
    if max_age_hours <= 0 {
        return Ok(0);
    }
    Ok(conn.execute(
        "DELETE FROM plugin_secrets WHERE substr(plugin_id, 1, ?1) = ?2 AND updated_at < ?3",
        params![
            OWNER_PREFIX.len() as i64,
            OWNER_PREFIX,
            now - max_age_hours * HOUR_MILLIS
        ],
    )?)
}

#[cfg(test)]
#[path = "session_log_tests.rs"]
mod tests;
