//! Production catalog projection of every unchanged authored Plugins Store manifest.
use super::*;

#[test]
fn shipped_package_cards_project_canonical_identity_and_permissions() {
    let repository = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut rows = Vec::new();
    let mut ids = std::collections::HashSet::new();
    let incoming_ids = [
        "@ryu/functiongemma",
        "@ryu/jina-reader",
        "@ryu/kill-switch",
        "@ryu/needle3",
    ];
    let mut incoming_seen = std::collections::HashSet::new();
    for cluster in ["plugins", "lsp", "external_plugins"] {
        let mut directories: Vec<_> =
            std::fs::read_dir(repository.join("generated/ryu-runtime/plugins-store").join(cluster))
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect();
        directories.sort();
        for directory in directories {
            let path = directory.join("manifest.json");
            if !path.is_file() {
                continue;
            }
            let package = directory.canonicalize().unwrap();
            let raw = std::fs::read_to_string(&path).unwrap();
            let manifest = crate::plugin_manifest::PluginManifest::parse_and_validate_with_code(
                &raw,
                |relative| {
                    let relative = std::path::Path::new(relative);
                    if relative
                        .components()
                        .any(|part| !matches!(part, std::path::Component::Normal(_)))
                    {
                        return Err("body path must stay inside its package".into());
                    }
                    let body = package
                        .join(relative)
                        .canonicalize()
                        .map_err(|error| error.to_string())?;
                    if !body.starts_with(&package) {
                        return Err("body path escapes package".into());
                    }
                    std::fs::read_to_string(body).map_err(|error| error.to_string())
                },
            )
            .unwrap();
            assert!(
                ids.insert(manifest.id.clone()),
                "duplicate canonical package identity"
            );
            let entry = plugin_manifest_to_entry(&manifest);
            assert_eq!(entry["id"], manifest.id);
            assert_eq!(entry["name"], manifest.name);
            assert_eq!(entry["version"], display_version(&manifest));
            assert_eq!(
                entry["permission_grants"],
                json!(manifest.permission_grants)
            );
            assert_eq!(
                entry["type"],
                if manifest_declares_destination(&manifest) {
                    "app"
                } else {
                    "plugin"
                }
            );
            assert_eq!(
                entry["mandatory"].as_bool().unwrap_or(false),
                crate::plugins::builtins::is_mandatory(&manifest.id)
            );
            if incoming_ids.contains(&manifest.id.as_str()) {
                assert!(incoming_seen.insert(manifest.id.clone()));
                assert_eq!(
                    entry["type"], "plugin",
                    "native tools and menu controls must not invent an app destination"
                );
                assert_eq!(entry["source"], "built-in");
                assert_eq!(entry["mandatory"].as_bool().unwrap_or(false), false);
                for private_key in [
                    "uiCode",
                    "artifact",
                    "manifest",
                    "sidecars",
                    "secret_headers",
                ] {
                    assert!(
                        entry.get(private_key).is_none(),
                        "card exposes install/runtime configuration: {} {private_key}",
                        manifest.id
                    );
                }
                let (name, grants, runnables, surfaces) = match manifest.id.as_str() {
                    "@ryu/functiongemma" => (
                        "FunctionGemma Local Planner",
                        json!(["tool:http-egress:127.0.0.1"]),
                        json!([{ "id": "tool-functiongemma-status", "kind": "tool", "name": "FunctionGemma Status" }]),
                        vec![
                            "cli",
                            "core",
                            "desktop",
                            "extension",
                            "island",
                            "mobile",
                            "web",
                        ],
                    ),
                    "@ryu/needle3" => (
                        "Needle 3 Local Planner",
                        json!(["tool:http-egress:127.0.0.1"]),
                        json!([{ "id": "tool-needle3-status", "kind": "tool", "name": "Needle 3 Status" }]),
                        vec![
                            "cli",
                            "core",
                            "desktop",
                            "extension",
                            "island",
                            "mobile",
                            "web",
                        ],
                    ),
                    "@ryu/jina-reader" => (
                        "Jina Reader",
                        json!(["tool:http-egress:r.jina.ai", "tool:execute"]),
                        json!([{ "id": "tool-jina-reader-fetch", "kind": "tool", "name": "Jina Reader Fetch" }]),
                        vec![
                            "cli",
                            "core",
                            "desktop",
                            "extension",
                            "island",
                            "mobile",
                            "web",
                        ],
                    ),
                    "@ryu/kill-switch" => (
                        "Kill Switch",
                        json!(["execution:control"]),
                        json!([]),
                        vec!["core", "desktop"],
                    ),
                    _ => unreachable!(),
                };
                assert_eq!(entry["name"], name);
                assert_eq!(entry["permission_grants"], grants);
                assert_eq!(entry["runnables"], runnables);
                let listed: std::collections::HashSet<_> = entry["surfaces"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|surface| surface.as_str().unwrap())
                    .collect();
                assert_eq!(listed, surfaces.into_iter().collect());
                if manifest.id == "@ryu/jina-reader" {
                    let extract = entry["layers"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|layer| layer["capability"] == "web.extract")
                        .unwrap();
                    assert_eq!(extract["selectable"], true);
                    assert_eq!(extract["verbs"], json!(["web.extract"]));
                }
            }
            rows.push(json!({ "package": format!("{cluster}/{}", directory.file_name().unwrap().to_string_lossy()), "entry": entry, "manifest": serde_json::from_str::<serde_json::Value>(&raw).unwrap() }));
        }
    }
    assert_eq!(rows.len(), 106, "all authored packages must be represented");
    assert_eq!(
        incoming_seen,
        incoming_ids.into_iter().map(str::to_string).collect()
    );
    let output = repository.join("docs/proof/test-coverage-sweep-20260924/parallel/plugins-runtime/full/cards/core-projection.json");
    std::fs::create_dir_all(output.parent().unwrap()).unwrap();
    std::fs::write(output, serde_json::to_string_pretty(&rows).unwrap()).unwrap();
    println!("Production card projection:106 canonical packages; incoming FunctionGemma/Jina Reader/Kill Switch/Needle3 identities, permissions, tool metadata and supported surfaces verified; no activation, provider, process or network effects");
}
