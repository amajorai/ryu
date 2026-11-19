//! Brokered-request events: the per-session sealed log and audit devices.
//!
//! Each request the broker logs is also appended to its session's sealed log
//! ([`super::session_log`]) and, per [`ENV_AUDIT_REQUESTS`], written to the
//! vault audit chain as a `broker.request` row, which fans it out to every
//! enabled audit device (file, syslog, socket, HTTP). The row carries the
//! request metadata, the JSON-RPC calls of MCP traffic, and both principals
//! of a delegated session; never a header, body, or credential value.

use serde_json::json;

use super::delegation::SessionAttrs;
use super::jsonrpc::RpcCall;
use super::log::LogRow;
use super::session_log::{self, SessionLogEntry};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::{AuditActor, AuditEntry};

/// `auto` (default: only while an audit device is enabled), `on`, or `off`.
pub const ENV_AUDIT_REQUESTS: &str = "RYU_VAULT_BROKER_AUDIT_REQUESTS";

/// When brokered requests reach the audit chain and its devices.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditMode {
    /// While at least one audit device is enabled.
    Auto,
    On,
    Off,
}

impl AuditMode {
    pub fn parse(raw: Option<&str>) -> Self {
        match raw
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("on" | "1" | "true" | "always") => Self::On,
            Some("off" | "0" | "false" | "never") => Self::Off,
            _ => Self::Auto,
        }
    }

    pub fn from_env() -> Self {
        Self::parse(std::env::var(ENV_AUDIT_REQUESTS).ok().as_deref())
    }
}

/// Outcomes of a request that reached (or was handed to) its upstream.
fn delivered(outcome: &str) -> bool {
    matches!(
        outcome,
        "forwarded" | "tunneled" | "intercepted" | "websocket"
    )
}

/// The `broker.request` audit row for one logged request.
pub fn audit_entry(row: &LogRow, rpc: &[RpcCall], attrs: &SessionAttrs) -> AuditEntry {
    let actor = AuditActor::new("broker_session", row.session_id.as_deref());
    let outcome = if delivered(&row.outcome) {
        "ok"
    } else {
        "refused"
    };
    let mut entry = AuditEntry::new(&actor, "broker.request", outcome).details(json!({
        "method": row.method,
        "scheme": row.scheme,
        "host": row.host,
        "port": row.port,
        "path": row.path,
        "service": row.service,
        "status": row.status,
        "latencyMs": row.latency_ms,
        "outcome": row.outcome,
        "rpc": rpc,
        "onBehalfOf": attrs.on_behalf_of.as_ref().map(super::delegation::Member::subject),
        "remote": attrs.remote,
    }));
    entry.environment = Some(row.environment.clone());
    entry
}

fn any_device_enabled(conn: &rusqlite::Connection) -> bool {
    crate::vault::audit_devices::list(conn)
        .map(|devices| devices.iter().any(|device| device.enabled))
        .unwrap_or(false)
}

/// Record one request's sealed session-log entry and, per `mode`, its audit
/// row. Failures are logged and never fail the request.
pub async fn observe(store: &PluginSecretStore, row: &LogRow, rpc: Vec<RpcCall>, mode: AuditMode) {
    let Some(session_id) = row.session_id.as_deref() else {
        return;
    };
    let (attrs, audit) = {
        let conn = store.conn.lock().await;
        let attrs = super::delegation::get(&conn, session_id).unwrap_or_else(|error| {
            tracing::warn!("reading broker session attributes failed: {error:#}");
            SessionAttrs::default()
        });
        let audit = match mode {
            AuditMode::On => true,
            AuditMode::Off => false,
            AuditMode::Auto => any_device_enabled(&conn),
        };
        (attrs, audit)
    };
    if audit {
        store.audit(&audit_entry(row, &rpc, &attrs)).await;
    }
    if session_log::enabled() {
        let member = attrs
            .on_behalf_of
            .as_ref()
            .map(super::delegation::Member::subject);
        let entry = SessionLogEntry::from_row(row, rpc, member);
        if let Err(error) = session_log::append(store, session_id, entry).await {
            tracing::warn!("broker session log write failed: {error:#}");
        }
    }
}

#[cfg(test)]
#[path = "request_events_tests.rs"]
mod tests;
