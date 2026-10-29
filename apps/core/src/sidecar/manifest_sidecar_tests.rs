use super::*;
use crate::plugin_manifest::schema::ExternalRuntimeConfig;
use crate::plugin_manifest::PluginTier;

#[test]
fn installed_sidecar_identity_does_not_recover_catalog_secrets() {
    let mut installed = crate::plugin_manifest::PluginManifestLoader::load_install_catalog()
        .into_iter()
        .find(|manifest| manifest.id == "@ryu/meetings")
        .expect("compiled Meetings manifest");
    let spec = installed
        .sidecars
        .first()
        .expect("Meetings sidecar")
        .clone();
    installed.name.push_str(" altered installed package");
    let plugins_dir = crate::plugin_manifest::PluginManifestLoader::plugins_dir();
    std::fs::create_dir_all(&plugins_dir).unwrap();
    let package = tempfile::tempdir_in(&plugins_dir).unwrap();
    std::fs::write(
        package.path().join("manifest.json"),
        serde_json::to_vec(&installed).unwrap(),
    )
    .unwrap();
    let loaded = owning_manifest(&installed.id).expect("installed runtime manifest");
    assert_eq!(loaded.name, installed.name);
    assert!(loaded.sidecars.contains(&spec));
    assert!(!crate::plugins::builtins::is_exact_compiled_manifest(
        &loaded
    ));
    let mut env = BTreeMap::new();
    inject_shadow_env(&mut env, &installed.id, &spec);
    assert!(!env.contains_key("SHADOW_API_TOKEN"));
    assert!(!env.contains_key("SHADOW_API_TOKEN_FILE"));
}

#[tokio::test]
async fn clef_sidecar_declared_env_keeps_reserved_runtime_values_authoritative() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let mut env = BTreeMap::from([
        ("RYU_EXT_TOKEN".to_owned(), "manifest-token".to_owned()),
        ("RYU_EXT_PLUGIN_ID".to_owned(), "manifest-owner".to_owned()),
        (
            "MISSING".to_owned(),
            "env:RYU_PLUGIN_CLEFSCOPEPROOF_MISSING".to_owned(),
        ),
        (
            crate::sidecar::cli_shims::ENV_CORE_PORT.to_owned(),
            "1".to_owned(),
        ),
    ]);
    resolve_declared_env(&mut env, "clefscopeproof", None).await;
    inject_ext_env(&mut env, "clefscopeproof", "minted-test-token", false).unwrap();
    assert_eq!(env["RYU_EXT_TOKEN"], "minted-test-token");
    assert_eq!(env["RYU_EXT_PLUGIN_ID"], "clefscopeproof");
    assert!(!env.contains_key("MISSING"));
    assert_eq!(
        env[crate::sidecar::cli_shims::ENV_CORE_PORT],
        crate::sidecar::cli_shims::core_port_string()
    );
    assert!(!env.contains_key("RYU_TOKEN"));
    assert!(!env.contains_key("RYU_MASTER_KEY"));
    assert!(matches!(
        env[crate::entitlement::BRANDING_REMOVABLE_ENV].as_str(),
        "0" | "1"
    ));
}

/// Every manifest sidecar gets its own plugin-scoped sealing subkey, never
/// the master key, and a manifest cannot declare another plugin's scope.
#[test]
fn sidecar_env_carries_only_the_plugin_scoped_seal_key() {
    crate::server::gateway_seal_test_key();
    let master = std::env::var("RYU_MASTER_KEY").expect("test master key set");
    let mut env = BTreeMap::from([
        (ryu_crypto::SEAL_KEY_ENV.to_owned(), "forged".to_owned()),
        (
            ryu_crypto::SEAL_SCOPE_ENV.to_owned(),
            "plugin:@ryu/other".to_owned(),
        ),
        ("RYU_MASTER_KEY".to_owned(), master.clone()),
    ]);
    inject_seal_env(&mut env, "@ryu/mail", true);
    assert!(!env.contains_key("RYU_MASTER_KEY"));
    assert_eq!(env[ryu_crypto::SEAL_SCOPE_ENV], "plugin:@ryu/mail");
    let delivered = &env[ryu_crypto::SEAL_KEY_ENV];
    assert_ne!(delivered, "forged");
    assert_ne!(delivered, &master);
    // A usable subkey, and a different one for every plugin.
    let child = ryu_crypto::PluginCipher::from_subkey_b64("@ryu/mail", delivered).unwrap();
    let sealed = child.seal("whsec_x").unwrap();
    assert_eq!(child.open(&sealed).unwrap(), "whsec_x");
    let mut other = BTreeMap::new();
    inject_seal_env(&mut other, "@ryu/social", true);
    assert_ne!(&other[ryu_crypto::SEAL_KEY_ENV], delivered);
}

/// A sidecar that does not declare `crypto:seal` gets no key at all, and a
/// manifest-declared one is still dropped, so its children inherit nothing.
#[test]
fn sidecar_without_the_seal_grant_gets_no_seal_key() {
    crate::server::gateway_seal_test_key();
    let mut env = BTreeMap::from([
        (ryu_crypto::SEAL_KEY_ENV.to_owned(), "forged".to_owned()),
        (
            ryu_crypto::SEAL_SCOPE_ENV.to_owned(),
            "plugin:@ryu/x".to_owned(),
        ),
        ("RYU_MASTER_KEY".to_owned(), "forged-master".to_owned()),
    ]);
    inject_seal_env(&mut env, "@ryu/research", false);
    for name in ryu_crypto::SEAL_ENV_VARS {
        assert!(!env.contains_key(name), "{name} leaked");
    }

    let spec = |grants: &[&str]| -> SidecarSpec {
        serde_json::from_value(serde_json::json!({
            "name": "s",
            "process": { "kind": "local", "command": "ryu-x" },
            "port": 1,
            "host_api": { "grants": grants },
        }))
        .unwrap()
    };
    assert!(seals_at_rest(&spec(&["tools.invoke", "crypto:seal"])));
    assert!(!seals_at_rest(&spec(&["tools.invoke"])));
    let mut bare = spec(&[]);
    bare.host_api = None;
    assert!(!seals_at_rest(&bare));
}

/// Only the compiled-in apps that seal content in their own stores declare
/// the grant; apps that hand their environment to third-party children
/// (`gh`, Chromium, ffmpeg) do not, so those children never inherit a
/// subkey. Research does seal, but its sidecar captures the key before its
/// runtime starts and spawns every experiment child with a cleared
/// environment (`apps-store/research/backend/src/engine_runtime.rs`).
#[test]
fn only_sealing_apps_receive_a_seal_key() {
    let catalog = crate::plugin_manifest::PluginManifestLoader::load_install_catalog();
    let seals = |id: &str| -> bool {
        catalog
            .iter()
            .find(|manifest| manifest.id == id)
            .unwrap_or_else(|| panic!("compiled manifest {id}"))
            .sidecars
            .iter()
            .any(seals_at_rest)
    };
    for id in [
        "@ryu/mail",
        "@ryu/social",
        "@ryu/monitors",
        "@ryu/dashboards",
        "@ryu/research",
        "@ryu/projects",
    ] {
        assert!(seals(id), "{id} must receive its seal key");
    }
    for id in ["@ryu/browser", "@ryu/pull-requests"] {
        assert!(!seals(id), "{id} must not receive a seal key");
    }
}

fn egress_request_env() -> BTreeMap<String, String> {
    BTreeMap::from([
        ("KEEP".to_owned(), "1".to_owned()),
        (
            crate::local_egress::BROWSER_PROXY_ENV.to_owned(),
            EGRESS_PROXY_URL_REQUEST.to_owned(),
        ),
    ])
}

fn compiled_browser_manifest() -> crate::plugin_manifest::PluginManifest {
    crate::plugin_manifest::PluginManifestLoader::load_install_catalog()
        .into_iter()
        .find(|manifest| manifest.id == "@ryu/browser")
        .expect("compiled Browser manifest")
}

/// The Browser's Local sidecar (the one that declares the egress request),
/// selected by process kind so a reordered `sidecars` list cannot quietly
/// hand these tests a different spec.
fn browser_local_sidecar(manifest: &crate::plugin_manifest::PluginManifest) -> SidecarSpec {
    manifest
        .sidecars
        .iter()
        .find(|spec| matches!(spec.process, SidecarProcess::Local(_)))
        .cloned()
        .expect("Browser Local sidecar")
}

#[test]
fn compiled_browser_manifest_declares_the_egress_proxy_request() {
    let browser = compiled_browser_manifest();
    assert!(crate::plugins::builtins::is_exact_compiled_manifest(
        &browser
    ));
    let declares = browser.sidecars.iter().any(|spec| match &spec.process {
        SidecarProcess::Local(local) => {
            local
                .env
                .get(crate::local_egress::BROWSER_PROXY_ENV)
                .map(String::as_str)
                == Some(EGRESS_PROXY_URL_REQUEST)
        }
        _ => false,
    });
    assert!(declares, "the browser sidecar opts in through its env");
}

#[test]
fn trusted_egress_request_receives_the_proxy_url() {
    let mut env = egress_request_env();
    apply_egress_route_request(
        &mut env,
        true,
        Some("socks5://ryu:pw@127.0.0.1:4100".to_owned()),
    );
    assert_eq!(
        env[crate::local_egress::BROWSER_PROXY_ENV],
        "socks5://ryu:pw@127.0.0.1:4100"
    );
    assert_eq!(env["KEEP"], "1");
}

#[test]
fn untrusted_egress_request_gets_nothing() {
    let mut env = egress_request_env();
    apply_egress_route_request(
        &mut env,
        false,
        Some("socks5://ryu:pw@127.0.0.1:4100".to_owned()),
    );
    assert!(!env.contains_key(crate::local_egress::BROWSER_PROXY_ENV));
    assert_eq!(env["KEEP"], "1");
}

#[test]
fn egress_request_without_a_url_never_leaks_the_placeholder() {
    let mut env = egress_request_env();
    apply_egress_route_request(&mut env, true, None);
    assert!(!env.contains_key(crate::local_egress::BROWSER_PROXY_ENV));
    assert!(env.values().all(|v| v != EGRESS_PROXY_URL_REQUEST));
}

#[test]
fn undeclared_egress_request_is_left_untouched() {
    let spec = browser_local_sidecar(&compiled_browser_manifest());
    let mut env = BTreeMap::from([("KEEP".to_owned(), "1".to_owned())]);
    inject_egress_route_env(&mut env, "@ryu/browser", &spec);
    assert_eq!(env, BTreeMap::from([("KEEP".to_owned(), "1".to_owned())]));
}

#[test]
fn non_compiled_manifest_declaring_the_egress_request_gets_nothing() {
    let mut installed = compiled_browser_manifest();
    installed.name.push_str(" altered installed package");
    let spec = browser_local_sidecar(&installed);
    let plugins_dir = crate::plugin_manifest::PluginManifestLoader::plugins_dir();
    std::fs::create_dir_all(&plugins_dir).unwrap();
    let package = tempfile::tempdir_in(&plugins_dir).unwrap();
    std::fs::write(
        package.path().join("manifest.json"),
        serde_json::to_vec(&installed).unwrap(),
    )
    .unwrap();
    let mut env = egress_request_env();
    inject_egress_route_env(&mut env, &installed.id, &spec);
    assert!(!env.contains_key(crate::local_egress::BROWSER_PROXY_ENV));
    // A third-party id declaring the request is stripped too.
    let mut env = egress_request_env();
    inject_egress_route_env(&mut env, "thirdparty", &spec);
    assert!(!env.contains_key(crate::local_egress::BROWSER_PROXY_ENV));
}

#[test]
fn plugin_sidecars_get_their_data_dir_and_the_shared_model_caches() {
    let root = tempfile::tempdir().unwrap();
    let mut env = BTreeMap::from([
        (
            "RYU_PLUGIN_DATA_DIR".to_owned(),
            "/manifest/override".to_owned(),
        ),
        ("TORCH_HOME".to_owned(), "/manifest/torch".to_owned()),
        (
            "PIP_CONSTRAINT".to_owned(),
            "/manifest/loose.txt".to_owned(),
        ),
    ]);
    inject_data_layout_env(&mut env, root.path(), "@ryu/meetings");
    assert!(
        env["PIP_CONSTRAINT"].ends_with("pip-security-constraints.txt"),
        "Core's Brotli floor replaces a manifest-declared PIP_CONSTRAINT"
    );
    let data = root.path().join("plugin-data").join("@ryu+meetings");
    assert_eq!(env["RYU_PLUGIN_DATA_DIR"], data.to_string_lossy());
    assert!(data.is_dir(), "the plugin data dir is created at spawn");
    assert_eq!(
        env["RYU_MODELS_DIR"],
        root.path().join("models").to_string_lossy()
    );
    assert_eq!(
        env["HF_HOME"],
        root.path().join("models").join("hf").to_string_lossy()
    );
    // A manifest-declared cache home is kept.
    assert_eq!(env["TORCH_HOME"], "/manifest/torch");
}

#[test]
fn manifest_env_expands_every_data_dir_token() {
    let declared = BTreeMap::from([
        ("A".to_owned(), "${RYU_PLUGIN_DATA_DIR}/datasets".to_owned()),
        ("B".to_owned(), "${RYU_MODELS_DIR}/hf".to_owned()),
        ("C".to_owned(), "${RYU_DIR}/x:${RYU_PLUGIN_DIR}".to_owned()),
        ("D".to_owned(), "${RYU_RUNTIME_DIR}/cache".to_owned()),
    ]);
    let plugin_dir = Path::new("/p/plugins/@ryu+finetune");
    let ryu = crate::paths::ryu_dir();
    let python = expand_manifest_env(
        &declared,
        "@ryu/finetune",
        plugin_dir,
        Some(Path::new("/rt")),
    );
    assert_eq!(
        python["A"],
        format!(
            "{}/datasets",
            ryu.join("plugin-data").join("@ryu+finetune").display()
        )
    );
    assert_eq!(python["B"], format!("{}/hf", ryu.join("models").display()));
    assert_eq!(
        python["C"],
        format!("{}/x:{}", ryu.display(), plugin_dir.display())
    );
    assert_eq!(python["D"], "/rt/cache");
    let local = expand_manifest_env(&declared, "@ryu/finetune", plugin_dir, None);
    assert_eq!(local["D"], "${RYU_RUNTIME_DIR}/cache");
}

fn binary_spec() -> SidecarSpec {
    SidecarSpec {
        name: "engine".to_owned(),
        process: SidecarProcess::Binary(BinarySpec {
            url: "https://example.com/dl/my-engine".to_owned(),
            sha256: None,
            version: "1.2.3".to_owned(),
            archive: None,
            binary_name: None,
            args: vec!["--port".to_owned(), "9099".to_owned()],
            env: BTreeMap::new(),
        }),
        port: 9099,
        health_path: "/health".to_owned(),
        http: None,
        host_api: None,
        lazy: false,
        idle_stop_secs: None,
        provides_provider: None,
        sandbox: None,
    }
}

#[tokio::test]
async fn ensure_binary_refuses_community_sidecar_without_sha256() {
    // A Community-tier plugin (anything not in CORE_PLUGINS) with a Binary
    // sidecar and no sha256 must fail closed BEFORE any network/disk work.
    let SidecarProcess::Binary(bin) = &binary_spec().process else {
        panic!("binary_spec is a Binary process");
    };
    assert!(bin.sha256.is_none());
    let downloads = crate::downloads::DownloadCenter::with_default_client();
    let err = ensure_binary(
        "com.example.community-tool",
        bin,
        Path::new("/nonexistent/plugins/com.example.community-tool"),
        &downloads,
    )
    .await
    .expect_err("must refuse an unverifiable community binary");
    assert!(err.to_string().contains("no sha256"), "got: {err}");
}

#[test]
fn namespaced_name_joins_plugin_and_local() {
    assert_eq!(
        namespaced_name("com.acme.tool", "engine"),
        "com.acme.tool/engine"
    );
}

/// The `provides_provider` block a bridge manifest ships (see
/// `examples/auth-bridge/build.mjs`) deserializes and yields the loopback baseUrl
/// Core registers. Pins the on-the-wire field names so the example cannot silently
/// drift from the Rust contract.
#[test]
fn provides_provider_deserializes_from_manifest_json() {
    let spec: SidecarSpec = serde_json::from_str(
        r#"{
                "name": "bridge",
                "process": { "kind": "node", "entry": "./backend.js" },
                "port": 7997,
                "health_path": "/health",
                "provides_provider": {
                    "id": "chatgpt-bridge",
                    "label": "ChatGPT (subscription bridge)",
                    "api": "openai-completions",
                    "base_path": "/v1",
                    "models": ["gpt-5", "gpt-5-codex"]
                }
            }"#,
    )
    .expect("bridge manifest should deserialize");

    let provider = spec.provides_provider.expect("provides_provider present");
    assert_eq!(provider.id, "chatgpt-bridge");
    assert_eq!(provider.effective_api(), "openai-completions");
    assert_eq!(provider.base_url(7997), "http://127.0.0.1:7997/v1");
    assert_eq!(provider.models.len(), 2);
}

/// Omitting the block leaves the sidecar a non-provider, and the optional
/// sub-fields fall back to their documented defaults.
#[test]
fn provides_provider_is_optional_with_defaults() {
    let spec: SidecarSpec = serde_json::from_str(
        r#"{
                "name": "plain",
                "process": { "kind": "node", "entry": "./x.js" },
                "port": 7001
            }"#,
    )
    .expect("manifest without provides_provider should deserialize");
    assert!(spec.provides_provider.is_none());

    let minimal: ProviderRegistrationSpec =
        serde_json::from_str(r#"{ "id": "some-bridge" }"#).expect("minimal spec");
    assert_eq!(minimal.effective_api(), "openai-completions");
    assert_eq!(minimal.base_url(9000), "http://127.0.0.1:9000/v1");
    assert!(minimal.models.is_empty());
}

#[test]
fn health_url_is_loopback() {
    assert_eq!(health_url(9099, "/health"), "http://127.0.0.1:9099/health");
    assert_eq!(
        health_url(8080, "/v1/ping"),
        "http://127.0.0.1:8080/v1/ping"
    );
}

#[test]
fn sidecar_name_is_namespaced() {
    let downloads = crate::downloads::DownloadCenter::with_default_client();
    let sc = ManifestSidecar::new("com.acme.tool".to_owned(), binary_spec(), downloads);
    assert_eq!(sc.name(), "com.acme.tool/engine");
    assert!(!sc.is_required());
    assert!(!sc.is_running());
    assert_eq!(sc.pid(), None);
    assert_eq!(sc.port(), Some(crate::profile::port(9099)));
}

#[test]
fn version_dir_is_namespaced() {
    let bin = BinarySpec {
        url: "https://example.com/dl/my-engine".to_owned(),
        sha256: None,
        version: "1.2.3".to_owned(),
        archive: None,
        binary_name: None,
        args: vec![],
        env: BTreeMap::new(),
    };
    let dir = version_dir(Path::new("/plugins/acme"), &bin);
    assert_eq!(dir, Path::new("/plugins/acme").join("bin").join("1.2.3"));
    assert_eq!(
        dir.join(url_filename(&bin.url).unwrap()),
        Path::new("/plugins/acme")
            .join("bin")
            .join("1.2.3")
            .join("my-engine")
    );
}

#[test]
fn url_filename_rejects_url_without_filename() {
    assert!(url_filename("https://example.com/dl/").is_err());
    assert_eq!(
        url_filename("https://example.com/a/b/tool").unwrap(),
        "tool"
    );
}

#[test]
fn core_tier_always_runs() {
    assert!(may_run_sidecar(PluginTier::Core, &[]));
    assert!(may_run_sidecar(
        PluginTier::Core,
        &["unrelated:grant".to_owned()]
    ));
}

#[test]
fn community_tier_needs_approved_grant() {
    assert!(!may_run_sidecar(PluginTier::Community, &[]));
    assert!(!may_run_sidecar(
        PluginTier::Community,
        &["mcp:web_search".to_owned()]
    ));
    assert!(may_run_sidecar(
        PluginTier::Community,
        &[GRANT_SIDECAR_PROCESS.to_owned()]
    ));
}

#[test]
fn python_flavor_builds() {
    let spec = SidecarSpec {
        name: "tts".to_owned(),
        process: SidecarProcess::Python(ExternalRuntimeConfig {
            kind: "python".to_owned(),
            entry: "ryu_tts".to_owned(),
            ..Default::default()
        }),
        port: 8085,
        health_path: "/health".to_owned(),
        http: None,
        host_api: None,
        lazy: false,
        idle_stop_secs: None,
        provides_provider: None,
        sandbox: None,
    };
    let downloads = crate::downloads::DownloadCenter::with_default_client();
    let sc = ManifestSidecar::new("com.acme.voice".to_owned(), spec, downloads);
    assert_eq!(sc.name(), "com.acme.voice/tts");
    assert_eq!(
        sc.health_url(),
        format!("http://127.0.0.1:{}/health", crate::profile::port(8085))
    );
}

/// **Defect 3.** `lazy: true` + `provides_provider` is an unsatisfiable pair, so
/// the provider declaration wins and the sidecar starts eagerly.
///
/// Without the coercion, the boot purge of stale sidecar-owned `models.json`
/// entries is permanently fatal to such a sidecar: the entry is dropped, nothing
/// starts the process (Pi dials `baseUrl` directly and never traverses the proxy
/// that is a lazy sidecar's only wake trigger), so the Healthy edge that would
/// re-register the provider never happens.
#[test]
fn provider_declaring_sidecar_starts_eagerly_even_when_lazy() {
    let provider = ProviderRegistrationSpec {
        id: "acme-bridge".to_owned(),
        label: Some("Acme Bridge".to_owned()),
        api: None,
        base_path: None,
        models: vec!["acme-1".to_owned()],
    };

    // Plain lazy sidecar: still lazy. The coercion must be narrow.
    let mut spec = binary_spec();
    spec.lazy = true;
    assert!(
        !starts_eagerly(&spec),
        "a lazy sidecar with no provider keeps wake-on-demand"
    );
    assert!(may_idle_stop(&spec));

    // The documented third-party auth-bridge shape — coerced to eager.
    spec.provides_provider = Some(provider.clone());
    assert!(
        starts_eagerly(&spec),
        "provides_provider must force an eager start; nothing can ever wake it"
    );
    assert!(
        !may_idle_stop(&spec),
        "and it must not be scaled to zero either — the model would vanish from \
             Pi's picker until a wake that never comes"
    );

    // An eager provider sidecar is unaffected (it was already eager).
    spec.lazy = false;
    assert!(starts_eagerly(&spec));

    // No provider, not lazy: eager, and idle-stop stays available.
    let plain = binary_spec();
    assert!(starts_eagerly(&plain));
    assert!(may_idle_stop(&plain));
}

/// **Defect 3's wiring**, as opposed to its predicate. The test above proves
/// `starts_eagerly` computes the right answer; it says nothing about whether the
/// enable path ever asks. The whole regression is one token wide — flipping
/// `apply_sidecars`' gate from `!starts_eagerly(spec)` back to `spec.lazy` restores
/// defect 3 in full and leaves every other test in this crate green, because they
/// all call the predicate directly.
///
/// The call site is asserted against the source text rather than by calling
/// `apply_sidecars`, which takes a whole `ServerState` (a SQLite plugin store, an
/// MCP registry, an ACP agent registry, …) that no unit test can stand up. The
/// comparison is whitespace-insensitive so rustfmt rewrapping cannot fail it, and
/// it pins the branch STRUCTURE — gate first, then the register-only arm, then the
/// eager `register_and_start` — so a gate that merely mentions `starts_eagerly`
/// somewhere decorative while still branching on `spec.lazy` does not pass.
#[test]
fn apply_sidecars_gates_the_register_only_branch_on_starts_eagerly() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/server/mod.rs");
    let src =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let squished: String = src.chars().filter(|c| !c.is_whitespace()).collect();

    let gate = squished
        .find("if!crate::sidecar::manifest_sidecar::starts_eagerly(spec){")
        .expect(
            "apply_sidecars must gate the register-only (lazy) arm on \
                 `starts_eagerly(spec)`, not on `spec.lazy`: a sidecar that declares \
                 `provides_provider` can never be woken (Pi dials its baseUrl directly, \
                 never the ext proxy), so leaving it lazy means the boot purge drops its \
                 provider row and nothing ever re-registers it",
        );
    // Deliberately matched on the call NAME only, not its argument list: the arms
    // themselves are ordinary code other work rewrites, and this test must fail for
    // the gate flipping and nothing else.
    let rest = &squished[gate..];
    let register_only = rest
        .find("manager.register(")
        .expect("the register-only arm still registers without starting");
    let eager = rest
        .find("manager.register_and_start(")
        .expect("the eager arm still starts");
    assert!(
        register_only < eager,
        "the register-only arm must be the one the `starts_eagerly` gate guards; a \
             gate that falls through to `register_and_start` first is not the branch \
             defect 3 is about"
    );
}

/// The `models.json` row for `id`, read straight off disk — the persisted form Pi
/// actually loads, not an in-memory projection of it.
fn provider_row(id: &str) -> Option<serde_json::Value> {
    let raw = std::fs::read_to_string(crate::pi_config::config_dir().join("models.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    json.get("providers")?.get(id).cloned()
}

/// **The crash lane.** `deregister_provider` had exactly one caller —
/// [`ManifestSidecar::stop`] — and a crashed child runs no teardown at all, so the
/// provider row outlived the process that justified it: a selectable model whose
/// `baseUrl` is the loopback port the crash just freed and whose `apiKey` is this
/// plugin's minted ext token. Pi dials that `baseUrl` DIRECTLY, so the ext proxy's
/// registration gate and the manager's `forward_target` refusal are both out of the
/// path — the first local process to bind the vacated port is handed the credential
/// and every inference request body, and nothing takes the row away until the next
/// boot's `purge_sidecar_providers`.
///
/// Reverting `on_crash_detected` (here or its call in
/// `SidecarManager::note_crash_if_exited`) fails this.
#[tokio::test]
async fn crash_teardown_drops_the_provider_row_and_its_credential() {
    let _guard = crate::pi_config::lock_pi_config_test_env();
    let dir = std::env::temp_dir().join(format!("ryu-crash-provider-{}", uuid::Uuid::new_v4()));
    std::env::set_var("RYU_PI_AGENT_DIR", &dir);

    let provider = ProviderRegistrationSpec {
        id: "acme-crash-bridge".to_owned(),
        label: Some("Acme Crash Bridge".to_owned()),
        api: None,
        base_path: None,
        models: vec!["acme-1".to_owned()],
    };
    let mut spec = binary_spec();
    spec.provides_provider = Some(provider.clone());
    let sc = ManifestSidecar::new(
        "com.acme.crashbridge".to_owned(),
        spec,
        crate::downloads::DownloadCenter::with_default_client(),
    );

    // The Healthy edge that publishes it — exactly what the health monitor does.
    register_provider_once(
        &sc.plugin_id,
        &provider,
        sc.effective_port(),
        "ext-tok-crash",
        &sc.provider_registered,
    );
    let row = provider_row(&provider.id).expect("a healthy sidecar publishes its provider");
    let token_env = crate::pi_config::secret_env::ext_token_env(&provider.id);
    assert_eq!(
        row["apiKey"],
        crate::pi_config::secret_env::reference(&token_env),
        "the row names the plugin's minted ext token by reference; the token itself \
             rides in the Pi spawn environment"
    );
    assert!(crate::pi_config::secret_env::secret_env()
        .contains(&(token_env.clone(), "ext-tok-crash".to_owned())));

    // The child dies on its own. `stop()` is never called on this path; this hook
    // is the only teardown a crash gets.
    sc.on_crash_detected();

    assert!(
        provider_row(&provider.id).is_none(),
        "a crashed sidecar's provider row must be gone: it points Pi at a port this \
             process no longer holds, with the plugin's ext token as the apiKey"
    );
    assert!(!crate::pi_config::secret_env::secret_env()
        .iter()
        .any(|(name, _)| name == &token_env));
    // Idempotent and panic-free: the monitor may see the same corpse again, and a
    // later stop() runs the same teardown.
    sc.on_crash_detected();
    sc.stop().await.unwrap();
    assert!(provider_row(&provider.id).is_none());

    std::env::remove_var("RYU_PI_AGENT_DIR");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A sidecar that declares no provider has nothing to release, and the crash hook
/// must stay a cheap no-op for it — the monitor calls this on every detected exit.
#[test]
fn crash_teardown_is_a_noop_without_a_declared_provider() {
    let sc = ManifestSidecar::new(
        "com.acme.plain".to_owned(),
        binary_spec(),
        crate::downloads::DownloadCenter::with_default_client(),
    );
    // No pi-config lock, no temp dir, no models.json: if this touched disk at all it
    // would be reaching into the developer's real config from a unit test.
    sc.on_crash_detected();
}

#[test]
fn is_truthy_accepts_common_flag_forms() {
    for on in ["1", "true", "TRUE", "on", " On "] {
        assert!(is_truthy(on), "{on:?} should be truthy");
    }
    for off in ["0", "false", "off", "", "no"] {
        assert!(!is_truthy(off), "{off:?} should be falsy");
    }
}

#[test]
fn resolve_node_runtime_rejects_missing_explicit() {
    // An explicit runtime that is not on PATH is a clean error, not a fallback.
    let err = resolve_node_runtime(Some("definitely-not-a-real-runtime-xyz"))
        .unwrap_err()
        .to_string();
    assert!(err.contains("not found on PATH"), "{err}");
}

#[test]
fn which_on_path_finds_a_known_program() {
    // `sh` on unix / `cmd` on windows is always present — proves the lookup works.
    #[cfg(unix)]
    assert!(which_on_path("sh").is_some());
    #[cfg(windows)]
    assert!(which_on_path("cmd").is_some());
    assert!(which_on_path("definitely-not-a-real-program-xyz").is_none());
}

/// A non-executable regular file earlier on `PATH` must not shadow a real
/// executable later on it (nor count as installed on its own).
#[cfg(unix)]
#[test]
fn which_in_path_skips_non_executable_candidates() {
    use std::os::unix::fs::PermissionsExt;
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let stray = first.path().join("ryu-which-probe");
    std::fs::write(&stray, "not a program\n").unwrap();
    std::fs::set_permissions(&stray, std::fs::Permissions::from_mode(0o644)).unwrap();
    let only_stray = std::env::join_paths([first.path()]).unwrap();
    assert_eq!(which_in_path(&only_stray, "ryu-which-probe"), None);

    let real = second.path().join("ryu-which-probe");
    std::fs::write(&real, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o755)).unwrap();
    let both = std::env::join_paths([first.path(), second.path()]).unwrap();
    assert_eq!(which_in_path(&both, "ryu-which-probe"), Some(real));
    // A directory with the program's name is not a candidate either.
    std::fs::create_dir(first.path().join("ryu-which-dir")).unwrap();
    assert_eq!(which_in_path(&only_stray, "ryu-which-dir"), None);
}

fn tmp_plugin_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ryu-node-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn manifest_with_backend(code: &str, sha: Option<&str>) -> crate::plugin_manifest::PluginManifest {
    crate::plugin_manifest::PluginManifest {
        id: "com.test.node".to_owned(),
        name: "Node".to_owned(),
        version: "1.0.0".to_owned(),
        backend_code: Some(code.to_owned()),
        backend_sha256: sha.map(str::to_owned),
        ..Default::default()
    }
}

#[tokio::test]
async fn prepare_node_backend_writes_and_verifies_hash() {
    let dir = tmp_plugin_dir();
    let code = "export function activate(){}";
    use sha2::{Digest, Sha256};
    let sha = hex::encode(Sha256::digest(code.as_bytes()));
    let manifest = manifest_with_backend(code, Some(&sha));

    let entry = prepare_node_backend(&dir, "backend.mjs", Some(&manifest))
        .await
        .expect("valid backend materializes");
    assert_eq!(entry, dir.join("backend.mjs"));
    assert_eq!(std::fs::read_to_string(&entry).unwrap(), code);
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn prepare_node_backend_refuses_on_hash_mismatch() {
    let dir = tmp_plugin_dir();
    let manifest = manifest_with_backend("export function activate(){}", Some("deadbeef"));
    let err = prepare_node_backend(&dir, "backend.mjs", Some(&manifest))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("hash mismatch"), "{err}");
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn prepare_node_backend_refuses_when_absent() {
    let dir = tmp_plugin_dir();
    // No backend_code and no on-disk file → refuse (nothing to run).
    let manifest = crate::plugin_manifest::PluginManifest {
        id: "com.test.node".to_owned(),
        name: "Node".to_owned(),
        version: "1.0.0".to_owned(),
        ..Default::default()
    };
    let err = prepare_node_backend(&dir, "backend.mjs", Some(&manifest))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("not found"), "{err}");
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn write_host_bootstrap_is_dependency_free() {
    let dir = tmp_plugin_dir();
    let path = write_host_bootstrap(&dir).await.unwrap();
    let src = std::fs::read_to_string(&path).unwrap();
    // The bootstrap must stay importable on stock node AND bun — node builtins only.
    assert!(src.contains("node:http"));
    assert!(src.contains("activate"));
    assert!(
        !src.contains("require("),
        "bootstrap must be ESM, no CJS require"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn native_permission_record_surfaces_report() {
    // Recording a native sidecar's posture makes it appear in the status-plane
    // reader with `enforced:false` (honest v1 — declared but not OS-enforced).
    // No manifest on disk in the test env → `declared: None`, which is fine: the
    // seam (record → reader) is what this asserts.
    let name = format!("com.test.perm-{}/worker", uuid::Uuid::new_v4());
    record_native_permissions(&name, "com.test.perm");
    let reports = native_sidecar_permission_reports();
    let found = reports
        .iter()
        .find(|r| r.name == name)
        .expect("recorded sidecar appears in the report");
    assert_eq!(found.plugin_id, "com.test.perm");
    assert!(
        !found.enforced,
        "native sidecars are never OS-enforced in v1"
    );
    // Serializes for the future status wire.
    let value = serde_json::to_value(found).unwrap();
    assert_eq!(value["enforced"], serde_json::json!(false));
    assert_eq!(value["name"], serde_json::json!(name));
}

// ── Missing app-sidecar binary: recorded + surfaced, never swallowed ──────────

/// A `Local` sidecar spec for a command that cannot exist on any host.
fn local_spec(command: &str) -> SidecarSpec {
    SidecarSpec {
        name: "worker".to_owned(),
        process: SidecarProcess::Local(crate::plugin_manifest::schema::LocalProcessSpec {
            command: command.to_owned(),
            command_env: None,
            port_env: None,
            args: vec![],
            env: BTreeMap::new(),
            bundles: BTreeMap::new(),
        }),
        port: 9098,
        health_path: "/health".to_owned(),
        http: None,
        host_api: None,
        lazy: false,
        idle_stop_secs: None,
        provides_provider: None,
        sandbox: None,
    }
}

/// The 404-swallowing case, which is what left `@ryu/browser` showing a
/// permanent "502 sidecar unreachable": when nothing resolves the command, the
/// reason is RECORDED (not just warned) and it names the exact release asset this
/// platform needs, so an operator can diff it against what CI publishes.
#[tokio::test]
async fn missing_local_sidecar_binary_is_recorded_with_the_expected_release_asset() {
    let command = format!("ryu-test-absent-{}", uuid::Uuid::new_v4());
    let name = format!("com.test.absent/{command}");
    let downloads = crate::downloads::DownloadCenter::with_default_client();

    // Falls through to the bare command (the spawn stays the authoritative
    // resolver — this hook never turns an optional sidecar into a boot failure).
    let program = ensure_local_sidecar_present(
        &name,
        "com.test.absent",
        command.clone(),
        &command,
        None,
        &downloads,
        None,
    )
    .await;
    assert_eq!(program, command);

    let reports = missing_sidecar_binary_reports();
    let found = reports
        .iter()
        .find(|r| r.name == name)
        .expect("an unresolvable command must be recorded, not swallowed");
    assert_eq!(found.plugin_id, "com.test.absent");
    assert_eq!(found.command, command);
    // The asset-name contract: `<command>-<os>-<arch>[.exe]`, byte-identical to
    // what the release workflow must publish. A mismatch here IS the bug class
    // this record exists to expose (ryu-browser once shipped only `-mac-arm64.dmg`).
    let ext = if cfg!(windows) { ".exe" } else { "" };
    assert_eq!(
        found.expected_asset,
        format!("{command}-{}{ext}", crate::update::platform_tag())
    );
    assert!(!found.reason.is_empty(), "a record must carry its reason");
    // Serializes for the status wire (the `/api/sidecar/status` seam).
    let value = serde_json::to_value(found).unwrap();
    assert_eq!(value["name"], serde_json::json!(name));
    assert_eq!(
        value["expected_asset"],
        serde_json::json!(found.expected_asset)
    );

    clear_missing_sidecar_binary(&name);
}

/// Both `Local` install paths (single file and bundle) resolve their download base
/// through this one helper, and it must put Core's OWN release first: the installed
/// file is stamped with Core's version, so a `releases/latest` asset (the newest
/// stable, a different train for a nightly/beta Core) must only be the fallback.
/// An explicit `RYU_SIDECAR_RELEASE_BASE` override is the only base.
#[test]
fn sidecar_release_bases_try_own_release_before_latest() {
    let bases = sidecar_release_bases(None);
    assert_eq!(
        bases,
        vec![
            crate::update::own_release_download_base(),
            format!(
                "https://github.com/{}/releases/latest/download",
                crate::update::RYU_REPO
            ),
        ]
    );
    assert!(bases[0].ends_with(&format!(
        "/releases/download/v{}",
        crate::update::current_version()
    )));

    let mirror = "https://mirror.example/releases".to_owned();
    assert_eq!(sidecar_release_bases(Some(mirror.clone())), vec![mirror]);
}

/// A record must never outlive the problem: once the binary resolves (a later
/// install, or a `command_env` override pointing at a dev build) the entry is
/// dropped, so a healed sidecar stops reporting "binary not installed" forever.
#[tokio::test]
async fn resolved_local_sidecar_binary_clears_a_stale_missing_record() {
    let name = format!("com.test.healed-{}/worker", uuid::Uuid::new_v4());
    record_missing_sidecar_binary(
        &name,
        "com.test.healed",
        "ryu-healed",
        "ryu-healed-macos-aarch64",
        "stale".to_owned(),
    );
    assert!(missing_sidecar_binary_reason(&name).is_some());

    // An existing file at the resolved program path is step 1 of the resolution
    // order (an env override or an already-installed bin).
    let existing = std::env::temp_dir().join(format!("ryu-healed-{}", uuid::Uuid::new_v4()));
    std::fs::write(&existing, b"#!/bin/sh\n").unwrap();
    let downloads = crate::downloads::DownloadCenter::with_default_client();
    let program = ensure_local_sidecar_present(
        &name,
        "com.test.healed",
        existing.to_string_lossy().into_owned(),
        "ryu-healed",
        None,
        &downloads,
        None,
    )
    .await;

    assert_eq!(program, existing.to_string_lossy());
    assert!(
        missing_sidecar_binary_reason(&name).is_none(),
        "a resolved binary must clear its stale missing-binary record"
    );
    std::fs::remove_file(&existing).ok();
}

/// A platform listed in `bundles` resolves to the installed bundle's entrypoint
/// (not the single-file `<command>` path), and an uninstalled bundle records the
/// archive asset name `<command>-<platform_tag>.<format>` CI must publish.
#[tokio::test]
async fn local_sidecar_bundle_resolves_to_installed_entrypoint_or_records_archive_asset() {
    let command = format!("ryu-test-bundle-{}", uuid::Uuid::new_v4());
    let name = format!("com.test.bundle/{command}");
    let bundle = crate::plugin_manifest::schema::LocalBundleSpec {
        format: "tar.gz".to_owned(),
        entrypoint: "Demo.app/Contents/MacOS/Demo".to_owned(),
    };
    let downloads = crate::downloads::DownloadCenter::with_default_client();

    // Not installed: falls through to the bare command and records the archive name.
    let program = ensure_local_sidecar_present(
        &name,
        "com.test.bundle",
        command.clone(),
        &command,
        Some(&bundle),
        &downloads,
        None,
    )
    .await;
    assert_eq!(program, command);
    let reports = missing_sidecar_binary_reports();
    let found = reports.iter().find(|r| r.name == name).expect("recorded");
    assert_eq!(
        found.expected_asset,
        format!("{command}-{}.tar.gz", crate::update::platform_tag())
    );

    // Installed (stamped with the running Core version): resolves to the entrypoint.
    let dir = managed_bundle_dir(&command);
    let exe = dir.join(&bundle.entrypoint);
    std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
    std::fs::write(&exe, b"#!/bin/sh\n").unwrap();
    std::fs::write(
        dir.join(crate::sidecar::bundle_install::BUNDLE_VERSION_MARKER),
        crate::update::current_version(),
    )
    .unwrap();
    let program = ensure_local_sidecar_present(
        &name,
        "com.test.bundle",
        command.clone(),
        &command,
        Some(&bundle),
        &downloads,
        None,
    )
    .await;
    assert_eq!(program, exe.to_string_lossy());
    assert!(missing_sidecar_binary_reason(&name).is_none());
    std::fs::remove_dir_all(&dir).ok();
}

// ── the managed-bin ready notifier ────────────────────────────────────────────

/// A uniquely-named slot in the Ryu-managed bin dir: reserved (absent) first, so a
/// test can assert the enable-time skip, then `install()`ed to make the binary land.
/// Removed on `Drop`.
///
/// Writes into the process's ACTUAL data dir (`~/.ryu/bin`, or the profile variant)
/// rather than redirecting it: `paths::ryu_dir()` is a `OnceLock` resolved on first
/// use, so setting `RYU_DIR` from a test would take effect or not depending on which
/// sibling test ran first. A uuid-suffixed name cannot collide with a real installed
/// binary, and it is never spawned.
struct ManagedBinSlot {
    command: String,
    path: PathBuf,
}

impl ManagedBinSlot {
    fn reserve() -> Self {
        let command = format!("ryu-test-notify-{}", uuid::Uuid::new_v4());
        let path = managed_bin_path(&command);
        assert!(
            which_on_path(&command).is_none(),
            "precondition: a uuid-named command is not on PATH"
        );
        assert!(!path.is_file(), "precondition: the slot starts empty");
        Self { command, path }
    }

    /// The binary lands — deliberately WITHOUT the `<command>.version` marker
    /// `ensure_local_sidecar_present` demands before it reuses a bin. The marker is
    /// download-lifecycle policy; the MCP resolver rung only asks "is there a file
    /// here", so this is also the dev-box shape (a locally built binary).
    fn install(&self) {
        std::fs::create_dir_all(self.path.parent().expect("bin dir has a parent"))
            .expect("create the managed bin dir");
        std::fs::write(&self.path, b"").expect("write the managed bin");
    }
}

impl Drop for ManagedBinSlot {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// A manifest declaring exactly one `mcp_servers` entry whose `command` is the bare
/// name of a Ryu-managed binary — the shape the managed-bin resolver rung exists for
/// (no `command_env` for anything to seed).
fn manifest_declaring_mcp_server(
    plugin_id: &str,
    server: &str,
    command: &str,
) -> crate::plugin_manifest::PluginManifest {
    let mut mcp_servers = BTreeMap::new();
    mcp_servers.insert(
        server.to_owned(),
        crate::plugin_manifest::McpServerDecl {
            command: Some(command.to_owned()),
            command_env: None,
            args: vec![],
            env: BTreeMap::new(),
            description: None,
            enabled: true,
            ..Default::default()
        },
    );
    crate::plugin_manifest::PluginManifest {
        id: plugin_id.to_owned(),
        name: "Notifier Test".to_owned(),
        version: "1.0.0".to_owned(),
        mcp_servers,
        ..Default::default()
    }
}

/// The whole point of the notifier: at enable the binary is not there yet, so the
/// declaration is skipped and nothing remembers it — and then the sidecar's binary
/// lands and the server registers itself, with no restart.
///
/// Both halves are asserted in one test on purpose: the skip is the precondition
/// that makes the registration meaningful. Without it, a host where the command
/// happened to resolve would pass while proving nothing.
///
/// The discriminator is the stored ABSOLUTE path, not mere presence: Ryu's installer
/// puts `<data dir>/bin` on the user's `PATH`, so on some hosts a bare name also
/// resolves through the plain-`PATH` rung, which stores the name verbatim. Only the
/// managed-bin rung can produce the absolute path.
#[tokio::test]
async fn a_landed_managed_binary_registers_the_plugins_mcp_server() {
    let slot = ManagedBinSlot::reserve();
    let plugin_id = format!("com.test.notify-{}", uuid::Uuid::new_v4());
    let server = format!("notify-srv-{}", uuid::Uuid::new_v4());
    let sidecar_name = namespaced_name(&plugin_id, "worker");

    let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
    let manifest = Arc::new(manifest_declaring_mcp_server(
        &plugin_id,
        &server,
        &slot.command,
    ));

    // 1. Enable time, reproduced exactly: `activate_plugin` registers the manifest's
    //    servers while `apply_sidecars` is still fetching the binary. Nothing to
    //    spawn, so the declaration is skipped — and a skip is remembered nowhere.
    let at_enable = crate::sidecar::mcp::register_manifest_mcp_servers(
        &registry,
        &manifest,
        PluginTier::Core,
        &[],
    );
    assert!(
        at_enable.is_empty() && !registry.contains_server(&server),
        "precondition: with no binary on disk the declaration must be skipped"
    );

    // 2. The binary lands — the event this notifier exists to observe.
    slot.install();

    let registration = McpRegistration {
        registry: Arc::clone(&registry),
        manifest: Arc::clone(&manifest),
        tier: PluginTier::Core,
        approved_grants: Vec::new(),
        runtime: None,
    };
    let downloads = crate::downloads::DownloadCenter::with_default_client();
    let program = ensure_local_sidecar_present(
        &sidecar_name,
        &plugin_id,
        slot.command.clone(),
        &slot.command,
        None,
        &downloads,
        Some(&registration),
    )
    .await;

    // 3. Registered, from the real `ManifestSidecar` code path. Note the resolver
    //    that matters is the MCP one, not this function's: with no `.version` marker
    //    the sidecar resolution still falls through to the bare command, and the
    //    server registers anyway.
    assert_eq!(program, slot.command);
    assert!(
        registry.contains_server(&server),
        "a binary landing must register the declaration the enable pass skipped"
    );
    let summary = registry
        .server_summaries()
        .into_iter()
        .find(|s| s.name == server)
        .expect("the registered server must be listed");
    assert_eq!(
        summary.command,
        slot.path.to_string_lossy(),
        "the stored command must be the absolute managed-bin path, not the bare name"
    );

    // 4. Cost control: a lazy sidecar wakes over and over, and `register_server`
    //    rebuilds the server map + clears the tool cache. Once every declared name is
    //    registered the notifier must do nothing at all.
    assert!(
        notify_managed_binary_ready(&registration).await.is_empty(),
        "a wake with nothing left to register must not touch the registry"
    );

    clear_missing_sidecar_binary(&sidecar_name);
}

/// The skip-if-nothing-to-do guard must key on OWNERSHIP, not on "is this name known
/// to the registry". Core reserves a set of built-in server names
/// (`threads`, `research`, the capability facade, …) that `contains_server` answers
/// `true` for whether or not anything is registered — while a plugin registration by
/// that name is real work, because it overlays the built-in in `rebuild_servers`.
///
/// Guarding on `contains_server` would therefore switch this notifier off
/// *permanently*, and silently, for exactly the apps that are taking a name Core
/// still reserves — which is the shape of every in-flight severance of a built-in
/// Core MCP module out to its own app. Hence `plugin_server_owner`.
#[tokio::test]
async fn a_name_core_merely_reserves_does_not_suppress_the_notifier() {
    let slot = ManagedBinSlot::reserve();
    slot.install();
    let plugin_id = format!("com.test.reserved-{}", uuid::Uuid::new_v4());
    // Any reserved built-in name works; `threads` stands in for whichever Core
    // module an app is in the middle of taking over.
    let server = crate::sidecar::mcp::threads::SERVER_NAME;
    let sidecar_name = namespaced_name(&plugin_id, "worker");

    let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
    assert!(
        registry.contains_server(server),
        "precondition: the name is reserved even though nothing is registered"
    );
    assert!(
        registry.plugin_server_owner(server).is_none(),
        "precondition: but no PLUGIN owns it, so a registration would change something"
    );

    let registration = McpRegistration {
        registry: Arc::clone(&registry),
        manifest: Arc::new(manifest_declaring_mcp_server(
            &plugin_id,
            server,
            &slot.command,
        )),
        tier: PluginTier::Core,
        approved_grants: Vec::new(),
        runtime: None,
    };
    let downloads = crate::downloads::DownloadCenter::with_default_client();
    let _ = ensure_local_sidecar_present(
        &sidecar_name,
        &plugin_id,
        slot.command.clone(),
        &slot.command,
        None,
        &downloads,
        Some(&registration),
    )
    .await;

    assert_eq!(
        registry.plugin_server_owner(server).as_deref(),
        Some(plugin_id.as_str()),
        "a reserved-but-unowned name must not short-circuit the notifier"
    );
    // And now that it IS owned, the guard does its job on the next wake.
    assert!(
        notify_managed_binary_ready(&registration).await.is_empty(),
        "once owned, a wake must not touch the registry"
    );

    clear_missing_sidecar_binary(&sidecar_name);
}

/// The notifier is the SAME gated door, asked twice — not a second, ungated one. A
/// Community-tier plugin without the approved `mcp:server` grant registers nothing
/// when its binary lands, exactly as it registered nothing at enable.
///
/// This is the property that matters most here: the notifier fires from a code path
/// (a sidecar start / lazy wake) that has no gate of its own, so if it re-derived
/// "which declarations now resolve" instead of re-running
/// `register_manifest_mcp_servers`, a `~/.ryu/plugins` manifest could reach
/// `Command::new` just by shipping a binary.
#[tokio::test]
async fn the_notifier_does_not_bypass_the_tier_and_grant_gate() {
    let slot = ManagedBinSlot::reserve();
    slot.install();
    let plugin_id = format!("com.test.ungated-{}", uuid::Uuid::new_v4());
    let server = format!("ungated-srv-{}", uuid::Uuid::new_v4());
    let sidecar_name = namespaced_name(&plugin_id, "worker");

    let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
    let registration = McpRegistration {
        registry: Arc::clone(&registry),
        manifest: Arc::new(manifest_declaring_mcp_server(
            &plugin_id,
            &server,
            &slot.command,
        )),
        tier: PluginTier::Community,
        approved_grants: Vec::new(),
        runtime: None,
    };

    let downloads = crate::downloads::DownloadCenter::with_default_client();
    let _ = ensure_local_sidecar_present(
        &sidecar_name,
        &plugin_id,
        slot.command.clone(),
        &slot.command,
        None,
        &downloads,
        Some(&registration),
    )
    .await;

    assert!(
        !registry.contains_server(&server),
        "a Community-tier plugin without the approved grant must register nothing, \
             even though its binary is now installed and resolvable"
    );
    // And the grant is what unlocks it — so the skip above is the gate, not a
    // resolution failure that would make this test vacuous.
    let granted = McpRegistration {
        approved_grants: vec![crate::sidecar::mcp::GRANT_MCP_SERVER.to_owned()],
        ..registration
    };
    assert_eq!(
        notify_managed_binary_ready(&granted).await,
        vec![server.clone()],
        "with the grant approved, the same landing registers the server"
    );

    clear_missing_sidecar_binary(&sidecar_name);
}

/// The surfaced half: `health_check` reports the recorded reason through
/// [`HealthStatus::Unhealthy`] — the reason channel that already exists — so a
/// stopped sidecar reads as "binary not installed", not the indistinguishable
/// "process not running" a crash and a lazy scale-to-zero also produce.
#[tokio::test]
async fn health_check_says_binary_not_installed_rather_than_process_not_running() {
    let downloads = crate::downloads::DownloadCenter::with_default_client();
    let plugin_id = format!("com.test.nobin-{}", uuid::Uuid::new_v4());
    let sc = ManifestSidecar::new(plugin_id.clone(), local_spec("ryu-test-nobin"), downloads);
    let name = sc.name().to_owned();

    // No record yet: a not-running sidecar (crashed, or lazily scaled to zero) must
    // NOT be reported as a missing binary — that would be a lie about the cause.
    assert!(!sc.is_running());
    let before = sc.health_check().await;
    let HealthStatus::Unhealthy(msg) = before else {
        panic!("a stopped sidecar is Unhealthy");
    };
    assert_eq!(msg, "process not running");

    record_missing_sidecar_binary(
        &name,
        &plugin_id,
        "ryu-test-nobin",
        "ryu-test-nobin-macos-aarch64",
        "not published for this platform".to_owned(),
    );
    let after = sc.health_check().await;
    let HealthStatus::Unhealthy(msg) = after else {
        panic!("a sidecar with no binary is Unhealthy");
    };
    assert!(
        msg.starts_with("binary not installed: "),
        "health must carry the missing-binary reason, got: {msg}"
    );
    assert!(msg.contains("not published for this platform"), "{msg}");

    clear_missing_sidecar_binary(&name);
}

// ── The ext-API fetch hook ────────────────────────────────────────────────

/// A one-shot loopback server that counts connections and answers every request
/// with a bare 404 — the shape of a real sidecar that serves no OpenAPI document,
/// which is the case the latch has to terminate on. Returns its port plus the
/// live hit counter.
///
/// A real socket rather than a mock because the thing under test is precisely
/// whether a SECOND fetch happens: a fake that records calls to a trait would be
/// asserting about the fake's own bookkeeping, not about the hook's behaviour.
fn spawn_counting_probe() -> (u16, Arc<std::sync::atomic::AtomicUsize>) {
    spawn_probe(ProbeReply::Status(404))
}

/// What a [`spawn_probe`] listener answers with. Each variant is a classification
/// the fetch hook has to get right, and each one is a different code path out of
/// `import_openapi` — which is why they share one listener instead of three.
#[derive(Clone, Copy)]
enum ProbeReply {
    /// A bare status with an empty body (404 ⇒ definitive, 503 ⇒ transient).
    Status(u16),
    /// A 200 whose body is `bytes` long — used to cross
    /// [`EXT_API_SPEC_MAX_BYTES`]. The declared `content-length` is deliberately a
    /// LIE (it claims a small body), so passing this test proves the *streaming*
    /// total is what bounds the read, not the header pre-check a hostile or buggy
    /// server controls.
    OversizedBody { bytes: usize },
}

/// A loopback server that counts connections and answers every request the same
/// way. Returns its port plus the live hit counter.
fn spawn_probe(reply: ProbeReply) -> (u16, Arc<std::sync::atomic::AtomicUsize>) {
    use std::sync::atomic::AtomicUsize;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().expect("addr").port();
    listener.set_nonblocking(true).expect("nonblocking");
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&hits);
    if let ProbeReply::OversizedBody { bytes } = reply {
        tokio::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).expect("into tokio");
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                counter.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
                // Chunked, so the client cannot pre-empt on `content-length` — the
                // read has to be stopped by the running total or not at all.
                let _ = sock
                    .write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\
                              transfer-encoding: chunked\r\nconnection: close\r\n\r\n",
                    )
                    .await;
                // 64 KB of filler per chunk; the JSON is never valid, which is fine
                // — the cap must trip long before anything tries to parse it.
                let chunk = vec![b'x'; 64 * 1024];
                let header = format!("{:x}\r\n", chunk.len());
                let mut sent = 0usize;
                while sent < bytes {
                    if sock.write_all(header.as_bytes()).await.is_err()
                        || sock.write_all(&chunk).await.is_err()
                        || sock.write_all(b"\r\n").await.is_err()
                    {
                        break;
                    }
                    sent += chunk.len();
                }
                let _ = sock.write_all(b"0\r\n\r\n").await;
                let _ = sock.shutdown().await;
            }
        });
        return (port, hits);
    }
    let ProbeReply::Status(status) = reply else {
        unreachable!("the oversized arm returned above");
    };
    tokio::spawn(async move {
        let listener = tokio::net::TcpListener::from_std(listener).expect("into tokio");
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            counter.fetch_add(1, Ordering::SeqCst);
            // Drain the request line/headers first: answering into an unread
            // socket makes some clients report a connection reset instead of the
            // status, which would misclassify a definitive 404 as transient.
            let mut buf = [0u8; 2048];
            let _ = sock.read(&mut buf).await;
            let resp = format!(
                "HTTP/1.1 {status} Status\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.shutdown().await;
        }
    });
    (port, hits)
}

/// The default hook fixture: plugin `@ryu/probe`, its `worker` sidecar, no live
/// manifest store (so [`OpenApiImport::lowering_inputs`] falls back to the
/// snapshot, which is the shape every pre-existing test asserts against).
fn probe_import(registry: &Arc<crate::sidecar::mcp::McpRegistry>) -> OpenApiImport {
    probe_import_named(registry, "@ryu/probe", "worker")
}

fn probe_import_named(
    registry: &Arc<crate::sidecar::mcp::McpRegistry>,
    plugin_id: &str,
    sidecar: &str,
) -> OpenApiImport {
    OpenApiImport {
        registry: Arc::clone(registry),
        plugin_id: plugin_id.to_owned(),
        sidecar_name: sidecar.to_owned(),
        sidecar_key: namespaced_name(plugin_id, sidecar),
        manifests: None,
        upstream_mount: "/api".to_owned(),
        declared_routes: Vec::new(),
        client: reqwest::Client::new(),
        runtime: None,
    }
}

/// A stranded claim is permanent and silent: the flag stays `true`, nothing was
/// stored so `has_ext_api_routes` stays `false`, and every later Healthy edge
/// spawns a task that loses the CAS and returns. The app then derives zero tools
/// for the life of the process with nothing in the log to say why. Releasing from
/// `Drop` rather than a trailing store is what makes an unwind survivable.
#[test]
fn claim_guard_releases_on_unwind() {
    let latch = Arc::new(AtomicBool::new(true));
    let escaped = std::panic::catch_unwind({
        let latch = Arc::clone(&latch);
        move || {
            let _claim = ClaimGuard(latch);
            panic!("lowering blew up");
        }
    });
    assert!(escaped.is_err(), "the panic must actually have unwound");
    assert!(
        !latch.load(Ordering::SeqCst),
        "an unwind must still release the claim, or the app never derives again"
    );
}

/// The re-wake guard. A `lazy` sidecar with `idle_stop_secs` crosses the Healthy
/// edge on every wake, so an unlatched hook would refetch and reparse the same
/// document for the life of the node.
///
/// This also pins the half that makes termination possible at all: a definitive
/// "no spec here" answer is RECORDED (as zero routes), not merely skipped. If it
/// were skipped, `has_ext_api_routes` would stay false and every one of the ~40
/// apps that serve no OpenAPI document would be re-probed twice a minute forever.
#[tokio::test]
async fn import_is_latched_and_does_not_refetch_on_rewake() {
    let (port, hits) = spawn_counting_probe();
    let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
    let latch = Arc::new(AtomicBool::new(false));

    import_openapi_once(probe_import(&registry), port, Arc::clone(&latch)).await;
    assert_eq!(
        hits.load(Ordering::SeqCst),
        2,
        "the first Healthy edge tries the root, then the mount-prefixed form"
    );
    assert!(
        registry.has_ext_api_routes("@ryu/probe"),
        "a definitive answer must be recorded even when it derives nothing"
    );

    import_openapi_once(probe_import(&registry), port, Arc::clone(&latch)).await;
    assert_eq!(hits.load(Ordering::SeqCst), 2, "a re-wake must not refetch");
}

/// The ROOT is tried first. `http.mount` says where the sidecar nests its routes,
/// not where its server is rooted — the spec's own paths already carry the mount
/// (which is why `ext_api::lower` strips it), so an app nesting at `/api/crm`
/// still publishes its schema at `/openapi.json`. Getting this backwards 404s
/// every app that has a mount, and — because a 404 is definitive — latches it at
/// zero derived tools for the life of the process.
#[test]
fn openapi_is_probed_at_the_root_before_the_mount() {
    assert_eq!(
        openapi_doc_urls("http://127.0.0.1:8009", "/api/crm"),
        vec![
            "http://127.0.0.1:8009/openapi.json".to_owned(),
            "http://127.0.0.1:8009/api/crm/openapi.json".to_owned(),
        ]
    );
    // No mount ⇒ one candidate, not a duplicate of the same URL.
    assert_eq!(
        openapi_doc_urls("http://127.0.0.1:8009", ""),
        vec!["http://127.0.0.1:8009/openapi.json".to_owned()]
    );
}

/// …and the latch is re-armable, which is the whole reason it lives in the
/// REGISTRY rather than in this struct. `deactivate_plugin` and
/// `update_app_handler` both clear the rows without rebuilding the sidecar object;
/// a local done-flag would make those clears permanent (zero derived tools until
/// the next process restart) instead of a re-lower request.
#[tokio::test]
async fn clearing_the_registry_re_arms_the_import() {
    let (port, hits) = spawn_counting_probe();
    let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
    let latch = Arc::new(AtomicBool::new(false));

    import_openapi_once(probe_import(&registry), port, Arc::clone(&latch)).await;
    let after_first = hits.load(Ordering::SeqCst);
    assert!(after_first > 0);

    registry.clear_ext_api_routes("@ryu/probe");
    import_openapi_once(probe_import(&registry), port, latch).await;
    assert!(
        hits.load(Ordering::SeqCst) > after_first,
        "clearing the registry must let the next Healthy edge re-lower"
    );
}

/// A 404 is the app's real answer about this URL, so it stays DEFINITIVE: the ~40
/// shipped apps that publish no OpenAPI document must be recorded as "nothing to
/// derive" and never probed again, or every one of them pays two requests per
/// health poll for the life of the node.
///
/// The counterpart to `server_error_status_is_transient_and_retries` below — the
/// two together are the whole content of the status split, and asserting only one
/// of them would pass under a classifier that treats everything the same way.
#[tokio::test]
async fn not_found_is_definitive() {
    let (port, hits) = spawn_probe(ProbeReply::Status(404));
    let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
    let latch = Arc::new(AtomicBool::new(false));
    let import = probe_import(&registry);
    let key = import.sidecar_key.clone();

    import_openapi_once(import, port, Arc::clone(&latch)).await;
    assert_eq!(
        hits.load(Ordering::SeqCst),
        2,
        "a 4xx at the root must still try the mount-prefixed candidate"
    );
    assert!(
        registry.has_ext_api_routes_for_sidecar(&key),
        "a 404 from every candidate is an answer, and must be recorded"
    );

    import_openapi_once(probe_import(&registry), port, latch).await;
    assert_eq!(
        hits.load(Ordering::SeqCst),
        2,
        "and it must never be re-asked"
    );
}

/// 401/403 stay DEFINITIVE, and that is a deliberate call rather than a gap in the
/// list. "The bearer was rejected" is a stable property of how the sidecar is
/// configured, not a hiccup — treating it as transient would put every
/// auth-misconfigured app into a permanent two-requests-per-30s loop that nothing
/// ever breaks, since the token Core presents does not change by being re-sent.
///
/// Pinned separately because it is the plausible wrong edit: "the token must have
/// rotated, so retry" reads reasonable and would leave the suite green. The INFO
/// line on the definitive branch carries the status precisely so an operator can
/// tell this case apart from a 404 without a retry loop to make it obvious.
#[tokio::test]
async fn unauthorized_is_definitive_not_a_retry_loop() {
    let (port, hits) = spawn_probe(ProbeReply::Status(401));
    let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
    let latch = Arc::new(AtomicBool::new(false));
    let import = probe_import(&registry);
    let key = import.sidecar_key.clone();

    import_openapi_once(import, port, Arc::clone(&latch)).await;
    assert!(
        registry.has_ext_api_routes_for_sidecar(&key),
        "a rejected bearer is an answer about the app, not a transport hiccup"
    );
    let after_first = hits.load(Ordering::SeqCst);

    import_openapi_once(probe_import(&registry), port, latch).await;
    assert_eq!(
        hits.load(Ordering::SeqCst),
        after_first,
        "…so it must never be re-asked"
    );
}

/// A 5xx is the sidecar failing, not answering — and the Healthy edge fires at
/// exactly the moment a sidecar is most likely to be mid-boot (health route up,
/// the rest of the router not yet mounted, workers still forking). Recording that
/// as "this app serves no OpenAPI document" would latch the app at zero derived
/// tools for the life of the process, on nothing but a slow start.
///
/// Also pins the no-second-candidate rule: a 503 at the root says nothing about
/// the mount, so retrying the mount would only add load to a sidecar that is
/// already shedding it. One hit per attempt, not two.
#[tokio::test]
async fn server_error_status_is_transient_and_retries() {
    let (port, hits) = spawn_probe(ProbeReply::Status(503));
    let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
    let latch = Arc::new(AtomicBool::new(false));
    let import = probe_import(&registry);
    let key = import.sidecar_key.clone();

    import_openapi_once(import, port, Arc::clone(&latch)).await;
    assert_eq!(
        hits.load(Ordering::SeqCst),
        1,
        "a transient status must abort the candidate walk, not double the load"
    );
    assert!(
        !registry.has_ext_api_routes_for_sidecar(&key),
        "a 503 must store NOTHING, or the retry can never happen"
    );

    // The next Healthy edge (30s later in production; immediately here) re-asks.
    import_openapi_once(probe_import(&registry), port, latch).await;
    assert_eq!(
        hits.load(Ordering::SeqCst),
        2,
        "the sidecar that was briefly 503 must get another chance"
    );
}

/// Unbounded consumption: the only bound on this fetch used to be the 10s timeout,
/// and 10 seconds of loopback is gigabytes — buffered into a `Vec` and then handed
/// to a JSON parser.
///
/// Two properties in one test, because either alone is a false pass:
///
/// 1. The read is *stopped* — the probe streams far more than
///    [`EXT_API_SPEC_MAX_BYTES`] under a chunked encoding with no honest
///    `content-length`, so only the running total can stop it.
/// 2. The refusal is *definitive*. A transient classification here would be worse
///    than no cap at all: every 30s health poll would re-download the same
///    oversized document forever, turning a one-shot memory spike into a permanent
///    bandwidth loop.
#[tokio::test]
async fn oversized_spec_body_is_refused_and_not_retried() {
    let over = (EXT_API_SPEC_MAX_BYTES as usize) + 512 * 1024;
    let (port, hits) = spawn_probe(ProbeReply::OversizedBody { bytes: over });
    let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
    let latch = Arc::new(AtomicBool::new(false));
    let import = probe_import(&registry);
    let key = import.sidecar_key.clone();

    import_openapi_once(import, port, Arc::clone(&latch)).await;
    let after_first = hits.load(Ordering::SeqCst);
    assert_eq!(
        after_first, 1,
        "the first candidate answered 200, so the walk stops there"
    );
    assert!(
        registry.has_ext_api_routes_for_sidecar(&key),
        "an over-cap body must be recorded as a definitive zero-tool result"
    );

    import_openapi_once(probe_import(&registry), port, latch).await;
    assert_eq!(
        hits.load(Ordering::SeqCst),
        after_first,
        "…and must NOT be re-downloaded on the next Healthy edge"
    );
}

/// The direct unit on the cap, so a regression is attributed to the reader rather
/// than to the hook around it — and so the `content-length` pre-check is pinned
/// independently of the streaming total the test above exercises.
#[tokio::test]
async fn a_lying_content_length_cannot_bypass_the_spec_cap() {
    // A server may under-declare (or omit) `content-length`; the pre-check is an
    // early-out, never the bound.
    let over = (EXT_API_SPEC_MAX_BYTES as usize) + 512 * 1024;
    let (port, _hits) = spawn_probe(ProbeReply::OversizedBody { bytes: over });
    let resp = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/openapi.json"))
        .send()
        .await
        .expect("the probe answers");
    assert!(
        resp.content_length()
            .is_none_or(|l| l <= EXT_API_SPEC_MAX_BYTES),
        "precondition: the header must not be what trips the cap"
    );
    assert!(
        matches!(
            read_capped_spec_body(resp, "probe").await,
            SpecBody::TooLarge
        ),
        "the streaming total is the bound"
    );
}

/// One derived row, shaped enough to be stored and counted. The registry never
/// inspects anything but `id`/`plugin_id` on the paths under test here.
fn derived_row(id: &str, plugin: &str) -> crate::ext_api::ExtApiRoute {
    crate::ext_api::ExtApiRoute {
        id: id.to_owned(),
        plugin_id: plugin.to_owned(),
        method: "GET".to_owned(),
        url: format!("core:/api/ext/{plugin}/thing"),
        name: "Do the thing".to_owned(),
        description: None,
        header_params: vec![],
        input_schema: serde_json::json!({ "type": "object", "properties": {} }),
    }
}

/// **FIX 3.** The hook is armed per SIDECAR while the store used to be keyed per
/// PLUGIN, so a manifest with two `http` sidecars had its second lowering silently
/// overwrite the first — and, worse, the plugin-scoped latch then answered "already
/// lowered" for the second sidecar before it ever ran, making the winner a function
/// of health-poll ordering.
///
/// Both halves are asserted, because they fail independently:
///
/// - the LATCH half, end-to-end through `import_openapi_once`: sidecar B must
///   actually go and fetch after sidecar A has finished;
/// - the STORE half: A's rows must still be there once B has stored its own.
///
/// Latent today only because exactly one shipped manifest (`finetune`) declares two
/// sidecars and its second happens to carry no `http` block. That is a coincidence,
/// not a guarantee, and the failure it would produce is invisible.
#[tokio::test]
async fn two_http_sidecars_on_one_plugin_do_not_overwrite_each_other() {
    let (port, hits) = spawn_counting_probe();
    let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());

    let alpha = probe_import_named(&registry, "@ryu/twin", "alpha");
    let beta = probe_import_named(&registry, "@ryu/twin", "beta");
    let (alpha_key, beta_key) = (alpha.sidecar_key.clone(), beta.sidecar_key.clone());
    assert_ne!(alpha_key, beta_key, "the two sidecars must key differently");

    import_openapi_once(alpha, port, Arc::new(AtomicBool::new(false))).await;
    let after_alpha = hits.load(Ordering::SeqCst);
    assert!(after_alpha > 0, "the first sidecar fetched");

    import_openapi_once(beta, port, Arc::new(AtomicBool::new(false))).await;
    assert!(
        hits.load(Ordering::SeqCst) > after_alpha,
        "the SECOND sidecar of the same plugin must still fetch its own document — \
             a plugin-scoped latch would have skipped it forever"
    );
    assert!(registry.has_ext_api_routes_for_sidecar(&alpha_key));
    assert!(registry.has_ext_api_routes_for_sidecar(&beta_key));

    // The store half: two sidecars' rows coexist instead of the later replacing
    // the earlier.
    registry.set_ext_api_routes_for_sidecar(
        "@ryu/twin",
        &alpha_key,
        vec![derived_row("ryu_ext.ryu_twin.get_alpha", "@ryu/twin")],
    );
    registry.set_ext_api_routes_for_sidecar(
        "@ryu/twin",
        &beta_key,
        vec![derived_row("ryu_ext.ryu_twin.get_beta", "@ryu/twin")],
    );
    assert!(
        registry
            .describe("ryu_ext.ryu_twin.get_alpha")
            .await
            .is_some(),
        "the first sidecar's rows must survive the second's lowering"
    );
    assert!(registry
        .describe("ryu_ext.ryu_twin.get_beta")
        .await
        .is_some());
}

/// …and the plugin-scoped clear must reach BOTH of them. `deactivate_plugin` and
/// `update_app_handler` know only the plugin id, so a sidecar-keyed store with a
/// `map.remove(plugin_id)` clear would leave the second sidecar's rows searchable
/// and callable for an app the user just disabled — tools that the ext-proxy then
/// refuses at the hop, i.e. tools that can only fail.
///
/// The look-alike plugin is the other half of the keying invariant: ownership
/// requires a `/` boundary, so disabling `@ryu/twin` must not strip `@ryu/twin-x`.
#[tokio::test]
async fn deactivate_clears_every_sidecar_for_the_plugin() {
    let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
    let alpha = namespaced_name("@ryu/twin", "alpha");
    let beta = namespaced_name("@ryu/twin", "beta");
    let neighbour = namespaced_name("@ryu/twin-x", "alpha");

    registry.set_ext_api_routes_for_sidecar(
        "@ryu/twin",
        &alpha,
        vec![derived_row("ryu_ext.ryu_twin.get_alpha", "@ryu/twin")],
    );
    // A zero-route entry is still an entry — it is what makes the latch terminate,
    // so a clear that only removed non-empty ones would re-arm nothing.
    registry.set_ext_api_routes_for_sidecar("@ryu/twin", &beta, vec![]);
    registry.set_ext_api_routes_for_sidecar(
        "@ryu/twin-x",
        &neighbour,
        vec![derived_row("ryu_ext.ryu_twin_x.get_alpha", "@ryu/twin-x")],
    );

    registry.clear_ext_api_routes("@ryu/twin");

    assert!(
        !registry.has_ext_api_routes_for_sidecar(&alpha),
        "the clear must reach the first sidecar"
    );
    assert!(
        !registry.has_ext_api_routes_for_sidecar(&beta),
        "…and the second, including one that lowered to zero rows"
    );
    assert!(
        !registry.has_ext_api_routes("@ryu/twin"),
        "the plugin-scoped read model must agree, so a re-enable re-lowers"
    );
    assert!(
        registry.has_ext_api_routes_for_sidecar(&neighbour),
        "a plugin whose id merely PREFIXES the cleared one must be untouched"
    );
    assert!(
        registry
            .describe("ryu_ext.ryu_twin_x.get_alpha")
            .await
            .is_some(),
        "…and its rows must still dispatch"
    );
}

/// **FIX 4.** An in-place app update rewrites the manifest without re-running
/// `apply_sidecars`: it reloads `state.app_manifests` and clears the derived rows,
/// leaving the next Healthy edge to re-lower. If the lowering inputs were the
/// arm-time snapshot, that re-lowering would intersect the NEW spec against the OLD
/// declared routes and strip the OLD mount — deriving tools for paths the update
/// withdrew (which then 404 at the proxy) while silently dropping the ones it added.
///
/// So the inputs are a live read, with the snapshot as the fallback. All three
/// branches are pinned here, because each fails differently: no store at all (test
/// and CLI contexts), a store that does not know this sidecar (uninstalled or
/// renamed mid-fetch), and the hit that is the whole point.
#[tokio::test]
async fn lowering_inputs_are_read_live_from_the_updated_manifest() {
    let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());

    // No store wired ⇒ the arm-time snapshot, unchanged.
    let bare = probe_import_named(&registry, "@ryu/updated", "worker");
    assert_eq!(
        bare.lowering_inputs().await,
        ("/api".to_owned(), Vec::new()),
        "with no manifest store the snapshot must still be used"
    );

    // The manifest as it looks AFTER an update: a different mount, different routes.
    let mut spec = binary_spec();
    spec.name = "worker".to_owned();
    spec.http = Some(
        serde_json::from_value(serde_json::json!({
            "mount": "/api/new/",
            "routes": [{ "path": "/added" }],
        }))
        .expect("the http fixture must match HttpProxySpec"),
    );
    let manifest = crate::plugin_manifest::PluginManifest {
        id: "@ryu/updated".to_owned(),
        name: "Updated".to_owned(),
        version: "2.0.0".to_owned(),
        sidecars: vec![spec],
        ..Default::default()
    };
    let store = Arc::new(tokio::sync::RwLock::new(vec![manifest]));

    let live = OpenApiImport {
        manifests: Some(Arc::clone(&store)),
        ..probe_import_named(&registry, "@ryu/updated", "worker")
    };
    let (mount, routes) = live.lowering_inputs().await;
    assert_eq!(mount, "/api/new");
    assert_eq!(
        routes
            .iter()
            .map(|route| route.path.as_str())
            .collect::<Vec<_>>(),
        ["/added"]
    );

    // A sidecar the live manifest does not describe (renamed, or the app was
    // uninstalled mid-fetch) falls back rather than lowering against nothing.
    let renamed = OpenApiImport {
        manifests: Some(store),
        ..probe_import_named(&registry, "@ryu/updated", "gone")
    };
    assert_eq!(
        renamed.lowering_inputs().await,
        ("/api".to_owned(), Vec::new()),
        "a miss must fall back to the snapshot, not to an empty declaration set"
    );
}
