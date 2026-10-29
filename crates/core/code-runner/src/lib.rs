//! Language runners behind the workflow `code` step.
//!
//! A `code` step hands Core a program in one of three languages and either
//! **runs** it (the step output is what the program produced) or **checks** it
//! (the step fails unless the language's own checker accepts every claim in the
//! source):
//!
//! | Language | `run`                                      | `check`                                        |
//! |----------|--------------------------------------------|------------------------------------------------|
//! | Lean 4   | `lean --run Main.lean <input>`; stdout     | `lean Main.lean`; fails on errors or `sorry`   |
//! | Bend 2   | `bend main.bend -- <input>`; stdout        | `bend main.bend --check-only`; `ALL PROOFS CHECK` |
//! | BAML     | `baml-cli serve` + `POST /call/<function>` | `baml-cli check`                               |
//!
//! **Isolation.** Lean and Bend programs can perform arbitrary IO, Lean even while
//! it is only being checked (`#eval` runs at elaboration time), so both run
//! through a command-capable [`ryu_sandbox`] backend when one is live. Without one,
//! release builds refuse the step unless the operator sets
//! [`ENV_ALLOW_UNSANDBOXED_CODE`]; the host fallback then runs with a cleared
//! environment. BAML has no IO of its own: its only effect is a model call, so
//! `baml-cli` runs on the host with a cleared environment and a Core-provided
//! [`BAML_CLIENT_NAME`] client that can only reach the Ryu gateway. Sources that
//! declare their own model clients are refused, so a BAML step cannot address a
//! provider directly or read a credential from the environment.
//!
//! This crate has ZERO dependency on `apps/core`; Core supplies the gateway route
//! ([`LlmRoute`]) and template-resolves the step input before calling
//! [`run_code`].

mod baml;
mod placement;
mod process;
mod programs;
mod toolchain;

#[cfg(test)]
mod tests;

use std::time::Duration;

use serde::{Deserialize, Serialize};

pub use baml::BAML_CLIENT_NAME;
pub use placement::ENV_ALLOW_UNSANDBOXED_CODE;
pub use toolchain::{ENV_BAML_BIN, ENV_BEND_BIN, ENV_LEAN_BIN};

/// Largest accepted program source. The sandbox path passes the source as one
/// argument, so this stays well under Linux's 128 KiB per-argument limit.
pub const MAX_SOURCE_BYTES: usize = 64 * 1024;
/// Largest accepted step input (the program argument, or the BAML argument object).
pub const MAX_INPUT_BYTES: usize = 64 * 1024;
/// Largest program output kept; anything beyond is drained and dropped.
pub const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
/// Timeout applied when the step does not set one.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
/// Upper bound on any single code step, matching the sandbox's 300 s ceiling.
pub const MAX_TIMEOUT: Duration = Duration::from_secs(300);

/// The language of a `code` step's source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CodeLanguage {
    /// Lean 4 (`lean`, usually installed through elan).
    Lean,
    /// Bend 2 (`bend`, from bend-lang.com).
    Bend,
    /// BAML (`baml-cli`, from BoundaryML).
    Baml,
}

impl CodeLanguage {
    /// The wire name (`lean` / `bend` / `baml`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lean => "lean",
            Self::Bend => "bend",
            Self::Baml => "baml",
        }
    }

    /// Human-facing name used in step errors.
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Lean => "Lean",
            Self::Bend => "Bend",
            Self::Baml => "BAML",
        }
    }
}

/// Whether a `code` step runs its program or only checks it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CodeMode {
    /// Run the program (Lean/Bend `main`, or one BAML function) and emit its result.
    #[default]
    Run,
    /// Check the source and fail unless the language's checker accepts it.
    Check,
}

impl CodeMode {
    /// The wire name (`run` / `check`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Run => "run",
            Self::Check => "check",
        }
    }
}

/// Where a BAML step's model calls go. Core fills this from its gateway
/// settings so the call stays governed (firewall, DLP, budgets, audit).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlmRoute {
    /// OpenAI-compatible base URL, including the `/v1` suffix.
    pub base_url: String,
    /// Bearer credential for the gateway, when it requires one.
    pub api_key: Option<String>,
    /// Model id the [`BAML_CLIENT_NAME`] client requests.
    pub model: String,
}

/// One `code` step invocation.
#[derive(Debug, Clone)]
pub struct CodeRequest<'a> {
    /// Source language.
    pub language: CodeLanguage,
    /// Run or check.
    pub mode: CodeMode,
    /// Program source. Never template-resolved: data reaches the program through
    /// `input` or `args`, so a step input cannot rewrite the program.
    pub source: &'a str,
    /// Lean/Bend: the single command-line argument the program receives.
    pub input: &'a str,
    /// BAML: the function to call in `run` mode.
    pub function: Option<&'a str>,
    /// BAML: the function's named arguments, as a JSON object.
    pub args: &'a serde_json::Value,
    /// Wall-clock budget, clamped to `1 s..=`[`MAX_TIMEOUT`].
    pub timeout: Duration,
    /// Gateway route for BAML model calls.
    pub llm: Option<&'a LlmRoute>,
}

/// A successful `code` step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeOutput {
    /// The step output: program stdout (Lean/Bend run), the function result
    /// (BAML run; a string result is emitted raw, anything else as JSON), or a
    /// JSON check receipt (check mode).
    pub value: String,
    /// Where it ran: `sandbox:<backend>`, `host:unsandboxed` (operator opt-in or
    /// a debug build), or `host:baml` (scrubbed, gateway-only BAML server).
    pub runner: String,
}

/// Run or check one program. Never panics; never runs past the clamped timeout.
pub async fn run_code(request: &CodeRequest<'_>) -> Result<CodeOutput, String> {
    validate_request(request)?;
    let timeout = clamp_timeout(request.timeout);
    match request.language {
        CodeLanguage::Lean | CodeLanguage::Bend => programs::run(request, timeout).await,
        CodeLanguage::Baml => baml::run(request, timeout).await,
    }
}

/// Clamp a requested timeout into `1 s..=MAX_TIMEOUT`.
pub fn clamp_timeout(requested: Duration) -> Duration {
    requested.clamp(Duration::from_secs(1), MAX_TIMEOUT)
}

fn validate_request(request: &CodeRequest<'_>) -> Result<(), String> {
    let language = request.language.display_name();
    if request.source.trim().is_empty() {
        return Err(format!("{language} code step has no source"));
    }
    if request.source.len() > MAX_SOURCE_BYTES {
        return Err(format!(
            "{language} source is {} bytes; code steps accept at most {MAX_SOURCE_BYTES}",
            request.source.len()
        ));
    }
    if request.source.contains('\0') || request.input.contains('\0') {
        return Err(format!(
            "{language} code step source and input must not contain NUL bytes"
        ));
    }
    if request.input.len() > MAX_INPUT_BYTES {
        return Err(format!(
            "{language} step input is {} bytes; code steps accept at most {MAX_INPUT_BYTES}",
            request.input.len()
        ));
    }
    Ok(())
}

/// Keep the head of long tool output for an error message or receipt.
pub(crate) fn clip(text: &str, limit: usize) -> String {
    let trimmed = text.trim();
    if trimmed.len() <= limit {
        return trimmed.to_string();
    }
    let mut end = limit;
    while !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[output clipped]", &trimmed[..end])
}

/// The JSON receipt a successful check emits as the step output.
pub(crate) fn check_receipt(language: CodeLanguage, runner: &str, diagnostics: &str) -> String {
    let mut receipt = serde_json::json!({
        "language": language.as_str(),
        "mode": CodeMode::Check.as_str(),
        "status": "checked",
        "runner": runner,
    });
    let diagnostics = clip(diagnostics, 4096);
    if !diagnostics.is_empty() {
        receipt["diagnostics"] = serde_json::Value::String(diagnostics);
    }
    receipt.to_string()
}
