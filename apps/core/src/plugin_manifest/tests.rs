use super::schema::validate_runnable;
use super::*;
use crate::runnable::RunnableKind;

const SAMPLE_JSON: &str = include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/sample/manifest.json");

/// Every apps-store satellite compiled into the hermetic test catalog must also
/// be in the production runtime set; a test-only satellite cannot be installed
/// offline by id (Life Recorder regressed exactly this way).
#[test]
fn every_test_catalog_satellite_is_registered_for_production() {
    let runtime: HashSet<String> = PluginManifestLoader::load_runtime_builtins_for_test()
        .into_iter()
        .map(|manifest| manifest.id)
        .collect();
    let apps_store = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps-store");
    let mut missing = Vec::new();
    for raw in BUILTIN_MANIFESTS {
        let Ok(manifest) = serde_json::from_str::<PluginManifest>(raw) else {
            continue;
        };
        let Some(name) = manifest.id.strip_prefix("@ryu/") else {
            continue;
        };
        if apps_store.join(name).join("manifest.json").is_file() && !runtime.contains(&manifest.id)
        {
            missing.push(manifest.id);
        }
    }
    assert!(
        missing.is_empty(),
        "apps-store satellites missing from CORE_RUNTIME_BUILTIN_MANIFESTS: {missing:?}"
    );
}

/// The multi-kind fixture lives in `apps/core/tests/manifest_fixtures/` so it
/// doubles as the integration-test input and the in-module round-trip fixture.
const MULTI_KIND_JSON: &str = include_str!("../../tests/manifest_fixtures/multi_kind.ryu.json");

#[cfg(unix)]
#[test]
fn package_file_reader_rejects_symlink_escapes_for_every_file_carriage() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().expect("tempdir");
    let package = temp.path().join("plugin");
    for dir in [
        "hooks",
        "adapters",
        "output-styles",
        "pi-extensions",
        "real",
    ] {
        std::fs::create_dir_all(package.join(dir)).expect("create package dir");
    }
    let external = temp.path().join("outside.txt");
    std::fs::write(&external, "private host data").expect("write external file");

    for rel in [
        "hooks/leak.js",
        "adapters/leak.js",
        "output-styles/leak.md",
        "pi-extensions/leak.ts",
    ] {
        symlink(&external, package.join(rel)).expect("create external symlink");
        let error = read_contained_package_file(&package, rel)
            .expect_err("external symlink must be rejected");
        assert!(error.contains("escapes package root"), "{rel}: {error}");
    }

    std::fs::write(package.join("real/body.js"), "return { kind: 'none' };")
        .expect("write in-root body");
    symlink("../real/body.js", package.join("hooks/inside.js")).expect("create in-root symlink");
    assert_eq!(
        read_contained_package_file(&package, "hooks/inside.js")
            .expect("in-root symlink is allowed"),
        "return { kind: 'none' };"
    );
}

/// Core-owned port bases — the ports Core's own substrate binds (llama.cpp and
/// friends, whisper, TTS, sd.cpp, restate, the SDK adapter). A manifest sidecar
/// landing on one fights a Core process for the socket and whoever starts second
/// loses. A literal list rather than imports of each provider's const, so this is a
/// second independent record of the map: if a provider const moves, the mismatch
/// surfaces here as a review question instead of silently agreeing with itself.
const CORE_RESERVED_PORTS: &[u16] = &[
    3200,  // sidecar::adapters::sdk DEFAULT_SDK_APP_PORT
    7980,  // tool_exec CORE_BASE_PORT
    8000,  // vllm / omlx DEFAULT_PORT
    8080,  // restate http + ingress (and llama.cpp)
    8081,  // llamacpp embed
    8082,  // llamacpp rerank
    8083,  // llamacpp CLASSIFY_PORT_BASE
    8084,  // mlx_vlm
    8085,  // ryutts TTS_PORT
    8086,  // mlx DEFAULT_PORT_BASE
    8088,  // llamacpp SPEECH_PROCESSING_PORT_BASE
    8089,  // apfel APFEL_PORT_BASE
    8090,  // whisper.cpp WHISPER_PORT_BASE
    8091,  // audio.cpp AUDIOCPP_PORT_BASE
    8092,  // llamacpp guard GUARD_PORT_BASE (node hazard screener)
    8099,  // node_screener DECISION_SCREENER_PORT_BASE (systemone)
    8101,  // sd.cpp SD_PORT_BASE
    9070,  // restate admin
    30000, // sglang
];

/// Known, pre-existing overlaps with [`CORE_RESERVED_PORTS`]. Real debt, frozen so
/// it cannot grow — a NEW overlap fails the test, these do not. Fixing one means
/// moving the app's port and deleting its row.
const KNOWN_CORE_OVERLAPS: &[(&str, u16)] = &[
    // finetune's Unsloth trainer vs mlx's DEFAULT_PORT_BASE. Latent: both are
    // opt-in and rarely resident at the same time.
    ("@ryu/finetune", 8086),
];

/// Return every packaged manifest directory with its root-qualified path.
/// Ordinary apps live directly under `apps-store`; plugins are grouped by
/// manifest category under `plugins-store/{plugins,lsp,external_plugins}`.
fn packaged_dirs(repo_root: &std::path::Path, root: &str) -> Vec<(String, std::path::PathBuf)> {
    let categories: Vec<(String, std::path::PathBuf)> = if root == "plugins-store" {
        ["plugins", "lsp", "external_plugins"]
            .into_iter()
            .map(|category| {
                (
                    format!("{root}/{category}"),
                    repo_root.join("generated/ryu-runtime").join(root).join(category),
                )
            })
            .collect()
    } else {
        vec![(root.to_owned(), repo_root.join("generated/ryu-runtime").join(root))]
    };

    let mut dirs = Vec::new();
    for (qualified_root, category_dir) in categories {
        let Ok(entries) = std::fs::read_dir(category_dir) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let dir = entry.path();
            if !dir.join("manifest.json").is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            dirs.push((format!("{qualified_root}/{name}"), dir));
        }
    }
    dirs.sort_by(|left, right| left.0.cmp(&right.0));
    dirs
}

/// Two built-in manifests must never declare the same sidecar port, and a built-in
/// must never squat a port Core itself binds.
///
/// This guard did not exist until 2026-08-11, and by then `simulator` + `teams`
/// were both on 7994 and `tuition` had been authored pre-collided with
/// `mission-control` on 8007 (that one was resolved the same day by moving
/// mission-control). The port map lived in prose — `BUILTIN_MANIFESTS`
/// still records that "8007 was contested by three concurrently built apps" —
/// which is a comment doing a registry's job. Nothing catches a collision until
/// `SidecarManager::claim_port` refuses at runtime, and the symptom there is an app
/// that will not start rather than anything naming a port.
///
/// A test only works for the set we own; a third-party app cannot be told to pick
/// differently. The allocator that fixes that case is designed in
/// `docs/port-allocation.md` and is not built.
#[test]
fn builtin_sidecar_ports_are_unique() {
    let mut owners: std::collections::HashMap<u16, String> = std::collections::HashMap::new();
    for manifest in PluginManifestLoader::load_builtins() {
        for spec in &manifest.sidecars {
            let owner = format!("{}/{}", manifest.id, spec.name);
            if let Some(prev) = owners.insert(spec.port, owner.clone()) {
                panic!(
                    "port {} is declared by BOTH '{prev}' and '{owner}' — pick a free \
                         port (band map: docs/port-allocation.md)",
                    spec.port
                );
            }
            if CORE_RESERVED_PORTS.contains(&spec.port)
                && !KNOWN_CORE_OVERLAPS.contains(&(manifest.id.as_str(), spec.port))
            {
                panic!(
                    "'{owner}' declares port {}, which Core's own substrate binds — pick \
                         a port outside CORE_RESERVED_PORTS",
                    spec.port
                );
            }
        }
    }
}

#[test]
fn feedback_board_is_compiled_in_but_opt_in() {
    let manifest = PluginManifestLoader::load_builtins()
        .into_iter()
        .find(|manifest| manifest.id == "@ryu/feedback-board")
        .expect("Feedback Board manifest must be registered");
    let http = manifest.sidecars[0]
        .http
        .as_ref()
        .expect("Feedback Board must declare an HTTP surface");
    assert_eq!(http.public_mount.as_deref(), Some("/feedback"));
    assert_eq!(manifest.sidecars[0].port, 8076);
    assert!(!crate::plugins::builtins::CORE_PREINSTALLED.contains(&"@ryu/feedback-board"));
}

const CUSTOM_ADAPTER_MANIFEST: &str = r#"{
        "id": "com.example.search",
        "name": "Example Search",
        "version": "0.1.0",
        "permission_grants": ["tool:execute"],
        "runnables": [{
            "id": "tool-example-search", "name": "Example Search", "kind": "tool",
            "config": { "slug": "example.search", "backend": "http", "method": "POST",
                        "url": "https://api.example.com/search" }
        }],
        "provides": [{
            "capability": "web.search", "version": "1.0.0", "selectable": true,
            "tools": { "web.search": { "tool": "example.search",
                       "adapter": { "code_file": "adapters/web.search.js" } } }
        }]
    }"#;

#[test]
fn package_manifest_hydrates_a_custom_adapter_from_its_directory() {
    let package = tempfile::tempdir().expect("create package");
    std::fs::create_dir(package.path().join("adapters")).expect("adapters dir");
    std::fs::write(
        package.path().join("adapters/web.search.js"),
        "return await callTool({ q: input.query });",
    )
    .expect("write adapter");

    let manifest = parse_package_manifest(CUSTOM_ADAPTER_MANIFEST, package.path())
        .expect("a file-backed custom adapter must load");
    let adapter = manifest.provides[0].tools["web.search"]
        .adapter
        .as_ref()
        .expect("adapter");
    assert!(adapter.code.contains("callTool"));
    assert!(adapter.code_file.is_none());
}

#[cfg(unix)]
#[test]
fn package_manifest_refuses_an_adapter_symlink_out_of_the_package() {
    let outside = tempfile::tempdir().expect("create outside dir");
    let secret = outside.path().join("secret.js");
    std::fs::write(&secret, "host-private data").expect("write outside file");
    let package = tempfile::tempdir().expect("create package");
    std::fs::create_dir(package.path().join("adapters")).expect("adapters dir");
    std::os::unix::fs::symlink(&secret, package.path().join("adapters/web.search.js"))
        .expect("symlink adapter");

    let err = parse_package_manifest(CUSTOM_ADAPTER_MANIFEST, package.path())
        .expect_err("a symlink escaping the package must not be hydrated");
    assert!(err.contains("escapes package root"), "{err}");
}

#[test]
fn runtime_loading_reserves_trusted_ids_without_promoting_disk_packages() {
    let root = tempfile::tempdir().expect("create plugin directory");
    let disk_plugin = root.path().join("spoofed-core");
    std::fs::create_dir(&disk_plugin).expect("create plugin package");
    std::fs::write(
        disk_plugin.join(MANIFEST_FILE_NAME),
        r#"{
                "id": "@ryu/ghost",
                "name": "Spoofed Ghost",
                "version": "99.0.0",
                "runnables": []
            }"#,
    )
    .expect("write spoofed manifest");

    let runtime = PluginManifestLoader::load_runtime_from(root.path());

    let ghosts: Vec<_> = runtime
        .iter()
        .filter(|manifest| manifest.id == "@ryu/ghost")
        .collect();
    assert_eq!(
        ghosts.len(),
        1,
        "a disk manifest must not replace the trusted id"
    );
    assert_eq!(ghosts[0].name, "Ghost");
    assert_eq!(
        crate::plugins::builtins::tier_for("@ryu/ghost"),
        PluginTier::Core
    );
}

#[test]
fn runtime_loading_keeps_every_mandatory_core_manifest_without_disk_packages() {
    let root = tempfile::tempdir().expect("create empty plugin directory");
    let runtime = PluginManifestLoader::load_runtime_from(root.path());

    for id in crate::plugins::builtins::MANDATORY_PLUGINS {
        assert!(
            runtime.iter().any(|manifest| manifest.id == *id),
            "mandatory Core manifest '{id}' must be available before marketplace materialization"
        );
    }

    assert!(
        runtime
            .iter()
            .any(|manifest| manifest.id == crate::plugins::builtins::ENGINES_PLUGIN_ID),
        "the engines provider must accompany the mandatory RAG runtime"
    );
}

#[test]
fn preinstalled_cloud_search_is_selectable_without_displacing_the_exa_default() {
    use crate::plugins::binding::{BindingConfig, BindingRegistry};
    let preinstalled: Vec<PluginManifest> = CORE_RUNTIME_BUILTIN_MANIFESTS
        .iter()
        .map(|raw| serde_json::from_str::<PluginManifest>(raw).unwrap())
        .filter(|manifest| {
            crate::plugins::builtins::CORE_PREINSTALLED.contains(&manifest.id.as_str())
        })
        .collect();
    let cloud = preinstalled
        .iter()
        .find(|manifest| manifest.id == "@ryu/cloud-search")
        .expect("Ryu Cloud Search ships pre-installed");
    let provides = cloud
        .provided_capabilities()
        .iter()
        .find(|entry| entry.capability == "web.search")
        .expect("Ryu Cloud Search provides web.search");
    assert!(provides.selectable);
    assert!(!provides.default_provider);
    assert!(crate::plugins::builtins::CORE_PLUGINS.contains(&"@ryu/cloud-search"));

    let defaults = BindingConfig::default();
    assert_eq!(
        BindingRegistry::new(&defaults, &preinstalled)
            .resolve_by_name("web.search")
            .unwrap()
            .provider_id,
        "@ryu/exa"
    );
    let chosen = BindingConfig {
        overrides: [("web.search".to_owned(), "@ryu/cloud-search".to_owned())].into(),
    };
    assert_eq!(
        BindingRegistry::new(&chosen, &preinstalled)
            .resolve_by_name("web.search")
            .unwrap()
            .provider_id,
        "@ryu/cloud-search"
    );
}

#[test]
fn production_runtime_manifest_set_contains_the_core_owned_substrate() {
    let ids: HashSet<String> = CORE_RUNTIME_BUILTIN_MANIFESTS
        .iter()
        .map(|raw| {
            serde_json::from_str::<PluginManifest>(raw)
                .expect("production runtime manifest must parse")
                .id
        })
        .collect();

    for id in crate::plugins::builtins::MANDATORY_PLUGINS
        .iter()
        .copied()
        .chain(std::iter::once(crate::plugins::builtins::ENGINES_PLUGIN_ID))
        .chain(crate::plugins::builtins::CORE_PREINSTALLED.iter().copied())
    {
        assert!(
            ids.contains(id),
            "production Core must embed runtime manifest '{id}'"
        );
    }
}

#[test]
fn production_runtime_includes_the_opt_in_meetings_install_target() {
    let ids: HashSet<String> = CORE_RUNTIME_BUILTIN_MANIFESTS
        .iter()
        .map(|raw| {
            serde_json::from_str::<PluginManifest>(raw)
                .expect("production runtime manifest must parse")
                .id
        })
        .collect();

    assert!(
        ids.contains("@ryu/meetings"),
        "Meetings is a Core-tier install target and must be available to the Store"
    );
}

#[test]
fn production_runtime_includes_the_opt_in_activity_install_target() {
    let ids: HashSet<String> = CORE_RUNTIME_BUILTIN_MANIFESTS
        .iter()
        .map(|raw| {
            serde_json::from_str::<PluginManifest>(raw)
                .expect("production runtime manifest must parse")
                .id
        })
        .collect();

    assert!(
        ids.contains("@ryu/activity"),
        "Activity is a Core-tier install target and must be available to the Store"
    );
}

#[test]
fn production_runtime_includes_opt_in_companion_install_targets() {
    let ids: HashSet<String> = CORE_RUNTIME_BUILTIN_MANIFESTS
        .iter()
        .map(|raw| {
            serde_json::from_str::<PluginManifest>(raw)
                .expect("production runtime manifest must parse")
                .id
        })
        .collect();

    for id in ["@ryu/autopilot", "@ryu/skill-editor"] {
        assert!(
            ids.contains(id),
            "{id} is a Core-tier install target and must be available to the Store"
        );
    }
}

#[test]
fn production_runtime_includes_every_core_companion_carriage() {
    let ids: HashSet<String> = CORE_RUNTIME_BUILTIN_MANIFESTS
        .iter()
        .map(|raw| {
            serde_json::from_str::<PluginManifest>(raw)
                .expect("production runtime manifest must parse")
                .id
        })
        .collect();

    for spec in crate::plugins::seed::companion_ui_specs() {
        if crate::plugins::builtins::CORE_PLUGINS.contains(&spec.id) {
            assert!(
                ids.contains(spec.id),
                "Core companion '{}' has a compiled UI carriage but no production runtime manifest",
                spec.id
            );
        }
    }
}

#[test]
fn production_runtime_includes_builtin_mcp_install_targets() {
    let ids: HashSet<String> = CORE_RUNTIME_BUILTIN_MANIFESTS
        .iter()
        .map(|raw| {
            serde_json::from_str::<PluginManifest>(raw)
                .expect("production runtime manifest must parse")
                .id
        })
        .collect();

    for id in ["@ryu/scrapling", "@ryu/zvec-grep"] {
        assert!(
            ids.contains(id),
            "{id} is a built-in MCP install target and must be available to the Store"
        );
    }
}

#[test]
fn production_code_table_covers_runtime_manifest_code_files() {
    let source = include_str!("builtin_code.rs");
    let production = source
        .split_once("#[cfg(not(test))]")
        .map(|(_, rest)| rest)
        .expect("builtin_code.rs must declare a production code table");

    for raw in CORE_RUNTIME_BUILTIN_MANIFESTS {
        let manifest = serde_json::from_str::<PluginManifest>(raw)
            .expect("production runtime manifest must parse");
        for rel in manifest.code_file_refs() {
            assert!(
                production.contains(&format!("\"{}\"", manifest.id))
                    && production.contains(&format!("\"{}\"", rel)),
                "production builtin-code table is missing ({}, {})",
                manifest.id,
                rel
            );
        }
    }
}

/// Every packaged app/plugin manifest has exactly ONE home — its package
/// directory (`<root>/<x>/manifest.json`, what the owning team edits). Only
/// the production runtime embeds the first-party defaults that are required
/// before marketplace materialization; ordinary opt-in packages are installed
/// from the signed marketplace package.
///
/// It used to be duplicated as a byte-identical fixture copy under
/// `src/plugin_manifest/fixtures/<x>.manifest.json`, purely so `apps/core` would
/// build in the OSS mirror, which ships neither package root. That copy is gone:
/// `tools/mirror-public.sh` step 1c now vendors the `manifest.json` files into the
/// published tree instead (and its step 3b refuses to emit a tree where any
/// `include_str!` path fails to resolve). So there is nothing left to keep in sync
/// and no dead-edit trap — this guard now verifies the system/package boundary.
///
/// Deliberately a DIRECTORY WALK, not a hand-maintained table. The table this
/// replaced had to be edited (and a hardcoded count bumped) for every new app,
/// which is a second list to maintain and the exact thing that drifts — a forgotten
/// row meant a manifest with NO guard at all, silently.
///
/// Read at runtime (not `include_str!`) and skipped per-root when that root is
/// absent, so the OSS Core mirror still builds and tests green.
#[test]
fn packaged_manifests_have_one_home_and_only_system_manifests_are_embedded() {
    let core = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = core.join("..").join("..");
    let fixtures = core.join("src").join("plugin_manifest").join("fixtures");

    // Reference-only plugins: they exist for a third party to fork but are
    // deliberately NOT in `BUILTIN_MANIFESTS`, so the off-chat-path hook phases
    // they demonstrate (esp. per-tool-call) stay lookup-free until a user installs
    // a plugin that actually uses them. See the `BUILTIN_MANIFESTS` comment above
    // `hook-session-context`.
    // `toolsmith-example` joins them for a different reason: it is the worked
    // example `tools/toolsmith` ships, a real verified `inline_js` tool that
    // exists so the scaffold → verify pipeline has an end-to-end regression
    // test. Registering it would put a demo in every user's catalog.
    const UNREGISTERED_BY_DESIGN: &[&str] =
        &["tool-firewall", "hook-observers", "toolsmith-example"];

    let sources: String = ["src/plugin_manifest/mod.rs", "src/sidecar/ext_proxy.rs"]
        .iter()
        .map(|rel| {
            std::fs::read_to_string(core.join(rel))
                .unwrap_or_else(|e| panic!("{rel} must be readable to check registration: {e}"))
        })
        .collect();

    let mut checked = 0;
    for (package_root, pkg_path) in packaged_dirs(&repo_root, "apps-store")
        .into_iter()
        .chain(packaged_dirs(&repo_root, "plugins-store"))
    {
        let name = pkg_path
            .file_name()
            .expect("package dir has a name")
            .to_string_lossy()
            .into_owned();
        // A resurrected duplicate is the regression this guards against: two
        // copies again means a dead-edit trap, and the fixture one would WIN
        // for any `include_str!` still pointing at `fixtures/`.
        let stale = fixtures.join(format!("{name}.manifest.json"));
        assert!(
            !stale.exists(),
            "{} is a duplicate of {package_root}/manifest.json. Packaged manifests have ONE \
                     home — the package directory — and Core includes them from there. Delete \
                     the fixture copy.",
            stale.display(),
        );

        // The manifest must parse where it lives; `include_str!` embeds bytes
        // without validating them, so a malformed package manifest would
        // otherwise compile and only fail at runtime.
        let manifest_path = pkg_path.join("manifest.json");
        let pkg_json = std::fs::read_to_string(&manifest_path)
            .unwrap_or_else(|e| panic!("{} unreadable: {e}", pkg_path.display()));
        serde_json::from_str::<PluginManifest>(&pkg_json)
            .unwrap_or_else(|e| panic!("{} is not a valid manifest: {e}", manifest_path.display()));

        let system = name == "ghost"
            || name == "shadow"
            || name == "agentbrowser"
            || (package_root == "apps-store/browser" && name == "browser");
        if system && !UNREGISTERED_BY_DESIGN.contains(&name.as_str()) {
            // The exact relative path, not just the file name: a wrong number of
            // `..` segments is a compile error, but a path pointing at the WRONG
            // package root would silently compile in someone else's manifest.
            let expected = format!("include_str!(\"../../../../generated/ryu-runtime/{package_root}/manifest.json\")");
            let multiline = format!("\"../../../../generated/ryu-runtime/{package_root}/manifest.json\"");
            assert!(
                sources.contains(&expected) || sources.contains(&multiline),
                "system package {package_root} is not embedded in Core — no `include_str!` \
                         names `../../../../generated/ryu-runtime/{package_root}/manifest.json`"
            );
        }
        checked += 1;
    }

    // Gate the zero-escape on the DIRECTORIES being absent, not on reads failing:
    // otherwise a tree where every package vanished is indistinguishable from the
    // mirror, and this guard passes having checked nothing.
    if repo_root.join("generated/ryu-runtime/apps-store").is_dir() || repo_root.join("generated/ryu-runtime/plugins-store").is_dir() {
        assert!(
            checked > 0,
            "a package root is present, so at least one manifest must have been checked"
        );
    } else {
        assert_eq!(
            checked, 0,
            "both package roots are absent (OSS mirror), so nothing should have been checked"
        );
    }
}

/// Every compiled-in Core-tier `http` tool must already hold the egress grant its
/// own URL demands, or it can only ever refuse.
///
/// `tool_exec::run_http_tool` runs the egress-grant check FIRST — before the SSRF
/// guard, before the gateway, before any socket — and refuses deterministically
/// when the owning plugin's grant set lacks `tool:http-egress:<host>`. For a
/// Core-tier plugin that grant set IS this manifest's `permission_grants`
/// (`sidecar::mcp::effective_tool_grants`), so a manifest that ships an `http`
/// runnable without the matching grant ships a tool that has never worked and
/// never will. `@ryu/crm` shipped exactly that: eight `core:`-scheme tools behind
/// a lone `crm:crud` grant, all eight refusing before the first request.
///
/// # Why Core tier only
///
/// Community-tier plugins are enforced against the RECORD's Gateway-approved
/// grants, not the manifest's self-declaration — a manifest-only test cannot see
/// those, and asserting on `permission_grants` there would be asserting on a field
/// the enforcement path deliberately ignores. Skipping them keeps this guard
/// aligned with what actually gates the call.
///
/// # Why the grant is DERIVED, not spelled out
///
/// The expected string is computed with the same two production functions the
/// enforcement site uses (`resolve_core_url` then `http_egress_domain`, prefixed
/// with `GRANT_HTTP_EGRESS_PREFIX`). A literal `tool:http-egress:127.0.0.1` here
/// would go stale the moment `core:` expansion or the prefix changes, and would
/// quietly assert the wrong thing; deriving it means the test follows the code.
/// It is also port-insensitive by construction — `http_egress_domain` keeps only
/// the host — so it holds on every profile's shifted Core port.
#[test]
fn http_backed_runnables_hold_the_grant_their_url_requires() {
    use crate::tool_exec::{http_egress_domain, resolve_core_url, GRANT_HTTP_EGRESS_PREFIX};

    let wildcard = format!("{GRANT_HTTP_EGRESS_PREFIX}*");
    let mut checked = 0_usize;
    let mut core_scheme_seen = 0_usize;

    for manifest in PluginManifestLoader::load_builtins() {
        if crate::plugins::builtins::tier_for_manifest(&manifest) != PluginTier::Core {
            continue;
        }
        for entry in manifest.runnables() {
            if entry.kind != RunnableKind::Tool {
                continue;
            }
            let Some(config) = entry.config.as_ref() else {
                continue;
            };
            if config.get("backend").and_then(serde_json::Value::as_str) != Some("http") {
                continue;
            }
            let Some(url) = config.get("url").and_then(serde_json::Value::as_str) else {
                continue;
            };
            if url.starts_with(crate::tool_exec::CORE_URL_SCHEME) {
                core_scheme_seen += 1;
            }
            // Resolve exactly as dispatch does: `core:` becomes this profile's
            // loopback origin, everything else passes through untouched.
            let resolved = resolve_core_url(url);
            let domain = http_egress_domain(&resolved).unwrap_or_else(|| {
                panic!(
                    "{}: runnable '{}' has url '{url}' with no parseable host — \
                         `run_http_tool` refuses it outright",
                    manifest.id, entry.id
                )
            });
            let needed = format!("{GRANT_HTTP_EGRESS_PREFIX}{domain}");
            assert!(
                manifest.permission_grants.contains(&needed)
                    || manifest.permission_grants.contains(&wildcard),
                "{}: runnable '{}' calls '{url}' but the manifest does not declare \
                     '{needed}'. A Core-tier plugin is enforced against its own \
                     `permission_grants`, so this tool refuses before it makes a request. \
                     Declared: {:?}",
                manifest.id,
                entry.id,
                manifest.permission_grants
            );
            checked += 1;
        }
    }

    // Non-vacuity. `load_builtins` drops unparseable manifests silently, and the
    // whole filter above is string matching on `backend`/`url` — a rename would
    // leave this test green over zero runnables forever. Both floors are 1 rather
    // than a hardcoded total so adding or removing a tool does not require
    // touching a count, which is the maintenance trap this repo keeps hitting.
    assert!(
        checked > 0,
        "no compiled-in Core-tier http tool was examined — the `backend`/`url` \
             config keys must have been renamed, or the manifests stopped parsing"
    );
    assert!(
        core_scheme_seen > 0,
        "no `core:`-scheme http tool was examined, so the loopback-grant case this \
             guard exists for went unchecked"
    );
}

/// Walk `plugins-store` and `apps-store`, returning `(plugin id, ROOT-qualified
/// package dir, code_file)` for every sandboxed-JS file a package manifest
/// references.
///
/// The dir is root-qualified (`plugins-store/plugins/advisor`, `apps-store/reasoning`)
/// because both roots may carry `code_file` refs, and the failure message below
/// hands the author an `include_str!` line to paste — one naming the wrong root
/// would not resolve.
///
/// Read at runtime (not `include_str!`) and empty when neither root is shipped,
/// so the OSS Core mirror still builds and tests green — the same posture as
/// [`packaged_manifests_are_compiled_in_from_their_package_home`].
fn packaged_code_file_refs() -> Vec<(String, String, String)> {
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    let mut refs = Vec::new();
    for (package_root, dir) in packaged_dirs(&repo_root, "apps-store")
        .into_iter()
        .chain(packaged_dirs(&repo_root, "plugins-store"))
    {
        let path = dir.join("manifest.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{} unreadable: {e}", path.display()));
        let manifest: PluginManifest = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("{} is not a valid manifest: {e}", path.display()));
        // Every package, not only system plugins: the test table's contract is
        // total (see the `builtin_code` module docs), so promoting an
        // unregistered package to a built-in stays a one-line change.
        for rel in manifest.code_file_refs() {
            refs.push((manifest.id.clone(), package_root.clone(), rel));
        }
    }
    refs
}

/// [`builtin_code::BUILTIN_CODE_FILES`] and the `code_file` references in the
/// package manifests must be a BIJECTION.
///
/// A missing row is the failure that matters: a built-in plugin's package
/// directory does not exist on the user's machine, so a `code_file` with no
/// embedded row cannot be resolved and the plugin fails to load. An orphan row is
/// the milder half — dead embedded code, and the signal that a hook was renamed
/// or deleted without cleaning up.
///
/// This is the check that keeps the table from becoming what the old
/// `fixtures/<x>.manifest.json` copies were: a second list nobody remembers to
/// edit. Both directions, so neither kind of drift can ship.
#[test]
fn builtin_code_table_matches_package_manifests() {
    let refs = packaged_code_file_refs();
    if refs.is_empty() {
        // OSS mirror, or genuinely no manifest uses `code_file`. Either way the
        // table must then be empty too, or it embeds code nothing references.
        assert!(
            builtin_code::BUILTIN_CODE_FILES.is_empty()
                || !std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../generated/ryu-runtime/plugins-store")
                    .is_dir(),
            "no package manifest references a code_file, but BUILTIN_CODE_FILES has {} \
                 row(s) — they embed code nothing can reach",
            builtin_code::BUILTIN_CODE_FILES.len()
        );
        return;
    }

    let declared: HashSet<(&str, &str)> = builtin_code::BUILTIN_CODE_FILES
        .iter()
        .map(|(id, rel, _)| (*id, *rel))
        .collect();

    for (id, dir, rel) in &refs {
        assert!(
            declared.contains(&(id.as_str(), rel.as_str())),
            "{dir}/manifest.json references '{rel}' but plugin_manifest::builtin_code has no \
                 row for ('{id}', '{rel}'). A built-in ships only its manifest — its package \
                 directory is NOT on the user's machine — so without an include_str! row this \
                 code does not exist at runtime. Add:\n    (\n        \"{id}\",\n        \
                 \"{rel}\",\n        include_str!(\"../../../../{dir}/{rel}\"),\n    ),"
        );
    }

    let referenced: HashSet<(&str, &str)> = refs
        .iter()
        .map(|(id, _, rel)| (id.as_str(), rel.as_str()))
        .collect();
    for (id, rel, _) in builtin_code::BUILTIN_CODE_FILES {
        assert!(
            referenced.contains(&(*id, *rel)),
            "plugin_manifest::builtin_code embeds ('{id}', '{rel}'), which no package \
                 manifest references any more. Remove the row (and the file, if it is dead)."
        );
    }
}

/// Walk `plugins-store` and `apps-store`, returning `(plugin id, package dir,
/// pi extension file)` for every `contributes.pi_extensions[].file` a package
/// manifest references. Same runtime-read, empty-in-the-OSS-mirror posture as
/// [`packaged_code_file_refs`].
fn packaged_pi_extension_refs() -> Vec<(String, String, String)> {
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    let mut refs = Vec::new();
    for (package_root, dir) in packaged_dirs(&repo_root, "apps-store")
        .into_iter()
        .chain(packaged_dirs(&repo_root, "plugins-store"))
    {
        let path = dir.join("manifest.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{} unreadable: {e}", path.display()));
        let manifest: PluginManifest = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("{} is not a valid manifest: {e}", path.display()));
        for rel in manifest.pi_extension_refs() {
            refs.push((manifest.id.clone(), package_root.clone(), rel));
        }
    }
    refs
}

/// [`builtin_code::BUILTIN_PI_EXTENSIONS`] and the `contributes.pi_extensions`
/// references in the package manifests must be a BIJECTION.
///
/// The unsandboxed-carriage twin of
/// [`builtin_code_table_matches_package_manifests`], and it exists for the same
/// reason: a built-in plugin's package directory is not on the user's machine,
/// so a declared extension with no embedded row resolves to nothing and the
/// capability is silently absent — the feature looks landed and is not there.
/// An orphan row is the milder half (dead embedded code, and the signal that an
/// extension was renamed or deleted without cleaning up).
#[test]
fn builtin_pi_extension_table_matches_package_manifests() {
    let refs = packaged_pi_extension_refs();
    if refs.is_empty() {
        assert!(
            builtin_code::BUILTIN_PI_EXTENSIONS.is_empty()
                || !std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../generated/ryu-runtime/plugins-store")
                    .is_dir(),
            "no package manifest declares a pi extension, but BUILTIN_PI_EXTENSIONS has \
                 {} row(s) — they embed code nothing can reach",
            builtin_code::BUILTIN_PI_EXTENSIONS.len()
        );
        return;
    }

    let declared: HashSet<(&str, &str)> = builtin_code::BUILTIN_PI_EXTENSIONS
        .iter()
        .map(|(id, rel, _)| (*id, *rel))
        .collect();

    for (id, dir, rel) in &refs {
        assert!(
            declared.contains(&(id.as_str(), rel.as_str())),
            "{dir}/manifest.json declares pi extension '{rel}' but \
                 plugin_manifest::builtin_code has no row for ('{id}', '{rel}'). A built-in \
                 ships only its manifest — its package directory is NOT on the user's machine \
                 — so without an include_str! row the extension does not exist at runtime. \
                 Add:\n    (\n        \"{id}\",\n        \"{rel}\",\n        \
                 include_str!(\"../../../../generated/ryu-runtime/plugins-store/{dir}/{rel}\"),\n    ),"
        );
    }

    let referenced: HashSet<(&str, &str)> = refs
        .iter()
        .map(|(id, _, rel)| (id.as_str(), rel.as_str()))
        .collect();
    for (id, rel, _) in builtin_code::BUILTIN_PI_EXTENSIONS {
        assert!(
            referenced.contains(&(*id, *rel)),
            "plugin_manifest::builtin_code embeds pi extension ('{id}', '{rel}'), which no \
                 package manifest declares any more. Remove the row (and the file, if it is dead)."
        );
    }
}

/// Walk `plugins-store` and `apps-store`, returning `(plugin id, package dir,
/// output style file)` for every `contributes.output_styles[].file` a package
/// manifest references. Same runtime-read, empty-in-the-OSS-mirror posture as
/// [`packaged_code_file_refs`].
fn packaged_output_style_refs() -> Vec<(String, String, String)> {
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    let mut refs = Vec::new();
    for (package_root, dir) in packaged_dirs(&repo_root, "apps-store")
        .into_iter()
        .chain(packaged_dirs(&repo_root, "plugins-store"))
    {
        let path = dir.join("manifest.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{} unreadable: {e}", path.display()));
        let manifest: PluginManifest = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("{} is not a valid manifest: {e}", path.display()));
        for rel in manifest.output_style_refs() {
            refs.push((manifest.id.clone(), package_root.clone(), rel));
        }
    }
    refs
}

/// [`builtin_code::BUILTIN_OUTPUT_STYLES`] and the `contributes.output_styles`
/// references in the package manifests must be a BIJECTION.
///
/// The inert-prose twin of [`builtin_code_table_matches_package_manifests`], and
/// it exists for the same reason both siblings do: a built-in plugin's package
/// directory is not on the user's machine, so a declared style with no embedded
/// row cannot be resolved. That one at least fails loudly — hydration treats a
/// missing row as a hard error rather than an empty body, precisely because an
/// empty style is indistinguishable at every read site from the user having
/// picked none — but the failure takes the WHOLE manifest down at load, so the
/// plugin's other contributions vanish with it. An orphan row is the milder half
/// (dead embedded prose, and the signal that a style was renamed or deleted
/// without cleaning up).
#[test]
fn builtin_output_style_table_matches_package_manifests() {
    let refs = packaged_output_style_refs();
    if refs.is_empty() {
        assert!(
            builtin_code::BUILTIN_OUTPUT_STYLES.is_empty()
                || !std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../generated/ryu-runtime/plugins-store")
                    .is_dir(),
            "no package manifest contributes an output style, but BUILTIN_OUTPUT_STYLES has \
                 {} row(s) — they embed prose nothing can reach",
            builtin_code::BUILTIN_OUTPUT_STYLES.len()
        );
        return;
    }

    let declared: HashSet<(&str, &str)> = builtin_code::BUILTIN_OUTPUT_STYLES
        .iter()
        .map(|(id, rel, _)| (*id, *rel))
        .collect();

    for (id, dir, rel) in &refs {
        assert!(
            declared.contains(&(id.as_str(), rel.as_str())),
            "{dir}/manifest.json contributes output style file '{rel}' but \
                 plugin_manifest::builtin_code has no row for ('{id}', '{rel}'). A built-in ships \
                 only its manifest — its package directory is NOT on the user's machine — so \
                 without an include_str! row the style cannot be hydrated and the whole manifest \
                 fails to load. Add:\n    (\n        \"{id}\",\n        \"{rel}\",\n        \
                 include_str!(\"../../../../generated/ryu-runtime/plugins-store/{dir}/{rel}\"),\n    ),"
        );
    }

    let referenced: HashSet<(&str, &str)> = refs
        .iter()
        .map(|(id, _, rel)| (id.as_str(), rel.as_str()))
        .collect();
    for (id, rel, _) in builtin_code::BUILTIN_OUTPUT_STYLES {
        assert!(
            referenced.contains(&(*id, *rel)),
            "plugin_manifest::builtin_code embeds output style ('{id}', '{rel}'), which no \
                 package manifest contributes any more. Remove the row (and the file, if it is \
                 dead)."
        );
    }
}

/// No package manifest may carry an output style's body INLINE.
///
/// The prose half of [`packaged_plugin_manifests_declare_no_inline_sandbox_code`],
/// and separate from it because the argument is different. Inline sandboxed JS is
/// banned because a `\n`-escaped blob is unauditable and that is where malicious
/// code hides; a style body is inert, so the reason here is authorship: the file
/// form is the SAME format a user's own `<claude-dir>/output-styles/*.md` uses, so
/// a style moves between a plugin package and a user root by plain copy. Inlined,
/// it stops being diffable, stops being copyable, and the frontmatter — which is
/// the single source of truth for the style's `name`, `description` and
/// `keep-coding-instructions` — becomes a JSON string nobody reads.
///
/// Checked against the raw JSON, not a parsed [`PluginManifest`]: hydration moves
/// the body INTO `source` and clears `file`, so a typed parse would inspect the
/// wire form and pass unconditionally. This is about the on-disk form.
#[test]
fn packaged_plugin_manifests_declare_no_inline_output_style_source() {
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    let mut checked = 0;
    let mut offenders: Vec<String> = Vec::new();

    for (package_root, dir) in packaged_dirs(&repo_root, "apps-store")
        .into_iter()
        .chain(packaged_dirs(&repo_root, "plugins-store"))
    {
        let path = dir.join("manifest.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{} unreadable: {e}", path.display()));
        let json: serde_json::Value = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", path.display()));

        let styles = json
            .get("contributes")
            .and_then(|c| c.get("output_styles"))
            .and_then(serde_json::Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        for style in styles {
            if style.get("source").is_some() {
                let id = style
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("?");
                offenders.push(format!("{package_root}: output style '{id}'"));
            }
        }
        checked += 1;
    }

    assert!(
        offenders.is_empty(),
        "these package manifests inline an output style body instead of pointing at a file \
             with `file`:\n  {}\nMove each body to {OUTPUT_STYLE_DIR}/<name>.md, replace `source` \
             with `file`, and add an include_str! row to \
             plugin_manifest::builtin_code::BUILTIN_OUTPUT_STYLES.",
        offenders.join("\n  ")
    );

    if repo_root.join("generated/ryu-runtime/apps-store").is_dir() || repo_root.join("generated/ryu-runtime/plugins-store").is_dir() {
        assert!(
            checked > 0,
            "a package root is present but nothing was checked"
        );
    }
}

/// Every `.md` sitting in a package's `output-styles/` folder must be DECLARED
/// by that package's own manifest.
///
/// The reference-keyed bijection above cannot see a file nobody references, so
/// this is the same guard [`packaged_pi_extension_files_are_all_declared`] gives
/// the extension road: an undeclared `output-styles/foo.md` is committed,
/// reviewed, mirrored into the published tree — and never reaches a prompt.
#[test]
fn packaged_output_style_files_are_all_declared() {
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    let declared: HashSet<(String, String)> = packaged_output_style_refs()
        .into_iter()
        .map(|(_, dir, rel)| (dir, rel))
        .collect();

    for (package_root, pkg) in packaged_dirs(&repo_root, "apps-store")
        .into_iter()
        .chain(packaged_dirs(&repo_root, "plugins-store"))
    {
        let Ok(files) = std::fs::read_dir(pkg.join(OUTPUT_STYLE_DIR)) else {
            continue;
        };
        for file in files.filter_map(Result::ok) {
            let name = file.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".md") {
                continue;
            }
            let rel = format!("{OUTPUT_STYLE_DIR}/{name}");
            assert!(
                declared.contains(&(package_root.clone(), rel.clone())),
                "{package_root}/{rel} exists but {package_root}/manifest.json declares no \
                         contributes.output_styles entry for it — it would never reach a prompt"
            );
        }
    }
}

/// Every `.ts` sitting in a package's `pi-extensions/` folder must be DECLARED
/// by that package's own manifest.
///
/// The bijection above is keyed on references, so it cannot see a file nobody
/// references — and an undeclared `pi-extensions/foo.ts` is exactly the silent
/// failure `every_pi_extension_asset_is_shipped` guards against on the
/// compiled-in road: the file is committed, reviewed, and never reaches an
/// agent. This is that guard, ported to the plugin road.
#[test]
fn packaged_pi_extension_files_are_all_declared() {
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    let declared: HashSet<(String, String)> = packaged_pi_extension_refs()
        .into_iter()
        .map(|(_, dir, rel)| (dir, rel))
        .collect();

    for (package_root, pkg) in packaged_dirs(&repo_root, "apps-store")
        .into_iter()
        .chain(packaged_dirs(&repo_root, "plugins-store"))
    {
        let Ok(files) = std::fs::read_dir(pkg.join(PI_EXTENSION_DIR)) else {
            continue;
        };
        for file in files.filter_map(Result::ok) {
            let name = file.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".ts") {
                continue;
            }
            let rel = format!("{PI_EXTENSION_DIR}/{name}");
            assert!(
                declared.contains(&(package_root.clone(), rel.clone())),
                "{package_root}/{rel} exists but {package_root}/manifest.json declares \
                         no contributes.pi_extensions entry for it — it would never reach the \
                         managed Pi agent"
            );
        }
    }
}

/// No package manifest may carry sandboxed JS INLINE.
///
/// A hook or capability adapter body belongs in `hooks/<name>.js` /
/// `adapters/<verb>.js`, referenced by `code_file`. A multi-kilobyte JS program
/// escaped into a one-line JSON string is unreadable, undiffable, unlintable and
/// — the reason this guard exists rather than a style note — effectively
/// unauditable: nobody reviews a 5 KB `\n`-escaped blob for what it actually
/// does, which is precisely where malicious code hides.
///
/// Without this check the extraction decays one convenient inline hook at a time.
/// Note `code`/`code_file` are mutually exclusive at the contract layer
/// ([`PluginManifest::hydrate_code_files`]), so this is about WHICH form the
/// checked-in source uses, not about a manifest being invalid.
#[test]
fn packaged_plugin_manifests_declare_no_inline_sandbox_code() {
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    let mut checked = 0;
    let mut offenders: Vec<String> = Vec::new();

    for (package_root, dir) in packaged_dirs(&repo_root, "apps-store")
        .into_iter()
        .chain(packaged_dirs(&repo_root, "plugins-store"))
    {
        let path = dir.join("manifest.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{} unreadable: {e}", path.display()));
        // Deserialise into the RAW json, not `PluginManifest`: hydration
        // clears `code_file`, and this check is about the on-disk form.
        let json: serde_json::Value = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", path.display()));

        let hooks = json
            .get("contributes")
            .and_then(|c| c.get("turn_hooks"))
            .and_then(serde_json::Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        for hook in hooks {
            if hook.get("code").is_some() {
                let id = hook
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("?");
                offenders.push(format!("{package_root}: turn hook '{id}'"));
            }
        }

        let provides = json
            .get("provides")
            .and_then(serde_json::Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        for entry in provides {
            let tools = entry.get("tools").and_then(serde_json::Value::as_object);
            for (verb, binding) in tools.into_iter().flatten() {
                if binding.get("adapter").and_then(|a| a.get("code")).is_some() {
                    offenders.push(format!("{package_root}: adapter '{verb}'"));
                }
            }
        }
        checked += 1;
    }

    assert!(
        offenders.is_empty(),
        "these package manifests inline sandboxed JS instead of pointing at a file with \
             `code_file`:\n  {}\nMove each body to hooks/<name>.js or adapters/<verb>.js, replace \
             `code` with `code_file`, and add an include_str! row to \
             plugin_manifest::builtin_code.",
        offenders.join("\n  ")
    );

    if repo_root.join("generated/ryu-runtime/apps-store").is_dir() || repo_root.join("generated/ryu-runtime/plugins-store").is_dir() {
        assert!(
            checked > 0,
            "a package root is present but nothing was checked"
        );
    }
}

/// Each companion app's UI is embedded at compile time via `include_str!`
/// (the `*_UI_HTML` consts) and seeded as the plugin's `ui_code`. A truncated
/// or emptied fixture would still compile but ship a broken companion, so this
/// asserts every bundle is present and non-trivially sized. It is deliberately
/// **size-only, not byte-identity**: the bundles are `vite`/`esbuild` output,
/// which is not guaranteed byte-stable across build hosts, so a byte-identity
/// check on a built asset (whiteboard is ~7.7 MB) would be flaky. The refresh
/// path is `scripts/sync-app-fixtures.sh`; the `*.manifest.json` manifests (hand
/// authored) keep their byte-identity guard in
/// `packaged_manifests_match_their_core_fixtures_and_are_registered`.
///
/// The loop is driven off `plugins::seed::companion_ui_specs()` — the ONE table
/// that carries these consts — not off a list copied into this test. The copy is
/// what this fix removed: it listed 14 of the 15 bundles, so `skill-editor`'s was
/// unguarded, and a truncated skill-editor fixture would have shipped green.
#[test]
fn companion_ui_fixtures_exist_and_are_nontrivial() {
    // A real inlined single-file app bundle is always far larger than this;
    // the floor only catches an emptied/truncated fixture.
    const MIN_BYTES: usize = 10_000;

    let specs = crate::plugins::seed::companion_ui_specs();
    assert!(
        specs.len() >= 15,
        "the seed table carries {} companion bundles — a drop means a companion \
             silently stopped being seeded, not that this guard should shrink",
        specs.len()
    );

    for spec in specs {
        let name = spec.id;
        let html = spec
            .ui_code
            .expect("companion_ui_specs filters on ui_code.is_some()");
        assert!(
            html.len() >= MIN_BYTES,
            "the bundle seeded for '{name}' is only {} bytes (< {MIN_BYTES}) — likely \
                 truncated or empty; rebuild with scripts/sync-app-fixtures.sh",
            html.len()
        );
        assert!(
            html.contains('<'),
            "the bundle seeded for '{name}' does not look like HTML"
        );
    }
}

#[test]
fn sample_fixture_deserializes_into_app_manifest() {
    let manifest: PluginManifest =
        serde_json::from_str(SAMPLE_JSON).expect("sample.ryu.json should deserialise");

    assert_eq!(manifest.id, "@example/research-assistant");
    assert_eq!(manifest.name, "Research Assistant");
    assert_eq!(manifest.version, "0.1.14");
    assert_eq!(
        manifest.permission_grants,
        vec!["mcp:web_search", "mcp:file_read"]
    );
    assert!(manifest.companion.is_some());
}

#[test]
fn runnables_helper_returns_all_bundled_runnables() {
    let manifest: PluginManifest =
        serde_json::from_str(SAMPLE_JSON).expect("sample.ryu.json should deserialise");

    let runnables = manifest.runnables();
    assert_eq!(runnables.len(), 4);

    let kinds: Vec<RunnableKind> = runnables.iter().map(|r| r.kind).collect();
    assert!(kinds.contains(&RunnableKind::Agent));
    assert!(kinds.contains(&RunnableKind::Workflow));
    assert!(kinds.contains(&RunnableKind::Tool));
    assert!(kinds.contains(&RunnableKind::Skill));
}

#[test]
fn runnables_of_kind_filters_correctly() {
    let manifest: PluginManifest =
        serde_json::from_str(SAMPLE_JSON).expect("sample.ryu.json should deserialise");

    let agents = manifest.runnables_of_kind(RunnableKind::Agent);
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].id, "agent-researcher");

    let workflows = manifest.runnables_of_kind(RunnableKind::Workflow);
    assert_eq!(workflows.len(), 1);
    assert_eq!(workflows[0].id, "wf-summarise");
}

#[test]
fn manifest_without_companion_deserializes() {
    let json = r#"{
            "id": "com.example.minimal",
            "name": "Minimal App",
            "version": "0.1.0",
            "runnables": [
                { "id": "agent-x", "name": "Agent X", "kind": "agent" }
            ]
        }"#;
    let manifest: PluginManifest =
        serde_json::from_str(json).expect("minimal manifest should deserialise");
    assert!(manifest.companion.is_none());
    assert!(manifest.permission_grants.is_empty());
    assert_eq!(manifest.runnables().len(), 1);
}

#[test]
fn manifest_roundtrips_through_json() {
    let manifest: PluginManifest =
        serde_json::from_str(SAMPLE_JSON).expect("sample.ryu.json should deserialise");
    let serialized = serde_json::to_string(&manifest).expect("serialise should succeed");
    let roundtripped: PluginManifest =
        serde_json::from_str(&serialized).expect("roundtrip deserialise should succeed");
    assert_eq!(manifest, roundtripped);
}

// ── PluginManifestLoader tests ───────────────────────────────────────────────

/// Flattens the typed rejection to its rendered message so the existing
/// `err.contains("…")` assertions keep reading the same way. Tests that need to
/// distinguish `Invalid` from `Incompatible` call `parse_and_validate` directly.
fn loader_parse(raw: &str) -> Result<PluginManifest, String> {
    PluginManifestLoader::parse_and_validate(raw, "<test>", None, &mut HashSet::new())
        .map_err(|e| e.to_string())
}

#[test]
fn loader_rejects_background_attribution_without_https() {
    let raw = r#"{
            "id": "@example/wallpapers",
            "name": "Wallpapers",
            "version": "1.0.0",
            "runnables": [],
            "contributes": {
                "backgrounds": [{
                    "id": "@example/wallpapers:aurora",
                    "label": "Aurora",
                    "backdropId": "aurora-flow",
                    "params": { "speed": 0.7 },
                    "attribution": "PatternCraft",
                    "attributionUrl": "http://example.com/aurora"
                }]
            }
        }"#;

    let error = loader_parse(raw).expect_err("non-HTTPS attribution must be rejected");
    assert!(
        error.contains("attributionUrl must be an HTTPS URL"),
        "{error}"
    );
}

#[test]
fn loader_accepts_avatar_packs_and_rejects_unsafe_paint() {
    let pack = |fill: &str| {
        format!(
            r##"{{
                "id": "@acme/hats",
                "name": "Hats",
                "version": "1.0.0",
                "runnables": [],
                "contributes": {{
                    "avatar_accessories": [{{
                        "id": "@acme/hats:beanie",
                        "label": "Beanie",
                        "target": "ghost",
                        "region": "headwear",
                        "shapes": [{{ "type": "path", "d": "M12 2 Q18 -3 24 2 Z", "fill": "{fill}" }}]
                    }}],
                    "avatar_styles": [{{
                        "id": "@acme/hats:robot",
                        "label": "Robot",
                        "viewBox": [0, 0, 64, 64],
                        "palettes": [{{ "id": "steel", "label": "Steel", "base": "#9aa5b1", "light": "#e4e7eb", "deep": "#3e4c59" }}],
                        "base": [{{ "type": "rect", "x": 12, "y": 14, "width": 40, "height": 38, "fill": "palette.base" }}]
                    }}]
                }}
            }}"##
        )
    };

    let manifest = loader_parse(&pack("palette.deep")).expect("avatar pack loads");
    let contributes = manifest.contributes.expect("contributes");
    assert_eq!(contributes.avatar_accessories.len(), 1);
    assert_eq!(contributes.avatar_styles.len(), 1);

    let error = loader_parse(&pack("url(#steal)")).expect_err("url paint must be rejected");
    assert!(error.contains("is not an accepted colour"), "{error}");
}

// ── companion label anti-impersonation ───────────────────────────────────

#[test]
fn loader_rejects_companion_label_impersonating_system_chrome() {
    let raw = r#"{
            "id": "com.example.evil",
            "name": "Evil",
            "version": "1.0.0",
            "runnables": [],
            "companion": { "label": "Ryu Settings" }
        }"#;
    let err = loader_parse(raw).unwrap_err();
    assert!(
        err.contains("impersonate system chrome"),
        "expected impersonation rejection, got: {err}"
    );
}

#[test]
fn loader_accepts_benign_companion_label() {
    let raw = r#"{
            "id": "com.example.good",
            "name": "Good",
            "version": "1.0.0",
            "runnables": [],
            "companion": { "label": "Research Assistant" }
        }"#;
    assert!(loader_parse(raw).is_ok());
}

// ── deletable data categories (Settings → Danger Zone) ───────────────────

/// The danger zone's App-owned rows are built from the manifests, so if these
/// declarations go missing the rows silently vanish from Settings rather than
/// failing anywhere a test would otherwise notice.
#[test]
fn monitors_and_meetings_declare_their_danger_zone_categories() {
    for (raw, expected) in [
        (
            include_str!("../../../../generated/ryu-runtime/apps-store/monitors/manifest.json"),
            "monitors",
        ),
        (
            include_str!("../../../../generated/ryu-runtime/apps-store/meetings/manifest.json"),
            "meetings",
        ),
    ] {
        let manifest = loader_parse(raw).expect("packaged manifest must load");
        let declared = manifest
            .contributes
            .as_ref()
            .expect("manifest declares contributions")
            .data_categories
            .iter()
            .find(|c| c.id == expected)
            .unwrap_or_else(|| {
                panic!("'{expected}' no longer declares its data category — the Danger Zone row for it is gone")
            });
        // Copy travels with the declaration; a row with no `detail` is a
        // confirm dialog that says nothing before an irreversible delete.
        assert!(!declared.title.trim().is_empty());
        assert!(!declared.detail.trim().is_empty());
    }
}

/// The loader is Core's validation chokepoint for the surface — every manifest
/// reaches Core through `parse_and_validate`, so a category an app must not own
/// is refused here and not just in the contract crate's unit tests.
#[test]
fn loader_rejects_an_app_claiming_a_kernel_data_category() {
    let raw = r#"{
            "id": "com.example.greedy",
            "name": "Greedy",
            "version": "1.0.0",
            "runnables": [],
            "contributes": {
                "data_categories": [{
                    "id": "chats",
                    "title": "Delete all chats",
                    "noun": "chats",
                    "detail": "Everything goes."
                }]
            }
        }"#;
    let err = loader_parse(raw).unwrap_err();
    assert!(
        err.contains("owned by the kernel"),
        "expected the kernel-id claim to be refused, got: {err}"
    );
}

#[test]
fn loader_accepts_an_app_owned_data_category() {
    let raw = r#"{
            "id": "com.example.watcher",
            "name": "Watcher",
            "version": "1.0.0",
            "runnables": [],
            "contributes": {
                "data_categories": [{
                    "id": "watches",
                    "title": "Delete all watches",
                    "noun": "watches",
                    "confirm_word": "Watches",
                    "detail": "Every watch and its history will be permanently deleted."
                }]
            }
        }"#;
    let manifest = loader_parse(raw).expect("a well-formed app category must load");
    let declared = &manifest.contributes.unwrap().data_categories;
    assert_eq!(declared.len(), 1);
    assert_eq!(declared[0].confirm_word(), "Watches");
}

// ── app id validation (path-traversal hardening) ─────────────────────────

#[test]
fn validate_plugin_id_accepts_bare_kebab_and_legacy_dotted() {
    // Bare-kebab ids (the new built-in convention) must pass.
    assert!(validate_plugin_id("@ryu/ghost").is_ok());
    assert!(validate_plugin_id("data-grid-explorer").is_ok());
    assert!(validate_plugin_id("@ryu/rtk").is_ok());
    // Legacy dotted third-party ids must still pass (back-compat).
    assert!(validate_plugin_id("@example/research-assistant").is_ok());
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
    ] {
        assert!(
            validate_plugin_id(bad).is_err(),
            "expected '{bad}' to be rejected"
        );
    }
}

#[test]
fn validate_plugin_id_rejects_overlong() {
    let long = format!("com.example.{}", "a".repeat(200));
    assert!(validate_plugin_id(&long).is_err());
}

#[test]
fn loader_rejects_path_traversal_id() {
    let json = r#"{"id":"../../../../etc/x","name":"Evil","version":"1.0.0","runnables":[]}"#;
    let err = loader_parse(json).unwrap_err();
    assert!(err.contains("..") || err.contains("illegal"), "got: {err}");
}

#[test]
fn loader_accepts_valid_semver() {
    let json = r#"{
            "id": "com.example.app",
            "name": "Test",
            "version": "2.3.1",
            "runnables": []
        }"#;
    let m = loader_parse(json).expect("valid semver should be accepted");
    assert_eq!(m.version, "2.3.1");
}

#[test]
fn loader_rejects_invalid_semver() {
    let json = r#"{
            "id": "com.example.bad-ver",
            "name": "Bad Version",
            "version": "not-semver",
            "runnables": []
        }"#;
    let err = loader_parse(json).unwrap_err();
    assert!(
        err.contains("invalid semver version"),
        "unexpected error: {err}"
    );
}

/// The loader is a separate gate from `PluginManifest::validate` — it re-runs
/// each rule individually rather than calling the superset — so the vocabulary
/// gate has to be proven HERE, not just in the contract crate. Every built-in
/// and every disk-installed manifest reaches Core through this function, and a
/// level id becomes a grant string and an API path segment.
#[test]
fn loader_rejects_a_malformed_permission_vocabulary() {
    let dangling = r#"{
            "id": "com.example.levels",
            "name": "Levels",
            "version": "1.0.0",
            "runnables": [],
            "permission_levels": [
                { "id": "edit", "label": "Can edit", "description": "Edit.", "implies": ["read"] }
            ]
        }"#;
    let err = loader_parse(dangling).unwrap_err();
    assert!(err.contains("implies 'read'"), "unexpected error: {err}");

    let uppercase = r#"{
            "id": "com.example.levels",
            "name": "Levels",
            "version": "1.0.0",
            "runnables": [],
            "permission_levels": [
                { "id": "Read", "label": "Can view", "description": "View." }
            ]
        }"#;
    let err = loader_parse(uppercase).unwrap_err();
    assert!(
        err.contains("illegal characters"),
        "unexpected error: {err}"
    );
}

/// An installed app must not ladder its own level into a kernel key, or every
/// grant of that level would silently convey the node-wide permission.
#[test]
fn loader_rejects_an_app_level_implying_a_kernel_key() {
    let json = r#"{
            "id": "com.example.ladder",
            "name": "Ladder",
            "version": "1.0.0",
            "runnables": [],
            "permission_levels": [
                { "id": "space.delete", "label": "Delete spaces", "description": "Delete." },
                { "id": "ladder.use", "label": "Use", "description": "Use.", "implies": ["space.delete"] }
            ]
        }"#;
    let err = loader_parse(json).unwrap_err();
    assert!(
        err.contains("implies kernel permission 'space.delete'"),
        "unexpected error: {err}"
    );

    // Labelling a kernel key (the supported case) still loads.
    let label_only = r#"{
            "id": "com.example.ladder",
            "name": "Ladder",
            "version": "1.0.0",
            "runnables": [],
            "permission_levels": [
                { "id": "space.delete", "label": "Delete spaces", "description": "Delete." },
                { "id": "ladder.use", "label": "Use", "description": "Use." }
            ]
        }"#;
    loader_parse(label_only).expect("labelling a kernel key must still load");
}

/// The companion case: a well-formed vocabulary must survive the loader intact,
/// or the gate above would be indistinguishable from "reject everything".
#[test]
fn loader_keeps_a_well_formed_permission_vocabulary() {
    let json = r#"{
            "id": "com.example.levels-ok",
            "name": "Levels",
            "version": "1.0.0",
            "runnables": [],
            "permission_levels": [
                { "id": "read", "label": "Can view", "description": "View." },
                { "id": "edit", "label": "Can edit", "description": "Edit.", "implies": ["read"] }
            ]
        }"#;
    let manifest = loader_parse(json).expect("a valid vocabulary must load");
    assert_eq!(manifest.permission_levels.len(), 2);
    assert_eq!(manifest.permission_levels[1].implies, ["read"]);
}

/// Same argument as `loader_rejects_a_malformed_permission_vocabulary`, for the
/// routes that CONSUME the vocabulary: the ext-proxy gates on this annotation,
/// so a route naming a level nobody declared must fail to load rather than 403
/// on every request for a reason visible in no manifest.
#[test]
fn loader_rejects_a_route_requiring_an_undeclared_permission() {
    let sidecar = |extra: &str| {
        format!(
            r#"{{
                    "id": "com.example.gated",
                    "name": "Gated",
                    "version": "1.0.0",
                    "runnables": [],
                    "permission_levels": [
                        {{ "id": "tabs.close", "label": "Can close", "description": "Close." }}
                    ],
                    "sidecars": [{{
                        "name": "api",
                        "process": {{ "kind": "local", "command": "gated-api" }},
                        "port": 9111,
                        "http": {{ "routes": [{{ "path": "/tabs/:id/close"{extra} }}] }}
                    }}]
                }}"#
        )
    };

    let err = loader_parse(&sidecar(r#", "permission": "tabs.destroy""#)).unwrap_err();
    assert!(err.contains("'tabs.destroy'"), "unexpected error: {err}");

    // The declared one loads, so the gate above is not "reject every route".
    let manifest = loader_parse(&sidecar(
        r#", "permission": "tabs.close", "resource_param": "id""#,
    ))
    .expect("a declared level must load");
    let route = &manifest.sidecars[0].http.as_ref().expect("http").routes[0];
    assert_eq!(route.permission.as_deref(), Some("tabs.close"));
}

#[test]
fn loader_rejects_duplicate_ids() {
    let json = r#"{"id":"com.example.dup","name":"A","version":"1.0.0","runnables":[]}"#;
    let mut seen = HashSet::new();
    PluginManifestLoader::parse_and_validate(json, "<t1>", None, &mut seen)
        .expect("first occurrence should succeed");
    let err = PluginManifestLoader::parse_and_validate(json, "<t2>", None, &mut seen)
        .unwrap_err()
        .to_string();
    assert!(err.contains("duplicate app id"), "unexpected error: {err}");
}

#[test]
fn loader_builtins_returns_all_built_in_manifests() {
    // Every built-in manifest must always load — including the #447/#448
    // policy/engine fixtures (whose `engines.ryu` must be satisfiable, or they
    // would be dropped here). The count grows as fixtures are added; assert the
    // floor plus each id below.
    let manifests = PluginManifestLoader::load();
    assert!(
        manifests.len() >= 5,
        "loader must return at least the built-in manifests, got {}",
        manifests.len()
    );
    // The new Core-tier policy/engine plugins must load (their engines.ryu
    // requirement is satisfied by this Core version).
    for id in [
        "@ryu/firewall",
        "@ryu/routing",
        "@ryu/sandbox",
        "@ryu/engines",
        "@ryu/durable",
    ] {
        assert!(
            manifests.iter().any(|m| m.id == id),
            "built-in '{id}' must load (engines.ryu must be satisfiable)"
        );
    }
    // The Research Assistant demo is no longer a shipped built-in (it was a
    // first-run sample); it must NOT appear in the catalog.
    assert!(
        !manifests
            .iter()
            .any(|m| m.id == "@example/research-assistant"),
        "sample research assistant manifest must not be a built-in"
    );
    assert!(
        manifests.iter().any(|m| m.id == "@ryu/spider"),
        "built-in Spider manifest should be loaded"
    );
    assert!(
        manifests.iter().any(|m| m.id == "@ryu/exa"),
        "built-in Exa manifest should be loaded"
    );
    let parallel = manifests
        .iter()
        .find(|m| m.id == "@ryu/parallel")
        .expect("built-in Parallel manifest should be loaded");
    assert!(
        parallel
            .provided_capabilities()
            .iter()
            .any(|p| p.capability == "web.search" && p.tools.contains_key("web.search")),
        "Parallel must be registered as a web.search provider"
    );
    assert!(
        manifests.iter().any(|m| m.id == "@ryu/ghost"),
        "built-in Ghost manifest should be loaded"
    );
    assert!(
        manifests.iter().any(|m| m.id == "@ryu/shadow"),
        "built-in Shadow manifest should be loaded"
    );
    assert!(
        manifests.iter().any(|m| m.id == "@ryu/proof"),
        "built-in Proof of Work manifest should be loaded"
    );
    assert!(
        manifests.iter().any(|m| m.id == "@ryu/security-guidance"),
        "built-in Security Guidance manifest should be loaded"
    );
    // The Whiteboard app (the FIRST companion runnable in BUILTIN_MANIFESTS) must
    // load AND validate as a companion whose config carries `ui_entry` + the
    // Path B `ui_format:"html"` discriminator. `cargo check` compiles the
    // `include_str!` but never RUNS this loader, so without this a fixture that
    // fails `parse_and_validate` would be silently dropped → the pre-installed seed
    // finds no version → the whole feature is inert while every check stays green.
    let whiteboard = manifests
        .iter()
        .find(|m| m.id == WHITEBOARD_PLUGIN_ID)
        .expect("whiteboard app manifest must load and validate");
    let companion = whiteboard
        .runnables()
        .iter()
        .find(|r| r.kind == RunnableKind::Companion)
        .expect("whiteboard must expose a companion runnable");
    let cfg = companion
        .config
        .as_ref()
        .expect("whiteboard companion must carry a config");
    assert!(
        cfg.get("ui_entry").and_then(|v| v.as_str()).is_some(),
        "whiteboard companion config must set ui_entry (so has_ui is true)"
    );
    assert_eq!(
        cfg.get("ui_format").and_then(|v| v.as_str()),
        Some("html"),
        "whiteboard companion must declare ui_format:\"html\" (Path B)"
    );
}

#[test]
fn sample_widget_fixture_loads_and_binds_its_widget() {
    // The reference third-party widget plugin must parse+register (a malformed
    // fixture is silently WARN-skipped by `load()`, staying green under
    // `cargo check`, so assert the loaded shape here). It carries no runnables:
    // its tool is owned by the declared MCP server, and the widget is wired by
    // `contributes.widgets` joined to the `widget:render` grant.
    let manifests = PluginManifestLoader::load();
    let m = manifests
        .iter()
        .find(|m| m.id == "@ryu/sample-widget")
        .expect("sample-widget fixture must load and validate");
    assert!(
        m.permission_grants.iter().any(|g| g == "widget:render"),
        "sample-widget must declare the widget:render grant"
    );
    assert!(
        m.mcp_servers.contains_key("sample_widget"),
        "sample-widget must declare the sample_widget MCP server"
    );
    let widgets = m
        .contributes
        .as_ref()
        .map(|c| c.widgets.as_slice())
        .unwrap_or_default();
    let widget = widgets
        .iter()
        .find(|w| w.tool_id == "sample_widget.render")
        .expect("sample-widget must contribute the sample_widget.render widget");
    // tool_id MUST be `<mcp_servers-key>.<toolName>` and the uri must match the
    // resource the server serves (and the tool _meta.outputTemplate).
    assert_eq!(widget.uri, "ui://widget/sample.html");
    assert_eq!(widget.mime, "text/html+skybridge");
}

#[test]
fn security_scanner_fixture_has_two_gated_hooks() {
    let manifests = PluginManifestLoader::load();
    let m = manifests
        .iter()
        .find(|m| m.id == "@ryu/security-scanner")
        .expect("security-scanner must load");
    assert!(
        m.permission_grants.iter().any(|g| g == "hook:run-agent"),
        "must declare the delegated-agent grant"
    );
    assert!(
        m.permission_grants.iter().any(|g| g == "hook:side-model"),
        "must declare the side-model grant"
    );
    let hooks = &m.contributes.as_ref().expect("contributes").turn_hooks;
    assert_eq!(hooks.len(), 2, "command and automatic-review hooks");
    let command = hooks
        .iter()
        .find(|hook| hook.id == "security-scanner.command")
        .expect("command hook");
    assert_eq!(command.on, "pre_user_turn");
    assert!(command.code.contains("runFanout"));
    assert!(command
        .run_when
        .as_ref()
        .expect("command gate")
        .commands
        .iter()
        .any(|command| command == "/security-scan"));
    let review = hooks
        .iter()
        .find(|hook| hook.id == "security-scanner.auto-review")
        .expect("automatic-review hook");
    assert_eq!(review.on, "post_assistant_turn");
    assert!(review.code.contains("sideModel"));
    assert_eq!(
        review
            .run_when
            .as_ref()
            .and_then(|gate| gate.flag.as_deref()),
        Some("io.ryu.security-scanner.auto-review")
    );
}

#[test]
fn security_guidance_fixture_has_gated_turn_hook() {
    // The ported security-guidance plugin must contribute a flag-gated
    // `post_assistant_turn` hook with the side-model grant, so it is free on
    // the hot path (skipped unless the toggle/command is set) and can review.
    let manifests = PluginManifestLoader::load();
    let m = manifests
        .iter()
        .find(|m| m.id == "@ryu/security-guidance")
        .expect("security-guidance must load");
    assert!(
        m.permission_grants.iter().any(|g| g == "hook:side-model"),
        "must declare the side-model grant"
    );
    let hooks = &m.contributes.as_ref().expect("contributes").turn_hooks;
    assert_eq!(hooks.len(), 1, "one turn hook");
    assert_eq!(hooks[0].on, "post_assistant_turn");
    let gate = hooks[0].run_when.as_ref().expect("a match gate");
    assert_eq!(gate.flag.as_deref(), Some("io.ryu.security-guidance"));
    assert!(gate.commands.iter().any(|c| c == "/security"));
}

// ── Per-kind validation via loader ────────────────────────────────────────

#[test]
fn loader_rejects_unknown_kind() {
    // An unknown `kind` string must be rejected with a descriptive error (serde
    // will produce a parse error since `RunnableKind` is exhaustive).
    let json = r#"{
            "id": "com.example.bad-kind",
            "name": "Bad Kind",
            "version": "1.0.0",
            "runnables": [
                { "id": "r1", "name": "R1", "kind": "not_a_real_kind" }
            ]
        }"#;
    let err = loader_parse(json).unwrap_err();
    assert!(
        err.contains("JSON parse error"),
        "expected parse error, got: {err}"
    );
}

#[test]
fn loader_rejects_runnable_missing_required_config() {
    // A `tool` Runnable without `config` must be rejected with a descriptive error.
    let json = r#"{
            "id": "com.example.bad-tool",
            "name": "Bad Tool",
            "version": "1.0.0",
            "runnables": [
                { "id": "tool-x", "name": "Tool X", "kind": "tool" }
            ]
        }"#;
    let err = loader_parse(json).unwrap_err();
    assert!(
        err.contains("kind=tool") || err.contains("missing required"),
        "expected per-kind validation error, got: {err}"
    );
}

#[test]
fn loader_rejects_policy_missing_required_config() {
    let json = r#"{
            "id": "com.example.bad-policy",
            "name": "Bad Policy",
            "version": "1.0.0",
            "runnables": [
                { "id": "policy-x", "name": "Policy X", "kind": "policy" }
            ]
        }"#;
    let err = loader_parse(json).unwrap_err();
    assert!(
        err.contains("kind=policy") || err.contains("missing required"),
        "expected per-kind validation error, got: {err}"
    );
}

// ── Multi-kind fixture round-trip (acceptance criteria for #167) ──────────

#[test]
fn multi_kind_fixture_deserializes_all_eight_kinds() {
    let manifest: PluginManifest =
        serde_json::from_str(MULTI_KIND_JSON).expect("multi_kind.ryu.json should deserialise");

    assert_eq!(manifest.id, "com.example.multi-kind");
    assert_eq!(manifest.runnables().len(), 8);

    let kinds: Vec<RunnableKind> = manifest.runnables().iter().map(|r| r.kind).collect();
    assert!(kinds.contains(&RunnableKind::Agent), "missing agent");
    assert!(kinds.contains(&RunnableKind::Workflow), "missing workflow");
    assert!(kinds.contains(&RunnableKind::Tool), "missing tool");
    assert!(kinds.contains(&RunnableKind::Skill), "missing skill");
    assert!(
        kinds.contains(&RunnableKind::Companion),
        "missing companion"
    );
    assert!(kinds.contains(&RunnableKind::Channel), "missing channel");
    assert!(kinds.contains(&RunnableKind::Engine), "missing engine");
    assert!(kinds.contains(&RunnableKind::Policy), "missing policy");
}

#[test]
fn multi_kind_fixture_roundtrips_with_zero_data_loss() {
    let manifest: PluginManifest = serde_json::from_str(MULTI_KIND_JSON).expect("deserialise");
    let serialized = serde_json::to_string(&manifest).expect("serialise");
    let roundtripped: PluginManifest =
        serde_json::from_str(&serialized).expect("roundtrip deserialise");
    assert_eq!(
        manifest, roundtripped,
        "round-trip must produce identical data"
    );
}

#[test]
fn multi_kind_fixture_all_runnables_pass_validation() {
    let manifest: PluginManifest = serde_json::from_str(MULTI_KIND_JSON).expect("deserialise");
    for entry in manifest.runnables() {
        validate_runnable(entry)
            .unwrap_or_else(|e| panic!("runnable '{}' failed validation: {e}", entry.id));
    }
}

// ── contributes / engines / activation_events (#443) ─────────────────────

#[test]
fn activation_events_default_empty_roundtrips() {
    let json = r#"{
            "id": "com.example.lazy",
            "name": "Lazy",
            "version": "1.0.0",
            "runnables": []
        }"#;
    let m = loader_parse(json).expect("manifest without activation_events should load");
    assert!(
        m.activation_events.is_empty(),
        "activation_events defaults to empty (eager)"
    );
    assert!(m.contributes.is_none());
    assert!(m.engines.is_none());

    // Round-trip preserves the empty default.
    let serialized = serde_json::to_string(&m).expect("serialise");
    let back: PluginManifest = serde_json::from_str(&serialized).expect("deserialise");
    assert_eq!(m, back);
}

#[test]
fn activation_events_parse_and_roundtrip() {
    let json = r#"{
            "id": "com.example.events",
            "name": "Events",
            "version": "1.0.0",
            "runnables": [],
            "activation_events": ["onStartup", "onCommand:do-thing"]
        }"#;
    let m = loader_parse(json).expect("manifest with activation_events should load");
    assert_eq!(m.activation_events, vec!["onStartup", "onCommand:do-thing"]);
}

#[test]
fn engines_satisfied_loads() {
    // A requirement the running Core always satisfies (any version >= 0.0.1).
    let json = r#"{
            "id": "com.example.engok",
            "name": "Eng OK",
            "version": "1.0.0",
            "runnables": [],
            "engines": { "ryu": ">=0.0.1" }
        }"#;
    let m = loader_parse(json).expect("satisfied engines.ryu should load");
    assert_eq!(m.engines.as_ref().unwrap().ryu, ">=0.0.1");
}

/// An unsatisfiable floor used to be a hard reject, which made the plugin
/// VANISH — no card, no explanation, no way to learn that updating would bring
/// it back. It is now a typed `Incompatible`, which the catalog can render and
/// the runtime still never sees.
#[test]
fn engines_unsatisfied_is_held_back_not_dropped() {
    // An impossibly-high requirement no real Core version satisfies.
    let json = r#"{
            "id": "com.example.engbad",
            "name": "Eng Bad",
            "version": "1.0.0",
            "runnables": [],
            "engines": { "ryu": ">=9999.0.0" }
        }"#;
    let err = PluginManifestLoader::parse_and_validate(json, "<test>", None, &mut HashSet::new())
        .unwrap_err();

    let ManifestRejection::Incompatible(inc) = err else {
        panic!("an unsatisfied floor must be Incompatible, not Invalid: {err}");
    };
    assert_eq!(inc.id(), "com.example.engbad");
    assert!(!inc.verdict().compatible);
    assert!(matches!(
        inc.verdict().unmet.as_slice(),
        [UnmetRequirement::TooOld {
            surface: Surface::Core,
            ..
        }]
    ));
    // The card still has everything it needs to render.
    assert_eq!(inc.for_catalog().name, "Eng Bad");
}

/// `engines.host_api` names the plugin host API floor. Core always knows the
/// host API it serves, so an unsatisfied floor is held back (refused at
/// install/enable with the host API named) and an unparseable one is dropped.
#[test]
fn engines_host_api_floor_gates_loading() {
    let ok = format!(
        r#"{{"id":"com.example.hostapiok","name":"H","version":"1.0.0","runnables":[],
                "engines":{{"ryu":">=0.0.1","host_api":"^{}"}}}}"#,
        ryu_kernel_contracts::host_api::HOST_API_VERSION
    );
    let m = loader_parse(&ok).expect("the current host API satisfies its own caret range");
    assert!(m.engines.as_ref().unwrap().host_api.is_some());

    let too_new = r#"{"id":"com.example.hostapinew","name":"H","version":"1.0.0",
            "runnables":[],"engines":{"ryu":">=0.0.1","host_api":">=999.0.0"}}"#;
    let err =
        PluginManifestLoader::parse_and_validate(too_new, "<test>", None, &mut HashSet::new())
            .unwrap_err();
    assert!(
        err.to_string().contains("host_api requires >=999.0.0"),
        "{err}"
    );
    let ManifestRejection::Incompatible(inc) = err else {
        panic!("an unsatisfied host API floor must be Incompatible");
    };
    assert!(matches!(
        inc.verdict().unmet.as_slice(),
        [UnmetRequirement::HostApiTooOld { .. }]
    ));

    let invalid = r#"{"id":"com.example.hostapibad","name":"H","version":"1.0.0",
            "runnables":[],"engines":{"ryu":">=0.0.1","host_api":"nope"}}"#;
    let err =
        PluginManifestLoader::parse_and_validate(invalid, "<test>", None, &mut HashSet::new())
            .unwrap_err();
    assert!(matches!(err, ManifestRejection::Invalid(_)));
    assert!(
        err.to_string().contains("invalid engines.host_api"),
        "{err}"
    );
}

/// An UNPARSEABLE requirement stays a hard drop: there is nothing coherent to
/// show a user, and a requirement nobody can evaluate must never be treated as
/// satisfied.
#[test]
fn engines_invalid_requirement_is_still_dropped() {
    let json = r#"{
            "id": "com.example.engsyntax",
            "name": "Eng Syntax",
            "version": "1.0.0",
            "runnables": [],
            "engines": { "ryu": "not-a-req" }
        }"#;
    let err = PluginManifestLoader::parse_and_validate(json, "<test>", None, &mut HashSet::new())
        .unwrap_err();

    assert!(
        matches!(err, ManifestRejection::Invalid(_)),
        "an unparseable requirement must be Invalid, not Incompatible"
    );
    // Named by the key an author actually wrote (`ryu`), never `engines.core`.
    assert!(
        err.to_string().contains("invalid engines.ryu"),
        "expected invalid-requirement rejection, got: {err}"
    );
}

/// THE CONTAINMENT PROPERTY. An incompatible manifest must be visible to the
/// catalog and invisible to the runtime — and the type system, not an audit of
/// every consumer, is what guarantees the second half: `load()` returns
/// `Vec<PluginManifest>` and the incompatible lane is a different type that
/// only `load_all()` hands out.
#[test]
fn an_incompatible_manifest_never_reaches_the_runtime_manifest_list() {
    let json = r#"{
            "id": "com.example.contained",
            "name": "Contained",
            "version": "1.0.0",
            "runnables": [],
            "engines": { "ryu": ">=9999.0.0" },
            "contributes": {
                "turn_hooks": [
                    { "id": "h1", "on": "pre_user_turn", "code": "return ctx;" }
                ]
            }
        }"#;
    let mut seen = HashSet::new();
    let rejected =
        PluginManifestLoader::parse_and_validate(json, "<test>", None, &mut seen).unwrap_err();

    let ManifestRejection::Incompatible(inc) = rejected else {
        panic!("expected the incompatible lane");
    };

    // It DOES declare a turn hook...
    assert_eq!(
        inc.for_catalog()
            .contributes
            .as_ref()
            .map(|c| c.turn_hooks.len()),
        Some(1),
        "the fixture must actually contribute something, or this proves nothing"
    );

    // ...and it is NOT in the list every runtime consumer iterates. `load()`
    // cannot return it: its type has no incompatible lane at all.
    let runtime: Vec<PluginManifest> = PluginManifestLoader::load();
    assert!(
        !runtime.iter().any(|m| m.id == "com.example.contained"),
        "an incompatible plugin must never enter the runtime manifest list"
    );
}

#[test]
fn contributes_referencing_existing_runnable_loads() {
    let json = r#"{
            "id": "com.example.contrib",
            "name": "Contrib",
            "version": "1.0.0",
            "runnables": [
                { "id": "tool-x", "name": "Tool X", "kind": "tool", "config": { "slug": "web_search" } }
            ],
            "contributes": { "tools": [ { "id": "tool-x", "title": "Search the web" } ] }
        }"#;
    let m = loader_parse(json).expect("contributes referencing a real runnable should load");
    let c = m.contributes.as_ref().unwrap();
    assert_eq!(c.tools.len(), 1);
    assert_eq!(c.tools[0].id, "tool-x");
    assert_eq!(c.tools[0].title.as_deref(), Some("Search the web"));
}

#[test]
fn contributes_referencing_missing_runnable_is_rejected() {
    let json = r#"{
            "id": "com.example.contribbad",
            "name": "Contrib Bad",
            "version": "1.0.0",
            "runnables": [
                { "id": "tool-x", "name": "Tool X", "kind": "tool", "config": { "slug": "web_search" } }
            ],
            "contributes": { "commands": [ { "id": "does-not-exist" } ] }
        }"#;
    let err = loader_parse(json).unwrap_err();
    assert!(
        err.contains("unknown runnable id"),
        "expected unknown-id rejection, got: {err}"
    );
}

#[test]
fn core_version_is_parseable() {
    // core_version() must always return a valid semver (never 0.0.0 in a real
    // build), so the engines gate has a meaningful version to match against.
    let v = core_version();
    assert!(v >= semver::Version::new(0, 0, 0));
}

#[test]
fn loader_scans_user_dir() {
    // Point RYU_PLUGINS_DIR at a temp dir with a canonical `manifest.json`
    // plugin, a legacy `plugin.json` plugin, a legacy `ryu.json` plugin
    // (proving the triple-read fallback), a plugin carrying BOTH
    // `manifest.json` and `plugin.json` (proving first-match-wins
    // precedence), and one malformed plugin.
    let tmp = std::env::temp_dir().join(format!(
        "ryu-plugin-manifest-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    ));
    let canonical_dir = tmp.join("canonical-plugin");
    std::fs::create_dir_all(&canonical_dir).unwrap();
    std::fs::write(
        canonical_dir.join("manifest.json"),
        r#"{"id":"com.test.canonical-plugin","name":"Canonical Plugin","version":"0.1.0","runnables":[]}"#,
    )
    .unwrap();
    let plugin_dir = tmp.join("my-plugin");
    std::fs::create_dir_all(&plugin_dir).unwrap();
    std::fs::write(
        plugin_dir.join("plugin.json"),
        r#"{"id":"com.test.my-plugin","name":"My Plugin","version":"0.1.0","runnables":[]}"#,
    )
    .unwrap();
    // Carries BOTH names: `manifest.json` must win, so the `plugin.json` id
    // must NOT appear in the loaded set.
    let both_dir = tmp.join("both-plugin");
    std::fs::create_dir_all(&both_dir).unwrap();
    std::fs::write(
        both_dir.join("manifest.json"),
        r#"{"id":"com.test.both-new","name":"Both New","version":"0.1.0","runnables":[]}"#,
    )
    .unwrap();
    std::fs::write(
        both_dir.join("plugin.json"),
        r#"{"id":"com.test.both-old","name":"Both Old","version":"0.1.0","runnables":[]}"#,
    )
    .unwrap();
    let legacy_dir = tmp.join("legacy-plugin");
    std::fs::create_dir_all(&legacy_dir).unwrap();
    std::fs::write(
        legacy_dir.join("ryu.json"),
        r#"{"id":"com.test.legacy-plugin","name":"Legacy Plugin","version":"0.1.0","runnables":[]}"#,
    )
    .unwrap();
    let bad_dir = tmp.join("bad-plugin");
    std::fs::create_dir_all(&bad_dir).unwrap();
    std::fs::write(bad_dir.join("plugin.json"), b"not json").unwrap();
    // An Agent Plugins v1 package: `plugin.json` here is the SPEC manifest,
    // not our legacy alias, so it must be translated rather than rejected for
    // having no `id`/`runnables`. Its `mcp.json` server must survive the
    // translation as a declared `mcp_servers` entry (registration itself stays
    // gated on the Gateway-approved `mcp:server` grant).
    // The reverse collision: a native plugin that ALSO carries the exported
    // spec `plugin.json` (which every packaged app and plugin now does).
    // `manifest.json` must still win, and the spec sibling must not be read.
    let exported_dir = tmp.join("exported-plugin");
    std::fs::create_dir_all(&exported_dir).unwrap();
    std::fs::write(
        exported_dir.join("manifest.json"),
        r#"{"id":"com.test.exported","name":"Exported","version":"0.1.0","runnables":[]}"#,
    )
    .unwrap();
    std::fs::write(
        exported_dir.join("plugin.json"),
        format!(
            r#"{{"$schema":"{}","name":"exported"}}"#,
            agent_plugin::PLUGIN_SCHEMA_URL
        ),
    )
    .unwrap();
    let spec_dir = tmp.join("summarize");
    std::fs::create_dir_all(&spec_dir).unwrap();
    std::fs::write(
        spec_dir.join("plugin.json"),
        format!(
            r#"{{"$schema":"{}","name":"summarize","version":"2.1.0"}}"#,
            agent_plugin::PLUGIN_SCHEMA_URL
        ),
    )
    .unwrap();
    std::fs::write(
        spec_dir.join("mcp.json"),
        format!(
            r#"{{"$schema":"{}","mcpServers":{{"sum":{{"type":"stdio","command":"npx","args":["-y","summarize-mcp"]}}}}}}"#,
            agent_plugin::MCP_SCHEMA_URL
        ),
    )
    .unwrap();

    std::env::set_var("RYU_PLUGINS_DIR", &tmp);
    let manifests = PluginManifestLoader::load();
    std::env::remove_var("RYU_PLUGINS_DIR");

    assert!(
        manifests
            .iter()
            .any(|m| m.id == "com.test.canonical-plugin"),
        "canonical manifest.json plugin should be loaded"
    );
    assert!(
        manifests.iter().any(|m| m.id == "com.test.my-plugin"),
        "legacy plugin.json plugin should still be loaded"
    );
    assert!(
        manifests.iter().any(|m| m.id == "com.test.legacy-plugin"),
        "legacy ryu.json plugin should still be loaded"
    );
    // Precedence: `manifest.json` is first in MANIFEST_FILE_NAMES, so a dir
    // carrying both resolves to it deterministically.
    assert!(
        manifests.iter().any(|m| m.id == "com.test.both-new"),
        "manifest.json must win over plugin.json when both are present"
    );
    assert!(
        !manifests.iter().any(|m| m.id == "com.test.both-old"),
        "plugin.json must NOT be read when manifest.json is present"
    );

    assert!(
        manifests.iter().any(|m| m.id == "com.test.exported"),
        "manifest.json must win over an exported spec plugin.json sibling"
    );
    assert!(
        !manifests.iter().any(|m| m.id == "@agent-plugins/exported"),
        "the spec sibling must NOT be imported when a native manifest exists"
    );

    let imported = manifests
        .iter()
        .find(|m| m.id == "@agent-plugins/summarize")
        .expect("an Agent Plugins v1 package should load through translation");
    assert_eq!(imported.version, "2.1.0");
    assert_eq!(
        imported
            .mcp_servers
            .get("sum")
            .and_then(|s| s.command.as_deref()),
        Some("npx"),
        "the spec mcp.json server should survive translation"
    );
    assert!(
        imported
            .permission_grants
            .iter()
            .any(|g| g == crate::sidecar::mcp::GRANT_MCP_SERVER),
        "an imported plugin must DECLARE the mcp grant (approval stays with the Gateway)"
    );

    // The legacy `RYU_APPS_DIR` must still be honoured when `RYU_PLUGINS_DIR`
    // is unset, so pre-rename setups are not orphaned. Reuse the same temp
    // dir (it holds a legacy `ryu.json` plugin) to keep env mutation in this
    // single test, avoiding cross-test env races under parallel runs.
    std::env::set_var("RYU_APPS_DIR", &tmp);
    let legacy_manifests = PluginManifestLoader::load();
    std::env::remove_var("RYU_APPS_DIR");

    std::fs::remove_dir_all(&tmp).ok();

    assert!(
        legacy_manifests
            .iter()
            .any(|m| m.id == "com.test.legacy-plugin"),
        "legacy RYU_APPS_DIR should still be honoured"
    );
}

// ── requires / targets ────────────────────────────────────────────────────

/// Parse a manifest through the real validation funnel (the same one the
/// loader uses for built-ins and disk manifests).
fn parse(raw: &str) -> Result<PluginManifest, String> {
    let mut seen = HashSet::new();
    PluginManifestLoader::parse_and_validate(raw, "<test>", None, &mut seen)
        .map_err(|e| e.to_string())
}

const NO_DEPS: &str = r#"{
        "id": "legacy.plugin",
        "name": "Legacy Plugin",
        "version": "1.0.0",
        "runnables": []
    }"#;

/// BACKWARD COMPAT — the single most important test here. A manifest with
/// neither `requires` nor `targets` (i.e. all 37 shipped fixtures) must still
/// parse, and must mean "no dependencies, runs on EVERY surface". An absent
/// `targets` must never be read as "hidden", or every existing plugin vanishes.
#[test]
fn manifest_without_requires_or_targets_means_no_deps_all_surfaces() {
    let m = parse(NO_DEPS).expect("a manifest with no requires/targets must parse");

    assert!(m.requires.is_none());
    assert!(m.dependencies().is_empty(), "absent requires = no deps");

    assert!(m.targets.is_empty());
    for surface in [
        Surface::Gateway,
        Surface::Core,
        Surface::Desktop,
        Surface::Island,
        Surface::Mobile,
        Surface::Extension,
        Surface::Web,
        Surface::Cli,
    ] {
        assert!(
            m.supports_surface(surface),
            "empty targets must mean EVERY surface, not none ({surface:?})"
        );
    }
}

/// Every shipped built-in must still load with the new fields present on the
/// struct — the concrete guarantee that these fields break no existing plugin.
///
/// The guarantee is precisely about manifests that declare **nothing**: absent
/// `requires` = no dependencies, absent/empty `targets` = every surface. It is
/// NOT "no built-in may ever declare them" — a built-in that *does* (Meetings
/// requires Spaces; anything with explicit `targets`) is the feature working as
/// designed. So each assertion is scoped to the undeclared case, which is the
/// one that must never change behaviour.
/// EVERY compiled-in manifest must parse. `load_builtins` is a
/// `filter_map(...ok())` and `load` only `warn!`s, so a manifest that fails
/// validation does not fail loudly — the app simply CEASES TO EXIST at runtime,
/// with its sidecars, MCP servers and contributions along with it. That silent
/// mode is the reason this is asserted rather than trusted.
///
/// The count check is the load-bearing half: iterating the survivors can never
/// notice the one that did not survive.
#[test]
fn every_compiled_in_manifest_parses_and_none_is_silently_dropped() {
    let mut seen_ids = HashSet::new();
    let manifests = BUILTIN_MANIFESTS
        .iter()
        .map(|raw| {
            let id = serde_json::from_str::<serde_json::Value>(raw)
                .ok()
                .and_then(|value| value.get("id")?.as_str().map(str::to_owned))
                .unwrap_or_else(|| "<unknown built-in>".to_owned());
            PluginManifestLoader::parse_and_validate(raw, "<built-in>", None, &mut seen_ids)
                .unwrap_or_else(|error| panic!("built-in manifest '{id}' was dropped: {error}"))
        })
        .collect::<Vec<_>>();

    // A declared MCP server that names NEITHER a spawnable command nor a remote
    // url clears no gate and reaches nothing: `mcp_server_is_present` rejects
    // both blanks, so the declaration is dead weight that looks live in the
    // manifest. Asserted through that one probe rather than re-deriving the
    // rule here, so the manifest invariant and the registration gate can never
    // disagree about what "declared but unreachable" means. Generic over all
    // built-ins — no app is named here.
    for m in &manifests {
        for (name, decl) in &m.mcp_servers {
            let lowered = crate::sidecar::mcp::mcp_server_config_from_decl(decl);
            assert!(
                lowered.command.is_some() || lowered.url.is_some(),
                "built-in '{}' declares MCP server '{name}' with neither a command \
                     nor a url",
                m.id
            );
        }
    }
}

#[test]
fn builtins_that_declare_nothing_keep_their_old_permissive_behaviour() {
    // `load_builtins`, not `load`: the latter also scans the developer's real
    // ~/.ryu/plugins, which would make this assertion depend on what they
    // happen to have installed.
    let manifests = PluginManifestLoader::load_builtins();
    assert!(!manifests.is_empty(), "built-ins must load");
    for m in &manifests {
        if m.requires.is_none() {
            assert!(
                m.dependencies().is_empty(),
                "built-in '{}' declares no `requires`, so it must have no dependencies",
                m.id
            );
        }
        // Scoped on BOTH forms being absent. `surfaces` supersedes `targets`
        // and inverts its default, so a manifest that declares a `surfaces`
        // map has an empty `targets` list while being anything but permissive
        // — checking `targets` alone would demand every declared app surface
        // everywhere, which is the opposite of what declaring means.
        if m.surfaces.is_none() && m.targets.is_empty() {
            for surface in [
                Surface::Gateway,
                Surface::Core,
                Surface::Desktop,
                Surface::Island,
                Surface::Mobile,
                Surface::Extension,
                Surface::Web,
                Surface::Cli,
            ] {
                assert!(
                    m.supports_surface(surface),
                    "built-in '{}' declares neither `surfaces` nor `targets`, so \
                         it must surface on EVERY host ({surface:?})",
                    m.id
                );
            }
        }
    }
}

#[test]
fn opt_in_local_model_plugins_are_installable_but_not_runtime_or_preinstalled() {
    let install_catalog = PluginManifestLoader::load_install_catalog();
    let runtime = PluginManifestLoader::load_runtime_builtins_for_test();

    for id in ["@ryu/laya", "@ryu/functiongemma", "@ryu/needle3"] {
        let manifest = install_catalog
            .iter()
            .find(|manifest| manifest.id == id)
            .unwrap_or_else(|| panic!("{id} must be in the compiled install catalog"));
        assert!(
            !runtime.iter().any(|manifest| manifest.id == id),
            "{id} must not enter the runtime set before installation"
        );
        assert!(
            !crate::plugins::builtins::is_preinstalled(id),
            "{id} must remain opt-in"
        );
        assert_eq!(
            crate::plugins::builtins::tier_for_manifest(manifest),
            PluginTier::Core,
            "{id} must retain its compiled Core trust tier"
        );
    }
}

/// The sharp edge of the `surfaces` map: it INVERTS the `targets` default, so
/// an absent key means *unsupported*. A map that forgets a surface — or marks
/// every surface `none` — silently delists the app with no error anywhere.
///
/// This is the guard for that. A built-in that declares a map must be reachable
/// somewhere, and must be reachable on at least one surface a human can
/// actually use (`core` alone is a headless node, not a place anyone browses).
#[test]
fn a_declared_surfaces_map_never_delists_a_builtin_everywhere() {
    let manifests = PluginManifestLoader::load_builtins();
    assert!(!manifests.is_empty(), "built-ins must load");

    // Surfaces a person actually interacts with. `gateway` and `core` are
    // headless hosts, so support there does not make an app reachable.
    const HUMAN_SURFACES: [Surface; 6] = [
        Surface::Desktop,
        Surface::Island,
        Surface::Mobile,
        Surface::Extension,
        Surface::Web,
        Surface::Cli,
    ];

    for m in &manifests {
        if m.surfaces.is_none() {
            continue;
        }
        assert!(
            HUMAN_SURFACES.iter().any(|s| m.supports_surface(*s)),
            "built-in '{}' declares a `surfaces` map that supports no \
                 human-facing surface — it would vanish from every client",
            m.id
        );
    }
}

#[test]
fn requires_and_targets_round_trip() {
    let raw = r#"{
            "id": "meetings",
            "name": "Meetings",
            "version": "1.0.0",
            "runnables": [],
            "requires": {
                "apps": [
                    { "id": "spaces", "min_version": "1.2.0" },
                    { "id": "voice" }
                ],
                "grants": ["spaces:docs"]
            },
            "targets": ["desktop", "island"]
        }"#;
    let m = parse(raw).expect("requires/targets must parse");

    let deps = m.dependencies();
    assert_eq!(deps.len(), 2);
    assert_eq!(deps[0].id, "spaces");
    assert_eq!(deps[0].min_version.as_deref(), Some("1.2.0"));
    assert_eq!(deps[1].id, "voice");
    assert!(deps[1].min_version.is_none(), "min_version is optional");
    assert_eq!(
        m.requires.as_ref().unwrap().grants,
        vec!["spaces:docs".to_owned()]
    );

    assert_eq!(m.targets, vec![Surface::Desktop, Surface::Island]);

    // Serialising and re-parsing preserves both (the manifest is signed
    // verbatim, so the round-trip must be lossless).
    let json = serde_json::to_string(&m).unwrap();
    let back: PluginManifest = serde_json::from_str(&json).unwrap();
    assert_eq!(back, m);
}

/// The omitted fields must not appear in the serialised form — an existing
/// manifest must re-serialise byte-identically, so its signature still verifies.
#[test]
fn absent_requires_and_targets_are_not_serialised() {
    let m = parse(NO_DEPS).unwrap();
    let json = serde_json::to_value(&m).unwrap();
    assert!(
        json.get("requires").is_none(),
        "absent requires must be omitted"
    );
    assert!(
        json.get("targets").is_none(),
        "empty targets must be omitted"
    );
}

// ── explicit targets: filtering ───────────────────────────────────────────

#[test]
fn explicit_targets_are_respected() {
    let raw = r#"{
            "id": "desktop.only",
            "name": "Desktop Only",
            "version": "1.0.0",
            "runnables": [],
            "targets": ["desktop"]
        }"#;
    let m = parse(raw).unwrap();
    assert!(m.supports_surface(Surface::Desktop));
    assert!(!m.supports_surface(Surface::Mobile));
    assert!(!m.supports_surface(Surface::Cli));
    assert!(!m.supports_surface(Surface::Core));
}

/// Replaces `unknown_surface_is_rejected`, which pinned the behaviour this
/// deliberately removes.
///
/// A surface token an older build has never heard of used to fail
/// deserialization and take the WHOLE manifest with it — so the first release
/// that added a surface would break every plugin naming it on every older
/// client. It now lands on [`Surface::Unknown`] and simply reads as "not that
/// surface", which is what an older client should conclude.
#[test]
fn unknown_surface_degrades_instead_of_killing_the_manifest() {
    let raw = r#"{
            "id": "future.surface",
            "name": "Future Surface",
            "version": "1.0.0",
            "runnables": [],
            "targets": ["desktop", "toaster"]
        }"#;
    let m = parse(raw).expect("an unknown surface must NOT fail the manifest");

    // The surfaces we do understand still work exactly as declared.
    assert!(m.supports_surface(Surface::Desktop));
    // The unknown one narrows, never widens: it cannot match a real surface,
    // and an explicit target list still excludes everything not named.
    assert!(!m.supports_surface(Surface::Web));
    assert!(!m.supports_surface(Surface::Mobile));
    // And asking about Unknown itself is always false — a manifest must never be
    // able to claim support for a surface this build cannot verify.
    assert!(!m.supports_surface(Surface::Unknown));
}

/// A manifest aimed ONLY at surfaces we do not know must render nowhere, not
/// everywhere. Dropping unknown entries and falling back to "empty targets means
/// all surfaces" would invert the author's intent completely.
#[test]
fn a_manifest_targeting_only_future_surfaces_appears_nowhere() {
    let raw = r#"{
            "id": "future.only",
            "name": "Future Only",
            "version": "1.0.0",
            "runnables": [],
            "targets": ["toaster", "fridge"]
        }"#;
    let m = parse(raw).expect("unknown surfaces must not fail the manifest");
    for s in [
        Surface::Desktop,
        Surface::Web,
        Surface::Mobile,
        Surface::Cli,
        Surface::Island,
        Surface::Extension,
    ] {
        assert!(
            !m.supports_surface(s),
            "a future-only manifest must not appear on {s:?}"
        );
    }
}

/// The `surfaces` map equivalent, plus the support-level landing pad: an
/// unrecognised LEVEL counts as supported (the author said it works here, just in
/// a way we cannot describe), while an explicit `none` still excludes.
#[test]
fn unknown_surface_support_level_counts_as_supported() {
    let raw = r#"{
            "id": "future.level",
            "name": "Future Level",
            "version": "1.0.0",
            "runnables": [],
            "surfaces": {
                "desktop": { "support": "read-only" },
                "web": { "support": "full" },
                "mobile": { "support": "none" }
            }
        }"#;
    let m = parse(raw).expect("an unknown support level must NOT fail the manifest");
    assert!(
        m.supports_surface(Surface::Desktop),
        "an unknown level must not delist a surface the author explicitly listed"
    );
    assert!(m.supports_surface(Surface::Web));
    assert!(
        !m.supports_surface(Surface::Mobile),
        "explicit none excludes"
    );
    // Absent key = unsupported (the `surfaces` map inverts the `targets` default).
    assert!(!m.supports_surface(Surface::Cli));
}

#[test]
fn surface_tokens_round_trip_through_parse() {
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
        assert_eq!(Surface::parse(s.as_str()), Some(s));
        // The wire token must match the serde (kebab-case) encoding exactly.
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(json, format!("\"{}\"", s.as_str()));
    }
    assert_eq!(Surface::parse("DESKTOP"), Some(Surface::Desktop));
    assert_eq!(Surface::parse("nonsense"), None);
}

// ── requires: shape validation ────────────────────────────────────────────

#[test]
fn self_dependency_is_rejected_at_load() {
    let raw = r#"{
            "id": "narcissus",
            "name": "Narcissus",
            "version": "1.0.0",
            "runnables": [],
            "requires": { "apps": [{ "id": "narcissus" }] }
        }"#;
    let err = parse(raw).expect_err("a self-dependency must be rejected");
    assert!(err.contains("cannot depend on itself"), "got: {err}");
}

#[test]
fn malformed_min_version_is_rejected_at_load() {
    let raw = r#"{
            "id": "app",
            "name": "App",
            "version": "1.0.0",
            "runnables": [],
            "requires": { "apps": [{ "id": "lib", "min_version": "not-a-version" }] }
        }"#;
    let err = parse(raw).expect_err("a malformed min_version must be rejected");
    assert!(err.contains("min_version"), "got: {err}");
}

// A tool persisted before the `inline_deno` → `inline_js` rename (an
// agent-built `write_tool` tool, an older SDK pack, an earlier marketplace
// install) must still load after an upgrade, not be skipped as invalid.
#[test]
fn legacy_inline_deno_tool_still_loads() {
    let raw = r#"{
            "id": "legacy-tool",
            "name": "Legacy Tool",
            "version": "1.0.0",
            "permission_grants": ["tool:execute"],
            "runnables": [{
                "id": "tool-demo",
                "name": "Demo",
                "kind": "tool",
                "config": { "slug": "demo", "backend": "inline_deno", "code": "return 1;" }
            }]
        }"#;
    let manifest = parse(raw).expect("a legacy inline_deno tool must load");
    let config: schema::ToolConfig =
        serde_json::from_value(manifest.runnables[0].config.clone().unwrap()).unwrap();
    assert_eq!(
        config.resolve_backend().unwrap(),
        schema::ToolBackend::InlineJs {
            code: "return 1;".to_owned()
        }
    );
}

#[test]
fn duplicate_dependency_is_rejected_at_load() {
    let raw = r#"{
            "id": "app",
            "name": "App",
            "version": "1.0.0",
            "runnables": [],
            "requires": { "apps": [{ "id": "lib" }, { "id": "lib" }] }
        }"#;
    let err = parse(raw).expect_err("a duplicate dependency must be rejected");
    assert!(err.contains("duplicate dependency"), "got: {err}");
}

// ── min_version semantics ─────────────────────────────────────────────────

/// The load-bearing semver decision: a bare `min_version` is a MINIMUM, not
/// semver's default caret range. `VersionReq::parse("1.2.0")` means `^1.2.0`
/// and would REJECT 2.0.0; `parse_min_version` must accept it.
#[test]
fn bare_min_version_is_a_minimum_not_a_caret() {
    let req = parse_min_version("1.2.0").unwrap();
    assert!(
        req.matches(&semver::Version::parse("1.2.0").unwrap()),
        "exact"
    );
    assert!(
        req.matches(&semver::Version::parse("1.9.9").unwrap()),
        "minor"
    );
    assert!(
        req.matches(&semver::Version::parse("2.0.0").unwrap()),
        "a bare min_version must accept a NEWER MAJOR — this is the whole point"
    );
    assert!(
        !req.matches(&semver::Version::parse("1.1.0").unwrap()),
        "below the minimum is still rejected"
    );
}

#[test]
fn explicit_comparators_are_honoured_verbatim() {
    // The caret escape hatch still pins the major when asked for explicitly.
    let caret = parse_min_version("^1.2.0").unwrap();
    assert!(caret.matches(&semver::Version::parse("1.9.0").unwrap()));
    assert!(!caret.matches(&semver::Version::parse("2.0.0").unwrap()));

    let range = parse_min_version(">=1.0, <2").unwrap();
    assert!(range.matches(&semver::Version::parse("1.5.0").unwrap()));
    assert!(!range.matches(&semver::Version::parse("2.0.0").unwrap()));
}

#[test]
fn invalid_min_version_strings_are_errors() {
    assert!(parse_min_version("not-a-version").is_err());
    assert!(parse_min_version("").is_err());
}

// ── Every fixture in `fixtures/*.manifest.json` must be well-formed ───────
//
// `BUILTIN_MANIFESTS` only `include_str!`s the SHIPPED subset, so `load()` never
// touches the reference/sample fixtures (`sample`, `tool-firewall`,
// `hook-observers`, `agents`, …). A truncated or malformed one of those would
// compile fine and slip past every existing test. This reads the directory at
// runtime (like `packaged_manifests_match_their_core_fixtures_and_are_registered`) so ALL of
// them are exercised, and is skipped on any tree that ships without the folder.

/// Every built-in manifest in this tree, from BOTH homes.
///
/// Manifests used to live only in `plugin_manifest/fixtures/`. The packaged ones
/// now live in `apps-store/<x>/manifest.json` /
/// `plugins-store/{plugins,lsp,external_plugins}/<x>/manifest.json`
/// and Core `include_str!`s them directly — the duplicate fixture copies are gone.
/// Only the ~13 Core-only manifests (no package home: `layers`, `memory`, `rag`,
/// …) still sit in `fixtures/`.
///
/// So this MUST read both roots. Reading only `fixtures/` would still return a
/// non-empty list and every caller below would still pass — while silently
/// covering 13 manifests instead of 71. That is the exact failure mode this
/// helper exists to prevent, so the shrink must not be possible: each root is
/// skipped only when its directory is absent (mirror/satellite trees).
fn fixture_plugin_json_paths() -> Vec<std::path::PathBuf> {
    let core = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = core.join("..").join("..");
    let mut paths: Vec<std::path::PathBuf> = Vec::new();

    // 1. Core-only manifests still living beside the crate.
    if let Ok(entries) = std::fs::read_dir(core.join("src/plugin_manifest/fixtures")) {
        paths.extend(entries.flatten().map(|e| e.path()).filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(".manifest.json"))
        }));
    }

    // 2. The packaged manifests Core compiles in from the package roots.
    paths.extend(
        packaged_dirs(&repo_root, "apps-store")
            .into_iter()
            .chain(packaged_dirs(&repo_root, "plugins-store"))
            .map(|(_, dir)| dir.join("manifest.json")),
    );

    paths.sort();
    paths
}

#[test]
fn every_fixture_deserializes_into_a_plugin_manifest() {
    let paths = fixture_plugin_json_paths();
    assert!(
        !paths.is_empty(),
        "fixtures/*.manifest.json must be present in this tree"
    );
    for path in &paths {
        let raw = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("{} unreadable: {e}", path.display()));
        let manifest: PluginManifest = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("{} failed to deserialise: {e}", path.display()));
        assert!(
            !manifest.id.trim().is_empty(),
            "{} has an empty id",
            path.display()
        );
        assert!(
            !manifest.name.trim().is_empty(),
            "{} has an empty name",
            path.display()
        );
    }
}

#[test]
fn every_fixture_has_a_valid_id_and_semver_version() {
    for path in &fixture_plugin_json_paths() {
        let raw = std::fs::read_to_string(path).expect("read fixture");
        let manifest: PluginManifest = serde_json::from_str(&raw).expect("deserialise fixture");
        validate_plugin_id(&manifest.id)
            .unwrap_or_else(|e| panic!("{} has an invalid plugin id: {e}", path.display()));
        semver::Version::parse(&manifest.version).unwrap_or_else(|e| {
            panic!(
                "{} version '{}' is not semver: {e}",
                path.display(),
                manifest.version
            )
        });
    }
}

#[test]
fn every_fixture_passes_parse_and_validate_independently() {
    // Each fixture, validated in isolation (a fresh `seen_ids`), must clear the
    // full loader contract — per-kind config, sidecar/companion/contributes
    // cross-checks — even the ones `load()` never reaches. `engines`-gated
    // fixtures are exempt: their `engines.ryu` is version-pinned and is a
    // deliberate load-time rejection, not a malformed manifest.
    for path in &fixture_plugin_json_paths() {
        let raw = std::fs::read_to_string(path).expect("read fixture");
        let manifest: PluginManifest = serde_json::from_str(&raw).expect("deserialise fixture");
        if manifest.engines.is_some() {
            continue;
        }
        let mut seen = HashSet::new();
        PluginManifestLoader::parse_and_validate(&raw, "<fixture>", None, &mut seen)
            .unwrap_or_else(|e| panic!("{} failed parse_and_validate: {e}", path.display()));
    }
}

#[test]
fn fixture_ids_are_unique_across_the_directory() {
    let mut seen: HashSet<String> = HashSet::new();
    for path in &fixture_plugin_json_paths() {
        let raw = std::fs::read_to_string(path).expect("read fixture");
        let manifest: PluginManifest = serde_json::from_str(&raw).expect("deserialise fixture");
        assert!(
            seen.insert(manifest.id.clone()),
            "duplicate fixture id '{}' at {}",
            manifest.id,
            path.display()
        );
    }
}
