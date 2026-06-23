//! Engine-agnostic *inference configuration* — the "advanced model settings"
//! surface (jan.ai / LM Studio parity) implemented once, translated per engine.
//!
//! There are two distinct layers, with two different lifetimes and two homes:
//!
//! 1. [`SamplingConfig`] — **per-request** generation knobs (temperature, top_p,
//!    top_k, min_p, penalties, mirostat, DRY, seed, …). These ride in the
//!    OpenAI-compat chat body on every call and need **no engine restart**. They
//!    live on the agent record (per-agent defaults) and may be overridden per
//!    request. [`SamplingConfig::apply_to_body`] merges them into the outbound
//!    JSON, translating field names for the target engine.
//!
//! 2. [`LaunchConfig`] — **engine-launch** flags (context size, GPU layers, MoE
//!    offload, chat template / jinja, speculative draft model, quantization, …).
//!    These are set when the engine process *starts*, so changing them requires a
//!    respawn. They are keyed **per model** (one resident `llama-server` serves
//!    every agent, so these belong to the loaded model, not the agent) and stored
//!    in the preferences KV. [`LaunchConfig::to_args`] builds the per-engine
//!    command-line argument vector.
//!
//! ## Nothing hardcoded
//!
//! Both layers carry a raw passthrough escape hatch — [`SamplingConfig::extra`]
//! (arbitrary body fields) and [`LaunchConfig::extra_args`] (raw CLI args). A
//! sampler or research flag the typed surface doesn't enumerate (turboquant, a
//! brand-new llama.cpp knob) works the day the engine build supports it, with no
//! Core code change. This mirrors the existing sdcpp "proxy the body verbatim"
//! pattern and the repo's #1 principle. (MTP and n-gram speculative decoding are
//! now first-class via [`LaunchConfig::spec_type`].)
//!
//! ## Per-engine reality (verified against each engine's source)
//!
//! - **llama.cpp** (`b9670`): richest surface; accepts every sampler as a body
//!   field and every flag on `llama-server`'s command line, including MTP
//!   speculative decoding (`--spec-type draft-mtp`). NOTE: b9xxx renamed
//!   `--draft-max`/`--draft-min` to `--spec-draft-n-max`/`--spec-draft-n-min`.
//! - **vLLM** / **SGLang**: OpenAI-compat bodies accept the common samplers plus
//!   extensions (`top_k`, `min_p`, `repetition_penalty`); launch flags differ
//!   (`--max-model-len` / `--context-length`, `--gpu-memory-utilization` /
//!   `--mem-fraction-static`, `--speculative-config` / `--speculative-algorithm`).
//! - **Ollama**: its OpenAI-compat endpoint deserializes into a *fixed struct of
//!   the 7 standard OpenAI fields* — no `options` passthrough. So non-standard
//!   sampling and all runtime/load knobs are emitted as Modelfile `PARAMETER`
//!   directives ([`LaunchConfig::to_ollama_modelfile`] /
//!   [`SamplingConfig::ollama_modelfile_params`]) applied when the model is loaded,
//!   keeping the gateway on the request path.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The local inference engines that accept tuning. Remote OpenAI-compat providers
/// map to [`Engine::Other`]: only the OpenAI-standard sampling fields are emitted
/// for them so a real OpenAI endpoint never 400s on an unknown sampler field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    LlamaCpp,
    Ollama,
    Vllm,
    Sglang,
    /// Apple MLX (`mlx_lm server`). Its launch surface is minimal and its
    /// OpenAI-compat body accepts only the standard sampling fields plus
    /// `repetition_penalty`, so it is treated conservatively (standard-only body,
    /// no launch flags) to avoid 400s on unsupported knobs.
    Mlx,
    Other,
}

impl Engine {
    /// Resolve from the engine-binding string used across Core (`"llamacpp"`,
    /// `"ollama"`, `"vllm"`, `"sglang"`). An optional `"acp:"` prefix or anything
    /// unrecognised maps to [`Engine::Other`].
    pub fn from_name(name: &str) -> Self {
        let n = name.trim().trim_start_matches("acp:").to_ascii_lowercase();
        match n.as_str() {
            "llamacpp" | "llama.cpp" | "llama" => Self::LlamaCpp,
            "ollama" => Self::Ollama,
            "vllm" => Self::Vllm,
            "sglang" => Self::Sglang,
            "mlx" => Self::Mlx,
            // mlx-vlm and oMLX are new engines whose exact sampler surface is not
            // yet verified here, so they are treated conservatively as `Other`
            // (only the standard OpenAI fields are emitted — never a non-standard
            // sampler that could 400). Promote to a dedicated arm once verified.
            "mlx-vlm" | "mlxvlm" | "omlx" => Self::Other,
            _ => Self::Other,
        }
    }

    /// Whether this is a local engine Ryu spawns (and can therefore tune with
    /// launch flags and non-standard sampler fields).
    pub fn is_local(self) -> bool {
        !matches!(self, Self::Other)
    }
}

// ── Sampling (per-request) ──────────────────────────────────────────────────────

/// Per-request generation parameters in a canonical, engine-agnostic form.
///
/// All fields are optional: `None` means "don't send it — use the engine default".
/// Serialised onto the agent record (defaults) and accepted as a per-request
/// override on [`crate::sidecar::adapters::ChatStreamRequest`].
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SamplingConfig {
    // ── Universally-supported (OpenAI-standard where a standard name exists) ──
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frequency_penalty: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presence_penalty: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stop: Vec<String>,

    // ── llama.cpp / vLLM / SGLang body extensions (NOT remote-OpenAI safe) ────
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_k: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_p: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub typical_p: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_n_sigma: Option<f64>,
    /// Canonical "repeat penalty". Emitted as `repeat_penalty` for llama.cpp /
    /// Ollama and as `repetition_penalty` for vLLM / SGLang.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat_penalty: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat_last_n: Option<i64>,

    // ── llama.cpp / Ollama only ───────────────────────────────────────────────
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mirostat: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mirostat_tau: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mirostat_eta: Option<f64>,

    // ── llama.cpp only (advanced research samplers) ──────────────────────────
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dynatemp_range: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dynatemp_exponent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xtc_probability: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xtc_threshold: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dry_multiplier: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dry_base: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dry_allowed_length: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dry_penalty_last_n: Option<i64>,
    /// Sampler chain order, e.g. `"penalties;dry;top_k;typ_p;top_p;min_p;xtc;temperature"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub samplers: Option<String>,

    /// Raw passthrough: arbitrary body fields merged verbatim, overriding any
    /// typed field above. The escape hatch for knobs the typed surface omits.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

impl SamplingConfig {
    /// `true` when nothing is set — lets callers skip the merge entirely.
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    /// Overlay `other` on top of `self`: any field set on `other` wins. Used to
    /// apply a per-request override on top of the agent's stored defaults.
    pub fn merge(&self, other: &Self) -> Self {
        let mut out = self.clone();
        macro_rules! over {
            ($($f:ident),* $(,)?) => { $( if other.$f.is_some() { out.$f = other.$f; } )* };
        }
        over!(
            temperature,
            top_p,
            max_tokens,
            frequency_penalty,
            presence_penalty,
            seed,
            top_k,
            min_p,
            typical_p,
            top_n_sigma,
            repeat_penalty,
            repeat_last_n,
            mirostat,
            mirostat_tau,
            mirostat_eta,
            dynatemp_range,
            dynatemp_exponent,
            xtc_probability,
            xtc_threshold,
            dry_multiplier,
            dry_base,
            dry_allowed_length,
            dry_penalty_last_n,
        );
        if other.samplers.is_some() {
            out.samplers = other.samplers.clone();
        }
        if !other.stop.is_empty() {
            out.stop = other.stop.clone();
        }
        for (k, v) in &other.extra {
            out.extra.insert(k.clone(), v.clone());
        }
        out
    }

    /// Merge these sampling params into an outbound `/v1/chat/completions` body,
    /// translating field names for `engine`. Only fields the engine actually reads
    /// from the request body are emitted; the raw `extra` map is applied last so a
    /// passthrough value always wins. Existing body keys are not overwritten unless
    /// this config sets them (so a client-supplied value is respected only when the
    /// agent leaves the field unset).
    pub fn apply_to_body(&self, engine: Engine, body: &mut Map<String, Value>) {
        macro_rules! set_f {
            ($key:expr, $val:expr) => {
                if let Some(v) = $val {
                    if let Some(n) = serde_json::Number::from_f64(v) {
                        body.insert($key.to_owned(), Value::Number(n));
                    }
                }
            };
        }
        macro_rules! set_i {
            ($key:expr, $val:expr) => {
                if let Some(v) = $val {
                    body.insert($key.to_owned(), Value::Number(v.into()));
                }
            };
        }

        // Universally-supported / OpenAI-standard fields. These are safe on every
        // engine including remote OpenAI.
        set_f!("temperature", self.temperature);
        set_f!("top_p", self.top_p);
        set_i!("max_tokens", self.max_tokens);
        set_f!("frequency_penalty", self.frequency_penalty);
        set_f!("presence_penalty", self.presence_penalty);
        set_i!("seed", self.seed);
        if !self.stop.is_empty() {
            body.insert(
                "stop".to_owned(),
                Value::Array(self.stop.iter().cloned().map(Value::String).collect()),
            );
        }

        // Non-standard sampler fields. Only emit for local engines whose
        // OpenAI-compat endpoint reads them from the body — never for remote
        // OpenAI (would 400) and never for Ollama (fixed 7-field struct; these
        // are applied via the Modelfile instead).
        match engine {
            Engine::LlamaCpp => {
                set_i!("top_k", self.top_k);
                set_f!("min_p", self.min_p);
                set_f!("typical_p", self.typical_p);
                set_f!("top_n_sigma", self.top_n_sigma);
                set_f!("repeat_penalty", self.repeat_penalty);
                set_i!("repeat_last_n", self.repeat_last_n);
                set_i!("mirostat", self.mirostat);
                set_f!("mirostat_tau", self.mirostat_tau);
                set_f!("mirostat_eta", self.mirostat_eta);
                set_f!("dynatemp_range", self.dynatemp_range);
                set_f!("dynatemp_exponent", self.dynatemp_exponent);
                set_f!("xtc_probability", self.xtc_probability);
                set_f!("xtc_threshold", self.xtc_threshold);
                set_f!("dry_multiplier", self.dry_multiplier);
                set_f!("dry_base", self.dry_base);
                set_i!("dry_allowed_length", self.dry_allowed_length);
                set_i!("dry_penalty_last_n", self.dry_penalty_last_n);
                if let Some(s) = &self.samplers {
                    body.insert("samplers".to_owned(), Value::String(s.clone()));
                }
            }
            Engine::Vllm | Engine::Sglang => {
                set_i!("top_k", self.top_k);
                set_f!("min_p", self.min_p);
                // vLLM + SGLang spell the repeat penalty `repetition_penalty`.
                set_f!("repetition_penalty", self.repeat_penalty);
            }
            Engine::Mlx => {
                // mlx_lm's body accepts `repetition_penalty` but not top_k/min_p,
                // so only that extension rides along beyond the standard fields.
                set_f!("repetition_penalty", self.repeat_penalty);
            }
            // Ollama: only the 7 standard fields above survive its OpenAI endpoint.
            // Everything else is set in the Modelfile (see ollama_modelfile_params).
            Engine::Ollama | Engine::Other => {}
        }

        // Raw passthrough — applied last so it always wins. Allowed on every
        // engine: the caller opted in explicitly, so we honour it verbatim.
        for (k, v) in &self.extra {
            body.insert(k.clone(), v.clone());
        }
    }

    /// The Ollama Modelfile `PARAMETER <name> <value>` lines for the sampler
    /// fields Ollama supports but cannot receive via its OpenAI endpoint. The
    /// standard 7 (temperature/top_p/…) are sent per-request and omitted here.
    pub fn ollama_modelfile_params(&self) -> Vec<(String, String)> {
        let mut out = Vec::new();
        macro_rules! p {
            ($name:expr, $val:expr) => {
                if let Some(v) = $val {
                    out.push(($name.to_owned(), v.to_string()));
                }
            };
        }
        p!("top_k", self.top_k);
        p!("min_p", self.min_p);
        p!("typical_p", self.typical_p);
        p!("repeat_penalty", self.repeat_penalty);
        p!("repeat_last_n", self.repeat_last_n);
        p!("mirostat", self.mirostat);
        p!("mirostat_tau", self.mirostat_tau);
        p!("mirostat_eta", self.mirostat_eta);
        out
    }
}

// ── Launch (per-model, engine-start) ────────────────────────────────────────────

/// Per-model engine-launch configuration in a canonical, engine-agnostic form.
///
/// Translated to a per-engine argument vector by [`LaunchConfig::to_args`]
/// (llama.cpp / vLLM / SGLang) or to Modelfile directives by
/// [`LaunchConfig::to_ollama_modelfile`]. Changing any field requires the engine
/// process to restart, so these are stored per model and applied on load.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct LaunchConfig {
    // ── Common: context + hardware ────────────────────────────────────────────
    /// Context window. `-c/--ctx-size` (llama.cpp), `--max-model-len` (vLLM),
    /// `--context-length` (SGLang), `num_ctx` (Ollama).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ctx_size: Option<u32>,
    /// GPU layers to offload. `-ngl` (llama.cpp), `num_gpu` (Ollama). vLLM/SGLang
    /// have no layer count — they use memory fraction + parallelism instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu_layers: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ubatch_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threads: Option<i32>,
    /// `on` | `off` | `auto` (llama.cpp `-fa`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flash_attn: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_type_k: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_type_v: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mlock: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_mmap: Option<bool>,

    // ── Concurrency / continuous batching (llama.cpp server) ──────────────────
    /// Number of server slots = the max requests llama-server batches together in
    /// one decode loop. `-np/--parallel N`. More slots ⇒ higher total throughput
    /// when several requests run at once (Ryu fan-out: delegate / threads / teams /
    /// council / workflows all hit the one resident engine), at the cost of KV-cache
    /// memory shared across slots. `None` ⇒ Core picks a memory-aware default at
    /// spawn (see [`crate::model_catalog::device::default_parallel_slots`]). Set to
    /// `1` to force the old single-slot serialization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parallel: Option<u32>,
    /// Keep a single unified KV buffer shared across all slots (`-kvu/--kv-unified`).
    /// Passing `--parallel N` explicitly disables llama-server's auto unified-KV,
    /// which would otherwise split the `-c` context rigidly into `c/N` per slot;
    /// re-enabling it keeps one shared buffer so per-request context degrades
    /// gracefully under load instead of being hard-divided. `None` ⇒ Core emits it
    /// when `parallel > 1`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kv_unified: Option<bool>,
    /// Minimum chunk size to reuse from the prompt cache via KV shifting
    /// (`--cache-reuse N`, llama-server default `0` = off). Reuses a shared prefix's
    /// KV across requests — a real win for Ryu's shared system block (skills +
    /// long-term memory) injected into every fan-out request. `None` ⇒ Core enables
    /// a small default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_reuse: Option<u32>,
    /// Continuous (dynamic) batching. `-cb/--cont-batching` is ENABLED by default in
    /// modern llama-server, so this only emits the negative `--no-cont-batching` when
    /// explicitly set to `false`. `None` / `true` ⇒ leave the default (on).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cont_batching: Option<bool>,

    // ── MoE offload (llama.cpp) ───────────────────────────────────────────────
    /// Keep all MoE expert weights on CPU (`--cpu-moe`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_moe: Option<bool>,
    /// Keep MoE weights of the first N layers on CPU (`--n-cpu-moe`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub n_cpu_moe: Option<u32>,
    /// Raw tensor buffer-type override pattern (`-ot/--override-tensor`), e.g.
    /// `"\\.ffn_.*_exps\\.=CPU"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub override_tensor: Option<String>,

    // ── Chat template (jinja) ─────────────────────────────────────────────────
    /// Enable the jinja chat-template engine (`--jinja`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jinja: Option<bool>,
    /// Inline custom chat template string (`--chat-template`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_template: Option<String>,
    /// Path to a chat-template file (`--chat-template-file`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_template_file: Option<String>,

    // ── Speculative decoding (draft model / MTP) ──────────────────────────────
    /// llama.cpp speculative-decoding type (`--spec-type`): `draft-mtp`
    /// (multi-token prediction — uses the model's MTP head, or a separate
    /// `*-assist-*.gguf` draft for Gemma-4 E2B/E4B), or an n-gram variant
    /// (`ngram-cache` | `ngram-simple` | `ngram-map-k` | `ngram-map-k4v` |
    /// `ngram-mod`). Comma-separated values are allowed. Ignored by other engines
    /// (SGLang uses `speculative_algorithm`, vLLM uses `speculative_config`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec_type: Option<String>,
    /// Draft model path. `-md/--model-draft` (llama.cpp),
    /// `--speculative-draft-model-path` (SGLang), folded into
    /// `--speculative-config` (vLLM). For Gemma-4 MTP this is the separate
    /// `*-assist-*.gguf`; for MTP models that carry the head in-file, leave unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft_model: Option<String>,
    /// Max tokens to draft. llama.cpp `--spec-draft-n-max` (renamed from the
    /// removed `--draft-max` in b9670), `--speculative-num-steps` (SGLang).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft_max: Option<u32>,
    /// Min draft tokens. llama.cpp `--spec-draft-n-min` (renamed from the removed
    /// `--draft-min` in b9670).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft_min: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft_p_min: Option<f64>,

    // ── RoPE / YaRN context extension (llama.cpp) ─────────────────────────────
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rope_scaling: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rope_scale: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rope_freq_base: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rope_freq_scale: Option<f64>,

    // ── vLLM / SGLang: memory, parallelism, quantization ──────────────────────
    /// vLLM `--gpu-memory-utilization` (0.0–1.0).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu_memory_utilization: Option<f64>,
    /// SGLang `--mem-fraction-static` (0.0–1.0).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mem_fraction_static: Option<f64>,
    /// Tensor-parallel size. `--tensor-parallel-size` (vLLM), `--tp-size` (SGLang).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tensor_parallel: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dtype: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quantization: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kv_cache_dtype: Option<String>,
    /// vLLM `--max-num-seqs`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_num_seqs: Option<u32>,
    /// SGLang `--max-running-requests`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_running_requests: Option<u32>,
    /// vLLM `--enable-prefix-caching`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enable_prefix_caching: Option<bool>,
    /// SGLang `--speculative-algorithm` (eagle | ngram | …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speculative_algorithm: Option<String>,
    /// vLLM `--speculative-config` raw JSON object, forwarded verbatim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speculative_config: Option<Value>,

    /// Raw passthrough: extra CLI args appended verbatim to the spawn command.
    /// The escape hatch for any flag the typed surface omits (turboquant research
    /// flags, new engine knobs).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_args: Vec<String>,
}

impl LaunchConfig {
    /// Fill in memory-aware continuous-batching defaults for the llama.cpp chat
    /// engine when the user hasn't pinned them. Called at engine spawn so the
    /// default scales to the machine (and stays *out* of the persisted config —
    /// a different machine recomputes). User-set fields always win.
    ///
    /// - `parallel`: a memory-tiered slot count (the batch width) when unset.
    /// - `kv_unified`: enabled alongside multi-slot to avoid the `c/N` context
    ///   cliff that an explicit `--parallel` otherwise forces.
    /// - `cache_reuse`: a small default so shared-prefix KV (Ryu's injected
    ///   system block) is reused across requests.
    pub fn apply_llamacpp_batching_defaults(&mut self) {
        if self.parallel.is_none() {
            let device = crate::model_catalog::device::DeviceInfo::detect();
            self.parallel = Some(crate::model_catalog::device::default_parallel_slots(&device));
        }
        if self.parallel.unwrap_or(1) > 1 && self.kv_unified.is_none() {
            self.kv_unified = Some(true);
        }
        if self.cache_reuse.is_none() {
            self.cache_reuse = Some(256);
        }
    }

    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    /// Build the argument vector to append to the engine spawn command for
    /// `engine`. Returns flags only — the caller already passes `--model`/`--port`/
    /// `--host`. For [`Engine::Ollama`] this returns empty (Ollama is configured
    /// via the Modelfile, not CLI flags); use [`LaunchConfig::to_ollama_modelfile`].
    pub fn to_args(&self, engine: Engine) -> Vec<String> {
        match engine {
            Engine::LlamaCpp => self.llamacpp_args(),
            Engine::Vllm => self.vllm_args(),
            Engine::Sglang => self.sglang_args(),
            Engine::Mlx => self.mlx_args(),
            Engine::Ollama | Engine::Other => Vec::new(),
        }
    }

    fn llamacpp_args(&self) -> Vec<String> {
        let mut a = ArgBuf::default();
        a.kv("--ctx-size", self.ctx_size);
        a.kv("--n-gpu-layers", self.gpu_layers);
        a.kv("--batch-size", self.batch_size);
        a.kv("--ubatch-size", self.ubatch_size);
        a.kv("--threads", self.threads);
        // Continuous batching: N server slots batched in one decode loop. The
        // shared unified-KV pairing avoids the per-slot `c/N` context cliff that
        // an explicit `--parallel` otherwise triggers.
        a.kv("--parallel", self.parallel);
        if self.kv_unified == Some(true) {
            a.bare("--kv-unified");
        }
        a.kv("--cache-reuse", self.cache_reuse);
        // cont-batching is default-on in modern llama-server; only the negative
        // flag is meaningful here.
        if self.cont_batching == Some(false) {
            a.bare("--no-cont-batching");
        }
        a.kv_str("--flash-attn", self.flash_attn.as_deref());
        a.kv_str("--cache-type-k", self.cache_type_k.as_deref());
        a.kv_str("--cache-type-v", self.cache_type_v.as_deref());
        a.flag("--mlock", self.mlock);
        // llama-server enables mmap by default; only the negative flag exists.
        if self.no_mmap == Some(true) {
            a.bare("--no-mmap");
        }
        a.flag("--cpu-moe", self.cpu_moe);
        a.kv("--n-cpu-moe", self.n_cpu_moe);
        a.kv_str("--override-tensor", self.override_tensor.as_deref());
        a.flag("--jinja", self.jinja);
        a.kv_str("--chat-template", self.chat_template.as_deref());
        a.kv_str("--chat-template-file", self.chat_template_file.as_deref());
        a.kv_str("--spec-type", self.spec_type.as_deref());
        a.kv_str("--model-draft", self.draft_model.as_deref());
        // b9670 removed `--draft-max`/`--draft-min`; the current names are
        // `--spec-draft-n-max`/`--spec-draft-n-min` (also used by MTP).
        a.kv("--spec-draft-n-max", self.draft_max);
        a.kv("--spec-draft-n-min", self.draft_min);
        a.kv_f("--draft-p-min", self.draft_p_min);
        a.kv_str("--rope-scaling", self.rope_scaling.as_deref());
        a.kv_f("--rope-scale", self.rope_scale);
        a.kv_f("--rope-freq-base", self.rope_freq_base);
        a.kv_f("--rope-freq-scale", self.rope_freq_scale);
        a.extend(&self.extra_args);
        a.0
    }

    fn vllm_args(&self) -> Vec<String> {
        let mut a = ArgBuf::default();
        a.kv("--max-model-len", self.ctx_size);
        a.kv_f("--gpu-memory-utilization", self.gpu_memory_utilization);
        a.kv("--tensor-parallel-size", self.tensor_parallel);
        a.kv_str("--dtype", self.dtype.as_deref());
        a.kv_str("--quantization", self.quantization.as_deref());
        a.kv_str("--kv-cache-dtype", self.kv_cache_dtype.as_deref());
        a.kv("--max-num-seqs", self.max_num_seqs);
        a.flag("--enable-prefix-caching", self.enable_prefix_caching);
        // Speculative decoding: prefer the explicit raw config; else synthesise a
        // minimal one from the draft model + draft-max so the common case works
        // without the user hand-writing JSON.
        if let Some(cfg) = &self.speculative_config {
            a.push("--speculative-config");
            a.push(&cfg.to_string());
        } else if let Some(model) = &self.draft_model {
            let mut obj = serde_json::Map::new();
            obj.insert("model".into(), Value::String(model.clone()));
            if let Some(n) = self.draft_max {
                obj.insert("num_speculative_tokens".into(), Value::Number(n.into()));
            }
            a.push("--speculative-config");
            a.push(&Value::Object(obj).to_string());
        }
        a.extend(&self.extra_args);
        a.0
    }

    /// MLX (`mlx_lm server`) launch flags. The generic launch-config knobs
    /// (ctx size, GPU layers, tensor-parallel, …) don't map onto MLX's minimal
    /// server surface, so nothing typed is emitted — but the raw `extra_args`
    /// escape hatch still rides along so any `mlx_lm server` flag a user sets
    /// works the day MLX supports it ("nothing hardcoded").
    fn mlx_args(&self) -> Vec<String> {
        let mut a = ArgBuf::default();
        a.extend(&self.extra_args);
        a.0
    }

    fn sglang_args(&self) -> Vec<String> {
        let mut a = ArgBuf::default();
        a.kv("--context-length", self.ctx_size);
        a.kv_f("--mem-fraction-static", self.mem_fraction_static);
        a.kv("--tp-size", self.tensor_parallel);
        a.kv_str("--dtype", self.dtype.as_deref());
        a.kv_str("--quantization", self.quantization.as_deref());
        a.kv_str("--kv-cache-dtype", self.kv_cache_dtype.as_deref());
        a.kv("--max-running-requests", self.max_running_requests);
        a.kv_str(
            "--speculative-algorithm",
            self.speculative_algorithm.as_deref(),
        );
        a.kv_str(
            "--speculative-draft-model-path",
            self.draft_model.as_deref(),
        );
        a.kv("--speculative-num-steps", self.draft_max);
        a.extend(&self.extra_args);
        a.0
    }

    /// The Ollama Modelfile `PARAMETER <name> <value>` lines for the runtime/load
    /// knobs Ollama exposes (context size, GPU layers, batch, threads, mmap/mlock).
    /// Combined with [`SamplingConfig::ollama_modelfile_params`] to build a full
    /// Modelfile when (re)loading a model under Ollama.
    pub fn to_ollama_modelfile(&self) -> Vec<(String, String)> {
        let mut out = Vec::new();
        macro_rules! p {
            ($name:expr, $val:expr) => {
                if let Some(v) = $val {
                    out.push(($name.to_owned(), v.to_string()));
                }
            };
        }
        p!("num_ctx", self.ctx_size);
        p!("num_gpu", self.gpu_layers);
        p!("num_batch", self.batch_size);
        p!("num_thread", self.threads);
        if let Some(true) = self.mlock {
            out.push(("use_mlock".to_owned(), "true".to_owned()));
        }
        if let Some(true) = self.no_mmap {
            out.push(("use_mmap".to_owned(), "false".to_owned()));
        }
        out
    }
}

/// Tiny helper to accumulate `--flag value` pairs while skipping `None`s.
#[derive(Default)]
struct ArgBuf(Vec<String>);

impl ArgBuf {
    fn push(&mut self, s: &str) {
        self.0.push(s.to_owned());
    }
    fn bare(&mut self, flag: &str) {
        self.0.push(flag.to_owned());
    }
    fn kv<T: std::fmt::Display>(&mut self, flag: &str, val: Option<T>) {
        if let Some(v) = val {
            self.0.push(flag.to_owned());
            self.0.push(v.to_string());
        }
    }
    fn kv_f(&mut self, flag: &str, val: Option<f64>) {
        if let Some(v) = val {
            self.0.push(flag.to_owned());
            self.0.push(v.to_string());
        }
    }
    fn kv_str(&mut self, flag: &str, val: Option<&str>) {
        if let Some(v) = val {
            self.0.push(flag.to_owned());
            self.0.push(v.to_owned());
        }
    }
    /// Boolean "enable" flag: emit the bare flag when `Some(true)`.
    fn flag(&mut self, flag: &str, val: Option<bool>) {
        if val == Some(true) {
            self.0.push(flag.to_owned());
        }
    }
    fn extend(&mut self, extra: &[String]) {
        self.0.extend(extra.iter().cloned());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_from_name_handles_acp_prefix_and_case() {
        assert_eq!(Engine::from_name("llamacpp"), Engine::LlamaCpp);
        assert_eq!(Engine::from_name("acp:pi"), Engine::Other);
        assert_eq!(Engine::from_name("Ollama"), Engine::Ollama);
        assert_eq!(Engine::from_name("vllm"), Engine::Vllm);
        assert_eq!(Engine::from_name("sglang"), Engine::Sglang);
        assert_eq!(Engine::from_name("mlx"), Engine::Mlx);
        assert!(Engine::LlamaCpp.is_local());
        assert!(Engine::Mlx.is_local());
        assert!(!Engine::Other.is_local());
    }

    #[test]
    fn sampling_standard_fields_apply_to_every_engine() {
        let s = SamplingConfig {
            temperature: Some(0.0),
            max_tokens: Some(128),
            ..Default::default()
        };
        for e in [
            Engine::LlamaCpp,
            Engine::Vllm,
            Engine::Sglang,
            Engine::Mlx,
            Engine::Other,
        ] {
            let mut body = Map::new();
            s.apply_to_body(e, &mut body);
            assert_eq!(body["temperature"], serde_json::json!(0.0));
            assert_eq!(body["max_tokens"], serde_json::json!(128));
        }
    }

    #[test]
    fn repeat_penalty_field_name_differs_per_engine() {
        let s = SamplingConfig {
            repeat_penalty: Some(1.1),
            top_k: Some(40),
            ..Default::default()
        };
        let mut llama = Map::new();
        s.apply_to_body(Engine::LlamaCpp, &mut llama);
        assert_eq!(llama["repeat_penalty"], serde_json::json!(1.1));
        assert_eq!(llama["top_k"], serde_json::json!(40));
        assert!(!llama.contains_key("repetition_penalty"));

        let mut vllm = Map::new();
        s.apply_to_body(Engine::Vllm, &mut vllm);
        assert_eq!(vllm["repetition_penalty"], serde_json::json!(1.1));
        assert!(!vllm.contains_key("repeat_penalty"));
    }

    #[test]
    fn non_standard_fields_skipped_for_remote_openai() {
        let s = SamplingConfig {
            top_k: Some(40),
            min_p: Some(0.05),
            ..Default::default()
        };
        let mut body = Map::new();
        s.apply_to_body(Engine::Other, &mut body);
        assert!(
            !body.contains_key("top_k"),
            "remote OpenAI would 400 on top_k"
        );
        assert!(!body.contains_key("min_p"));
    }

    #[test]
    fn extra_passthrough_wins_and_applies_everywhere() {
        let mut extra = Map::new();
        extra.insert("temperature".into(), serde_json::json!(0.9));
        extra.insert("mtp_draft".into(), serde_json::json!(true));
        let s = SamplingConfig {
            temperature: Some(0.1),
            extra,
            ..Default::default()
        };
        let mut body = Map::new();
        s.apply_to_body(Engine::Other, &mut body);
        assert_eq!(
            body["temperature"],
            serde_json::json!(0.9),
            "extra overrides typed"
        );
        assert_eq!(
            body["mtp_draft"],
            serde_json::json!(true),
            "passthrough on any engine"
        );
    }

    #[test]
    fn merge_override_wins_per_field() {
        let base = SamplingConfig {
            temperature: Some(0.7),
            top_k: Some(40),
            ..Default::default()
        };
        let over = SamplingConfig {
            temperature: Some(0.2),
            ..Default::default()
        };
        let m = base.merge(&over);
        assert_eq!(m.temperature, Some(0.2));
        assert_eq!(m.top_k, Some(40), "untouched field kept from base");
    }

    #[test]
    fn llamacpp_args_cover_common_flags() {
        let c = LaunchConfig {
            ctx_size: Some(8192),
            gpu_layers: Some(35),
            cpu_moe: Some(true),
            jinja: Some(true),
            chat_template_file: Some("/tmp/tpl.jinja".into()),
            draft_model: Some("/models/draft.gguf".into()),
            draft_max: Some(16),
            extra_args: vec!["--device".into(), "none".into()],
            ..Default::default()
        };
        let args = c.to_args(Engine::LlamaCpp);
        let joined = args.join(" ");
        assert!(joined.contains("--ctx-size 8192"));
        assert!(joined.contains("--n-gpu-layers 35"));
        assert!(joined.contains("--cpu-moe"));
        assert!(joined.contains("--jinja"));
        assert!(joined.contains("--chat-template-file /tmp/tpl.jinja"));
        assert!(joined.contains("--model-draft /models/draft.gguf"));
        // b9670 renamed --draft-max → --spec-draft-n-max (old flag is rejected).
        assert!(joined.contains("--spec-draft-n-max 16"));
        assert!(
            !joined.contains("--draft-max"),
            "removed flag must not be emitted"
        );
        assert!(joined.contains("--device none"), "extra_args passthrough");
    }

    #[test]
    fn llamacpp_emits_continuous_batching_flags() {
        let c = LaunchConfig {
            parallel: Some(4),
            kv_unified: Some(true),
            cache_reuse: Some(256),
            ..Default::default()
        };
        let joined = c.to_args(Engine::LlamaCpp).join(" ");
        assert!(joined.contains("--parallel 4"));
        assert!(joined.contains("--kv-unified"));
        assert!(joined.contains("--cache-reuse 256"));
        // cont-batching is default-on, so the unset case emits no flag either way.
        assert!(!joined.contains("--no-cont-batching"));
    }

    #[test]
    fn llamacpp_cont_batching_only_emits_negative_flag() {
        // None / true ⇒ silent (default is on); only false ⇒ the negative flag.
        let on = LaunchConfig {
            cont_batching: Some(true),
            ..Default::default()
        };
        assert!(!on.to_args(Engine::LlamaCpp).join(" ").contains("cont-batching"));
        let off = LaunchConfig {
            cont_batching: Some(false),
            ..Default::default()
        };
        assert!(
            off.to_args(Engine::LlamaCpp)
                .join(" ")
                .contains("--no-cont-batching")
        );
    }

    #[test]
    fn batching_defaults_are_memory_aware_and_respect_user_overrides() {
        // Unset ⇒ Core fills a sensible slot count + pairs unified KV + cache-reuse.
        let mut auto = LaunchConfig::default();
        auto.apply_llamacpp_batching_defaults();
        let slots = auto.parallel.expect("a default slot count is chosen");
        assert!(slots >= 1, "at least one slot");
        if slots > 1 {
            assert_eq!(auto.kv_unified, Some(true), "multi-slot pairs unified KV");
        }
        assert_eq!(auto.cache_reuse, Some(256));

        // A user pin always wins and is never overwritten.
        let mut pinned = LaunchConfig {
            parallel: Some(1),
            cache_reuse: Some(0),
            ..Default::default()
        };
        pinned.apply_llamacpp_batching_defaults();
        assert_eq!(pinned.parallel, Some(1), "user slot count preserved");
        assert_eq!(pinned.cache_reuse, Some(0), "user cache-reuse preserved");
        assert_eq!(pinned.kv_unified, None, "single slot ⇒ no unified-KV forced");
    }

    #[test]
    fn llamacpp_emits_mtp_spec_type() {
        // MTP (multi-token prediction): `--spec-type draft-mtp` + a draft cap, and
        // optionally the separate assist GGUF as the draft model (Gemma-4 E2B/E4B).
        let c = LaunchConfig {
            spec_type: Some("draft-mtp".into()),
            draft_model: Some("/models/gemma-4-E2B-it-assist-Q4_0.gguf".into()),
            draft_max: Some(3),
            ..Default::default()
        };
        let joined = c.to_args(Engine::LlamaCpp).join(" ");
        assert!(joined.contains("--spec-type draft-mtp"));
        assert!(joined.contains("--model-draft /models/gemma-4-E2B-it-assist-Q4_0.gguf"));
        assert!(joined.contains("--spec-draft-n-max 3"));
    }

    #[test]
    fn vllm_synthesises_speculative_config_from_draft_model() {
        let c = LaunchConfig {
            ctx_size: Some(4096),
            gpu_memory_utilization: Some(0.9),
            draft_model: Some("eagle-head".into()),
            draft_max: Some(5),
            ..Default::default()
        };
        let args = c.to_args(Engine::Vllm);
        let joined = args.join(" ");
        assert!(joined.contains("--max-model-len 4096"));
        assert!(joined.contains("--gpu-memory-utilization 0.9"));
        assert!(joined.contains("--speculative-config"));
        assert!(joined.contains("num_speculative_tokens"));
    }

    #[test]
    fn sglang_maps_context_and_speculative() {
        let c = LaunchConfig {
            ctx_size: Some(4096),
            mem_fraction_static: Some(0.8),
            speculative_algorithm: Some("eagle".into()),
            draft_model: Some("draft".into()),
            draft_max: Some(3),
            ..Default::default()
        };
        let joined = c.to_args(Engine::Sglang).join(" ");
        assert!(joined.contains("--context-length 4096"));
        assert!(joined.contains("--mem-fraction-static 0.8"));
        assert!(joined.contains("--speculative-algorithm eagle"));
        assert!(joined.contains("--speculative-draft-model-path draft"));
        assert!(joined.contains("--speculative-num-steps 3"));
    }

    #[test]
    fn ollama_uses_modelfile_not_args() {
        let c = LaunchConfig {
            ctx_size: Some(8192),
            gpu_layers: Some(20),
            ..Default::default()
        };
        assert!(c.to_args(Engine::Ollama).is_empty());
        let mf = c.to_ollama_modelfile();
        assert!(mf.contains(&("num_ctx".to_owned(), "8192".to_owned())));
        assert!(mf.contains(&("num_gpu".to_owned(), "20".to_owned())));
    }
}
