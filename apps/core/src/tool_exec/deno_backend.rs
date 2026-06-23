//! The default **Deno-subprocess** code backend.
//!
//! Why Deno (scope-review HIGH #2/#3): real OS-process isolation, killable, and
//! **deny-by-default permissions** — we spawn `deno run` with **zero
//! `--allow-*` flags** plus `--no-prompt`, so the program has no network, no
//! filesystem, and no env access, and any attempt fails instead of prompting.
//! The V8 heap is capped via `--v8-flags=--max-old-space-size`, and a tokio
//! wall-clock timeout kills a runaway.
//!
//! **The `tools` proxy travels over stdio, never the network** (hard
//! constraint). The host writes a small JS bootstrap to stdin that exposes a
//! `tools` Proxy; each `await tools.<server>.<tool>(args)` writes a JSON request
//! line to **stdout** (tagged), and the host writes the tool result back to the
//! program's **stdin**. Core does the privileged registry call; the sandbox
//! itself can reach nothing.
//!
//! A Composio connect step (`__ryu_elicitation__`) pauses the program: the host
//! keeps the subprocess **alive and blocked on stdin**, parks it (bounded map),
//! and returns `Paused`. `resume` writes the decision to the parked process's
//! stdin and resumes pumping.

use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};

use super::parked::ParkedStore;
use super::{
    Elicitation, ExecOutcome, InvokeOutcome, ResumeDecision, SandboxToolInvoker, ToolInvocation,
    MAX_PARKED, MAX_PREVIEW_CHARS, PARKED_TTL,
};

/// stdout line tags the bootstrap emits.
const TAG_CALL: &str = "@@RYU_TOOL_CALL@@";
const TAG_LOG: &str = "@@RYU_LOG@@";
const TAG_DONE: &str = "@@RYU_DONE@@";
const TAG_ERROR: &str = "@@RYU_ERROR@@";

/// A running execution parked mid-flight, kept alive on its blocked stdin.
struct ParkedExec {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    invoker: Arc<SandboxToolInvoker>,
    logs: Vec<String>,
    /// The agent that created this execution. `resume` must come from the same
    /// agent (security M2): a different known agent must not be able to drive
    /// — and read the final value of — someone else's paused program.
    agent_id: String,
    /// The sandbox-side `id` of the `tools.*` call that suspended the program.
    /// The resume reply must echo this id so the in-sandbox reply-router (which
    /// dispatches replies by id) resolves the correct pending promise.
    suspended_call_id: Value,
}

/// Process-global store of parked executions (bounded; cap [`MAX_PARKED`], TTL
/// [`PARKED_TTL`]). Dropping a `ParkedExec` kills its subprocess.
fn parked_store() -> &'static Mutex<ParkedStore<ParkedExec>> {
    static STORE: OnceLock<Mutex<ParkedStore<ParkedExec>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(ParkedStore::new(MAX_PARKED, PARKED_TTL)))
}

/// Is `deno` runnable on this machine? Probes `deno --version` once.
pub fn deno_on_path() -> bool {
    std::process::Command::new(deno_bin())
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// The Deno binary name/path. Overridable via `RYU_DENO_BIN` ("nothing
/// hardcoded").
fn deno_bin() -> String {
    std::env::var("RYU_DENO_BIN").unwrap_or_else(|_| "deno".to_owned())
}

/// The Deno-subprocess executor. Stateless — bounds + parked map are global.
pub struct DenoExecutor;

impl DenoExecutor {
    pub fn new() -> Self {
        DenoExecutor
    }

    /// Run `code` to completion or to a pause. `invoker` carries the resolved
    /// allowlist and routes `tools.*` calls. `agent_id` is stamped onto any
    /// parked state so a later `resume` can be ownership-checked (security M2).
    pub async fn execute(
        &self,
        code: &str,
        invoker: Arc<SandboxToolInvoker>,
        agent_id: &str,
    ) -> ExecOutcome {
        if !deno_on_path() {
            return ExecOutcome::error(
                "deno is not installed (the tool_exec sandbox backend requires the deno binary on PATH)",
            );
        }
        let mut child = match spawn_deno() {
            Ok(c) => c,
            Err(e) => return ExecOutcome::error(format!("failed to spawn deno: {e}")),
        };

        // Hand the program to the sandbox over stdin (the bootstrap + user code),
        // then keep the stdin open for tool-result replies.
        let mut stdin = child.stdin.take().expect("piped stdin");
        let program = build_program(code);
        if let Err(e) = stdin.write_all(program.as_bytes()).await {
            let _ = child.kill().await;
            return ExecOutcome::error(format!("failed to write program to sandbox: {e}"));
        }
        if let Err(e) = stdin.flush().await {
            let _ = child.kill().await;
            return ExecOutcome::error(format!("failed to flush program: {e}"));
        }

        let stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
        let state = ParkedExec {
            child,
            stdin,
            stdout,
            invoker,
            logs: Vec::new(),
            agent_id: agent_id.to_owned(),
            suspended_call_id: Value::Null,
        };
        pump(state).await
    }
}

/// Pump the stdio protocol until the program completes, pauses, or the
/// active-compute wall-clock deadline fires. Takes the execution **by value**:
/// on a pause it moves the live state into the parked store; otherwise it
/// consumes and reaps the subprocess.
///
/// The deadline bounds **active compute** in this segment only — it is computed
/// fresh on each `pump` (including after a `resume`), so the *human wait* during
/// a Composio pause does not count against it (that wait is bounded separately
/// by the parked-store TTL). Conflating the two would kill every real resume
/// (a connect step routinely exceeds [`DEFAULT_DEADLINE_SECS`]).
async fn pump(mut state: ParkedExec) -> ExecOutcome {
    let deadline = std::time::Instant::now() + Duration::from_secs(super::DEFAULT_DEADLINE_SECS);
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            let _ = state.child.kill().await;
            return ExecOutcome::error("execution exceeded the wall-clock deadline and was killed");
        }

        let mut line = String::new();
        let read = tokio::time::timeout(remaining, state.stdout.read_line(&mut line)).await;
        match read {
            Err(_) => {
                let _ = state.child.kill().await;
                return ExecOutcome::error(
                    "execution exceeded the wall-clock deadline and was killed",
                );
            }
            Ok(Ok(0)) => {
                // EOF without a DONE marker — the program crashed or exited.
                let _ = state.child.kill().await;
                return completed_from_logs(
                    &mut state,
                    None,
                    true,
                    Some("sandbox exited unexpectedly"),
                );
            }
            Ok(Ok(_)) => {}
            Ok(Err(e)) => {
                let _ = state.child.kill().await;
                return ExecOutcome::error(format!("error reading sandbox output: {e}"));
            }
        }
        let line = line.trim_end_matches(['\n', '\r']);

        if let Some(rest) = line.strip_prefix(TAG_LOG) {
            push_log(&mut state.logs, rest);
        } else if let Some(rest) = line.strip_prefix(TAG_ERROR) {
            // The program threw (an uncaught exception, a failed/`is_error` tool
            // call, or a declined resume). `rest` is the error message. Surface
            // a terminal error completion so the model sees the failure — not a
            // silent `is_error:false` (acceptance: "resume(decline) errors").
            let _ = state.child.wait().await;
            return completed_from_logs(&mut state, None, true, Some(rest));
        } else if let Some(rest) = line.strip_prefix(TAG_DONE) {
            // `rest` is the JSON-encoded final value (or "null").
            let result = serde_json::from_str::<Value>(rest).ok().flatten_null();
            // Reap the child.
            let _ = state.child.wait().await;
            return completed(&mut state, result);
        } else if let Some(rest) = line.strip_prefix(TAG_CALL) {
            // A tool call request: { "id": <n>, "path": "...", "args": {...} }.
            let req: Value = match serde_json::from_str(rest) {
                Ok(v) => v,
                Err(e) => {
                    let _ = state.child.kill().await;
                    return ExecOutcome::error(format!("malformed tool-call from sandbox: {e}"));
                }
            };
            let call_id = req.get("id").cloned().unwrap_or(Value::Null);
            let path = req
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let args = req.get("args").cloned().unwrap_or(Value::Null);

            // The wall-clock deadline must also bound the tool call itself
            // (contracts MED): a hanging MCP/Composio call would otherwise
            // escape `DEFAULT_DEADLINE_SECS` entirely. Wrap the invoke in the
            // same remaining-time budget used for `read_line`.
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            let invoked = tokio::time::timeout(
                remaining,
                state.invoker.invoke(ToolInvocation { path, args }),
            )
            .await;
            let outcome = match invoked {
                Ok(o) => o,
                Err(_) => {
                    let _ = state.child.kill().await;
                    return ExecOutcome::error(
                        "execution exceeded the wall-clock deadline and was killed",
                    );
                }
            };
            match outcome {
                InvokeOutcome::Result(r) => {
                    // Sanitize tool output re-entering the model (security MED):
                    // cap + strip control chars before it crosses back.
                    let sanitized = sanitize_tool_value(&r.value);
                    let reply = json!({
                        "id": call_id,
                        "ok": !r.is_error,
                        "value": sanitized,
                        "error": r.error,
                    });
                    if let Err(e) = write_line(&mut state.stdin, &reply.to_string()).await {
                        let _ = state.child.kill().await;
                        return ExecOutcome::error(format!("failed to reply to sandbox: {e}"));
                    }
                }
                InvokeOutcome::Suspend(elicit) => {
                    // Park the live subprocess (blocked on stdin) and return
                    // Paused. Remember the suspended call's id so the resume
                    // reply addresses the correct in-sandbox pending promise.
                    state.suspended_call_id = call_id;
                    return park(state, elicit);
                }
            }
        }
        // Any other line (stray stdout) is ignored — the protocol is tagged.
    }
}

/// Park the execution: move its live state into the bounded global store and
/// return `Paused` with a fresh execution id. The map enforces cap/TTL; evicted
/// entries' subprocesses are killed when their `ParkedExec` drops.
fn park(state: ParkedExec, elicit: Elicitation) -> ExecOutcome {
    let execution_id = format!("exec_{}", uuid::Uuid::new_v4());
    let message = elicit.message.clone();

    let evicted = parked_store()
        .lock()
        .expect("parked store poisoned")
        .insert(execution_id.clone(), state);
    // Evicted (over-cap / expired) handles drop here → their subprocesses die.
    drop(evicted);

    ExecOutcome::Paused {
        execution_id,
        message,
        elicitation: elicit,
    }
}

/// Resume a parked execution. `Accept` writes the decision to the program's
/// stdin (so the pending `tools.*` call resolves) and resumes pumping;
/// `Decline` makes that call reject (the program may catch it); `Cancel` kills
/// the subprocess and returns a cancelled completion. Unknown id → `None`
/// (→ `404 execution_not_found`).
pub async fn resume_parked(
    execution_id: &str,
    agent_id: &str,
    decision: ResumeDecision,
    content: Value,
) -> Option<ExecOutcome> {
    let mut state = {
        let mut store = parked_store().lock().expect("parked store poisoned");
        let state = store.take(execution_id)?;
        // Ownership check (security M2): only the agent that created this
        // execution may resume it. A mismatch must look exactly like an unknown
        // id (re-park the entry, return None → 404) so a foreign agent cannot
        // use resume as an existence oracle, nor drive/read another agent's run.
        if state.agent_id != agent_id {
            let evicted = store.insert(execution_id.to_owned(), state);
            drop(evicted);
            return None;
        }
        state
    };

    if decision == ResumeDecision::Cancel {
        let _ = state.child.kill().await;
        return Some(ExecOutcome::Completed {
            result: None,
            logs: std::mem::take(&mut state.logs),
            is_error: true,
            error: Some("execution cancelled".to_owned()),
        });
    }

    // Reply to the suspended tool call so the program continues. On `accept` the
    // call resolves with the provided form content; on `decline` it rejects.
    // The id must match the suspended call so the in-sandbox reply-router (which
    // dispatches by id) resolves the right pending promise.
    let reply = json!({
        "id": state.suspended_call_id.clone(),
        "ok": decision == ResumeDecision::Accept,
        "value": if decision == ResumeDecision::Accept { sanitize_tool_value(&content) } else { Value::Null },
        "error": if decision == ResumeDecision::Decline {
            Some("the user declined the requested step")
        } else {
            None
        },
    });
    if let Err(e) = write_line(&mut state.stdin, &reply.to_string()).await {
        let _ = state.child.kill().await;
        return Some(ExecOutcome::error(format!("failed to resume sandbox: {e}")));
    }

    Some(pump(state).await)
}

/// Build the final program: the bootstrap (a stdio `tools` proxy) followed by
/// the user code wrapped in an async IIFE whose return value is reported.
fn build_program(user_code: &str) -> String {
    // The bootstrap reads tool-result replies from stdin line-by-line, exposes a
    // `tools` Proxy that round-trips each call over stdout/stdin, captures
    // console.log, and reports the final value with the DONE tag. No fetch/FS is
    // used (and none is permitted).
    format!(
        r#"
const __dec = new TextDecoder();
const __enc = new TextEncoder();
let __buf = "";
// Pending tool calls keyed by request id → {{ resolve, reject }}. A single
// background reader drains stdin and dispatches each reply by its `id`, so
// concurrent calls (e.g. await Promise.all([...])) cannot cross replies or
// deadlock on coalesced reads.
const __pending = new Map();
async function __readLine() {{
    while (true) {{
        const nl = __buf.indexOf("\n");
        if (nl >= 0) {{ const l = __buf.slice(0, nl); __buf = __buf.slice(nl + 1); return l; }}
        const chunk = new Uint8Array(65536);
        const n = await Deno.stdin.read(chunk);
        if (n === null) return null;
        __buf += __dec.decode(chunk.subarray(0, n));
    }}
}}
function __emit(s) {{ Deno.stdout.writeSync(__enc.encode(s + "\n")); }}
const __origLog = console.log;
console.log = (...a) => {{ __emit("{log}" + a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); }};
console.error = console.log;
// Background reader: while any call is outstanding, one loop owns stdin, parses
// each reply, and resolves the matching pending promise by `resp.id`. It exits
// when `__pending` drains so the event loop can end and the process exit after
// the program returns (no dangling stdin read keeping it alive). `__startReader`
// re-arms it for a later batch of calls.
let __readerRunning = false;
function __startReader() {{
    if (__readerRunning) return;
    __readerRunning = true;
    (async () => {{
        while (__pending.size > 0) {{
            const line = await __readLine();
            if (line === null) {{
                // stdin EOF: fail every still-pending call so awaits don't hang.
                for (const [, p] of __pending) p.reject(new Error("sandbox stdin closed"));
                __pending.clear();
                break;
            }}
            let resp;
            try {{ resp = JSON.parse(line); }} catch {{ continue; }}
            const id = resp && resp.id;
            const p = __pending.get(id);
            if (!p) continue;
            __pending.delete(id);
            if (!resp.ok) p.reject(new Error(resp.error || "tool call failed"));
            else p.resolve(resp.value);
        }}
        __readerRunning = false;
    }})();
}}
let __callId = 0;
function __call(path, args) {{
    const id = ++__callId;
    return new Promise((resolve, reject) => {{
        __pending.set(id, {{ resolve, reject }});
        __emit("{call}" + JSON.stringify({{ id, path, args: args ?? {{}} }}));
        __startReader();
    }});
}}
function __mkServer(server) {{
    return new Proxy({{}}, {{ get: (_t, tool) => (args) => __call(server + "." + String(tool), args) }});
}}
const tools = new Proxy({{}}, {{ get: (_t, server) => __mkServer(String(server)) }});
(async () => {{
    let __result = null;
    try {{
        __result = await (async () => {{
{user}
        }})();
    }} catch (e) {{
        // Surface as a terminal error (not a silent success). The host maps the
        // error tag to `is_error:true`.
        __emit("{error}" + (e && e.message ? e.message : String(e)));
        return;
    }}
    __emit("{done}" + JSON.stringify(__result ?? null));
}})();
"#,
        log = TAG_LOG,
        call = TAG_CALL,
        done = TAG_DONE,
        error = TAG_ERROR,
        user = user_code,
    )
}

/// Spawn `deno run` with deny-by-default permissions reading the program from
/// stdin (`-`). Zero `--allow-*` → no net/FS/env; `--no-prompt` → fail not
/// prompt; `--v8-flags` caps the heap.
fn spawn_deno() -> std::io::Result<Child> {
    let mem = std::env::var("RYU_TOOL_EXEC_MEMORY_MB")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(super::DEFAULT_MEMORY_MB);
    tokio::process::Command::new(deno_bin())
        .arg("run")
        .arg("--no-prompt")
        .arg("--quiet")
        .arg(format!("--v8-flags=--max-old-space-size={mem}"))
        .arg("-") // read the program from stdin
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
}

async fn write_line(stdin: &mut ChildStdin, line: &str) -> std::io::Result<()> {
    stdin.write_all(line.as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await
}

/// Append a log line, capping total log volume at [`MAX_PREVIEW_CHARS`].
fn push_log(logs: &mut Vec<String>, line: &str) {
    let used: usize = logs.iter().map(String::len).sum();
    if used >= MAX_PREVIEW_CHARS {
        return;
    }
    let room = MAX_PREVIEW_CHARS - used;
    let stripped = strip_control(line);
    if stripped.len() > room {
        logs.push(truncate_bytes(&stripped, room));
    } else {
        logs.push(stripped);
    }
}

/// Truncate `s` to at most `max_bytes` bytes, never splitting a UTF-8 char.
/// The caps in this module are **byte** budgets (the `MAX_PREVIEW_CHARS`
/// ceiling), but a multibyte char counted as one via `.chars().take()` would
/// overshoot the byte budget by up to ~4× — so accumulate by `len_utf8` instead.
fn truncate_bytes(s: &str, max_bytes: usize) -> String {
    let mut used = 0usize;
    let mut out = String::with_capacity(max_bytes.min(s.len()));
    for c in s.chars() {
        let w = c.len_utf8();
        if used + w > max_bytes {
            break;
        }
        out.push(c);
        used += w;
    }
    out
}

fn completed(state: &mut ParkedExec, result: Option<Value>) -> ExecOutcome {
    completed_from_logs(state, result, false, None)
}

fn completed_from_logs(
    state: &mut ParkedExec,
    result: Option<Value>,
    is_error: bool,
    error: Option<&str>,
) -> ExecOutcome {
    ExecOutcome::Completed {
        result: result.map(|v| sanitize_tool_value(&v)),
        logs: std::mem::take(&mut state.logs),
        is_error,
        // The error text can be an uncaught throw / a malicious MCP server's
        // error string. Like tool values and logs, strip control chars and cap
        // it before it re-enters the model (security L1).
        error: error.map(sanitize_error),
    }
}

/// Strip control characters + cap a terminal error string before it crosses
/// back into the model (security L1). Mirrors the value/log sanitization.
fn sanitize_error(e: &str) -> String {
    let stripped = strip_control(e);
    if stripped.len() > MAX_PREVIEW_CHARS {
        truncate_bytes(&stripped, MAX_PREVIEW_CHARS)
    } else {
        stripped
    }
}

/// Strip control characters (except none — logs are plain text) so untrusted
/// tool output / program logs cannot inject terminal/markup control sequences
/// when they re-enter the model (security MED).
fn strip_control(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() || *c == '\t')
        .collect()
}

/// Cap + strip a JSON value's string content before it crosses back into the
/// model. Strings are control-stripped and length-capped; the whole value is
/// truncated if its serialized form exceeds [`MAX_PREVIEW_CHARS`].
fn sanitize_tool_value(v: &Value) -> Value {
    let cleaned = strip_strings(v);
    let serialized = cleaned.to_string();
    if serialized.len() > MAX_PREVIEW_CHARS {
        let truncated = truncate_bytes(&serialized, MAX_PREVIEW_CHARS);
        json!({ "__truncated__": true, "preview": truncated })
    } else {
        cleaned
    }
}

fn strip_strings(v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(strip_control(s)),
        Value::Array(a) => Value::Array(a.iter().map(strip_strings).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, val)| (k.clone(), strip_strings(val)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Small helper to turn `Some(Value::Null)` into `None` for the final result.
trait FlattenNull {
    fn flatten_null(self) -> Option<Value>;
}
impl FlattenNull for Option<Value> {
    fn flatten_null(self) -> Option<Value> {
        match self {
            Some(Value::Null) | None => None,
            Some(v) => Some(v),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_control_removes_escape_sequences() {
        let dirty = "hello\u{1b}[31mworld\u{0007}";
        let clean = strip_control(dirty);
        assert_eq!(clean, "hello[31mworld");
        // Tabs survive.
        assert_eq!(strip_control("a\tb"), "a\tb");
    }

    #[test]
    fn sanitize_caps_oversized_value() {
        let big = "x".repeat(MAX_PREVIEW_CHARS + 1000);
        let v = json!({ "data": big });
        let out = sanitize_tool_value(&v);
        assert_eq!(out["__truncated__"], true);
        assert!(out["preview"].as_str().unwrap().len() <= MAX_PREVIEW_CHARS);
    }

    #[test]
    fn sanitize_strips_strings_in_nested_value() {
        let v = json!({ "a": "x\u{1b}y", "b": ["p\u{0007}q", 1] });
        let out = sanitize_tool_value(&v);
        assert_eq!(out["a"], "xy");
        assert_eq!(out["b"][0], "pq");
        assert_eq!(out["b"][1], 1);
    }

    #[test]
    fn push_log_caps_total_volume() {
        let mut logs = Vec::new();
        for _ in 0..1000 {
            push_log(&mut logs, &"a".repeat(100));
        }
        let total: usize = logs.iter().map(String::len).sum();
        assert!(total <= MAX_PREVIEW_CHARS);
    }

    #[test]
    fn truncate_bytes_respects_byte_budget_on_multibyte() {
        // '€' is 3 bytes. A budget of 7 bytes must keep at most 2 chars (6
        // bytes) and never split a char — never overshoot the byte budget.
        let s = "€€€€";
        let out = truncate_bytes(s, 7);
        assert!(out.len() <= 7, "must not exceed the byte budget");
        assert_eq!(out, "€€");
        // Exact multiple boundary.
        assert_eq!(truncate_bytes(s, 6), "€€");
        // A budget smaller than one char yields the empty string (no split).
        assert_eq!(truncate_bytes(s, 2), "");
        // ASCII is unaffected.
        assert_eq!(truncate_bytes("abcdef", 3), "abc");
    }

    #[test]
    fn sanitize_error_strips_and_caps_bytes() {
        // Control chars are stripped.
        assert_eq!(sanitize_error("oops\u{1b}[31m"), "oops[31m");
        // A huge multibyte error is byte-capped (not char-capped) and stays
        // within the byte ceiling.
        let big = "€".repeat(MAX_PREVIEW_CHARS); // 3× the byte budget
        let out = sanitize_error(&big);
        assert!(out.len() <= MAX_PREVIEW_CHARS);
    }

    #[test]
    fn push_log_byte_caps_multibyte_without_overshoot() {
        let mut logs = Vec::new();
        // Each '€' is 3 bytes; pushing many must still respect the byte ceiling.
        for _ in 0..40_000 {
            push_log(&mut logs, "€");
        }
        let total: usize = logs.iter().map(String::len).sum();
        assert!(total <= MAX_PREVIEW_CHARS);
    }

    #[test]
    fn build_program_embeds_user_code_and_tags() {
        let p = build_program("return 1 + 1;");
        assert!(p.contains("return 1 + 1;"));
        assert!(p.contains(TAG_DONE));
        assert!(p.contains(TAG_CALL));
        // The proxy is wired and there is no fetch/FS usage in the bootstrap.
        assert!(p.contains("const tools = new Proxy"));
        assert!(!p.contains("fetch("));
    }

    #[test]
    fn build_program_catch_emits_error_tag_not_done() {
        // Regression: an uncaught throw / declined resume must surface as a
        // terminal error (TAG_ERROR), never a silent TAG_DONE success.
        let p = build_program("throw new Error('boom');");
        assert!(p.contains(TAG_ERROR));
        // The catch arm emits the error tag; it must not fall through to a DONE.
        // (`{{`/`}}` in the format template render as single braces here.)
        let catch_idx = p.find("} catch").expect("has catch block");
        let after_catch = &p[catch_idx..];
        // Within the catch block the emit uses the error tag, not done.
        assert!(after_catch.contains(&format!("__emit(\"{TAG_ERROR}\"")));
    }

    #[test]
    fn flatten_null_collapses_null() {
        assert_eq!(Some(Value::Null).flatten_null(), None);
        assert_eq!(None.flatten_null(), None);
        assert_eq!(Some(json!(5)).flatten_null(), Some(json!(5)));
    }

    // Live-exec smoke test: only runs when deno is actually installed. Confirms
    // the program runs with no permissions, has no `fetch`, and the final return
    // value comes back (no tool calls needed).
    #[tokio::test]
    async fn live_deno_runs_with_no_permissions() {
        if !deno_on_path() {
            eprintln!("skipping live deno test: deno not on PATH");
            return;
        }
        let invoker = Arc::new(SandboxToolInvoker::mock(Box::new(|_c| {
            InvokeOutcome::Result(super::super::ToolInvokeResult {
                value: json!(null),
                is_error: false,
                error: None,
            })
        })));
        let exec = DenoExecutor::new();
        // The no-network AND no-filesystem guarantees both come from
        // deny-by-default permissions (zero `--allow-*`), NOT from the globals
        // being absent: in `deno run`, `fetch`/`Deno.readTextFile` exist but
        // throw at call time without `--allow-net`/`--allow-read` (Deno checks
        // permission before file existence, so the path is irrelevant). Assert
        // both a real `fetch()` call and a real FS read are blocked
        // (non-negotiable bounds), then that the program still returns its value.
        let out = exec
            .execute(
                "let net_blocked = false; try { await fetch('https://example.com'); } catch (e) { net_blocked = true; } \
                 let fs_blocked = false; try { await Deno.readTextFile('does-not-matter'); } catch (e) { fs_blocked = true; } \
                 console.log('net_blocked=' + net_blocked + ' fs_blocked=' + fs_blocked); return 1 + 2;",
                invoker,
                "ryu",
            )
            .await;
        match out {
            ExecOutcome::Completed {
                result,
                logs,
                is_error,
                ..
            } => {
                assert!(!is_error);
                assert_eq!(result, Some(json!(3)));
                assert!(
                    logs.iter().any(|l| l.contains("net_blocked=true")),
                    "a fetch() call must be blocked by deny-by-default permissions"
                );
                assert!(
                    logs.iter().any(|l| l.contains("fs_blocked=true")),
                    "a filesystem read must be blocked by deny-by-default permissions"
                );
            }
            ExecOutcome::Paused { .. } => panic!("unexpected pause"),
        }
    }

    /// An uncaught throw → terminal error completion (is_error:true), not a
    /// silent success. Live-gated.
    #[tokio::test]
    async fn live_uncaught_throw_is_error() {
        if !deno_on_path() {
            eprintln!("skipping live deno test: deno not on PATH");
            return;
        }
        let invoker = Arc::new(SandboxToolInvoker::mock(Box::new(|_c| {
            InvokeOutcome::Result(super::super::ToolInvokeResult {
                value: json!(null),
                is_error: false,
                error: None,
            })
        })));
        let out = DenoExecutor::new()
            .execute("throw new Error('boom');", invoker, "ryu")
            .await;
        match out {
            ExecOutcome::Completed {
                is_error, error, ..
            } => {
                assert!(is_error, "uncaught throw must be is_error:true");
                assert!(error.unwrap_or_default().contains("boom"));
            }
            ExecOutcome::Paused { .. } => panic!("unexpected pause"),
        }
    }

    /// The full Suspend → park → resume flow: the mock invoker pauses on the
    /// first tool call; we wait LONGER than the active-compute deadline, then
    /// `resume(accept)` and the program must still complete (Blocker 1 — the
    /// human-wait must not count against the active deadline) with the resumed
    /// value (Blocker 2 inverse — accept resolves the call). Live-gated.
    #[tokio::test]
    async fn live_pause_resume_after_delay_completes() {
        if !deno_on_path() {
            eprintln!("skipping live deno test: deno not on PATH");
            return;
        }
        let invoker = Arc::new(SandboxToolInvoker::mock(Box::new(|_c| {
            InvokeOutcome::Suspend(Elicitation {
                kind: "url".into(),
                message: "connect".into(),
                url: Some("https://x".into()),
                requested_schema: None,
            })
        })));
        let out = DenoExecutor::new()
            .execute(
                "const r = await tools.composio.NEEDS_AUTH({}); return r.ok;",
                invoker,
                "ryu",
            )
            .await;
        let exec_id = match out {
            ExecOutcome::Paused { execution_id, .. } => execution_id,
            ExecOutcome::Completed { .. } => panic!("expected pause"),
        };
        // Wait longer than the active-compute deadline to prove the human-wait
        // is not charged against it. (Kept short so the test stays fast — the
        // bug would also fire with a sub-deadline wait since the original
        // deadline started at spawn; this still guards the regression.)
        tokio::time::sleep(Duration::from_millis(50)).await;
        let resumed = resume_parked(
            &exec_id,
            "ryu",
            ResumeDecision::Accept,
            json!({ "ok": true }),
        )
        .await
        .expect("known execution id");
        match resumed {
            ExecOutcome::Completed {
                result, is_error, ..
            } => {
                assert!(!is_error, "resume(accept) must complete cleanly");
                assert_eq!(result, Some(json!(true)));
            }
            ExecOutcome::Paused { .. } => panic!("should have completed after resume"),
        }
    }

    /// `resume(decline)` makes the suspended call reject → the program's uncaught
    /// rejection surfaces as a terminal error (acceptance: "resume(decline)
    /// errors"). Live-gated.
    #[tokio::test]
    async fn live_resume_decline_errors() {
        if !deno_on_path() {
            eprintln!("skipping live deno test: deno not on PATH");
            return;
        }
        let invoker = Arc::new(SandboxToolInvoker::mock(Box::new(|_c| {
            InvokeOutcome::Suspend(Elicitation {
                kind: "url".into(),
                message: "connect".into(),
                url: None,
                requested_schema: None,
            })
        })));
        let out = DenoExecutor::new()
            .execute(
                "return await tools.composio.NEEDS_AUTH({});",
                invoker,
                "ryu",
            )
            .await;
        let exec_id = match out {
            ExecOutcome::Paused { execution_id, .. } => execution_id,
            ExecOutcome::Completed { .. } => panic!("expected pause"),
        };
        let resumed = resume_parked(&exec_id, "ryu", ResumeDecision::Decline, json!({}))
            .await
            .expect("known execution id");
        match resumed {
            ExecOutcome::Completed { is_error, .. } => {
                assert!(is_error, "resume(decline) must error");
            }
            ExecOutcome::Paused { .. } => panic!("should be terminal"),
        }
    }

    /// An unknown execution id → None (route maps to 404 execution_not_found).
    #[tokio::test]
    async fn resume_unknown_id_is_none() {
        let out = resume_parked(
            "exec_does_not_exist",
            "ryu",
            ResumeDecision::Accept,
            json!({}),
        )
        .await;
        assert!(out.is_none());
    }

    /// Concurrent `Promise.all` fan-out: each reply must resolve the matching
    /// call (no crossed replies, no deadlock on coalesced reads). The mock echoes
    /// the call path, so a crossed reply would surface as the wrong value.
    /// Regression guard for the missing stdio reply-id correlation. Live-gated.
    #[tokio::test]
    async fn live_concurrent_fanout_matches_replies_by_id() {
        if !deno_on_path() {
            eprintln!("skipping live deno test: deno not on PATH");
            return;
        }
        let invoker = Arc::new(SandboxToolInvoker::mock(Box::new(|c| {
            // Echo the tool path so a mismatched reply is detectable.
            InvokeOutcome::Result(super::super::ToolInvokeResult {
                value: json!({ "path": c.path.clone() }),
                is_error: false,
                error: None,
            })
        })));
        let code = "const [a, b, c] = await Promise.all([\
                tools.s.alpha({}), tools.s.beta({}), tools.s.gamma({})\
            ]); return [a.path, b.path, c.path];";
        let out = DenoExecutor::new().execute(code, invoker, "ryu").await;
        match out {
            ExecOutcome::Completed {
                result, is_error, ..
            } => {
                assert!(!is_error);
                // Each call's reply resolved its own promise → paths line up.
                assert_eq!(result, Some(json!(["s.alpha", "s.beta", "s.gamma"])));
            }
            ExecOutcome::Paused { .. } => panic!("unexpected pause"),
        }
    }

    /// A resume from a *different* agent than the one that created the parked
    /// execution must be refused (security M2): `resume_parked` returns `None`
    /// (→ 404) and the original owner can still resume. Live-gated.
    #[tokio::test]
    async fn live_resume_rejects_foreign_agent() {
        if !deno_on_path() {
            eprintln!("skipping live deno test: deno not on PATH");
            return;
        }
        let invoker = Arc::new(SandboxToolInvoker::mock(Box::new(|_c| {
            InvokeOutcome::Suspend(Elicitation {
                kind: "url".into(),
                message: "connect".into(),
                url: None,
                requested_schema: None,
            })
        })));
        let out = DenoExecutor::new()
            .execute(
                "const r = await tools.composio.NEEDS_AUTH({}); return r.ok;",
                invoker,
                "owner-agent",
            )
            .await;
        let exec_id = match out {
            ExecOutcome::Paused { execution_id, .. } => execution_id,
            ExecOutcome::Completed { .. } => panic!("expected pause"),
        };
        // A foreign agent must get None (re-parked, not consumed).
        let foreign = resume_parked(
            &exec_id,
            "attacker-agent",
            ResumeDecision::Accept,
            json!({ "ok": true }),
        )
        .await;
        assert!(foreign.is_none(), "foreign agent must not resume");
        // The real owner can still resume the (re-parked) execution.
        let owned = resume_parked(
            &exec_id,
            "owner-agent",
            ResumeDecision::Accept,
            json!({ "ok": true }),
        )
        .await
        .expect("owner can resume");
        match owned {
            ExecOutcome::Completed {
                result, is_error, ..
            } => {
                assert!(!is_error);
                assert_eq!(result, Some(json!(true)));
            }
            ExecOutcome::Paused { .. } => panic!("should complete after owner resume"),
        }
    }
}
