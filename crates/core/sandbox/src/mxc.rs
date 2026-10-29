//! MXC backend implementing the Core [`Sandbox`] trait.
//!
//! Runs commands inside a Microsoft eXecution Container (MXC,
//! `microsoft/mxc`, MIT) through its `wxc-exec` executor. MXC's default
//! Windows containment is `processcontainer`: an AppContainer/BaseContainer
//! process boundary chosen at runtime, with filesystem and network policy
//! applied per run. It needs no sandbox user accounts, no administrator setup,
//! and no host firewall rules, which is why it is the native Windows option
//! (the same engine Codex uses for its Windows sandbox).
//!
//! Like [`super::docker`] and [`super::microsandbox`], this shells out to a CLI
//! that must already be installed — **no compile-time dependency** on the MXC
//! SDK and **no install/bundle path**. [`detect`] runs a request-aware
//! `wxc-exec --probe --config <request>` with a representative request (a
//! read-write working directory under the system temp dir and this node's real
//! `allowDaclMutation` value), so the tier it reports is the one a real run
//! would get rather than the one MXC's default request would get.
//!
//! ## Isolation posture
//!
//! Ryu treats `mxc` as OS-level process isolation for everyday agent commands,
//! not a VM or container boundary. The descriptor therefore reports "OS process
//! container" rather than a VM or OCI boundary; callers that need the strongest
//! isolation should still pick `docker`, `microsandbox`, or `opensandbox`.
//!
//! ## Capability mapping (MXC config schema `1.0.0`, one-shot request)
//!
//! - every exec gets a fresh working directory (or the workspace directory),
//!   granted read-write and used as `cwd`, `HOME`, and `TEMP`;
//! - [`SandboxCapabilities::effective_mounts`] → `filesystem.readonlyPaths` /
//!   `filesystem.readwritePaths` (the shared [`crate::WorkspaceAccess`] clamp
//!   applies);
//! - `network = false` → egress `deny`, ingress and host loopback `deny`;
//!   `network = true` → egress `allow` (ingress stays denied);
//! - visible UI, input injection, and clipboard are disabled;
//! - `fallback.allowDaclMutation` is `false` unless the operator opts in, so
//!   MXC never edits host ACLs silently. On hosts whose only available tier
//!   needs DACL edits, [`detect`] reports MXC unavailable and names the opt-in.
//!
//! ## Executor failures
//!
//! A guest that exits non-zero is returned as an [`ExecOutput`]. MXC's own
//! failures are returned as errors: the JSON envelope it writes after a runner
//! ran (see `executor_error`), and the plain-text refusals it prints before
//! any runner starts (see `pre_runner_failure`). Because a guest can print the
//! same `error: ` prefix, a plain-text refusal only counts once a request-aware
//! probe of the same request confirms MXC cannot run it.
//!
//! The environment is explicit (no host variables beyond `PATH` and the few
//! Windows needs to start a process), so Core's own secrets never reach the
//! child.
//!
//! ## Workspaces
//!
//! A workspace is a persistent host directory. Each `exec_in_workspace` runs a
//! fresh container with that directory mounted read-write plus the exec's own
//! capabilities; the container itself is not long-lived.
//!
//! ## Platform reality
//!
//! Only the Windows `processcontainer` backend is wired. MXC's Linux/macOS
//! executors exist upstream but are not used here, so [`detect`] reports
//! unavailable on every non-Windows host. Process isolation requires a
//! Windows 11 build that MXC lists as supported; `--probe` is the authority.
//!
//! ## Config
//!
//! | Env var                                   | Default     | Meaning                                  |
//! |-------------------------------------------|-------------|------------------------------------------|
//! | `RYU_SANDBOX_MXC_BINARY`                  | `wxc-exec`  | Path / name of the MXC Windows executor  |
//! | `RYU_SANDBOX_MXC_DETECT_SECS`             | `5`         | Detection probe timeout (s)              |
//! | `RYU_SANDBOX_MXC_ALLOW_DACL_MUTATION`     | unset       | `1` lets MXC use its host-ACL fallback   |

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use tokio::process::Command;
use tokio::time::timeout;

use super::{ExecOutput, ExecSpec, Sandbox, SandboxCapabilities, WorkspaceId};
use crate::capture::BoundedCommand;
use crate::process_output::{execution_timeout, output_capped, MAX_TIMEOUT_SECS};
use crate::win_process::NoWindow;
use crate::BoxFuture;

// ── Configuration knobs ──────────────────────────────────────────────────────

/// Name / path of the MXC Windows executor. Defaults to `wxc-exec` (PATH).
pub const ENV_BINARY: &str = "RYU_SANDBOX_MXC_BINARY";
/// Detection probe timeout in seconds.
pub const ENV_DETECT_SECS: &str = "RYU_SANDBOX_MXC_DETECT_SECS";
/// Operator consent for MXC's host-DACL fallback tier.
pub const ENV_ALLOW_DACL_MUTATION: &str = "RYU_SANDBOX_MXC_ALLOW_DACL_MUTATION";

const DEFAULT_BINARY: &str = "wxc-exec";
const DEFAULT_DETECT_SECS: u64 = 5;
/// Host commands default to 120 seconds, matching `local` and `ssh`.
const DEFAULT_TIMEOUT_SECS: u64 = 120;
/// Head start the outer kill gives MXC's own timeout, so MXC tears the
/// container down itself before Core kills the executor.
const TIMEOUT_GRACE_SECS: u64 = 5;
/// The exact published MXC config contract this backend emits.
const CONFIG_VERSION: &str = "1.0.0";
/// Prefix of every working directory this backend creates. Workspace ids are
/// validated against it so `destroy_workspace` can never delete anything else.
const WORKDIR_PREFIX: &str = "ryu-sandbox-mxc-";

fn binary() -> String {
    std::env::var(ENV_BINARY)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_BINARY.to_owned())
}

fn detect_timeout() -> Duration {
    let secs = std::env::var(ENV_DETECT_SECS)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_DETECT_SECS);
    Duration::from_secs(secs)
}

fn opt_in_value_enabled(value: Option<&str>) -> bool {
    matches!(
        value.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

fn dacl_mutation_allowed() -> bool {
    opt_in_value_enabled(std::env::var(ENV_ALLOW_DACL_MUTATION).ok().as_deref())
}

// ── Detection ────────────────────────────────────────────────────────────────

/// Result of the MXC availability probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetectResult {
    /// `wxc-exec --probe` selected a process-isolation tier this node may use.
    Available,
    /// Non-Windows host, binary missing, unsupported OS build, or a tier that
    /// needs a host-ACL fallback the operator has not allowed.
    Unavailable(String),
}

/// Interpret the JSON `wxc-exec --probe` prints. Pure so it is testable on
/// every host.
fn interpret_probe(stdout: &str, allow_dacl_mutation: bool) -> DetectResult {
    let probe: Value = match serde_json::from_str(stdout.trim()) {
        Ok(value) => value,
        Err(error) => {
            return DetectResult::Unavailable(format!("unreadable wxc-exec probe output: {error}"))
        }
    };
    if let Some(error) = probe.get("error").and_then(Value::as_str) {
        // A request-aware probe that carries `allowDaclMutation: false` reports
        // a DACL-only host as an error rather than a tier; name the opt-in.
        if !allow_dacl_mutation && error.contains("allowDaclMutation") {
            return DetectResult::Unavailable(format!(
                "MXC process isolation unavailable: {error}; set \
                 {ENV_ALLOW_DACL_MUTATION}=1 to allow host ACL edits"
            ));
        }
        return DetectResult::Unavailable(format!("MXC process isolation unavailable: {error}"));
    }
    let Some(tier) = probe.get("tier").and_then(Value::as_str) else {
        return DetectResult::Unavailable("wxc-exec probe selected no isolation tier".to_owned());
    };
    let needs_dacl = probe
        .get("needsDaclAugmentation")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if needs_dacl && !allow_dacl_mutation {
        return DetectResult::Unavailable(format!(
            "MXC tier '{tier}' needs host ACL edits on this node; set \
             {ENV_ALLOW_DACL_MUTATION}=1 to allow them"
        ));
    }
    DetectResult::Available
}

/// Probe whether MXC process isolation is usable on this host. Detection-only:
/// runs a request-aware `wxc-exec --probe` with a short timeout and never
/// installs anything.
pub async fn detect() -> DetectResult {
    if !cfg!(windows) {
        return DetectResult::Unavailable(
            "the mxc backend uses MXC's Windows process container and runs on Windows only"
                .to_owned(),
        );
    }
    detect_with_binary(&binary(), detect_timeout(), dacl_mutation_allowed()).await
}

/// The request [`detect`] probes: the same shape every real run sends (a
/// read-write working directory and the node's `allowDaclMutation` value), so
/// MXC's tier choice matches the one exec will get. MXC's default request has
/// no filesystem policy and allows DACL edits, which can select a tier no real
/// run is allowed to use.
fn probe_request_document(allow_dacl_mutation: bool) -> Result<Value> {
    build_request(
        &ExecSpec::new("cmd.exe", vec![]),
        &std::env::temp_dir(),
        1000,
        allow_dacl_mutation,
    )
}

/// Write `request` to a request file outside any sandbox working directory.
fn write_request_file(request: &Value) -> Result<tempfile::NamedTempFile> {
    let mut config = tempfile::Builder::new()
        .prefix("ryu-mxc-request-")
        .suffix(".json")
        .tempfile()
        .context("create mxc request file")?;
    serde_json::to_writer(config.as_file_mut(), request).context("write mxc request")?;
    Ok(config)
}

async fn detect_with_binary(
    binary: &str,
    deadline: Duration,
    allow_dacl_mutation: bool,
) -> DetectResult {
    let config = match probe_request_document(allow_dacl_mutation)
        .and_then(|request| write_request_file(&request))
    {
        Ok(config) => config,
        Err(error) => {
            return DetectResult::Unavailable(format!(
                "could not write the MXC probe request: {error:#}"
            ))
        }
    };
    probe_request(binary, config.path(), deadline, allow_dacl_mutation).await
}

/// What one `wxc-exec --probe` run said about a request.
enum ProbeVerdict {
    /// The probe ran to completion and judged the request.
    Answered(DetectResult),
    /// The probe never judged the request: it timed out or could not start.
    NoAnswer(String),
}

/// Run `wxc-exec --probe --config <config>`. MXC decodes the request and
/// reports the tier it would choose for it without spawning a sandbox.
async fn probe_request(
    binary: &str,
    config: &Path,
    deadline: Duration,
    allow_dacl_mutation: bool,
) -> DetectResult {
    match probe_verdict(binary, config, deadline, allow_dacl_mutation).await {
        ProbeVerdict::Answered(result) => result,
        ProbeVerdict::NoAnswer(reason) => DetectResult::Unavailable(reason),
    }
}

async fn probe_verdict(
    binary: &str,
    config: &Path,
    deadline: Duration,
    allow_dacl_mutation: bool,
) -> ProbeVerdict {
    let probe = timeout(
        deadline,
        Command::new(binary)
            .arg("--probe")
            .arg("--config")
            .arg(config)
            .kill_on_drop(true)
            .no_window()
            .bounded_output(),
    )
    .await;
    match probe {
        Err(_elapsed) => ProbeVerdict::NoAnswer(format!(
            "wxc-exec probe timed out after {}s",
            deadline.as_secs()
        )),
        Ok(Err(io_err)) => {
            ProbeVerdict::NoAnswer(format!("wxc-exec not found or not executable: {io_err}"))
        }
        Ok(Ok(output)) if !output.status.success() => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            ProbeVerdict::Answered(DetectResult::Unavailable(format!(
                "wxc-exec probe failed: {}",
                stderr.trim()
            )))
        }
        Ok(Ok(output)) => ProbeVerdict::Answered(interpret_probe(
            &String::from_utf8_lossy(&output.stdout),
            allow_dacl_mutation,
        )),
    }
}

fn ensure_supported_host() -> Result<()> {
    if cfg!(windows) {
        Ok(())
    } else {
        Err(anyhow!(
            "sandbox backend 'mxc' uses MXC's Windows process container and runs on Windows only"
        ))
    }
}

// ── Request building ─────────────────────────────────────────────────────────

/// Quote one argument so `CommandLineToArgvW` / the MSVC CRT parse it back
/// verbatim (backslashes are literal except before a quote).
fn quote_windows_arg(arg: &str) -> String {
    let needs_quotes = arg.is_empty() || arg.contains([' ', '\t', '\n', '\u{b}', '"']);
    if !needs_quotes {
        return arg.to_owned();
    }
    let mut quoted = String::with_capacity(arg.len() + 2);
    quoted.push('"');
    let mut backslashes = 0usize;
    for ch in arg.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                quoted.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            other => {
                quoted.extend(std::iter::repeat_n('\\', backslashes));
                quoted.push(other);
                backslashes = 0;
            }
        }
    }
    quoted.extend(std::iter::repeat_n('\\', backslashes * 2));
    quoted.push('"');
    quoted
}

fn command_line(spec: &ExecSpec) -> Result<String> {
    if spec.command.trim().is_empty() {
        return Err(anyhow!("mxc exec requires a non-empty command"));
    }
    let mut parts = Vec::with_capacity(spec.args.len() + 1);
    parts.push(quote_windows_arg(&spec.command));
    parts.extend(spec.args.iter().map(|arg| quote_windows_arg(arg)));
    Ok(parts.join(" "))
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The child's explicit environment: no host variables leak beyond `PATH` and
/// what Windows needs to start a process; home/temp point at the workdir.
fn child_env(workdir: &Path) -> Vec<String> {
    let workdir = path_string(workdir);
    let mut env = Vec::new();
    for key in [
        "PATH",
        "SystemRoot",
        "SystemDrive",
        "ComSpec",
        "PATHEXT",
        "WINDIR",
    ] {
        if let Ok(value) = std::env::var(key) {
            env.push(format!("{key}={value}"));
        }
    }
    for key in ["HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR"] {
        env.push(format!("{key}={workdir}"));
    }
    env
}

/// Build the one-shot MXC `1.0.0` request for `spec` running in `workdir`.
fn build_request(
    spec: &ExecSpec,
    workdir: &Path,
    timeout_ms: u64,
    allow_dacl_mutation: bool,
) -> Result<Value> {
    let mut readonly = Vec::new();
    let mut readwrite = vec![path_string(workdir)];
    let mut mounts = spec.capabilities.effective_mounts();
    mounts.sort();
    for (path, writable) in mounts {
        if !path.is_absolute() {
            return Err(anyhow!(
                "mxc filesystem grants must be absolute paths: '{}'",
                path.display()
            ));
        }
        if writable {
            readwrite.push(path_string(&path));
        } else {
            readonly.push(path_string(&path));
        }
    }
    let egress = if spec.capabilities.network {
        "allow"
    } else {
        "deny"
    };
    Ok(json!({
        "version": CONFIG_VERSION,
        "containment": "processcontainer",
        "process": {
            "commandLine": command_line(spec)?,
            "cwd": path_string(workdir),
            "env": child_env(workdir),
            "timeout": timeout_ms,
        },
        "filesystem": {
            "readonlyPaths": readonly,
            "readwritePaths": readwrite,
        },
        "network": {
            "egress": { "default": egress },
            "ingress": { "default": "deny", "hostLoopback": "deny" },
        },
        "ui": { "disable": true, "injection": false, "clipboard": "none" },
        "lifecycle": { "destroyOnExit": true },
        "fallback": { "allowDaclMutation": allow_dacl_mutation },
    }))
}

/// MXC writes `{"error":{"code","message"}}` as a stderr line when a runner
/// started and reported an infrastructure failure (policy refused at run time,
/// sandbox launch failed). A guest that merely exits non-zero leaves no
/// envelope. Failures before a runner is chosen (an unreadable request, no
/// isolation tier this request may use) print plain text instead; see
/// [`pre_runner_failure`].
fn executor_error(stderr: &[u8]) -> Option<String> {
    String::from_utf8_lossy(stderr)
        .lines()
        .rev()
        .filter(|line| line.trim_start().starts_with('{'))
        .find_map(|line| {
            let value: Value = serde_json::from_str(line.trim()).ok()?;
            let error = value.get("error")?;
            let code = error.get("code").and_then(Value::as_str).unwrap_or("error");
            let message = error.get("message").and_then(Value::as_str)?;
            Some(format!("{code}: {message}"))
        })
}

/// Line prefixes `wxc-exec` prints, without a JSON envelope, when it refuses a
/// request before any runner starts: `error: ` (no usable isolation tier),
/// `Error: ` (missing or unloadable config), and `Request error` (the request
/// did not parse).
const PRE_RUNNER_PREFIXES: [&str; 3] = ["error: ", "Error: ", "Request error"];

/// The plain-text refusal line of a run that may have failed before its guest
/// started: nothing on stdout, and the first stderr line (after `wxc-exec`'s
/// own orphaned-ACL recovery report) starts with a [`PRE_RUNNER_PREFIXES`]
/// entry. A guest can print the same prefix, so this is only a candidate; the
/// caller confirms it with a probe of the same request.
fn pre_runner_failure(stdout: &[u8], stderr: &[u8]) -> Option<String> {
    if !stdout.iter().all(u8::is_ascii_whitespace) {
        return None;
    }
    let stderr = String::from_utf8_lossy(stderr);
    let line = stderr
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .find(|line| {
            !line.starts_with("DACL recovery") && !line.starts_with(char::is_whitespace)
        })?;
    PRE_RUNNER_PREFIXES
        .iter()
        .any(|prefix| line.starts_with(prefix))
        .then(|| line.to_owned())
}

// ── Execution ────────────────────────────────────────────────────────────────

/// Create a fresh working directory under the system temp dir.
fn create_workdir() -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("{WORKDIR_PREFIX}{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("create mxc sandbox dir {}", dir.display()))?;
    Ok(dir)
}

/// Resolve a workspace id back to a directory this backend created.
fn workspace_dir(id: &WorkspaceId) -> Result<PathBuf> {
    let dir = PathBuf::from(&id.0);
    let is_ours = dir.parent() == Some(std::env::temp_dir().as_path())
        && dir
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(WORKDIR_PREFIX));
    if !is_ours {
        return Err(anyhow!("'{}' is not an mxc sandbox workspace", id.0));
    }
    Ok(dir)
}

/// Run `spec` through `binary` with `workdir` as the container's writable cwd.
async fn run_in_dir(binary: &str, spec: ExecSpec, workdir: &Path) -> Result<ExecOutput> {
    let secs = execution_timeout(spec.timeout_secs, DEFAULT_TIMEOUT_SECS)?;
    let outer_secs = (secs + TIMEOUT_GRACE_SECS).min(MAX_TIMEOUT_SECS);
    let inner_ms = outer_secs.saturating_sub(TIMEOUT_GRACE_SECS).max(1) * 1000;
    let allow_dacl_mutation = dacl_mutation_allowed();
    let request = build_request(&spec, workdir, inner_ms, allow_dacl_mutation)?;

    // The request lives outside the workdir so the guest cannot read or edit it.
    let config = write_request_file(&request)?;

    let mut cmd = Command::new(binary);
    cmd.arg("--config").arg(config.path()).no_window();
    let output = output_capped(&mut cmd, spec.stdin, Some(outer_secs), "mxc").await?;

    let exit_code = output.status.code().unwrap_or(-1);
    if exit_code != 0 {
        if let Some(error) = executor_error(&output.stderr) {
            return Err(anyhow!("mxc executor failed: {error}"));
        }
        if let Some(line) = pre_runner_failure(&output.stdout, &output.stderr) {
            // Only a refusal MXC's own probe reproduces for this exact request is
            // an executor failure; otherwise the guest printed that line itself.
            // A probe that times out or cannot start confirms nothing.
            if let ProbeVerdict::Answered(DetectResult::Unavailable(reason)) =
                probe_verdict(binary, config.path(), detect_timeout(), allow_dacl_mutation).await
            {
                return Err(anyhow!("mxc executor failed: {line} ({reason})"));
            }
        }
    }
    drop(config);
    Ok(ExecOutput {
        exit_code,
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

async fn exec_ephemeral(binary: String, spec: ExecSpec) -> Result<ExecOutput> {
    let workdir = create_workdir()?;
    let result = run_in_dir(&binary, spec, &workdir).await;
    // Best-effort teardown; a failed cleanup must not mask the result.
    let _ = std::fs::remove_dir_all(&workdir);
    result
}

// ── MxcSandbox ───────────────────────────────────────────────────────────────

/// MXC backend: detect-only, CLI-driven, zero compile-time dependency.
#[derive(Debug, Clone, Default)]
pub struct MxcSandbox;

impl MxcSandbox {
    /// Construct the backend. Cheap: no I/O at construction time.
    pub fn new() -> Self {
        Self
    }
}

impl Sandbox for MxcSandbox {
    fn name(&self) -> &'static str {
        "mxc"
    }

    fn exec(&self, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>> {
        Box::pin(async move {
            ensure_supported_host()?;
            exec_ephemeral(binary(), spec).await
        })
    }

    fn create_workspace(
        &self,
        _capabilities: SandboxCapabilities,
    ) -> BoxFuture<Result<WorkspaceId>> {
        Box::pin(async move {
            ensure_supported_host()?;
            let dir = create_workdir()?;
            Ok(WorkspaceId(path_string(&dir)))
        })
    }

    fn exec_in_workspace(&self, id: &WorkspaceId, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>> {
        let id = id.clone();
        Box::pin(async move {
            ensure_supported_host()?;
            let dir = workspace_dir(&id)?;
            if !dir.is_dir() {
                return Err(anyhow!("mxc sandbox workspace '{}' does not exist", id.0));
            }
            run_in_dir(&binary(), spec, &dir).await
        })
    }

    fn destroy_workspace(&self, id: &WorkspaceId) -> BoxFuture<Result<()>> {
        let id = id.clone();
        Box::pin(async move {
            let dir = workspace_dir(&id)?;
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(anyhow!(
                    "remove mxc sandbox workspace {}: {e}",
                    dir.display()
                )),
            }
        })
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_name_is_mxc() {
        assert_eq!(MxcSandbox::new().name(), "mxc");
    }

    #[test]
    fn windows_quoting_round_trips_msvc_rules() {
        assert_eq!(quote_windows_arg("plain"), "plain");
        assert_eq!(quote_windows_arg(""), "\"\"");
        assert_eq!(quote_windows_arg("two words"), "\"two words\"");
        assert_eq!(quote_windows_arg(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote_windows_arg(r"C:\dir\"), r"C:\dir\");
        assert_eq!(quote_windows_arg(r"C:\my dir\"), r#""C:\my dir\\""#);
        assert_eq!(quote_windows_arg(r#"a\"b"#), r#""a\\\"b""#);
    }

    #[test]
    fn command_line_quotes_each_argument() {
        let spec = ExecSpec::new("python", vec!["-c".to_owned(), "print('a b')".to_owned()]);
        assert_eq!(command_line(&spec).unwrap(), "python -c \"print('a b')\"");
        assert!(command_line(&ExecSpec::new(" ", vec![])).is_err());
    }

    fn absolute(name: &str) -> PathBuf {
        std::env::temp_dir().join(name)
    }

    #[test]
    fn default_request_is_deny_all_with_only_the_workdir_writable() {
        let workdir = absolute("ryu-sandbox-mxc-test");
        let request =
            build_request(&ExecSpec::new("cmd", vec![]), &workdir, 30_000, false).unwrap();
        assert_eq!(request["version"], "1.0.0");
        assert_eq!(request["containment"], "processcontainer");
        assert_eq!(request["process"]["timeout"], 30_000);
        assert_eq!(request["process"]["cwd"], path_string(&workdir));
        assert_eq!(request["filesystem"]["readonlyPaths"], json!([]));
        assert_eq!(
            request["filesystem"]["readwritePaths"],
            json!([path_string(&workdir)])
        );
        assert_eq!(request["network"]["egress"]["default"], "deny");
        assert_eq!(request["network"]["ingress"]["hostLoopback"], "deny");
        assert_eq!(request["ui"]["disable"], true);
        assert_eq!(request["fallback"]["allowDaclMutation"], false);
    }

    #[test]
    fn request_env_never_carries_host_secrets() {
        // SAFETY: test-local variable no other test reads.
        unsafe { std::env::set_var("RYU_MXC_TEST_SECRET", "leak") };
        let workdir = absolute("ryu-sandbox-mxc-env");
        let request = build_request(&ExecSpec::new("cmd", vec![]), &workdir, 1000, false).unwrap();
        unsafe { std::env::remove_var("RYU_MXC_TEST_SECRET") };
        let env: Vec<String> = serde_json::from_value(request["process"]["env"].clone()).unwrap();
        assert!(env
            .iter()
            .all(|entry| !entry.contains("RYU_MXC_TEST_SECRET")));
        assert!(env.contains(&format!("TEMP={}", path_string(&workdir))));
    }

    #[test]
    fn capabilities_map_to_mxc_paths_and_network() {
        let read = absolute("ryu-mxc-read");
        let write = absolute("ryu-mxc-write");
        let mut spec = ExecSpec::new("cmd", vec![]);
        spec.capabilities.fs_read_paths.insert(read.clone());
        spec.capabilities.fs_write_paths.insert(write.clone());
        spec.capabilities.network = true;
        let workdir = absolute("ryu-sandbox-mxc-caps");
        let request = build_request(&spec, &workdir, 1000, true).unwrap();
        assert_eq!(
            request["filesystem"]["readonlyPaths"],
            json!([path_string(&read)])
        );
        assert_eq!(
            request["filesystem"]["readwritePaths"],
            json!([path_string(&workdir), path_string(&write)])
        );
        assert_eq!(request["network"]["egress"]["default"], "allow");
        assert_eq!(request["network"]["ingress"]["default"], "deny");
        assert_eq!(request["fallback"]["allowDaclMutation"], true);

        spec.capabilities.workspace_access = crate::WorkspaceAccess::ReadOnly;
        let clamped = build_request(&spec, &workdir, 1000, false).unwrap();
        assert_eq!(
            clamped["filesystem"]["readwritePaths"],
            json!([path_string(&workdir)])
        );
        assert_eq!(
            clamped["filesystem"]["readonlyPaths"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn relative_grants_are_rejected() {
        let mut spec = ExecSpec::new("cmd", vec![]);
        spec.capabilities
            .fs_read_paths
            .insert(PathBuf::from("relative/dir"));
        assert!(build_request(&spec, &absolute("ryu-sandbox-mxc-rel"), 1000, false).is_err());
    }

    #[test]
    fn probe_output_is_interpreted_fail_closed() {
        assert_eq!(
            interpret_probe(
                r#"{"tier":"base-container","needsDaclAugmentation":false,"warnings":[],"probes":{}}"#,
                false
            ),
            DetectResult::Available
        );
        let dacl = r#"{"tier":"appcontainer-dacl","needsDaclAugmentation":true,"warnings":[],"probes":{}}"#;
        match interpret_probe(dacl, false) {
            DetectResult::Unavailable(reason) => assert!(reason.contains(ENV_ALLOW_DACL_MUTATION)),
            DetectResult::Available => panic!("DACL tier must need the opt-in"),
        }
        assert_eq!(interpret_probe(dacl, true), DetectResult::Available);
        assert!(matches!(
            interpret_probe(
                r#"{"warnings":[],"probes":{},"error":"unsupported build"}"#,
                true
            ),
            DetectResult::Unavailable(_)
        ));
        assert!(matches!(
            interpret_probe("not json", true),
            DetectResult::Unavailable(_)
        ));
    }

    #[test]
    fn probe_error_requiring_dacl_names_the_opt_in() {
        let disabled = r#"{"warnings":[],"probes":{},"error":"DACL fallback required but fallback.allowDaclMutation is false"}"#;
        match interpret_probe(disabled, false) {
            DetectResult::Unavailable(reason) => {
                assert!(reason.contains(ENV_ALLOW_DACL_MUTATION), "{reason}")
            }
            DetectResult::Available => panic!("a probe error is never available"),
        }
        match interpret_probe(
            r#"{"warnings":[],"probes":{},"error":"unsupported build"}"#,
            false,
        ) {
            DetectResult::Unavailable(reason) => {
                assert!(!reason.contains(ENV_ALLOW_DACL_MUTATION), "{reason}")
            }
            DetectResult::Available => panic!("a probe error is never available"),
        }
    }

    #[test]
    fn probe_request_matches_the_shape_real_runs_send() {
        let request = probe_request_document(false).unwrap();
        assert_eq!(request["containment"], "processcontainer");
        assert_eq!(
            request["filesystem"]["readwritePaths"],
            json!([path_string(&std::env::temp_dir())])
        );
        assert_eq!(request["fallback"]["allowDaclMutation"], false);
        assert_eq!(
            probe_request_document(true).unwrap()["fallback"]["allowDaclMutation"],
            true
        );
    }

    #[test]
    fn pre_runner_refusals_are_candidates_only_without_guest_stdout() {
        assert_eq!(
            pre_runner_failure(b"", b"error: BaseContainer is unavailable\n").as_deref(),
            Some("error: BaseContainer is unavailable")
        );
        assert_eq!(
            pre_runner_failure(b"\n", b"Request error\nbad field\n").as_deref(),
            Some("Request error")
        );
        assert_eq!(
            pre_runner_failure(
                b"",
                b"DACL recovery: 1 file(s), 2 ACE(s) restored, 0 pruned (missing), 1 error(s)\n  stale\nError: failed to load probe config\n"
            )
            .as_deref(),
            Some("Error: failed to load probe config")
        );
        assert_eq!(
            pre_runner_failure(b"partial output", b"error: boom\n"),
            None
        );
        assert_eq!(
            pre_runner_failure(b"", b"Traceback (most recent call last):\n"),
            None
        );
        assert_eq!(pre_runner_failure(b"", b""), None);
    }

    #[test]
    fn executor_error_envelope_is_distinguished_from_guest_exit() {
        let stderr =
            b"guest noise\n{\"error\":{\"code\":\"policy_validation\",\"message\":\"bad path\"}}\n";
        assert_eq!(
            executor_error(stderr).as_deref(),
            Some("policy_validation: bad path")
        );
        assert_eq!(executor_error(b"plain failure\n"), None);
    }

    #[test]
    fn workspace_ids_outside_temp_prefix_are_rejected() {
        assert!(workspace_dir(&WorkspaceId("/".to_owned())).is_err());
        let foreign = std::env::temp_dir().join("ryu-sandbox-local-abc");
        assert!(workspace_dir(&WorkspaceId(path_string(&foreign))).is_err());
        let ours = std::env::temp_dir().join(format!("{WORKDIR_PREFIX}abc"));
        assert_eq!(
            workspace_dir(&WorkspaceId(path_string(&ours))).unwrap(),
            ours
        );
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn non_windows_hosts_report_unavailable_and_refuse_exec() {
        assert!(matches!(detect().await, DetectResult::Unavailable(_)));
        let error = MxcSandbox::new()
            .exec(ExecSpec::new("cmd", vec![]))
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("Windows only"), "{error}");
    }

    #[tokio::test]
    async fn missing_binary_is_unavailable() {
        let result = detect_with_binary(
            "/nonexistent-wxc-exec-ryu-test",
            Duration::from_secs(DEFAULT_DETECT_SECS),
            false,
        )
        .await;
        assert!(matches!(result, DetectResult::Unavailable(_)));
    }

    #[cfg(unix)]
    fn fake_wxc_exec(directory: &Path, script: &str) -> String {
        use std::os::unix::fs::PermissionsExt;

        let fake = directory.join("fake-wxc-exec");
        std::fs::write(&fake, script).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();
        path_string(&fake)
    }

    /// Detection hands the probe the request a real run sends, not MXC's
    /// default request (no filesystem policy, DACL edits allowed).
    #[cfg(unix)]
    #[tokio::test]
    async fn detect_probes_a_representative_request() {
        let directory = tempfile::tempdir().unwrap();
        let fake = fake_wxc_exec(
            directory.path(),
            concat!(
                "#!/bin/sh\n",
                "[ \"$1\" = --probe ] || exit 90\n",
                "[ \"$2\" = --config ] || exit 91\n",
                "grep -q '\"allowDaclMutation\":false' \"$3\" || exit 92\n",
                "grep -q '\"readwritePaths\":\\[\"' \"$3\" || exit 93\n",
                "echo '{\"tier\":\"base-container\",\"needsDaclAugmentation\":false,\"warnings\":[],\"probes\":{}}'\n",
            ),
        );
        let result = detect_with_binary(&fake, Duration::from_secs(10), false).await;
        assert_eq!(result, DetectResult::Available);
    }

    /// Drive the real exec path against a fake `wxc-exec` that echoes the
    /// request it was handed, so the wire shape and exit plumbing are covered
    /// on every CI host.
    #[cfg(unix)]
    #[tokio::test]
    async fn exec_passes_request_file_stdin_and_exit_code() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let fake = directory.path().join("fake-wxc-exec");
        std::fs::write(
            &fake,
            "#!/bin/sh\n[ \"$1\" = --config ] || exit 90\ncat \"$2\"\necho\ncat\necho guest-err >&2\nexit 4\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();

        let mut spec = ExecSpec::new("python", vec!["-V".to_owned()]);
        spec.stdin = Some(b"from-stdin".to_vec());
        spec.timeout_secs = Some(10);
        let output = exec_ephemeral(path_string(&fake), spec).await.unwrap();
        assert_eq!(output.exit_code, 4);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let (request, rest) = stdout.split_once('\n').unwrap();
        let request: Value = serde_json::from_str(request).unwrap();
        assert_eq!(request["process"]["commandLine"], "python -V");
        assert_eq!(request["process"]["timeout"], 10_000);
        let workdir = PathBuf::from(request["process"]["cwd"].as_str().unwrap());
        assert!(
            !workdir.exists(),
            "ephemeral workdir is removed after the run"
        );
        assert_eq!(rest, "from-stdin");
        assert_eq!(String::from_utf8_lossy(&output.stderr).trim(), "guest-err");
    }

    /// A refusal printed before any runner starts carries no JSON envelope; the
    /// probe of the same request confirms it, so it is an error, not exit 1.
    #[cfg(unix)]
    #[tokio::test]
    async fn plain_text_pre_runner_refusal_surfaces_as_error() {
        let directory = tempfile::tempdir().unwrap();
        let fake = fake_wxc_exec(
            directory.path(),
            concat!(
                "#!/bin/sh\n",
                "if [ \"$1\" = --probe ]; then\n",
                "  [ -f \"$3\" ] || exit 94\n",
                "  echo '{\"warnings\":[],\"probes\":{},\"error\":\"DACL fallback required but fallback.allowDaclMutation is false\"}'\n",
                "  exit 0\n",
                "fi\n",
                "echo 'error: BaseContainer is unavailable on this system and DACL fallback is disabled' >&2\n",
                "exit 1\n",
            ),
        );
        let error = exec_ephemeral(fake, ExecSpec::new("cmd", vec![]))
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("mxc executor failed"), "{error}");
        assert!(error.contains("DACL fallback is disabled"), "{error}");
    }

    /// A guest that prints the same prefix is still a guest failure when the
    /// probe says MXC can run the request.
    #[cfg(unix)]
    #[tokio::test]
    async fn guest_error_line_stays_a_guest_exit_when_the_probe_passes() {
        let directory = tempfile::tempdir().unwrap();
        let fake = fake_wxc_exec(
            directory.path(),
            concat!(
                "#!/bin/sh\n",
                "if [ \"$1\" = --probe ]; then\n",
                "  echo '{\"tier\":\"base-container\",\"needsDaclAugmentation\":false,\"warnings\":[],\"probes\":{}}'\n",
                "  exit 0\n",
                "fi\n",
                "echo \"error: pathspec 'nope' did not match any file(s) known to git\" >&2\n",
                "exit 1\n",
            ),
        );
        let output = exec_ephemeral(fake, ExecSpec::new("git", vec!["checkout".to_owned()]))
            .await
            .unwrap();
        assert_eq!(output.exit_code, 1);
        assert!(String::from_utf8_lossy(&output.stderr).starts_with("error: pathspec"));
    }

    /// A confirmation probe that never answers (here the executor is gone by
    /// the time it runs) confirms nothing, so the guest exit stands.
    #[cfg(unix)]
    #[tokio::test]
    async fn unanswered_probe_keeps_the_guest_exit() {
        let directory = tempfile::tempdir().unwrap();
        let fake = fake_wxc_exec(
            directory.path(),
            concat!(
                "#!/bin/sh\n",
                "rm -f \"$0\"\n",
                "echo 'error: something the guest printed' >&2\n",
                "exit 1\n",
            ),
        );
        let output = exec_ephemeral(fake, ExecSpec::new("cmd", vec![]))
            .await
            .unwrap();
        assert_eq!(output.exit_code, 1);
        assert!(String::from_utf8_lossy(&output.stderr).starts_with("error: something"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn executor_failure_surfaces_as_error() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let fake = directory.path().join("fake-wxc-exec");
        std::fs::write(
            &fake,
            "#!/bin/sh\necho '{\"error\":{\"code\":\"backend_error\",\"message\":\"runner unavailable\"}}' >&2\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();
        let error = exec_ephemeral(path_string(&fake), ExecSpec::new("cmd", vec![]))
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("runner unavailable"), "{error}");
    }
}
