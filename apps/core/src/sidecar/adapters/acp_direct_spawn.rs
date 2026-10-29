//! Start npm-distributed ACP agents directly instead of through `npx`.
//!
//! Most ACP spawn declarations are `npx -y <package>[@latest] …`, wrapped in
//! `cmd /c` on Windows. Every thread start then pays for two `cmd.exe`s and an
//! `npm exec` node process that stay resident as the agent's parents (~80 MB
//! and ~0.9 s of startup measured per Claude thread), plus, for `@latest`, a
//! registry round-trip. This module keeps one Ryu-owned install per spec and rewrites
//! the parsed stdio declaration to `node <bin.js> …`.
//!
//! The rewrite happens only on the structured stdio value right before spawn. The
//! declaration string that the rest of the adapter matches on (`claude-agent-acp`,
//! `pi-acp`, `PI_CODING_AGENT_DIR`, …) is never changed. When nothing is
//! installed yet, the declaration is returned untouched (the first start still
//! uses `npx`) and an install runs in the background for the next start.
//!
//! Each install lands in a new directory and `current` is switched only after
//! the bin resolves, so a refresh never overwrites files a running agent is using.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use agent_client_protocol::schema::v1::{EnvVariable, McpServerStdio};

mod install;
mod parse;

use install::*;
pub(crate) use parse::*;

/// How long an install of an unpinned or `@latest` spec is used before a
/// background refresh picks up a newer release.
const LATEST_REFRESH_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
const CURRENT_FILE: &str = "current";

/// An `npx` invocation recovered from a parsed ACP stdio declaration.
#[derive(Debug, Clone, PartialEq, Eq)]
struct NpxInvocation {
    /// `set NAME=value&&` assignments from a Windows `cmd /c` wrapper.
    env: Vec<(String, String)>,
    spec: String,
    args: Vec<String>,
}

fn store_root() -> PathBuf {
    crate::paths::runtime_dir("acp-npm")
}

/// Rewrite an `npx`-launched ACP declaration to run its installed bin with
/// `node`. Returns the declaration unchanged whenever that is not possible.
pub(crate) fn resolve_direct_stdio(stdio: McpServerStdio) -> McpServerStdio {
    if std::env::var_os("RYU_ACP_DIRECT_SPAWN").is_some_and(|value| value == "0") {
        return stdio;
    }
    let Some(invocation) = parse_npx_invocation(&stdio) else {
        return stdio;
    };
    let Some(node) = node_binary() else {
        return stdio;
    };
    let root = store_root();
    let installed = installed_bin(&root, &invocation.spec);
    let needs_install = match &installed {
        None => true,
        Some(install) => {
            spec_follows_latest(&invocation.spec) && install.is_stale(SystemTime::now())
        }
    };
    if needs_install {
        schedule_install(root, invocation.spec.clone());
    }
    match installed {
        Some(install) => rewrite(stdio, &invocation, &node, &install),
        None => stdio,
    }
}

/// Read declared environment even when an npm install has not completed or
/// direct spawn is disabled. Reuse the same Windows wrapper parser as launch.
pub(crate) fn declared_environment(stdio: &McpServerStdio) -> Vec<(String, String)> {
    let mut environment: Vec<_> = stdio
        .env
        .iter()
        .map(|variable| (variable.name.clone(), variable.value.clone()))
        .collect();
    if let Some(invocation) = parse_npx_invocation(stdio) {
        environment.extend(invocation.env);
    }
    environment
}

fn rewrite(
    mut stdio: McpServerStdio,
    invocation: &NpxInvocation,
    node: &Path,
    install: &InstalledBin,
) -> McpServerStdio {
    stdio.command = node.to_path_buf();
    let mut args = Vec::with_capacity(invocation.args.len() + 1);
    args.push(process_path_argument(&install.bin));
    args.extend(invocation.args.iter().cloned());
    stdio.args = args;
    for (name, value) in &invocation.env {
        upsert_env(&mut stdio.env, name, value.clone());
    }
    // pi-acp passes this generated path to child_process.spawn. Windows
    // verbatim paths break its batch-shim handling just as they break Node's
    // script lookup. Other environment values remain literal.
    #[cfg(windows)]
    if let Some(variable) = stdio
        .env
        .iter_mut()
        .find(|variable| variable.name == "PI_ACP_PI_COMMAND")
    {
        variable.value = process_path_argument(Path::new(&variable.value));
    }
    // `npx` puts the package's `.bin` first on PATH; keep that for bins that
    // start sibling bins by name.
    let bin_dir = install.prefix.join("node_modules").join(".bin");
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let path =
        std::env::join_paths(std::iter::once(bin_dir).chain(std::env::split_paths(&inherited)))
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|_| inherited.to_string_lossy().into_owned());
    upsert_env(&mut stdio.env, "PATH", path);
    stdio
}

/// Keep Windows canonical paths inside Rust, but pass ordinary drive/UNC paths
/// to Node. Each path stays one argument, without shell quoting or splitting.
pub(crate) fn process_path_argument(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        normalize_windows_process_path(&value)
    }
    #[cfg(not(windows))]
    {
        value.into_owned()
    }
}

#[cfg(any(windows, test))]
fn normalize_windows_process_path(value: &str) -> String {
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    if let Some(drive) = value.strip_prefix(r"\\?\") {
        let bytes = drive.as_bytes();
        if bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'\\'
        {
            return drive.to_owned();
        }
    }
    value.to_owned()
}

fn upsert_env(env: &mut Vec<EnvVariable>, name: &str, value: String) {
    if let Some(existing) = env
        .iter_mut()
        .find(|entry| entry.name.eq_ignore_ascii_case(name))
    {
        existing.value = value;
    } else {
        env.push(EnvVariable::new(name, value));
    }
}

fn node_binary() -> Option<PathBuf> {
    static NODE: OnceLock<Option<PathBuf>> = OnceLock::new();
    NODE.get_or_init(|| super::acp::resolve_in_path("node"))
        .clone()
}

#[cfg(test)]
mod tests;
