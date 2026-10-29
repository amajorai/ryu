//! **Code evaluators** (unified-evaluator plan, P4).
//!
//! A *code evaluator* is a user function
//! `(input, output, expected, vars) -> {score: 0..1, pass?: bool, detail?: string}`
//! that scores one eval case. It runs in one of two isolated runtimes:
//!
//! - **JS** — the same deny-all WebAssembly sandbox the PTC tool-exec path uses
//!   (QuickJS in Wasmtime: no net/FS/env, deadline-bounded), but with **no tool
//!   bridge**: the payload is embedded and the return value is reported back
//!   ([`ryu_tool_exec::run_eval_js`]). We do NOT weaken the tool-exec sandbox.
//! - **Python** — routed through the swappable [`ryu_sandbox`] crate's
//!   command-backend abstraction (deny-all caps, stdin = payload JSON) when a
//!   command-capable backend (docker/daytona/…) is configured **and** live.
//!   When none is, a release build **refuses** the evaluator
//!   (`executed:false`) rather than running user python on the host; the bare
//!   host-`python` subprocess is opt-in only
//!   ([`ENV_ALLOW_UNSANDBOXED_PYTHON`]) and every outcome it produces is tagged
//!   [`UNSANDBOXED_DETAIL_TAG`] on the wire. If python is unavailable at all, the
//!   evaluator is honestly reported as `executed:false` rather than faked.
//!
//! **Why the python arm is fail-closed.** The default sandbox backend is
//! `wasmtime`, which is a WASM-*module* runner — `build_command_backend` rejects
//! it outright — so "no command-capable backend" is not an edge case, it is the
//! out-of-the-box configuration of every node that has not installed docker or
//! configured daytona. The old code answered that by executing the user's python
//! on the host behind a single `tracing::warn!`, i.e. the shipped default was
//! "arbitrary code, no isolation, no notice". Guardrails elsewhere in the tree
//! fail *open* because availability wins; executing code is the inverse case, and
//! the tree already draws that line the same way
//! (`plugins::lifecycle::stub_may_approve` refuses arbitrary-code-execution
//! grants in release builds even when the stub seam is on). The JS arm has always
//! behaved this way — no sandbox ⇒ `skipped`, never a host fallback — so this makes
//! the two languages agree.
//!
//! **Core-vs-Gateway placement:** code execution is a *Core* capability, so the
//! Gateway's offline eval runner (`POST /v1/evals/run`) marks `Code` evaluators
//! `executed:false` and Core — which already proxies the run
//! (`POST /api/gateway/evals/run`) — executes them and merges the real scores in
//! ([`merge_code_evaluators`]). Nothing here touches the gateway crate.

use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

mod env_scrub;
mod win_process;

use crate::win_process::NoWindow;

/// The base Python interpreter for the un-sandboxed host fallback: `python` on
/// Windows, `python3` elsewhere. A focused copy of
/// `apps/core::sidecar::external_runtime::bootstrap_python` (a trivial OS switch,
/// no state) kept here so this crate has ZERO dependency on `apps/core`.
fn bootstrap_python() -> &'static str {
    if cfg!(target_os = "windows") {
        "python"
    } else {
        "python3"
    }
}

/// Per-eval wall-clock ceiling. Deliberately small — NOT the 30 s tool-exec
/// per-*run* ceiling: a dataset run multiplies this by cases × evaluators, so it
/// must stay tight or the proxy could hang for minutes after the gateway leg
/// already returned. See also [`EVAL_TOTAL_BUDGET_SECS`].
pub const EVAL_PER_CALL_DEADLINE_SECS: u64 = 5;

/// Total wall-clock budget for ALL code-eval work merged into a single
/// `POST /api/gateway/evals/run` response. Once spent, remaining evals return
/// `executed:false` ("budget exhausted") so a large dataset can never hang the
/// proxy unboundedly.
pub const EVAL_TOTAL_BUDGET_SECS: u64 = 60;

/// The language a code evaluator is written in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeEvalLang {
    Js,
    Python,
}

impl CodeEvalLang {
    /// Parse a lang tag (case-insensitive; common aliases accepted). `None` for
    /// an unrecognised language so the caller can report it honestly.
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            // JavaScript only: the sandbox runs no TypeScript transpiler, so a
            // `ts` tag is unrecognised rather than failing on its first annotation.
            "js" | "javascript" => Some(Self::Js),
            "py" | "python" | "python3" => Some(Self::Python),
            _ => None,
        }
    }
}

/// A user-authored code evaluator, supplied per eval-run request. Never sent to
/// the gateway — Core strips it from the forwarded body and runs it here.
#[derive(Debug, Clone, Deserialize)]
pub struct CodeEvaluatorSpec {
    /// Stable id — matched against the gateway's placeholder `EvaluatorScore` so
    /// the real score replaces the `executed:false` stub in place.
    pub id: String,
    /// `"js"` | `"python"` (aliases accepted, see [`CodeEvalLang::parse`]).
    pub lang: String,
    /// The user function source.
    pub source: String,
    /// Optional target case index used for Promptfoo inline code assertions.
    /// Run-level custom evaluators leave this unset and score every case.
    #[serde(default)]
    pub case_index: Option<usize>,
    /// Optional target assertion index used when this spec represents an inline
    /// JavaScript/Python assertion rather than a run-level evaluator.
    #[serde(default)]
    pub assertion_index: Option<usize>,
}

/// Per-case data pulled from the request dataset to enrich the payload with
/// `expected` + `vars` (the gateway's response case only carries `prompt` +
/// `response_text`). Matched to a response case by index.
#[derive(Debug, Clone, Default)]
pub struct CaseInput {
    pub expected: Option<Value>,
    pub context: Option<Value>,
    pub vars: Value,
}

impl CaseInput {
    /// Extract `{expected, vars}` from one request-dataset case value.
    pub fn from_case(v: &Value) -> Self {
        Self {
            expected: v.get("expected").cloned().filter(|e| !e.is_null()),
            context: v.get("context").cloned().filter(|e| !e.is_null()),
            vars: v.get("vars").cloned().unwrap_or_else(|| json!({})),
        }
    }
}

/// The result of running one code evaluator against one case.
#[derive(Debug, Clone)]
pub struct CodeEvalOutcome {
    /// Score in `[0,1]` when the evaluator executed and returned a numeric score.
    pub score: Option<f32>,
    /// Pass verdict (explicit, else derived from `score >= 0.5`).
    pub pass: Option<bool>,
    /// Human-readable detail (the evaluator's own `detail`, or a skip note).
    pub detail: String,
    /// Honesty flag: `true` only when a real score was computed.
    pub executed: bool,
    /// Failure/skip reason, when `executed == false`.
    pub error: Option<String>,
    /// `true` when this outcome came from the opt-in un-sandboxed host-python
    /// fallback. Kept as its own field rather than baked into `detail` so the
    /// evaluator's own `detail` stays verbatim for callers; [`Self::display_detail`]
    /// folds [`UNSANDBOXED_DETAIL_TAG`] in for the wire, which is where a human
    /// reads it.
    pub unsandboxed: bool,
}

impl CodeEvalOutcome {
    /// Not executed for a benign reason (unavailable runtime, budget exhausted).
    fn skipped(detail: impl Into<String>) -> Self {
        let d = detail.into();
        Self {
            score: None,
            pass: None,
            detail: d.clone(),
            executed: false,
            error: Some(d),
            unsandboxed: false,
        }
    }

    /// Executed but failed (threw, exited non-zero, unparseable output, timeout).
    fn failed(error: impl Into<String>) -> Self {
        let e = error.into();
        Self {
            score: None,
            pass: None,
            detail: String::new(),
            executed: false,
            error: Some(e),
            unsandboxed: false,
        }
    }

    /// Parse the evaluator's returned Promptfoo-compatible result.
    ///
    /// Promptfoo accepts a boolean, numeric score, or grading-result object;
    /// accepting all three here keeps imported `javascript`/`python` assertions
    /// executable instead of forcing users to rewrite the common
    /// `output.includes(...)` form into a Ryu-specific object.
    fn from_return(v: &Value) -> Self {
        let (score, pass, detail) = match v {
            Value::Bool(pass) => {
                let score = if *pass { 1.0 } else { 0.0 };
                (score, *pass, String::new())
            }
            Value::Number(number) => match number.as_f64() {
                Some(score) if score.is_finite() => {
                    let score = (score as f32).clamp(0.0, 1.0);
                    (score, score >= 0.5, String::new())
                }
                _ => return Self::failed("evaluator return is not a finite numeric score"),
            },
            Value::Object(obj) => {
                let score = match obj.get("score").and_then(Value::as_f64) {
                    Some(score) if score.is_finite() => (score as f32).clamp(0.0, 1.0),
                    _ => {
                        return Self::failed("evaluator return is missing a finite numeric 'score'")
                    }
                };
                let pass = obj
                    .get("pass")
                    .and_then(Value::as_bool)
                    .unwrap_or(score >= 0.5);
                let detail = obj
                    .get("detail")
                    .or_else(|| obj.get("reason"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                (score, pass, detail)
            }
            _ => {
                return Self::failed(
                    "evaluator must return a boolean, number, or object with a numeric 'score'",
                )
            }
        };
        Self {
            score: Some(score),
            pass: Some(pass),
            detail,
            executed: true,
            error: None,
            unsandboxed: false,
        }
    }

    /// Mark an outcome as having come from the un-sandboxed host-python fallback.
    /// Applied to whatever the subprocess produced (score, failure, or timeout) so
    /// the tag cannot be lost on the error paths.
    fn marked_unsandboxed(mut self) -> Self {
        self.unsandboxed = true;
        self
    }

    /// The `detail` string to surface on the wire `EvaluatorScore` (folds any
    /// error in so a skip/failure is legible, not silent — and prefixes
    /// [`UNSANDBOXED_DETAIL_TAG`] when the score was produced without isolation,
    /// so "this number came from code we ran on the host" is visible next to the
    /// number rather than buried in a log line nobody reads).
    fn display_detail(&self) -> String {
        let base = match (&self.error, self.detail.is_empty()) {
            (Some(e), true) => e.clone(),
            (Some(e), false) => format!("{}: {}", self.detail, e),
            (None, _) => self.detail.clone(),
        };
        if !self.unsandboxed {
            return base;
        }
        if base.is_empty() {
            UNSANDBOXED_DETAIL_TAG.to_owned()
        } else {
            format!("{UNSANDBOXED_DETAIL_TAG} {base}")
        }
    }
}

/// Run one code evaluator against one `payload` (`{input, output, expected,
/// vars, context}`), bounded by `timeout`. Never panics; never hangs past
/// `timeout`.
pub async fn run_code_evaluator(
    lang: CodeEvalLang,
    source: &str,
    payload: &Value,
    timeout: Duration,
) -> CodeEvalOutcome {
    match lang {
        CodeEvalLang::Js => run_js(source, payload, timeout).await,
        CodeEvalLang::Python => run_python(source, payload, timeout).await,
    }
}

// ── JS ───────────────────────────────────────────────────────────────────────

#[cfg(feature = "js-sandbox")]
async fn run_js(source: &str, payload: &Value, timeout: Duration) -> CodeEvalOutcome {
    match ryu_tool_exec::run_eval_js(source, payload, timeout).await {
        ryu_tool_exec::EvalJsOutcome::Value(v) => CodeEvalOutcome::from_return(&v),
        ryu_tool_exec::EvalJsOutcome::Error(e) => CodeEvalOutcome::failed(e),
    }
}

#[cfg(not(feature = "js-sandbox"))]
async fn run_js(_source: &str, _payload: &Value, _timeout: Duration) -> CodeEvalOutcome {
    CodeEvalOutcome::skipped(
        "JS code evaluators require the js-sandbox backend, which is not built",
    )
}

// ── Python ─────────────────────────────────────────────────────────────────────

/// Env var that opts a node **into** running python code evaluators as a bare
/// host subprocess when no command-capable sandbox backend is live. Truthy values:
/// `1`/`true`/`yes`/`on` (case-insensitive); anything else, including unset, keeps
/// the fail-closed default.
///
/// This is a deliberate escape hatch, not a config knob to reach for: setting it
/// means "user-authored python from an eval request may execute on this host with
/// the host's filesystem and network". The alternative — install docker or point
/// `RYU_SANDBOX_BACKEND`/the sandbox picker at daytona — is the supported path.
pub const ENV_ALLOW_UNSANDBOXED_PYTHON: &str = "RYU_EVAL_ALLOW_UNSANDBOXED_PYTHON";

/// Prefix stamped onto the wire `detail` of every score the un-sandboxed host
/// fallback produced (see [`CodeEvalOutcome::display_detail`]).
pub const UNSANDBOXED_DETAIL_TAG: &str = "[unsandboxed: host python]";

/// What to do when no command-capable sandbox backend is live.
#[derive(Debug, Clone, PartialEq, Eq)]
enum HostFallback {
    /// Refuse the evaluator, reporting this reason as an `executed:false` skip.
    Refuse(String),
    /// Run it on the host, tagged [`UNSANDBOXED_DETAIL_TAG`].
    AllowUnsandboxed,
}

/// Parse the [`ENV_ALLOW_UNSANDBOXED_PYTHON`] opt-in. Split out from the env read
/// so the truthy set is pinned by a test rather than by whatever the host
/// environment happens to hold.
fn unsandboxed_opt_in(raw: Option<&str>) -> bool {
    matches!(
        raw.map(|s| s.trim().to_ascii_lowercase()).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// The refuse-or-allow rule, split out so it is testable on its own.
/// [`host_fallback`] itself cannot be meaningfully asserted from this crate's test
/// suite: it is gated on `cfg!(debug_assertions)`, which is always true under
/// `cargo test`, so the fallback always looks allowed there and a test would pass
/// whether or not the release build refuses. Testing the rule directly is what
/// actually pins the posture. (Same shape, and the same reason, as
/// `apps/core::plugins::lifecycle::is_arbitrary_code_execution_grant`.)
fn host_fallback_rule(backend_name: &str, opted_in: bool, debug_build: bool) -> HostFallback {
    if opted_in || debug_build {
        return HostFallback::AllowUnsandboxed;
    }
    HostFallback::Refuse(format!(
        "python code evaluators need a command-capable sandbox backend (docker/daytona); the \
         configured backend '{backend_name}' cannot run commands, and this evaluator was refused \
         rather than executed unsandboxed on the host. Configure docker/daytona, or set \
         {ENV_ALLOW_UNSANDBOXED_PYTHON}=1 to accept the un-sandboxed host fallback."
    ))
}

/// [`host_fallback_rule`] against the live environment.
///
/// Debug builds always allow the fallback: this crate's own python runtime tests
/// (`tests.rs`) drive `run_code_evaluator` with no sandbox configured and must keep
/// exercising the subprocess executor, and the integration harness runs unshipped
/// debug binaries. Release builds — everything a user installs — refuse unless the
/// operator opted in.
fn host_fallback(backend_name: &str) -> HostFallback {
    let raw = std::env::var(ENV_ALLOW_UNSANDBOXED_PYTHON).ok();
    host_fallback_rule(
        backend_name,
        unsandboxed_opt_in(raw.as_deref()),
        cfg!(debug_assertions),
    )
}

async fn run_python(source: &str, payload: &Value, timeout: Duration) -> CodeEvalOutcome {
    use ryu_sandbox::{build_command_backend, configured_backend, detect_backend, ExecSpec};

    let script = build_python_script(source);
    let payload_bytes = serde_json::to_vec(payload).unwrap_or_else(|_| b"{}".to_vec());
    let secs = timeout.as_secs().max(1);

    // Prefer a command-capable sandbox backend when one is configured AND live.
    // `build_command_backend` returns `Ok` for docker/daytona/etc. even when the
    // daemon is down (reachability is a separate probe) — so we MUST `detect`
    // before committing, else a configured-but-unavailable backend would fail
    // every python eval instead of falling through to the subprocess path.
    let backend = configured_backend();
    if let Ok(sandbox) = build_command_backend(&backend) {
        if detect_backend(backend.as_str()).await {
            let mut spec = ExecSpec::new("python", vec!["-c".to_owned(), script.clone()]);
            spec.stdin = Some(payload_bytes.clone());
            spec.timeout_secs = Some(secs);
            return match sandbox.exec(spec).await {
                Ok(out) => outcome_from_python(out.exit_code, &out.stdout, &out.stderr),
                Err(e) => CodeEvalOutcome::failed(format!(
                    "python sandbox '{}' exec failed: {e}",
                    backend.as_str()
                )),
            };
        }
    }

    // No live command-capable backend. This is the DEFAULT configuration, not an
    // edge case: `wasmtime` (the built-in default backend) runs WASM modules, so
    // `build_command_backend` rejects it and we land here on any node without
    // docker/daytona. Refuse unless the operator opted in — see `host_fallback`.
    if let HostFallback::Refuse(reason) = host_fallback(backend.as_str()) {
        tracing::warn!(
            backend = backend.as_str(),
            "refused a python code evaluator: no command-capable sandbox backend is live and the \
             un-sandboxed host fallback is not enabled ({ENV_ALLOW_UNSANDBOXED_PYTHON})"
        );
        return CodeEvalOutcome::skipped(reason);
    }

    // Opted in (or a debug build): bare host subprocess — NOT sandbox-isolated.
    // Logged AND tagged onto the outcome, so the score itself carries the notice.
    if !python_on_path() {
        return CodeEvalOutcome::skipped(
            "python is unavailable on PATH and no command-capable sandbox backend is configured; python evaluator skipped",
        );
    }
    tracing::warn!(
        "running a python code evaluator via a bare host subprocess (NOT sandbox-isolated); \
         configure a command-capable sandbox backend (docker/daytona) for real isolation"
    );
    run_python_subprocess(&script, &payload_bytes, timeout)
        .await
        .marked_unsandboxed()
}

/// Wrap the user python: read the payload JSON from stdin, bind `ctx` +
/// `input`/`output`/`expected`/`vars`/`context`, then run the user source.
/// Promptfoo-compatible sources may print a JSON boolean, number, or grading
/// result object.
fn build_python_script(user_source: &str) -> String {
    // The preamble is fixed and indentation-free; the user source runs at module
    // level (no added indentation, so pasted code keeps its own structure).
    format!(
        "import sys, json\n\
         _payload = json.loads(sys.stdin.read() or \"{{}}\")\n\
         ctx = _payload\n\
         input = _payload.get(\"input\")\n\
         output = _payload.get(\"output\")\n\
         expected = _payload.get(\"expected\")\n\
         vars = _payload.get(\"vars\") or {{}}\n\
         context = _payload\n\
         metadata = _payload.get(\"metadata\") or {{}}\n\
         # ---- user evaluator source ----\n\
         {user}\n",
        user = user_source
    )
}

fn python_on_path() -> bool {
    use std::process::Stdio;
    std::process::Command::new(bootstrap_python())
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .no_window()
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

async fn run_python_subprocess(script: &str, payload: &[u8], timeout: Duration) -> CodeEvalOutcome {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;

    // Scrub secrets from the inherited env (mirrors the sandbox's child spawn) but keep the
    // non-secret vars python needs (PATH so the interpreter resolves, etc.).
    let scrubbed = crate::env_scrub::scrub_child_env(std::env::vars(), &[]);
    let mut child = match tokio::process::Command::new(bootstrap_python())
        // `-I` = isolated mode: ignore PYTHON* env, don't add cwd/script dir to
        // sys.path, no user site. Hardens the (unavoidably un-sandboxed) host run.
        .arg("-I")
        .arg("-c")
        .arg(script)
        .env_clear()
        .envs(scrubbed)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .no_window()
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return CodeEvalOutcome::skipped(format!("failed to spawn python: {e}")),
    };

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(payload).await;
        let _ = stdin.shutdown().await;
        drop(stdin);
    }

    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(out)) => {
            outcome_from_python(out.status.code().unwrap_or(-1), &out.stdout, &out.stderr)
        }
        Ok(Err(e)) => CodeEvalOutcome::failed(format!("python subprocess error: {e}")),
        // The future (and the child it owns) drops here → `kill_on_drop` fires.
        Err(_) => CodeEvalOutcome::failed(
            "python evaluator exceeded the wall-clock deadline and was killed",
        ),
    }
}

/// Parse python output: the LAST stdout line that JSON-parses to a Promptfoo
/// boolean, number, or grading-result object. On none, fail with a stderr
/// snippet so the reason is legible.
fn outcome_from_python(exit_code: i32, stdout: &[u8], stderr: &[u8]) -> CodeEvalOutcome {
    let stdout_s = String::from_utf8_lossy(stdout);
    for line in stdout_s.lines().rev() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(t) {
            if v.is_boolean() || v.is_number() || v.get("score").is_some() {
                return CodeEvalOutcome::from_return(&v);
            }
        }
    }
    let err = String::from_utf8_lossy(stderr);
    let snippet = tail(err.trim(), 400);
    let msg = if exit_code != 0 {
        if snippet.is_empty() {
            format!("python evaluator exited {exit_code} without printing a JSON score")
        } else {
            format!("python evaluator exited {exit_code}: {snippet}")
        }
    } else if snippet.is_empty() {
        "python evaluator printed no parseable JSON score".to_owned()
    } else {
        format!("python evaluator printed no parseable JSON score (stderr: {snippet})")
    };
    CodeEvalOutcome::failed(msg)
}

/// Last `max` chars of `s` (for bounded error snippets).
fn tail(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        s.to_owned()
    } else {
        chars[chars.len() - max..].iter().collect()
    }
}

// ── Merge into the gateway eval-run response ───────────────────────────────────

/// Run every `spec` over each case in the gateway's eval-run `response` and merge
/// the real scores in, replacing the gateway's `executed:false` `Code`
/// placeholders and re-aggregating the affected evaluator ids.
///
/// Structure handled (both shapes the gateway can return):
/// - single-model: top-level `cases` + `aggregate`;
/// - multi-model: a `models[]` array (each `{model, cases, aggregate}`), with the
///   top-level `cases`/`aggregate` mirroring `models[0]`.
///
/// To avoid double-running the code evaluators on `models[0]` (wasted budget +
/// possible divergence for non-deterministic evaluators), the multi-model path
/// merges each `models[]` entry once, then mirrors the merged `models[0]` back
/// into the top-level fields.
pub async fn merge_code_evaluators(
    response: &mut Value,
    dataset: &[CaseInput],
    specs: &[CodeEvaluatorSpec],
) {
    if specs.is_empty() {
        return;
    }
    let budget = Instant::now() + Duration::from_secs(EVAL_TOTAL_BUDGET_SECS);
    let per_call = Duration::from_secs(EVAL_PER_CALL_DEADLINE_SECS);

    let has_models = response
        .get("models")
        .and_then(Value::as_array)
        .is_some_and(|a| !a.is_empty());

    if has_models {
        // Take the models array out to merge each entry, then put it back.
        let mut models = response
            .get_mut("models")
            .and_then(Value::as_array_mut)
            .map(std::mem::take)
            .unwrap_or_default();
        for model in &mut models {
            merge_block(model, dataset, specs, per_call, budget).await;
        }
        // Mirror the merged models[0] into the top-level back-compat fields.
        if let Some(first) = models.first() {
            let cases = first.get("cases").cloned();
            let aggregate = first.get("aggregate").cloned();
            if let Some(obj) = response.as_object_mut() {
                if let Some(cases) = cases {
                    obj.insert("cases".to_owned(), cases);
                }
                if let Some(aggregate) = aggregate {
                    obj.insert("aggregate".to_owned(), aggregate);
                }
            }
        }
        if let Some(obj) = response.as_object_mut() {
            obj.insert("models".to_owned(), Value::Array(models));
        }
    } else {
        merge_block(response, dataset, specs, per_call, budget).await;
    }
}

/// Execute Core-owned inline JavaScript/Python assertions and replace the
/// Gateway's defensive `executed:false` assertion result in place. The same
/// bounded runner and evaluator payload are used as run-level code evaluators;
/// `case_index`/`assertion_index` keep a per-case assertion from being applied
/// to unrelated cases.
pub async fn merge_inline_code_assertions(
    response: &mut Value,
    dataset: &[CaseInput],
    specs: &[CodeEvaluatorSpec],
) {
    if specs.is_empty() {
        return;
    }
    merge_code_evaluators(response, dataset, specs).await;
    patch_inline_assertions(response, specs);
}

fn patch_inline_assertions(response: &mut Value, specs: &[CodeEvaluatorSpec]) {
    if let Some(cases) = response.get_mut("cases").and_then(Value::as_array_mut) {
        patch_inline_block(cases, specs);
    }
    if let Some(models) = response.get_mut("models").and_then(Value::as_array_mut) {
        for model in models {
            if let Some(cases) = model.get_mut("cases").and_then(Value::as_array_mut) {
                patch_inline_block(cases, specs);
            }
        }
    }
}

fn patch_inline_block(cases: &mut [Value], specs: &[CodeEvaluatorSpec]) {
    for (case_index, case) in cases.iter_mut().enumerate() {
        let Some(evaluators) = case.get("evaluators").and_then(Value::as_array).cloned() else {
            continue;
        };
        let mut patched_any = false;
        {
            let Some(assertions) = case.get_mut("assertions").and_then(Value::as_array_mut) else {
                continue;
            };
            for spec in specs {
                if spec.case_index != Some(case_index) {
                    continue;
                }
                let Some(assertion_index) = spec.assertion_index else {
                    continue;
                };
                let Some(score) = evaluators.iter().find(|entry| {
                    entry.get("id").and_then(Value::as_str) == Some(spec.id.as_str())
                }) else {
                    continue;
                };
                let Some(assertion) = assertions.get_mut(assertion_index) else {
                    continue;
                };
                let Some(object) = assertion.as_object_mut() else {
                    continue;
                };
                for field in ["detail", "executed", "pass", "score"] {
                    if let Some(value) = score.get(field) {
                        object.insert(field.to_owned(), value.clone());
                    }
                }
                patched_any = true;
            }
        }
        if !patched_any {
            continue;
        }
        let Some(assertions) = case.get("assertions").and_then(Value::as_array) else {
            continue;
        };
        if assertions.is_empty() {
            continue;
        }
        let score = assertions
            .iter()
            .map(|assertion| {
                assertion
                    .get("score")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
            })
            .sum::<f64>()
            / assertions.len() as f64;
        let pass = assertions.iter().all(|assertion| {
            assertion.get("executed").and_then(Value::as_bool) == Some(true)
                && assertion.get("pass").and_then(Value::as_bool) == Some(true)
        });
        if let Some(object) = case.as_object_mut() {
            object.insert("assertion_score".to_owned(), Value::from(score));
            object.insert("assertions_pass".to_owned(), Value::Bool(pass));
        }
    }
}

/// Merge specs into one block that carries `cases` (array) + `aggregate` (object).
async fn merge_block(
    block: &mut Value,
    dataset: &[CaseInput],
    specs: &[CodeEvaluatorSpec],
    per_call: Duration,
    budget: Instant,
) {
    // 1. Score each case (mutable borrow of `cases` is scoped to this block).
    {
        let Some(cases) = block.get_mut("cases").and_then(Value::as_array_mut) else {
            return;
        };
        for (idx, case) in cases.iter_mut().enumerate() {
            let payload = build_payload(case, dataset.get(idx));
            for spec in specs {
                if spec.case_index.is_some_and(|target| target != idx) {
                    continue;
                }
                let outcome = if Instant::now() >= budget {
                    CodeEvalOutcome::skipped("code-eval total budget exhausted")
                } else {
                    match CodeEvalLang::parse(&spec.lang) {
                        Some(lang) => {
                            run_code_evaluator(lang, &spec.source, &payload, per_call).await
                        }
                        None => CodeEvalOutcome::skipped(format!(
                            "unknown code evaluator lang '{}'",
                            spec.lang
                        )),
                    }
                };
                insert_or_replace_score(case, &spec.id, &outcome);
            }
        }
    }

    // 2. Re-aggregate the affected evaluator ids from the now-merged cases.
    reaggregate(block, specs);
}

/// Build the `{input, output, expected, vars, context}` payload for one case. `input` +
/// `output` come from the response case (always present); `expected` + `vars`
/// from the matching request-dataset case when available.
fn build_payload(response_case: &Value, request_case: Option<&CaseInput>) -> Value {
    let input = response_case.get("prompt").cloned().unwrap_or(Value::Null);
    let output = response_case
        .get("response_text")
        .cloned()
        .unwrap_or(Value::Null);
    let expected = request_case
        .and_then(|c| c.expected.clone())
        .unwrap_or(Value::Null);
    let context = request_case
        .and_then(|c| c.context.clone())
        .unwrap_or(Value::Null);
    let vars = request_case
        .map(|c| c.vars.clone())
        .unwrap_or_else(|| json!({}));
    json!({ "input": input, "output": output, "expected": expected, "vars": vars, "context": context })
}

/// Insert or replace the `EvaluatorScore` for `id` in `case.evaluators`,
/// preserving the gateway placeholder's `category` when replacing (else `custom`).
fn insert_or_replace_score(case: &mut Value, id: &str, outcome: &CodeEvalOutcome) {
    if !case.get("evaluators").is_some_and(Value::is_array) {
        if let Some(obj) = case.as_object_mut() {
            obj.insert("evaluators".to_owned(), Value::Array(Vec::new()));
        }
    }
    let category = case
        .get("evaluators")
        .and_then(Value::as_array)
        .and_then(|a| {
            a.iter()
                .find(|e| e.get("id").and_then(Value::as_str) == Some(id))
        })
        .and_then(|e| e.get("category").and_then(Value::as_str))
        .unwrap_or("custom")
        .to_owned();

    let score_val = json!({
        "id": id,
        "category": category,
        "score": outcome.score.unwrap_or(0.0),
        "pass": outcome.pass.unwrap_or(false),
        "detail": outcome.display_detail(),
        "executed": outcome.executed,
    });

    let Some(arr) = case.get_mut("evaluators").and_then(Value::as_array_mut) else {
        return;
    };
    if let Some(slot) = arr
        .iter_mut()
        .find(|e| e.get("id").and_then(Value::as_str) == Some(id))
    {
        *slot = score_val;
    } else {
        arr.push(score_val);
    }
}

/// Recompute `aggregate.evaluators[id]` for each spec id from the merged cases:
/// mean score + pass rate over EXECUTED cases, and the executed count. Keys are
/// camelCase to match the gateway's `EvaluatorAggregate` wire shape
/// (`meanScore`/`passRate`/`executedCount`).
fn reaggregate(block: &mut Value, specs: &[CodeEvaluatorSpec]) {
    let cases = block
        .get("cases")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    // Ensure `aggregate` and `aggregate.evaluators` exist as objects.
    if !block.get("aggregate").is_some_and(Value::is_object) {
        if let Some(obj) = block.as_object_mut() {
            obj.insert("aggregate".to_owned(), json!({}));
        }
    }
    if let Some(aggregate) = block.get_mut("aggregate").and_then(Value::as_object_mut) {
        if !aggregate.get("evaluators").is_some_and(Value::is_object) {
            aggregate.insert("evaluators".to_owned(), json!({}));
        }
    }

    for spec in specs {
        let mut sum = 0.0_f64;
        let mut pass_count = 0_usize;
        let mut executed = 0_usize;
        for case in &cases {
            let Some(es) = case
                .get("evaluators")
                .and_then(Value::as_array)
                .and_then(|a| {
                    a.iter()
                        .find(|e| e.get("id").and_then(Value::as_str) == Some(spec.id.as_str()))
                })
            else {
                continue;
            };
            if es.get("executed").and_then(Value::as_bool) == Some(true) {
                executed += 1;
                sum += es.get("score").and_then(Value::as_f64).unwrap_or(0.0);
                if es.get("pass").and_then(Value::as_bool) == Some(true) {
                    pass_count += 1;
                }
            }
        }
        let (mean, rate) = if executed > 0 {
            (sum / executed as f64, pass_count as f64 / executed as f64)
        } else {
            (0.0, 0.0)
        };
        let agg = json!({
            "meanScore": mean,
            "passRate": rate,
            "executedCount": executed,
        });
        if let Some(map) = block
            .get_mut("aggregate")
            .and_then(|a| a.get_mut("evaluators"))
            .and_then(Value::as_object_mut)
        {
            map.insert(spec.id.clone(), agg);
        }
    }
}

#[cfg(test)]
mod tests;

/// Tests for the python sandbox posture. Separate from `tests.rs` because these
/// pin the *release* decision, which `cargo test` (a debug build) can never take:
/// they assert the pure rule, never `host_fallback` itself.
#[cfg(test)]
mod sandbox_posture_tests {
    use super::*;

    #[test]
    fn only_explicit_truthy_values_opt_into_the_unsandboxed_fallback() {
        for yes in ["1", "true", "TRUE", " yes ", "on"] {
            assert!(unsandboxed_opt_in(Some(yes)), "{yes:?} should opt in");
        }
        for no in ["", "0", "false", "no", "off", "maybe"] {
            assert!(!unsandboxed_opt_in(Some(no)), "{no:?} must not opt in");
        }
        assert!(!unsandboxed_opt_in(None), "unset must not opt in");
    }

    #[test]
    fn release_build_without_opt_in_refuses_and_says_how_to_proceed() {
        let decision = host_fallback_rule("wasmtime", false, false);
        let HostFallback::Refuse(reason) = decision else {
            panic!("a release build with no live command sandbox must refuse: {decision:?}");
        };
        assert!(
            reason.contains("wasmtime"),
            "the refusal must name the configured backend: {reason}"
        );
        assert!(
            reason.contains(ENV_ALLOW_UNSANDBOXED_PYTHON) && reason.contains("docker"),
            "the refusal must name both remedies: {reason}"
        );
    }

    #[test]
    fn opt_in_or_debug_build_allows_the_host_fallback() {
        assert_eq!(
            host_fallback_rule("wasmtime", true, false),
            HostFallback::AllowUnsandboxed,
            "an explicit opt-in must be honoured in a release build"
        );
        assert_eq!(
            host_fallback_rule("wasmtime", false, true),
            HostFallback::AllowUnsandboxed,
            "debug builds keep the fallback so the python runtime tests still run it"
        );
    }

    #[test]
    fn unsandboxed_scores_are_tagged_on_the_wire_but_keep_their_own_detail() {
        let scored = CodeEvalOutcome::from_return(&json!({ "score": 1.0, "detail": "nope" }))
            .marked_unsandboxed();
        assert_eq!(
            scored.detail, "nope",
            "the evaluator's detail stays verbatim"
        );
        assert_eq!(
            scored.display_detail(),
            format!("{UNSANDBOXED_DETAIL_TAG} nope"),
            "the wire detail must announce the missing isolation"
        );

        // A sandboxed score is never tagged, and neither is the refusal skip.
        let sandboxed = CodeEvalOutcome::from_return(&json!({ "score": 1.0, "detail": "nope" }));
        assert_eq!(sandboxed.display_detail(), "nope");
        let HostFallback::Refuse(reason) = host_fallback_rule("wasmtime", false, false) else {
            unreachable!("covered above")
        };
        let refused = CodeEvalOutcome::skipped(reason);
        assert!(!refused.unsandboxed);
        assert!(!refused.display_detail().contains(UNSANDBOXED_DETAIL_TAG));
    }

    #[test]
    fn a_failed_unsandboxed_run_is_still_tagged() {
        // The tag rides on the outcome, not on the happy path: a timeout or a
        // non-zero exit from host python must still say it was un-sandboxed.
        let failed = CodeEvalOutcome::failed("python subprocess error: boom").marked_unsandboxed();
        assert!(failed.display_detail().starts_with(UNSANDBOXED_DETAIL_TAG));
    }
}
