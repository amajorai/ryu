//! Broker session history and relabeling routes.

use super::*;
use crate::vault::broker::sessions::history::{self, HistoryFilter};

/// GET /api/vault/broker/sessions/history.
#[utoipa::path(get, path = "/api/vault/broker/sessions/history", tag = "Vault",
    operation_id = "broker_session_history",
    summary = "Every broker session, live and ended, newest first (admin on sys/broker)",
    params(
        ("label" = Option<String>, Query, description = "Exact session label"),
        ("status" = Option<String>, Query, description = "live, expired, revoked, or ended"),
        ("environment" = Option<String>, Query, description = "Environment"),
        ("before" = Option<i64>, Query, description = "Sessions created before this time (ms)"),
        ("limit" = Option<i64>, Query, description = "Page size (max 200)"),
    ),
    responses((status = 200, description = "Sessions with status (no tokens)", body = serde_json::Value)))]
pub async fn session_history(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(filter): Query<HistoryFilter>,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    tri!(ctx.require_sys(SYS_BROKER, Capability::Admin));
    let conn = ctx.store.conn.lock().await;
    match history::list(&conn, &filter) {
        Ok(items) => respond(json!({ "sessions": items })),
        Err(error) => vault_error(error),
    }
}

#[derive(Debug, Deserialize)]
pub struct RelabelBody {
    label: String,
}

/// PATCH /api/vault/broker/sessions/{id}.
#[utoipa::path(patch, path = "/api/vault/broker/sessions/{id}", tag = "Vault",
    operation_id = "broker_relabel_session",
    summary = "Change a broker session's label (its minter, or admin on sys/broker)",
    params(("id" = String, Path, description = "Session id")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Relabeled", body = serde_json::Value)))]
pub async fn relabel_session(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    let body: RelabelBody = tri!(parse_body(body));
    let conn = ctx.store.conn.lock().await;
    let session = match sessions::get(&conn, &id) {
        Ok(Some(session)) => session,
        Ok(None) => {
            return json_error(
                StatusCode::NOT_FOUND,
                format!("vault_not_found: broker session `{id}`"),
            )
        }
        Err(error) => return vault_error(error),
    };
    tri!(authorize_revoke(&ctx, &session));
    match history::relabel(&conn, &id, &body.label) {
        Ok(_) => {
            ctx.store.audit_locked(
                &conn,
                &AuditEntry::new(&ctx.actor(), "broker.session.relabel", "ok")
                    .details(json!({ "session": id })),
            );
            respond(json!({ "id": id, "label": body.label }))
        }
        Err(error) => vault_error(error),
    }
}

#[cfg(test)]
#[path = "session_history_routes_tests.rs"]
mod tests;
