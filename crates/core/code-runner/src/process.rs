//! Bounded host subprocess execution: cleared environment, wall-clock timeout,
//! and capped output that keeps draining so a chatty child cannot block.

use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};

use crate::MAX_OUTPUT_BYTES;

/// Host variables a toolchain may need to start. Everything else, including
/// every credential, is cleared before the child runs.
const PASSTHROUGH_ENV: [&str; 16] = [
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SYSTEMROOT",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "ELAN_HOME",
    "ELAN_TOOLCHAIN",
    "BEND_HOME",
    "BENDTT",
];

/// Captured result of a finished child.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Captured {
    /// Exit code; `None` when the child was ended by a signal.
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl Captured {
    /// stdout followed by stderr, for diagnostics.
    pub(crate) fn combined(&self) -> String {
        match (self.stdout.trim().is_empty(), self.stderr.trim().is_empty()) {
            (false, false) => format!("{}\n{}", self.stdout.trim_end(), self.stderr.trim_end()),
            (false, true) => self.stdout.clone(),
            _ => self.stderr.clone(),
        }
    }
}

/// The child environment: the passthrough set from the host plus `extra`.
pub(crate) fn child_env(extra: &[(&str, String)]) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = std::env::vars()
        .filter(|(key, _)| {
            PASSTHROUGH_ENV
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(key))
        })
        .collect();
    env.extend(
        extra
            .iter()
            .map(|(key, value)| ((*key).to_string(), value.clone())),
    );
    env
}

/// Configure `command` for a bounded run: cleared env, no stdin, piped output,
/// its own process group (so a timeout can stop toolchain proxies such as
/// elan's `lean` together with the compiler they start), killed when dropped.
pub(crate) fn prepare(command: &mut Command, env: Vec<(String, String)>) {
    command
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
}

/// Stop `child` and, on Unix, every process in the group [`prepare`] gave it.
pub(crate) async fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id().and_then(|pid| i32::try_from(pid).ok()) {
        // SAFETY: `kill` takes no pointers; a negative pid addresses the process
        // group `prepare` created for this child, and a stale group only yields
        // ESRCH.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    let _ = child.kill().await;
}

/// Spawn and wait, bounded by `timeout`. `label` names the tool in errors.
pub(crate) async fn run_bounded(
    mut command: Command,
    timeout: Duration,
    label: &str,
) -> Result<Captured, String> {
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start {label}: {error}"))?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return Err(format!("{label} started without captured output"));
    };
    let finished = tokio::time::timeout(timeout, async {
        tokio::join!(read_capped(stdout), read_capped(stderr), child.wait())
    })
    .await;
    let Ok((stdout, stderr, status)) = finished else {
        kill_tree(&mut child).await;
        return Err(format!(
            "{label} exceeded the {}s step timeout",
            timeout.as_secs()
        ));
    };
    let status = status.map_err(|error| format!("{label} did not finish cleanly: {error}"))?;
    Ok(Captured {
        exit_code: status.code(),
        stdout,
        stderr,
    })
}

/// Read a stream to its end, keeping at most [`MAX_OUTPUT_BYTES`].
pub(crate) async fn read_capped<R: AsyncRead + Unpin>(mut reader: R) -> String {
    let mut kept = Vec::new();
    let mut clipped = false;
    let mut chunk = [0_u8; 8192];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let room = MAX_OUTPUT_BYTES.saturating_sub(kept.len());
                if read > room {
                    clipped = true;
                }
                kept.extend_from_slice(&chunk[..read.min(room)]);
            }
        }
    }
    let mut text = String::from_utf8_lossy(&kept).into_owned();
    if clipped {
        text.push_str("\n[output clipped]");
    }
    text
}
