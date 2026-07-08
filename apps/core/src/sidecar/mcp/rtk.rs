//! Built-in RTK (Rust Token Killer) tool provider.
//!
//! RTK (<https://github.com/rtk-ai/rtk>) is a single-binary CLI that wraps a dev
//! command (e.g. `rtk git status`, `rtk cargo test`) and returns a
//! token-compressed version of that command's output — 60-90% fewer tokens —
//! so an agent spends far less context on noisy tool output. This module surfaces
//! that capability as a callable registry tool (`rtk__run`) through the same
//! `list_all_tools` / `call_tool` surface every other built-in provider uses.
//!
//! ## Architecture note (Core-vs-Gateway)
//!
//! Deciding *what tools run* is Core, so this provider lives here. RTK is a local
//! CLI (not an HTTP service and not an MCP server), so — exactly like the Spider
//! provider ([`super::spider`]) — we register RTK as a reserved server name and
//! dispatch calls by shelling out to the `rtk` binary on demand. Tool ids keep
//! the registry's `<server>__<tool>` scheme (`rtk__run`) so the allowlist,
//! listing, and single `call_tool` entry all work for free.
//!
//! ## Detect-on-PATH, never managed
//!
//! Unlike Spider (a Ryu-downloaded sidecar at `~/.ryu/bin`), RTK is BYO: we detect
//! an `rtk` already on the user's `PATH` (or `RYU_RTK_BIN`), matching how Ryu
//! detects agent CLIs. Nothing is downloaded and nothing is hardcoded.
//!
//! ## Graceful degradation
//!
//! The tool is always *listed* so an agent can discover it on any machine. A call
//! returns a structured `{ available: false, reason }` result (never `Err`, and
//! never runs the underlying command) when `rtk` is not on PATH, so the agent's
//! turn continues. This mirrors `spider.rs` / `shadow.rs`.
//!
//! ## Security
//!
//! `rtk__run` executes a shell command (the thing RTK wraps). It is opt-in (the
//! `io.ryu.rtk` plugin) and every tool call is subject to Ryu's approval gate and
//! the agent's allowlist, the same governance every other tool call gets. When
//! `rtk` is absent the command is **not** run at all (no raw fallback).

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use anyhow::Result;
use serde_json::{json, Value};

use super::RegistryTool;

/// Wall-clock cap on a wrapped command, mirroring Spider's crawl timeout.
const RUN_TIMEOUT: Duration = Duration::from_secs(120);

/// Reserved registry server name for the built-in RTK provider.
pub const SERVER_NAME: &str = "rtk";

/// Resolve the `rtk` binary: `RYU_RTK_BIN` override first, else the first `rtk`
/// (`rtk.exe` on Windows) found on `PATH`. Returns `None` when RTK is not
/// installed — the detect-on-PATH, BYO posture (nothing downloaded).
pub fn rtk_bin_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("RYU_RTK_BIN") {
        let path = PathBuf::from(p);
        return path.exists().then_some(path);
    }
    let exe = if cfg!(target_os = "windows") {
        "rtk.exe"
    } else {
        "rtk"
    };
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(exe))
        .find(|candidate| candidate.exists())
}

/// True when an `rtk` binary is resolvable (used for the store's availability
/// badge and the graceful-degrade check).
pub fn is_available() -> bool {
    rtk_bin_path().is_some()
}

/// A structured "RTK is unavailable" tool result. Returned as `Ok` (not `Err`) so
/// a missing RTK install does not abort the agent's turn.
fn unavailable(reason: impl Into<String>) -> Value {
    json!({
        "available": false,
        "reason": reason.into(),
        "hint": "Install RTK (https://github.com/rtk-ai/rtk) — e.g. `brew install rtk-ai/rtk/rtk` or `cargo install rtk` — so it is on PATH, or set RYU_RTK_BIN."
    })
}

/// Map the optional `mode` argument to the RTK sub-invocation that precedes the
/// user's command. `wrap` (the default) is the plain `rtk <command>` filter;
/// the others select RTK's built-in narrower filters. Pure so it is unit-tested
/// without spawning anything.
fn mode_prefix(mode: &str) -> Option<&'static str> {
    match mode {
        "" | "wrap" => Some(""),
        "proxy" => Some("proxy "),
        "test" => Some("test "),
        "err" => Some("err "),
        _ => None,
    }
}

/// Schema for the `run` tool's arguments.
fn run_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "The dev command to run through RTK, e.g. \"git status\", \"cargo test\", \"ls -la\". RTK runs it and returns a token-compressed version of its output."
            },
            "mode": {
                "type": "string",
                "enum": ["wrap", "proxy", "test", "err"],
                "description": "wrap (default): filter+compress the output. proxy: run raw with tracking (no filtering). test: keep only failures. err: keep only errors."
            }
        },
        "required": ["command"]
    })
}

/// The set of RTK tools exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    vec![RegistryTool {
        id: format!("{SERVER_NAME}__run"),
        server: SERVER_NAME.to_owned(),
        name: "run".to_owned(),
        description: Some(
            "Run a dev command through RTK (Rust Token Killer) and return a \
             token-compressed version of its output (60-90% fewer tokens). Prefer \
             this over running noisy commands (git status/log/diff, test runners, \
             build tools, ls/find/grep) directly — you get the same information for \
             a fraction of the context."
                .to_owned(),
        ),
        input_schema: Some(run_schema()),
    }]
}

/// Dispatch an RTK tool call by shelling out to the resolved `rtk` binary.
///
/// `tool` is the bare tool name (already stripped of the `rtk__` prefix). Never
/// returns `Err` for a merely-absent RTK binary — that becomes an
/// `available: false` result so the tool loop continues. `Err` is reserved for a
/// genuinely malformed call (unknown tool, missing/blank command, bad mode).
pub async fn dispatch(tool: &str, arguments: Value) -> Result<Value> {
    match tool {
        "run" => do_run(arguments).await,
        other => Err(anyhow::anyhow!("unknown RTK tool '{other}'")),
    }
}

async fn do_run(arguments: Value) -> Result<Value> {
    let command = arguments
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if command.is_empty() {
        return Err(anyhow::anyhow!(
            "rtk__run requires a non-empty 'command' string"
        ));
    }
    let mode = arguments
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("wrap");
    let Some(prefix) = mode_prefix(mode) else {
        return Err(anyhow::anyhow!(
            "rtk__run: unknown mode '{mode}' (expected wrap|proxy|test|err)"
        ));
    };

    let Some(bin) = rtk_bin_path() else {
        return Ok(unavailable("rtk binary not found on PATH"));
    };

    // Build `<rtk> <mode-prefix><command>` and run it through the platform shell so
    // the user's command (quotes, pipes, redirects) parses exactly as it would if
    // typed. The rtk path is quoted to tolerate spaces.
    let bin_q = bin.to_string_lossy();
    let line = format!("\"{bin_q}\" {prefix}{command}");
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(&line);
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c").arg(&line);
        c
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => return Ok(unavailable(format!("failed to spawn rtk: {e}"))),
    };

    let output = match tokio::time::timeout(RUN_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(anyhow::anyhow!("rtk process error: {e}")),
        Err(_) => {
            return Err(anyhow::anyhow!(
                "rtk__run timed out after {}s",
                RUN_TIMEOUT.as_secs()
            ))
        }
    };

    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&stderr);
    }
    let exit_code = output.status.code().unwrap_or(-1);

    Ok(json!({
        "available": true,
        "exit_code": exit_code,
        "output": text,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_expose_rtk_run_with_schema() {
        let tools = tools();
        assert_eq!(tools.len(), 1);
        let t = &tools[0];
        assert_eq!(t.id, "rtk__run");
        assert_eq!(t.server, SERVER_NAME);
        assert_eq!(t.name, "run");
        let schema = t.input_schema.as_ref().expect("schema present");
        assert_eq!(schema["required"][0], "command");
    }

    #[test]
    fn mode_prefix_maps_known_modes_and_rejects_others() {
        assert_eq!(mode_prefix(""), Some(""));
        assert_eq!(mode_prefix("wrap"), Some(""));
        assert_eq!(mode_prefix("proxy"), Some("proxy "));
        assert_eq!(mode_prefix("test"), Some("test "));
        assert_eq!(mode_prefix("err"), Some("err "));
        assert_eq!(mode_prefix("nonsense"), None);
    }

    #[test]
    fn unavailable_is_a_structured_ok_shape() {
        let v = unavailable("nope");
        assert_eq!(v["available"], json!(false));
        assert_eq!(v["reason"], json!("nope"));
        assert!(v["hint"].is_string());
    }

    #[tokio::test]
    async fn do_run_rejects_blank_command() {
        let err = do_run(json!({ "command": "   " })).await.unwrap_err();
        assert!(err.to_string().contains("non-empty"));
    }

    #[tokio::test]
    async fn do_run_rejects_unknown_mode() {
        let err = do_run(json!({ "command": "ls", "mode": "bogus" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("unknown mode"));
    }

    #[tokio::test]
    async fn dispatch_unknown_tool_errors() {
        let err = dispatch("frobnicate", json!({})).await.unwrap_err();
        assert!(err.to_string().contains("unknown RTK tool"));
    }

    #[tokio::test]
    async fn do_run_reports_unavailable_when_rtk_absent() {
        // Point the override at a path that does not exist so detection fails
        // deterministically regardless of the host PATH.
        let prev = std::env::var_os("RYU_RTK_BIN");
        std::env::set_var("RYU_RTK_BIN", "/nonexistent/definitely/not/rtk");
        let v = do_run(json!({ "command": "git status" })).await.unwrap();
        assert_eq!(v["available"], json!(false));
        match prev {
            Some(p) => std::env::set_var("RYU_RTK_BIN", p),
            None => std::env::remove_var("RYU_RTK_BIN"),
        }
    }
}
