//! Org-scoped project and bot daily rollups (`projectDaily`, `botDaily`) for
//! the control plane's per-project and per-bot caps (scoped budgets, contract
//! §4). Both have the `teamDaily` row shape.
//!
//! Only rows attributed to an organization count: project and bot ids are
//! org-local, and an unattributed row (anonymous, master key, local scoped
//! credentials) has no cap to feed. A row's `agent_id` is a verified id on
//! org traffic (a Core-proven agent on a dynamic credential, or the agent a
//! static trusted forwarder names; any other static key drops the header), so
//! no caller can shift spend onto another bot by setting `x-ryu-agent-id`.

use serde_json::{json, Value};

use super::{build_daily, AuditEntry, SharedState};

/// Per-project daily rollup (`projectDaily`), keyed by `projectId`.
pub(super) fn build_project_daily(state: &SharedState, entries: &[AuditEntry]) -> Vec<Value> {
    build_daily(state, entries, "projectId", false, |entry| {
        org_scoped(entry, entry.project_id.as_deref())
    })
}

/// Per-bot daily rollup (`botDaily`), keyed by `botId`. A bot id names no
/// organization, so each bucket also carries the `keyId` of the hosted
/// credential that served it (the fleet ingest credits the bucket to that
/// key's org); rows are therefore bucketed per key as well.
pub(super) fn build_bot_daily(state: &SharedState, entries: &[AuditEntry]) -> Vec<Value> {
    let mut keys: Vec<Option<&str>> = entries
        .iter()
        .filter(|entry| !org_scoped(entry, entry.agent_id.as_deref()).is_empty())
        .map(|entry| entry.key_id.as_deref())
        .collect();
    keys.sort_unstable();
    keys.dedup();
    let mut rows = Vec::new();
    for key in keys {
        let mut group = build_daily(state, entries, "botId", false, |entry| {
            if entry.key_id.as_deref() == key {
                org_scoped(entry, entry.agent_id.as_deref())
            } else {
                Vec::new()
            }
        });
        if let Some(key) = key {
            for row in &mut group {
                row["keyId"] = json!(key);
            }
        }
        rows.append(&mut group);
    }
    rows
}

/// `id` when the row belongs to an organization and `id` is non-blank.
fn org_scoped<'a>(entry: &AuditEntry, id: Option<&'a str>) -> Vec<&'a str> {
    let in_org = entry.org_id.as_deref().is_some_and(|org| !org.is_empty());
    id.filter(|id| in_org && !id.trim().is_empty())
        .into_iter()
        .collect()
}

#[cfg(test)]
#[path = "scoped_daily_tests.rs"]
mod tests;
