use super::*;

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
    let dir = version_dir(Path::new("/plugins/acme"), &bin).unwrap();
    assert_eq!(dir, Path::new("/plugins/acme").join("bin").join("1.2.3"));
    assert_eq!(
        dir.join(url_filename(&bin.url).unwrap()),
        Path::new("/plugins/acme")
            .join("bin")
            .join("1.2.3")
            .join("my-engine")
    );
}
