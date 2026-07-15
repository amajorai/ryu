//! The `plugin.json` manifest model and loader — the shared definition every
//! binding uses to author, validate, and load Ryu plugin bundles.
//!
//! Mirrors `apps/core/src/plugin_manifest/mod.rs` (the pure-data + validation
//! slice). Built-in manifest discovery and the apps→plugins dual-read fallback
//! are reproduced so a binding can enumerate installed plugins identically to
//! Core.

use std::collections::HashSet;
use std::path::PathBuf;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::runnable::{validate_runnable, RunnableEntry, RunnableMeta};

/// Maximum length of a plugin `id`.
const MAX_PLUGIN_ID_LEN: usize = 128;

/// File names a plugin manifest may use on disk, in preference order. The
/// canonical name is `plugin.json`; the legacy `ryu.json` is still read so
/// plugins installed before the apps→plugins rename keep loading.
const MANIFEST_FILE_NAMES: &[&str] = &["plugin.json", "ryu.json"];

/// An installable Ryu plugin manifest (`plugin.json`).
///
/// Mirrors `PluginManifest` in `apps/core/src/plugin_manifest/mod.rs`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PluginManifest {
    /// Reverse-domain unique identifier (e.g. `"com.example.my-plugin"`).
    pub id: String,
    /// Human-readable display name shown in the plugin store / launcher.
    pub name: String,
    /// Semver version string (e.g. `"1.0.0"`).
    pub version: String,
    /// The Runnables this plugin bundles.
    #[serde(default)]
    pub runnables: Vec<RunnableEntry>,
    /// Permission grants this plugin declares it needs (e.g. `"mcp:web_search"`).
    /// Declarations only — grant enforcement is the Gateway's responsibility.
    #[serde(default)]
    pub permission_grants: Vec<String>,
    /// Optional Companion surface (an in-desktop overlay or sidebar panel).
    #[serde(default)]
    pub companion: Option<CompanionSurface>,
    /// Plugin-to-plugin dependencies. Absent means *no dependencies* — the plugin
    /// enables standalone, which is the behaviour of every manifest predating this
    /// field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires: Option<Requires>,
    /// Host surfaces this plugin runs on. An **empty/absent** list means the plugin
    /// runs on *every* surface — the backward-compatible default, which MUST NOT be
    /// read as "hidden".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub targets: Vec<Surface>,
}

/// Plugin-to-plugin dependencies, resolved into a topological enable order by Core.
///
/// Distinct from the `engines.ryu` requirement, which constrains plugin→**Core**;
/// `requires` constrains plugin→**plugin**.
///
/// Mirrors `Requires` in `apps/core/src/plugin_manifest/mod.rs`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct Requires {
    /// Other plugins that must be installed (and are auto-enabled, in dependency
    /// order) before this one can enable.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub apps: Vec<AppDependency>,
    /// Permission grants implied by the dependencies. Declaration only — the Gateway
    /// remains the sole authority on what a grant *allows*.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub grants: Vec<String>,
}

/// A single plugin-to-plugin dependency edge.
///
/// Mirrors `AppDependency` in `apps/core/src/plugin_manifest/mod.rs`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AppDependency {
    /// The `id` of the plugin this one depends on.
    pub id: String,
    /// Optional **minimum** version the dependency must satisfy.
    ///
    /// A bare version (`"1.2.0"`) is a *minimum*, i.e. `">=1.2.0"` — deliberately NOT
    /// semver's default caret (`^1.2.0`), which would reject `2.0.0`. Explicit
    /// comparator syntax (`">=1.2, <2"`, `"^1.2"`, `"~1.2"`) is honoured verbatim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_version: Option<String>,
}

/// A host surface a plugin can declare support for via `targets`.
///
/// `core` is the headless node (a Core running with no UI at all).
///
/// Mirrors `Surface` in `apps/core/src/plugin_manifest/mod.rs`. The kebab-case tokens
/// are the wire format and must stay byte-identical to Core's.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum Surface {
    /// The Ryu Gateway.
    Gateway,
    /// A headless Core node (no UI).
    Core,
    /// The Tauri desktop app.
    Desktop,
    /// The Electron dynamic-island companion.
    Island,
    /// The Expo/React-Native mobile app.
    Mobile,
    /// The browser extension.
    Extension,
    /// The Next.js web app.
    Web,
    /// The terminal client.
    Cli,
}

impl PluginManifest {
    /// The bundled Runnable entries.
    pub fn runnables(&self) -> &[RunnableEntry] {
        &self.runnables
    }

    /// The plugin-to-plugin dependency edges this manifest declares.
    pub fn dependencies(&self) -> &[AppDependency] {
        self.requires.as_ref().map_or(&[], |r| r.apps.as_slice())
    }

    /// Whether this plugin runs on `surface`.
    ///
    /// An empty `targets` means *every* surface — never "none".
    pub fn supports_surface(&self, surface: Surface) -> bool {
        self.targets.is_empty() || self.targets.contains(&surface)
    }

    /// Only the bundled Runnables of a specific kind.
    pub fn runnables_of_kind(&self, kind: crate::runnable::RunnableKind) -> Vec<&RunnableEntry> {
        self.runnables.iter().filter(|r| r.kind == kind).collect()
    }

    /// A [`RunnableMeta`] view of each bundled Runnable.
    pub fn runnable_metas(&self) -> Vec<RunnableMeta> {
        self.runnables.iter().map(RunnableEntry::metadata).collect()
    }

    /// Parse a manifest from JSON and fully validate it (id, semver, per-kind
    /// Runnable contracts). The single entry point a binding should use when
    /// loading an untrusted manifest.
    pub fn parse_and_validate(raw: &str) -> Result<Self, String> {
        let manifest: Self =
            serde_json::from_str(raw).map_err(|e| format!("JSON parse error: {e}"))?;
        manifest.validate()?;
        Ok(manifest)
    }

    /// Validate this manifest's id, version, and every Runnable entry.
    pub fn validate(&self) -> Result<(), String> {
        validate_plugin_id(&self.id)?;
        if semver::Version::parse(&self.version).is_err() {
            return Err(format!(
                "plugin '{}' has invalid semver version '{}'",
                self.id, self.version
            ));
        }
        for entry in &self.runnables {
            validate_runnable(entry).map_err(|e| format!("plugin '{}': {e}", self.id))?;
        }
        Ok(())
    }
}

/// Companion surface descriptor — an optional in-desktop overlay or sidebar
/// panel. Mirrors `CompanionSurface` in Core.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CompanionSurface {
    /// Display label for the companion panel tab or tooltip.
    pub label: String,
    /// Icon identifier (resolved by the desktop shell).
    #[serde(default)]
    pub icon: Option<String>,
    /// Keyboard shortcut string (e.g. `"ctrl+shift+r"`).
    #[serde(default)]
    pub shortcut: Option<String>,
}

/// Validate a plugin `id` for use as both an identity key and a filesystem
/// directory name. Strict allowlist (Windows-first): rejects path separators,
/// drive qualifiers, `..`, and leading/trailing dots. Mirrors
/// `validate_plugin_id` in Core.
pub fn validate_plugin_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("plugin id must not be empty".to_string());
    }
    if id.len() > MAX_PLUGIN_ID_LEN {
        return Err(format!(
            "plugin id is too long ({} bytes, max {MAX_PLUGIN_ID_LEN})",
            id.len()
        ));
    }
    let valid_chars = id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
    if !valid_chars {
        return Err(format!(
            "plugin id '{id}' contains illegal characters (allowed: a-z A-Z 0-9 . - _)"
        ));
    }
    if id.contains("..") {
        return Err(format!("plugin id '{id}' must not contain '..'"));
    }
    if id.starts_with('.') || id.ends_with('.') {
        return Err(format!("plugin id '{id}' must not start or end with '.'"));
    }
    if id.starts_with('-') {
        return Err(format!("plugin id '{id}' must not start with '-'"));
    }
    if !id.contains('.') {
        return Err(format!(
            "plugin id '{id}' must be reverse-domain (contain at least one '.')"
        ));
    }
    Ok(())
}

/// Resolve the plugins scan directory, matching Core's resolution order:
/// 1. `RYU_PLUGINS_DIR`, 2. legacy `RYU_APPS_DIR`, 3. `~/.ryu/plugins`
/// (or legacy `~/.ryu/apps` only when the new dir is absent but legacy exists).
pub fn plugins_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("RYU_PLUGINS_DIR") {
        return PathBuf::from(p);
    }
    if let Some(p) = std::env::var_os("RYU_APPS_DIR") {
        return PathBuf::from(p);
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let ryu = home.join(".ryu");
    let new_dir = ryu.join("plugins");
    let legacy_dir = ryu.join("apps");
    if !new_dir.exists() && legacy_dir.exists() {
        return legacy_dir;
    }
    new_dir
}

/// Scan [`plugins_dir`] for user-installed manifests, returning only those that
/// pass id/semver/duplicate validation. (Built-in compiled-in manifests live in
/// Core; a binding that needs them should call Core's `GET /api/plugins`.)
pub fn load_user_plugins() -> Vec<PluginManifest> {
    let mut manifests: Vec<PluginManifest> = Vec::new();
    let mut seen_ids: HashSet<String> = HashSet::new();
    let dir = plugins_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return manifests;
    };
    for entry in entries.flatten() {
        let Some(path) = MANIFEST_FILE_NAMES
            .iter()
            .map(|name| entry.path().join(name))
            .find(|p| p.exists())
        else {
            continue;
        };
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        match PluginManifest::parse_and_validate(&raw) {
            Ok(m) if seen_ids.insert(m.id.clone()) => manifests.push(m),
            _ => {}
        }
    }
    manifests
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runnable::RunnableKind;

    #[test]
    fn validate_plugin_id_accepts_reverse_domain() {
        assert!(validate_plugin_id("com.example.research-assistant").is_ok());
        assert!(validate_plugin_id("io.ryu.ghost").is_ok());
        assert!(validate_plugin_id("com.example.my_app").is_ok());
    }

    #[test]
    fn validate_plugin_id_rejects_traversal_and_separators() {
        for bad in [
            "../../etc/cron.d/x",
            "..",
            "a/../b",
            "com/example/app",
            "com\\example\\app",
            "C:windows.x",
            "/etc/foo.bar",
            ".hidden.app",
            "app.",
            "-leading.dash",
            "",
            "no-dot",
        ] {
            assert!(
                validate_plugin_id(bad).is_err(),
                "expected '{bad}' to be rejected"
            );
        }
    }

    #[test]
    fn parse_and_validate_minimal_manifest() {
        let json = r#"{
            "id": "com.example.minimal",
            "name": "Minimal",
            "version": "0.1.0",
            "runnables": [ { "id": "agent-x", "name": "Agent X", "kind": "agent" } ]
        }"#;
        let m = PluginManifest::parse_and_validate(json).expect("should validate");
        assert_eq!(m.runnables().len(), 1);
        assert!(m.companion.is_none());
        assert!(m.permission_grants.is_empty());
        assert_eq!(m.runnable_metas()[0].kind, RunnableKind::Agent);
    }

    #[test]
    fn parse_and_validate_rejects_bad_semver_and_id_and_kind() {
        let bad_ver = r#"{"id":"com.example.x","name":"X","version":"nope","runnables":[]}"#;
        assert!(PluginManifest::parse_and_validate(bad_ver)
            .unwrap_err()
            .contains("invalid semver"));

        let bad_id = r#"{"id":"../evil","name":"X","version":"1.0.0","runnables":[]}"#;
        assert!(PluginManifest::parse_and_validate(bad_id).is_err());

        let bad_kind = r#"{"id":"com.example.x","name":"X","version":"1.0.0","runnables":[{"id":"r","name":"R","kind":"nope"}]}"#;
        assert!(PluginManifest::parse_and_validate(bad_kind)
            .unwrap_err()
            .contains("JSON parse error"));
    }

    #[test]
    fn manifest_roundtrips_through_json() {
        let json = r#"{
            "id": "com.example.multi",
            "name": "Multi",
            "version": "1.2.3",
            "runnables": [
                { "id": "t", "name": "T", "kind": "tool", "config": { "slug": "web_search" } }
            ],
            "permission_grants": ["mcp:web_search"],
            "companion": { "label": "Panel", "icon": "search" }
        }"#;
        let m = PluginManifest::parse_and_validate(json).expect("validate");
        let serialized = serde_json::to_string(&m).expect("serialize");
        let round = PluginManifest::parse_and_validate(&serialized).expect("roundtrip");
        assert_eq!(m, round);
    }

    /// `requires` and `targets` must survive a parse round-trip verbatim. This crate
    /// is a hand-maintained mirror of Core's `PluginManifest` and has drifted before,
    /// so a silent strip here would make an SDK-authored dependency simply vanish.
    #[test]
    fn requires_and_targets_survive_a_round_trip() {
        let raw = r#"{
            "id": "com.example.meetings",
            "name": "Meetings",
            "version": "1.0.0",
            "runnables": [],
            "requires": {
                "apps": [{ "id": "com.ryu.spaces", "min_version": "1.0.0" }],
                "grants": ["spaces:docs"]
            },
            "targets": ["core", "desktop"]
        }"#;

        let m = PluginManifest::parse_and_validate(raw).expect("parse");
        assert_eq!(m.dependencies().len(), 1);
        assert_eq!(m.dependencies()[0].id, "com.ryu.spaces");
        assert_eq!(m.dependencies()[0].min_version.as_deref(), Some("1.0.0"));
        assert!(m.supports_surface(Surface::Desktop));
        assert!(!m.supports_surface(Surface::Gateway));

        let round = PluginManifest::parse_and_validate(
            &serde_json::to_string(&m).expect("serialize"),
        )
        .expect("roundtrip");
        assert_eq!(m, round);
    }

    /// The backward-compatibility invariant: a manifest declaring neither field parses,
    /// has no dependencies, and runs on EVERY surface. If absent `targets` ever came to
    /// mean "matches nothing", every shipped plugin would vanish from every host.
    #[test]
    fn absent_requires_and_targets_mean_no_deps_and_all_surfaces() {
        let raw = r#"{
            "id": "com.example.legacy",
            "name": "Legacy",
            "version": "1.0.0",
            "runnables": []
        }"#;

        let m = PluginManifest::parse_and_validate(raw).expect("parse");
        assert!(m.requires.is_none());
        assert!(m.dependencies().is_empty());
        assert!(m.targets.is_empty());
        for s in [
            Surface::Gateway,
            Surface::Core,
            Surface::Desktop,
            Surface::Island,
            Surface::Mobile,
            Surface::Extension,
            Surface::Web,
            Surface::Cli,
        ] {
            assert!(m.supports_surface(s), "absent targets must mean {s:?} too");
        }
    }

    /// The kebab-case tokens are the wire format shared with Core and the
    /// `x-ryu-surface` header. A drift here is a silent no-match, not an error.
    #[test]
    fn surface_tokens_match_cores_kebab_case_wire_format() {
        let json = serde_json::to_string(&vec![
            Surface::Gateway,
            Surface::Core,
            Surface::Desktop,
            Surface::Island,
            Surface::Mobile,
            Surface::Extension,
            Surface::Web,
            Surface::Cli,
        ])
        .expect("serialize");
        assert_eq!(
            json,
            r#"["gateway","core","desktop","island","mobile","extension","web","cli"]"#
        );
    }
}
