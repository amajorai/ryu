//! App lifecycle handlers (M3 / U033).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Skill CRUD/version/activate handlers moved to `ryu_skills::api` ───────────
//
// The `/api/skills` list + `/api/skills/:id` source/update + version-history +
// `/api/skills/activate` handlers now live in the extracted `ryu-skills` crate
// (`ryu_skills::api`, merged in `skills_routes`). The `catalog`/`updates`/
// `install-from-source` handlers stay Core-side (download-center + catalog_source
// + buyer-token coupled) — see their definitions further below.

// ── App lifecycle handlers (M3 / U033) ───────────────────────────────────────

/// Find a manifest by `id` from the loaded set. This is a synchronous helper
/// used by handlers that hold a read guard.
pub(in crate::server) async fn find_manifest(
    state: &ServerState,
    id: &str,
) -> Option<crate::plugin_manifest::PluginManifest> {
    let manifests = state.app_manifests.read().await;
    manifests.iter().find(|m| m.id == id).cloned().or_else(|| {
        // Opt-in built-in apps are intentionally absent from the runtime
        // manifest set until installed. They still need to resolve through
        // the built-in install endpoint. External-repository apps carry their
        // Companion through the verified package/standalone carriage. Keep
        // runtime activation unchanged: this is a read-only manifest lookup
        // for the install/enable handlers.
        crate::plugin_manifest::PluginManifestLoader::load_install_catalog()
            .into_iter()
            .find(|m| m.id == id)
    })
}

/// Load the node's host-access trust policy (preferences + local revocations).
/// See [`crate::plugins::isolation::load_trust_policy`] for the fail-safe rules.
pub(in crate::server) async fn load_trust_policy(
    state: &ServerState,
) -> crate::plugins::isolation::TrustPolicy {
    crate::plugins::isolation::load_trust_policy(Some(&state.app_store)).await
}

/// Whether Core must refuse to enable `manifest` or run its host-access lanes:
/// a local revocation, or the opt-in trust requirement with no trust basis.
/// Reads the RAW record so the decision uses the installed version and
/// provenance, never a Safe-Mode-masked view.
pub(in crate::server) async fn plugin_host_access_refusal(
    state: &ServerState,
    manifest: &crate::plugin_manifest::PluginManifest,
) -> Option<crate::plugins::isolation::HostAccessRefusal> {
    plugin_host_access_refusal_in(&state.app_store, manifest).await
}

/// [`plugin_host_access_refusal`] over the lifecycle store alone, for callers
/// that hold store parts rather than a whole [`ServerState`].
pub(in crate::server) async fn plugin_host_access_refusal_in(
    app_store: &PluginStore,
    manifest: &crate::plugin_manifest::PluginManifest,
) -> Option<crate::plugins::isolation::HostAccessRefusal> {
    let record = app_store.get_record(&manifest.id).await.ok().flatten();
    let version = record
        .as_ref()
        .map_or(manifest.version.as_str(), |r| r.version.as_str());
    let provenance = record.as_ref().and_then(|r| r.provenance.as_ref());
    crate::plugins::isolation::load_trust_policy(Some(app_store))
        .await
        .host_access_refusal(manifest, version, provenance)
}

/// `GET /api/plugins/isolation` — which installed plugins run sandboxed, which
/// run with full host access, and on whose authority.
///
/// Answers the question nothing else in Core could: a manifest's declared
/// `permissions` block is enforced on the JS sandbox lane and only *recorded* on the
/// native sidecar lane, so "this plugin declares permissions" has never implied
/// "those permissions are enforced". Each report separates the two facts —
/// `enforcement` is about the lane's mechanism, `host_access` is about trust.
#[utoipa::path(
    get,
    path = "/api/plugins/isolation",
    tag = "Plugins",
    responses((status = 200, description = "Per-plugin isolation and trust report"))
)]
pub(in crate::server) async fn plugins_isolation_handler(
    State(state): State<ServerState>,
) -> axum::response::Response {
    let policy = load_trust_policy(&state).await;
    let revocations = state.app_store.list_revocations().await.unwrap_or_default();
    // The RAW, Safe-Mode-unmasked read, deliberately. This is a management/report
    // surface (it spawns, injects and routes nothing), and it is the one caller for
    // which the masked read would actively lie: under Safe Mode every record reports
    // `enabled = false`, so a report on what is INSTALLED would describe an empty
    // machine. Each row carries its own `enabled` bit instead.
    let records = match state.app_store.list_all_records().await {
        Ok(r) => r,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let manifests = state.app_manifests.read().await;
    let mut reports = Vec::with_capacity(records.len());
    let mut manifests_missing = 0_usize;
    for record in &records {
        // An installed plugin whose manifest is not loaded must still appear. It is
        // precisely the row someone auditing isolation would want to see, and
        // dropping it would make `summary.total` count what was reported rather than
        // what is installed — a report that silently under-reports.
        let Some(manifest) = manifests.iter().find(|m| m.id == record.id) else {
            manifests_missing += 1;
            let trust = policy.resolve_trust(&record.id, record.provenance.as_ref());
            let revoked = policy.revocation_for(&record.id, &record.version);
            reports.push(json!({
                "id": record.id,
                "name": record.id,
                "version": record.version,
                "enabled": record.enabled,
                // No manifest ⇒ no lane list can be derived. That is unknown, NOT
                // "declares nothing", so `fully_sandboxed` is null rather than true.
                "lanes": [],
                "fully_sandboxed": serde_json::Value::Null,
                "unenforceable_lanes": [],
                "trust": trust,
                "host_access": serde_json::Value::Null,
                "manifest_loaded": false,
                "revoked": revoked,
                "refused_by_policy": revoked.is_some(),
            }));
            continue;
        };
        let report =
            crate::plugins::isolation::resolve(manifest, record.provenance.as_ref(), &policy);
        let refusal =
            policy.host_access_refusal(manifest, &record.version, record.provenance.as_ref());
        let refused = refusal.is_some();
        let revoked = policy.revocation_for(&record.id, &record.version);
        let mut value = serde_json::to_value(&report).unwrap_or_else(|_| json!({}));
        if let Some(obj) = value.as_object_mut() {
            obj.insert("enabled".to_owned(), json!(record.enabled));
            obj.insert("version".to_owned(), json!(record.version));
            obj.insert("manifest_loaded".to_owned(), json!(true));
            // Surfaced per-plugin so a client never has to re-derive the policy
            // decision from the flag plus the verdict.
            obj.insert("refused_by_policy".to_owned(), json!(refused));
            obj.insert("refusal".to_owned(), json!(refusal));
            obj.insert("revoked".to_owned(), json!(revoked));
        }
        reports.push(value);
    }
    let unvetted = reports
        .iter()
        .filter(|r| r["host_access"]["state"] == "unvetted")
        .count();
    let sandboxed = reports
        .iter()
        .filter(|r| r["fully_sandboxed"] == json!(true))
        .count();
    Json(json!({
        "plugins": reports,
        "summary": {
            // Every INSTALLED plugin, including any whose manifest is not loaded —
            // those are counted separately rather than dropped.
            "total": reports.len(),
            "fully_sandboxed": sandboxed,
            "host_access_unvetted": unvetted,
            "manifests_missing": manifests_missing,
        },
        // Hooks that failed since their last success, with circuit-breaker state
        // (`open: true` = currently skipped). In-memory, cheap, process-local.
        "hook_breakers": crate::plugin_host::breaker::snapshot(),
        "policy": {
            "require_trust_for_host_access": policy.require_trust_for_host_access,
            "trusted_ids": policy.trusted_ids.iter().collect::<Vec<_>>(),
        },
        // The node's local revocation list. A revoked plugin reads as disabled to
        // every runtime consumer and cannot be enabled until the entry is removed.
        "revocations": revocations,
        // Stated in the payload so no client has to infer it: the native sidecar
        // lane has no isolation mechanism at all today. `unenforceable_lanes` is a
        // statement about Ryu, not about the plugin or the user.
        "note": "sidecar, mcp_server, pi_extension and lsp_server lanes have no OS-level \
                 isolation in this build; turn hooks, capability adapters and UI bundles are \
                 mechanically sandboxed",
    }))
    .into_response()
}

/// `GET /api/plugins/revocations` — the node's local plugin revocation list.
pub(in crate::server) async fn list_plugin_revocations_handler(
    State(state): State<ServerState>,
) -> axum::response::Response {
    match state.app_store.list_revocations().await {
        Ok(revocations) => Json(json!({ "revocations": revocations })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// Body for `POST /api/plugins/revocations`.
#[derive(serde::Deserialize)]
pub(in crate::server) struct RevokePluginBody {
    pub(in crate::server) id: String,
    /// Revoke only this installed version (`id@version`); omit for every version.
    #[serde(default)]
    pub(in crate::server) version: Option<String>,
    #[serde(default)]
    pub(in crate::server) reason: Option<String>,
    /// Required to revoke a load-bearing plugin, as for a disable.
    #[serde(default)]
    pub(in crate::server) force: bool,
}

/// `POST /api/plugins/revocations` — revoke an installed plugin on this node.
///
/// A revoked plugin reads as disabled to every runtime consumer (hooks, adapters,
/// sidecars, MCP servers, Pi extensions, routes) and the lifecycle refuses to
/// enable it. Its persisted enabled bit and grants are left untouched, so removing
/// the revocation and enabling it again restores the user's choice. If it is
/// running now, its runtime contributions are torn down immediately.
///
/// A revocation switches a plugin off, so it honours the same tiers as a disable:
/// a mandatory plugin (compiled into Core, so no publisher can compromise it) is
/// refused outright, and a load-bearing one needs `force`.
pub(in crate::server) async fn revoke_plugin_handler(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<RevokePluginBody>,
) -> axum::response::Response {
    if let Err(response) = enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_DISABLE,
    )
    .await
    {
        return response;
    }
    let id = body.id.trim();
    if let Err(e) = crate::plugin_manifest::validate_plugin_id(id) {
        return json_error(StatusCode::UNPROCESSABLE_ENTITY, e);
    }
    if crate::plugins::builtins::is_mandatory(id) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "success": false,
                "error": format!("app '{id}' is required for Ryu to run and cannot be revoked"),
                "code": "mandatory",
                "hint": "this app is part of Core; force does not override it",
            })),
        )
            .into_response();
    }
    if !body.force && crate::plugins::builtins::is_load_bearing(id) {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "success": false,
                "error": format!("app '{id}' is load-bearing and cannot be revoked without force"),
                "code": "load_bearing",
                "hint": "retry with force: true to revoke anyway (this breaks a core function)",
            })),
        )
            .into_response();
    }
    let revocation = match state
        .app_store
        .revoke(id, body.version.as_deref(), body.reason.as_deref())
        .await
    {
        Ok(revocation) => revocation,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let record = state.app_store.get_record(id).await.ok().flatten();
    let now_revoked = record.as_ref().is_some_and(|r| {
        crate::plugins::isolation::revocation_matches(&revocation.entry, &r.id, &r.version)
    });
    if now_revoked && record.as_ref().is_some_and(|r| r.enabled) {
        if let Some(manifest) = find_manifest(&state, id).await {
            deactivate_plugin(&state, &manifest).await;
            state.realtime.broadcast_event(
                "system:plugins",
                "plugin.contributions.changed",
                json!({"type": "contributions_changed"}),
            );
        }
    }
    Json(json!({
        "success": true,
        "revocation": revocation,
        "applies_to_installed_version": now_revoked,
    }))
    .into_response()
}

/// Body for `DELETE /api/plugins/revocations`.
#[derive(serde::Deserialize)]
pub(in crate::server) struct UnrevokePluginBody {
    /// The exact entry to remove (`id` or `id@version`).
    pub(in crate::server) entry: String,
}

/// `DELETE /api/plugins/revocations` — remove one revocation entry. The plugin
/// is not re-activated automatically; enable it again (or restart Core).
pub(in crate::server) async fn unrevoke_plugin_handler(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<UnrevokePluginBody>,
) -> axum::response::Response {
    if let Err(response) = enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_ENABLE,
    )
    .await
    {
        return response;
    }
    match state.app_store.unrevoke(body.entry.trim()).await {
        Ok(removed) => Json(json!({ "success": true, "removed": removed })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}
