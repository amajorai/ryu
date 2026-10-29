//! Reaping a tool sidecar left behind by an earlier Core.
//!
//! Shadow, Ghost and Restate record their child's PID on spawn and remove the
//! file only on a clean `stop()`. A crash, a killed Core or a reboot leaves the
//! file behind, and by the next start the OS may have handed that PID to an
//! unrelated process (an editor, a browser, Core itself). So the recorded PID is
//! only a hint: it is signalled only while the live process is still the tool's
//! own binary and started no later than the PID file was written.

use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

/// How long a terminated orphan gets to exit before it is force-killed.
#[cfg(unix)]
const TERM_GRACE: Duration = Duration::from_secs(2);

/// What the OS reports about the process currently holding a recorded PID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ObservedProcess {
    /// The process's executable, or `None` when the OS will not say (for example
    /// a process owned by another user).
    pub exe: Option<PathBuf>,
    /// Process start, in seconds since the Unix epoch.
    pub start_time: u64,
}

/// Parse a PID file's contents into a PID that may be signalled at all: never
/// 0 or 1 (on unix those address a process group or init), and never Core's own.
pub(crate) fn parse_signalable_pid(content: &str, own_pid: u32) -> Option<u32> {
    let pid = content.trim().parse::<u32>().ok()?;
    (pid > 1 && pid != own_pid && i32::try_from(pid).is_ok()).then_some(pid)
}

/// Whether `observed` is the tool binary at `expected_exe`, started no later
/// than the PID file was written (`recorded_at`, seconds since the epoch). An
/// unknown executable never matches.
pub(crate) fn is_recorded_tool(
    observed: &ObservedProcess,
    expected_exe: &Path,
    recorded_at: Option<u64>,
) -> bool {
    let Some(exe) = observed.exe.as_deref() else {
        return false;
    };
    // The PID file is written just after spawn; allow a second of clock slack.
    if recorded_at.is_some_and(|recorded| observed.start_time > recorded.saturating_add(1)) {
        return false;
    }
    normalized_exe(exe) == normalized_exe(expected_exe)
}

/// Canonicalize an executable path for comparison. Linux reports a binary that
/// was replaced on disk (a tool update) as `<path> (deleted)`; that is still the
/// tool's own orphan, so the suffix is dropped before comparing.
fn normalized_exe(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    let path = raw
        .strip_suffix(" (deleted)")
        .map_or_else(|| path.to_path_buf(), PathBuf::from);
    std::fs::canonicalize(&path).unwrap_or(path)
}

fn observe(pid: u32) -> Option<ObservedProcess> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::Always),
    );
    let process = system.process(pid)?;
    Some(ObservedProcess {
        exe: process.exe().map(Path::to_path_buf),
        start_time: process.start_time(),
    })
}

fn still_the_tool(pid: u32, expected_exe: &Path, recorded_at: Option<u64>) -> bool {
    observe(pid).is_some_and(|observed| is_recorded_tool(&observed, expected_exe, recorded_at))
}

/// Stop the process recorded in `pid_path` if it is still `binary_path`'s own
/// orphan, then remove the PID file whatever was found.
pub(crate) async fn reap(pid_path: &Path, binary_path: &Path, tool: &str) {
    let Ok(content) = tokio::fs::read_to_string(pid_path).await else {
        return;
    };
    let recorded_at = tokio::fs::metadata(pid_path)
        .await
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|age| age.as_secs());

    if let Some(pid) = parse_signalable_pid(&content, std::process::id()) {
        if still_the_tool(pid, binary_path, recorded_at) {
            tracing::info!("{tool}: stopping orphaned process {pid} from an earlier run");
            terminate(pid, binary_path, recorded_at).await;
        } else {
            tracing::debug!(
                "{tool}: recorded PID {pid} is not a running {tool} process; not signalling it"
            );
        }
    }

    let _ = tokio::fs::remove_file(pid_path).await;
}

#[cfg(unix)]
async fn terminate(pid: u32, binary_path: &Path, recorded_at: Option<u64>) {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;

    let Ok(raw) = i32::try_from(pid) else {
        return;
    };
    let nix_pid = Pid::from_raw(raw);
    let _ = kill(nix_pid, Signal::SIGTERM);

    let deadline = tokio::time::Instant::now() + TERM_GRACE;
    while tokio::time::Instant::now() < deadline {
        // `kill(pid, None)` fails with ESRCH once the process is gone.
        if kill(nix_pid, None).is_err() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // The PID may have been reused during the grace period: check again.
    if still_the_tool(pid, binary_path, recorded_at) {
        let _ = kill(nix_pid, Signal::SIGKILL);
    }
}

#[cfg(windows)]
async fn terminate(pid: u32, _binary_path: &Path, _recorded_at: Option<u64>) {
    use crate::win_process::NoWindow;

    let _ = tokio::process::Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .no_window()
        .output()
        .await;
}

/// Seconds since the Unix epoch, for callers building an [`ObservedProcess`].
#[cfg(test)]
fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |age| age.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_rejects_group_init_own_and_garbage_pids() {
        assert_eq!(parse_signalable_pid("4242\n", 7), Some(4242));
        assert_eq!(parse_signalable_pid("0", 7), None);
        assert_eq!(parse_signalable_pid("1", 7), None);
        assert_eq!(parse_signalable_pid("-1", 7), None);
        assert_eq!(parse_signalable_pid("7", 7), None);
        assert_eq!(parse_signalable_pid("not-a-pid", 7), None);
        assert_eq!(parse_signalable_pid("4294967295", 7), None);
    }

    #[test]
    fn only_the_tool_binary_started_before_the_record_matches() {
        let expected = Path::new("/opt/ryu/bin/shadow");
        let recorded_at = Some(1_000);
        let tool = ObservedProcess {
            exe: Some(expected.to_path_buf()),
            start_time: 999,
        };
        assert!(is_recorded_tool(&tool, expected, recorded_at));

        // A reused PID: some other program.
        let editor = ObservedProcess {
            exe: Some(PathBuf::from("/usr/bin/vim")),
            ..tool.clone()
        };
        assert!(!is_recorded_tool(&editor, expected, recorded_at));

        // The OS will not name the executable (another user's process).
        let unknown = ObservedProcess {
            exe: None,
            ..tool.clone()
        };
        assert!(!is_recorded_tool(&unknown, expected, recorded_at));

        // Same binary, but started well after the PID file was written.
        let later = ObservedProcess {
            start_time: 2_000,
            ..tool.clone()
        };
        assert!(!is_recorded_tool(&later, expected, recorded_at));
    }

    #[test]
    fn a_replaced_binary_is_still_the_tool() {
        let expected = Path::new("/opt/ryu/bin/ghost");
        let replaced = ObservedProcess {
            exe: Some(PathBuf::from("/opt/ryu/bin/ghost (deleted)")),
            start_time: now_secs(),
        };
        assert!(is_recorded_tool(&replaced, expected, None));
    }

    #[tokio::test]
    async fn reap_removes_a_stale_record_without_signalling_a_stranger() {
        let dir = std::env::temp_dir().join(format!("ryu-orphan-test-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let pid_file = dir.join("tool.pid");
        // Core's own PID is never signalled, whatever the record says.
        tokio::fs::write(&pid_file, std::process::id().to_string())
            .await
            .unwrap();
        reap(&pid_file, Path::new("/nonexistent/tool"), "tool").await;
        assert!(!pid_file.exists(), "a stale PID file is always removed");
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reap_leaves_a_process_that_reused_the_pid_running() {
        let Ok(mut stranger) = std::process::Command::new("sleep").arg("30").spawn() else {
            return;
        };
        let dir = std::env::temp_dir().join(format!("ryu-orphan-reuse-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let pid_file = dir.join("tool.pid");
        tokio::fs::write(&pid_file, stranger.id().to_string())
            .await
            .unwrap();
        reap(&pid_file, Path::new("/nonexistent/tool"), "tool").await;
        assert!(
            stranger.try_wait().unwrap().is_none(),
            "a process that is not the tool binary must not be signalled"
        );
        assert!(!pid_file.exists());
        let _ = stranger.kill();
        let _ = stranger.wait();
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
