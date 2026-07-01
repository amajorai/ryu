//! Built-in Spider crawl tool provider (U040).
//!
//! Spider (<https://spider.cloud>) is a high-performance web crawler and scraper
//! available as the `spider_cli` crate installed at `~/.ryu/bin/spider`. This
//! module surfaces Spider's crawl capability as a callable tool through the same
//! registry call surface the rest of the tool loop uses
//! (`McpRegistry::list_all_tools` / `call_tool`), so an agent can crawl and
//! extract web pages without any per-user MCP wiring.
//!
//! ## Architecture note (Core-vs-Gateway)
//!
//! Deciding *what tools run* is Core, so this provider lives here. Spider is a
//! local process, not an HTTP service, so rather than shipping a long-lived stdio
//! MCP server (which would require a `mcp` subcommand Spider doesn't have) we
//! register Spider as a reserved server name inside the registry and dispatch its
//! tool calls by shelling out to the installed `spider` binary on demand. Tool ids
//! keep the registry's `<server>__<tool>` scheme (`spider__crawl`) so the
//! allowlist, listing, and single `call_tool` entry all work for free.
//!
//! ## Graceful degradation
//!
//! The crawl tool is always *listed* so an agent can discover it on any machine.
//! A call returns a structured `{ available: false, reason }` result (never `Err`)
//! when the spider binary is not yet installed, so the agent's turn continues.
//! This mirrors `shadow.rs:137-146`.

use std::{path::PathBuf, time::Duration};

use anyhow::Result;
use serde_json::{json, Value};

use super::RegistryTool;

const CRAWL_TIMEOUT: Duration = Duration::from_secs(120);

/// Reserved registry server name for the built-in Spider provider.
pub const SERVER_NAME: &str = "spider";

/// Resolve the path to the installed Spider binary.
///
/// `RYU_SPIDER_BIN` overrides the default (`~/.ryu/bin/spider[.exe]`) so tests
/// and environments with a non-standard install location can point at the right
/// binary without mutating PATH.
pub fn spider_bin_path() -> PathBuf {
    if let Some(p) = std::env::var_os("RYU_SPIDER_BIN") {
        return PathBuf::from(p);
    }
    let name = if cfg!(target_os = "windows") {
        "spider.exe"
    } else {
        "spider"
    };
    crate::paths::ryu_dir().join("bin").join(name)
}

/// A structured "Spider is unavailable" tool result. Returned (as `Ok`) instead
/// of an error so a missing Spider install does not abort the agent's turn — the
/// agent sees a clean signal it can reason about and continue.
fn unavailable(reason: impl Into<String>) -> Value {
    json!({
        "available": false,
        "reason": reason.into(),
        "hint": "Install the Spider sidecar from the App-store (or run `cargo install spider_cli`) to enable web crawling."
    })
}

/// Schema for the `crawl` tool's arguments.
fn crawl_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "The URL to crawl and extract content from."
            },
            "depth": {
                "type": "integer",
                "description": "How many link hops to follow from the start URL (default 1 — single page only).",
                "minimum": 0,
                "maximum": 10
            },
            "limit": {
                "type": "integer",
                "description": "Maximum number of pages to crawl (default 10).",
                "minimum": 1,
                "maximum": 500
            }
        },
        "required": ["url"]
    })
}

/// The set of Spider tools exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    vec![RegistryTool {
        id: format!("{SERVER_NAME}__crawl"),
        server: SERVER_NAME.to_owned(),
        name: "crawl".to_owned(),
        description: Some(
            "Crawl a URL with the Spider web crawler and return the extracted page content. \
             Use depth=0 for a single page; depth>0 follows links up to that many hops."
                .to_owned(),
        ),
        input_schema: Some(crawl_schema()),
    }]
}

/// Dispatch a Spider tool call by shelling out to the installed `spider` binary.
///
/// `tool` is the bare tool name (already stripped of the `spider__` prefix by the
/// registry). Never returns `Err` for a merely-absent or failing Spider binary —
/// that becomes an `available: false` result so the tool loop continues. `Err` is
/// reserved for genuinely malformed calls (unknown tool, bad arguments).
pub async fn dispatch(tool: &str, arguments: Value) -> Result<Value> {
    match tool {
        "crawl" => do_crawl(arguments).await,
        other => Err(anyhow::anyhow!("unknown Spider tool '{other}'")),
    }
}

/// Run `spider crawl -- <url> [--depth N] [--limit N] --output json` and return
/// the parsed JSON result. Returns `unavailable` when the binary is absent or the
/// invocation fails.
async fn do_crawl(arguments: Value) -> Result<Value> {
    let url = require_string(&arguments, "url")?;

    // SSRF egress screen: reject non-http/https schemes (file://, ldap://, etc.)
    // AND — default-on, host-allowlist escape hatch — resolve the host and reject
    // loopback / RFC1918 / link-local (incl. 169.254.169.254 metadata) / ULA /
    // CGNAT destinations before shelling out to the crawler. See
    // `crate::server::screen_agent_egress_url`. Residual: the crawler re-resolves
    // the host itself, so this pre-dispatch screen cannot IP-pin the connection
    // (a narrow DNS-rebinding TOCTOU window remains, inherent to a shell-out
    // crawler). Disable with `RYU_AGENT_EGRESS_SSRF_GUARD=0`; allowlist specific
    // hosts with `RYU_AGENT_EGRESS_ALLOW_HOSTS`.
    crate::server::screen_agent_egress_url(&url).await?;

    // Clamp depth/limit to the same bounds the schema advertises, ensuring a
    // caller who bypasses the MCP schema (e.g. raw JSON) cannot exceed them.
    let depth = arguments
        .get("depth")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .min(10);
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(10)
        .clamp(1, 500);

    let bin = spider_bin_path();
    if !bin.exists() {
        return Ok(unavailable(format!(
            "Spider binary not found at {}. Install the Spider sidecar first.",
            bin.display()
        )));
    }

    // `--` terminates option parsing so a URL starting with `-` cannot inject
    // additional flags (argv flag smuggling). Depth/limit are already bounded.
    let cmd = tokio::process::Command::new(&bin)
        .args([
            "crawl",
            "--depth",
            &depth.to_string(),
            "--limit",
            &limit.to_string(),
            "--output",
            "json",
            "--",
            &url,
        ])
        .output();

    let output = match tokio::time::timeout(CRAWL_TIMEOUT, cmd).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Ok(unavailable(format!("Failed to spawn spider binary: {e}"))),
        Err(_) => {
            return Ok(unavailable(format!(
                "Spider crawl timed out after {CRAWL_TIMEOUT:?}"
            )))
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Ok(unavailable(format!(
            "Spider crawl failed (exit {:?}): {stderr}",
            output.status.code()
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Try to parse as JSON; if the binary printed something non-JSON, wrap it.
    match serde_json::from_str::<Value>(stdout.trim()) {
        Ok(v) => Ok(v),
        Err(_) => {
            // Return the raw text as a structured result.
            Ok(json!({
                "available": true,
                "url": url,
                "content": stdout.trim()
            }))
        }
    }
}

fn require_string(args: &Value, key: &str) -> Result<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| anyhow::anyhow!("missing required string argument '{key}'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_spider_crawl_tool_with_qualified_id() {
        let tools = tools();
        assert_eq!(tools.len(), 1);
        let t = &tools[0];
        assert_eq!(t.id, "spider__crawl");
        assert_eq!(t.server, SERVER_NAME);
        assert_eq!(t.name, "crawl");
        assert!(t.description.is_some());
        assert!(t.input_schema.is_some());
    }

    #[tokio::test]
    async fn unknown_tool_is_an_error() {
        let err = dispatch("does_not_exist", json!({})).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn missing_url_argument_is_an_error() {
        let err = dispatch("crawl", json!({})).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn missing_binary_yields_unavailable_not_error() {
        // Point RYU_SPIDER_BIN at a path that doesn't exist so the binary-absent
        // branch is exercised without needing the real spider binary.
        unsafe {
            std::env::set_var("RYU_SPIDER_BIN", "/ryu-test-spider-does-not-exist/spider");
        }
        let result = dispatch("crawl", json!({ "url": "https://example.com" }))
            .await
            .expect("missing spider binary must not be an error");
        assert_eq!(
            result.get("available").and_then(Value::as_bool),
            Some(false)
        );
        assert!(result.get("reason").is_some());
        unsafe {
            std::env::remove_var("RYU_SPIDER_BIN");
        }
    }

    #[test]
    fn unavailable_result_shape() {
        let v = unavailable("not installed");
        assert_eq!(v["available"], json!(false));
        assert_eq!(v["reason"], json!("not installed"));
        assert!(v["hint"].is_string());
    }

    #[tokio::test]
    async fn non_http_scheme_is_rejected() {
        let err = dispatch("crawl", json!({ "url": "file:///etc/passwd" })).await;
        assert!(err.is_err(), "file:// URL must be rejected");
        let err = dispatch("crawl", json!({ "url": "ftp://example.com" })).await;
        assert!(err.is_err(), "ftp:// URL must be rejected");
    }

    #[tokio::test]
    async fn flag_smuggling_url_is_rejected() {
        // A URL starting with '--' is not valid http/https so it is caught by
        // the scheme check before it ever reaches argv.
        let err = dispatch("crawl", json!({ "url": "--config=/etc/shadow" })).await;
        assert!(err.is_err(), "flag-like URL must be rejected");
    }

    #[tokio::test]
    async fn metadata_ip_is_blocked() {
        // The cloud-metadata endpoint must be rejected before any shell-out. This
        // relies on the default-on egress guard and an IP literal (no DNS).
        let err = dispatch("crawl", json!({ "url": "http://169.254.169.254/" })).await;
        assert!(err.is_err(), "cloud metadata IP must be blocked");
    }

    #[tokio::test]
    async fn private_ip_is_blocked() {
        for url in ["http://10.0.0.1/", "http://127.0.0.1/", "https://192.168.1.1/"] {
            let err = dispatch("crawl", json!({ "url": url })).await;
            assert!(err.is_err(), "private/loopback IP {url} must be blocked");
        }
    }
}
