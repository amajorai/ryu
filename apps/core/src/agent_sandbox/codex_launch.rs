use super::*;

/// Rewrite a Codex stdio server to launch through Ryu's OS-level runner.
///
/// Non-Codex ACP servers are returned unchanged for compatibility. Codex is
/// rejected on platforms where this build cannot establish a deletion boundary;
/// there is no unsafe direct-spawn fallback.
pub fn confine_codex_stdio(stdio: McpServerStdio) -> Result<McpServerStdio> {
    let codex = is_codex_stdio(&stdio);
    confine_classified_codex_stdio(stdio, codex)
}

pub fn confine_classified_codex_stdio(
    mut stdio: McpServerStdio,
    codex: bool,
) -> Result<McpServerStdio> {
    if !codex {
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

pub(super) fn ensure_runner_supported() -> Result<()> {
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

pub(super) fn is_executable(path: &Path) -> bool {
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
