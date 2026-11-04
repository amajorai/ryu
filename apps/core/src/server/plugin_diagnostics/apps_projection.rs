//! The installed-app projection, plugin doctor and plugin eval runs: `list_apps` through `plugin_doctor_finding`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `GET /api/apps` — list all loaded App manifests (built-ins + user-installed),
/// merged with their persisted lifecycle state (installed version, enabled flag).
///
/// Each entry includes:
/// - `id` — manifest id
/// - `kinds` — deduplicated list of [`RunnableKind`] strings bundled by this app
/// - `enabled` — current enabled flag from the lifecycle store
/// - `permission_grants` — verbatim declared grants from `ryu.json` (declarations
///   only; enforcement is Gateway scope — Core never gates calls on grants)
///
/// Returns the manifests loaded at startup via [`PluginManifestLoader`]. The list is
/// stable for the lifetime of this Core process; a restart is required for newly
/// installed apps to appear.
#[utoipa::path(
    get,
    path = "/api/plugins",
    tag = "Plugins",
    summary = "List installed plugins with state",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_apps(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
) -> Json<serde_json::Value> {
    list_apps_projection(&state, surface_from_headers(&headers), false).await
}

pub(in crate::server) async fn list_apps_projection(
    state: &ServerState,
    surface: Option<crate::plugin_manifest::Surface>,
    include_blocked: bool,
) -> Json<serde_json::Value> {
    // Attach lifecycle state to each manifest so the client knows install/enable
    // status without a separate round-trip.
    // RAW records. This is the management surface: while Safe Mode is active it
    // must still report the user's real enable state, marked `suppressed_by_safe_mode`,
    // so the Store draws a "disabled by Safe Mode" badge. Rendering the mask here
    // would show every app as off and invite the user to re-enable them one by one —
    // writing real state to undo something that was only ever a read mask.
    let lifecycle: Vec<crate::plugins::PluginRecord> =
        state.app_store.list_all_records().await.unwrap_or_default();
    let safe_mode = crate::safe_mode::is_active();

    // Surface filter (`targets`). Applied HERE, at the read boundary — never in
    // the store — so a plugin that doesn't target this surface stays installed and
    // inspectable, it just isn't listed for a host that can't run it.
    //
    // An empty/absent `targets` means EVERY surface, and an unknown/absent
    // `x-ryu-surface` header means no filter at all, so every manifest that
    // predates this field keeps listing everywhere.
    let lifecycle_by_id: HashMap<&str, &crate::plugins::PluginRecord> = lifecycle
        .iter()
        .map(|record| (record.id.as_str(), record))
        .collect();
    let manifests = state.app_manifests.read().await;
    let manifests_with_state: Vec<serde_json::Value> = manifests
        .iter()
        .filter(|m| surface.is_none_or(|s| m.supports_surface(s)))
        .filter(|m| include_blocked || !crate::fleet::is_artifact_blocked(&m.id))
        .map(|m| {
            let lc = lifecycle_by_id.get(m.id.as_str()).copied();
            let mut v = serde_json::to_value(m).unwrap_or_default();
            if let Some(obj) = v.as_object_mut() {
                obj.insert(
                    "installed".to_owned(),
                    serde_json::Value::Bool(lc.is_some()),
                );
                obj.insert(
                    "enabled".to_owned(),
                    serde_json::Value::Bool(lc.map_or(false, |r| r.enabled)),
                );
                obj.insert(
                    "installed_version".to_owned(),
                    lc.map_or(serde_json::Value::Null, |r| {
                        serde_json::Value::String(r.version.clone())
                    }),
                );
                // The release train this install FOLLOWS, which is not derivable
                // from the manifest: a plugin sitting on `1.2.0` may still be
                // pinned to `canary` and simply have no canary build yet. Null when
                // not installed, so a client renders a channel only where one is
                // actually being followed.
                obj.insert(
                    "channel".to_owned(),
                    lc.map_or(serde_json::Value::Null, |r| {
                        serde_json::Value::String(r.channel.clone())
                    }),
                );
                // The raw manifest spells `deprecated` three ways (bool, string,
                // object); hand clients the one normalised shape the catalog card
                // uses, and no key at all for a current listing.
                match m.deprecation() {
                    Some(notice) => {
                        obj.insert("deprecated".to_owned(), json!(notice));
                    }
                    None => {
                        obj.remove("deprecated");
                    }
                }
                // Safe Mode is a READ mask, so `enabled` above stays the user's own
                // choice. This is the second half of that truth: enabled, but not
                // running this boot. Only ever true for a record safe mode actually
                // holds back — the kernel tiers keep running and are not flagged.
                obj.insert(
                    "suppressed_by_safe_mode".to_owned(),
                    serde_json::Value::Bool(
                        safe_mode
                            && lc.is_some_and(|r| r.enabled)
                            && !crate::safe_mode::keeps_plugin_enabled(&m.id),
                    ),
                );
                // The grants actually APPROVED on the last successful enable — the
                // subset of the manifest's `permission_grants` that is really in
                // force. Without it the installed-plugin permissions editor had
                // nothing to check its switches against and drew every grant as
                // revoked, no matter what the record held. From the RECORD, never
                // the manifest's claim: the manifest states what the app ASKED for.
                obj.insert(
                    "approved_grants".to_owned(),
                    lc.map_or(serde_json::Value::Array(vec![]), |r| {
                        serde_json::to_value(&r.approved_grants)
                            .unwrap_or(serde_json::Value::Array(vec![]))
                    }),
                );
                // Deduplicated list of Runnable kinds bundled by this app.
                // Lets the Desktop Extensions page know at a glance what kinds of
                // Runnables the app contributes without parsing the full runnables list.
                let kinds: Vec<&str> = {
                    let mut seen = std::collections::HashSet::new();
                    m.runnables
                        .iter()
                        .filter_map(|r| {
                            let s = r.kind.as_str();
                            if seen.insert(s) {
                                Some(s)
                            } else {
                                None
                            }
                        })
                        .collect()
                };
                obj.insert(
                    "kinds".to_owned(),
                    serde_json::to_value(kinds).unwrap_or(serde_json::Value::Array(vec![])),
                );
                // Built-in system apps (Ghost, Shadow) are sidecar-managed; the
                // frontend renders a SystemAppCard and calls the sidecar endpoints
                // instead of the app-lifecycle endpoints.
                let system = crate::plugins::builtins::find_system_plugin(&m.id);
                obj.insert(
                    "built_in".to_owned(),
                    serde_json::Value::Bool(system.is_some()),
                );
                // Required for Core: the installed list must not render a Disable
                // switch or an Uninstall button for it, because both are refused
                // (403, no force). From Core's own constant for the same reason
                // `tier` is — an app cannot self-assert that it is undeletable.
                obj.insert(
                    "mandatory".to_owned(),
                    serde_json::Value::Bool(crate::plugins::builtins::is_mandatory(&m.id)),
                );
                // The "System" label: exactly what the uninstall refuses, so the
                // installed list never offers Remove for a plugin Core protects.
                obj.insert(
                    "system".to_owned(),
                    serde_json::Value::Bool(crate::plugins::builtins::is_system_labelled(&m.id)),
                );
                // Two-tier registry (#444): Core (first-party tier) vs
                // Community (opt-in). Derived from membership, so a plugin cannot
                // self-assert Core. Lets the desktop render the Core/Community split.
                obj.insert(
                    "tier".to_owned(),
                    serde_json::Value::String(
                        crate::plugins::builtins::tier_for_manifest(m)
                            .as_str()
                            .to_owned(),
                    ),
                );
                if let Some(s) = system {
                    obj.insert(
                        "sidecar_name".to_owned(),
                        serde_json::Value::String(s.sidecar_name.to_owned()),
                    );
                    obj.insert(
                        "windows_first".to_owned(),
                        serde_json::Value::Bool(s.windows_first),
                    );
                    obj.insert(
                        "local_only".to_owned(),
                        serde_json::Value::Bool(s.local_only),
                    );
                } else {
                    obj.insert("sidecar_name".to_owned(), serde_json::Value::Null);
                    obj.insert("windows_first".to_owned(), serde_json::Value::Bool(false));
                    obj.insert("local_only".to_owned(), serde_json::Value::Bool(false));
                }
                // Rich marketplace-detail contract alignment (Phase 1.5): the raw
                // manifest already serializes `tagline`/`iconUrl`/`screenshots`/
                // `category`/`license`/`privacyPolicyUrl`/`termsOfServiceUrl`/
                // `examplePrompts`/`setup` under their contract keys, and the raw
                // `runnables` (with `config`) is left intact. Only the derived
                // keys are added here so the installed-plugin surface matches the
                // detail contract with no `author`/`developer` split.
                if let Some(dev) = m.developer() {
                    obj.insert("developer".to_owned(), serde_json::Value::String(dev));
                }
                if let Some(site) = &m.homepage {
                    obj.insert(
                        "website".to_owned(),
                        serde_json::Value::String(site.clone()),
                    );
                }
                if m.capabilities.is_empty() {
                    obj.insert(
                        "capabilities".to_owned(),
                        serde_json::to_value(m.resolved_capabilities())
                            .unwrap_or(serde_json::Value::Array(vec![])),
                    );
                }
                let layers = manifest_layer_projection(m);
                if !layers.is_empty() {
                    obj.insert("layers".to_owned(), json!(layers));
                }
                if m.external {
                    obj.insert("external".to_owned(), json!(true));
                }
            }
            v
        })
        .collect();

    Json(json!({ "apps": manifests_with_state }))
}

#[derive(Debug, Default, Deserialize)]
pub(in crate::server) struct PluginDoctorQuery {
    /// Limit the runtime audit to one installed app/plugin. Omitting it audits
    /// every loaded artifact, which is useful in CI and before publishing a
    /// release.
    pub(in crate::server) id: Option<String>,
}

pub(in crate::server) fn plugin_artifact_kind(app: &serde_json::Value) -> &'static str {
    if app
        .get("kinds")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|kinds| kinds.iter().any(|kind| kind.as_str() == Some("companion")))
    {
        "app"
    } else {
        "plugin"
    }
}

pub(in crate::server) fn installed_plugin_root(plugin_id: &str) -> std::path::PathBuf {
    crate::plugin_manifest::PluginManifestLoader::plugins_dir()
        .join(crate::plugin_manifest::plugin_dir_name(plugin_id))
}

pub(in crate::server) fn inspect_plugin_evals(
    plugin_id: &str,
    artifact_kind: &str,
) -> crate::plugin_evals::ParsedSuite {
    crate::plugin_evals::inspect_package(
        &installed_plugin_root(plugin_id),
        plugin_id,
        artifact_kind,
    )
}

pub(in crate::server) fn plugin_doctor_finding(
    plugin_id: &str,
    check_id: &str,
    category: &str,
    severity: &str,
    summary: &str,
    detail: &str,
    recommended_action: &str,
    evidence: serde_json::Value,
) -> serde_json::Value {
    json!({
        "checkId": check_id,
        "category": category,
        "severity": severity,
        "pluginId": plugin_id,
        "summary": summary,
        "detail": detail,
        "recommendedAction": recommended_action,
        "canAutoFix": false,
        "source": "core-plugin-loader",
        "evidence": evidence,
    })
}
