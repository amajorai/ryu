//! Binary-version enforcement for `command` tools that declare `bin_version`.
//!
//! A command manifest names an allowlist KEY, not a binary, so Core cannot know
//! which release an operator installed under that key. Some guarantees are a
//! property of a specific release, not of the name: the egress broker only
//! mediates a crawler that honours `HTTP(S)_PROXY`, which was verified for one
//! `spider_cli` release. Before spawning such a tool, Core runs the manifest's
//! fixed probe argv (for example `--version`) against the resolved binary,
//! extracts the version with the manifest's `{version}` pattern, and refuses
//! the call when the version is missing, unparsable, or outside the declared
//! SemVer requirement.
//!
//! The probe output is cached per (binary path, size, modification time, probe
//! argv), so a replaced or rebuilt binary is probed again on its next call.
//! Only completed probes are cached; a spawn failure or timeout is retried on
//! the next call. The probe runs with the same scrubbed, cleared environment as
//! the command itself, no stdin, a bounded output read, and a short timeout.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use tokio::io::AsyncReadExt;

use crate::plugin_manifest::schema::CommandBinVersion;

/// Upper bound on a version probe's wall-clock time.
pub(crate) const BIN_VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Prefix of every refusal this module returns, so callers and tests can tell a
/// version refusal from other command-tool errors.
pub(crate) const BIN_VERSION_REFUSAL: &str = "command tool: binary version check failed: ";

/// Per-stream cap on captured probe output.
const MAX_PROBE_OUTPUT_BYTES: u64 = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ProbeKey {
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
    args: Vec<String>,
}

/// Completed probe output (stdout followed by stderr), keyed by binary identity.
static PROBE_CACHE: std::sync::LazyLock<Mutex<HashMap<ProbeKey, String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn probe_key(path: &Path, args: &[String]) -> Result<ProbeKey, String> {
    let meta = std::fs::metadata(path)
        .map_err(|e| format!("{BIN_VERSION_REFUSAL}cannot read {} ({e})", path.display()))?;
    Ok(ProbeKey {
        path: path.to_owned(),
        len: meta.len(),
        modified: meta.modified().ok(),
        args: args.to_vec(),
    })
}

fn install_advice(spec: &CommandBinVersion) -> String {
    match spec.install_hint.as_deref() {
        Some(hint) => format!("install a supported version: {hint}"),
        None => format!("install a version matching '{}'", spec.requirement.trim()),
    }
}

/// Run the probe once: cleared + scrubbed env, no stdin, bounded output, and a
/// hard timeout (the child is killed when the timeout drops it).
async fn run_probe(
    bin_key: &str,
    path: &Path,
    args: &[String],
    env: &BTreeMap<String, String>,
    timeout: Duration,
) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new(path);
    cmd.args(args)
        .env_clear()
        .envs(env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "{BIN_VERSION_REFUSAL}could not start the version probe for '{bin_key}' at {} ({e})",
            path.display()
        )
    })?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let collect = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let read_out = async {
            if let Some(pipe) = stdout.as_mut() {
                let _ = pipe
                    .take(MAX_PROBE_OUTPUT_BYTES)
                    .read_to_end(&mut out)
                    .await;
            }
        };
        let read_err = async {
            if let Some(pipe) = stderr.as_mut() {
                let _ = pipe
                    .take(MAX_PROBE_OUTPUT_BYTES)
                    .read_to_end(&mut err)
                    .await;
            }
        };
        tokio::join!(read_out, read_err);
        // Close the pipes before waiting so a child still writing past the
        // cap gets EPIPE instead of blocking until the timeout.
        drop(stdout.take());
        drop(stderr.take());
        let _ = child.wait().await;
        let mut text = String::from_utf8_lossy(&out).into_owned();
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&String::from_utf8_lossy(&err));
        text
    };
    tokio::time::timeout(timeout, collect).await.map_err(|_| {
        format!(
            "{BIN_VERSION_REFUSAL}the version probe for '{bin_key}' at {} timed out after {}s",
            path.display(),
            timeout.as_secs_f32()
        )
    })
}

/// Probe (or reuse the cached probe of) `path` and require its version to
/// satisfy `spec`. Returns the version on success; every failure is a
/// fail-closed `Err` starting with [`BIN_VERSION_REFUSAL`] that names the
/// installed version (when known), the required range, and the install advice.
pub(crate) async fn check_bin_version(
    bin_key: &str,
    path: &Path,
    spec: &CommandBinVersion,
    env: &BTreeMap<String, String>,
    timeout: Duration,
) -> Result<semver::Version, String> {
    let requirement = spec
        .version_req()
        .map_err(|e| format!("{BIN_VERSION_REFUSAL}{e}"))?;
    let args = spec.probe_args();
    let key = probe_key(path, &args)?;
    let cached = PROBE_CACHE
        .lock()
        .ok()
        .and_then(|cache| cache.get(&key).cloned());
    let output = match cached {
        Some(output) => output,
        None => {
            let output = run_probe(bin_key, path, &args, env, timeout).await?;
            if let Ok(mut cache) = PROBE_CACHE.lock() {
                // One entry per binary path + probe argv: a replaced binary
                // evicts its stale entry instead of accumulating.
                cache.retain(|existing, _| existing.path != key.path || existing.args != key.args);
                cache.insert(key, output.clone());
            }
            output
        }
    };
    let Some(version) = spec.extract_version(&output) else {
        return Err(format!(
            "{BIN_VERSION_REFUSAL}could not read the version of '{bin_key}' at {} (`{} {}` printed no line matching '{}'); required '{}'; {}",
            path.display(),
            bin_key,
            args.join(" "),
            spec.pattern,
            spec.requirement.trim(),
            install_advice(spec),
        ));
    };
    if !requirement.matches(&version) {
        return Err(format!(
            "{BIN_VERSION_REFUSAL}'{bin_key}' at {} is version {version}, which does not satisfy the required '{}'; {}",
            path.display(),
            spec.requirement.trim(),
            install_advice(spec),
        ));
    }
    Ok(version)
}

#[cfg(all(test, unix))]
#[path = "tests/bin_version_test.rs"]
mod tests;
