//! App lifecycle handlers: isolation, revocation, install, enable, activation, contributions and policies: `plugin_widget_apps` through `policy_requires_respawn`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// The `widget_apps` rows of [`plugin_contributions`]: every enabled app that
/// declares chat widgets, and whether it holds `widget:render`.
pub(in crate::server) fn plugin_widget_apps(
    manifests: &[crate::plugin_manifest::PluginManifest],
    enabled_records: &std::collections::HashMap<String, crate::plugins::PluginRecord>,
) -> Vec<serde_json::Value> {
    let mut widget_apps: Vec<serde_json::Value> = Vec::new();
    for manifest in manifests.iter() {
        let Some(record) = enabled_records.get(&manifest.id) else {
            continue;
        };
        let declared = manifest
            .contributes
            .as_ref()
            .map(|c| c.widgets.len())
            .unwrap_or(0);
        if declared == 0 {
            continue;
        }
        widget_apps.push(json!({
            "plugin_id": manifest.id,
            "name": manifest.name,
            "widget_count": declared,
            "granted": record
                .approved_grants
                .iter()
                .any(|g| g == crate::sidecar::mcp::WIDGET_RENDER_GRANT),
        }));
    }
    widget_apps
}

/// The `companions` rows of [`plugin_contributions`]: the `Companion` runnables
/// of every enabled app that targets the calling surface, each with its owning
/// plugin's gateway-approved grants and whether a sandboxed-UI bundle is stored.
pub(in crate::server) fn plugin_companion_rows(
    manifests: &[crate::plugin_manifest::PluginManifest],
    enabled_records: &std::collections::HashMap<String, crate::plugins::PluginRecord>,
    surface: Option<crate::plugin_manifest::Surface>,
    ui_bundle_ids: &std::collections::HashSet<String>,
    enforce_custom_app_csp: bool,
) -> Vec<serde_json::Value> {
    let mut companions: Vec<serde_json::Value> = Vec::new();
    for manifest in manifests.iter() {
        if !surface.is_none_or(|s| manifest.supports_surface(s)) {
            continue;
        }
        let Some(record) = enabled_records.get(&manifest.id) else {
            continue;
        };
        let has_ui = ui_bundle_ids.contains(&manifest.id);
        for entry in &manifest.runnables {
            if entry.kind != crate::runnable::RunnableKind::Companion {
                continue;
            }
            let cfg: crate::plugin_manifest::schema::CompanionConfig = match entry
                .config
                .as_ref()
                .and_then(|v| serde_json::from_value(v.clone()).ok())
            {
                Some(c) => c,
                None => continue,
            };
            let trusted_manifest = crate::plugins::builtins::tier_for_manifest(manifest)
                == crate::plugin_manifest::PluginTier::Core;
            let default_csp_enforced = crate::app_security::should_enforce_default_csp(
                trusted_manifest,
                cfg.csp.is_some(),
                enforce_custom_app_csp,
            );
            companions.push(json!({
                "id": format!("app__{}", entry.id),
                "name": entry.name,
                "label": cfg.label,
                "icon": cfg.icon,
                "shortcut": cfg.shortcut,
                "plugin_id": manifest.id,
                "approved_grants": record.approved_grants,
                "has_ui": has_ui && cfg.ui_entry.is_some(),
                // Provenance, NOT trust tier and NOT privilege: whether this app's
                // manifest ships compiled into the binary (`BUILTIN_MANIFESTS`). The
                // Host attribution and first-party local form handlers use this flag;
                // CSP form-action/connect-src restrictions still apply. The
                // sandboxed frame needs a visible "Plugin · <name>" attribution bar so
                // third-party content can never be mistaken for system chrome
                // (extension-host invariant #6). A first-party app is already named by
                // the tab that opened it, so the bar is pure noise there. Deliberately
                // `is_compiled_in_manifest` and not `CORE_PLUGINS` (privilege) or
                // `find_system_plugin` (the 5 sidecar system apps) — those answer
                // different questions over different sets.
                "first_party": crate::plugins::builtins::is_exact_compiled_manifest(manifest),
                // A declared CSP can widen the sandbox egress lock, so the policy is
                // emitted only for a trusted manifest. Untrusted app declarations
                // are ignored and remain on the restricted default. The preference
                // below controls that default only for custom apps with no CSP claim.
                "csp": if trusted_manifest {
                    cfg.csp.clone()
                } else {
                    None
                },
                "default_csp_enforced": default_csp_enforced,
            }));
        }
    }
    companions
}

/// The installed app ids and the enabled records, by id, for
/// [`plugin_contributions`], from one read of the lifecycle store.
pub(in crate::server) async fn installed_and_enabled_records(
    state: &ServerState,
) -> Result<
    (
        std::collections::HashSet<String>,
        std::collections::HashMap<String, crate::plugins::PluginRecord>,
    ),
    axum::response::Response,
> {
    // Read lifecycle records once and derive both views. `store_tabs` needs the
    // INSTALLED set as well as the enabled one (it is served outside the enabled
    // filter and tags each tab with both bits), so splitting this into two `list()`
    // calls would be a second round-trip for the same rows.
    //
    // Keep the full enabled records (not just ids): the companions payload maps
    // each enabled plugin's companion to that plugin's GATEWAY-APPROVED grants,
    // which live on the record (never the manifest's `permission_grants` claim).
    let all_records = match state.app_store.list().await {
        Ok(records) => records,
        Err(e) => return Err(json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    };
    let installed_ids: std::collections::HashSet<String> =
        all_records.iter().map(|r| r.id.clone()).collect();
    let enabled_records: std::collections::HashMap<String, crate::plugins::PluginRecord> =
        all_records
            .into_iter()
            .filter(|r| r.enabled)
            .map(|r| (r.id.clone(), r))
            .collect();
    Ok((installed_ids, enabled_records))
}

/// Collect the full [`PolicyConfig`] (type + definition) of every `Policy`
/// runnable in a manifest, so [`apply_policy`] can data-drive a policy from its
/// declared `definition` (e.g. the compression service URL) rather than a
/// hardcoded value.
pub(in crate::server) fn manifest_policies(
    manifest: &crate::plugin_manifest::PluginManifest,
) -> Vec<crate::plugin_manifest::schema::PolicyConfig> {
    manifest
        .runnables
        .iter()
        .filter(|r| r.kind == crate::runnable::RunnableKind::Policy)
        .filter_map(|r| {
            r.config.as_ref().and_then(|v| {
                serde_json::from_value::<crate::plugin_manifest::schema::PolicyConfig>(v.clone())
                    .ok()
            })
        })
        .collect()
}

/// The **config-pack** payload a `firewall` policy plugin may carry in its
/// `PolicyConfig.definition`. Today the one live-swappable config-pack target is a
/// firewall pattern pack: a set of `custom_patterns` (kept as raw JSON so Core
/// stays decoupled from the gateway's `CustomPattern` type — the gateway
/// deserializes them). Absent/empty ⇒ the plugin is a pure on/off switch (the
/// built-in `firewall` fixture), exactly as before. This is the seam where a
/// policy plugin declares its bundle; enabling PUSHES the pack into the live
/// gateway config, disabling REMOVES it (see [`build_firewall_patch`]).
#[derive(serde::Deserialize, Default)]
pub(in crate::server) struct FirewallPolicyBundle {
    #[serde(default)]
    pub(in crate::server) custom_patterns: Vec<serde_json::Value>,
}

impl FirewallPolicyBundle {
    /// Parse the bundle from a policy `definition` JSON blob, tolerating extra
    /// keys (`service`, `note`, …) and a missing `custom_patterns` (→ empty pack).
    pub(in crate::server) fn from_definition(def: &serde_json::Value) -> Self {
        serde_json::from_value(def.clone()).unwrap_or_default()
    }
}

/// Read the current `[section]` table of Core's LOCAL `gateway.toml` as JSON, or
/// `{}` when the file / section is absent. Used to read-modify-write the `routing`
/// policy toggle: we mutate only `smart_routing.enabled` and PUT the section back,
/// so the toggle never resets the operator's other routing settings to defaults
/// (the gateway's `PUT /v1/config` is full-replacement per section).
///
/// NOTE — `firewall` no longer uses this: its toggle sources the section from the
/// gateway's LIVE config (`GET /v1/config` via [`crate::sidecar::gateway::fetch_config`]),
/// because Core's local toml is empty for a REMOTE gateway and a full-replacement
/// firewall PUT built from `{}` would silently downgrade enforcement (reset `policy`
/// to warn-only, wipe `locked_fields`/`inspector`/operator patterns). Routing has the
/// same-class limitation for a remote gateway (empty local toml → a defaulted
/// `routing` persisted on the remote disk), but its only live-swapped field is
/// `smart_routing.enabled`; `model_map`/`fallback_chain` are restart-only snapshots,
/// so the live toggle is unaffected. A clean routing fix needs a full-routing live
/// source (the `RoutingView` GET is lossy — it omits `eval_routing`/`modality_map`),
/// which is out of scope for this round.
///
/// Known edge (routing): a field set ONLY via a spawn-time env override with no
/// `gateway.toml` is invisible here; the dominant case — config persisted by a prior
/// PUT / the web UI — round-trips correctly.
pub(in crate::server) fn read_gateway_section(section: &str) -> serde_json::Value {
    gateway_config_path()
        .and_then(|p| std::fs::read_to_string(&p).ok())
        .and_then(|raw| toml::from_str::<toml::Value>(&raw).ok())
        .and_then(|v| v.get(section).cloned())
        .and_then(|s| serde_json::to_value(s).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| json!({}))
}

/// Build the `firewall` object for a live `PUT /v1/config` from the **live** gateway
/// firewall section (read via `GET /v1/config`, so `policy` / `locked_fields` /
/// `inspector` / operator `custom_patterns` are all present and round-trip through
/// the full-replacement PUT untouched).
///
/// Two DECOUPLED effects, keyed off whether this plugin carries a config-pack:
/// - A **pure on/off switch** (empty config-pack — the built-in `firewall` fixture)
///   drives the GLOBAL `firewall.enabled` flag to the toggle direction. This is the
///   ONE plugin shape allowed to arm/disarm the whole firewall.
/// - A **pattern-pack** plugin (non-empty config-pack) contributes ONLY its
///   `custom_patterns` (union by `name` on enable, remove-by-`name` on disable) and
///   NEVER writes `enabled` — so removing one narrow add-on pack can never silently
///   disarm the whole firewall (nor the patterns of every still-enabled pack). This
///   closes the "any one firewall plugin drives the global switch" finding.
///
/// Every other field of the live config is preserved. Pure so the toggle logic is
/// unit-testable without a gateway.
pub(in crate::server) fn build_firewall_patch(
    mut firewall: serde_json::Value,
    enabled: bool,
    bundle: &FirewallPolicyBundle,
) -> serde_json::Value {
    if !firewall.is_object() {
        firewall = json!({});
    }
    // A pattern-pack plugin (carries its own `custom_patterns`) contributes only
    // patterns; a pure switch (empty pack) owns the global `enabled` flag. They are
    // mutually exclusive by construction, so `is_pattern_pack` cleanly selects which
    // effect this toggle applies.
    let is_pattern_pack = !bundle.custom_patterns.is_empty();
    let obj = firewall.as_object_mut().expect("object");
    if !is_pattern_pack {
        obj.insert("enabled".to_owned(), json!(enabled));
    }

    // The names contributed by this pack — dropped first (idempotent re-apply /
    // clean removal), then re-added only when enabling.
    let pack_names: std::collections::HashSet<String> = bundle
        .custom_patterns
        .iter()
        .filter_map(|p| p.get("name").and_then(|n| n.as_str()).map(str::to_owned))
        .collect();

    let mut patterns: Vec<serde_json::Value> = obj
        .get("custom_patterns")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    patterns.retain(|p| {
        !p.get("name")
            .and_then(|n| n.as_str())
            .is_some_and(|n| pack_names.contains(n))
    });
    if enabled {
        patterns.extend(bundle.custom_patterns.iter().cloned());
    }
    obj.insert("custom_patterns".to_owned(), json!(patterns));
    firewall
}

/// Build the `routing` object for a live `PUT /v1/config`: force
/// `smart_routing.enabled` to the toggle direction, preserving every other routing
/// field (model_map, fallback_chain, the rest of smart_routing). Pure.
pub(in crate::server) fn build_routing_patch(
    mut routing: serde_json::Value,
    enabled: bool,
) -> serde_json::Value {
    if !routing.is_object() {
        routing = json!({});
    }
    let obj = routing.as_object_mut().expect("object");
    let smart = obj.entry("smart_routing").or_insert_with(|| json!({}));
    if !smart.is_object() {
        *smart = json!({});
    }
    smart
        .as_object_mut()
        .expect("object")
        .insert("enabled".to_owned(), json!(enabled));
    routing
}

/// Whether a gateway policy type still needs a process **respawn** to take effect,
/// vs the live config-push path. Only `compression` does: its config is env-only
/// (`GATEWAY_COMPRESSION_*`, not in the gateway's `ConfigPatch`), so it rides the
/// spawn-env → respawn path. `firewall` and `routing` are hot-swapped via
/// `PUT /v1/config` (no respawn), closing the Round-A "toggle doesn't take effect
/// remotely" gap. Pure so the respawn-vs-push split is unit-testable.
pub(in crate::server) fn policy_requires_respawn(policy_type: &str) -> bool {
    matches!(policy_type, "compression")
}
