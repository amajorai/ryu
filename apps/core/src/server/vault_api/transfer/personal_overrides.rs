//! `GET`/`PUT /api/vault/personal-overrides`: the caller's own switch for
//! whether their personal values override shared (project, team and
//! organization) values at resolution and export
//! ([`crate::vault::shared::personal_overrides`]).
//!
//! A caller only ever reads or sets their own setting. The user is the one
//! the resolver would use ([`Ctx::resolution_context`]): the verified caller,
//! or `local` for the operator of an unregistered node. A registered node
//! without a signed-in user has no personal values, so both routes refuse.

use super::*;
use crate::vault::shared::personal_overrides;

/// Body of `PUT /api/vault/personal-overrides`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersonalOverridesBody {
    /// `true`: personal values win (the default). `false`: shared values win.
    pub(crate) enabled: bool,
}

/// The routes, merged into the protected vault router.
pub(crate) fn routes() -> axum::Router<ServerState> {
    use axum::routing::get;
    axum::Router::new().route(
        "/api/vault/personal-overrides",
        get(get_personal_overrides)
            .put(put_personal_overrides)
            .layer(axum::extract::DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES)),
    )
}

fn user_of(ctx: &Ctx) -> Result<String, Response> {
    ctx.resolution_context(None).user_id.ok_or_else(|| {
        vault_error(
            VaultError::Denied("personal overrides need a signed-in user".to_owned()).into(),
        )
    })
}

fn render(user_id: &str, enabled: bool) -> Response {
    respond(json!({ "userId": user_id, "enabled": enabled }))
}

pub(crate) async fn get_with(ctx: &Ctx) -> Response {
    let user_id = try_response!(user_of(ctx));
    render(
        &user_id,
        personal_overrides::enabled(ctx.store, &user_id).await,
    )
}

pub(crate) async fn put_with(ctx: &Ctx, body: PersonalOverridesBody) -> Response {
    let user_id = try_response!(user_of(ctx));
    if let Err(error) = personal_overrides::set(ctx.store, &user_id, body.enabled).await {
        return vault_error(error);
    }
    let entry = AuditEntry::new(&ctx.actor(), "vault.personal_overrides", "ok")
        .details(json!({ "enabled": body.enabled }));
    if !ctx.store.audit(&entry).await {
        return vault_error(VaultError::AuditUnavailable.into());
    }
    render(&user_id, body.enabled)
}

/// GET /api/vault/personal-overrides
#[utoipa::path(
    get,
    path = "/api/vault/personal-overrides",
    tag = "Vault",
    summary = "Whether the caller's personal values override shared values",
    responses(
        (status = 200, description = "The caller's setting", body = serde_json::Value),
        (status = 403, description = "No signed-in user on a registered node")
    )
)]
pub async fn get_personal_overrides(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    get_with(&ctx).await
}

/// PUT /api/vault/personal-overrides
#[utoipa::path(
    put,
    path = "/api/vault/personal-overrides",
    tag = "Vault",
    summary = "Switch whether the caller's personal values override shared values",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "The caller's new setting", body = serde_json::Value),
        (status = 403, description = "No signed-in user on a registered node")
    )
)]
pub async fn put_personal_overrides(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<PersonalOverridesBody>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    put_with(&ctx, body).await
}

#[cfg(test)]
#[path = "personal_overrides_tests.rs"]
mod tests;
