//! Control-plane reporting, shared budgets and flat cost defaults.

use super::*;

/// Connection to the control plane (M7 / U29). When enabled, the gateway
/// periodically pushes its eval/budget/audit snapshot up to the control plane
/// for aggregation, and reconciles shared budgets through the coordinator.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ControlPlaneConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Base URL of the control-plane API, e.g. `http://127.0.0.1:3000/api`.
    #[serde(default = "default_control_plane_url")]
    pub base_url: String,
    /// Gateway credential issued by the control plane (env: CONTROL_PLANE_KEY).
    /// Sent as the `X-Gateway-Key` header to authenticate and resolve the org.
    pub gateway_key: Option<String>,
    /// How often to push a report, in seconds. Default: 60.
    #[serde(default = "default_report_interval_secs")]
    pub report_interval_secs: u64,
    /// Maximum audit rows to push per report. Default: 200.
    #[serde(default = "default_report_audit_limit")]
    pub audit_limit: u32,
    /// Optional shared-budget id to reconcile through the coordinator. When set,
    /// the gateway reports its consumption and respects the shared cap.
    pub shared_budget_id: Option<String>,
    /// Estimated cost in micro-USD per 1000 tokens (input + output combined),
    /// used to attribute spend. Default: 2000 (= $0.002 / 1k tokens).
    #[serde(default = "default_cost_per_1k_micro_usd")]
    pub cost_per_1k_micro_usd: u64,

    /// Per-model price table (#9). Keyed by model id (exact, then longest-prefix
    /// match, e.g. `"claude-sonnet"`). When a model matches, spend is attributed
    /// with real input/output rates instead of the flat `cost_per_1k_micro_usd`.
    /// Empty (the default) keeps the flat estimate — nothing hardcoded, fully
    /// swappable per deployment.
    #[serde(default)]
    pub model_pricing: HashMap<String, ModelPrice>,
}

/// Real input/output pricing for one model, in micro-USD per 1000 tokens.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ModelPrice {
    /// micro-USD per 1000 input (prompt) tokens.
    pub input_per_1k_micro_usd: u64,
    /// micro-USD per 1000 output (completion) tokens.
    pub output_per_1k_micro_usd: u64,
}

impl ControlPlaneConfig {
    /// Estimated spend in micro-USD for one call. Uses the per-model price table
    /// when the model matches (exact, then longest-prefix), else the flat
    /// `cost_per_1k_micro_usd` fallback.
    pub fn cost_for(&self, model: &str, input: u64, output: u64) -> u64 {
        if let Some(p) = self.price_for_model(model) {
            let i = input.saturating_mul(p.input_per_1k_micro_usd) / 1000;
            let o = output.saturating_mul(p.output_per_1k_micro_usd) / 1000;
            return i.saturating_add(o);
        }
        (input.saturating_add(output)).saturating_mul(self.cost_per_1k_micro_usd) / 1000
    }

    /// The OUTPUT price per 1k tokens for `model`, falling back to the flat
    /// `cost_per_1k_micro_usd` when the table has no entry.
    ///
    /// The spend ceiling is computed from this rather than from the flat rate,
    /// and the difference is the whole point: output prices span roughly 500x
    /// across the catalog, so one blended rate makes the ceiling far too
    /// generous on a frontier model — which is exactly where an overdraft is
    /// worth having — and needlessly tight on a cheap one, truncating
    /// completions that were affordable all along.
    ///
    /// OUTPUT only, not the blend `cost_for` uses: the ceiling bounds how many
    /// tokens the model may still GENERATE. The prompt is already paid for by
    /// the time this is asked, so charging the ceiling for input tokens would
    /// shrink it for a reason that has nothing to do with what remains to be
    /// spent.
    pub fn output_price_per_1k_micro_usd(&self, model: &str) -> u64 {
        self.price_for_model(model)
            .map(|p| p.output_per_1k_micro_usd)
            .filter(|p| *p > 0)
            .unwrap_or(self.cost_per_1k_micro_usd)
    }

    /// Exact match first, then the longest matching prefix (so `"claude-sonnet"`
    /// covers `"claude-sonnet-4-5-20250929"`).
    pub(super) fn price_for_model(&self, model: &str) -> Option<&ModelPrice> {
        if let Some(p) = self.model_pricing.get(model) {
            return Some(p);
        }
        let mut best: Option<(&String, &ModelPrice)> = None;
        for (k, v) in &self.model_pricing {
            if model.starts_with(k.as_str()) && best.map_or(true, |(bk, _)| k.len() > bk.len()) {
                best = Some((k, v));
            }
        }
        best.map(|(_, v)| v)
    }
}

/// Managed-app base rate. Direct execution and other add-ons are separate.
pub(super) fn default_cost_per_tool_call_micro_usd() -> u64 {
    500
}

/// Replicate's published Nvidia L40S rate, $0.000975/sec, in micro-USD.
pub(super) fn default_cost_per_gpu_second_micro_usd() -> u64 {
    975
}

// ─── Media fallback rates (micro-USD per call) ───────────────────────────────
// The four flat per-call rates the media debit falls back to when the provider
// reported no compute time. Each is DERIVED from the one published price this
// file already holds — Replicate's L40S GPU-second — times the nominal duration
// of that kind of job, so there is exactly one number to re-check when the
// hardware rate changes and no invented figures at all.
//
// Image and video take their durations from the derivation already written down
// on `cost_per_gpu_second_micro_usd`: "a two-second image and a sixty-second
// video". Nothing in this file publishes a per-character, per-second-of-audio or
// per-minute rate for speech, so TTS and STT take the shortest job the fallback
// can honestly represent — one GPU-second.
//
// These are FALLBACKS, not prices. The metered path
// ([`CreditsConfig::media_cost_from_response`]) is what should pay for a real
// call; a rate here only has to be non-zero, because zero is the one value that
// turns "charge a little" into "skip the debit" under the `if cost > 0` guard.
// Every one is overridable per deployment with the matching
// `GATEWAY_CREDITS_COST_PER_*_MICRO_USD`.

/// A nominal two-second image on L40S: `2 x $0.000975/sec`.
pub(super) fn default_cost_per_image_micro_usd() -> u64 {
    default_cost_per_gpu_second_micro_usd() * 2
}

/// A nominal sixty-second video render on L40S: `60 x $0.000975/sec`.
pub(super) fn default_cost_per_video_micro_usd() -> u64 {
    default_cost_per_gpu_second_micro_usd() * 60
}

/// One L40S second, the shortest job the fallback can represent. TTS is the
/// urgent half of this pair with STT: both are served synchronously, and neither
/// has a published per-audio-unit rate anywhere in this config.
pub(super) fn default_cost_per_tts_micro_usd() -> u64 {
    default_cost_per_gpu_second_micro_usd()
}

/// One L40S second — see [`default_cost_per_tts_micro_usd`].
pub(super) fn default_cost_per_stt_micro_usd() -> u64 {
    default_cost_per_gpu_second_micro_usd()
}

pub(super) fn default_control_plane_url() -> String {
    "http://127.0.0.1:3000/api".to_string()
}
pub(super) fn default_report_interval_secs() -> u64 {
    60
}
pub(super) fn default_report_audit_limit() -> u32 {
    200
}
pub(super) fn default_cost_per_1k_micro_usd() -> u64 {
    2000
}

impl Default for ControlPlaneConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            base_url: default_control_plane_url(),
            gateway_key: None,
            report_interval_secs: default_report_interval_secs(),
            audit_limit: default_report_audit_limit(),
            shared_budget_id: None,
            cost_per_1k_micro_usd: default_cost_per_1k_micro_usd(),
            model_pricing: HashMap::new(),
        }
    }
}
