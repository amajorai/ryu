//! The `plugin.json` manifest model + loader — the shared definition every
//! binding uses to author, validate, and load Ryu plugin bundles.
//!
//! The manifest **types and validation** (`PluginManifest`, `Surface`,
//! `Requires`, `AppDependency`, `CompanionSurface`, `validate_plugin_id`, and the
//! `parse_and_validate`/`validate` methods) now have a single definition in the
//! `ryu-kernel-contracts` crate, which `apps/core` also depends on. This module
//! re-exports them so the SDK and Core validate against one identical contract
//! (no more drift), and keeps only the SDK-local **disk discovery** helpers
//! ([`plugins_dir`], [`load_user_plugins`]) here — those do filesystem I/O, which
//! the pure-data contract crate deliberately does not.

use std::collections::HashSet;
use std::path::PathBuf;

pub use ryu_kernel_contracts::manifest::{
    validate_plugin_id, AppDependency, CompanionSurface, PluginManifest, Requires, Surface,
};

/// File names a plugin manifest may use on disk, in preference order. The
/// canonical name is `plugin.json`; the legacy `ryu.json` is still read so
/// plugins installed before the apps→plugins rename keep loading.
const MANIFEST_FILE_NAMES: &[&str] = &["plugin.json", "ryu.json"];

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
    fn validate_plugin_id_accepts_reverse_domain_and_bare() {
        assert!(validate_plugin_id("com.example.research-assistant").is_ok());
        assert!(validate_plugin_id("io.ryu.ghost").is_ok());
        assert!(validate_plugin_id("com.example.my_app").is_ok());
        // Ending the drift: the canonical id rule (shared with Core, whose built-in
        // ids are bare-kebab like `ghost`) does NOT require a dot. A bare id that is
        // not a traversal/separator is valid.
        assert!(validate_plugin_id("ghost").is_ok());
        assert!(validate_plugin_id("no-dot").is_ok());
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

    /// `requires` and `targets` must survive a parse round-trip verbatim. This used
    /// to be a hand-maintained mirror of Core's `PluginManifest` that had drifted;
    /// it now shares Core's exact definition, so this guards the shared contract.
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
