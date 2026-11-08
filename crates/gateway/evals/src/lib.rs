//! Ryu Gateway evals stage (decomposition W6).
//!
//! Extracted from `apps/gateway/src/evals`: the live [`EvalsRunner`]
//! (per-request sampling + provider-score EMA) exposed as a swappable
//! [`EvalsBackend`] trait + [`EvalsRegistry`], plus the pure, network-free
//! dataset scorers ([`score_case`], [`aggregate_scores`], [`Assertion`],
//! judge helpers). Gateway re-exports the whole crate via `crate::evals` so
//! every call site is unchanged; [`EvalsConfig`] is re-exported from
//! `crate::config` so `GatewayConfig` still embeds `evals`.
//!
//! Every item is re-exported at the crate root, so the module layout below is
//! an implementation detail: callers name `ryu_gw_evals::<item>`.

mod aggregate;
mod assertion;
mod case;
mod config;
mod deterministic;
mod deterministic_codes;
mod judge;
pub mod online;
mod options;
mod registry;
mod runner;
mod score;
mod template;
mod text_shape;

pub use aggregate::aggregate_scores;
pub use assertion::{Assertion, AssertionOptions, AssertionResult};
pub use case::{
    CaseScore, EvalCase, EvalCaseOptions, EvalMessage, EvalRunAggregate, EvaluatorAggregate,
    EvaluatorScore,
};
pub use config::EvalsConfig;
pub use deterministic::{eval_assertion_deterministic, eval_assertion_deterministic_with_metrics};
pub use judge::{
    build_judge_prompt, judge_pass, judge_reply_text, parse_judge_reply, parse_judge_verdict,
    resolve_judge_model, truncate_chars, JudgeVerdict,
};
pub use online::OnlineEvalsConfig;
pub use options::{apply_assertion_options, AssertionMetrics};
pub use registry::{EvalsBackend, EvalsRegistry};
pub use runner::{EvalResult, EvalsRunner};
pub use score::{builtin_dataset, score_case, set_measurement_availability};
pub use template::{render_template, substitute_vars};
