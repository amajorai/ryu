//! Shipped Headroom policy values through Core's real Gateway spawn environment.
//! No process is started; lifecycle/respawn and real Headroom remain separate.
use super::*;
use std::collections::BTreeMap;
const MANIFEST: &str =
    include_str!("../../../../../../generated/ryu-runtime/plugins-store/plugins/headroom/manifest.json");
const CHILD: &str = "RYU_HEADROOM_POLICY_RUNTIME_CHILD";
const TEST:&str="sidecar::gateway::tests::headroom_policy_runtime::shipped_headroom_policy_sets_and_clears_spawn_contract";

#[test]
fn shipped_headroom_policy_sets_and_clears_spawn_contract() {
    if std::env::var_os(CHILD).is_none() {
        let dir = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--nocapture"])
            .env(CHILD, "1")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", dir.path())
            .env("RYU_GATEWAY_MANAGED", "1")
            .env_remove("RYU_GATEWAY_REMOTE")
            .env_remove("RYU_MANAGED_NODE")
            .env_remove("GATEWAY_ADMIN_KEY")
            .env_remove("GATEWAY_MASTER_KEY")
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    let _flags = crate::sidecar::gateway_policy::lock_policy_flags();
    let _gateway = lock_gateway_env();
    let _env = EnvGuard::capture(&[
        "RYU_HEADROOM_URL",
        "RYU_HEADROOM_ENABLED",
        "GATEWAY_COMPRESSION_ENABLED",
        "GATEWAY_COMPRESSION_URL",
        "GATEWAY_COMPRESSION_TOKEN",
        "GATEWAY_COMPRESSION_TIMEOUT_MS",
        "GATEWAY_COMPRESSION_MIN_MESSAGES",
    ]);
    let manifest =
        crate::plugin_manifest::PluginManifest::parse_and_validate_with_code(MANIFEST, |_| {
            Err("no code fragments".into())
        })
        .unwrap();
    assert_eq!(manifest.runnables.len(), 1);
    assert_eq!(
        manifest.runnables[0].kind,
        crate::runnable::RunnableKind::Policy
    );
    let config: crate::plugin_manifest::schema::PolicyConfig =
        serde_json::from_value(manifest.runnables[0].config.clone().unwrap()).unwrap();
    assert_eq!(config.policy_type, "compression");
    let policy = crate::sidecar::headroom::CompressionPolicy::from_definition(&config.definition);
    assert_eq!(policy.service.as_deref(), Some("headroom"));
    assert_eq!(policy.url.as_deref(), Some("http://127.0.0.1:8787"));
    assert_eq!(policy.timeout_ms, Some(4000));
    assert_eq!(policy.min_messages, Some(4));
    assert!(policy.token.is_none());
    crate::sidecar::headroom::set_compression_policy(policy);
    crate::sidecar::headroom::set_enabled(true);
    let compression_env = |env: Vec<(String, String)>| {
        env.into_iter()
            .filter(|(name, _)| name.starts_with("GATEWAY_COMPRESSION_"))
            .collect::<BTreeMap<_, _>>()
    };
    let enabled = compression_env(gateway_spawn_env());
    assert_eq!(
        enabled,
        BTreeMap::from([
            ("GATEWAY_COMPRESSION_ENABLED".into(), "1".into()),
            (
                "GATEWAY_COMPRESSION_URL".into(),
                "http://127.0.0.1:8787".into()
            ),
            ("GATEWAY_COMPRESSION_TIMEOUT_MS".into(), "4000".into()),
            ("GATEWAY_COMPRESSION_MIN_MESSAGES".into(), "4".into()),
        ])
    );
    std::env::set_var("RYU_HEADROOM_URL", "http://127.0.0.1:19876");
    assert_eq!(
        compression_env(gateway_spawn_env())["GATEWAY_COMPRESSION_URL"],
        "http://127.0.0.1:19876"
    );
    crate::sidecar::headroom::set_enabled(false);
    crate::sidecar::headroom::set_compression_policy(Default::default());
    assert!(compression_env(gateway_spawn_env()).is_empty());
}
