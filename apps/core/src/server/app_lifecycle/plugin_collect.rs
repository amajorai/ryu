//! App lifecycle handlers: isolation, revocation, install, enable, activation, contributions and policies: `collect_plugin_store_tabs` through `serialize_plugin_backgrounds`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Walk the manifests and collect every `store_tabs` entry, tagged with its owning
/// `plugin` id plus that app's `app_installed` / `app_enabled` bits.
///
/// # Why this one is not enabled-filtered
///
/// Every sibling contribution family is served only for ENABLED plugins, because a
/// disabled app must not drive the shell. A marketplace tab is the deliberate
/// exception: it is the surface you *install the app from*. Every built-in feature
/// app is absent from the store on a fresh machine, not merely disabled — so an
/// enabled-gated Workflows tab would vanish on
/// exactly the profile that has never installed Workflows, taking the workflow
/// template catalog with it.
///
/// The declaration is executable authority: its source/install HTTP is validated
/// against the manifest's server-resolved provenance below before the shell can see
/// it. The shell learns the app's state from the two bits stamped here and decides —
/// the desktop Store hides a tab whose app is not installed and enabled, rather than
/// showing a pill that only ever opens an enable prompt.
///
/// The SURFACE filter still applies: a shell the app does not target cannot render
/// the tab whatever its enabled bit says.
pub(in crate::server) fn collect_plugin_store_tabs(
    manifests: &[crate::plugin_manifest::PluginManifest],
    installed_ids: &std::collections::HashSet<String>,
    enabled_ids: &std::collections::HashSet<String>,
    surface: Option<crate::plugin_manifest::Surface>,
) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for manifest in manifests {
        if !surface.is_none_or(|s| manifest.supports_surface(s)) {
            continue;
        }
        let Some(c) = &manifest.contributes else {
            continue;
        };
        let Ok(http_policy) = declarative_http_policy(manifest) else {
            tracing::warn!(
                plugin = %manifest.id,
                "dropping unsafe declarative Store contributions"
            );
            continue;
        };
        for tab in &c.store_tabs {
            let Ok(mut value) = serde_json::to_value(tab) else {
                continue;
            };
            stamp_contribution_authority(manifest, &mut value, http_policy);
            let Some(obj) = value.as_object_mut() else {
                continue;
            };
            obj.insert(
                "app_installed".to_string(),
                serde_json::json!(installed_ids.contains(&manifest.id)),
            );
            obj.insert(
                "app_enabled".to_string(),
                serde_json::json!(enabled_ids.contains(&manifest.id)),
            );
            out.push(value);
        }
    }
    out
}

/// Walk the manifests and collect every `settings_tabs` entry of an **installed**
/// plugin, tagged with its owning `plugin` id and that app's `app_enabled` bit.
///
/// # Why this one is not enabled-filtered
///
/// The second deliberate exception, for the same class of reason as
/// [`collect_plugin_store_tabs`]: an enabled-gated settings tab is absent exactly
/// when the user goes looking for it. Installing a plugin does not enable it
/// (`install_app` inserts the record; `enable_app` is a separate call), so the
/// first thing a user does after installing — open its settings to paste the API
/// key it needs in order to be worth enabling — hit a plugin whose settings tab
/// did not exist yet. The configuration and the enablement are two different
/// questions, and Core was answering the first with the second.
///
/// Installed IS still required: settings write preferences for a plugin this node
/// has, and a listing nobody installed has nothing to configure.
///
/// This is safe for the same reason the store tab is: a settings tab is a
/// declaration, not an authority. Its fields bind to the generic preference KV
/// (`/api/preferences/:key`), which is not gated on any app being enabled, and a
/// disabled plugin reads its preferences only once enabled. The shell learns the
/// state from `app_enabled` and says so rather than pretending the plugin is live.
///
/// The SURFACE filter still applies, exactly as for store tabs.
pub(in crate::server) fn collect_plugin_settings_tabs(
    manifests: &[crate::plugin_manifest::PluginManifest],
    installed_ids: &std::collections::HashSet<String>,
    enabled_ids: &std::collections::HashSet<String>,
    surface: Option<crate::plugin_manifest::Surface>,
) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for manifest in manifests {
        if !installed_ids.contains(&manifest.id) {
            continue;
        }
        if !surface.is_none_or(|s| manifest.supports_surface(s)) {
            continue;
        }
        let Some(c) = &manifest.contributes else {
            continue;
        };
        for tab in &c.settings_tabs {
            let mut value = tab.clone();
            let Some(obj) = value.as_object_mut() else {
                continue;
            };
            obj.insert("plugin".to_string(), serde_json::json!(manifest.id));
            obj.insert(
                "app_enabled".to_string(),
                serde_json::json!(enabled_ids.contains(&manifest.id)),
            );
            out.push(value);
        }
    }
    out
}

/// Walk the manifests and collect every `output_styles` entry of an **enabled**
/// plugin, tagged with its owning `plugin` id.
///
/// # Why this one IS enabled-filtered
///
/// The store/settings-tab carve-outs above exist because a tab is how you reach an
/// app that is not running yet. A style is the opposite: it is a live behaviour, and
/// a disabled plugin must not be able to change how the agent talks. This is the
/// same rule `contributes.themes` follows one loop below — disabling the plugin is
/// how a user turns its contributions back off — and it agrees with the registry,
/// which drops the same styles at the disable seam
/// ([`sync_plugin_output_styles`]). Two views of the same set must not disagree
/// about membership.
///
/// # The body is deliberately not served here
///
/// Each row carries the style's parsed *metadata* and never its `source`. The body
/// is up to `MAX_OUTPUT_STYLE_BYTES` (64 KB) per style and this endpoint is polled
/// by every shell on boot, while the body's only real consumer is the registry,
/// which already received it at the enable seam; a client that wants the text has
/// `GET /api/output-styles/{id}/source`. The metadata comes out of
/// `parse_output_style_md` rather than mirrored manifest keys because design §4
/// makes the frontmatter the single source of truth for it — an unparseable
/// contribution is skipped here exactly as it is skipped at registration, so this
/// list never advertises a style the profile selector cannot assign.
pub(in crate::server) fn collect_plugin_output_styles(
    manifests: &[crate::plugin_manifest::PluginManifest],
    enabled_ids: &std::collections::HashSet<String>,
    surface: Option<crate::plugin_manifest::Surface>,
) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for manifest in manifests {
        if !enabled_ids.contains(&manifest.id) {
            continue;
        }
        if !surface.is_none_or(|s| manifest.supports_surface(s)) {
            continue;
        }
        let Some(c) = &manifest.contributes else {
            continue;
        };
        for style in &c.output_styles {
            let Some(source) = style.source.as_deref() else {
                continue;
            };
            let Ok(record) = ryu_output_styles::parse_output_style_md(&style.id, source) else {
                continue;
            };
            out.push(serde_json::json!({
                "plugin": manifest.id,
                "id": record.id,
                "name": record.name,
                "description": record.description,
                "keep_coding_instructions": record.keep_coding_instructions,
                "force_for_plugin": record.force_for_plugin,
            }));
        }
    }
    out
}

pub(in crate::server) fn collect_plugin_chat_widget_templates(
    manifests: &[crate::plugin_manifest::PluginManifest],
    enabled_ids: &std::collections::HashSet<String>,
    surface: Option<crate::plugin_manifest::Surface>,
) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for manifest in manifests {
        if !enabled_ids.contains(&manifest.id)
            || !surface.is_none_or(|s| manifest.supports_surface(s))
        {
            continue;
        }
        let Some(templates) = manifest
            .contributes
            .as_ref()
            .and_then(|contributes| contributes.chat_widget_templates.as_ref())
        else {
            continue;
        };
        for template in templates {
            if let Ok(mut value) = serde_json::to_value(template) {
                if let Some(object) = value.as_object_mut() {
                    object.insert("plugin".to_owned(), json!(manifest.id));
                }
                out.push(value);
            }
        }
    }
    out
}

pub(in crate::server) fn tag_plugin_contribution(
    mut value: serde_json::Value,
    plugin_id: &str,
    approved_grants: &[String],
) -> serde_json::Value {
    if let Some(object) = value.as_object_mut() {
        object.insert("plugin".to_owned(), serde_json::json!(plugin_id));
        object.insert(
            "approved_grants".to_owned(),
            serde_json::json!(approved_grants),
        );
    }
    value
}

pub(in crate::server) const MAX_PLUGIN_BACKGROUND_ROWS_PER_RESPONSE: usize = 256;
/// Mirrors `MAX_CONTRIBUTED_INTERFACES` in `@ryuhq/protocol/interfaces`.
pub(in crate::server) const MAX_PLUGIN_INTERFACE_ROWS_PER_RESPONSE: usize = 64;

pub(in crate::server) fn serialize_plugin_interfaces(
    contributes: &crate::plugin_manifest::Contributes,
    tag: &impl Fn(serde_json::Value) -> serde_json::Value,
    limit: usize,
) -> Vec<serde_json::Value> {
    contributes
        .interfaces
        .iter()
        .take(limit)
        .filter_map(|interface| serde_json::to_value(interface).ok())
        .map(tag)
        .collect()
}

pub(in crate::server) fn serialize_plugin_backgrounds(
    contributes: &crate::plugin_manifest::Contributes,
    tag: &impl Fn(serde_json::Value) -> serde_json::Value,
    limit: usize,
) -> Vec<serde_json::Value> {
    contributes
        .backgrounds
        .iter()
        .take(limit)
        .filter_map(|background| serde_json::to_value(background).ok())
        .map(tag)
        .collect()
}
