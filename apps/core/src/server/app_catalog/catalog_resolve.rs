//! App catalog browse, install-from-URL and hot reload: `resolve_plugin_from_catalog_inner` through `app_tool_hide_filters`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

pub(in crate::server) async fn resolve_plugin_from_catalog_inner(
    state: &ServerState,
    id: &str,
    buyer_token: Option<String>,
    channel: Option<&str>,
    version: Option<&str>,
) -> Result<
    (
        crate::plugin_manifest::PluginManifest,
        Option<String>,
        crate::plugins::isolation::PluginProvenance,
    ),
    (StatusCode, String),
> {
    use crate::catalog_source::CatalogKind;

    let active = state
        .catalog_sources
        .get_active(CatalogKind::Plugin, &state.preferences)
        .await;
    let active_id = active.as_ref().map(|s| s.id().to_owned());
    let mut sources: Vec<crate::catalog_source::Source> = active.into_iter().collect();
    for meta in state.catalog_sources.sources_for(CatalogKind::Plugin) {
        if Some(&meta.id) == active_id.as_ref() {
            continue;
        }
        if let Some(source) = state
            .catalog_sources
            .source_by_id(CatalogKind::Plugin, &meta.id)
        {
            sources.push(source);
        }
    }
    if sources.is_empty() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "no active plugin catalog source".to_owned(),
        ));
    }

    // Keep the FIRST failure (the active source's), so a caller sees the same error
    // it always saw rather than whatever the last fallback source happened to say.
    let mut first_err: Option<(StatusCode, String)> = None;
    let mut remember = |err: (StatusCode, String)| {
        if first_err.is_none() {
            first_err = Some(err);
        }
    };

    for source in sources {
        // Fetch detail → verify signature → ui_code integrity gate (all fail-closed
        // inside `install_descriptor`).
        let descriptor_result = if let Some(version) = version {
            crate::catalog_source::with_buyer_token(
                buyer_token.clone(),
                source.install_descriptor_at_version(&state.client, id, version),
            )
            .await
        } else {
            crate::catalog_source::with_buyer_token(
                buyer_token.clone(),
                source.install_descriptor_at(&state.client, id, channel),
            )
            .await
        };
        let descriptor = match descriptor_result {
            Ok(d) => d,
            Err(e) => {
                remember((StatusCode::BAD_GATEWAY, e.to_string()));
                continue;
            }
        };
        if descriptor.kind != CatalogKind::Plugin {
            remember((
                StatusCode::BAD_REQUEST,
                format!("resolved item `{id}` is not a plugin"),
            ));
            continue;
        }

        // The VALIDATED manifest + ui_code ride in `descriptor.raw` (the integrity
        // gate has already run; `ui_code` is null for an unsigned/manifest-only
        // item).
        let manifest_value = descriptor
            .raw
            .get("manifest")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let mut manifest: crate::plugin_manifest::PluginManifest =
            match serde_json::from_value(manifest_value) {
                Ok(m) => m,
                Err(e) => {
                    remember((
                        StatusCode::UNPROCESSABLE_ENTITY,
                        format!("Invalid manifest JSON: {e}"),
                    ));
                    continue;
                }
            };
        // Same dependency-id canonicalization the local loader applies, so a
        // catalog manifest that still says `requires.apps: [{ id: "shadow" }]`
        // resolves against the installed `@ryu/shadow` instead of being reported
        // as a missing dependency.
        crate::plugin_manifest::canonicalize_dependency_ids(&mut manifest);
        // The signed surface must carry the sandbox JS itself. `ryu publish` inlines
        // every `code_file` before signing, which is what puts the whole hook body
        // INSIDE the signature; a `code_file` here would name a file that no signed
        // payload contains and that nothing downstream can fetch.
        if let Err(e) = manifest.validate_code_sources() {
            remember((StatusCode::UNPROCESSABLE_ENTITY, e));
            continue;
        }
        let ui_code = descriptor
            .raw
            .get("ui_code")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        // Capture WHO served this and what they were vouched for, at the one
        // moment we actually observe it. `install_descriptor_at` has already run
        // the signature gate fail-closed, so reaching here means it verified.
        //
        // `orgVerified` is read from the descriptor but only *counts* when the
        // source is the official marketplace — `TrustPolicy::resolve_trust`
        // enforces that, because any other source asserting the flag is just
        // publisher-controlled JSON.
        let provenance = crate::plugins::isolation::PluginProvenance {
            source_id: Some(descriptor.source_id.clone()),
            publisher_org: descriptor
                .raw
                .get("publisherOrg")
                .and_then(|v| v.as_str())
                .map(str::to_owned),
            org_verified: descriptor
                .raw
                .get("orgVerified")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            org_verified_tier: descriptor
                .raw
                .get("orgVerifiedTier")
                .and_then(|v| v.as_str())
                .map(str::to_owned),
            signature_verified: descriptor
                .raw
                .get("signature_verified")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            builtin: false,
            captured_at: Some(chrono::Utc::now().to_rfc3339()),
            ..crate::plugins::isolation::PluginProvenance::default()
        };
        return Ok((manifest, ui_code, provenance));
    }

    Err(first_err.unwrap_or_else(|| {
        (
            StatusCode::BAD_GATEWAY,
            format!("`{id}` was not found in any plugin catalog source"),
        )
    }))
}

/// Undo ONE plugin install performed earlier in this same request: remove the
/// on-disk manifest directory, drop the lifecycle row, and reload so no in-memory
/// manifest outlives the files behind it.
///
/// Deliberately best-effort and infallible: a rollback runs *because* an install
/// already failed, and letting the cleanup error mask the real failure would hide
/// the reason the user's install refused. Every step is logged instead.
///
/// The id is re-validated before it is used as a path component — the ONE place
/// that check is enforced for this path, so a rollback triggered by a manifest that
/// failed id validation inside `persist_installed_plugin` can never be turned into
/// a directory traversal.
pub(in crate::server) async fn rollback_plugin_install(state: &ServerState, id: &str) {
    if crate::plugin_manifest::validate_plugin_id(id).is_err() {
        tracing::warn!(plugin = %id, "refusing to roll back a plugin with an invalid id");
        return;
    }
    let plugin_dir = crate::plugin_manifest::PluginManifestLoader::plugins_dir()
        .join(crate::plugin_manifest::plugin_dir_name(id));
    if plugin_dir.exists() {
        if let Err(e) = tokio::fs::remove_dir_all(&plugin_dir).await {
            tracing::warn!(plugin = %id, "rollback: failed to remove plugin directory: {e}");
        }
    }
    if let Err(e) = state.app_store.remove(id).await {
        tracing::warn!(plugin = %id, "rollback: failed to remove lifecycle record: {e}");
    }
    reload_manifests_inner(state).await;
    tracing::info!(plugin = %id, "rolled back a partial plugin install");
}

/// `GET /api/plugins/:id/ui-bundle` — serve an ENABLED plugin's bundled
/// sandboxed-UI code. Returns `{ "code": "<module source>" }` for an enabled
/// plugin that carries a bundle, else **404** (a disabled/unapproved plugin's
/// code is never served, so an operator cannot be tricked into running the UI of
/// a plugin whose grants the Gateway has not validated). The host base64-inlines
/// the returned code into the null-origin iframe; the plugin never fetches this.
#[utoipa::path(
    get,
    path = "/api/plugins/{id}/ui-bundle",
    tag = "Plugins",
    summary = "Serve a plugin's UI bundle",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn plugin_ui_bundle(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    // Enabled-state gate: only an ENABLED plugin's UI is served.
    let record = match state.app_store.get(&id).await {
        Ok(Some(rec)) => rec,
        Ok(None) => {
            return json_error(StatusCode::NOT_FOUND, "plugin not enabled".to_owned());
        }
        Err(e) => {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    };
    if !record.enabled {
        return json_error(StatusCode::NOT_FOUND, "plugin not enabled".to_owned());
    }
    match state.app_store.get_ui_code(&id).await {
        Ok(Some(code)) => Json(json!({ "code": code })).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "plugin has no UI bundle".to_owned()),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `POST /api/apps/reload` — re-scan built-ins + `~/.ryu/apps/*/ryu.json` and
/// replace the in-memory manifest set. Idempotent.
#[utoipa::path(
    post,
    path = "/api/plugins/reload",
    tag = "Plugins",
    summary = "Reload plugin manifests from disk",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn reload_app_manifests(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    // A reload swaps the runtime manifest set (new on-disk manifests go live), so
    // it is an app update on a managed node.
    if let Err(response) = enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_UPDATE,
    )
    .await
    {
        return response;
    }
    reload_manifests_inner(&state).await;
    Json(json!({ "success": true })).into_response()
}

/// `POST /api/plugins/activation-event` — fire a command activation event so
/// `onCommand:<id>`-gated plugins wake when the desktop command palette (WF2)
/// invokes a plugin-contributed slash command.
///
/// Core today has **no** command-invocation endpoint of its own — plugin slash
/// commands are surfaced read-only via `GET /api/plugins/contributions` and are
/// dispatched from the desktop palette, a separate process that cannot call the
/// in-process `fire_activation_event` fn across the boundary. This endpoint is
/// that seam: the palette POSTs `{ "event": "onCommand:<id>" }` when it runs a
/// command, and the gated plugins activate.
///
/// Scoped deliberately to the `onCommand:` prefix so it stays the onCommand
/// seam and cannot be used to spoof `onStartup`/`onChat`/arbitrary events. The
/// firing is awaited here (this is not the hot chat path) and is idempotent.
#[utoipa::path(
    post,
    path = "/api/plugins/activation-event",
    tag = "Plugins",
    summary = "Fire a plugin activation event",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn fire_activation_event_handler(
    State(state): State<ServerState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let event = body.get("event").and_then(|v| v.as_str()).unwrap_or("");
    if !event.starts_with("onCommand:") || event == "onCommand:" {
        return Json(json!({
            "success": false,
            "error": "event must be of the form 'onCommand:<id>'",
        }));
    }
    fire_activation_event(&state, event).await;
    Json(json!({ "success": true, "event": event }))
}

/// Re-load all manifests from disk and swap the in-memory set. `load_all()`
/// returns the two lanes directly (not a `Result`), so this never fails; a parse
/// error in one manifest only drops that manifest with a logged warning.
///
/// BOTH lanes are swapped. Refreshing only the runtime list would leave
/// `incompatible_manifests` frozen at whatever boot found: a plugin installed
/// mid-session that this node cannot run would be missing from the marketplace
/// until a restart (the very "it just vanished" behaviour the lane exists to end),
/// and one that became compatible — because the user updated Core and the manifests
/// were reloaded — would keep its stale "Unavailable" pill.
pub(in crate::server) async fn reload_manifests_inner(state: &ServerState) {
    let mut loaded = crate::plugin_manifest::PluginManifestLoader::load_all();
    loaded.compatible = crate::plugin_manifest::PluginManifestLoader::load_runtime();
    let count = loaded.compatible.len();
    let held_back = loaded.incompatible.len();
    // Ordered: the runtime list first, so no window exists in which a plugin is
    // absent from BOTH lanes and a concurrent catalog read renders it nowhere.
    {
        let mut lock = state.app_manifests.write().await;
        *lock = loaded.compatible;
    }
    {
        let mut lock = state.incompatible_manifests.write().await;
        *lock = loaded.incompatible;
    }
    tracing::info!("app manifests hot-reloaded: {count} loaded, {held_back} held back");
}

/// Compute the set of MCP tool name slugs claimed by disabled apps.
///
/// A grant entry has the form `"mcp:<tool_slug>"`. This function scans every
/// loaded manifest, looks up its enabled/disabled state, and builds two sets:
///
/// - `disabled_claimed` — slugs claimed by at least one *disabled* app.
/// - `enabled_claimed`  — slugs claimed by at least one *enabled* app.
///
/// The caller uses these to decide visibility: a tool is filtered out only when
/// it is claimed by a disabled app and NOT claimed by any enabled app.
///
/// ## Why "claimed by any enabled app wins"
///
/// Two apps may legitimately declare the same grant (e.g. both a Research app and
/// a Summariser app declare `mcp:web_search`). If either is enabled, the tool
/// should be discoverable — removing it only when the last claimant is disabled.
pub(in crate::server) fn app_tool_claim_sets(
    manifests: &[crate::plugin_manifest::PluginManifest],
    lifecycle: &[crate::plugins::PluginRecord],
) -> (
    std::collections::HashSet<String>,
    std::collections::HashSet<String>,
) {
    let mut disabled_claimed: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut enabled_claimed: std::collections::HashSet<String> = std::collections::HashSet::new();

    for m in manifests {
        let enabled = lifecycle
            .iter()
            .find(|r| r.id == m.id)
            .map_or(false, |r| r.enabled);

        for grant in &m.permission_grants {
            // Permission grants for MCP tools follow the "mcp:<tool_slug>" convention.
            if let Some(slug) = grant.strip_prefix("mcp:") {
                if enabled {
                    enabled_claimed.insert(slug.to_owned());
                } else {
                    disabled_claimed.insert(slug.to_owned());
                }
            }
        }
    }

    (disabled_claimed, enabled_claimed)
}

/// Collect the tool-hide patterns declared by **enabled** plugins
/// (`contributes.tool_filters`).
///
/// This is the declarative half of a tool firewall, and it is strictly better than
/// the `pre_tool_use` + [`HookDirective::Deny`] half for anything a plugin knows
/// statically: `Deny` fires only once the model has already chosen the tool and
/// spent a round-trip on it, so the user pays latency and tokens for a call that
/// was never going to run. Removing the tool from the offered list means the model
/// never sees it and never tries.
///
/// Only enabled plugins contribute. A disabled plugin that kept hiding tools would
/// be invisible policy — the user disabled it precisely to stop it acting.
///
/// Hiding is NOT a security boundary and must not be read as one: it changes what
/// is advertised, not what is permitted. A tool that is hidden is still callable by
/// id, and enforcement stays with permissions, grants, and the approval gate.
///
/// [`HookDirective::Deny`]: crate::plugin_host::HookDirective::Deny
pub(in crate::server) fn app_tool_hide_filters(
    manifests: &[crate::plugin_manifest::PluginManifest],
    lifecycle: &[crate::plugins::PluginRecord],
) -> Vec<ryu_kernel_contracts::manifest::ToolFilterContribution> {
    manifests
        .iter()
        .filter(|m| {
            lifecycle
                .iter()
                .find(|r| r.id == m.id)
                .is_some_and(|r| r.enabled)
        })
        .filter_map(|m| m.contributes.as_ref())
        .flat_map(|c| c.tool_filters.iter().cloned())
        .collect()
}
