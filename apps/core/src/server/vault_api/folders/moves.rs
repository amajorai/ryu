//! Folder rename/move and single-value move routes.
//!
//! * `POST /api/vault/folders/move`: move or rename a folder with everything
//!   under it. Needs `admin` on both folder keys (`sys/folders/<env><path>`),
//!   and on every value under it `delete` at the old key and `write` at the
//!   new one (plus `admin` in a protected environment). A value the caller
//!   cannot move, including another user's personal value they cannot see,
//!   refuses the whole move; the refusal reports a count, never a name.
//! * `POST /api/vault/secrets/{name}/move`: move one value to another folder,
//!   environment or name within its scope (`delete` at the old key, `write`
//!   at the new one).
//!
//! A destination guarded by write-parameter constraints is refused: a move
//! does not re-check the stored value, so write it there instead. Team and
//! org values a managed node forwards to the control plane cannot be moved
//! here yet (`501`).

use super::*;

/// Body of `POST /api/vault/folders/move`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderMoveBody {
    pub(crate) environment: String,
    pub(crate) path: String,
    /// Defaults to `environment`.
    #[serde(default)]
    pub(crate) to_environment: Option<String>,
    pub(crate) to_path: String,
}

/// Body of `POST /api/vault/secrets/{name}/move`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretMoveBody {
    #[serde(flatten)]
    pub(crate) coords: CoordsBody,
    #[serde(default)]
    pub(crate) to_environment: Option<String>,
    #[serde(default)]
    pub(crate) to_path: Option<String>,
    #[serde(default)]
    pub(crate) to_name: Option<String>,
}

fn constrained_destination(key: &str) -> Response {
    json_error(
        StatusCode::FORBIDDEN,
        format!(
            "vault_denied: `{key}` has write-parameter constraints; write the value there \
             instead of moving it"
        ),
    )
}

pub(crate) async fn move_folder_with(ctx: &Ctx, body: FolderMoveBody) -> Response {
    let to_environment = body
        .to_environment
        .filter(|env| !env.trim().is_empty())
        .unwrap_or_else(|| body.environment.clone());
    let (from, from_key) = try_response!(folder_policy_key(&body.environment, &body.path));
    let (to, to_key) = try_response!(folder_policy_key(&to_environment, &body.to_path));
    for key in [&from_key, &to_key] {
        try_response!(ctx.require_sys(key, Capability::Admin));
    }
    let from_protected = try_response!(protected_environment(ctx, &body.environment).await);
    let to_protected = try_response!(protected_environment(ctx, &to_environment).await);
    let allow = |old: &SecretCoords, new: &SecretCoords| {
        let (old_caps, new_caps) = (ctx.caps(old), ctx.caps(new));
        old_caps.contains(&Capability::Delete)
            && new_caps.contains(&Capability::Write)
            && (from_protected.is_none() || old_caps.contains(&Capability::Admin))
            && (to_protected.is_none() || new_caps.contains(&Capability::Admin))
            && !ctx.write_parameters_constrained(new)
    };
    match ctx
        .store
        .move_folder(
            &body.environment,
            &from,
            &to_environment,
            &to,
            &ctx.actor(),
            allow,
        )
        .await
    {
        Ok(report) => respond(json!({ "ok": true, "move": report })),
        Err(error) => vault_error(error),
    }
}

pub(crate) async fn move_secret_with(ctx: &Ctx, name: &str, body: SecretMoveBody) -> Response {
    if ctx.shared_remote(body.coords.scope) {
        return json_error(
            StatusCode::NOT_IMPLEMENTED,
            "vault_unsupported: control-plane shared values cannot be moved from a node yet"
                .to_owned(),
        );
    }
    let from = try_response!(coords_for(ctx, name, body.coords.clone()));
    let target = CoordsBody {
        environment: body.to_environment.or_else(|| Some(from.environment.clone())),
        path: body.to_path.or_else(|| Some(from.path.clone())),
        ..body.coords
    };
    let to_name = body.to_name.unwrap_or_else(|| from.name.clone());
    let to = try_response!(coords_for(ctx, &to_name, target));
    try_response!(ctx.require(&from, Capability::Delete));
    try_response!(ctx.require(&to, Capability::Write));
    if ctx.write_parameters_constrained(&to) {
        return constrained_destination(&to.policy_key());
    }
    for coords in [&from, &to] {
        match protected_environment(ctx, &coords.environment).await {
            Ok(Some(_)) if !ctx.caps(coords).contains(&Capability::Admin) => {
                return protected_denied(&coords.environment);
            }
            Ok(_) => {}
            Err(response) => return response,
        }
    }
    match ctx.store.move_secret(from, to, &ctx.actor()).await {
        Ok(info) => respond(json!({ "ok": true, "secret": to_wire(ctx, info) })),
        Err(error) => vault_error(error),
    }
}

/// POST /api/vault/folders/move.
#[utoipa::path(post, path = "/api/vault/folders/move", tag = "Vault",
    summary = "Move or rename a folder with everything under it (admin)",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Moved", body = serde_json::Value),
        (status = 409, description = "A destination value exists, or items, an external source or a pending change request block the move", body = serde_json::Value),
    ))]
pub async fn move_folder(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<FolderMoveBody>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    move_folder_with(&ctx, body).await
}

/// POST /api/vault/secrets/{name}/move.
#[utoipa::path(post, path = "/api/vault/secrets/{name}/move", tag = "Vault",
    summary = "Move or rename one value within its scope",
    params(("name" = String, Path, description = "Secret name")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Moved", body = serde_json::Value),
        (status = 409, description = "A value exists at the destination", body = serde_json::Value),
    ))]
pub async fn move_secret(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<SecretMoveBody>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    move_secret_with(&ctx, &name, body).await
}

#[cfg(test)]
#[path = "moves_tests.rs"]
mod tests;
