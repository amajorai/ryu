//! OS sleep inhibition for active ACP work.
//!
//! The frontend decides when the feature should be active (the persisted Gateway
//! preference must be on and Core must report an active ACP agent). This module
//! only owns the native assertion and keeps it scoped to the desktop process.

use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::process::{Child, Command, Stdio};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::time::Duration;

#[derive(Default)]
pub struct KeepAwakeState {
    inner: Mutex<KeepAwakeInner>,
}

#[derive(Default)]
struct KeepAwakeInner {
    enabled: bool,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    child: Option<Child>,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl Drop for KeepAwakeInner {
    fn drop(&mut self) {
        // `std::process::Child` does not terminate on drop. Without explicit
        // cleanup, quitting Ryu leaves caffeinate/systemd-inhibit alive and the
        // machine can remain awake indefinitely.
        let _ = stop_child(self);
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepAwakeStatus {
    enabled: bool,
    supported: bool,
    backend: &'static str,
}

fn backend() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        return "caffeinate";
    }
    #[cfg(target_os = "linux")]
    {
        return "systemd-inhibit";
    }
    #[cfg(target_os = "windows")]
    {
        return "SetThreadExecutionState";
    }
    #[allow(unreachable_code)]
    "unsupported"
}

fn supported() -> bool {
    cfg!(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "windows"
    ))
}

fn status(inner: &KeepAwakeInner) -> KeepAwakeStatus {
    KeepAwakeStatus {
        enabled: inner.enabled,
        supported: supported(),
        backend: backend(),
    }
}

#[cfg(target_os = "windows")]
const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
#[cfg(target_os = "windows")]
const ES_CONTINUOUS: u32 = 0x8000_0000;

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
extern "system" {
    fn SetThreadExecutionState(execution_state: u32) -> u32;
}

/// Apply the native assertion. It is deliberately idempotent because the React
/// runtime polls ACP status and may send the same state more than once.
#[tauri::command]
pub fn set_keep_awake(
    state: State<'_, KeepAwakeState>,
    enabled: bool,
) -> Result<KeepAwakeStatus, String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "keep-awake state is unavailable".to_owned())?;

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    if inner.enabled {
        let exited = inner
            .child
            .as_mut()
            .map(|child| {
                child
                    .try_wait()
                    .map(|status| status.is_some())
                    .map_err(|error| format!("could not inspect sleep inhibition: {error}"))
            })
            .transpose()?
            .unwrap_or(false);
        if exited {
            inner.child = None;
            inner.enabled = false;
        }
    }

    if !supported() {
        inner.enabled = false;
        return Ok(status(&inner));
    }

    #[cfg(target_os = "macos")]
    {
        if enabled && !inner.enabled {
            let mut command = Command::new("/usr/bin/caffeinate");
            command
                .arg("-i")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            configure_process_group(&mut command);
            let child = command
                .spawn()
                .map_err(|error| format!("could not start caffeinate: {error}"))?;
            inner.child = Some(child);
        } else if !enabled {
            stop_child(&mut inner)?;
        }
        inner.enabled = enabled;
    }

    #[cfg(target_os = "linux")]
    {
        if enabled && !inner.enabled {
            let mut command = Command::new("systemd-inhibit");
            command
                .args([
                    "--what=idle:sleep",
                    "--who=Ryu",
                    "--why=ACP agents are active",
                    "--mode=block",
                    "sh",
                    "-c",
                    "while :; do sleep 3600; done",
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            configure_process_group(&mut command);
            let child = match command.spawn() {
                Ok(child) => child,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    inner.enabled = false;
                    return Ok(status(&inner));
                }
                Err(error) => {
                    return Err(format!("could not start systemd-inhibit: {error}"));
                }
            };
            inner.child = Some(child);
        } else if !enabled {
            stop_child(&mut inner)?;
        }
        inner.enabled = enabled;
    }

    #[cfg(target_os = "windows")]
    {
        let flags = if enabled {
            ES_CONTINUOUS | ES_SYSTEM_REQUIRED
        } else {
            ES_CONTINUOUS
        };
        // SAFETY: SetThreadExecutionState is a process-local Windows power API;
        // the flags are fixed constants and no pointers cross the FFI boundary.
        let result = unsafe { SetThreadExecutionState(flags) };
        if result == 0 {
            return Err("Windows rejected the sleep-inhibition request".to_owned());
        }
        inner.enabled = enabled;
    }

    Ok(status(&inner))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn stop_child(inner: &mut KeepAwakeInner) -> Result<(), String> {
    if let Some(mut child) = inner.child.take() {
        let raw_pid = child.id() as i32;
        if raw_pid > 0 {
            use nix::sys::signal::{kill, Signal};
            use nix::unistd::Pid;

            // The inhibitor and any helper command it spawned share a dedicated
            // process group. Signal the group, not only its leader.
            let group = Pid::from_raw(-raw_pid);
            let _ = kill(group, Signal::SIGTERM);
            let deadline = std::time::Instant::now() + Duration::from_millis(500);
            while std::time::Instant::now() < deadline {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                    Err(error) => {
                        return Err(format!("could not inspect sleep inhibition: {error}"));
                    }
                }
            }
            // TERM gives the helper a clean exit; KILL is a final group sweep for
            // a wedged child or a command left behind by systemd-inhibit.
            let _ = kill(group, Signal::SIGKILL);
        }
        let _ = child.wait();
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn dropping_keep_awake_state_terminates_the_inhibitor_group() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "sleep 30 & wait"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_process_group(&mut command);
        let child = command.spawn().expect("spawn inhibitor stand-in");
        let process_group = child.id() as i32;
        let inner = KeepAwakeInner {
            enabled: true,
            child: Some(child),
        };

        drop(inner);

        use nix::sys::signal::kill;
        use nix::unistd::Pid;
        // The killed grandchild is reparented to PID 1 and stays a zombie group
        // member until that reaper collects it, so allow a short reap window.
        let group = Pid::from_raw(-process_group);
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while kill(group, None).is_ok() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            kill(group, None).is_err(),
            "the inhibitor process group survived state drop"
        );
    }
}
