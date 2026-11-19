//! `GET /api/vault/sys/metrics`: counts that show a vault's size and load,
//! like OpenBao's `sys/metrics`, as JSON or Prometheus text
//! (`?format=prometheus`). Needs `read` on `sys/metrics`.
//!
//! Every figure is a count of rows: values by state, live leases, tokens and
//! broker sessions, machine identities, policies and audit rows. No name,
//! path, identity or value appears, so the endpoint is safe to scrape. A
//! table a node has never created counts as zero.

use super::*;
use rusqlite::Connection;

/// One gauge: its Prometheus name, help text, labels and value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Gauge {
    pub(crate) name: &'static str,
    pub(crate) help: &'static str,
    pub(crate) labels: Vec<(&'static str, &'static str)>,
    pub(crate) value: i64,
}

#[derive(Debug, Default, Deserialize)]
pub struct MetricsQuery {
    #[serde(default)]
    format: Option<String>,
}

fn count(conn: &Connection, sql: &str, now: i64) -> i64 {
    let with_now = sql.contains("?1");
    let result = if with_now {
        conn.query_row(sql, [now], |row| row.get::<_, i64>(0))
    } else {
        conn.query_row(sql, [], |row| row.get::<_, i64>(0))
    };
    // A table this node never created reads as zero, not an error.
    result.unwrap_or(0)
}

/// The gauges for the store behind `conn` at `now` (epoch millis).
pub(crate) fn metrics_snapshot(conn: &Connection, now: i64) -> Vec<Gauge> {
    let gauge = |name, help, labels: Vec<(&'static str, &'static str)>, sql: &str| Gauge {
        name,
        help,
        labels,
        value: count(conn, sql, now),
    };
    vec![
        gauge(
            "ryu_vault_values",
            "Vault values by state.",
            vec![("state", "active")],
            "SELECT COUNT(*) FROM vault_secrets WHERE deleted_at IS NULL",
        ),
        gauge(
            "ryu_vault_values",
            "Vault values by state.",
            vec![("state", "deleted")],
            "SELECT COUNT(*) FROM vault_secrets WHERE deleted_at IS NOT NULL",
        ),
        gauge(
            "ryu_vault_leases_active",
            "Dynamic-credential leases not revoked or expired.",
            Vec::new(),
            "SELECT COUNT(*) FROM vault_leases WHERE revoked_at IS NULL AND expires_at > ?1",
        ),
        gauge(
            "ryu_vault_leases_pending_revoke",
            "Credentials never handed out whose revoke is still being retried (retry leases).",
            Vec::new(),
            "SELECT COUNT(*) FROM vault_leases WHERE revoked_at IS NULL AND pending_revoke = 1",
        ),
        gauge(
            "ryu_vault_tokens_active",
            "Machine tokens not revoked or expired.",
            Vec::new(),
            "SELECT COUNT(*) FROM vault_tokens WHERE revoked_at IS NULL AND expires_at > ?1",
        ),
        gauge(
            "ryu_vault_broker_sessions_active",
            "Credential-broker sessions not revoked or expired.",
            Vec::new(),
            "SELECT COUNT(*) FROM vault_broker_sessions WHERE revoked_at IS NULL AND expires_at > ?1",
        ),
        gauge(
            "ryu_vault_machine_identities",
            "Machine identities.",
            Vec::new(),
            "SELECT COUNT(*) FROM vault_machine_identities",
        ),
        gauge(
            "ryu_vault_policies",
            "Vault policies.",
            Vec::new(),
            "SELECT COUNT(*) FROM vault_policies",
        ),
        gauge(
            "ryu_vault_audit_rows",
            "Rows in the vault audit log.",
            Vec::new(),
            "SELECT COUNT(*) FROM vault_audit",
        ),
    ]
}

/// Prometheus text exposition (version 0.0.4) for `gauges`.
pub(crate) fn prometheus_text(gauges: &[Gauge]) -> String {
    let mut out = String::new();
    let mut described: Vec<&str> = Vec::new();
    for gauge in gauges {
        if !described.contains(&gauge.name) {
            described.push(gauge.name);
            out.push_str(&format!(
                "# HELP {} {}\n# TYPE {} gauge\n",
                gauge.name, gauge.help, gauge.name
            ));
        }
        let labels = if gauge.labels.is_empty() {
            String::new()
        } else {
            let pairs: Vec<String> = gauge
                .labels
                .iter()
                .map(|(key, value)| format!("{key}=\"{value}\""))
                .collect();
            format!("{{{}}}", pairs.join(","))
        };
        out.push_str(&format!("{}{} {}\n", gauge.name, labels, gauge.value));
    }
    out
}

/// GET /api/vault/sys/metrics.
#[utoipa::path(get, path = "/api/vault/sys/metrics", tag = "Vault",
    summary = "Vault size and load counts, as JSON or Prometheus text (read on sys/metrics)",
    params(("format" = Option<String>, Query, description = "`json` (default) or `prometheus`")),
    responses(
        (status = 200, description = "Counts; never names or values", body = serde_json::Value),
        (status = 400, description = "Unknown format", body = serde_json::Value),
        (status = 403, description = "No read on sys/metrics", body = serde_json::Value),
    ))]
pub async fn vault_metrics(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<MetricsQuery>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    vault_metrics_with(&ctx, query.format.as_deref()).await
}

pub(crate) async fn vault_metrics_with(ctx: &Ctx, format: Option<&str>) -> Response {
    if let Err(response) = ctx.require_sys("sys/metrics", Capability::Read) {
        return response;
    }
    let format = format.map(str::trim).filter(|format| !format.is_empty());
    if !matches!(format, None | Some("json" | "prometheus")) {
        return invalid_request("format must be json or prometheus");
    }
    let gauges = {
        let conn = ctx.store.conn.lock().await;
        metrics_snapshot(&conn, crate::vault::now_millis())
    };
    if format == Some("prometheus") {
        let mut response = prometheus_text(&gauges).into_response();
        response.headers_mut().insert(
            axum::http::header::CONTENT_TYPE,
            axum::http::HeaderValue::from_static("text/plain; version=0.0.4"),
        );
        return response;
    }
    let metrics: Vec<Value> = gauges
        .iter()
        .map(|gauge| {
            let labels: serde_json::Map<String, Value> = gauge
                .labels
                .iter()
                .map(|(key, value)| ((*key).to_owned(), json!(value)))
                .collect();
            json!({ "name": gauge.name, "labels": labels, "value": gauge.value })
        })
        .collect();
    respond(json!({ "metrics": metrics }))
}

#[cfg(test)]
#[path = "metrics_tests.rs"]
mod tests;
