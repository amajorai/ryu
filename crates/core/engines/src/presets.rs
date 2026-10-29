//! Per-model sampling support and node-level inference presets.
//!
//! Three things live here, all pure data and translation (no I/O):
//!
//! 1. **Which knobs a model honours.** [`local_sampling_fields`] (per local
//!    [`Engine`]) and [`remote_sampling_fields`] (per cloud provider id) list the
//!    [`SamplingConfig`] field names that actually reach the model. Settings UIs
//!    render exactly these, so a cloud model shows `top_k` only where the
//!    provider takes it, and a llama.cpp model shows every sampler.
//! 2. **Cloud sampler extensions.** Non-standard samplers (`top_k`, `min_p`,
//!    repeat penalty) are not OpenAI-safe, so on the Core → Gateway hop they ride
//!    in the private [`GATEWAY_SAMPLING_FIELD`] body object. The gateway owns the
//!    per-provider wire mapping: it strips the object on every provider attempt
//!    and re-emits only what that provider accepts (Anthropic `top_k`,
//!    OpenRouter `top_k`/`min_p`/`repetition_penalty`, …).
//! 3. **Presets.** An [`InferencePreset`] is a named, reusable sampling bundle
//!    (plus optional launch flags for local models), stored once per node and
//!    applied to any model's settings. [`builtin_presets`] ships read-only
//!    starting points that only use universally supported fields.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{Engine, LaunchConfig, SamplingConfig};

/// Private Core → Gateway body field carrying the non-standard samplers for a
/// cloud request. Same convention as `ryu_smart_route` / `ryu_anthropic_beta`:
/// the gateway always removes it before a provider sees the body.
pub const GATEWAY_SAMPLING_FIELD: &str = "ryu_sampling";

/// OpenAI-standard sampling fields: safe on every engine and OpenAI-compatible
/// provider. `prefill` and `extra` are always available too (prefill is a
/// message, `extra` is an explicit raw passthrough), so they are listed here.
const STANDARD_FIELDS: &[&str] = &[
    "temperature",
    "top_p",
    "max_tokens",
    "frequency_penalty",
    "presence_penalty",
    "seed",
    "stop",
    "prefill",
    "extra",
];

/// OpenAI structured-output and token-bias fields.
const OUTPUT_FIELDS: &[&str] = &["response_format", "logit_bias"];

/// Every llama.cpp sampler beyond the standard set.
const LLAMACPP_FIELDS: &[&str] = &[
    "top_k",
    "min_p",
    "typical_p",
    "top_n_sigma",
    "repeat_penalty",
    "repeat_last_n",
    "mirostat",
    "mirostat_tau",
    "mirostat_eta",
    "dynatemp_range",
    "dynatemp_exponent",
    "xtc_probability",
    "xtc_threshold",
    "dry_multiplier",
    "dry_base",
    "dry_allowed_length",
    "dry_penalty_last_n",
    "samplers",
    "grammar",
];

fn fields(groups: &[&[&'static str]]) -> Vec<&'static str> {
    groups
        .iter()
        .flat_map(|group| group.iter().copied())
        .collect()
}

/// The [`SamplingConfig`] fields `engine` reads from the request body. Mirrors
/// the match arms of [`SamplingConfig::apply_to_body`]; a test keeps them aligned.
pub fn local_sampling_fields(engine: Engine) -> Vec<&'static str> {
    match engine {
        Engine::LlamaCpp => fields(&[STANDARD_FIELDS, LLAMACPP_FIELDS, OUTPUT_FIELDS]),
        Engine::Vllm | Engine::Sglang => fields(&[
            STANDARD_FIELDS,
            &["top_k", "min_p", "repeat_penalty"],
            OUTPUT_FIELDS,
        ]),
        Engine::Mlx => fields(&[STANDARD_FIELDS, &["repeat_penalty"]]),
        Engine::Ollama
        | Engine::MlxVlm
        | Engine::MlxServe
        | Engine::Omlx
        | Engine::Apfel
        | Engine::MeshLlm => fields(&[STANDARD_FIELDS]),
        Engine::Other => fields(&[STANDARD_FIELDS, OUTPUT_FIELDS]),
    }
}

/// The [`SamplingConfig`] fields a cloud provider honours when the request is
/// routed through the Ryu gateway. `provider` is the catalog/gateway provider id
/// (`anthropic`, `openrouter`, `genai-groq`, …); unknown ids fall back to the
/// OpenAI-compatible set, which is safe for any compliant endpoint.
pub fn remote_sampling_fields(provider: &str) -> Vec<&'static str> {
    let provider = provider.trim().to_ascii_lowercase();
    let provider = provider.strip_prefix("genai-").unwrap_or(&provider);
    match provider {
        // Anthropic Messages (direct or via Bedrock): no penalties or seed, but
        // native `top_k`.
        "anthropic" | "bedrock" | "claude" => vec![
            "temperature",
            "top_p",
            "top_k",
            "max_tokens",
            "stop",
            "prefill",
            "extra",
        ],
        "openrouter" | "open-router" => fields(&[
            STANDARD_FIELDS,
            &["top_k", "min_p", "repeat_penalty"],
            OUTPUT_FIELDS,
        ]),
        // SDK-backed providers translate through `genai` chat options. Gemini,
        // Cohere, and Vertex map `top_k` onto their native APIs; Bedrock does not.
        "genai" | "google" | "gemini" | "vertex" | "cohere" => vec![
            "temperature",
            "top_p",
            "top_k",
            "max_tokens",
            "stop",
            "prefill",
            "extra",
        ],
        "bedrock-api" => vec![
            "temperature",
            "top_p",
            "max_tokens",
            "stop",
            "prefill",
            "extra",
        ],
        // The local OpenAI-compatible gateway provider fronts llama.cpp-class
        // servers, which read the common sampler extensions from the body.
        "local" => fields(&[
            STANDARD_FIELDS,
            &["top_k", "min_p", "repeat_penalty"],
            OUTPUT_FIELDS,
        ]),
        _ => fields(&[STANDARD_FIELDS, OUTPUT_FIELDS]),
    }
}

impl SamplingConfig {
    /// The non-standard samplers a cloud request may carry, keyed canonically
    /// (`top_k`, `min_p`, `repeat_penalty`). `None` when none are set, so an
    /// ordinary request body stays byte-identical.
    pub fn gateway_extensions(&self) -> Option<Value> {
        let mut out = Map::new();
        if let Some(top_k) = self.top_k {
            out.insert("top_k".to_owned(), Value::Number(top_k.into()));
        }
        for (key, value) in [
            ("min_p", self.min_p),
            ("repeat_penalty", self.repeat_penalty),
        ] {
            if let Some(number) = value.and_then(serde_json::Number::from_f64) {
                out.insert(key.to_owned(), Value::Number(number));
            }
        }
        (!out.is_empty()).then_some(Value::Object(out))
    }

    /// A copy whose raw passthrough also carries [`GATEWAY_SAMPLING_FIELD`]. Use
    /// only on the hop to the Ryu gateway, which strips and translates it; a
    /// direct provider endpoint must never receive the private field.
    pub fn with_gateway_extensions(&self) -> Self {
        let mut out = self.clone();
        if let Some(extensions) = self.gateway_extensions() {
            out.extra
                .insert(GATEWAY_SAMPLING_FIELD.to_owned(), extensions);
        }
        out
    }

    /// Keep only the fields named in `allowed` (as listed by
    /// [`local_sampling_fields`] / [`remote_sampling_fields`]). Used so a preset
    /// written for llama.cpp applies cleanly to a cloud model.
    pub fn retain_fields(&self, allowed: &[&str]) -> Self {
        let Ok(Value::Object(mut map)) = serde_json::to_value(self) else {
            return Self::default();
        };
        map.retain(|key, _| allowed.contains(&key.as_str()));
        serde_json::from_value(Value::Object(map)).unwrap_or_default()
    }
}

/// Which models a preset is meant for. Purely a hint for pickers: applying a
/// preset always filters it to the target model's supported fields.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PresetTarget {
    #[default]
    Any,
    Local,
    Cloud,
}

/// A named, reusable bundle of model parameters saved on the node.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct InferencePreset {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub target: PresetTarget,
    #[serde(default)]
    pub sampling: SamplingConfig,
    /// Engine-launch flags, applied only to local models (cloud models have no
    /// launch surface). Changing them restarts the engine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch: Option<LaunchConfig>,
    /// Shipped read-only presets. Never trusted from input: the store forces
    /// `false` on save and serves built-ins from [`builtin_presets`].
    #[serde(default)]
    pub builtin: bool,
    /// Unix seconds; `0` for built-ins.
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// Prefix reserved for shipped preset ids.
pub const BUILTIN_PRESET_PREFIX: &str = "builtin.";

fn builtin(
    id: &str,
    name: &str,
    description: &str,
    temperature: f64,
    top_p: f64,
) -> InferencePreset {
    InferencePreset {
        id: format!("{BUILTIN_PRESET_PREFIX}{id}"),
        name: name.to_owned(),
        description: Some(description.to_owned()),
        target: PresetTarget::Any,
        sampling: SamplingConfig {
            temperature: Some(temperature),
            top_p: Some(top_p),
            ..SamplingConfig::default()
        },
        launch: None,
        builtin: true,
        created_at: 0,
        updated_at: 0,
    }
}

/// Read-only starting points. They set only `temperature` and `top_p`, which
/// every local engine and cloud provider accepts.
pub fn builtin_presets() -> Vec<InferencePreset> {
    vec![
        builtin(
            "precise",
            "Precise",
            "Low randomness for code, extraction, and factual answers.",
            0.2,
            0.9,
        ),
        builtin(
            "balanced",
            "Balanced",
            "General chat with moderate variety.",
            0.7,
            0.95,
        ),
        builtin(
            "creative",
            "Creative",
            "Higher variety for brainstorming and writing.",
            1.0,
            0.98,
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn every_field() -> SamplingConfig {
        let mut logit_bias = Map::new();
        logit_bias.insert("42".to_owned(), serde_json::json!(-100.0));
        SamplingConfig {
            temperature: Some(0.5),
            top_p: Some(0.9),
            max_tokens: Some(64),
            frequency_penalty: Some(0.1),
            presence_penalty: Some(0.1),
            seed: Some(7),
            stop: vec!["END".to_owned()],
            top_k: Some(40),
            min_p: Some(0.05),
            typical_p: Some(1.0),
            top_n_sigma: Some(1.0),
            repeat_penalty: Some(1.1),
            repeat_last_n: Some(64),
            mirostat: Some(2),
            mirostat_tau: Some(5.0),
            mirostat_eta: Some(0.1),
            dynatemp_range: Some(0.1),
            dynatemp_exponent: Some(1.0),
            xtc_probability: Some(0.1),
            xtc_threshold: Some(0.1),
            dry_multiplier: Some(0.8),
            dry_base: Some(1.75),
            dry_allowed_length: Some(2),
            dry_penalty_last_n: Some(-1),
            samplers: Some("top_k;temperature".to_owned()),
            logit_bias,
            response_format: Some(serde_json::json!({"type": "json_object"})),
            grammar: Some("root ::= \"x\"".to_owned()),
            prefill: None,
            extra: Map::new(),
        }
    }

    /// The listed fields must be exactly the typed fields `apply_to_body` emits,
    /// so a settings UI never offers a knob the engine silently drops.
    #[test]
    fn local_field_lists_match_apply_to_body() {
        let renames = [("repetition_penalty", "repeat_penalty")];
        for engine in [
            Engine::LlamaCpp,
            Engine::Vllm,
            Engine::Sglang,
            Engine::Mlx,
            Engine::Ollama,
            Engine::MlxServe,
            Engine::Other,
        ] {
            let mut body = Map::new();
            every_field().apply_to_body(engine, &mut body);
            let mut emitted: Vec<String> = body
                .keys()
                .map(|key| {
                    renames
                        .iter()
                        .find(|(wire, _)| wire == key)
                        .map_or_else(|| key.clone(), |(_, canonical)| (*canonical).to_owned())
                })
                .collect();
            emitted.sort();
            let mut listed: Vec<String> = local_sampling_fields(engine)
                .into_iter()
                .filter(|field| !matches!(*field, "prefill" | "extra"))
                .map(str::to_owned)
                .collect();
            listed.sort();
            assert_eq!(emitted, listed, "{engine:?}");
        }
    }

    #[test]
    fn remote_fields_gate_non_standard_samplers_by_provider() {
        assert!(remote_sampling_fields("anthropic").contains(&"top_k"));
        assert!(!remote_sampling_fields("anthropic").contains(&"seed"));
        assert!(remote_sampling_fields("openrouter").contains(&"min_p"));
        assert!(!remote_sampling_fields("openai").contains(&"top_k"));
        assert!(!remote_sampling_fields("genai-groq").contains(&"top_k"));
        assert!(remote_sampling_fields("GOOGLE").contains(&"top_k"));
        assert!(remote_sampling_fields("genai-cohere").contains(&"top_k"));
        assert!(!remote_sampling_fields("genai-bedrock-api").contains(&"top_k"));
        assert!(remote_sampling_fields("some-new-endpoint").contains(&"logit_bias"));
    }

    #[test]
    fn gateway_extensions_only_carry_non_standard_samplers() {
        assert_eq!(SamplingConfig::default().gateway_extensions(), None);
        let cfg = SamplingConfig {
            temperature: Some(0.3),
            top_k: Some(20),
            repeat_penalty: Some(1.05),
            ..SamplingConfig::default()
        };
        assert_eq!(
            cfg.gateway_extensions(),
            Some(serde_json::json!({"top_k": 20, "repeat_penalty": 1.05}))
        );
        let forwarded = cfg.with_gateway_extensions();
        assert_eq!(
            forwarded.extra.get(GATEWAY_SAMPLING_FIELD),
            cfg.gateway_extensions().as_ref()
        );
        assert_eq!(forwarded.temperature, Some(0.3));
    }

    #[test]
    fn retain_fields_drops_unsupported_knobs() {
        let filtered = every_field().retain_fields(&remote_sampling_fields("anthropic"));
        assert_eq!(filtered.top_k, Some(40));
        assert_eq!(filtered.temperature, Some(0.5));
        assert_eq!(filtered.min_p, None);
        assert_eq!(filtered.seed, None);
        assert!(filtered.logit_bias.is_empty());
    }

    #[test]
    fn builtins_are_read_only_and_universally_supported() {
        let presets = builtin_presets();
        assert!(!presets.is_empty());
        for preset in presets {
            assert!(preset.builtin);
            assert!(preset.id.starts_with(BUILTIN_PRESET_PREFIX));
            let narrow = remote_sampling_fields("bedrock-api");
            assert_eq!(preset.sampling.retain_fields(&narrow), preset.sampling);
        }
    }

    #[test]
    fn preset_round_trips_with_defaults() {
        let parsed: InferencePreset =
            serde_json::from_value(serde_json::json!({"id": "p1", "name": "Mine"})).unwrap();
        assert_eq!(parsed.target, PresetTarget::Any);
        assert!(parsed.sampling.is_empty());
        assert!(!parsed.builtin);
    }
}
