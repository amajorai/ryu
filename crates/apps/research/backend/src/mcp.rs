//! Built-in Research tool provider — drives the autoresearch sidecar.
//!
//! Surfaces the research sidecar's HTTP contract (`apps-store/research/sidecar`,
//! Python stdlib on :8087) as callable tools. Core's `sidecar::mcp::research` shim
//! maps [`tool_specs`] onto the registry's `<server>__<tool>` id scheme
//! (`research__run`) so the allowlist, listing, and single `call_tool` entry all
//! work for free; [`dispatch`] is the single HTTP entrypoint the registry calls to
//! run the loop (init a workspace, read/edit the mutable files, run one attempt,
//! keep-if-improved-else-reset, and log the ledger).
//!
//! ## Architecture (Core-vs-Gateway)
//!
//! Deciding *what runs* (which experiment) is Core, so this lives in the Core
//! capability crate. It is an HTTP-backed provider (like Shadow): dispatch forwards
//! to the sidecar.
//!
//! ## Graceful degradation
//!
//! Every tool is always *listed* so an agent can discover it. A call returns a
//! structured `{ available: false, reason }` result (never `Err`) when the sidecar
//! is not running, so the agent's turn continues (mirrors `spider.rs`).

use anyhow::Result;
use serde_json::{json, Value};

use crate::research_base_url;

/// Reserved registry server name for the built-in Research provider.
pub const SERVER_NAME: &str = "research";

/// A single research tool's registry-agnostic definition: the bare tool name, a
/// human description, and the JSON input schema. Core's thin `sidecar::mcp::research`
/// wiring shim maps this onto its own `RegistryTool` registry type (applying the
/// `research__<name>` id scheme), keeping this crate free of that core type.
pub struct ResearchToolSpec {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// A structured "sidecar unavailable" result. Returned (as `Ok`) instead of an
/// error so a stopped sidecar does not abort the agent's turn.
fn unavailable(reason: impl Into<String>) -> Value {
    json!({
        "available": false,
        "reason": reason.into(),
        "hint": "Install the Research sidecar from the Store (or run `python -m ryu_research`) to enable autoresearch."
    })
}

fn tool(name: &str, description: &str, schema: Value) -> ResearchToolSpec {
    ResearchToolSpec {
        name: name.to_owned(),
        description: description.to_owned(),
        input_schema: schema,
    }
}

fn ws_prop() -> Value {
    json!({ "type": "string", "description": "The workspace id returned by init_workspace." })
}

/// The set of Research tools exposed through the registry, as registry-agnostic
/// specs. Core's `sidecar::mcp::research` shim maps these onto `RegistryTool`.
pub fn tool_specs() -> Vec<ResearchToolSpec> {
    vec![
        tool(
            "list_experiments",
            "List the available autoresearch experiment kinds (id, gpu_required, budget_s, mutable_files).",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
        tool(
            "init_workspace",
            "Create a fresh git-versioned workspace for an experiment kind. Returns workspace_id, the mutable_files you may edit, and program_md (the researcher instructions).",
            json!({
                "type": "object",
                "properties": { "experiment": { "type": "string", "description": "Experiment kind id, e.g. 'toy' or 'nanochat'." } },
                "required": ["experiment"]
            }),
        ),
        tool(
            "read_file",
            "Read a file from the workspace (typically a mutable train.py).",
            json!({
                "type": "object",
                "properties": { "workspace_id": ws_prop(), "path": { "type": "string", "description": "Workspace-relative file path." } },
                "required": ["workspace_id", "path"]
            }),
        ),
        tool(
            "write_file",
            "Overwrite a file in the workspace with new content (your proposed edit).",
            json!({
                "type": "object",
                "properties": {
                    "workspace_id": ws_prop(),
                    "path": { "type": "string", "description": "Workspace-relative file path." },
                    "content": { "type": "string", "description": "Full new file content." }
                },
                "required": ["workspace_id", "path", "content"]
            }),
        ),
        tool(
            "run",
            "Commit the current state and run one experiment attempt under a wall-clock budget. Returns {score (lower=better, or null), memory_gb, status: ok|crash|timeout, commit, logs_tail}.",
            json!({
                "type": "object",
                "properties": {
                    "workspace_id": ws_prop(),
                    "budget_s": { "type": "integer", "description": "Optional wall-clock cap in seconds; defaults to the experiment's budget_s." }
                },
                "required": ["workspace_id"]
            }),
        ),
        tool(
            "keep",
            "Keep the last attempt (advance the git ledger). Use when the score improved.",
            json!({ "type": "object", "properties": { "workspace_id": ws_prop() }, "required": ["workspace_id"] }),
        ),
        tool(
            "reset",
            "Discard the last attempt (git reset --hard HEAD~1). Use when the score did not improve, or the run crashed/timed out.",
            json!({ "type": "object", "properties": { "workspace_id": ws_prop() }, "required": ["workspace_id"] }),
        ),
        tool(
            "ledger",
            "Read the results ledger (no extra fields), OR append a row when commit/score/memory_gb/status/description are provided. Lower score = better.",
            json!({
                "type": "object",
                "properties": {
                    "workspace_id": ws_prop(),
                    "commit": { "type": "string", "description": "Commit sha of the attempt (append mode)." },
                    "score": { "type": "number", "description": "Parsed metric, lower=better (append mode)." },
                    "memory_gb": { "type": "number", "description": "Peak memory of the attempt (append mode)." },
                    "status": { "type": "string", "description": "ok|crash|timeout (append mode)." },
                    "description": { "type": "string", "description": "What the attempt changed + its outcome (append mode)." }
                },
                "required": ["workspace_id"]
            }),
        ),
    ]
}

/// Dispatch a Research tool call by forwarding to the sidecar over HTTP.
///
/// `tool` is the bare tool name (already stripped of the `research__` prefix by
/// the registry). Never returns `Err` for a merely-unreachable sidecar — that
/// becomes an `available: false` result so the tool loop continues. `Err` is
/// reserved for genuinely malformed calls (unknown tool, missing argument).
pub async fn dispatch(client: &reqwest::Client, tool: &str, arguments: Value) -> Result<Value> {
    let base = research_base_url();
    match tool {
        "list_experiments" => get(client, &format!("{base}/experiments")).await,
        "init_workspace" => {
            let experiment = require_string(&arguments, "experiment")?;
            post(
                client,
                &format!("{base}/workspace/init"),
                json!({ "experiment": experiment }),
            )
            .await
        }
        "read_file" => {
            let ws = require_string(&arguments, "workspace_id")?;
            let path = require_string(&arguments, "path")?;
            get(
                client,
                &format!(
                    "{base}/workspace/{ws}/file?path={}",
                    urlencoding_encode(&path)
                ),
            )
            .await
        }
        "write_file" => {
            let ws = require_string(&arguments, "workspace_id")?;
            let path = require_string(&arguments, "path")?;
            let content = arguments
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            put(
                client,
                &format!("{base}/workspace/{ws}/file"),
                json!({ "path": path, "content": content }),
            )
            .await
        }
        "run" => {
            let ws = require_string(&arguments, "workspace_id")?;
            let mut body = json!({});
            if let Some(b) = arguments.get("budget_s") {
                body["budget_s"] = b.clone();
            }
            post(client, &format!("{base}/workspace/{ws}/run"), body).await
        }
        "keep" => git_action(client, &base, &arguments, "advance").await,
        "reset" => git_action(client, &base, &arguments, "reset").await,
        "ledger" => {
            let ws = require_string(&arguments, "workspace_id")?;
            // Append mode when the caller supplies a commit/score/status; else read.
            let appends = arguments.get("commit").is_some()
                || arguments.get("score").is_some()
                || arguments.get("status").is_some();
            if appends {
                let body = json!({
                    "commit": arguments.get("commit").cloned().unwrap_or(json!("")),
                    "score": arguments.get("score").cloned().unwrap_or(Value::Null),
                    "memory_gb": arguments.get("memory_gb").cloned().unwrap_or(Value::Null),
                    "status": arguments.get("status").cloned().unwrap_or(json!("")),
                    "description": arguments.get("description").cloned().unwrap_or(json!("")),
                });
                post(client, &format!("{base}/workspace/{ws}/ledger"), body).await
            } else {
                get(client, &format!("{base}/workspace/{ws}/ledger")).await
            }
        }
        other => Err(anyhow::anyhow!("unknown Research tool '{other}'")),
    }
}

async fn git_action(
    client: &reqwest::Client,
    base: &str,
    arguments: &Value,
    action: &str,
) -> Result<Value> {
    let ws = require_string(arguments, "workspace_id")?;
    post(
        client,
        &format!("{base}/workspace/{ws}/git"),
        json!({ "action": action }),
    )
    .await
}

async fn get(client: &reqwest::Client, url: &str) -> Result<Value> {
    match client.get(url).send().await {
        Ok(r) => parse(r).await,
        Err(e) => Ok(unavailable(format!("research sidecar not reachable: {e}"))),
    }
}

async fn post(client: &reqwest::Client, url: &str, body: Value) -> Result<Value> {
    match client.post(url).json(&body).send().await {
        Ok(r) => parse(r).await,
        Err(e) => Ok(unavailable(format!("research sidecar not reachable: {e}"))),
    }
}

async fn put(client: &reqwest::Client, url: &str, body: Value) -> Result<Value> {
    match client.put(url).json(&body).send().await {
        Ok(r) => parse(r).await,
        Err(e) => Ok(unavailable(format!("research sidecar not reachable: {e}"))),
    }
}

async fn parse(resp: reqwest::Response) -> Result<Value> {
    let status = resp.status();
    let bytes = resp.bytes().await.unwrap_or_default();
    let value: Value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }));
    if !status.is_success() {
        // Surface the sidecar's error body but keep the turn alive.
        return Ok(json!({
            "available": true,
            "error": format!("research sidecar returned {status}"),
            "detail": value
        }));
    }
    Ok(value)
}

/// Minimal percent-encoding for a query value (path arg). Encodes the handful of
/// characters that matter for a `?path=` value; keeps the dep surface at zero.
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
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
    fn lists_eight_research_tool_specs() {
        let specs = tool_specs();
        assert_eq!(specs.len(), 8);
        assert!(specs.iter().all(|s| s.input_schema.is_object()));
        assert!(specs.iter().any(|s| s.name == "run"));
        assert!(specs.iter().any(|s| s.name == "init_workspace"));
    }

    #[tokio::test]
    async fn unknown_tool_is_an_error() {
        let client = reqwest::Client::new();
        assert!(dispatch(&client, "does_not_exist", json!({}))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn missing_argument_is_an_error() {
        let client = reqwest::Client::new();
        assert!(dispatch(&client, "init_workspace", json!({}))
            .await
            .is_err());
        assert!(dispatch(&client, "run", json!({})).await.is_err());
    }

    #[test]
    fn encodes_query_values() {
        assert_eq!(urlencoding_encode("train.py"), "train.py");
        assert_eq!(urlencoding_encode("a b"), "a%20b");
        assert_eq!(urlencoding_encode("x=1&y"), "x%3D1%26y");
    }

    #[test]
    fn encodes_reserved_and_unicode_but_keeps_path_chars() {
        // Path separators and the RFC-3986 unreserved set pass through unescaped.
        assert_eq!(urlencoding_encode("dir/sub-file_v.1"), "dir/sub-file_v.1");
        // A '?' and space are escaped; a 2-byte UTF-8 char is percent-encoded per byte.
        assert_eq!(urlencoding_encode("a?b"), "a%3Fb");
        assert_eq!(urlencoding_encode("é"), "%C3%A9");
    }

    #[test]
    fn require_string_extracts_and_rejects() {
        assert_eq!(require_string(&json!({ "k": "v" }), "k").unwrap(), "v");
        // Missing key and non-string value both error.
        assert!(require_string(&json!({}), "k").is_err());
        assert!(require_string(&json!({ "k": 7 }), "k").is_err());
    }

    #[tokio::test]
    async fn read_file_requires_both_workspace_and_path() {
        let client = reqwest::Client::new();
        assert!(dispatch(&client, "read_file", json!({ "workspace_id": "w" }))
            .await
            .is_err());
        assert!(dispatch(&client, "read_file", json!({ "path": "train.py" }))
            .await
            .is_err());
    }

    // ── Graceful-degradation contract against a dead sidecar ────────────────────
    //
    // The whole point of `dispatch` vs. an unknown-tool `Err`: a merely-unreachable
    // sidecar must return `Ok(available:false)` so the agent's tool loop continues.

    #[tokio::test]
    async fn unreachable_sidecar_degrades_to_available_false_not_err() {
        let _g = crate::UpstreamGuard::set(Some("127.0.0.1:1"));
        let client = reqwest::Client::new();
        for (tool, args) in [
            ("list_experiments", json!({})),
            ("init_workspace", json!({ "experiment": "toy" })),
            ("read_file", json!({ "workspace_id": "w", "path": "train.py" })),
            ("write_file", json!({ "workspace_id": "w", "path": "train.py", "content": "x" })),
            ("run", json!({ "workspace_id": "w" })),
            ("keep", json!({ "workspace_id": "w" })),
            ("reset", json!({ "workspace_id": "w" })),
            ("ledger", json!({ "workspace_id": "w" })),
        ] {
            let out = dispatch(&client, tool, args).await.expect("degrades, not Err");
            assert_eq!(out["available"], json!(false), "tool {tool}");
            assert!(out["reason"].as_str().unwrap().contains("not reachable"));
        }
    }

    /// Records the (method, path, body) of every request the mock sidecar sees, so a
    /// test can assert dispatch built the right upstream call.
    async fn spawn_recorder() -> (String, std::sync::Arc<tokio::sync::Mutex<Vec<(String, String, Value)>>>)
    {
        use axum::extract::Path as AxPath;
        use axum::routing::{get, post};
        use axum::{Json, Router};

        type Log = std::sync::Arc<tokio::sync::Mutex<Vec<(String, String, Value)>>>;
        let log: Log = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new()));

        async fn rec(log: &Log, method: &str, path: String, body: Value) {
            log.lock().await.push((method.to_owned(), path, body));
        }

        let app = Router::new()
            .route(
                "/experiments",
                get({
                    let log = log.clone();
                    move || {
                        let log = log.clone();
                        async move {
                            rec(&log, "GET", "/experiments".into(), Value::Null).await;
                            Json(json!({ "experiments": [{ "id": "toy" }] }))
                        }
                    }
                }),
            )
            .route(
                "/workspace/init",
                post({
                    let log = log.clone();
                    move |Json(b): Json<Value>| {
                        let log = log.clone();
                        async move {
                            rec(&log, "POST", "/workspace/init".into(), b).await;
                            Json(json!({ "workspace_id": "ws-1" }))
                        }
                    }
                }),
            )
            .route(
                "/workspace/:id/file",
                get({
                    let log = log.clone();
                    move |AxPath(id): AxPath<String>, req: axum::extract::Request| {
                        let log = log.clone();
                        let q = req.uri().query().unwrap_or("").to_owned();
                        async move {
                            rec(&log, "GET", format!("/workspace/{id}/file?{q}"), Value::Null).await;
                            Json(json!({ "content": "print(1)" }))
                        }
                    }
                })
                .put({
                    let log = log.clone();
                    move |AxPath(id): AxPath<String>, Json(b): Json<Value>| {
                        let log = log.clone();
                        async move {
                            rec(&log, "PUT", format!("/workspace/{id}/file"), b).await;
                            Json(json!({ "written": true }))
                        }
                    }
                }),
            )
            .route(
                "/workspace/:id/run",
                post({
                    let log = log.clone();
                    move |AxPath(id): AxPath<String>, Json(b): Json<Value>| {
                        let log = log.clone();
                        async move {
                            rec(&log, "POST", format!("/workspace/{id}/run"), b).await;
                            Json(json!({ "status": "ok", "score": 1.0 }))
                        }
                    }
                }),
            )
            .route(
                "/workspace/:id/git",
                post({
                    let log = log.clone();
                    move |AxPath(id): AxPath<String>, Json(b): Json<Value>| {
                        let log = log.clone();
                        async move {
                            rec(&log, "POST", format!("/workspace/{id}/git"), b).await;
                            Json(json!({ "ok": true }))
                        }
                    }
                }),
            )
            .route(
                "/workspace/:id/ledger",
                get({
                    let log = log.clone();
                    move |AxPath(id): AxPath<String>| {
                        let log = log.clone();
                        async move {
                            rec(&log, "GET", format!("/workspace/{id}/ledger"), Value::Null).await;
                            Json(json!({ "rows": [] }))
                        }
                    }
                })
                .post({
                    let log = log.clone();
                    move |AxPath(id): AxPath<String>, Json(b): Json<Value>| {
                        let log = log.clone();
                        async move {
                            rec(&log, "POST", format!("/workspace/{id}/ledger"), b).await;
                            Json(json!({ "appended": true }))
                        }
                    }
                }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (addr.to_string(), log)
    }

    #[tokio::test]
    async fn dispatch_routes_every_tool_to_the_right_upstream_call() {
        let (addr, log) = spawn_recorder().await;
        let _g = crate::UpstreamGuard::set(Some(&addr));
        let client = reqwest::Client::new();

        // list_experiments → GET /experiments, and the catalog passes back.
        let out = dispatch(&client, "list_experiments", json!({})).await.unwrap();
        assert_eq!(out["experiments"][0]["id"], json!("toy"));

        // init_workspace → POST /workspace/init with the experiment.
        dispatch(&client, "init_workspace", json!({ "experiment": "toy" }))
            .await
            .unwrap();

        // read_file → GET /workspace/{id}/file?path=<encoded>.
        dispatch(&client, "read_file", json!({ "workspace_id": "ws 1", "path": "a b.py" }))
            .await
            .unwrap();

        // write_file → PUT with path+content (content defaults to "" if omitted).
        dispatch(&client, "write_file", json!({ "workspace_id": "w", "path": "t.py" }))
            .await
            .unwrap();

        // run with explicit budget_s → POST /workspace/{id}/run { budget_s }.
        dispatch(&client, "run", json!({ "workspace_id": "w", "budget_s": 42 }))
            .await
            .unwrap();

        // run without budget_s → empty body (no budget_s key).
        dispatch(&client, "run", json!({ "workspace_id": "w" }))
            .await
            .unwrap();

        // keep → git advance, reset → git reset.
        dispatch(&client, "keep", json!({ "workspace_id": "w" })).await.unwrap();
        dispatch(&client, "reset", json!({ "workspace_id": "w" })).await.unwrap();

        // ledger read (no append keys) → GET.
        dispatch(&client, "ledger", json!({ "workspace_id": "w" })).await.unwrap();

        // ledger append (commit present) → POST with the full row.
        dispatch(
            &client,
            "ledger",
            json!({ "workspace_id": "w", "commit": "abc", "score": 0.5, "status": "ok" }),
        )
        .await
        .unwrap();

        let calls = log.lock().await.clone();
        // Ordered assertions on the exact upstream calls dispatch produced.
        assert_eq!(calls[0], ("GET".into(), "/experiments".into(), Value::Null));
        assert_eq!(calls[1].0, "POST");
        assert_eq!(calls[1].1, "/workspace/init");
        assert_eq!(calls[1].2, json!({ "experiment": "toy" }));
        // read_file: the path arg is percent-encoded into the query string.
        assert_eq!(calls[2].0, "GET");
        assert_eq!(calls[2].1, "/workspace/ws 1/file?path=a%20b.py");
        // write_file: content defaulted to empty string.
        assert_eq!(calls[3].0, "PUT");
        assert_eq!(calls[3].2, json!({ "path": "t.py", "content": "" }));
        // run WITH budget_s.
        assert_eq!(calls[4].0, "POST");
        assert_eq!(calls[4].1, "/workspace/w/run");
        assert_eq!(calls[4].2, json!({ "budget_s": 42 }));
        // run WITHOUT budget_s → empty object body.
        assert_eq!(calls[5].2, json!({}));
        // keep → advance, reset → reset.
        assert_eq!(calls[6].1, "/workspace/w/git");
        assert_eq!(calls[6].2, json!({ "action": "advance" }));
        assert_eq!(calls[7].2, json!({ "action": "reset" }));
        // ledger read vs append.
        assert_eq!(calls[8].0, "GET");
        assert_eq!(calls[8].1, "/workspace/w/ledger");
        assert_eq!(calls[9].0, "POST");
        assert_eq!(calls[9].2["commit"], json!("abc"));
        assert_eq!(calls[9].2["score"], json!(0.5));
        assert_eq!(calls[9].2["status"], json!("ok"));
        // Unsupplied append fields default (not omitted).
        assert_eq!(calls[9].2["memory_gb"], Value::Null);
        assert_eq!(calls[9].2["description"], json!(""));
    }

    #[tokio::test]
    async fn ledger_append_triggers_on_score_or_status_alone() {
        let (addr, log) = spawn_recorder().await;
        let _g = crate::UpstreamGuard::set(Some(&addr));
        let client = reqwest::Client::new();

        // score-only counts as append.
        dispatch(&client, "ledger", json!({ "workspace_id": "w", "score": 0.1 }))
            .await
            .unwrap();
        // status-only counts as append.
        dispatch(&client, "ledger", json!({ "workspace_id": "w", "status": "crash" }))
            .await
            .unwrap();

        let calls = log.lock().await.clone();
        assert_eq!(calls[0].0, "POST");
        assert_eq!(calls[1].0, "POST");
    }

    #[tokio::test]
    async fn non_success_upstream_stays_available_true_with_error() {
        use axum::http::StatusCode;
        use axum::routing::get;
        use axum::{Json, Router};
        let app = Router::new().route(
            "/experiments",
            get(|| async {
                (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "detail": "engine broke" })))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let _g = crate::UpstreamGuard::set(Some(&addr.to_string()));
        let client = reqwest::Client::new();
        let out = dispatch(&client, "list_experiments", json!({})).await.unwrap();
        // A 5xx is surfaced but the turn stays alive: available:true + error + detail.
        assert_eq!(out["available"], json!(true));
        assert!(out["error"].as_str().unwrap().contains("500"));
        assert_eq!(out["detail"]["detail"], json!("engine broke"));
    }

    #[tokio::test]
    async fn non_json_success_body_is_wrapped_as_raw() {
        use axum::routing::get;
        use axum::Router;
        let app = Router::new().route("/experiments", get(|| async { "plain text" }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let _g = crate::UpstreamGuard::set(Some(&addr.to_string()));
        let client = reqwest::Client::new();
        let out = dispatch(&client, "list_experiments", json!({})).await.unwrap();
        assert_eq!(out["raw"], json!("plain text"));
    }
}
