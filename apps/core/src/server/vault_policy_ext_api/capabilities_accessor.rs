//! `GET /api/vault/capabilities-accessor?accessor=…&paths=a,b`: another
//! machine token's capabilities on policy keys, like OpenBao's
//! `sys/capabilities-accessor`. An administrator uses it to check what a CI
//! or agent token may do before handing it out, without holding the token.
//!
//! Needs `admin` on `sys/machines`, the key that already guards token
//! lookup and revocation. The answer comes from the token's live principal
//! (not revoked, not expired, identity enabled, a scoped child's narrowed
//! policies), evaluated with no baseline, exactly as a request made with the
//! token would be. An unknown or dead accessor is a 404. Nothing secret is
//! returned: capabilities and the identity id only.

use super::*;
use crate::server::vault_engines_api::machine_who;

/// Query of `GET /api/vault/capabilities-accessor`.
#[derive(Debug, Deserialize)]
pub struct CapabilitiesAccessorQuery {
    accessor: String,
    /// Comma-separated policy keys.
    paths: String,
}

/// GET /api/vault/capabilities-accessor.
#[utoipa::path(get, path = "/api/vault/capabilities-accessor", tag = "Vault",
    summary = "A machine token's capabilities on policy keys, by accessor (admin on sys/machines)",
    params(
        ("accessor" = String, Query, description = "Token accessor"),
        ("paths" = String, Query, description = "Comma-separated policy keys"),
    ),
    responses(
        (status = 200, description = "Capabilities per key", body = serde_json::Value),
        (status = 400, description = "No paths or too many", body = serde_json::Value),
        (status = 403, description = "Not an administrator on sys/machines", body = serde_json::Value),
        (status = 404, description = "No live token with that accessor", body = serde_json::Value),
    ))]
pub async fn capabilities_accessor(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<CapabilitiesAccessorQuery>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    capabilities_accessor_with(&ctx, &query.accessor, &query.paths).await
}

/// The `capabilities-accessor` answer for an administrator `ctx`.
pub(super) async fn capabilities_accessor_with(ctx: &Ctx, accessor: &str, paths: &str) -> Response {
    if let Err(response) = ctx.require_sys("sys/machines", Capability::Admin) {
        return response;
    }
    let paths: Vec<&str> = paths
        .split(',')
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .collect();
    if paths.is_empty() || paths.len() > MAX_CAPABILITY_PATHS {
        return invalid_request(&format!(
            "paths must list between 1 and {MAX_CAPABILITY_PATHS} keys"
        ));
    }
    let principal = {
        let conn = ctx.store.conn.lock().await;
        crate::vault::machine::principal_by_accessor_locked(&conn, accessor.trim())
    };
    let principal = match principal {
        Ok(Some(principal)) => principal,
        Ok(None) => {
            return json_error(
                StatusCode::NOT_FOUND,
                "vault_not_found: no live token with that accessor".to_owned(),
            )
        }
        Err(error) => return vault_error(error),
    };
    let identity_id = principal.identity_id.clone();
    let who = match machine_who(ctx.store, principal).await {
        Ok(who) => who,
        Err(response) => return response,
    };
    let mut out = serde_json::Map::new();
    for path in paths {
        out.insert(
            path.to_owned(),
            json!({ "capabilities": who.sys_caps(path) }),
        );
    }
    respond(json!({
        "accessor": accessor.trim(),
        "identityId": identity_id,
        "paths": out,
    }))
}

#[cfg(test)]
#[path = "capabilities_accessor_tests.rs"]
mod tests;
