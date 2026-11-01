//! `canonicalize_dependency_ids` — the dependency-edge half of legacy-id
//! canonicalization, shared by the local loader and catalog fetches.

use super::{canonicalize_dependency_ids, PluginManifest};

fn manifest_requiring(dep: &str) -> PluginManifest {
    serde_json::from_value(serde_json::json!({
        "id": "@ryu/clips",
        "name": "Clips",
        "version": "0.1.15",
        "runnables": [],
        "requires": { "apps": [{ "id": dep, "min_version": "0.1.14" }] }
    }))
    .expect("test manifest parses")
}

#[test]
fn legacy_dependency_ids_are_rewritten_to_canonical() {
    let mut manifest = manifest_requiring("shadow");
    canonicalize_dependency_ids(&mut manifest);
    let dep = &manifest.dependencies()[0];
    assert_eq!(dep.id, "@ryu/shadow");
    assert_eq!(dep.min_version.as_deref(), Some("0.1.14"));
    // The manifest's own id is untouched: callers compare it to the requested id.
    assert_eq!(manifest.id, "@ryu/clips");
}

#[test]
fn canonical_dependency_ids_are_left_alone() {
    let mut manifest = manifest_requiring("@ryu/spaces");
    canonicalize_dependency_ids(&mut manifest);
    assert_eq!(manifest.dependencies()[0].id, "@ryu/spaces");
}
