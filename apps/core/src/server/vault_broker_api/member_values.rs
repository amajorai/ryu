//! Member-provided values for broker credential slots.
//!
//! A service's credential slots are the `secret:` references it names. A
//! signed-in member holding `use` on the service may supply their own value
//! for a slot: it is written to their personal (user) scope at the slot's
//! coordinates, never to a shared or node value. Personal values win over
//! node, team and org values at resolution, so sessions the member mints, and
//! sessions minted on the member's behalf (`onBehalfOf`), use it; nobody
//! else's do. No route here returns a value.

use super::*;

/// The member's user-scope coordinates for `reference` in `environment`.
fn member_coords(
    user_id: &str,
    reference: &str,
    environment: &str,
) -> Result<SecretCoords, Response> {
    let parsed = reference
        .strip_prefix("secret:")
        .and_then(SecretRef::parse)
        .ok_or_else(|| invalid_request(&format!("`{reference}` is not a vault credential slot")))?;
    SecretCoords {
        scope: SecretScope::User,
        scope_id: user_id.to_owned(),
        environment: parsed.environment_or(environment),
        path: parsed.path,
        binding: None,
        name: parsed.name,
    }
    .normalize()
    .map_err(|error| invalid_request(&error.to_string()))
}

/// The service, if the caller is a signed-in member holding `use` on it.
async fn member_service(
    ctx: &Ctx,
    name: &str,
) -> Result<(String, services::BrokerService), Response> {
    let Some(caller) = ctx.caller.as_ref() else {
        return Err(json_error(
            StatusCode::UNAUTHORIZED,
            "vault_user_required: member values need a signed-in member".to_owned(),
        ));
    };
    ctx.require_sys(&service_key(name), Capability::Use)?;
    let found = {
        let conn = ctx.store.conn.lock().await;
        services::get(&conn, name).map_err(vault_error)?
    };
    let service = found.ok_or_else(|| {
        json_error(
            StatusCode::NOT_FOUND,
            format!("vault_not_found: broker service `{name}`"),
        )
    })?;
    Ok((caller.user_id.clone(), service))
}

/// The `secret:` slots of a service (password-manager references are
/// resolved through their account, not a member value).
fn slots(service: &services::BrokerService) -> Vec<String> {
    let mut slots: Vec<String> = service
        .refs()
        .into_iter()
        .filter(|reference| reference.starts_with("secret:"))
        .collect();
    slots.sort();
    slots.dedup();
    slots
}

/// Which slots the caller has filled (never the values).
pub(super) async fn list_member_values(ctx: &Ctx, name: &str) -> Result<Value, Response> {
    let (user_id, service) = member_service(ctx, name).await?;
    let mut out = Vec::new();
    for reference in slots(&service) {
        let coords = member_coords(&user_id, &reference, &service.input.environment)?;
        let info = ctx.store.secret_info(&coords).await.map_err(vault_error)?;
        let live = info.filter(|info| info.deleted_at.is_none());
        out.push(json!({
            "reference": reference,
            "provided": live.is_some(),
            "updatedAt": live.map(|info| info.updated_at),
        }));
    }
    Ok(json!({ "service": name, "slots": out }))
}

/// Set (`Some`) or clear (`None`) the caller's value for one slot.
pub(super) async fn put_member_value(
    ctx: &Ctx,
    name: &str,
    reference: &str,
    value: Option<&str>,
) -> Result<Value, Response> {
    let (user_id, service) = member_service(ctx, name).await?;
    if !slots(&service).iter().any(|slot| slot == reference) {
        return Err(invalid_request(&format!(
            "`{reference}` is not a credential slot of broker service `{name}`"
        )));
    }
    let coords = member_coords(&user_id, reference, &service.input.environment)?;
    let actor = ctx.actor();
    let changed = match value {
        Some(value) => {
            if value.is_empty() {
                return Err(invalid_request("value must not be empty"));
            }
            ctx.require(&coords, Capability::Write)?;
            ctx.require_write_parameters(&coords, Some(value))?;
            ctx.store
                .write_secret(WriteRequest {
                    coords: coords.clone(),
                    value: Some(value),
                    patch: Default::default(),
                    actor: &actor,
                    source: VersionSource::Write,
                    expected_version: None,
                })
                .await
                .map_err(vault_error)?;
            true
        }
        None => {
            ctx.require(&coords, Capability::Delete)?;
            ctx.store
                .soft_delete(coords.clone(), &actor)
                .await
                .map_err(vault_error)?
        }
    };
    audit(
        ctx.store,
        &actor,
        if value.is_some() {
            "broker.member_value.set"
        } else {
            "broker.member_value.clear"
        },
        json!({ "service": name, "reference": reference }),
    )
    .await;
    Ok(
        json!({ "service": name, "reference": reference, "provided": value.is_some(), "changed": changed }),
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberValueBody {
    reference: String,
    /// The value; absent or `null` clears the slot.
    #[serde(default)]
    value: Option<String>,
}

/// GET /api/vault/broker/services/{name}/member-values.
#[utoipa::path(get, path = "/api/vault/broker/services/{name}/member-values", tag = "Vault",
    operation_id = "broker_list_member_values",
    summary = "Which credential slots of a service the caller filled with a personal value (use on sys/broker/<name>)",
    params(("name" = String, Path, description = "Service name")),
    responses((status = 200, description = "Slots, never values", body = serde_json::Value)))]
pub async fn list_member_values_route(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    match list_member_values(&ctx, &name).await {
        Ok(body) => respond(body),
        Err(response) => response,
    }
}

/// PUT /api/vault/broker/services/{name}/member-values.
#[utoipa::path(put, path = "/api/vault/broker/services/{name}/member-values", tag = "Vault",
    operation_id = "broker_put_member_value",
    summary = "Set or clear the caller's personal value for one credential slot of a service (use on sys/broker/<name>)",
    params(("name" = String, Path, description = "Service name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Saved", body = serde_json::Value)))]
pub async fn put_member_value_route(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let ctx = tri!(human(&state, caller, &headers).await);
    let body: MemberValueBody = tri!(parse_body(body));
    match put_member_value(&ctx, &name, &body.reference, body.value.as_deref()).await {
        Ok(body) => respond(body),
        Err(response) => response,
    }
}

#[cfg(test)]
#[path = "member_values_tests.rs"]
mod tests;
