use super::*;

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
    // Compared as paths: the manifest entrypoint is written with '/', which
    // Windows also accepts as a separator.
    assert_eq!(std::path::Path::new(&program), exe.as_path());
    assert!(missing_sidecar_binary_reason(&name).is_none());
    std::fs::remove_dir_all(&dir).ok();
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
