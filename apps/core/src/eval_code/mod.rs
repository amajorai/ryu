//! **Code evaluators** (unified-evaluator plan, P4).
//!
//! A *code evaluator* is a user function
//! `(input, output, expected, vars) -> {score: 0..1, pass?: bool, detail?: string}`
//! that scores one eval case. It runs in one of two isolated runtimes:
//!
//! - **JS** — the same deny-all **Deno** subprocess the PTC tool-exec path uses
//!   (zero `--allow-*` → no net/FS/env, `env_clear`, `kill_on_drop`,
//!   deadline-bounded), but with **no tool bridge**: the payload is embedded and
//!   the return value is read back over a tagged stdout line
//!   ([`crate::tool_exec::run_eval_js`]). We do NOT weaken the tool-exec sandbox.
//! - **Python** — routed through the swappable [`crate::sidecar::sandbox`]
//!   command-backend abstraction (deny-all caps, stdin = payload JSON) when a
//!   command-capable backend (docker/daytona/…) is configured **and** live;
//!   otherwise a bare host-`python` subprocess fallback (mirrors the Deno spawn:
//!   `env_clear` + scrub + `kill_on_drop` + deadline) — explicitly **not**
//!   isolated, logged as such. If python is unavailable at all, the evaluator is
//!   honestly reported as `executed:false` rather than faked.
//!
//! **Core-vs-Gateway placement:** code execution is a *Core* capability, so the
//! Gateway's offline eval runner (`POST /v1/evals/run`) marks `Code` evaluators
//! `executed:false` and Core — which already proxies the run
//! (`POST /api/gateway/evals/run`) — executes them and merges the real scores in
//! ([`merge_code_evaluators`]). Nothing here touches the gateway crate.

use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

use crate::win_process::NoWindow;

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
            "js" | "javascript" | "deno" | "ts" | "typescript" => Some(Self::Js),
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
}

/// Per-case data pulled from the request dataset to enrich the payload with
/// `expected` + `vars` (the gateway's response case only carries `prompt` +
/// `response_text`). Matched to a response case by index.
#[derive(Debug, Clone, Default)]
pub struct CaseInput {
    pub expected: Option<Value>,
    pub vars: Value,
}

impl CaseInput {
    /// Extract `{expected, vars}` from one request-dataset case value.
    pub fn from_case(v: &Value) -> Self {
        Self {
            expected: v.get("expected").cloned().filter(|e| !e.is_null()),
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
        }
    }

    /// Parse the evaluator's returned `{score, pass?, detail?}` JSON.
    fn from_return(v: &Value) -> Self {
        let Some(obj) = v.as_object() else {
            return Self::failed("evaluator did not return an object with a numeric 'score'");
        };
        let score = match obj.get("score").and_then(Value::as_f64) {
            Some(s) if s.is_finite() => (s as f32).clamp(0.0, 1.0),
            _ => return Self::failed("evaluator return is missing a finite numeric 'score'"),
        };
        let pass = obj
            .get("pass")
            .and_then(Value::as_bool)
            .unwrap_or(score >= 0.5);
        let detail = obj
            .get("detail")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        Self {
            score: Some(score),
            pass: Some(pass),
            detail,
            executed: true,
            error: None,
        }
    }

    /// The `detail` string to surface on the wire `EvaluatorScore` (folds any
    /// error in so a skip/failure is legible, not silent).
    fn display_detail(&self) -> String {
        match (&self.error, self.detail.is_empty()) {
            (Some(e), true) => e.clone(),
            (Some(e), false) => format!("{}: {}", self.detail, e),
            (None, _) => self.detail.clone(),
        }
    }
}

/// Run one code evaluator against one `payload` (`{input, output, expected,
/// vars}`), bounded by `timeout`. Never panics; never hangs past `timeout`.
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

#[cfg(feature = "tool-exec-deno")]
async fn run_js(source: &str, payload: &Value, timeout: Duration) -> CodeEvalOutcome {
    match crate::tool_exec::run_eval_js(source, payload, timeout).await {
        crate::tool_exec::EvalJsOutcome::Value(v) => CodeEvalOutcome::from_return(&v),
        crate::tool_exec::EvalJsOutcome::Error(e) => CodeEvalOutcome::failed(e),
    }
}

#[cfg(not(feature = "tool-exec-deno"))]
async fn run_js(_source: &str, _payload: &Value, _timeout: Duration) -> CodeEvalOutcome {
    CodeEvalOutcome::skipped(
        "JS code evaluators require the tool-exec-deno backend, which is not built",
    )
}

// ── Python ─────────────────────────────────────────────────────────────────────

async fn run_python(source: &str, payload: &Value, timeout: Duration) -> CodeEvalOutcome {
    use crate::sidecar::sandbox::{
        build_command_backend, configured_backend, detect_backend, ExecSpec,
    };

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

    // Fallback: bare host subprocess — NOT sandbox-isolated. Honest + logged.
    if !python_on_path() {
        return CodeEvalOutcome::skipped(
            "python is unavailable on PATH and no command-capable sandbox backend is configured; python evaluator skipped",
        );
    }
    tracing::warn!(
        "running a python code evaluator via a bare host subprocess (NOT sandbox-isolated); \
         configure a command-capable sandbox backend (docker/daytona) for real isolation"
    );
    run_python_subprocess(&script, &payload_bytes, timeout).await
}

/// Wrap the user python: read the payload JSON from stdin, bind `ctx` +
/// `input`/`output`/`expected`/`vars`, then run the user source. Per the
/// contract the user code `print(json.dumps({...}))` its `{score,pass?,detail?}`.
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
         # ---- user evaluator source ----\n\
         {user}\n",
        user = user_source
    )
}

fn python_on_path() -> bool {
    use std::process::Stdio;
    std::process::Command::new(crate::sidecar::external_runtime::bootstrap_python())
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .no_window()
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

async fn run_python_subprocess(
    script: &str,
    payload: &[u8],
    timeout: Duration,
) -> CodeEvalOutcome {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;

    // Scrub secrets from the inherited env (mirrors the Deno spawn) but keep the
    // non-secret vars python needs (PATH so the interpreter resolves, etc.).
    let scrubbed = crate::sidecar::env_scrub::scrub_child_env(std::env::vars(), &[]);
    let mut child = match tokio::process::Command::new(
        crate::sidecar::external_runtime::bootstrap_python(),
    )
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
        Ok(Ok(out)) => outcome_from_python(
            out.status.code().unwrap_or(-1),
            &out.stdout,
            &out.stderr,
        ),
        Ok(Err(e)) => CodeEvalOutcome::failed(format!("python subprocess error: {e}")),
        // The future (and the child it owns) drops here → `kill_on_drop` fires.
        Err(_) => CodeEvalOutcome::failed(
            "python evaluator exceeded the wall-clock deadline and was killed",
        ),
    }
}

/// Parse python output: the LAST stdout line that JSON-parses to an object with a
/// `score`. On none, fail with a stderr snippet so the reason is legible.
fn outcome_from_python(exit_code: i32, stdout: &[u8], stderr: &[u8]) -> CodeEvalOutcome {
    let stdout_s = String::from_utf8_lossy(stdout);
    for line in stdout_s.lines().rev() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(t) {
            if v.get("score").is_some() {
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

/// Build the `{input, output, expected, vars}` payload for one case. `input` +
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
    let vars = request_case
        .map(|c| c.vars.clone())
        .unwrap_or_else(|| json!({}));
    json!({ "input": input, "output": output, "expected": expected, "vars": vars })
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
