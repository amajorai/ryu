//! The `[evals]` config the runner consumes.

use serde::{Deserialize, Serialize};

use crate::online::OnlineEvalsConfig;

// ─── Evals config (moved verbatim from gateway `config.rs`) ──────────────────
//
// The serde-shaped config the runner consumes. It lives here (not in gateway
// `config.rs`) so this stage crate is self-contained; gateway `config.rs`
// re-exports it so `crate::config::EvalsConfig` is unchanged and
// `GatewayConfig` still embeds `evals`.

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EvalsConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Latency (ms) at which the latency score drops to 0. Default: 10 000 ms.
    #[serde(default = "default_max_latency_ms")]
    pub max_latency_ms: u64,
    /// Fraction of completed requests to score, in `[0.0, 1.0]`.
    /// `1.0` scores every request; `0.0` disables scoring entirely.
    /// Sampling keeps eval overhead bounded under load. Default: 1.0.
    #[serde(default = "default_sample_rate")]
    pub sample_rate: f32,
    /// Inject `stream_options.include_usage=true` into streamed requests so
    /// the provider emits a terminal usage frame that the gateway can parse
    /// to record non-zero token counts and run eval scoring at stream end.
    ///
    /// Only conforming providers (OpenAI and OpenAI-compatible) honour this
    /// flag. Non-conforming providers fall back to `estimate_prompt_tokens`.
    /// Default: true (on by default for all OpenAI-compatible providers).
    #[serde(default = "default_true")]
    pub stream_usage: bool,
    /// Model that `POST /v1/evals/run` and `POST /v1/evals/score` use when a
    /// request names no `model`/`models`. `None` (the default) means callers
    /// must name a model: the Gateway never assumes a vendor model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    /// Model that judges LLM-judge assertions/evaluators when neither the
    /// evaluator (`offline.judgeModel`) nor the request names one. `None`
    /// keeps the previous behavior: the run's first model (dataset runs) or
    /// the model that produced the response (online scoring) judges.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub judge_model: Option<String>,
    /// `[evals.online]`: score a sampled fraction of production traffic with
    /// catalog evaluators off the request path (opt-in; see [`online`]).
    #[serde(default)]
    pub online: OnlineEvalsConfig,
}

pub(crate) fn default_true() -> bool {
    true
}

fn default_max_latency_ms() -> u64 {
    10_000
}

fn default_sample_rate() -> f32 {
    1.0
}

impl Default for EvalsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_latency_ms: default_max_latency_ms(),
            sample_rate: default_sample_rate(),
            stream_usage: true,
            default_model: None,
            judge_model: None,
            online: OnlineEvalsConfig::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An empty `[evals]` section is the documented default: on, every
    /// request sampled, a 10 s latency ceiling, stream usage injected, and no
    /// assumed default or judge model.
    #[test]
    fn an_empty_section_takes_the_documented_defaults() {
        let parsed: EvalsConfig = serde_json::from_str("{}").expect("parses");
        let default = EvalsConfig::default();
        for config in [parsed, default] {
            assert!(config.enabled);
            assert_eq!(config.max_latency_ms, 10_000);
            assert!((config.sample_rate - 1.0).abs() < f32::EPSILON);
            assert!(config.stream_usage);
            assert_eq!(config.default_model, None);
            assert_eq!(config.judge_model, None);
        }
    }
}
