//! Preferences handlers (cross-surface theme sync).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Preferences handlers (cross-surface theme sync) ────────────────────────────

#[utoipa::path(
    get,
    path = "/api/preferences/{key}",
    tag = "Preferences",
    summary = "Get a preference value",
    params(("key" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_preference(
    State(state): State<ServerState>,
    Path(key): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    if let Some(response) = generic_preference_read_denial(&key) {
        return response;
    }
    if key == crate::server::onboarding_state::USER_PERSONALIZATION_PREF_KEY
        && !crate::server::onboarding_state::can_access_user_personalization(&caller)
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "personalization is not available on this node" })),
        )
            .into_response();
    }
    // The node-wide default selection has a built-in value (flagship agent on the
    // bundled local Gemma), served HERE rather than seeded into the store: every
    // client — the composer's seed chain, the Defaults dialog, plugins — reads the
    // preference through this one route, so a read-default reaches all of them
    // while still letting a cleared preference genuinely return to the default.
    let default_value = |key: &str| -> Option<String> {
        matches!(
            key,
            crate::agent_selection::GLOBAL_SELECTION_PREF
                | crate::agent_selection::LOCAL_SELECTION_PREF
        )
        .then(|| serde_json::to_string(&crate::agent_selection::builtin_default_selection()).ok())
        .flatten()
    };
    let stored = match state.preferences.get(&key).await {
        Ok(value) => value,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    };
    // Privacy controls must display the same stored/environment/default choice
    // that Core's collection and export gates use, without persisting on reads.
    if let Some(value) =
        crate::privacy::effective_boolean_privacy_preference(&key, stored.as_deref())
    {
        return (
            StatusCode::OK,
            Json(json!({ "key": key, "value": value.to_string() })),
        )
            .into_response();
    }
    match stored {
        Some(value) if value.trim().is_empty() => {
            let value = default_value(&key)
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null);
            (StatusCode::OK, Json(json!({ "key": key, "value": value }))).into_response()
        }
        // A credential is never returned to a client: the owner sees that it is
        // set, and a PUT that sends the placeholder back keeps the stored value.
        Some(_) if crate::server::preferences::is_secret_preference_key(&key) => (
            StatusCode::OK,
            Json(json!({ "key": key, "value": ryu_crypto::redact::REDACTED })),
        )
            .into_response(),
        Some(value) => {
            (StatusCode::OK, Json(json!({ "key": key, "value": value }))).into_response()
        }
        // An unset key is not an error for a KV store. The local lane is the one
        // compatibility exception: when its new key is absent, read the former
        // single default so old installations migrate without a write.
        None if key == crate::agent_selection::LOCAL_SELECTION_PREF => {
            let value = crate::agent_selection::load_local(&state.preferences).await;
            let value = serde_json::to_string(&value)
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null);
            (StatusCode::OK, Json(json!({ "key": key, "value": value }))).into_response()
        }
        // An unset key is not an error for a KV store: return 200 with a null
        // value so clients reading optional prefs don't generate console 404 noise.
        None => {
            let value = default_value(&key)
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null);
            (StatusCode::OK, Json(json!({ "key": key, "value": value }))).into_response()
        }
    }
}

pub(in crate::server) fn generic_preference_write_denial(
    key: &str,
) -> Option<axum::response::Response> {
    if key == crate::acp_agent_settings::ACP_AGENT_SETTINGS_PREF_KEY {
        return Some(acp_agent_settings_generic_denial());
    }
    (key == crate::skills_catalog::distribution::INSTALL_TARGETS_PREF).then(|| {
        (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "Use /api/skills/targets/preferences to change skill install targets" })),
        ).into_response()
    })
}

/// Preferences whose value only a dedicated, permission-checked route may read.
/// The ACP agent settings map becomes executable spawn declarations and holds
/// agent credentials in its environment entries, so reading it requires the
/// per-agent `agent.edit` check in `GET /api/agents/:id/acp-settings`.
pub(in crate::server) fn generic_preference_read_denial(
    key: &str,
) -> Option<axum::response::Response> {
    (key == crate::acp_agent_settings::ACP_AGENT_SETTINGS_PREF_KEY)
        .then(acp_agent_settings_generic_denial)
}

pub(in crate::server) fn acp_agent_settings_generic_denial() -> axum::response::Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "error": "Use /api/agents/{id}/acp-settings to read or change ACP agent launch settings" })),
    )
        .into_response()
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct SetPreferenceBody {
    pub(in crate::server) value: String,
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct TrustWorkspacesBody {
    pub(in crate::server) folders: Vec<String>,
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct KeybindingEntryBody {
    pub(in crate::server) entry: String,
    /// Drop the entry so the default applies; `value` is ignored.
    #[serde(default)]
    pub(in crate::server) remove: bool,
    /// The shortcut to store; null or absent stores a JSON null (disabled).
    #[serde(default)]
    pub(in crate::server) value: Option<String>,
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct UntrustWorkspaceBody {
    pub(in crate::server) folder: String,
}

pub(in crate::server) fn workspace_trust_response(
    result: anyhow::Result<Vec<String>>,
) -> axum::response::Response {
    match result {
        Ok(folders) => Json(json!({ "folders": folders })).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/keybindings/entry` — set or remove one plugin shortcut
/// (`plugin:<id>` entries only) in one locked read-modify-write of the
/// `keybindings` preference, and return the stored document as `{ value }`.
pub(in crate::server) async fn edit_keybinding_entry(
    State(state): State<ServerState>,
    Json(body): Json<KeybindingEntryBody>,
) -> axum::response::Response {
    if body
        .entry
        .strip_prefix("plugin:")
        .is_none_or(|id| id.is_empty())
    {
        return json_error(
            StatusCode::BAD_REQUEST,
            "entry must be a plugin shortcut (plugin:<id>)".to_owned(),
        );
    }
    let edit = if body.remove {
        preferences::KeybindingEdit::Remove
    } else if let Some(shortcut) = body.value.as_deref() {
        preferences::KeybindingEdit::Set(shortcut)
    } else {
        preferences::KeybindingEdit::Disable
    };
    match state
        .preferences
        .edit_keybinding_entry(&body.entry, edit)
        .await
    {
        Ok(document) => Json(json!({ "value": document })).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

/// `POST /api/workspace-trust/trust` — add folders to the trusted list in one
/// locked read-modify-write and return the stored list.
pub(in crate::server) async fn trust_workspaces(
    State(state): State<ServerState>,
    Json(body): Json<TrustWorkspacesBody>,
) -> axum::response::Response {
    workspace_trust_response(
        crate::workspace_trust::trust_folders(&state.preferences, &body.folders).await,
    )
}

/// `POST /api/workspace-trust/untrust` — remove one folder from the trusted
/// list in one locked read-modify-write and return the stored list.
pub(in crate::server) async fn untrust_workspace(
    State(state): State<ServerState>,
    Json(body): Json<UntrustWorkspaceBody>,
) -> axum::response::Response {
    workspace_trust_response(
        crate::workspace_trust::untrust_folder(&state.preferences, &body.folder).await,
    )
}
