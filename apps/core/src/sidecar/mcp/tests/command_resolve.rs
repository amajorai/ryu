//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;
use crate::sidecar::mcp::tests::{
    lock_mcp_env, manifest_with_mcp_server, present_command, register_as_enabled, ManagedBin,
};

#[test]
fn installed_plugin_dir_is_the_package_the_manifest_came_from() {
    let root = tempfile::tempdir().expect("tempdir");
    assert_eq!(
        installed_plugin_dir_in(root.path(), "@ryu/pomodoro"),
        None,
        "a built-in with no on-disk package keeps the inherited cwd"
    );
    let write_package = |name: &str, id: &str| {
        let dir = root.path().join(name);
        std::fs::create_dir_all(&dir).expect("package dir");
        std::fs::write(dir.join("manifest.json"), format!(r#"{{"id":"{id}"}}"#)).expect("manifest");
        dir
    };
    // A directory with no manifest, or another plugin's, is not this package.
    std::fs::create_dir_all(root.path().join("@ryu+pomodoro")).expect("empty dir");
    write_package("other", "@ryu/other");
    assert_eq!(installed_plugin_dir_in(root.path(), "@ryu/pomodoro"), None);
    // A hand-installed copy under any directory name is found by its id.
    let dev = write_package("pomodoro-dev", "@ryu/pomodoro");
    assert_eq!(
        installed_plugin_dir_in(root.path(), "@ryu/pomodoro"),
        Some(dev.clone())
    );
    std::fs::remove_dir_all(&dev).expect("remove dir");
    std::fs::write(&dev, b"not a directory").expect("file");
    assert_eq!(installed_plugin_dir_in(root.path(), "@ryu/pomodoro"), None);
}

#[test]
fn a_relative_command_is_anchored_to_the_package_directory() {
    let package = std::path::Path::new("/plugins/@ryu+pomodoro");
    assert_eq!(
        anchor_relative_command("./bin/mcp-server", package),
        Ok(Some(
            package
                .join("./bin/mcp-server")
                .to_string_lossy()
                .into_owned()
        ))
    );
    // Bare names resolve through PATH and absolute paths stand as written.
    assert_eq!(anchor_relative_command("node", package), Ok(None));
    #[cfg(not(windows))]
    let absolute = "/usr/bin/node";
    #[cfg(windows)]
    let absolute = r"C:\Program Files\nodejs\node.exe";
    assert_eq!(anchor_relative_command(absolute, package), Ok(None));
    // On Windows a drive-less rooted path is not absolute: the OS would resolve it
    // against Core's current drive, so it is pinned to the package's drive instead.
    #[cfg(windows)]
    assert_eq!(
        anchor_relative_command("/usr/bin/node", std::path::Path::new(r"D:\plugins\pkg")),
        Ok(Some(r"D:/usr/bin/node".to_owned()))
    );
    // A command may not climb out of its package.
    assert_eq!(anchor_relative_command("../evil/server", package), Err(()));
    assert_eq!(anchor_relative_command("bin/../../x", package), Err(()));
}

/// `command_env` is applied BEFORE the probe, so an operator who points the
/// declaration at a binary outside `PATH` is not told it is missing. Without this
/// ordering, `ghost` with a valid `RYU_GHOST_BIN` would still be skipped.
#[test]
fn the_probe_honors_command_env_before_deciding_a_binary_is_missing() {
    let reg = McpRegistry::empty();
    let mut manifest = manifest_with_mcp_server("com.test.plugin", "env-srv");
    let decl = manifest.mcp_servers.get_mut("env-srv").expect("decl");
    // A bare name that is definitely not on PATH...
    decl.command = Some(format!("ryu-absent-mcp-{}", uuid::Uuid::new_v4()));
    // ...redirected by env at a path that exists.
    decl.command_env = Some("RYU_TEST_PROBE_MCP_BIN".to_owned());
    std::env::set_var("RYU_TEST_PROBE_MCP_BIN", present_command());

    let names = register_as_enabled(&reg, &manifest, &[GRANT_MCP_SERVER]);
    std::env::remove_var("RYU_TEST_PROBE_MCP_BIN");

    assert_eq!(
        names,
        vec!["env-srv".to_owned()],
        "an env-redirected command that exists must register"
    );
}

/// The probe's rules, asserted directly: `PATH` lookup for a bare name, a FILE
/// check for anything carrying a separator (that is what `Command::new` does with
/// a path — it does not consult `PATH`), and blank is never spawnable.
///
/// The lazy-package-runner idiom is the load-bearing case: `agentbrowser` declares
/// `npx -y agent-browser mcp`, so the thing probed must be `npx` (present, fetches
/// the package on first spawn) and never `agent-browser` (absent until then).
#[test]
fn the_probe_answers_for_path_names_paths_and_blanks() {
    // A bare name resolved through PATH. The platform shell is the one program
    // that is on PATH on every host this suite runs on; PATH is deliberately not
    // mutated here (it is process-global and these tests run in parallel).
    let on_path = if cfg!(windows) { "cmd" } else { "sh" };
    assert!(
        mcp_command_is_present(on_path),
        "a bare name on PATH must resolve"
    );
    assert!(!mcp_command_is_present(&format!(
        "ryu-absent-mcp-{}",
        uuid::Uuid::new_v4()
    )));

    // A path is checked as a file, never through PATH.
    let exe = present_command();
    assert!(mcp_command_is_present(&exe), "an existing file resolves");
    assert!(
        !mcp_command_is_present(&format!("{exe}-does-not-exist")),
        "a path that is not a file must not resolve"
    );
    let dir = std::env::temp_dir();
    assert!(
        !mcp_command_is_present(&dir.to_string_lossy()),
        "a directory is not something Command::new can exec"
    );

    // Blank: nothing to spawn, and registering it would yield a spawn failure
    // with an empty program name.
    assert!(!mcp_command_is_present(""));
    assert!(!mcp_command_is_present("   "));

    // Surrounding whitespace is not part of the program name.
    assert!(mcp_command_is_present(&format!("  {on_path}  ")));
}

/// Rung 2, the point of this seam: a bare `command` that is absent from `PATH` but
/// present in the Ryu-managed bin dir registers, and the config stores the ABSOLUTE
/// path — which is what makes the probe's file branch (and `Command::new`) find it.
///
/// Without this, a manifest could never reach a binary Ryu itself installed:
/// `ensure_local_sidecar_present` writes to `<data dir>/bin`, which is deliberately
/// not on `PATH`, so declaring a `command_env` and hoping something seeded it was the
/// only working shape. App-agnostic by construction — the only input is the manifest's
/// `command`.
///
/// The discriminator is the **absolute stored path**, not mere registration. Presence
/// alone would prove nothing: Ryu's own installer appends `<data dir>/bin` to the
/// user's `PATH`, so on a developer box the bare name frequently resolves through rung
/// 3 as well — and that is precisely the host this suite runs on. Rung 3 stores the
/// bare name verbatim; only rung 2 can produce the absolute path, so asserting it
/// is what separates the two on every host.
#[test]
fn a_bare_command_in_the_managed_bin_dir_resolves_to_its_absolute_path() {
    let bin = ManagedBin::install();

    let reg = McpRegistry::empty();
    let mut manifest = manifest_with_mcp_server("com.test.plugin", "managed-srv");
    let decl = manifest.mcp_servers.get_mut("managed-srv").expect("decl");
    decl.command = Some(bin.command.clone());
    decl.command_env = None;

    let names = register_as_enabled(&reg, &manifest, &[GRANT_MCP_SERVER]);

    assert_eq!(
        names,
        vec!["managed-srv".to_owned()],
        "a command installed in the managed bin dir must register"
    );
    let servers = reg.servers.read().expect("lock");
    assert_eq!(
        servers
            .get("managed-srv")
            .expect("registered")
            .command
            .as_deref(),
        Some(bin.path.to_string_lossy().as_ref()),
        "the stored command must be the absolute managed-bin path, not the bare name"
    );
}

/// Rung 1 stays on top: an explicit `command_env` override beats a managed-bin hit,
/// even though both resolve. An operator or `bun dev` pointing at a locally-built
/// binary must not be silently overruled by whatever a release left in `~/.ryu/bin`.
#[test]
fn command_env_wins_over_a_managed_bin_dir_hit() {
    let _lock = lock_mcp_env();
    let bin = ManagedBin::install();
    let previous = std::env::var("RYU_TEST_MANAGED_MCP_BIN").ok();
    std::env::set_var("RYU_TEST_MANAGED_MCP_BIN", present_command());

    let decl = crate::plugin_manifest::McpServerDecl {
        command: Some(bin.command.clone()),
        command_env: Some("RYU_TEST_MANAGED_MCP_BIN".to_owned()),
        args: Vec::new(),
        env: BTreeMap::new(),
        description: None,
        enabled: true,
        ..Default::default()
    };
    let resolved = mcp_server_config_from_decl(&decl).command;

    match previous {
        Some(prev) => std::env::set_var("RYU_TEST_MANAGED_MCP_BIN", prev),
        None => std::env::remove_var("RYU_TEST_MANAGED_MCP_BIN"),
    }

    assert_eq!(
        resolved.as_deref(),
        Some(present_command().as_str()),
        "the env override must win even when the managed bin dir also has the command"
    );
}

/// Rung 3 is untouched for a name that only `PATH` can resolve: the lazy-package-runner
/// idiom (`npx -y agent-browser mcp`) depends on the bare name surviving to
/// `Command::new`, and a lowered absolute path would also pin the runner to one
/// install for the life of the config.
///
/// The platform shell stands in for `npx` because it is on `PATH` on every host this
/// suite runs on; `npx` itself would make the test depend on whether the runner is
/// installed. The absence precondition is asserted so a host that somehow has
/// `<data dir>/bin/sh` fails with the real reason instead of a bare inequality.
#[test]
fn a_bare_command_only_on_path_is_not_rewritten() {
    let on_path = if cfg!(windows) { "cmd" } else { "sh" };
    assert!(
        !crate::sidecar::manifest_sidecar::managed_bin_path(on_path).is_file(),
        "precondition: '{on_path}' must not be installed in the managed bin dir"
    );

    let decl = crate::plugin_manifest::McpServerDecl {
        command: Some(on_path.to_owned()),
        command_env: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        description: None,
        enabled: true,
        ..Default::default()
    };

    assert_eq!(
        mcp_server_config_from_decl(&decl).command.as_deref(),
        Some(on_path),
        "a PATH-resolved runner must reach Command::new as the bare name"
    );
    assert!(
        mcp_command_is_present(on_path),
        "and it must still probe as present"
    );
}

/// A `command` that already carries a path separator is a path, never a managed-bin
/// name: joining it under `<data dir>/bin` would change its meaning and let `..`
/// segments walk out of the dir. Asserted for a path that exists (so the managed-bin
/// rung cannot be skipped merely because the file was absent).
#[test]
fn a_command_carrying_a_path_separator_is_never_rewritten() {
    let exe = present_command();
    assert!(
        exe.contains('/') || exe.contains('\\'),
        "precondition: the test binary path carries a separator"
    );

    let decl = crate::plugin_manifest::McpServerDecl {
        command: Some(exe.clone()),
        command_env: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        description: None,
        enabled: true,
        ..Default::default()
    };

    assert_eq!(
        mcp_server_config_from_decl(&decl).command.as_deref(),
        Some(exe.as_str()),
        "a declared path must be passed through verbatim"
    );
}

/// Fail-closed, with the new rung in place: a bare command that is on neither `PATH`
/// nor the managed bin dir, with no `command_env`, still resolves to nothing and is
/// still SKIPPED rather than registered — the guard that keeps a model from being
/// offered tools whose every call ENOENTs.
///
/// (`register_manifest_mcp_servers` also logs a warning naming the command and the bin
/// dir. That is `tracing::warn!` with no subscriber installed under `cargo test`, so
/// what is asserted here is the skip itself, not the log line.)
#[test]
fn a_bare_command_absent_from_path_and_the_managed_bin_dir_is_still_skipped() {
    let absent = format!("ryu-absent-mcp-{}", uuid::Uuid::new_v4());
    assert!(
        crate::sidecar::manifest_sidecar::which_on_path(&absent).is_none(),
        "precondition: not on PATH"
    );
    assert!(
        !crate::sidecar::manifest_sidecar::managed_bin_path(&absent).is_file(),
        "precondition: not in the managed bin dir"
    );

    let decl = crate::plugin_manifest::McpServerDecl {
        command: Some(absent.clone()),
        command_env: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        description: None,
        enabled: true,
        ..Default::default()
    };
    let resolved = mcp_server_config_from_decl(&decl).command;
    assert_eq!(
        resolved.as_deref(),
        Some(absent.as_str()),
        "nothing to lower to; the bare name stands"
    );
    assert!(
        !mcp_command_is_present(resolved.as_deref().unwrap_or_default()),
        "and it must not probe as present"
    );

    let reg = McpRegistry::empty();
    let mut manifest = manifest_with_mcp_server("com.test.plugin", "absent-srv");
    manifest.mcp_servers.insert("absent-srv".to_owned(), decl);

    let names = register_as_enabled(&reg, &manifest, &[GRANT_MCP_SERVER]);

    assert!(
        names.is_empty(),
        "the managed-bin rung must not weaken the fail-closed skip, got {names:?}"
    );
    assert!(!reg.contains_server("absent-srv"));
}
