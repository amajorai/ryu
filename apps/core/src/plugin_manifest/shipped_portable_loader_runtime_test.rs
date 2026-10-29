//! Real installed-directory resolution; no extension iframe or MCP server is run.
use super::*;

const TEST: &str = "plugin_manifest::shipped_portable_loader_runtime::shipped_portable_packages_resolve_refuse_restore_and_preserve_native_precedence";

fn copy_body_files(value: &serde_json::Value, source: &Path, destination: &Path) {
    match value {
        serde_json::Value::Object(fields) => {
            for (key, value) in fields {
                if key == "code_file" {
                    let relative = Path::new(value.as_str().unwrap());
                    assert!(relative
                        .components()
                        .all(|part| matches!(part, std::path::Component::Normal(_))));
                    let path = source.join(relative).canonicalize().unwrap();
                    assert!(path.starts_with(source));
                    let target = destination.join(relative);
                    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                    std::fs::copy(path, target).unwrap();
                } else {
                    copy_body_files(value, source, destination);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                copy_body_files(item, source, destination);
            }
        }
        _ => {}
    }
}

#[test]
fn shipped_portable_packages_resolve_refuse_restore_and_preserve_native_precedence() {
    if std::env::var_os("RYU_PORTABLE_LOADER_CHILD").is_none() {
        let dir = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--nocapture"])
            .env("RYU_PORTABLE_LOADER_CHILD", "1")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", dir.path())
            .env("RYU_PLUGINS_DIR", dir.path().join("plugins"))
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../generated/ryu-runtime/plugins-store");
    let mut packages = 0;
    let mut configs = 0;
    let incoming_ids = [
        "@ryu/functiongemma",
        "@ryu/jina-reader",
        "@ryu/kill-switch",
        "@ryu/needle3",
    ];
    let mut incoming_seen = HashSet::new();
    for cluster in ["plugins", "lsp", "external_plugins"] {
        for entry in std::fs::read_dir(source.join(cluster)).unwrap() {
            let package = entry.unwrap().path().canonicalize().unwrap();
            let portable_path = package.join("plugin.json");
            if !portable_path.is_file() {
                continue;
            }
            let portable = std::fs::read_to_string(portable_path).unwrap();
            let projected: serde_json::Value = serde_json::from_str(&portable).unwrap();
            let extension = &projected["extensions"][agent_plugin::EXTENSION_NS];
            let id = extension["id"].as_str().unwrap();
            let display = extension["displayName"].as_str().unwrap();
            let installed = tempfile::tempdir().unwrap();
            let destination = installed.path().join(plugin_dir_name(id));
            std::fs::create_dir_all(&destination).unwrap();
            std::fs::write(destination.join("plugin.json"), &portable).unwrap();
            let mcp_source = package.join("mcp.json");
            let mcp = mcp_source
                .is_file()
                .then(|| std::fs::read_to_string(&mcp_source).unwrap());
            if let Some(body) = &mcp {
                std::fs::write(destination.join("mcp.json"), body).unwrap();
            }
            let imported = agent_plugin::import_manifest(&destination, &portable).unwrap();
            assert_eq!(imported.manifest["id"], id);
            assert_eq!(imported.manifest["name"], display);
            assert_eq!(imported.manifest["version"], projected["version"]);
            assert_eq!(imported.manifest["runnables"], serde_json::json!([]));
            let baseline = PluginManifestLoader::load_runtime_from(installed.path());
            let runtime = baseline.iter().find(|manifest| manifest.id == id).unwrap();
            let reserved = crate::plugins::builtins::is_runtime_builtin(id);
            if incoming_ids.contains(&id) {
                assert!(
                    incoming_seen.insert(id.to_string()),
                    "duplicate incoming package {id}"
                );
                assert!(
                    !reserved,
                    "incoming package must resolve from its installed directory: {id}"
                );
                assert!(
                    mcp.is_none(),
                    "these native packages do not declare portable MCP servers: {id}"
                );
                // A portable identity cannot inherit the native package's egress,
                // process, or execution-control declarations from a known ID.
                assert!(
                    runtime.permission_grants.is_empty(),
                    "portable identity borrowed native grants: {id}"
                );
                assert!(
                    runtime.sidecars.is_empty(),
                    "portable identity launched native sidecars: {id}"
                );
                assert!(
                    runtime.provides.is_empty(),
                    "portable identity advertised native capabilities: {id}"
                );
                assert!(
                    runtime
                        .contributes
                        .as_ref()
                        .is_none_or(|contributes| contributes.context_menu_items.is_empty()),
                    "portable identity exposed native execution controls: {id}"
                );
            }
            if !reserved {
                assert_eq!(runtime.name, display);
                assert_eq!(runtime.version, projected["version"].as_str().unwrap());
                assert!(
                    runtime.runnables.is_empty(),
                    "portable import does not invent native runnables"
                );
            }
            if let Some(body) = &mcp {
                let spec: serde_json::Value = serde_json::from_str(body).unwrap();
                let servers = spec["mcpServers"].as_object().unwrap();
                let translated = imported.manifest["mcp_servers"].as_object().unwrap();
                assert_eq!(translated.len(), servers.len());
                for (name, server) in servers {
                    let native = &translated[name];
                    if server["type"] == "stdio" {
                        assert_eq!(native["command"], server["command"]);
                        assert_eq!(native["args"], server["args"]);
                    } else {
                        assert_eq!(native["type"], server["type"]);
                        assert_eq!(native["url"], server["url"]);
                    }
                    if !reserved {
                        assert!(runtime.mcp_servers.contains_key(name));
                    }
                    configs += 1;
                }
                assert_eq!(
                    imported.manifest["permission_grants"],
                    serde_json::json!([crate::sidecar::mcp::GRANT_MCP_SERVER])
                );
                let registry = crate::sidecar::mcp::McpRegistry::empty();
                if !reserved {
                    let before: Vec<_> = registry
                        .server_summaries()
                        .into_iter()
                        .map(|server| server.name)
                        .collect();
                    let registered = crate::sidecar::mcp::register_manifest_mcp_servers(
                        &registry,
                        runtime,
                        PluginTier::Community,
                        &[],
                    );
                    assert!(
                        registered.is_empty(),
                        "import declaration cannot self-approve MCP registration"
                    );
                    let after: Vec<_> = registry
                        .server_summaries()
                        .into_iter()
                        .map(|server| server.name)
                        .collect();
                    assert_eq!(
                        after, before,
                        "unapproved import preserves the built-in summary set"
                    );
                    for name in servers.keys() {
                        assert!(
                            registry.plugin_server_owner(name).is_none(),
                            "unapproved import has no owner for {name}"
                        );
                    }
                }
                std::fs::write(destination.join("mcp.json"), b"{not-json").unwrap();
                let refused = agent_plugin::import_manifest(&destination, &portable).unwrap();
                assert!(refused.manifest.get("mcp_servers").is_none());
                assert!(refused
                    .notes
                    .iter()
                    .any(|note| note.contains("MCP disabled")));
                if !reserved {
                    let loaded = PluginManifestLoader::load_runtime_from(installed.path());
                    assert!(loaded
                        .iter()
                        .find(|manifest| manifest.id == id)
                        .unwrap()
                        .mcp_servers
                        .is_empty());
                }
                std::fs::write(destination.join("mcp.json"), body).unwrap();
                let recovered = agent_plugin::import_manifest(&destination, &portable).unwrap();
                assert_eq!(
                    recovered.manifest["mcp_servers"],
                    imported.manifest["mcp_servers"]
                );
                if !reserved {
                    let loaded = PluginManifestLoader::load_runtime_from(installed.path());
                    let restored = loaded.iter().find(|manifest| manifest.id == id).unwrap();
                    let restored_names: HashSet<_> = restored.mcp_servers.keys().cloned().collect();
                    assert_eq!(restored_names, servers.keys().cloned().collect());
                }
            }
            std::fs::write(destination.join("plugin.json"), b"{not-json").unwrap();
            assert!(agent_plugin::import_manifest(&destination, "{not-json").is_err());
            if !reserved {
                assert!(!PluginManifestLoader::load_runtime_from(installed.path())
                    .iter()
                    .any(|manifest| manifest.id == id));
            }
            std::fs::write(destination.join("plugin.json"), &portable).unwrap();
            let restored = PluginManifestLoader::load_runtime_from(installed.path());
            assert!(restored.iter().any(|manifest| manifest.id == id));
            let authored = std::fs::read_to_string(package.join("manifest.json")).unwrap();
            let value: serde_json::Value = serde_json::from_str(&authored).unwrap();
            copy_body_files(&value, &package, &destination);
            std::fs::write(destination.join("manifest.json"), &authored).unwrap();
            // An unreadable portable sibling must not replace the canonical native manifest.
            std::fs::write(destination.join("plugin.json"), b"{not-json").unwrap();
            let native = PluginManifestLoader::load_runtime_from(installed.path());
            let resolved = native.iter().find(|manifest| manifest.id == id).unwrap();
            if !reserved {
                assert_eq!(resolved.name, value["name"].as_str().unwrap());
                assert_eq!(
                    resolved.runnables.len(),
                    value["runnables"].as_array().map_or(0, Vec::len)
                );
            }
            match id {
                "@ryu/functiongemma" | "@ryu/needle3" => {
                    assert_eq!(resolved.permission_grants, ["tool:http-egress:127.0.0.1"]);
                    assert_eq!(resolved.sidecars.len(), 1);
                    let expected_name = id.strip_prefix("@ryu/").unwrap();
                    let sidecar = serde_json::to_value(&resolved.sidecars[0]).unwrap();
                    assert_eq!(sidecar["name"], expected_name);
                    assert_eq!(sidecar["process"]["entry"], format!("ryu_{expected_name}"));
                    assert_eq!(resolved.runnables.len(), 1);
                    assert_eq!(
                        resolved.runnables[0].config.as_ref().unwrap()["slug"],
                        format!("{expected_name}.status")
                    );
                    let routes = sidecar["http"]["routes"].as_array().unwrap();
                    let predict = routes
                        .iter()
                        .find(|route| route["path"] == "/computer-use")
                        .unwrap();
                    assert_eq!(predict["method"], "POST");
                    assert_eq!(predict["permission"], format!("{expected_name}.predict"));
                    assert!(routes.iter().all(|route| route["auth"] != "public"));
                }
                "@ryu/jina-reader" => {
                    assert_eq!(
                        resolved.permission_grants,
                        ["tool:http-egress:r.jina.ai", "tool:execute"]
                    );
                    assert!(resolved.sidecars.is_empty());
                    let tool = resolved.runnables[0].config.as_ref().unwrap();
                    assert_eq!(tool["slug"], "jina_reader.fetch");
                    assert_eq!(tool["url"], "https://r.jina.ai/");
                    let providers = serde_json::to_value(&resolved.provides).unwrap();
                    assert_eq!(providers[0]["capability"], "web.extract");
                    assert_eq!(
                        providers[0]["tools"]["web.extract"]["tool"],
                        "jina_reader.fetch"
                    );
                    assert_eq!(
                        providers[0]["tools"]["web.extract"]["adapter"]["code"],
                        std::fs::read_to_string(package.join("adapters/web.extract.js")).unwrap()
                    );
                }
                "@ryu/kill-switch" => {
                    assert_eq!(resolved.permission_grants, ["execution:control"]);
                    assert!(resolved.runnables.is_empty());
                    assert!(resolved.sidecars.is_empty());
                    let actions = &resolved.contributes.as_ref().unwrap().context_menu_items;
                    assert_eq!(actions.len(), 2);
                    assert_eq!(actions[0]["capability"], "execution.pause");
                    assert_eq!(actions[1]["capability"], "execution.resume");
                    assert!(actions
                        .iter()
                        .all(|action| action["anchor"] == "conversation"));
                }
                _ => {}
            }
            println!("portable loader: {cluster}/{} id={id} reserved={reserved} namespace=identity/displayName malformed-refusal=passed restoration=passed native-precedence=passed", package.file_name().unwrap().to_string_lossy());
            packages += 1;
        }
    }
    assert_eq!(
        packages, 106,
        "update explicit package coverage when authored inventory changes"
    );
    assert_eq!(
        incoming_seen,
        incoming_ids.into_iter().map(str::to_string).collect()
    );
    assert_eq!(configs, 15);
}
