//! Namespace lock routes: freeze and thaw a scope subtree.
//!
//! * `GET    /api/vault/namespace-locks`: every lock (`list` on `sys/namespaces`);
//! * `POST   /api/vault/namespace-locks`: lock a subtree (`admin` on
//!   `sys/namespaces/<scope>/<id>`);
//! * `DELETE /api/vault/namespace-locks/{id}`: unlock (`admin` on the same key).
//!
//! While a lock holds, every per-value route answers `423 vault_locked`
//! ([`Ctx::require`]), listings hide the values, and runtime resolution
//! treats them as absent. See [`crate::vault::policy::namespace_locks`].

use super::*;
use crate::vault::policy::namespace_locks::{self as locks, NamespaceLock};

impl Ctx {
    /// The namespace lock covering `coords`, if any. A locked value has no
    /// capabilities, so listings hide it and every per-value route refuses.
    pub(crate) fn namespace_lock(&self, coords: &SecretCoords) -> Option<NamespaceLock> {
        let held = locks::cached(self.store);
        let org = self.node.as_ref().map(|node| node.org.id.as_str());
        locks::lock_for(&held, coords, org).cloned()
    }
}

/// The policy key that guards locking `scope:id`.
pub(crate) fn namespace_lock_key(scope: SecretScope, scope_id: &str) -> String {
    format!("sys/namespaces/{}/{}", scope.as_str(), scope_id.trim())
}

/// Body of `POST /api/vault/namespace-locks`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockBody {
    pub(crate) scope: SecretScope,
    pub(crate) scope_id: String,
    #[serde(default)]
    pub(crate) environment: Option<String>,
    #[serde(default)]
    pub(crate) path: Option<String>,
    #[serde(default)]
    pub(crate) reason: Option<String>,
}

pub(crate) async fn list_namespace_locks_with(ctx: &Ctx) -> Response {
    if let Err(response) = ctx.require_sys("sys/namespaces", Capability::List) {
        return response;
    }
    match ctx.store.namespace_locks().await {
        Ok(held) => respond(json!({ "locks": held })),
        Err(error) => vault_error(error),
    }
}

pub(crate) async fn lock_namespace_with(ctx: &Ctx, body: LockBody) -> Response {
    let key = namespace_lock_key(body.scope, &body.scope_id);
    if let Err(response) = ctx.require_sys(&key, Capability::Admin) {
        return response;
    }
    let lock = NamespaceLock {
        id: String::new(),
        scope: body.scope,
        scope_id: body.scope_id,
        environment: body.environment.filter(|env| !env.trim().is_empty()),
        path: body.path.filter(|path| !path.trim().is_empty()),
        reason: body.reason.unwrap_or_default(),
        locked_by: None,
        locked_at: 0,
    };
    match ctx.store.lock_namespace(lock, &ctx.actor()).await {
        Ok(lock) => respond(json!({ "ok": true, "lock": lock })),
        Err(error) => vault_error(error),
    }
}

pub(crate) async fn unlock_namespace_with(ctx: &Ctx, id: &str) -> Response {
    let held = match ctx.store.namespace_locks().await {
        Ok(held) => held,
        Err(error) => return vault_error(error),
    };
    let Some(lock) = held.into_iter().find(|lock| lock.id == id) else {
        return json_error(
            StatusCode::NOT_FOUND,
            "vault_not_found: no such namespace lock".to_owned(),
        );
    };
    let key = namespace_lock_key(lock.scope, &lock.scope_id);
    if let Err(response) = ctx.require_sys(&key, Capability::Admin) {
        return response;
    }
    match ctx.store.unlock_namespace(id, &ctx.actor()).await {
        Ok(removed) => respond(json!({ "ok": true, "removed": removed })),
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/namespace-locks.
#[utoipa::path(get, path = "/api/vault/namespace-locks", tag = "Vault",
    summary = "List namespace locks",
    responses((status = 200, description = "Locks", body = serde_json::Value)))]
pub async fn list_namespace_locks(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    list_namespace_locks_with(&ctx).await
}

/// POST /api/vault/namespace-locks.
#[utoipa::path(post, path = "/api/vault/namespace-locks", tag = "Vault",
    summary = "Lock a user, node, team or org subtree (admin)",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Locked", body = serde_json::Value),
        (status = 409, description = "Already locked", body = serde_json::Value),
    ))]
pub async fn lock_namespace(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<LockBody>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    lock_namespace_with(&ctx, body).await
}

/// DELETE /api/vault/namespace-locks/{id}.
#[utoipa::path(delete, path = "/api/vault/namespace-locks/{id}", tag = "Vault",
    summary = "Unlock a namespace (admin)",
    params(("id" = String, Path, description = "Lock id")),
    responses((status = 200, description = "Unlocked", body = serde_json::Value)))]
pub async fn unlock_namespace(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    unlock_namespace_with(&ctx, &id).await
}

#[cfg(test)]
#[path = "namespace_locks_tests.rs"]
mod tests;
