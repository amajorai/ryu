//! Apptainer / Singularity backend implementing the Core [`Sandbox`] trait.
//!
//! Runs workloads in an Apptainer (formerly Singularity) container through the
//! host's `apptainer` or `singularity` CLI. Like the Docker backend there is no
//! SDK: the backend shells out, never installs anything, and is available only
//! when one of the two binaries is on `PATH` (or named by
//! `RYU_SANDBOX_SINGULARITY_BINARY`). Apptainer is preferred when both exist.
//!
//! ## Capability model
//!
//! Every invocation is contained (no host home, no host environment, no host
//! `/tmp`), and [`SandboxCapabilities`] maps to Apptainer flags on `exec` and
//! `instance start`:
//!
//! - always: `--containall` (private PID/IPC namespaces, clean environment,
//!   temporary `$HOME` and `/tmp`) and `--no-privs` (drops capabilities when
//!   the launcher runs as root);
//! - always: `--no-mount hostfs,bind-paths,cwd` (no admin-configured
//!   `bind path` / `mount hostfs` entries and no automatic bind of the
//!   launcher's working directory, which `--containall` alone does not stop);
//! - `network = false` (default) → `--net --network none` (loopback only);
//! - `network = true`            → no network flags (host network, like
//!   Docker's default bridge is the broad grant);
//! - effective mounts            → `--bind <host>:<host>:ro|rw`, mounted at the
//!   same path inside the container, exactly like the Docker backend's `-v`.
//!
//! Host paths containing `:` or `,` cannot be expressed in Apptainer's bind
//! syntax and are rejected instead of being silently mangled.
//!
//! The launcher itself starts from a cleared environment that keeps only
//! [`LAUNCHER_ENV_ALLOWLIST`] (`PATH`, `HOME`, locale, temp/runtime dirs and
//! the session bus, Apptainer's own cache/config/tmp locations, and the host's
//! proxy/CA settings for image pulls). Core's provider keys and `RYU_*`
//! tokens never reach the CLI, `APPTAINERENV_*` cannot inject variables into
//! the container, and bind-path variables (`APPTAINER_BIND`,
//! `SINGULARITY_BIND`, …) cannot add host mounts, so the capability set is the
//! only source of host mounts.
//!
//! ## Ephemeral exec
//!
//! `exec` → `apptainer exec [flags] <image> <command> [args]`
//!
//! ## Long-lived workspace
//!
//! `create_workspace`  → `apptainer instance start [flags] <image> <name>`
//! `exec_in_workspace` → `apptainer exec --cleanenv --no-privs instance://<name> <command> [args]`
//! `destroy_workspace` → `apptainer instance stop <name>`
//!
//! The instance owns the namespaces and binds chosen at creation time, so later
//! execs inherit them (they cannot widen them). Apptainer resolves the
//! environment and privilege drop per joining process, not per instance, so
//! every workspace exec repeats `--cleanenv` (the environment half of
//! `--containall`, which is not valid on a join) and `--no-privs`. Scratch
//! writes under `/tmp` and `$HOME` persist for the life of the instance.
//!
//! ## Config
//!
//! | Env var                               | Default                  | Meaning                         |
//! |---------------------------------------|--------------------------|---------------------------------|
//! | `RYU_SANDBOX_SINGULARITY_BINARY`      | `apptainer`/`singularity`| CLI to invoke                   |
//! | `RYU_SANDBOX_SINGULARITY_IMAGE`       | `docker://alpine:3.20`   | Image (SIF path or URI)         |
//! | `RYU_SANDBOX_SINGULARITY_DETECT_SECS` | `3`                      | Probe timeout (seconds)         |
//!
//! A missing CLI is an explicit error; this backend never falls back to host
//! execution or to another backend.

use std::path::Path;
use std::time::Duration;

use anyhow::{anyhow, Result};
use tokio::process::Command;
use tokio::time::timeout;

use super::{ExecOutput, ExecSpec, Sandbox, SandboxCapabilities, WorkspaceId};
use crate::capture::BoundedCommand;
use crate::win_process::NoWindow;
use crate::BoxFuture;

/// Name / path of the CLI to invoke. Unset → `apptainer`, then `singularity`.
pub const ENV_SINGULARITY_BINARY: &str = "RYU_SANDBOX_SINGULARITY_BINARY";
/// Image to run: a local `.sif` path or any URI the CLI accepts.
pub const ENV_SINGULARITY_IMAGE: &str = "RYU_SANDBOX_SINGULARITY_IMAGE";
/// Detection probe timeout in seconds.
pub const ENV_SINGULARITY_DETECT_SECS: &str = "RYU_SANDBOX_SINGULARITY_DETECT_SECS";

/// CLI names probed on `PATH`, in preference order.
const CANDIDATE_BINARIES: &[&str] = &["apptainer", "singularity"];
/// Default image; mirrors the Docker backend's minimal `/bin/sh` image.
const DEFAULT_IMAGE: &str = "docker://alpine:3.20";
const DEFAULT_DETECT_SECS: u64 = 3;
/// Prefix of every instance this backend starts. Workspace ids are validated
/// against it so `destroy_workspace` can never stop a foreign instance.
const INSTANCE_PREFIX: &str = "ryu-ws-";
/// Host variables the launcher keeps; everything else is cleared. `PATH` must
/// stay so the CLI and its helpers resolve; `HOME` and the cache/tmp/config
/// variables keep image caches and registry logins where the operator put
/// them; `XDG_RUNTIME_DIR` and the session bus let a rootless `instance start`
/// reach systemd for its cgroup; the proxy and CA variables let a `docker://`
/// image pull work on a proxied host. None of them reach the container
/// (`--containall`/`--cleanenv`), and nothing here can add binds (`*_BIND`) or
/// inject container variables (`APPTAINERENV_*`).
const LAUNCHER_ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "HOME",
    "LANG",
    "TMPDIR",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "APPTAINER_CACHEDIR",
    "APPTAINER_CONFIGDIR",
    "APPTAINER_TMPDIR",
    "SINGULARITY_CACHEDIR",
    "SINGULARITY_CONFIGDIR",
    "SINGULARITY_TMPDIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
];

// ── Configuration ────────────────────────────────────────────────────────────

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn image() -> String {
    non_empty_env(ENV_SINGULARITY_IMAGE).unwrap_or_else(|| DEFAULT_IMAGE.to_owned())
}

fn detect_timeout() -> Duration {
    let secs = non_empty_env(ENV_SINGULARITY_DETECT_SECS)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_DETECT_SECS);
    Duration::from_secs(secs)
}

fn on_path(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| {
        let candidate = dir.join(name);
        candidate.is_file() || (cfg!(windows) && candidate.with_extension("exe").is_file())
    })
}

/// Pick the CLI: an explicit override wins, otherwise the first candidate for
/// which `exists` holds. Pure so the selection and its error are unit-testable.
fn resolve_binary(
    override_binary: Option<String>,
    exists: impl Fn(&str) -> bool,
) -> Result<String> {
    if let Some(binary) = override_binary {
        return Ok(binary);
    }
    CANDIDATE_BINARIES
        .iter()
        .find(|name| exists(name))
        .map(|name| (*name).to_owned())
        .ok_or_else(|| {
            anyhow!(
                "sandbox backend 'singularity' is unavailable: neither `apptainer` nor \
                 `singularity` was found on PATH. Install Apptainer (https://apptainer.org) or \
                 set {ENV_SINGULARITY_BINARY} to the CLI path"
            )
        })
}

fn binary() -> Result<String> {
    resolve_binary(non_empty_env(ENV_SINGULARITY_BINARY), on_path)
}

// ── Detection ────────────────────────────────────────────────────────────────

/// Result of the Apptainer/Singularity probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetectResult {
    /// The CLI answered `--version`; the backend is usable.
    Available,
    /// The CLI is missing, timed out, or failed.
    Unavailable(String),
}

/// Probe for a working `apptainer`/`singularity` CLI. Detection-only: no image
/// is pulled and nothing is installed.
pub async fn detect() -> DetectResult {
    if !cfg!(target_os = "linux") {
        return DetectResult::Unavailable(
            "Apptainer/Singularity runs only on Linux hosts".to_owned(),
        );
    }
    let binary = match binary() {
        Ok(binary) => binary,
        Err(error) => return DetectResult::Unavailable(error.to_string()),
    };
    let deadline = detect_timeout();
    let probe = timeout(
        deadline,
        // Same cleared environment as real runs, so detection reflects them.
        launcher(&binary, &["--version".to_owned()])
            .kill_on_drop(true)
            .no_window()
            .bounded_output(),
    )
    .await;
    match probe {
        Err(_) => DetectResult::Unavailable(format!(
            "{binary} --version timed out after {}s",
            deadline.as_secs()
        )),
        Ok(Err(error)) => DetectResult::Unavailable(format!("{binary} is not executable: {error}")),
        Ok(Ok(output)) if output.status.success() => DetectResult::Available,
        Ok(Ok(output)) => DetectResult::Unavailable(format!(
            "{binary} --version failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )),
    }
}

// ── Command construction ─────────────────────────────────────────────────────

/// Automatic mounts disabled for every invocation (`--no-mount`, Apptainer ≥ 1.0).
const NO_MOUNT: &str = "hostfs,bind-paths,cwd";

/// Translate capabilities into Apptainer isolation flags. See the module docs.
fn caps_to_flags(caps: &SandboxCapabilities) -> Result<Vec<String>> {
    let mut flags = vec![
        "--containall".to_owned(),
        "--no-privs".to_owned(),
        // `--containall` still lets Apptainer bind the current working directory
        // and admin-configured `bind path`/hostfs entries; only the
        // capability-approved `--bind`s below may reach the host filesystem.
        "--no-mount".to_owned(),
        NO_MOUNT.to_owned(),
    ];
    if !caps.network {
        flags.extend(["--net", "--network", "none"].map(str::to_owned));
    }
    let mut mounts = caps.effective_mounts();
    // Stable order keeps the argv deterministic (the mount set is a HashMap).
    mounts.sort();
    for (path, writable) in mounts {
        flags.push("--bind".to_owned());
        flags.push(bind_spec(&path, writable)?);
    }
    Ok(flags)
}

fn bind_spec(path: &Path, writable: bool) -> Result<String> {
    let host = path
        .to_str()
        .ok_or_else(|| anyhow!("bind path {} is not valid UTF-8", path.display()))?;
    // Apptainer runs on POSIX hosts, so a bind source is absolute when it
    // starts with `/`, whatever path rules the build platform uses.
    if !host.starts_with('/') {
        return Err(anyhow!("bind path '{host}' must be absolute"));
    }
    if host.contains([':', ',']) {
        return Err(anyhow!(
            "bind path '{host}' contains ':' or ',' which Apptainer bind syntax cannot express"
        ));
    }
    let mode = if writable { "rw" } else { "ro" };
    Ok(format!("{host}:{host}:{mode}"))
}

/// Argv (after the binary) for a one-shot `exec`.
fn exec_argv(caps: &SandboxCapabilities, image: &str, spec: &ExecSpec) -> Result<Vec<String>> {
    let mut argv = vec!["exec".to_owned()];
    argv.extend(caps_to_flags(caps)?);
    argv.push(image.to_owned());
    argv.push(spec.command.clone());
    argv.extend(spec.args.iter().cloned());
    Ok(argv)
}

/// Argv (after the binary) to start a workspace instance.
fn instance_start_argv(caps: &SandboxCapabilities, image: &str, name: &str) -> Result<Vec<String>> {
    let mut argv = vec!["instance".to_owned(), "start".to_owned()];
    argv.extend(caps_to_flags(caps)?);
    argv.push(image.to_owned());
    argv.push(name.to_owned());
    Ok(argv)
}

/// Argv (after the binary) to run a command inside a workspace instance.
///
/// Joining an instance inherits its namespaces and mounts, but Apptainer builds
/// the environment and drops privileges per invocation, so both are repeated
/// here. `--containall` itself is not valid on a join; `--cleanenv` is its
/// environment half.
fn instance_exec_argv(name: &str, spec: &ExecSpec) -> Vec<String> {
    let mut argv = vec![
        "exec".to_owned(),
        "--cleanenv".to_owned(),
        "--no-privs".to_owned(),
        format!("instance://{name}"),
    ];
    argv.push(spec.command.clone());
    argv.extend(spec.args.iter().cloned());
    argv
}

/// Validate a workspace id as an instance this backend started.
fn instance_name(id: &WorkspaceId) -> Result<&str> {
    let name = id.0.as_str();
    let valid = name
        .strip_prefix(INSTANCE_PREFIX)
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_hexdigit()));
    if valid {
        Ok(name)
    } else {
        Err(anyhow!("'{name}' is not a singularity sandbox workspace"))
    }
}

/// The launcher's environment: only the allowlisted host variables that are
/// set. Pure over `lookup` so the filtering is unit-testable.
fn launcher_env(
    lookup: impl Fn(&'static str) -> Option<std::ffi::OsString>,
) -> Vec<(&'static str, std::ffi::OsString)> {
    LAUNCHER_ENV_ALLOWLIST
        .iter()
        .filter_map(|key| lookup(key).map(|value| (*key, value)))
        .collect()
}

fn launcher(binary: &str, argv: &[String]) -> Command {
    let mut cmd = Command::new(binary);
    cmd.args(argv)
        .env_clear()
        .envs(launcher_env(std::env::var_os));
    cmd
}

async fn stop_instance(binary: &str, name: &str) -> Result<()> {
    let output = timeout(
        Duration::from_secs(30),
        launcher(
            binary,
            &["instance".to_owned(), "stop".to_owned(), name.to_owned()],
        )
        .kill_on_drop(true)
        .no_window()
        .bounded_output(),
    )
    .await
    .map_err(|_| anyhow!("{binary} instance stop timed out"))?
    .map_err(|error| anyhow!("{binary} instance stop failed: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(anyhow!(
            "{binary} instance stop {name} failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

// ── SingularitySandbox ───────────────────────────────────────────────────────

/// Apptainer/Singularity backend: detect-only, CLI-driven.
#[derive(Debug, Clone, Default)]
pub struct SingularitySandbox;

impl SingularitySandbox {
    /// Construct without I/O.
    pub fn new() -> Self {
        Self
    }
}

impl Sandbox for SingularitySandbox {
    fn name(&self) -> &'static str {
        "singularity"
    }

    fn exec(&self, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>> {
        Box::pin(async move {
            let binary = binary()?;
            let argv = exec_argv(&spec.capabilities, &image(), &spec)?;
            let cmd = launcher(&binary, &argv);
            crate::local::run_captured(cmd, spec.stdin, spec.timeout_secs, "singularity").await
        })
    }

    fn create_workspace(
        &self,
        capabilities: SandboxCapabilities,
    ) -> BoxFuture<Result<WorkspaceId>> {
        Box::pin(async move {
            let binary = binary()?;
            let name = format!("{INSTANCE_PREFIX}{}", uuid::Uuid::new_v4().simple());
            let argv = instance_start_argv(&capabilities, &image(), &name)?;
            let started = timeout(
                Duration::from_secs(120),
                launcher(&binary, &argv)
                    .kill_on_drop(true)
                    .no_window()
                    .bounded_output(),
            )
            .await;
            let output = match started {
                Ok(Ok(output)) => output,
                Ok(Err(error)) => {
                    return Err(anyhow!("{binary} instance start failed: {error}"));
                }
                Err(_) => {
                    // The launcher was killed mid-start; stop whatever it left.
                    let _ = stop_instance(&binary, &name).await;
                    return Err(anyhow!("{binary} instance start timed out"));
                }
            };
            if !output.status.success() {
                return Err(anyhow!(
                    "{binary} instance start failed (exit {}): {}",
                    output.status.code().unwrap_or(-1),
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
            Ok(WorkspaceId(name))
        })
    }

    fn exec_in_workspace(&self, id: &WorkspaceId, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>> {
        let id = id.clone();
        Box::pin(async move {
            let name = instance_name(&id)?.to_owned();
            let binary = binary()?;
            let cmd = launcher(&binary, &instance_exec_argv(&name, &spec));
            let result =
                crate::local::run_captured(cmd, spec.stdin, spec.timeout_secs, "singularity").await;
            if result.is_err() {
                // Same contract as Docker: a failed/timed-out workspace exec
                // tears the workspace down so it must be recreated.
                stop_instance(&binary, &name).await?;
            }
            result
        })
    }

    fn destroy_workspace(&self, id: &WorkspaceId) -> BoxFuture<Result<()>> {
        let id = id.clone();
        Box::pin(async move {
            let name = instance_name(&id)?.to_owned();
            stop_instance(&binary()?, &name).await
        })
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests;
