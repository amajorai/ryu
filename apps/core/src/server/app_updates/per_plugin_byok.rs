//! Per-plugin BYOK secrets.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Per-plugin BYOK secrets ───────────────────────────────────────────────────
//
// The write half of the `secret` settings-field type. A plugin's manifest already
// names its credential as an `env:VARNAME` token in `secret_headers`; these three
// routes let the UI fill that name in from an encrypted store instead of requiring
// an exported env var and a Core restart (see `crate::plugin_secrets`).
//
// The single invariant: **no route here ever returns a secret value.** The listing
// answers "is one set, and when was it written" and nothing more; there is
// deliberately no read endpoint to add a leak to later.

/// Body for `PUT /api/plugins/:id/secrets/:key`.
#[derive(serde::Deserialize)]
pub(in crate::server) struct PutPluginSecretBody {
    /// The credential. Empty/whitespace-only CLEARS the stored secret — the same
    /// gesture as blanking the field in the UI, so "delete" needs no separate call
    /// from the renderer's point of view.
    pub(in crate::server) value: String,
}

/// Resolve the process-global secret store, or the 503 a caller sees when the
/// at-rest master key could not be loaded at boot (Core keeps running; secrets are
/// simply unavailable).
pub(in crate::server) fn plugin_secret_store(
) -> Result<&'static crate::plugin_secrets::PluginSecretStore, axum::response::Response> {
    crate::plugin_secrets::global().ok_or_else(|| {
        json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "plugin secret store unavailable (at-rest encryption key could not be loaded)"
                .to_owned(),
        )
    })
}

/// `GET /api/plugins/:id/secrets` — which BYOK secrets this plugin has stored.
///
/// **Metadata only, by construction.** The response carries the key name, a `set`
/// flag and the last-write timestamp; the ciphertext columns are not even selected
/// by the query behind it, so there is no code path from this handler to a
/// plaintext or an encrypted value. A masked settings field renders "Set"/"Not set"
/// from this and nothing else.
///
/// Not manifest-gated: an id with no manifest (uninstalled, or renamed) yields an
/// empty list rather than a 404, so the UI can always ask and cleanup can always
/// proceed.
#[utoipa::path(
    get,
    path = "/api/plugins/{id}/secrets",
    tag = "Plugins",
    summary = "List a plugin's stored secret names (never their values)",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_plugin_secrets_handler(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    // Plugin credential configuration (even its metadata) is an app update.
    if let Err(response) = enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_UPDATE,
    )
    .await
    {
        return response;
    }
    let store = match plugin_secret_store() {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    match store.list_keys(&id).await {
        Ok(keys) => Json(json!({
            "secrets": keys
                .into_iter()
                .map(|k| {
                    // Two ways a stored secret can be real yet never actually used,
                    // both of which would otherwise render as a confident "Set":
                    //
                    // `shadowed_by_env` — the resolver prefers an exported process
                    // env var, so on a machine where the operator already exported
                    // this name the stored value is inert. Showing "Set" there sends
                    // the user hunting for the wrong problem when a key looks wrong.
                    //
                    // `readable` — `may_read_env_secret` restricts which names a
                    // plugin may read at all (its own namespace, or the operator
                    // allowlist). A plugin that stored a name outside that gate has a
                    // credential the resolver will always skip.
                    //
                    // Neither is an error, so neither belongs in the status code;
                    // they are facts about the row the UI must be able to say out loud.
                    let shadowed_by_env = std::env::var(&k.key)
                        .ok()
                        .is_some_and(|v| !v.is_empty());
                    json!({
                        "key": k.key,
                        "set": true,
                        "updated_at": k.updated_at,
                        "shadowed_by_env": shadowed_by_env,
                        "readable": crate::tool_exec::may_read_env_secret(&id, &k.key),
                    })
                })
                .collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `PUT /api/plugins/{id}/secrets/{key}` — store (or clear) one BYOK credential,
/// encrypted at rest.
///
/// `key` is the ENV VAR NAME the plugin's manifest already names in its
/// `secret_headers` (`RYU_TAVILY_API_KEY`), which is why it is validated as a POSIX
/// env-var identifier: a name that could not be an env var could never be read back
/// by the resolver, so accepting it would store a credential the user believes is
/// live and nothing ever reads.
///
/// The write is NOT gated on `may_read_env_secret`. That gate is a READ-time
/// control and stays the single authority: it consults an operator allowlist that
/// can legitimately change after the fact, so refusing the write would let a
/// today-ungated name become permanently unsettable even once an operator opens it.
/// A stored row the gate refuses is inert — no path reads it.
#[utoipa::path(
    put,
    path = "/api/plugins/{id}/secrets/{key}",
    tag = "Plugins",
    summary = "Set a plugin's BYOK secret (write-only; encrypted at rest)",
    params(
        ("id" = String, Path),
        ("key" = String, Path, description = "The env var name the manifest names, e.g. RYU_TAVILY_API_KEY"),
    ),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 400, description = "Malformed key name", body = serde_json::Value),
        (status = 404, description = "No such plugin", body = serde_json::Value),
    )
)]
pub(in crate::server) async fn put_plugin_secret_handler(
    State(state): State<ServerState>,
    Path((id, key)): Path<(String, String)>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<PutPluginSecretBody>,
) -> axum::response::Response {
    if let Err(response) = enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_UPDATE,
    )
    .await
    {
        return response;
    }
    if !crate::plugin_secrets::is_valid_secret_key(&key) {
        return json_error(
            StatusCode::BAD_REQUEST,
            format!(
                "'{key}' is not a valid secret name (expected an environment variable \
                 identifier: a letter or underscore followed by letters, digits or underscores)"
            ),
        );
    }
    // Writes are bounded to plugins this node actually knows about, so the store
    // cannot be used as an arbitrary encrypted dumping ground. Reads and deletes
    // stay unbounded on purpose (an uninstalled plugin must still be cleanable).
    if find_manifest(&state, &id).await.is_none() {
        return json_error(
            StatusCode::NOT_FOUND,
            format!("no manifest found for plugin '{id}'"),
        );
    }
    let store = match plugin_secret_store() {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    match store.set(&id, &key, &body.value).await {
        // The response deliberately echoes nothing back — not the value, not a
        // masked preview, not a length.
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `DELETE /api/plugins/{id}/secrets/{key}` — clear one stored credential.
/// Idempotent: deleting an absent secret is a 200, not a 404.
#[utoipa::path(
    delete,
    path = "/api/plugins/{id}/secrets/{key}",
    tag = "Plugins",
    summary = "Clear a plugin's stored BYOK secret",
    params(("id" = String, Path), ("key" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn delete_plugin_secret_handler(
    State(state): State<ServerState>,
    Path((id, key)): Path<(String, String)>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    if let Err(response) = enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_UPDATE,
    )
    .await
    {
        return response;
    }
    let store = match plugin_secret_store() {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    match store.delete(&id, &key).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}
