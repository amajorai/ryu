//! App catalog browse, install-from-URL and hot reload: `install_plugin_from_catalog` through `install_plugin_from_catalog`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/plugins/catalog/install { id }` — the marketplace/URL sink for a
/// signed Plugin (the missing CODE CARRIAGE endpoint). Resolves the active Plugin
/// catalog source's `install_descriptor` for `id`, which (in `catalog_source`)
/// runs `verify_manifest_signature` AND the fail-closed ui_code integrity gate
/// (`sha256(ui_code)` must match the SIGNED manifest's `ui_code_sha256`, else the
/// resolve errors and nothing is installed). Only the VALIDATED manifest + ui_code
/// reach here (in `descriptor.raw`), so this handler just persists them through
/// the SAME sink `install-bundle` uses. An unsigned item resolves with `ui_code`
/// null (a benign summary). The buyer bearer is forwarded when present for
/// optional Marketplace account-aware operations.
#[utoipa::path(
    post,
    path = "/api/plugins/catalog/install",
    tag = "Plugins",
    summary = "Install a plugin from the marketplace catalog",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn install_plugin_from_catalog(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<PluginCatalogInstallBody>,
) -> axum::response::Response {
    if let Err(response) = enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_INSTALL,
    )
    .await
    {
        return response;
    }

    let id = body.id.trim().to_string();
    if id.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "`id` must not be empty".to_owned());
    }
    // Normalized once: `stable` and an absent channel are the same request, and a
    // channel is compared case-insensitively everywhere else.
    let channel: Option<String> = body
        .channel
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty() && !c.eq_ignore_ascii_case(crate::update::STABLE_CHANNEL))
        .map(str::to_ascii_lowercase);
    let version = body
        .version
        .as_deref()
        .map(str::trim)
        .filter(|version| !version.is_empty())
        .map(str::to_owned);
    if version.as_ref().is_some_and(|value| {
        value.len() > 128
            || !value
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || ".-+vV".contains(character))
    }) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "`version` must be a semver release tag".to_owned(),
        );
    }
    if channel.is_some() && version.is_some() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "choose either `channel` or an exact `version`, not both".to_owned(),
        );
    }

    // Forward the caller's bearer to the Marketplace install handoff for optional
    // account-aware commerce. EVERY dependency resolved below goes through the
    // SAME `install_descriptor` seam with the SAME bearer, so a dependency clears
    // the identical signature + ui_code-integrity checks as the plugin the user
    // actually clicked. Pricing is not an access gate for the target or its deps.
    let buyer_token = buyer_bearer_from_headers(&headers);

    // The installed set: both the dependency graph's "already satisfied" side and
    // the duplicate-install guard.
    let installed: Vec<crate::plugin_manifest::PluginManifest> =
        state.app_manifests.read().await.clone();
    if installed.iter().any(|m| m.id == id) {
        // Same 409 `persist_installed_plugin` would raise. Checked FIRST because an
        // already-installed target resolves to an EMPTY plan below, which would
        // otherwise report a phantom success.
        return json_error(
            StatusCode::CONFLICT,
            format!("Plugin '{id}' is already installed"),
        );
    }

    // ── Phase 1: DISCOVERY — walk `requires` and fetch what is not installed ──
    //
    // Breadth-first over the declared edges, from the target. An INSTALLED plugin
    // contributes its own manifest (never refetched, never reinstalled); anything
    // else is resolved from the catalog. The `visited` set makes the walk terminate
    // on cyclic catalog data — the cycle is then *reported* by the resolver in
    // phase 2 rather than hanging here.
    let mut fetched: Vec<crate::plugin_manifest::PluginManifest> = Vec::new();
    let mut ui_codes: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    // Captured per resolved id so the install sink can persist WHO served each
    // manifest — including dependencies, which are installed on the user's behalf
    // and would otherwise land with no provenance at all (i.e. untrusted).
    let mut provenances: std::collections::HashMap<
        String,
        crate::plugins::isolation::PluginProvenance,
    > = std::collections::HashMap::new();
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut queue: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    queue.push_back(id.clone());

    while let Some(next) = queue.pop_front() {
        if !visited.insert(next.clone()) {
            continue;
        }
        if visited.len() > crate::plugins::catalog::MAX_INSTALL_CLOSURE {
            return json_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                format!(
                    "`{id}` pulls in more than {} plugins; refusing the install",
                    crate::plugins::catalog::MAX_INSTALL_CLOSURE
                ),
            );
        }

        let manifest = if let Some(m) = installed.iter().find(|m| m.id == next) {
            m.clone()
        } else {
            // The requested channel applies to the plugin the user actually chose.
            // Its dependencies resolve on their own default train — see the note on
            // `resolve_plugin_from_catalog`.
            let dep_channel = (next == id).then_some(channel.as_deref()).flatten();
            let dep_version = (next == id).then_some(version.as_deref()).flatten();
            match resolve_plugin_from_catalog(
                &state,
                &next,
                buyer_token.clone(),
                dep_channel,
                dep_version,
            )
            .await
            {
                Ok((m, ui_code, provenance)) => {
                    provenances.insert(next.clone(), provenance);
                    // A source that answers a request for `next` with a manifest for
                    // some OTHER id would let a dependency name be swapped for an
                    // arbitrary plugin. Refuse.
                    if m.id != next {
                        return json_error(
                            StatusCode::BAD_GATEWAY,
                            format!("catalog returned manifest `{}` for `{next}`", m.id),
                        );
                    }
                    if let Some(code) = ui_code {
                        ui_codes.insert(next.clone(), code);
                    }
                    fetched.push(m.clone());
                    m
                }
                // The TARGET must resolve — that is exactly today's hard failure,
                // with today's status code.
                Err((status, msg)) if next == id => return json_error(status, msg),
                // A DEPENDENCY no source can serve is simply left OUT of the graph.
                // The resolver in phase 2 then reports it as a typed
                // `MissingDependency` naming who needs it and the version they need
                // — one definition of that error, rendered by the desktop already.
                Err((_, msg)) => {
                    tracing::warn!(
                        plugin = %next,
                        "plugin dependency could not be resolved from any catalog source: {msg}"
                    );
                    continue;
                }
            }
        };

        for dep in manifest.dependencies() {
            if !visited.contains(&dep.id) {
                queue.push_back(dep.id.clone());
            }
        }
    }

    // ── Phase 2: PLAN — topological order, cycles/versions/missing deps ───────
    //
    // Delegates to `plugins::graph::resolve_enable_order` (via the catalog planner):
    // one resolver, one semver rule, one cycle detector. Nothing has touched disk
    // yet, so a refusal here installs NOTHING — the whole point.
    let order = match crate::plugins::catalog::plan_install_closure(&id, &installed, &fetched) {
        Ok(order) => order,
        Err(e) => {
            // 409 + the typed payload, the SAME envelope `enable_app_handler` uses,
            // so the desktop's existing `describeDependencyError` renders it with no
            // client change ("Meetings needs Spaces (1.2.0 or newer)").
            return (
                StatusCode::CONFLICT,
                Json(json!({
                    "success": false,
                    "error": e.to_string(),
                    "dependency_error": e,
                })),
            )
                .into_response();
        }
    };

    // ── Phase 3: INSTALL the closure in order, rolling back on any failure ────
    let outcome = crate::plugins::catalog::install_closure(
        order,
        |manifest| {
            let state = state.clone();
            let ui_code = ui_codes.get(&manifest.id).cloned();
            let provenance = provenances.get(&manifest.id).cloned();
            // The SAME sink the single-plugin path used: validate → write manifest →
            // reload → lifecycle record (installed, DISABLED). Enabling stays with
            // `enable_app`, which runs its own dependency closure over what we just
            // made present.
            async move { persist_installed_plugin(&state, manifest, ui_code, provenance).await }
        },
        |plugin_id| {
            let state = state.clone();
            async move { rollback_plugin_install(&state, &plugin_id).await }
        },
    )
    .await;

    let target_name = fetched
        .iter()
        .find(|manifest| manifest.id == id)
        .map(|manifest| manifest.name.clone())
        .unwrap_or_else(|| id.clone());

    match outcome {
        Ok(installed_plugins) => {
            let canonical = provenances
                .get(&id)
                .and_then(|provenance| provenance.source_id.as_deref())
                .and_then(|source_id| {
                    state
                        .catalog_sources
                        .source_by_id(crate::catalog_source::CatalogKind::Plugin, source_id)
                })
                .is_some_and(|source| source.is_canonical_marketplace());
            if canonical {
                crate::stats_beacon::witness_public_marketplace_install("plugin", &id).await;
                if let Some(manifest) = fetched.iter().find(|manifest| manifest.id == id) {
                    crate::stats_beacon::witness_runtime_definition(
                        "plugin",
                        &id,
                        &manifest.id,
                        manifest,
                    );
                }
                crate::stats_beacon::record_marketplace_event("plugin", &id, true);
            }
            let dependencies: Vec<&str> = installed_plugins
                .iter()
                .map(|(pid, _)| pid.as_str())
                .filter(|pid| *pid != id)
                .collect();
            // The TARGET's body, additively augmented — the existing client contract
            // (`{ success, app: {…}, has_ui }`) is unchanged; a dependency install is
            // new information alongside it, not a new shape.
            let mut body = installed_plugins
                .iter()
                .find(|(pid, _)| *pid == id)
                .map(|(_, value)| value.clone())
                .unwrap_or_else(|| json!({ "success": true }));
            // Pin the train the user chose so `POST /api/plugins/:id/update`
            // re-resolves on it. Only the TARGET is pinned — a dependency was
            // resolved on its own default channel, so recording anything else on it
            // would be a lie the update path would then act on.
            //
            // Best-effort: the plugin IS installed at this point, and failing the
            // whole install over the preference write would be worse than an install
            // that follows stable. The channel is still reported below, from the
            // record, so a client never renders a pin that was not stored.
            if let Some(channel) = channel.as_deref() {
                if let Err(e) = state.app_store.set_channel(&id, Some(channel)).await {
                    tracing::warn!(plugin = %id, "installed on `{channel}` but could not persist the channel pin: {e}");
                }
            }
            let pinned = state
                .app_store
                .get(&id)
                .await
                .ok()
                .flatten()
                .map(|r| r.channel)
                .unwrap_or_else(|| crate::update::STABLE_CHANNEL.to_owned());
            if let Some(obj) = body.as_object_mut() {
                obj.insert("installed_dependencies".to_owned(), json!(dependencies));
                obj.insert("channel".to_owned(), json!(pinned));
            }
            crate::events::publish_system_notification(
                "App installed",
                format!("{target_name} is installed and ready to enable."),
                "success",
            );
            Json(body).into_response()
        }
        Err(failure) => {
            let (status, msg) = failure.error;
            // A member that failed part-way through `persist_installed_plugin` (e.g.
            // the manifest was written but the lifecycle row was not) is undone too,
            // so the closure is all-or-nothing. Never on a 409: that status means the
            // plugin was ALREADY there, and rolling it back would delete something
            // this request did not create.
            if status != StatusCode::CONFLICT {
                rollback_plugin_install(&state, &failure.failed).await;
            }
            let undone = if failure.rolled_back.is_empty() {
                String::new()
            } else {
                format!(" (rolled back: {})", failure.rolled_back.join(", "))
            };
            let message = if failure.failed == id {
                format!("{msg}{undone}")
            } else {
                format!(
                    "dependency `{}` of `{id}` failed to install: {msg}{undone}",
                    failure.failed
                )
            };
            json_error(status, message)
        }
    }
}
