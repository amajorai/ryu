use super::*;

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
    let src = crate::server::tests::source_text::server_source();
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
