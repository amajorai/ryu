//! Shipped Spider command through canonical registry routing. URL-fetching child
//! processes run only behind Core's per-invocation egress broker: private URL
//! arguments are refused before spawn, and a public URL spawns the (sentinel)
//! binary with the broker's authenticated proxy URL in its environment.
use super::*;
use std::sync::Arc;

const MANIFEST: &str = include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/spider/manifest.json");
const CHILD: &str = "RYU_SPIDER_REGISTRY_RUNTIME_CHILD";
const TEST_NAME: &str = "tool_exec::tests::spider_runtime::spider_canonical_registry_preserves_grants_and_egress_refusal";
const EGRESS_REFUSAL: &str = "command tool: egress URL refused: ";
/// Cloud metadata: must never reach the child.
const PRIVATE_URL: &str = "http://169.254.169.254/latest/meta-data/";
/// A public IP literal, so the pre-spawn screen needs no DNS in CI.
const PUBLIC_URL: &str = "https://93.184.216.34/page";
const CANONICAL_REFUSAL: &str = "call web or browser providers through their canonical layer tools";

#[tokio::test]
async fn spider_canonical_registry_preserves_grants_and_egress_refusal() {
    if std::env::var_os(CHILD).is_none() {
        let dir = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST_NAME, "--nocapture"])
            .env(CHILD, "1")
            .env("RUST_MIN_STACK", "16777216")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", dir.path())
            .env("RYU_ALLOW_GATEWAY_FALLBACK", "1")
            .env("RYU_EXEC_APPROVAL_MODE", "off")
            .env_remove("RYU_GATEWAY_REMOTE")
            .status()
            .unwrap();
        assert!(status.success(), "isolated Spider registry proof failed");
        return;
    }
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    // A runnable local sentinel leaves evidence when the production spawn
    // boundary is crossed, and records the proxy environment it received. It
    // never fetches the target URL; when curl is available it asks the broker
    // for the metadata address and records the broker's status code.
    #[cfg(unix)]
    let execution_fixture = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    let execution_marker = execution_fixture.path().join("executed");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let executable = execution_fixture.path().join("spider");
        std::fs::write(
            &executable,
            concat!(
                "#!/bin/sh\n",
                "d=\"${0%/*}\"\n",
                // Core's `bin_version` probe: spider_cli 2.53.9's clap output.
                "if [ \"$1\" = \"--version\" ]; then printf '%s\\n' \"${HTTPS_PROXY-unset}\" > \"$d/probed\"; echo 'spider_cli 2.53.9'; exit 0; fi\n",
                "printf executed > \"$d/executed\"\n",
                "printf '%s\\n%s\\n%s\\n%s\\n' \"$HTTPS_PROXY\" \"$HTTP_PROXY\" \"${NO_PROXY-unset}\" \"$all_proxy\" > \"$d/env\"\n",
                "if [ -x /usr/bin/curl ]; then /usr/bin/curl -s -o /dev/null -w '%{http_code}' -x \"$HTTP_PROXY\" http://169.254.169.254/ > \"$d/metadata\"; fi\n",
                "printf '{\"sentinel\":true}\\n'\n",
            ),
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        // Match the production env-clear posture and prove the sentinel itself
        // can record execution before relying on its absence for denial proof.
        assert!(std::process::Command::new(&executable)
            .env_clear()
            .output()
            .unwrap()
            .status
            .success());
        assert_eq!(std::fs::read(&execution_marker).unwrap(), b"executed");
        std::fs::remove_file(&execution_marker).unwrap();
        std::env::set_var(
            ENV_COMMAND_TOOL_ALLOWLIST,
            format!("spider={}", executable.display()),
        );
        std::env::set_var("RYU_SPIDER_BIN", executable);
    }
    std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
    std::env::remove_var("RYU_GATEWAY_TOKEN");
    let manifest =
        crate::plugin_manifest::PluginManifest::parse_and_validate_with_code(MANIFEST, |path| {
            Err(format!("Spider has no code fragments: {path}"))
        })
        .unwrap();
    assert_eq!(manifest.id, "@ryu/spider");
    assert_eq!(manifest.permission_grants, ["tool:command:spider"]);
    let authored: Value = serde_json::from_str(MANIFEST).unwrap();
    let config: crate::plugin_manifest::schema::ToolConfig =
        serde_json::from_value(authored["runnables"][0]["config"].clone()).unwrap();
    let crate::plugin_manifest::schema::ToolBackend::Command {
        args: templates,
        arg_bounds,
        egress_url_arg,
        ..
    } = config.resolve_backend().unwrap()
    else {
        panic!("Spider must retain its command backend");
    };
    assert_eq!(egress_url_arg.as_deref(), Some("url"));
    // These are Core's actual mapping/default/render helpers; the argv a real
    // Spider receives is asserted here rather than through the sentinel.
    for (verb, input, expected) in [
        (
            "web.extract",
            serde_json::json!({"url":"https://fixture.invalid/page","format":"text"}),
            vec![
                "crawl",
                "--depth",
                "0",
                "--limit",
                "1",
                "--output",
                "json",
                "--",
                "https://fixture.invalid/page",
            ],
        ),
        (
            "web.crawl",
            serde_json::json!({"url":"https://fixture.invalid/site"}),
            vec![
                "crawl",
                "--depth",
                "1",
                "--limit",
                "10",
                "--output",
                "json",
                "--",
                "https://fixture.invalid/site",
            ],
        ),
        (
            "web.crawl",
            serde_json::json!({"url":"https://fixture.invalid/site","depth":99,"limit":-2}),
            vec![
                "crawl",
                "--depth",
                "10",
                "--limit",
                "1",
                "--output",
                "json",
                "--",
                "https://fixture.invalid/site",
            ],
        ),
    ] {
        let provide = authored["provides"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["tools"].get(verb).is_some())
            .unwrap();
        let binding: crate::plugin_manifest::CapabilityToolBinding =
            serde_json::from_value(provide["tools"][verb].clone()).unwrap();
        assert_eq!(binding.tool, "spider.crawl");
        let mut mapped = crate::sidecar::mcp::capability_tools::map_args(&binding, input);
        assert!(mapped.get("format").is_none());
        crate::plugin_manifest::schema::clamp_and_default_args(&mut mapped, &arg_bounds);
        let argv: Vec<_> = templates
            .iter()
            .map(|arg| render_command_arg(arg, &mapped).unwrap())
            .collect();
        assert_eq!(argv, expected);
    }
    let store = Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    store.insert(&manifest.id, &manifest.version).await.unwrap();
    store
        .set_enabled(&manifest.id, &manifest.permission_grants)
        .await
        .unwrap();
    let manifests = Arc::new(tokio::sync::RwLock::new(vec![manifest]));
    let registry =
        crate::sidecar::mcp::McpRegistry::empty().with_self_build(manifests.clone(), store.clone());
    registry.register_app_tool("spider.crawl".into(), "spider.crawl".into(), None);
    crate::plugins::binding::set_active_config(crate::plugins::binding::BindingConfig {
        overrides: [
            ("web.crawl".into(), "@ryu/spider".into()),
            ("web.extract".into(), "@ryu/spider".into()),
        ]
        .into_iter()
        .collect(),
    });
    let verbs = registry.capability_verbs().await;
    assert_eq!(verbs.len(), 2);
    assert!(verbs.iter().all(|verb| verb.provider_id == "@ryu/spider"));
    for verb in ["web.extract", "web.crawl"] {
        let denied = registry
            .call_tool(
                verb,
                serde_json::json!({"url":"https://fixture.invalid/page"}),
                Some(&["web.search".into()]),
            )
            .await
            .unwrap_err();
        assert!(denied.to_string().contains("not in this agent's allowlist"));
        let refusal = registry
            .call_tool(
                verb,
                serde_json::json!({"url": PRIVATE_URL}),
                Some(&[verb.into()]),
            )
            .await
            .unwrap_err();
        assert!(refusal.to_string().starts_with(EGRESS_REFUSAL), "{refusal}");
        for private in [
            "http://127.0.0.1:7980/",
            "http://10.0.0.1/",
            "http://localhost/",
        ] {
            let retry = registry
                .call_tool(verb, serde_json::json!({"url": private}), None)
                .await
                .unwrap_err();
            assert!(
                retry.to_string().starts_with(EGRESS_REFUSAL),
                "{private}: {retry}"
            );
        }
        #[cfg(unix)]
        assert!(
            !execution_marker.exists(),
            "private URLs must never spawn Spider"
        );
    }
    // A public URL spawns Spider behind the broker: the child receives the
    // authenticated loopback proxy for every scheme and no NO_PROXY exemption.
    #[cfg(unix)]
    {
        let crawled = registry
            .call_tool(
                "web.crawl",
                serde_json::json!({"url": PUBLIC_URL}),
                Some(&["web.crawl".into()]),
            )
            .await
            .unwrap();
        assert_eq!(crawled["provider"], "@ryu/spider", "{crawled}");
        assert_eq!(crawled["raw"]["sentinel"], true, "{crawled}");
        assert!(execution_marker.exists());
        let env = std::fs::read_to_string(execution_fixture.path().join("env")).unwrap();
        let lines: Vec<_> = env.lines().collect();
        assert!(
            lines[0].starts_with("http://ryu:") && lines[0].contains("@127.0.0.1:"),
            "{env}"
        );
        assert_eq!(lines[1], lines[0]);
        assert_eq!(lines[2], "unset");
        assert_eq!(lines[3], lines[0]);
        if let Ok(code) = std::fs::read_to_string(execution_fixture.path().join("metadata")) {
            assert_eq!(
                code, "403",
                "the broker must refuse the child's metadata request"
            );
        }
        std::fs::remove_file(&execution_marker).unwrap();
        let probed = execution_fixture.path().join("probed");
        assert!(probed.exists(), "the declared version probe must run");

        // A different installed Spider (here one reporting an older release) is
        // refused by the manifest's `bin_version` requirement before argv,
        // Gateway, egress broker, or crawl spawn: the probe ran without the
        // broker's proxy credential and the crawl itself never started.
        let executable = execution_fixture.path().join("spider");
        let current = std::fs::read_to_string(&executable).unwrap();
        let stale = current.replace("spider_cli 2.53.9", "spider_cli 2.9.0");
        std::fs::write(&executable, &stale).unwrap();
        std::fs::remove_file(&probed).unwrap();
        let refused = registry
            .call_tool(
                "web.crawl",
                serde_json::json!({"url": PUBLIC_URL}),
                Some(&["web.crawl".into()]),
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(
            refused.starts_with(super::bin_version::BIN_VERSION_REFUSAL),
            "{refused}"
        );
        assert!(refused.contains("version 2.9.0"), "{refused}");
        assert!(refused.contains("'=2.53.9'"), "{refused}");
        assert!(
            refused.contains("cargo install spider_cli --version 2.53.9 --locked"),
            "{refused}"
        );
        let probe_proxy = std::fs::read_to_string(&probed).unwrap();
        assert!(
            !probe_proxy.starts_with("http://ryu:"),
            "the version probe must run before the egress broker exists: {probe_proxy}"
        );
        assert!(
            !execution_marker.exists(),
            "an unsupported Spider version must never be spawned for a crawl"
        );
        std::fs::write(&executable, &current).unwrap();
    }
    store.set_disabled("@ryu/spider").await.unwrap();
    // Production deactivation removes contributed app tools as well as updating
    // the store. That registry mutation invalidates cached provider resolution;
    // a low-level store write alone is not the complete lifecycle operation.
    registry.unregister_app_tool("spider.crawl");
    assert!(registry
        .capability_verbs()
        .await
        .iter()
        .all(|verb| verb.provider_id != "@ryu/spider"));
    let disabled_record = store.get("@ryu/spider").await.unwrap().unwrap();
    assert!(!disabled_record.enabled);
    assert!(disabled_record.approved_grants.is_empty());
    let unavailable = registry
        .call_tool(
            "web.crawl",
            serde_json::json!({"url":"https://fixture.invalid/page"}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(unavailable["ok"], false);
    assert_eq!(unavailable["available"], false);
    assert_eq!(unavailable["capability"], "web.crawl");
    assert_eq!(unavailable["error"], "no provider is selected for 'web.crawl' that serves 'web.crawl' — install and select one in the layer picker");
    store
        .set_enabled("@ryu/spider", &["tool:command:spider".into()])
        .await
        .unwrap();
    registry.register_app_tool("spider.crawl".into(), "spider.crawl".into(), None);
    let restored_verbs = registry.capability_verbs().await;
    assert_eq!(
        restored_verbs
            .iter()
            .filter(|verb| verb.provider_id == "@ryu/spider")
            .count(),
        2
    );
    // Raw provider admission is refused before its command grants/egress checks.
    let bypass = registry
        .call_tool(
            "spider.crawl",
            serde_json::json!({"url":"https://fixture.invalid/page"}),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(bypass.to_string(), CANONICAL_REFUSAL);
    let restored = registry
        .call_tool("web.crawl", serde_json::json!({"url": PRIVATE_URL}), None)
        .await
        .unwrap_err();
    assert!(
        restored.to_string().starts_with(EGRESS_REFUSAL),
        "{restored}"
    );
    // Core-tier trust uses the shipped declaration, not the approval record.
    store.set_approved_grants("@ryu/spider", &[]).await.unwrap();
    let trusted = registry
        .call_tool("web.crawl", serde_json::json!({"url": PRIVATE_URL}), None)
        .await
        .unwrap_err();
    assert!(trusted.to_string().starts_with(EGRESS_REFUSAL), "{trusted}");
    // A missing declaration does not open a raw provider bypass. The canonical
    // verb reaches the command grant guard before the egress guard instead.
    manifests.write().await[0].permission_grants.clear();
    let direct = registry
        .call_tool(
            "spider.crawl",
            serde_json::json!({"url":"https://fixture.invalid/page"}),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(direct.to_string(), CANONICAL_REFUSAL);
    let ungranted = registry
        .call_tool(
            "web.crawl",
            serde_json::json!({"url":"https://fixture.invalid/page"}),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(
        ungranted.to_string(),
        "command tool: exec of 'spider' is not granted (needs 'tool:command:spider')"
    );
    #[cfg(unix)]
    assert!(
        !execution_marker.exists(),
        "canonical admission, grant, and egress refusals must never execute Spider"
    );
}
