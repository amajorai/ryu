//! OS-level deletion containment for Ryu-managed ACP agents.
//!
//! The Codex hook and command scanner are policy guardrails, but an ACP agent
//! still runs as a child process. This module inserts a tiny Ryu-owned runner
//! between the ACP client and Codex so the operating system can deny file
//! removal before the agent's shell or descendants start.
//!
//! Platform posture:
//! - Linux uses Landlock with `REMOVE_FILE` and `REMOVE_DIR` handled and no
//!   allow rules, which denies unlink and rename for the runner and descendants.
//! - macOS uses the system Seatbelt runner with a narrow deletion-denial profile.
//!   `sandbox-exec` is deprecated by Apple; the packaged App Sandbox/VM runner
//!   is the follow-up replacement, but silently spawning an unconfined Codex is
//!   not acceptable in the meantime.
//! - Windows fails closed until Ryu has a native AppContainer runner. The
//!   Recycle Bin helper remains available for an explicitly brokered operation;
//!   it is not an OS containment boundary for an arbitrary child process.
//!
//! This is deliberately scoped to Codex for the first rollout. Other ACP agents
//! retain their existing Ryu scanner/permission behavior until their process
//! contracts are audited against the same runner.

use std::path::{Path, PathBuf};

use agent_client_protocol::schema::McpServerStdio;
use anyhow::{bail, Context, Result};

/// Marker argument used when the Ryu Core binary is acting as the child runner.
pub const AGENT_SANDBOX_RUNNER_ARG: &str = "--ryu-agent-sandbox-runner";

const ARG_SEPARATOR: &str = "--";

/// Rewrite a Codex stdio server to launch through Ryu's OS-level runner.
///
/// Non-Codex ACP servers are returned unchanged for compatibility. Codex is
/// rejected on platforms where this build cannot establish a deletion boundary;
/// there is no unsafe direct-spawn fallback.
pub fn confine_codex_stdio(mut stdio: McpServerStdio) -> Result<McpServerStdio> {
    if !is_codex_stdio(&stdio) {
        return Ok(stdio);
    }

    ensure_runner_supported()?;
    let runner = std::env::current_exe().context("resolving the Ryu agent runner")?;
    let original_command = std::mem::replace(&mut stdio.command, PathBuf::new());
    let original_args = std::mem::take(&mut stdio.args);
    let mut runner_args = Vec::with_capacity(original_args.len() + 3);
    runner_args.push(AGENT_SANDBOX_RUNNER_ARG.to_owned());
    runner_args.push(ARG_SEPARATOR.to_owned());
    runner_args.push(original_command.to_string_lossy().into_owned());
    runner_args.extend(original_args);

    stdio.command = runner;
    stdio.args = runner_args;
    Ok(stdio)
}

fn is_codex_stdio(stdio: &McpServerStdio) -> bool {
    let command = stdio.command.to_string_lossy().to_ascii_lowercase();
    let args = stdio
        .args
        .iter()
        .map(|arg| arg.to_ascii_lowercase())
        .collect::<Vec<_>>();
    command.contains("codex") || args.iter().any(|arg| arg.contains("codex-acp"))
}

fn ensure_runner_supported() -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let path = Path::new("/usr/bin/sandbox-exec");
        if is_executable(path) {
            return Ok(());
        }
        bail!(
            "Ryu cannot start managed Codex: macOS deletion containment requires /usr/bin/sandbox-exec"
        )
    }

    #[cfg(target_os = "windows")]
    {
        bail!(
            "Ryu cannot start managed Codex on Windows yet: native AppContainer deletion containment is not available in this build"
        )
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        bail!("Ryu cannot start managed Codex: this OS has no verified deletion containment runner")
    }
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Run the Ryu Core binary as the ACP child runner when the marker argument is
/// present. This executes before normal Core startup, so it does not open any
/// database, start an HTTP server, or invoke agent code outside the OS boundary.
pub fn run_if_requested() -> bool {
    let args = std::env::args().collect::<Vec<_>>();
    let Some(marker_index) = args.iter().position(|arg| arg == AGENT_SANDBOX_RUNNER_ARG) else {
        return false;
    };

    if let Err(error) = run_child(&args[marker_index + 1..]) {
        eprintln!("ryu agent sandbox runner refused to start: {error}");
        std::process::exit(126);
    }
    unreachable!("agent sandbox runner returned without replacing the process")
}

fn run_child(args: &[String]) -> Result<()> {
    if args.first().map(String::as_str) != Some(ARG_SEPARATOR) {
        bail!("runner arguments must start with '{ARG_SEPARATOR}'")
    }
    let Some(command) = args.get(1) else {
        bail!("runner received no child command")
    };
    let child_args = &args[2..];

    #[cfg(target_os = "linux")]
    {
        install_linux_delete_denial()?;
        use std::os::unix::process::CommandExt;
        let error = std::process::Command::new(command).args(child_args).exec();
        return Err(error).context("execing the confined Codex child");
    }

    #[cfg(target_os = "macos")]
    {
        const PROFILE: &str = "(version 1) (allow default) (deny file-write-unlink)";
        use std::os::unix::process::CommandExt;
        let error = std::process::Command::new("/usr/bin/sandbox-exec")
            .arg("-p")
            .arg(PROFILE)
            .arg(command)
            .args(child_args)
            .exec();
        return Err(error).context("execing the macOS Seatbelt Codex child");
    }

    #[cfg(target_os = "windows")]
    {
        let _ = (command, child_args);
        bail!("native Windows AppContainer deletion containment is not available in this build")
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (command, child_args);
        bail!("this OS has no verified deletion containment runner")
    }
}

#[cfg(target_os = "linux")]
fn install_linux_delete_denial() -> Result<()> {
    // Landlock syscall numbers are stable in the asm-generic syscall table used
    // by supported Linux architectures. This ruleset handles only removal
    // rights and installs no path rules, so those rights are denied everywhere.
    const LANDLOCK_CREATE_RULESET: libc::c_long = 444;
    const LANDLOCK_RESTRICT_SELF: libc::c_long = 446;
    const LANDLOCK_ACCESS_FS_REMOVE_DIR: u64 = 1 << 4;
    const LANDLOCK_ACCESS_FS_REMOVE_FILE: u64 = 1 << 5;

    let no_new_privs = unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    if no_new_privs != 0 {
        return Err(std::io::Error::last_os_error()).context("enabling no_new_privs for Landlock");
    }

    #[repr(C)]
    struct RulesetAttr {
        handled_access_fs: u64,
    }
    let attr = RulesetAttr {
        handled_access_fs: LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE,
    };
    let fd = unsafe {
        libc::syscall(
            LANDLOCK_CREATE_RULESET,
            &attr as *const RulesetAttr,
            std::mem::size_of::<RulesetAttr>(),
            0,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error())
            .context("creating the Landlock deletion-denial ruleset");
    }

    let restricted = unsafe { libc::syscall(LANDLOCK_RESTRICT_SELF, fd, 0) };
    let restrict_error = if restricted != 0 {
        Some(std::io::Error::last_os_error())
    } else {
        None
    };
    unsafe {
        libc::close(fd as libc::c_int);
    }
    if let Some(error) = restrict_error {
        return Err(error).context("installing the Landlock deletion-denial ruleset");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_codex_stdio_is_not_rewritten() {
        let stdio = McpServerStdio::new("safe-agent", "/usr/bin/echo");
        let confined = confine_codex_stdio(stdio.clone()).expect("non-Codex agent unchanged");
        assert_eq!(confined.command, stdio.command);
        assert_eq!(confined.args, stdio.args);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn codex_stdio_uses_the_runner_marker() {
        let stdio = McpServerStdio::new("codex", "codex-acp").args(vec!["--version".to_owned()]);
        let confined = confine_codex_stdio(stdio).expect("supported host runner");
        assert_eq!(
            confined.command,
            std::env::current_exe().expect("current executable")
        );
        assert_eq!(confined.args[0], AGENT_SANDBOX_RUNNER_ARG);
        assert_eq!(confined.args[1], ARG_SEPARATOR);
        assert_eq!(confined.args[2], "codex-acp");
        assert_eq!(confined.args[3], "--version");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_codex_spawn_fails_closed_without_native_runner() {
        let stdio = McpServerStdio::new("codex", "codex-acp");
        let error = confine_codex_stdio(stdio).expect_err("Windows must fail closed");
        assert!(error.to_string().contains("AppContainer"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_runner_is_available_without_running_a_deletion_command() {
        ensure_runner_supported().expect("macOS Seatbelt runner");
    }
}
