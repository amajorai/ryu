//! Per-engine *native option* catalogs — the "adapter" that exposes each local
//! runtime's own launch surface (llama-server, whisper-server, sd-server,
//! llama-tts, vLLM, SGLang, `mlx_lm server`, `mlx_vlm.server`, `mlx-serve`,
//! `omlx serve`, `apfel --serve`, `mesh-llm serve`, `audiocpp_server`, the Ryu
//! Audio TTS sidecar and `ollama serve`) without growing a typed
//! [`crate::LaunchConfig`] field for every upstream flag.
//!
//! A catalog is a static table of [`NativeOption`]s. Each entry names a stable
//! storage key, how the value reaches the runtime (a CLI flag or an environment
//! variable), and the value's shape. The same table drives:
//!
//! - the argument / environment builders ([`native_args`], [`native_env`]) used
//!   at engine spawn, and
//! - the settings UI, which renders whatever the catalog lists (served by Core
//!   at `GET /api/engines/{engine}/launch-options`).
//!
//! Values live in [`crate::LaunchConfig::native`] keyed by [`NativeOption::key`].
//! Keys are shared across catalogs only when they mean the same thing (for
//! example `trust_remote_code` for vLLM, SGLang, MLX and MLX-VLM), so one
//! per-model map applies to whichever engine serves the model. Builders read
//! only the keys the target engine's catalog lists and silently skip values
//! that do not match the declared shape — a stale or hand-edited preference
//! never breaks a spawn.
//!
//! Catalogs deliberately omit flags that Core manages (host, port, model path,
//! projector, pooling for the embedding/reranker tiers, API keys, config files
//! Core writes) and flags that already have a typed [`crate::LaunchConfig`]
//! field for that engine. Anything not listed still works through
//! [`crate::LaunchConfig::extra_args`] where the engine has a command line.
//!
//! Every row is checked against the upstream source of the build Ryu installs:
//! llama.cpp `b10218` (llama-server and llama-tts), whisper.cpp `v1.8.6`,
//! stable-diffusion.cpp `master-890-74988b2`, audio.cpp `v0.7.1` and the Ryu
//! Audio TTS sidecar `v0.1.2` (pinned downloads) and mlx-vlm `0.7.8` (pinned
//! pip install). Engines installed at the latest release or adopted from the
//! system were checked at the current release: mlx-lm `0.32.2`, vLLM `0.32.0`,
//! SGLang `0.5.22`, Ollama `v0.40.6`, oMLX `v0.7.1rc1` (Homebrew formula),
//! mlx-serve `v26.8.10` and `v26.10.2` (rows are present in both), apfel
//! `v1.16.0` (rows also present in `v1.0.0`), and Mesh LLM `v0.78.1`.

use serde::Serialize;
use serde_json::{Map, Value};

/// How an option's value reaches the runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "type", content = "name", rename_all = "snake_case")]
pub enum NativeTarget {
    /// A command-line flag. Booleans emit the bare flag when `true`; other
    /// kinds emit `flag value`.
    Flag(&'static str),
    /// An environment variable on the spawned process. Booleans emit `1`/`0`.
    Env(&'static str),
}

/// The value shape an option accepts.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NativeKind {
    Int {
        #[serde(skip_serializing_if = "Option::is_none")]
        min: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max: Option<i64>,
    },
    Float {
        #[serde(skip_serializing_if = "Option::is_none")]
        min: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max: Option<f64>,
    },
    Text,
    Bool,
    Enum {
        values: &'static [&'static str],
    },
}

/// One native launch option for an engine.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct NativeOption {
    /// Storage key inside [`crate::LaunchConfig::native`].
    pub key: &'static str,
    pub label: &'static str,
    /// UI grouping heading.
    pub group: &'static str,
    pub help: &'static str,
    pub target: NativeTarget,
    pub kind: NativeKind,
}

const fn int(min: Option<i64>, max: Option<i64>) -> NativeKind {
    NativeKind::Int { min, max }
}

const fn float(min: Option<f64>, max: Option<f64>) -> NativeKind {
    NativeKind::Float { min, max }
}

const fn opt(
    key: &'static str,
    label: &'static str,
    group: &'static str,
    help: &'static str,
    target: NativeTarget,
    kind: NativeKind,
) -> NativeOption {
    NativeOption {
        key,
        label,
        group,
        help,
        target,
        kind,
    }
}

use NativeKind::{Bool, Text};
use NativeTarget::{Env, Flag};

const CPU: &str = "CPU & threads";
const GPU: &str = "GPU & memory";
const CONTEXT: &str = "Context";
const REASONING: &str = "Reasoning & templates";
const DRAFT: &str = "Speculative decoding";
const ADAPTERS: &str = "Adapters";
const SERVER: &str = "Server";
const SCHEDULER: &str = "Scheduler & batching";
const DECODING: &str = "Decoding defaults";
const AUDIO: &str = "Audio processing";
const VAD: &str = "Voice activity detection";
const MODEL: &str = "Model loading";
const CACHE: &str = "Prompt cache";
const NETWORK: &str = "Network";
const LOGGING: &str = "Logging";
const SPLIT: &str = "Split serving";
const MESH: &str = "Mesh membership";
const PRIVACY: &str = "Privacy & trust";

/// llama.cpp KV cache types accepted by `--cache-type-*` (`kv_cache_types`).
const LLAMA_KV_TYPES: &[&str] = &[
    "f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1",
];

/// `llama-server` (chat engine and the embedding, reranker, classify and Speech
/// Processing tiers). Typed `LaunchConfig` fields cover context size, GPU
/// layers, batch sizes, threads, slots, KV cache types, flash attention,
/// mlock/mmap, idle sleep, MoE offload, chat templates, draft model and RoPE.
/// Draft-model rows use the canonical `--spec-draft-*` names (the older
/// `--*-draft` spellings are aliases).
#[rustfmt::skip]
const LLAMA_SERVER: &[NativeOption] = &[
    opt("threads_batch", "Batch threads", CPU,
        "Threads for prompt processing and batching (default: same as threads; <= 0 = all hardware threads).",
        Flag("--threads-batch"), int(Some(-1), None)),
    opt("threads_http", "HTTP threads", CPU,
        "Threads that handle HTTP requests (-1 = auto).",
        Flag("--threads-http"), int(Some(-1), None)),
    opt("prio", "Process priority", CPU,
        "-1 low, 0 normal, 1 medium, 2 high, 3 realtime.",
        Flag("--prio"), int(Some(-1), Some(3))),
    opt("poll", "Polling level", CPU,
        "Busy-wait polling level while waiting for work (0 = no polling, 100 = max).",
        Flag("--poll"), int(Some(0), Some(100))),
    opt("numa", "NUMA strategy", CPU,
        "Optimizations for NUMA systems.",
        Flag("--numa"), NativeKind::Enum { values: &["distribute", "isolate", "numactl"] }),
    opt("device", "Devices", GPU,
        "Comma-separated devices to offload to, e.g. CUDA0,CUDA1. `none` disables offloading.",
        Flag("--device"), Text),
    opt("split_mode", "Split mode", GPU,
        "How to split the model across several GPUs (tensor is experimental).",
        Flag("--split-mode"), NativeKind::Enum { values: &["none", "layer", "row", "tensor"] }),
    opt("tensor_split", "Tensor split", GPU,
        "Fraction of the model to put on each GPU, e.g. 3,1.",
        Flag("--tensor-split"), Text),
    opt("main_gpu", "Main GPU", GPU,
        "GPU used for the whole model (split mode none) or for intermediate results (row).",
        Flag("--main-gpu"), int(Some(0), None)),
    opt("fit", "Fit to device memory", GPU,
        "Adjust unset model and context settings to fit free device memory (default on). Off uses exactly the values you gave.",
        Flag("--fit"), NativeKind::Enum { values: &["on", "off"] }),
    opt("fit_target", "Fit memory margin (MiB)", GPU,
        "Free memory each device keeps when fitting, comma-separated per device; one value applies to all (default 1024).",
        Flag("--fit-target"), Text),
    opt("fit_ctx", "Fit minimum context", GPU,
        "Smallest context size fitting may choose.",
        Flag("--fit-ctx"), int(Some(0), None)),
    opt("no_kv_offload", "Keep KV cache on CPU", GPU,
        "Disable KV cache offloading to the GPU (--no-kv-offload).",
        Flag("--no-kv-offload"), Bool),
    opt("no_op_offload", "Disable host-tensor op offload", GPU,
        "Do not offload operations on host tensor weights to the GPU (--no-op-offload).",
        Flag("--no-op-offload"), Bool),
    opt("no_mmproj_offload", "Keep projector on CPU", GPU,
        "Do not offload the multimodal projector to the GPU (--no-mmproj-offload).",
        Flag("--no-mmproj-offload"), Bool),
    opt("no_repack", "Disable weight repacking", GPU,
        "Do not repack weights into CPU-optimized layouts (--no-repack).",
        Flag("--no-repack"), Bool),
    opt("no_host", "Bypass host buffer", GPU,
        "Bypass the host buffer so extra buffer types can be used (--no-host).",
        Flag("--no-host"), Bool),
    opt("swa_full", "Full-size SWA cache", GPU,
        "Use a full-size cache for sliding-window attention models (--swa-full).",
        Flag("--swa-full"), Bool),
    opt("cache_ram", "Prompt cache RAM (MiB)", GPU,
        "Maximum host RAM for the prompt cache (-1 = no limit, 0 = disabled).",
        Flag("--cache-ram"), int(Some(-1), None)),
    opt("no_cache_idle_slots", "Don't cache idle slots", GPU,
        "Do not save idle slots to the prompt cache when a new task starts (--no-cache-idle-slots).",
        Flag("--no-cache-idle-slots"), Bool),
    opt("image_min_tokens", "Min image tokens", GPU,
        "Minimum tokens per image for dynamic-resolution vision models (default: from the model).",
        Flag("--image-min-tokens"), int(Some(1), None)),
    opt("image_max_tokens", "Max image tokens", GPU,
        "Maximum tokens per image for dynamic-resolution vision models (default: from the model).",
        Flag("--image-max-tokens"), int(Some(1), None)),
    opt("no_warmup", "Skip warmup", GPU,
        "Skip the empty warmup run at load (--no-warmup).",
        Flag("--no-warmup"), Bool),
    opt("check_tensors", "Check tensors", MODEL,
        "Validate model tensor data for invalid values at load (--check-tensors).",
        Flag("--check-tensors"), Bool),
    opt("keep", "Tokens to keep", CONTEXT,
        "Prompt tokens kept when the context is shifted (-1 = all).",
        Flag("--keep"), int(Some(-1), None)),
    opt("n_predict", "Max tokens to predict", CONTEXT,
        "Server-side generation limit when a request sets none (-1 = unlimited).",
        Flag("--n-predict"), int(Some(-1), None)),
    opt("context_shift", "Context shift", CONTEXT,
        "Shift the context instead of stopping when generation runs past it (--context-shift).",
        Flag("--context-shift"), Bool),
    opt("ctx_checkpoints", "Context checkpoints", CONTEXT,
        "Maximum context checkpoints per slot (default 32); lets SWA and hybrid models resume without reprocessing.",
        Flag("--ctx-checkpoints"), int(Some(0), None)),
    opt("checkpoint_min_step", "Checkpoint spacing", CONTEXT,
        "Minimum tokens between context checkpoints (default 256, 0 = no minimum).",
        Flag("--checkpoint-min-step"), int(Some(0), None)),
    opt("yarn_orig_ctx", "YaRN original context", CONTEXT,
        "Original context size of the model (0 = from the model).",
        Flag("--yarn-orig-ctx"), int(Some(0), None)),
    opt("yarn_ext_factor", "YaRN extrapolation factor", CONTEXT,
        "Extrapolation mix factor (-1 = from the model, 0 = full interpolation).",
        Flag("--yarn-ext-factor"), float(None, None)),
    opt("yarn_attn_factor", "YaRN attention factor", CONTEXT,
        "Scale for sqrt(t) / attention magnitude.",
        Flag("--yarn-attn-factor"), float(None, None)),
    opt("yarn_beta_slow", "YaRN beta slow", CONTEXT,
        "High correction dimension (alpha).",
        Flag("--yarn-beta-slow"), float(None, None)),
    opt("yarn_beta_fast", "YaRN beta fast", CONTEXT,
        "Low correction dimension (beta).",
        Flag("--yarn-beta-fast"), float(None, None)),
    opt("reasoning", "Reasoning", REASONING,
        "Use thinking in chat: on, off, or auto (detect from the template). Replaces enable_thinking in chat template kwargs.",
        Flag("--reasoning"), NativeKind::Enum { values: &["on", "off", "auto"] }),
    opt("reasoning_format", "Reasoning format", REASONING,
        "How thinking output is returned: in reasoning_content (deepseek) or left in the text (none).",
        Flag("--reasoning-format"),
        NativeKind::Enum { values: &["auto", "none", "deepseek", "deepseek-legacy"] }),
    opt("reasoning_budget", "Reasoning budget", REASONING,
        "-1 unrestricted, 0 ends thinking immediately, N > 0 token budget.",
        Flag("--reasoning-budget"), int(Some(-1), None)),
    opt("reasoning_budget_message", "Reasoning budget message", REASONING,
        "Message injected before the end-of-thinking tag when the reasoning budget runs out.",
        Flag("--reasoning-budget-message"), Text),
    opt("chat_template_kwargs", "Chat template kwargs", REASONING,
        "JSON object passed to the jinja template, e.g. {\"key\":\"value\"}. Use Reasoning to turn thinking on or off.",
        Flag("--chat-template-kwargs"), Text),
    opt("gpu_layers_draft", "Draft GPU layers", DRAFT,
        "Draft-model layers in VRAM: N, -1 = auto (default), -2 = all.",
        Flag("--spec-draft-ngl"), int(Some(-2), None)),
    opt("threads_draft", "Draft threads", DRAFT,
        "Threads for the draft model (default: same as threads; <= 0 = all hardware threads).",
        Flag("--spec-draft-threads"), int(Some(-1), None)),
    opt("spec_draft_threads_batch", "Draft batch threads", DRAFT,
        "Threads for draft-model prompt processing (default: same as draft threads; <= 0 = all hardware threads).",
        Flag("--spec-draft-threads-batch"), int(Some(-1), None)),
    opt("device_draft", "Draft devices", DRAFT,
        "Comma-separated devices for the draft model. `none` disables offloading.",
        Flag("--spec-draft-device"), Text),
    opt("cache_type_k_draft", "Draft cache type K", DRAFT,
        "KV cache type K for the draft model.",
        Flag("--spec-draft-type-k"), NativeKind::Enum { values: LLAMA_KV_TYPES }),
    opt("cache_type_v_draft", "Draft cache type V", DRAFT,
        "KV cache type V for the draft model.",
        Flag("--spec-draft-type-v"), NativeKind::Enum { values: LLAMA_KV_TYPES }),
    opt("spec_draft_cpu_moe", "Draft MoE on CPU", DRAFT,
        "Keep all MoE expert weights of the draft model on the CPU (--spec-draft-cpu-moe).",
        Flag("--spec-draft-cpu-moe"), Bool),
    opt("spec_draft_n_cpu_moe", "Draft MoE layers on CPU", DRAFT,
        "Keep the MoE weights of the first N draft-model layers on the CPU.",
        Flag("--spec-draft-n-cpu-moe"), int(Some(0), None)),
    opt("spec_draft_override_tensor", "Draft tensor overrides", DRAFT,
        "Override tensor buffer types for the draft model, as <pattern>=<buffer type>,...",
        Flag("--spec-draft-override-tensor"), Text),
    opt("lora", "LoRA adapter", ADAPTERS,
        "Path to a LoRA adapter GGUF.",
        Flag("--lora"), Text),
    opt("lora_scaled", "Scaled LoRA adapters", ADAPTERS,
        "LoRA adapters with a custom scale, as FNAME:SCALE,... (comma-separated).",
        Flag("--lora-scaled"), Text),
    opt("lora_init_without_apply", "Load LoRA without applying", ADAPTERS,
        "Load adapters but leave them disabled until a request scales them.",
        Flag("--lora-init-without-apply"), Bool),
    opt("timeout", "Request timeout (s)", SERVER,
        "Server read/write timeout in seconds.",
        Flag("--timeout"), int(Some(1), None)),
    opt("slot_prompt_similarity", "Slot prompt similarity", SERVER,
        "How closely a prompt must match a slot's cached prompt to reuse that slot (0 = off).",
        Flag("--slot-prompt-similarity"), float(Some(0.0), Some(1.0))),
    opt("slot_save_path", "Slot save path", SERVER,
        "Directory where slot KV caches can be saved and restored.",
        Flag("--slot-save-path"), Text),
    opt("no_cache_prompt", "Disable prompt caching", SERVER,
        "Turn off server prompt caching, which is on by default (--no-cache-prompt).",
        Flag("--no-cache-prompt"), Bool),
    opt("no_prefill_assistant", "Don't prefill assistant", SERVER,
        "Treat a trailing assistant message as complete instead of prefilling the reply (--no-prefill-assistant).",
        Flag("--no-prefill-assistant"), Bool),
    opt("sse_ping_interval", "SSE ping interval (s)", SERVER,
        "Seconds between SSE keep-alive pings on streams (-1 = disabled, default 30).",
        Flag("--sse-ping-interval"), int(Some(-1), None)),
    opt("metrics", "Prometheus metrics", SERVER,
        "Expose /metrics (--metrics).",
        Flag("--metrics"), Bool),
    opt("no_ui", "Disable web UI", SERVER,
        "Do not serve llama-server's built-in web UI (--no-ui).",
        Flag("--no-ui"), Bool),
];

/// `llama-tts` (OuteTTS). One-shot synthesis over llama.cpp's common options.
/// llama-tts reuses these settings for the WavTokenizer vocoder too.
#[rustfmt::skip]
const LLAMA_TTS: &[NativeOption] = &[
    opt("threads", "Threads", CPU,
        "CPU threads used during synthesis.",
        Flag("--threads"), int(Some(-1), None)),
    opt("threads_batch", "Batch threads", CPU,
        "CPU threads for prompt and batch processing (default: same as threads).",
        Flag("--threads-batch"), int(Some(-1), None)),
    opt("gpu_layers", "GPU layers", GPU,
        "Layers to offload to the GPU for the OuteTTS model and the WavTokenizer vocoder (-1 = auto, -2 = all).",
        Flag("--n-gpu-layers"), int(Some(-2), None)),
    opt("device", "Devices", GPU,
        "Comma-separated devices to offload to. `none` disables offloading.",
        Flag("--device"), Text),
    opt("flash_attn", "Flash attention", GPU,
        "Flash attention mode.",
        Flag("--flash-attn"), NativeKind::Enum { values: &["auto", "on", "off"] }),
    opt("ctx_size", "Context size", CONTEXT,
        "Context size for the OuteTTS model and vocoder (llama-tts default 8192, 0 = from the model).",
        Flag("--ctx-size"), int(Some(0), None)),
    opt("batch_size", "Batch size", CONTEXT,
        "Logical batch size for both models (llama-tts default 8192). The vocoder decodes all audio codes in one batch, so keep it at or above Max audio tokens.",
        Flag("--batch-size"), int(Some(512), None)),
    opt("n_predict", "Max audio tokens", DECODING,
        "Maximum audio tokens to generate (llama-tts default 4096). Keep it at or below the batch size.",
        Flag("--n-predict"), int(Some(1), None)),
    opt("top_k", "Top-k", DECODING,
        "Top-k sampling (llama-tts default 4). It is the only sampler llama-tts applies.",
        Flag("--top-k"), int(Some(0), None)),
    opt("seed", "Seed", DECODING,
        "Sampling seed. llama-tts is deterministic by default (it adds 1 internally; 4294967294 gives a random seed).",
        Flag("--seed"), int(Some(0), Some(4_294_967_294))),
    opt("tts_use_guide_tokens", "Guide tokens", AUDIO,
        "Use guide tokens to improve word recall in the spoken output (--tts-use-guide-tokens).",
        Flag("--tts-use-guide-tokens"), Bool),
    opt("tts_speaker_file", "Speaker file", AUDIO,
        "Path to an OuteTTS speaker profile JSON that sets the voice.",
        Flag("--tts-speaker-file"), Text),
    opt("load_mode", "Model load mode", MODEL,
        "How model weights are loaded: none, mmap (default), mlock, mmap+mlock, or dio (direct I/O).",
        Flag("--load-mode"),
        NativeKind::Enum { values: &["none", "mmap", "mlock", "mmap+mlock", "dio"] }),
];

/// `whisper-server`. Per-request decoding (language, temperature, temperature
/// fallback, beam size, best-of, prompt, translate, max context/length) lives in
/// the transcription profile; threads is typed.
#[rustfmt::skip]
const WHISPER_SERVER: &[NativeOption] = &[
    opt("processors", "Processors", CPU,
        "Parallel processors used for one transcription.",
        Flag("--processors"), int(Some(1), None)),
    opt("no_gpu", "Disable GPU", GPU,
        "Run on the CPU only (--no-gpu).",
        Flag("--no-gpu"), Bool),
    opt("gpu_device", "GPU device", GPU,
        "Index of the GPU to use.",
        Flag("--device"), int(Some(0), None)),
    opt("no_flash_attn", "Disable flash attention", GPU,
        "Flash attention is on by default in this build (--no-flash-attn).",
        Flag("--no-flash-attn"), Bool),
    opt("audio_ctx", "Audio context", AUDIO,
        "Audio context size (0 = full, max 1500). Smaller values are faster but less accurate.",
        Flag("--audio-ctx"), int(Some(0), Some(1500))),
    opt("split_on_word", "Split on word", AUDIO,
        "Split segments on words instead of tokens (--split-on-word).",
        Flag("--split-on-word"), Bool),
    opt("word_thold", "Word timestamp threshold", AUDIO,
        "Word timestamp probability threshold.",
        Flag("--word-thold"), float(Some(0.0), Some(1.0))),
    opt("entropy_thold", "Entropy threshold", AUDIO,
        "Entropy threshold for decoder fallback.",
        Flag("--entropy-thold"), float(Some(0.0), None)),
    opt("logprob_thold", "Log-probability threshold", AUDIO,
        "Average log-probability threshold for decoder fallback.",
        Flag("--logprob-thold"), float(None, None)),
    opt("no_speech_thold", "No-speech threshold", AUDIO,
        "Probability above which a segment is treated as silence and skipped (default 0.6).",
        Flag("--no-speech-thold"), float(Some(0.0), Some(1.0))),
    opt("carry_initial_prompt", "Carry initial prompt", AUDIO,
        "Prepend the initial prompt to every decoding window, not only the first (--carry-initial-prompt).",
        Flag("--carry-initial-prompt"), Bool),
    opt("tinydiarize", "Tinydiarize", AUDIO,
        "Speaker-turn detection; needs a tdrz model (--tinydiarize). Cannot be combined with Stereo diarization.",
        Flag("--tinydiarize"), Bool),
    opt("diarize", "Stereo diarization", AUDIO,
        "Label speakers from stereo channels (--diarize). Cannot be combined with Tinydiarize.",
        Flag("--diarize"), Bool),
    opt("dtw", "DTW timestamps preset", AUDIO,
        "Token-level DTW timestamps preset; must match the loaded model. Needs Disable flash attention (DTW is ignored while flash attention is on).",
        Flag("--dtw"),
        NativeKind::Enum { values: &[
            "tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en",
            "large.v1", "large.v2", "large.v3", "large.v3.turbo",
        ] }),
    opt("convert", "Convert input with ffmpeg", AUDIO,
        "Convert uploaded audio to WAV with ffmpeg. The server will not start if ffmpeg is not on PATH.",
        Flag("--convert"), Bool),
    opt("vad", "Voice activity detection", VAD,
        "Skip silence before transcribing (--vad). Needs a VAD model.",
        Flag("--vad"), Bool),
    opt("vad_model", "VAD model", VAD,
        "Path to a Silero VAD GGML model.",
        Flag("--vad-model"), Text),
    opt("vad_threshold", "VAD threshold", VAD,
        "Speech probability threshold.",
        Flag("--vad-threshold"), float(Some(0.0), Some(1.0))),
    opt("vad_min_speech_duration_ms", "VAD min speech (ms)", VAD,
        "Shortest speech run kept as speech (default 250 ms).",
        Flag("--vad-min-speech-duration-ms"), int(Some(0), None)),
    opt("vad_min_silence_duration_ms", "VAD min silence (ms)", VAD,
        "Silence length that splits speech segments (default 100 ms).",
        Flag("--vad-min-silence-duration-ms"), int(Some(0), None)),
    opt("vad_max_speech_duration_s", "VAD max speech (s)", VAD,
        "Longest speech segment before it is split automatically (default unlimited).",
        Flag("--vad-max-speech-duration-s"), float(Some(0.0), None)),
    opt("vad_speech_pad_ms", "VAD speech padding (ms)", VAD,
        "Padding added around each detected speech segment (default 30 ms).",
        Flag("--vad-speech-pad-ms"), int(Some(0), None)),
    opt("vad_samples_overlap", "VAD segment overlap (s)", VAD,
        "Overlap in seconds between adjacent speech segments (default 0.1).",
        Flag("--vad-samples-overlap"), float(Some(0.0), None)),
];

const SD_RNG: &[&str] = &["std_default", "cuda", "cpu"];

/// `sd-server` (stable-diffusion.cpp). Model and companion weights are managed
/// by Core. `Decoding defaults` are server-side defaults the server copies into
/// each request that leaves them unset.
#[rustfmt::skip]
const SD_SERVER: &[NativeOption] = &[
    opt("threads", "Threads", CPU,
        "CPU threads (-1 = physical cores).",
        Flag("--threads"), int(Some(-1), None)),
    opt("auto_fit", "Auto-fit weights", GPU,
        "Place weights on GPU, RAM or disk to fit available memory (default on). An explicit parameter backend disables it.",
        Flag("--auto-fit"), NativeKind::Enum { values: &["on", "off"] }),
    opt("max_vram", "VRAM budget (GiB)", GPU,
        "Per-device GiB budget for automatic fitting, e.g. 6 or cuda0=6,vulkan0=4. 0 uses live free VRAM; a negative value reserves that much.",
        Flag("--max-vram"), Text),
    opt("sd_backend", "Backend assignment", GPU,
        "Runtime device per module, e.g. cpu or clip=cpu,vae=cuda0,diffusion=vulkan0. Replaces the deprecated *-on-cpu options.",
        Flag("--backend"), Text),
    opt("params_backend", "Parameter backend", GPU,
        "Where weights live per module, e.g. disk, cpu, or diffusion=disk,clip=cpu. Setting it disables auto-fit.",
        Flag("--params-backend"), Text),
    opt("sd_split_mode", "Multi-GPU split mode", GPU,
        "How a module assigned to several devices is split: layer (default) or row (CUDA only), or per module, e.g. diffusion=row,te=layer.",
        Flag("--split-mode"), Text),
    opt("offload_to_cpu", "Offload weights to RAM", GPU,
        "Keep weights in RAM and move them to VRAM only when needed (--offload-to-cpu).",
        Flag("--offload-to-cpu"), Bool),
    opt("disable_prefetch", "Disable weight prefetch", GPU,
        "Turn off asynchronous prefetch of the next segment's weights (--disable-prefetch).",
        Flag("--disable-prefetch"), Bool),
    opt("disable_segmented_compute", "Disable segmented compute", GPU,
        "Force monolithic graph execution even when automatic graph cutting is needed (--disable-segmented-compute).",
        Flag("--disable-segmented-compute"), Bool),
    opt("clip_on_cpu", "Text encoder on CPU", GPU,
        "Run text encoders on the CPU (deprecated upstream alias for backend te=cpu).",
        Flag("--clip-on-cpu"), Bool),
    opt("vae_on_cpu", "VAE on CPU", GPU,
        "Run the VAE on the CPU (deprecated upstream alias for backend vae=cpu).",
        Flag("--vae-on-cpu"), Bool),
    opt("control_net_cpu", "ControlNet on CPU", GPU,
        "Keep ControlNet on the CPU (deprecated upstream alias for backend controlnet=cpu).",
        Flag("--control-net-cpu"), Bool),
    opt("vae_tiling", "VAE tiling", GPU,
        "Decode in tiles to reduce memory use (--vae-tiling).",
        Flag("--vae-tiling"), Bool),
    opt("vae_tile_size", "VAE tile size", GPU,
        "Tile size for VAE tiling, [X]x[Y] (default 32x32).",
        Flag("--vae-tile-size"), Text),
    opt("vae_tile_overlap", "VAE tile overlap", GPU,
        "Tile overlap as a fraction of tile size (default 0.5).",
        Flag("--vae-tile-overlap"), float(Some(0.0), Some(1.0))),
    opt("temporal_tiling", "Temporal tiling", GPU,
        "Tile video VAE decode over time where supported (--temporal-tiling).",
        Flag("--temporal-tiling"), Bool),
    opt("sd_flash_attn", "Flash attention", GPU,
        "Use flash attention in all models, not only the diffusion model (--fa).",
        Flag("--fa"), Bool),
    opt("diffusion_fa", "Diffusion flash attention", GPU,
        "Flash attention in the diffusion model; saves memory (--diffusion-fa).",
        Flag("--diffusion-fa"), Bool),
    opt("sage_attn", "SageAttention (CUDA)", GPU,
        "Native CUDA SageAttention in the diffusion model, falling back to flash or default attention (--sage-attn).",
        Flag("--sage-attn"), Bool),
    opt("diffusion_conv_direct", "Direct convolution (diffusion)", GPU,
        "Use ggml_conv2d_direct in the diffusion model (--diffusion-conv-direct).",
        Flag("--diffusion-conv-direct"), Bool),
    opt("vae_conv_direct", "Direct convolution (VAE)", GPU,
        "Use direct 2D/3D convolutions in the VAE (--vae-conv-direct).",
        Flag("--vae-conv-direct"), Bool),
    opt("weight_type", "Weight type", MODEL,
        "Convert weights to this type at load, e.g. f16, q8_0, q4_K.",
        Flag("--type"), Text),
    opt("tensor_type_rules", "Per-tensor weight types", MODEL,
        "Weight type per tensor pattern, e.g. ^vae\\.=f16,model\\.=q8_0.",
        Flag("--tensor-type-rules"), Text),
    opt("sd_mmap", "Memory-map model", MODEL,
        "Memory-map model files instead of reading them (--mmap). Off by default.",
        Flag("--mmap"), Bool),
    opt("eager_load", "Eager load", MODEL,
        "Load all weights into the parameter backend at startup instead of on first use (--eager-load).",
        Flag("--eager-load"), Bool),
    opt("prediction", "Prediction type", MODEL,
        "Override the model's prediction type.",
        Flag("--prediction"),
        NativeKind::Enum { values: &[
            "eps", "v", "edm_v", "sd3_flow", "flux_flow", "sefi_flow", "minit2i_flow",
            "sensenova_u1_flow",
        ] }),
    opt("rng", "RNG", MODEL,
        "Random number generator (default cuda, as in sd-webui; cpu matches ComfyUI).",
        Flag("--rng"), NativeKind::Enum { values: SD_RNG }),
    opt("sampler_rng", "Sampler RNG", MODEL,
        "RNG used by the sampler; defaults to the RNG setting.",
        Flag("--sampler-rng"), NativeKind::Enum { values: SD_RNG }),
    opt("lora_model_dir", "LoRA directory", ADAPTERS,
        "Directory searched for LoRA weights referenced in prompts.",
        Flag("--lora-model-dir"), Text),
    opt("lora_apply_mode", "LoRA apply mode", ADAPTERS,
        "How LoRAs are applied: auto (at runtime for quantized weights, otherwise immediately), immediately, or at_runtime.",
        Flag("--lora-apply-mode"), NativeKind::Enum { values: &["auto", "immediately", "at_runtime"] }),
    opt("embd_dir", "Embeddings directory", ADAPTERS,
        "Directory of textual-inversion embeddings referenced in prompts.",
        Flag("--embd-dir"), Text),
    opt("default_steps", "Default steps", DECODING,
        "Sampling steps when a request sets none.",
        Flag("--steps"), int(Some(1), None)),
    opt("default_cfg_scale", "Default CFG scale", DECODING,
        "Text CFG scale when a request sets none.",
        Flag("--cfg-scale"), float(Some(0.0), None)),
    opt("default_sampling_method", "Default sampler", DECODING,
        "Sampling method when a request sets none (default euler for Flux/SD3/Wan, euler_a otherwise).",
        Flag("--sampling-method"),
        NativeKind::Enum { values: &[
            "euler", "euler_a", "heun", "dpm2", "dpm++2s_a", "dpm++2m", "dpm++2mv2", "ipndm",
            "ipndm_v", "lcm", "ddim_trailing", "tcd", "res_multistep", "res_2s", "er_sde",
            "euler_cfg_pp", "euler_a_cfg_pp", "euler_ge", "dpm++2m_sde", "dpm++2m_sde_bt", "lms",
        ] }),
    opt("default_scheduler", "Default scheduler", DECODING,
        "Sigma scheduler when a request sets none (default depends on the model).",
        Flag("--scheduler"),
        NativeKind::Enum { values: &[
            "discrete", "karras", "exponential", "ays", "gits", "sgm_uniform", "simple",
            "smoothstep", "kl_optimal", "lcm", "bong_tangent", "ltx2", "logit_normal", "flux2",
            "flux", "beta", "llada_image",
        ] }),
    opt("sd_log_level", "Log level", SERVER,
        "Minimum log level for sd-server (default info).",
        Flag("--log-level"), NativeKind::Enum { values: &["debug", "verbose", "info", "warn", "error"] }),
];

/// vLLM `serve` (vLLM 0.32). Typed fields cover max model length, GPU memory
/// utilization, tensor parallelism, dtype, quantization, KV cache dtype, max
/// sequences, prefix caching and speculative config.
#[rustfmt::skip]
const VLLM: &[NativeOption] = &[
    opt("pipeline_parallel_size", "Pipeline parallel size", GPU,
        "Number of pipeline stages.",
        Flag("--pipeline-parallel-size"), int(Some(1), None)),
    opt("data_parallel_size", "Data parallel size", GPU,
        "Number of data-parallel engine replicas.",
        Flag("--data-parallel-size"), int(Some(1), None)),
    opt("enable_expert_parallel", "Expert parallelism", GPU,
        "Use expert parallelism instead of tensor parallelism for MoE layers (--enable-expert-parallel).",
        Flag("--enable-expert-parallel"), Bool),
    opt("cpu_offload_gb", "CPU offload (GiB)", GPU,
        "GiB of weights per GPU to offload to CPU memory.",
        Flag("--cpu-offload-gb"), float(Some(0.0), None)),
    opt("kv_offloading_size", "KV offload buffer (GiB)", GPU,
        "Size in GiB of the CPU KV-cache offload buffer, summed across TP ranks. Offload is off when unset.",
        Flag("--kv-offloading-size"), float(Some(0.0), None)),
    opt("block_size", "KV block size", GPU,
        "Token block size for the paged KV cache.",
        Flag("--block-size"), int(Some(1), None)),
    opt("enforce_eager", "Enforce eager mode", GPU,
        "Disable CUDA graphs (--enforce-eager).",
        Flag("--enforce-eager"), Bool),
    opt("optimization_level", "Optimization level", GPU,
        "Compilation and CUDA-graph level: 0 = none (fastest startup) to 3; default 2.",
        Flag("--optimization-level"), NativeKind::Enum { values: &["0", "1", "2", "3"] }),
    opt("max_num_batched_tokens", "Max batched tokens", SCHEDULER,
        "Maximum tokens processed in one scheduler iteration.",
        Flag("--max-num-batched-tokens"), int(Some(1), None)),
    opt("disable_chunked_prefill", "Disable chunked prefill", SCHEDULER,
        "Turn off chunked prefill, which is on by default (--no-enable-chunked-prefill). vLLM warns that this may crash or give wrong output on models that support it.",
        Flag("--no-enable-chunked-prefill"), Bool),
    opt("scheduling_policy", "Scheduling policy", SCHEDULER,
        "Order requests first-come-first-served or by request priority.",
        Flag("--scheduling-policy"), NativeKind::Enum { values: &["fcfs", "priority"] }),
    opt("long_prefill_token_threshold", "Long prefill threshold", SCHEDULER,
        "Prompt length in tokens above which a request counts as long for chunked prefill (0 = no cap, default).",
        Flag("--long-prefill-token-threshold"), int(Some(0), None)),
    opt("max_logprobs", "Max logprobs", SCHEDULER,
        "Most logprobs a request may ask for (-1 = no limit).",
        Flag("--max-logprobs"), int(Some(-1), None)),
    opt("seed", "Seed", SCHEDULER,
        "Random seed for the engine.",
        Flag("--seed"), int(Some(0), None)),
    opt("trust_remote_code", "Trust remote code", MODEL,
        "Allow model repositories to run custom code (--trust-remote-code).",
        Flag("--trust-remote-code"), Bool),
    opt("revision", "Model revision", MODEL,
        "Model branch, tag or commit to load from the Hub.",
        Flag("--revision"), Text),
    opt("tokenizer_mode", "Tokenizer mode", MODEL,
        "Tokenizer mode, e.g. auto, hf, mistral.",
        Flag("--tokenizer-mode"), Text),
    opt("generation_config", "Generation config", MODEL,
        "Where default sampling comes from: auto, vllm, or a folder path.",
        Flag("--generation-config"), Text),
    opt("override_generation_config", "Generation overrides", MODEL,
        "JSON default sampling overrides, e.g. {\"temperature\":0.5}.",
        Flag("--override-generation-config"), Text),
    opt("hf_overrides", "HF config overrides", MODEL,
        "JSON merged into the Hugging Face model config, e.g. {\"rope_scaling\":{...}}.",
        Flag("--hf-overrides"), Text),
    opt("chat_template", "Chat template", MODEL,
        "Path to a chat template file, or an inline template, that replaces the model's own.",
        Flag("--chat-template"), Text),
    opt("limit_mm_per_prompt", "Multimodal limits", MODEL,
        "JSON limits per prompt, e.g. {\"image\":4}.",
        Flag("--limit-mm-per-prompt"), Text),
    opt("mm_processor_cache_gb", "MM processor cache (GiB)", MODEL,
        "Cache size for processed multimodal inputs (0 disables it). Default 4.",
        Flag("--mm-processor-cache-gb"), float(Some(0.0), None)),
    opt("enable_lora", "Enable LoRA", ADAPTERS,
        "Allow LoRA adapters (--enable-lora).",
        Flag("--enable-lora"), Bool),
    opt("max_lora_rank", "Max LoRA rank", ADAPTERS,
        "Highest LoRA rank to support (default 16).",
        Flag("--max-lora-rank"),
        NativeKind::Enum { values: &["1", "8", "16", "32", "64", "128", "256", "320", "512"] }),
    opt("max_loras", "Max LoRAs per batch", ADAPTERS,
        "Most LoRA adapters active in a single batch.",
        Flag("--max-loras"), int(Some(1), None)),
    opt("max_cpu_loras", "Max CPU LoRAs", ADAPTERS,
        "Most LoRA adapters kept in CPU memory (must be at least Max LoRAs per batch).",
        Flag("--max-cpu-loras"), int(Some(1), None)),
    opt("reasoning_parser", "Reasoning parser", REASONING,
        "Parser that extracts reasoning content, e.g. deepseek_r1, qwen3.",
        Flag("--reasoning-parser"), Text),
    opt("default_chat_template_kwargs", "Chat template kwargs", REASONING,
        "JSON default chat-template kwargs, e.g. {\"enable_thinking\": false}.",
        Flag("--default-chat-template-kwargs"), Text),
    opt("enable_auto_tool_choice", "Auto tool choice", REASONING,
        "Let the model decide when to call tools (--enable-auto-tool-choice).",
        Flag("--enable-auto-tool-choice"), Bool),
    opt("tool_call_parser", "Tool-call parser", REASONING,
        "Parser for tool calls, e.g. hermes, llama3_json.",
        Flag("--tool-call-parser"), Text),
    opt("exclude_tools_when_tool_choice_none", "Hide tools when choice is none", REASONING,
        "Leave tool definitions out of the prompt when tool_choice is none.",
        Flag("--exclude-tools-when-tool-choice-none"), Bool),
];

/// SGLang `launch_server` (SGLang 0.5.22). Typed fields cover context length,
/// static memory fraction, TP size, dtype, quantization, KV cache dtype, max
/// running requests and the speculative algorithm, draft model and step count.
#[rustfmt::skip]
const SGLANG: &[NativeOption] = &[
    opt("dp_size", "Data parallel size", GPU,
        "Data-parallel replicas.",
        Flag("--dp-size"), int(Some(1), None)),
    opt("pp_size", "Pipeline parallel size", GPU,
        "Pipeline-parallel stages.",
        Flag("--pp-size"), int(Some(1), None)),
    opt("ep_size", "Expert parallel size", GPU,
        "Expert-parallel size for MoE models.",
        Flag("--ep-size"), int(Some(1), None)),
    opt("attention_backend", "Attention backend", GPU,
        "Attention kernel backend, e.g. flashinfer, triton, fa3.",
        Flag("--attention-backend"), Text),
    opt("disable_decode_cuda_graph", "Disable decode CUDA graph", GPU,
        "Turn off the decode-phase CUDA graph (--disable-decode-cuda-graph).",
        Flag("--disable-decode-cuda-graph"), Bool),
    opt("disable_prefill_cuda_graph", "Disable prefill CUDA graph", GPU,
        "Turn off the prefill-phase CUDA graph (--disable-prefill-cuda-graph).",
        Flag("--disable-prefill-cuda-graph"), Bool),
    opt("cuda_graph_max_bs_decode", "CUDA graph max batch (decode)", GPU,
        "Largest batch size captured in the decode CUDA graph.",
        Flag("--cuda-graph-max-bs-decode"), int(Some(1), None)),
    opt("cuda_graph_max_bs_prefill", "CUDA graph max batch (prefill)", GPU,
        "Largest batch size captured in the prefill CUDA graph.",
        Flag("--cuda-graph-max-bs-prefill"), int(Some(1), None)),
    opt("enable_torch_compile", "torch.compile", GPU,
        "Compile the model with torch.compile (--enable-torch-compile).",
        Flag("--enable-torch-compile"), Bool),
    opt("torch_compile_max_bs", "torch.compile max batch", GPU,
        "Largest batch size compiled when torch.compile is on.",
        Flag("--torch-compile-max-bs"), int(Some(1), None)),
    opt("sglang_cpu_offload_gb", "CPU offload (GB)", GPU,
        "GB of system RAM reserved for offloading weights.",
        Flag("--cpu-offload-gb"), int(Some(0), None)),
    opt("chunked_prefill_size", "Chunked prefill size", SCHEDULER,
        "Max tokens per prefill chunk (-1 disables chunking).",
        Flag("--chunked-prefill-size"), int(Some(-1), None)),
    opt("max_prefill_tokens", "Max prefill tokens", SCHEDULER,
        "Maximum tokens in one prefill batch.",
        Flag("--max-prefill-tokens"), int(Some(1), None)),
    opt("prefill_max_requests", "Max prefill requests", SCHEDULER,
        "Maximum number of requests in one prefill batch.",
        Flag("--prefill-max-requests"), int(Some(1), None)),
    opt("max_total_tokens", "Max total tokens", SCHEDULER,
        "Token capacity of the memory pool.",
        Flag("--max-total-tokens"), int(Some(1), None)),
    opt("max_queued_requests", "Max queued requests", SCHEDULER,
        "Maximum number of requests waiting in the queue.",
        Flag("--max-queued-requests"), int(Some(1), None)),
    opt("page_size", "Page size", SCHEDULER,
        "Tokens per KV-cache page.",
        Flag("--page-size"), int(Some(1), None)),
    opt("schedule_policy", "Schedule policy", SCHEDULER,
        "Request scheduling policy (default fcfs).",
        Flag("--schedule-policy"),
        NativeKind::Enum { values: &[
            "fcfs", "lpm", "random", "dfs-weight", "lof", "priority", "routing-key", "hrrn",
            "shortest-prefill-first",
        ] }),
    opt("enable_priority_scheduling", "Priority scheduling", SCHEDULER,
        "Schedule requests by their priority value (--enable-priority-scheduling).",
        Flag("--enable-priority-scheduling"), Bool),
    opt("schedule_conservativeness", "Schedule conservativeness", SCHEDULER,
        "Higher values admit fewer requests at once.",
        Flag("--schedule-conservativeness"), float(Some(0.0), None)),
    opt("disable_radix_cache", "Disable radix cache", SCHEDULER,
        "Turn off prefix caching (--disable-radix-cache).",
        Flag("--disable-radix-cache"), Bool),
    opt("enable_hierarchical_cache", "Hierarchical cache", SCHEDULER,
        "Spill the prefix cache to host memory (--enable-hierarchical-cache).",
        Flag("--enable-hierarchical-cache"), Bool),
    opt("hicache_ratio", "Host cache ratio", SCHEDULER,
        "Host KV pool size as a multiple of the device pool (with hierarchical cache).",
        Flag("--hicache-ratio"), float(Some(0.0), None)),
    opt("enable_mixed_chunk", "Mixed chunk", SCHEDULER,
        "Mix prefill and decode in one batch (--enable-mixed-chunk).",
        Flag("--enable-mixed-chunk"), Bool),
    opt("stream_interval", "Stream interval", SCHEDULER,
        "Tokens buffered per streamed chunk; higher favours throughput.",
        Flag("--stream-interval"), int(Some(1), None)),
    opt("enable_deterministic_inference", "Deterministic inference", SCHEDULER,
        "Use batch-invariant ops for reproducible outputs (--enable-deterministic-inference).",
        Flag("--enable-deterministic-inference"), Bool),
    opt("random_seed", "Seed", SCHEDULER,
        "Random seed for the server.",
        Flag("--random-seed"), int(Some(0), None)),
    opt("grammar_backend", "Grammar backend", DECODING,
        "Backend for grammar-guided (structured) decoding.",
        Flag("--grammar-backend"),
        NativeKind::Enum { values: &["xgrammar", "outlines", "llguidance", "none"] }),
    opt("speculative_eagle_topk", "EAGLE top-k", DRAFT,
        "Branching factor per EAGLE draft step.",
        Flag("--speculative-eagle-topk"), int(Some(1), None)),
    opt("speculative_num_draft_tokens", "Draft tokens", DRAFT,
        "Tokens verified per speculative step.",
        Flag("--speculative-num-draft-tokens"), int(Some(1), None)),
    opt("speculative_draft_model_revision", "Draft model revision", DRAFT,
        "Branch, tag or commit of the draft model repository.",
        Flag("--speculative-draft-model-revision"), Text),
    opt("trust_remote_code", "Trust remote code", MODEL,
        "Allow model repositories to run custom code (--trust-remote-code).",
        Flag("--trust-remote-code"), Bool),
    opt("revision", "Model revision", MODEL,
        "Branch, tag or commit of the model repository.",
        Flag("--revision"), Text),
    opt("sglang_chat_template", "Chat template", REASONING,
        "Built-in template name or path to a chat template file.",
        Flag("--chat-template"), Text),
    opt("reasoning_parser", "Reasoning parser", REASONING,
        "Parser that extracts reasoning content, e.g. deepseek-r1, qwen3.",
        Flag("--reasoning-parser"), Text),
    opt("tool_call_parser", "Tool-call parser", REASONING,
        "Parser for tool calls, e.g. qwen25, llama3.",
        Flag("--tool-call-parser"), Text),
];

const PY_LOG_LEVELS: &[&str] = &["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];

/// `mlx_lm server` (mlx-lm 0.32.2). Server-wide defaults applied when a request
/// leaves a field unset, plus batching and prompt-cache limits.
#[rustfmt::skip]
const MLX_LM: &[NativeOption] = &[
    opt("trust_remote_code", "Trust remote code", MODEL,
        "Allow the tokenizer to run custom code (--trust-remote-code).",
        Flag("--trust-remote-code"), Bool),
    opt("adapter_path", "Adapter path", ADAPTERS,
        "Path to trained LoRA adapter weights.",
        Flag("--adapter-path"), Text),
    opt("mlx_chat_template", "Chat template", REASONING,
        "Override the tokenizer's chat template.",
        Flag("--chat-template"), Text),
    opt("use_default_chat_template", "Use default chat template", REASONING,
        "Use the tokenizer's default template when none is defined (--use-default-chat-template).",
        Flag("--use-default-chat-template"), Bool),
    opt("chat_template_args", "Chat template args", REASONING,
        "JSON object passed to the chat template, e.g. {\"enable_thinking\":false}.",
        Flag("--chat-template-args"), Text),
    opt("mlx_draft_model", "Draft model", DRAFT,
        "Model used for speculative decoding.",
        Flag("--draft-model"), Text),
    opt("num_draft_tokens", "Draft tokens", DRAFT,
        "Tokens drafted per speculative step.",
        Flag("--num-draft-tokens"), int(Some(1), None)),
    opt("decode_concurrency", "Decode concurrency", SCHEDULER,
        "Batchable requests decoded in parallel (default 32).",
        Flag("--decode-concurrency"), int(Some(1), None)),
    opt("prompt_concurrency", "Prompt concurrency", SCHEDULER,
        "Batchable prompts prefilled in parallel (default 8).",
        Flag("--prompt-concurrency"), int(Some(1), None)),
    opt("prefill_step_size", "Prefill step size", SCHEDULER,
        "Tokens processed per prefill step (default 2048).",
        Flag("--prefill-step-size"), int(Some(1), None)),
    opt("prompt_cache_size", "Prompt cache entries", CONTEXT,
        "Maximum distinct KV caches held in the prompt cache (default 10).",
        Flag("--prompt-cache-size"), int(Some(1), None)),
    opt("prompt_cache_bytes", "Prompt cache size limit", CONTEXT,
        "Maximum total size of cached KV state, e.g. 8GB or 500MB (suffixes M, G, MB, GB; a bare number means bytes).",
        Flag("--prompt-cache-bytes"), Text),
    opt("kv_bits", "KV cache bits", GPU,
        "Quantize the KV cache to this many bits (4 or 8 typical). Saves memory on long contexts but turns off batching.",
        Flag("--kv-bits"), int(Some(2), Some(8))),
    opt("kv_group_size", "KV quantization group size", GPU,
        "Group size for KV cache quantization (default 64). Only applies when KV cache bits is set.",
        Flag("--kv-group-size"), NativeKind::Enum { values: &["32", "64", "128"] }),
    opt("quantized_kv_start", "Quantized KV start", GPU,
        "Token position where KV cache quantization begins (default 5000). Only applies when KV cache bits is set.",
        Flag("--quantized-kv-start"), int(Some(0), None)),
    opt("default_temp", "Default temperature", DECODING,
        "Temperature when a request sets none.",
        Flag("--temp"), float(Some(0.0), None)),
    opt("default_top_p", "Default top-p", DECODING,
        "Top-p when a request sets none.",
        Flag("--top-p"), float(Some(0.0), Some(1.0))),
    opt("default_top_k", "Default top-k", DECODING,
        "Top-k when a request sets none.",
        Flag("--top-k"), int(Some(0), None)),
    opt("default_min_p", "Default min-p", DECODING,
        "Min-p when a request sets none.",
        Flag("--min-p"), float(Some(0.0), Some(1.0))),
    opt("default_max_tokens", "Default max tokens", DECODING,
        "Generation limit when a request sets none.",
        Flag("--max-tokens"), int(Some(1), None)),
    opt("mlx_log_level", "Log level", SERVER,
        "mlx_lm server logging level (default INFO).",
        Flag("--log-level"), NativeKind::Enum { values: PY_LOG_LEVELS }),
];

const MLX_VLM_KV_SCHEMES: &[&str] = &["uniform", "turboquant"];

/// `python -m mlx_vlm.server` (mlx-vlm 0.7.8). The CLI copies most flags into
/// environment variables unconditionally, so those knobs are flags; the prefix
/// cache (`APC_*`) and queue/coalesce knobs are environment-only. The draft
/// model has its own key because mlx-vlm drafters (DFlash, EAGLE-3, MTP) are
/// not interchangeable with mlx-lm draft models.
#[rustfmt::skip]
const MLX_VLM: &[NativeOption] = &[
    opt("trust_remote_code", "Trust remote code", MODEL,
        "Allow custom model and processor code from the Hub (--trust-remote-code).",
        Flag("--trust-remote-code"), Bool),
    opt("adapter_path", "Adapter path", ADAPTERS,
        "Path to LoRA adapter weights loaded with the model.",
        Flag("--adapter-path"), Text),
    opt("default_max_tokens", "Default max tokens", DECODING,
        "Generation limit when a request sets none (upstream default 2048).",
        Flag("--max-tokens"), int(Some(1), None)),
    opt("mlx_vlm_enable_thinking", "Enable thinking by default", REASONING,
        "Turn on thinking mode for requests that do not set enable_thinking.",
        Flag("--enable-thinking"), Bool),
    opt("mlx_vlm_thinking_budget", "Thinking budget", REASONING,
        "Default maximum tokens inside a thinking block; requests can override it.",
        Flag("--thinking-budget"), int(Some(0), None)),
    opt("mlx_vlm_thinking_start_token", "Thinking start token", REASONING,
        "Token that opens a thinking block, e.g. <think>.",
        Flag("--thinking-start-token"), Text),
    opt("mlx_vlm_thinking_end_token", "Thinking end token", REASONING,
        "Token that closes a thinking block, e.g. </think>.",
        Flag("--thinking-end-token"), Text),
    opt("mlx_vlm_max_kv_size", "Max KV cache size (tokens)", CONTEXT,
        "Cap the KV cache and the request context budget (prompt + max tokens). Ignored when KV cache bits are set.",
        Flag("--max-kv-size"), int(Some(1), None)),
    opt("mlx_vlm_kv_bits", "KV cache bits", GPU,
        "Quantize the KV cache to this many bits (fractional values such as 3.5 use TurboQuant).",
        Flag("--kv-bits"), float(Some(1.0), Some(16.0))),
    opt("mlx_vlm_kv_quant_scheme", "KV quantization scheme", GPU,
        "KV cache quantization backend (default uniform).",
        Flag("--kv-quant-scheme"), NativeKind::Enum { values: MLX_VLM_KV_SCHEMES }),
    opt("mlx_vlm_kv_group_size", "KV quantization group size", GPU,
        "Group size for uniform KV cache quantization (default 64).",
        Flag("--kv-group-size"), int(Some(1), None)),
    opt("mlx_vlm_quantized_kv_start", "Quantized KV start", GPU,
        "Token position at which the KV cache switches to quantized storage (default 5000).",
        Flag("--quantized-kv-start"), int(Some(0), None)),
    opt("mlx_vlm_kv_key_bits", "KV key bits", GPU,
        "Override the TurboQuant key bit-width (defaults to the floor of KV cache bits).",
        Flag("--kv-key-bits"), float(Some(1.0), Some(16.0))),
    opt("mlx_vlm_kv_value_bits", "KV value bits", GPU,
        "Override the TurboQuant value bit-width (defaults to the ceiling of KV cache bits).",
        Flag("--kv-value-bits"), float(Some(1.0), Some(16.0))),
    opt("mlx_vlm_kv_key_scheme", "KV key scheme", GPU,
        "Override the KV quantization backend for keys only.",
        Flag("--kv-key-scheme"), NativeKind::Enum { values: MLX_VLM_KV_SCHEMES }),
    opt("mlx_vlm_kv_value_scheme", "KV value scheme", GPU,
        "Override the KV quantization backend for values only.",
        Flag("--kv-value-scheme"), NativeKind::Enum { values: MLX_VLM_KV_SCHEMES }),
    opt("mlx_vlm_prefill_step_size", "Prefill step size", GPU,
        "Tokens processed per prefill step (default 2048); lower it to reduce peak memory.",
        Flag("--prefill-step-size"), int(Some(1), None)),
    opt("mlx_vlm_expert_cache_gb", "Expert cache (GB)", GPU,
        "For MoE-offload checkpoints, bound resident routed experts to this many GB (default 70% of the GPU working set). Ignored for normal checkpoints.",
        Flag("--expert-cache-gb"), float(Some(0.0), None)),
    opt("mlx_vlm_vision_cache_size", "Vision feature cache size", GPU,
        "Maximum cached vision features (default 20).",
        Flag("--vision-cache-size"), int(Some(1), None)),
    opt("mlx_vlm_max_num_seqs", "Max concurrent sequences", SCHEDULER,
        "Sequences decoded at once in the continuous batch; extra requests wait in the queue. Default unbounded.",
        Flag("--max-num-seqs"), int(Some(1), None)),
    opt("mlx_vlm_token_queue_timeout", "Token queue timeout (s)", SCHEDULER,
        "MLX_VLM_TOKEN_QUEUE_TIMEOUT: seconds a request waits for the next token (default 600); 0 disables the timeout.",
        Env("MLX_VLM_TOKEN_QUEUE_TIMEOUT"), float(Some(0.0), None)),
    opt("mlx_vlm_draft_model", "Draft model", DRAFT,
        "Speculative drafter path or Hub id (DFlash, EAGLE-3, or MTP). Qwen3.5+ checkpoints with bundled MTP weights can reuse the main model.",
        Flag("--draft-model"), Text),
    opt("mlx_vlm_draft_kind", "Draft kind", DRAFT,
        "Drafter family; detected from the drafter's model type when unset.",
        Flag("--draft-kind"), NativeKind::Enum { values: &["dflash", "eagle3", "mtp"] }),
    opt("mlx_vlm_draft_block_size", "Draft block size", DRAFT,
        "Override the drafter's configured block size.",
        Flag("--draft-block-size"), int(Some(1), None)),
    opt("mlx_vlm_spec_batch_coalesce_ms", "Speculative batch coalesce (ms)", DRAFT,
        "MLX_VLM_SPEC_BATCH_COALESCE_MS: wait to group speculative requests into a batch (default 5).",
        Env("MLX_VLM_SPEC_BATCH_COALESCE_MS"), float(Some(0.0), None)),
    opt("mlx_vlm_apc_enabled", "Prefix cache", CACHE,
        "APC_ENABLED: reuse KV blocks for repeated prompt prefixes.",
        Env("APC_ENABLED"), Bool),
    opt("mlx_vlm_apc_disk_enabled", "Persist prefix cache to disk", CACHE,
        "APC_DISK_ENABLED: keep a disk tier for prefix-cache blocks (default on).",
        Env("APC_DISK_ENABLED"), Bool),
    opt("mlx_vlm_apc_block_size", "Prefix cache block size", CACHE,
        "APC_BLOCK_SIZE: tokens per cache block (default 16).",
        Env("APC_BLOCK_SIZE"), int(Some(1), None)),
    opt("mlx_vlm_apc_num_blocks", "Prefix cache blocks", CACHE,
        "APC_NUM_BLOCKS: block pool capacity (default 2048); 0 disables block retention.",
        Env("APC_NUM_BLOCKS"), int(Some(0), None)),
    opt("mlx_vlm_apc_disk_max_gb", "Prefix cache disk cap (GB)", CACHE,
        "APC_DISK_MAX_GB: disk tier cap (default 20); 0 is uncapped.",
        Env("APC_DISK_MAX_GB"), float(Some(0.0), None)),
    opt("mlx_vlm_apc_memory_max_gb", "Prefix cache memory (GB)", CACHE,
        "APC_MEMORY_MAX_GB: resident prefix-cache budget; unset is automatic, 0 keeps blocks on disk only.",
        Env("APC_MEMORY_MAX_GB"), float(Some(0.0), None)),
    opt("mlx_vlm_top_logprobs_k", "Top logprobs cap", SERVER,
        "Server-side cap on per-token top_logprobs (0-20; default 0 disables).",
        Flag("--top-logprobs-k"), int(Some(0), Some(20))),
    opt("mlx_vlm_log_level", "Log level", SERVER,
        "Server log verbosity (default INFO).",
        Flag("--log-level"), NativeKind::Enum { values: PY_LOG_LEVELS }),
    opt("mlx_vlm_log_progress_interval", "Progress log interval", SERVER,
        "Decoded tokens between progress log lines (default 10); 0 disables.",
        Flag("--log-progress-interval"), int(Some(0), None)),
];

/// `omlx serve` (oMLX v0.7.1rc1, the Homebrew formula tag; the serve surface
/// is identical on main). oMLX writes every explicitly passed serve flag back
/// into its own `settings.json`, while `OMLX_*` environment overrides apply
/// only to the run, so rows prefer the environment twin. The three flag rows
/// have no environment twin and are saved by oMLX.
#[rustfmt::skip]
const OMLX_SERVE: &[NativeOption] = &[
    opt("omlx_max_concurrent_requests", "Max concurrent requests", SCHEDULER,
        "OMLX_MAX_CONCURRENT_REQUESTS: requests batched at once. Higher raises throughput and memory use (default 8).",
        Env("OMLX_MAX_CONCURRENT_REQUESTS"), int(Some(1), None)),
    opt("omlx_embedding_batch_size", "Embedding batch size", SCHEDULER,
        "OMLX_EMBEDDING_BATCH_SIZE: embedding inputs per forward pass (default 32).",
        Env("OMLX_EMBEDDING_BATCH_SIZE"), int(Some(1), None)),
    opt("omlx_memory_guard", "Memory guard", GPU,
        "How much RAM oMLX keeps free for other apps (safe ~20%, balanced ~8%, aggressive ~2%), or off. oMLX saves this setting to its own settings.",
        Flag("--memory-guard"), NativeKind::Enum { values: &["off", "safe", "balanced", "aggressive"] }),
    opt("omlx_memory_guard_gb", "Memory guard ceiling (GB)", GPU,
        "Custom memory ceiling in GB; switches the guard to a custom tier and turns it on. Cannot be combined with Memory guard off. oMLX saves this setting to its own settings.",
        Flag("--memory-guard-gb"), float(Some(0.1), None)),
    opt("omlx_gpu_keep_warm_interval", "GPU keep-warm interval (s)", GPU,
        "OMLX_GPU_KEEP_WARM_INTERVAL: seconds between keep-warm GPU ticks while a model is idle-loaded, avoiding first-token stalls; 0 disables (default 0.5).",
        Env("OMLX_GPU_KEEP_WARM_INTERVAL"), float(Some(0.0), None)),
    opt("omlx_cache_enabled", "Paged SSD prefix cache", CACHE,
        "OMLX_CACHE_ENABLED: turn oMLX's paged SSD prefix cache on or off (default on).",
        Env("OMLX_CACHE_ENABLED"), Bool),
    opt("omlx_ssd_cache_dir", "SSD cache directory", CACHE,
        "OMLX_SSD_CACHE_DIR: where paged KV cache blocks are stored (default <oMLX base>/cache).",
        Env("OMLX_SSD_CACHE_DIR"), Text),
    opt("omlx_ssd_cache_max_size", "SSD cache max size", CACHE,
        "OMLX_SSD_CACHE_MAX_SIZE: a size such as 100GB, or auto (half of available cache space; default).",
        Env("OMLX_SSD_CACHE_MAX_SIZE"), Text),
    opt("omlx_hot_cache_max_size", "Hot (RAM) cache size", CACHE,
        "In-memory hot cache tier size, e.g. 8GB; 0 disables (default). oMLX saves this setting to its own settings.",
        Flag("--hot-cache-max-size"), Text),
    opt("omlx_hot_cache_only", "Hot cache only", CACHE,
        "OMLX_HOT_CACHE_ONLY: keep cache blocks in RAM only and skip the SSD tier.",
        Env("OMLX_HOT_CACHE_ONLY"), Bool),
    opt("omlx_hot_cache_write_through", "Hot cache write-through", CACHE,
        "OMLX_HOT_CACHE_WRITE_THROUGH: also persist every hot-cache block to SSD immediately.",
        Env("OMLX_HOT_CACHE_WRITE_THROUGH"), Bool),
    opt("omlx_initial_cache_blocks", "Initial cache blocks", CACHE,
        "OMLX_INITIAL_CACHE_BLOCKS: cache blocks pre-allocated at startup (default 256).",
        Env("OMLX_INITIAL_CACHE_BLOCKS"), int(Some(1), None)),
    opt("omlx_gdn_snapshot_storage", "Hybrid-model state storage", CACHE,
        "OMLX_GDN_SNAPSHOT_STORAGE: where Gated DeltaNet (hybrid model) state snapshots are cached.",
        Env("OMLX_GDN_SNAPSHOT_STORAGE"), NativeKind::Enum { values: &["auto", "ssd_sidecar", "embedded"] }),
    opt("omlx_gdn_ssd_pending_max_size", "Hybrid-model pending SSD buffer", CACHE,
        "OMLX_GDN_SSD_PENDING_MAX_SIZE: a size such as 512MB (default).",
        Env("OMLX_GDN_SSD_PENDING_MAX_SIZE"), Text),
    opt("omlx_gdn_sidecar_state_dtype", "Hybrid-model state precision", CACHE,
        "OMLX_GDN_SIDECAR_STATE_DTYPE: precision for cached hybrid-model state (default fp32).",
        Env("OMLX_GDN_SIDECAR_STATE_DTYPE"),
        NativeKind::Enum { values: &["fp32", "bf16", "int8", "rht_int8", "rht_int16"] }),
    opt("omlx_headless", "Headless (no web UI)", SERVER,
        "OMLX_HEADLESS: serve the inference and admin APIs without oMLX's web dashboard.",
        Env("OMLX_HEADLESS"), Bool),
    opt("omlx_sse_keepalive_mode", "SSE keep-alive mode", SERVER,
        "Streaming keep-alive: chunk (protocol no-op events, default), comment, or off. oMLX saves this setting to its own settings.",
        Flag("--sse-keepalive-mode"), NativeKind::Enum { values: &["chunk", "comment", "off"] }),
    opt("omlx_max_audio_upload_size", "Max audio upload", SERVER,
        "OMLX_MAX_AUDIO_UPLOAD_SIZE: per-request audio limit for transcription, e.g. 100MB (default); also a RAM cap.",
        Env("OMLX_MAX_AUDIO_UPLOAD_SIZE"), Text),
    opt("omlx_max_image_upload_size", "Max image upload", SERVER,
        "OMLX_MAX_IMAGE_UPLOAD_SIZE: image payload limit for vision models, e.g. 50MB (default).",
        Env("OMLX_MAX_IMAGE_UPLOAD_SIZE"), Text),
    opt("omlx_max_image_side_length", "Max image side (px)", SERVER,
        "OMLX_MAX_IMAGE_SIDE_LENGTH: larger VLM images are downscaled; 0 disables (default 2048).",
        Env("OMLX_MAX_IMAGE_SIDE_LENGTH"), int(Some(0), None)),
    opt("omlx_mcp_config", "MCP config file", SERVER,
        "OMLX_MCP_CONFIG: path to a JSON or YAML MCP config for oMLX's tool integration.",
        Env("OMLX_MCP_CONFIG"), Text),
    opt("omlx_usage_history", "Usage history", SERVER,
        "OMLX_USAGE_HISTORY: record hourly per-model usage aggregates to oMLX's usage database (default on).",
        Env("OMLX_USAGE_HISTORY"), Bool),
    opt("omlx_hf_cache_enabled", "Discover Hugging Face cache", MODEL,
        "OMLX_HF_CACHE_ENABLED: also list models from the local Hugging Face Hub cache (default on).",
        Env("OMLX_HF_CACHE_ENABLED"), Bool),
    opt("omlx_hf_endpoint", "Hugging Face endpoint", MODEL,
        "OMLX_HF_ENDPOINT: custom Hub mirror URL used for downloads.",
        Env("OMLX_HF_ENDPOINT"), Text),
    opt("omlx_ms_endpoint", "ModelScope endpoint", MODEL,
        "OMLX_MS_ENDPOINT: custom ModelScope Hub URL.",
        Env("OMLX_MS_ENDPOINT"), Text),
    opt("omlx_http_proxy", "HTTP proxy", NETWORK,
        "OMLX_HTTP_PROXY: proxy URL for oMLX's outbound HTTP (model downloads).",
        Env("OMLX_HTTP_PROXY"), Text),
    opt("omlx_https_proxy", "HTTPS proxy", NETWORK,
        "OMLX_HTTPS_PROXY: proxy URL for outbound HTTPS.",
        Env("OMLX_HTTPS_PROXY"), Text),
    opt("omlx_no_proxy", "No-proxy hosts", NETWORK,
        "OMLX_NO_PROXY: comma-separated hosts that bypass the proxy.",
        Env("OMLX_NO_PROXY"), Text),
    opt("omlx_ca_bundle", "CA bundle", NETWORK,
        "OMLX_CA_BUNDLE: PEM bundle for TLS-intercepting networks.",
        Env("OMLX_CA_BUNDLE"), Text),
    opt("omlx_log_level", "Log level", LOGGING,
        "OMLX_LOG_LEVEL: trace also logs full message content (default info).",
        Env("OMLX_LOG_LEVEL"), NativeKind::Enum { values: &["trace", "debug", "info", "warning", "error"] }),
    opt("omlx_log_dir", "Log directory", LOGGING,
        "OMLX_LOG_DIR: where oMLX writes server.log and crash.log (default <oMLX base>/logs).",
        Env("OMLX_LOG_DIR"), Text),
    opt("omlx_log_retention_days", "Log retention (days)", LOGGING,
        "OMLX_LOG_RETENTION_DAYS: days of rotated logs to keep (default 7).",
        Env("OMLX_LOG_RETENTION_DAYS"), int(Some(1), None)),
];

/// Largest value mlx-serve accepts for its `u32` integer flags; a larger value
/// fails `std.fmt.parseInt(u32, ...)` and the server exits.
const U32_MAX: i64 = u32::MAX as i64;
/// Largest value for mlx-serve's `i32` flags (`--reasoning-budget`).
const I32_MAX: i64 = i32::MAX as i64;

/// `mlx-serve --serve` (ddalcu/mlx-serve). Every row exists with the same value
/// grammar in both v26.8.10 and v26.10.2: mlx-serve exits on an unknown flag,
/// and Ryu adopts whichever build is installed, so newer-only flags are left
/// out. Context size is the typed `ctx_size` field.
#[rustfmt::skip]
const MLX_SERVE: &[NativeOption] = &[
    opt("no_vision", "Disable vision encoder", MODEL,
        "Skip loading the vision encoder to save memory, including for on-demand loads (--no-vision).",
        Flag("--no-vision"), Bool),
    opt("gguf_engine", "GGUF engine", MODEL,
        "Engine for .gguf models only: auto reads the file metadata, ds4 forces the embedded ds4 engine, llama forces llama.cpp.",
        Flag("--engine"), NativeKind::Enum { values: &["auto", "ds4", "llama"] }),
    opt("ssd_streaming", "Stream experts from SSD", MODEL,
        "ds4 / DeepSeek-V4-Flash only: stream expert weights from SSD instead of holding the whole model in RAM (--ssd-streaming).",
        Flag("--ssd-streaming"), Bool),
    opt("skip_mem_preflight", "Skip memory pre-flight", MODEL,
        "Load even when the free-RAM pre-flight would refuse it. A real over-commit can crash the server (--skip-mem-preflight).",
        Flag("--skip-mem-preflight"), Bool),
    opt("no_warmup", "Skip warmup", MODEL,
        "Do not pre-fault weights and pre-compile kernels at load (--no-warmup-eager). Faster start, slower first prompt.",
        Flag("--no-warmup-eager"), Bool),
    opt("max_resident_models", "Max loaded models", GPU,
        "Most models kept loaded at once; the least recently used is evicted first (default 3).",
        Flag("--max-resident-models"), int(Some(1), Some(U32_MAX))),
    opt("max_resident_mem", "Max resident memory", GPU,
        "Cap on memory across all loaded models, e.g. 48GB, auto (derived from the GPU working-set limit), or 0 to disable. Units: KB, MB, GB.",
        Flag("--max-resident-mem"), Text),
    opt("idle_evict_secs", "Idle unload (s)", GPU,
        "Unload a model that has been idle this many seconds (0 = off).",
        Flag("--idle-evict-secs"), int(Some(0), Some(U32_MAX))),
    opt("mlx_serve_kv_quant", "KV cache quantization", GPU,
        "KV cache quantization for MLX models: off, 4-bit or 8-bit.",
        Flag("--kv-quant"), NativeKind::Enum { values: &["off", "4", "8"] }),
    opt("kv_attn_mode", "Quantized KV read path", GPU,
        "How decode reads a quantized KV cache: auto (fused from 8K prompt tokens), dense, or fused. Only applies with KV cache quantization 4 or 8.",
        Flag("--kv-attn-mode"), NativeKind::Enum { values: &["auto", "dense", "fused"] }),
    opt("llama_kv_quant", "GGUF KV cache type", GPU,
        "KV cache type for GGUF models on llama.cpp: off (F16), q8 or q4. Turns on flash attention automatically.",
        Flag("--llama-kv-quant"), NativeKind::Enum { values: &["off", "q8", "q4"] }),
    opt("no_decode_attn_quant", "Exact dense decode", GPU,
        "Turn off quantized side copies of dense attention weights during decode (--no-decode-attn-quant). Lossless but slower.",
        Flag("--no-decode-attn-quant"), Bool),
    opt("ane_prefill", "Neural Engine prefill", GPU,
        "Offload part of each prefill chunk's MLP to the Neural Engine (qwen3_5 family only, lossy, needs 96 GB RAM or more).",
        Flag("--ane-prefill"), Bool),
    opt("prefill_chunk", "Prefill chunk (tokens)", CONTEXT,
        "Most tokens sent per prefill chunk (default 8192). Lower it if long prompts cause memory spikes.",
        Flag("--prefill-chunk"), int(Some(1), None)),
    opt("embedding_max_length", "Embedding input limit", CONTEXT,
        "Per-input token limit for embeddings (0 = the model's own window). Longer inputs return an error and are not truncated.",
        Flag("--embedding-max-length"), int(Some(0), Some(U32_MAX))),
    opt("prefix_cache_entries", "Prefix cache entries", CACHE,
        "Number of entries in the hot prefix cache (default 32). 0 disables prefix reuse.",
        Flag("--prefix-cache-entries"), int(Some(0), Some(U32_MAX))),
    opt("prefix_cache_mem", "Prefix cache memory", CACHE,
        "Memory budget for the hot prefix cache, e.g. 2GB (KB, MB, GB), or 0/off for no byte budget.",
        Flag("--prefix-cache-mem"), Text),
    opt("prefix_cache_disk", "Prefix cache on SSD", CACHE,
        "Disk budget for saving prefixes across restarts under ~/.mlx-serve/kv-cache, e.g. 10GB. Off by default; 0/off disables.",
        Flag("--prefix-cache-disk"), Text),
    opt("tokenize_cache_entries", "Tokenize cache entries", CACHE,
        "Cached chat-template renders per model (default 4). 0 disables.",
        Flag("--tokenize-cache-entries"), int(Some(0), Some(U32_MAX))),
    opt("ssm_checkpoint_stride", "SSM checkpoint stride", CACHE,
        "Hybrid SSM models only: save state every N prefill tokens so shared prefixes can be reused. 0 disables.",
        Flag("--ssm-checkpoint-stride"), int(Some(0), Some(U32_MAX))),
    opt("ssm_checkpoint_max", "SSM checkpoints kept", CACHE,
        "Most SSM checkpoints kept per cache entry (default 16 or 32 depending on the mlx-serve version, 0 = unlimited).",
        Flag("--ssm-checkpoint-max"), int(Some(0), Some(U32_MAX))),
    opt("max_concurrent", "Concurrent requests", SCHEDULER,
        "Requests decoded together in batched decode (default 1). The server clamps it for models that cannot batch.",
        Flag("--max-concurrent"), int(Some(1), Some(U32_MAX))),
    opt("llama_cache_entries", "GGUF sequences", SCHEDULER,
        "For GGUF models on llama.cpp: sequences per model that are batched together and keep their own warm KV (default 4).",
        Flag("--llama-cache-entries"), int(Some(1), Some(64))),
    opt("mlx_serve_stall_timeout", "Stall timeout (s)", SERVER,
        "Abort a request after this many seconds with no token produced (default 300, 0 = never).",
        Flag("--timeout"), int(Some(0), Some(U32_MAX))),
    opt("metrics", "Prometheus metrics", SERVER,
        "Expose /metrics and /metrics.json (--metrics).",
        Flag("--metrics"), Bool),
    opt("no_tool_autocorrect", "Disable tool-argument autocorrect", SERVER,
        "Pass tool-call arguments through as the model wrote them, without converting them to the schema's types (--no-tool-autocorrect).",
        Flag("--no-tool-autocorrect"), Bool),
    opt("mlx_serve_log_level", "Log level", SERVER,
        "mlx-serve log verbosity (default info).",
        Flag("--log-level"), NativeKind::Enum { values: &["error", "warn", "info", "debug"] }),
    opt("mlx_serve_log_file", "Log file", SERVER,
        "Where mlx-serve saves its log, or off. Default: ~/.mlx-serve/logs/mlx-serve-<port>.log.",
        Flag("--log-file"), Text),
    opt("default_temp", "Default temperature", DECODING,
        "Temperature when a request sets none (otherwise the model's generation config, then 1.0).",
        Flag("--temp"), float(Some(0.0), None)),
    opt("default_top_p", "Default top-p", DECODING,
        "Top-p when a request sets none.",
        Flag("--top-p"), float(Some(0.0), Some(1.0))),
    opt("default_top_k", "Default top-k", DECODING,
        "Top-k when a request sets none (0 = off).",
        Flag("--top-k"), int(Some(0), Some(U32_MAX))),
    opt("default_max_tokens", "Default max tokens", DECODING,
        "Generation limit when a request sets none.",
        Flag("--max-tokens"), int(Some(1), Some(U32_MAX))),
    opt("reasoning_budget", "Reasoning budget", REASONING,
        "Most thinking tokens per request (-1 = unlimited).",
        Flag("--reasoning-budget"), int(Some(-1), Some(I32_MAX))),
    opt("no_pld", "Disable prompt lookup decoding", DRAFT,
        "Turn off n-gram prompt lookup speculative decoding, which is on by default (--no-pld).",
        Flag("--no-pld"), Bool),
    opt("pld_draft_len", "PLD draft tokens", DRAFT,
        "Most draft tokens per prompt-lookup step (default 5).",
        Flag("--pld-draft-len"), int(Some(1), Some(U32_MAX))),
    opt("pld_key_len", "PLD key length", DRAFT,
        "N-gram key length used for prompt-lookup matches (default 3).",
        Flag("--pld-key-len"), int(Some(1), Some(U32_MAX))),
    opt("mlx_serve_drafter", "Drafter checkpoint", DRAFT,
        "Path to a Gemma 4 assistant drafter or DFlash block-drafter checkpoint, loaded at startup.",
        Flag("--drafter"), Text),
    opt("draft_block_size", "Drafter block size", DRAFT,
        "Tokens per drafter round. Detected per target by default; for DFlash this only lowers the configured size.",
        Flag("--draft-block-size"), int(Some(1), Some(U32_MAX))),
    opt("no_drafter", "Never load a drafter", DRAFT,
        "Do not load any speculative drafter, including one shipped inside the checkpoint (--no-drafter).",
        Flag("--no-drafter"), Bool),
    opt("no_mtp", "Disable MTP head", DRAFT,
        "Do not draft with a model's native multi-token-prediction head (--no-mtp).",
        Flag("--no-mtp"), Bool),
    opt("mtp_history_window", "MTP history window", DRAFT,
        "For prompts over 16384 tokens, build MTP history only for the last N tokens (0 = full history).",
        Flag("--mtp-history-window"), int(Some(0), None)),
    opt("no_ds4_mtp", "Disable ds4 MTP head", DRAFT,
        "ds4 engine only: do not load the MTP draft head automatically (--no-ds4-mtp).",
        Flag("--no-ds4-mtp"), Bool),
    opt("dspark", "DeepSeek-V4 DSpark drafting", DRAFT,
        "Turn on DeepSeek-V4 DSpark draft stages (about 11 GB more resident memory) (--dspark).",
        Flag("--dspark"), Bool),
];

/// `apfel --serve` (apfel v1.16.0; every row also exists in v1.0.0 and v1.8.0).
/// apfel has no typed fields. Serve mode rejects sampling, context and system
/// prompt flags, so none are listed; token and MCP flags are excluded because
/// they break Core's readiness probe or bypass Gateway tool governance.
#[rustfmt::skip]
const APFEL_SERVE: &[NativeOption] = &[
    opt("apfel_max_concurrent", "Max concurrent requests", SCHEDULER,
        "Generations apfel runs at once (default 5). Requests over the limit get HTTP 429.",
        Flag("--max-concurrent"), int(Some(1), None)),
    opt("apfel_retry", "Retry transient errors", SERVER,
        "Retry transient model errors with backoff (default 3 attempts) (--retry).",
        Flag("--retry"), Bool),
    opt("apfel_cors", "CORS headers", SERVER,
        "Send CORS headers so browser pages on allowed origins can call apfel directly. Ryu's own traffic does not need it.",
        Flag("--cors"), Bool),
    opt("apfel_allowed_origins", "Allowed origins", SERVER,
        "Comma-separated browser origins accepted in addition to the loopback defaults.",
        Flag("--allowed-origins"), Text),
    opt("apfel_debug", "Debug logging", LOGGING,
        "Verbose request and response logging to apfel's output (--debug). Logs can include prompt text.",
        Flag("--debug"), Bool),
    opt("apfel_quiet", "Quiet output", LOGGING,
        "Suppress non-essential output (--quiet).",
        Flag("--quiet"), Bool),
    opt("apfel_no_color", "Disable ANSI colors", LOGGING,
        "Plain, uncolored banner and log output (--no-color).",
        Flag("--no-color"), Bool),
];

/// `mesh-llm serve` (verified against mesh-llm v0.78.1; Ryu adopts whichever
/// build is installed, so older builds may reject newer flags). Context size,
/// parallel lanes, draft model and draft max are typed `LaunchConfig` fields.
/// The startup model is listed because Mesh LLM owns its models: Core never
/// passes `--model` to it.
#[rustfmt::skip]
const MESH_LLM: &[NativeOption] = &[
    opt("mesh_model", "Startup model", MODEL,
        "Model to serve (local path, Mesh LLM catalog name, or Hugging Face ref). When unset, Mesh LLM loads the startup models from its own config.",
        Flag("--model"), Text),
    opt("mesh_quant", "Load-time quantization", MODEL,
        "Quantize SafeTensors weights while loading (default preserve), e.g. preserve, F16, BF16, Q8_0, Q6_K, Q5_K_M, Q4_K_M.",
        Flag("--quant"), Text),
    opt("mesh_local_model_only", "Local model only", MODEL,
        "Serve one model directly through the local OpenAI API without starting a mesh node.",
        Flag("--local-model-only"), Bool),
    opt("mesh_config", "Config file", MODEL,
        "Path to an alternate Mesh LLM config file instead of ~/.mesh-llm/config.toml.",
        Flag("--config"), Text),
    opt("mesh_llama_flavor", "llama.cpp backend flavor", GPU,
        "Override which bundled llama.cpp flavor Mesh LLM uses.",
        Flag("--llama-flavor"), NativeKind::Enum { values: &["cpu", "cuda", "rocm", "vulkan", "metal"] }),
    opt("mesh_device", "Device", GPU,
        "Device override for local backend selection, e.g. MTL0, CUDA0.",
        Flag("--device"), Text),
    opt("mesh_max_vram", "VRAM cap (GB)", GPU,
        "Cap the VRAM used for planning, local-fit decisions and mesh advertisement, in GB.",
        Flag("--max-vram"), float(Some(0.1), None)),
    opt("mesh_split", "Force tensor split", SPLIT,
        "Split the model across mesh nodes even when it fits on one node (--split).",
        Flag("--split"), Bool),
    opt("mesh_auto_balance", "Auto-balance split layers", SPLIT,
        "Place split layers by node speed and rebalance while serving. Only applies with Force tensor split.",
        Flag("--auto-balance"), Bool),
    opt("mesh_no_draft", "Disable auto draft model", DRAFT,
        "Turn off automatic draft-model detection for speculative decoding (--no-draft).",
        Flag("--no-draft"), Bool),
    opt("mesh_speculative_strategy", "Speculative strategy", DRAFT,
        "Override speculative decoding: mtp, ngram-cache, ngram-suffix, or a package strategy id.",
        Flag("--speculative-strategy"), Text),
    opt("mesh_speculative_ngram_min", "N-gram min length", DRAFT,
        "Minimum matching N-gram length for the request-local cache extension.",
        Flag("--speculative-ngram-min"), int(Some(1), None)),
    opt("mesh_speculative_ngram_max", "N-gram max length", DRAFT,
        "Maximum matching N-gram length for the request-local cache extension.",
        Flag("--speculative-ngram-max"), int(Some(1), None)),
    opt("mesh_speculative_ngram_proposer", "N-gram proposer", DRAFT,
        "Standalone N-gram proposer kind.",
        Flag("--speculative-ngram-proposer"), NativeKind::Enum { values: &["cache", "suffix"] }),
    opt("mesh_speculative_ngram_fallback", "N-gram miss fallback", DRAFT,
        "Propose from the draft model when the N-gram proposer misses (draft) or not at all (none). draft needs a draft model and a pipeline depth above 1.",
        Flag("--speculative-ngram-fallback"), NativeKind::Enum { values: &["draft", "none"] }),
    opt("mesh_speculative_pipeline_depth", "Verify pipeline depth", DRAFT,
        "Number of in-flight pipelined speculative verify windows.",
        Flag("--speculative-verify-window-pipeline-depth"), int(Some(1), None)),
    opt("mesh_kv_cache_disk", "Disk prompt cache", CACHE,
        "Node-local disk prompt cache: off, auto, or an explicit size such as 32GiB.",
        Flag("--kv-cache-disk"), Text),
    opt("mesh_kv_cache_disk_dir", "Disk prompt cache directory", CACHE,
        "Absolute directory for the node-local disk prompt cache.",
        Flag("--kv-cache-disk-dir"), Text),
    opt("mesh_kv_cache_min_free", "Minimum free disk", CACHE,
        "Free storage the disk prompt cache must preserve, e.g. 16GiB.",
        Flag("--kv-cache-min-free"), Text),
    opt("mesh_join_file", "Invite token file", MESH,
        "Join a mesh with the invite token in this file. It is re-read on every rejoin, so a rotated token is picked up without a restart.",
        Flag("--join-file"), Text),
    opt("mesh_auto_join", "Auto-join best mesh", MESH,
        "Discover meshes and auto-join the best one (--auto).",
        Flag("--auto"), Bool),
    opt("mesh_discovery_mode", "Discovery provider", MESH,
        "Discovery provider for auto-join and publishing: nostr (public relays) or mdns (local network only).",
        Flag("--mesh-discovery-mode"), NativeKind::Enum { values: &["nostr", "mdns"] }),
    opt("mesh_publish", "Publish mesh", MESH,
        "Publish this mesh for discovery by other nodes. Without it the mesh is private and joinable only by invite.",
        Flag("--publish"), Bool),
    opt("mesh_name", "Mesh name", MESH,
        "Human-readable mesh name shown in discovery (does not publish the mesh by itself).",
        Flag("--mesh-name"), Text),
    opt("mesh_region", "Region tag", MESH,
        "Region tag shown in discovery, e.g. US, EU, AU.",
        Flag("--region"), Text),
    opt("mesh_node_name", "Node display name", MESH,
        "Display name for this node.",
        Flag("--name"), Text),
    opt("mesh_max_clients", "Max clients", MESH,
        "Stop advertising once this many clients are connected.",
        Flag("--max-clients"), int(Some(1), None)),
    opt("mesh_bind_port", "Mesh QUIC port", MESH,
        "Bind mesh QUIC to a fixed UDP port (for NAT port forwarding). Separate from the API port Ryu manages.",
        Flag("--bind-port"), int(Some(1), Some(65535))),
    opt("mesh_no_enumerate_host", "Hide host hardware from peers", PRIVACY,
        "Stop broadcasting GPU name, hostname, VRAM and reserved bytes to peers (--no-enumerate-host).",
        Flag("--no-enumerate-host"), Bool),
    opt("mesh_trust_policy", "Peer trust policy", PRIVACY,
        "Peer ownership trust policy.",
        Flag("--trust-policy"),
        NativeKind::Enum { values: &["off", "prefer-owned", "require-owned", "allowlist"] }),
    opt("mesh_owner_key", "Owner keystore", PRIVACY,
        "Path to the owner keystore used to attest this node.",
        Flag("--owner-key"), Text),
    opt("mesh_owner_required", "Require owner attestation", PRIVACY,
        "Fail startup if owner attestation cannot be loaded or signed (--owner-required).",
        Flag("--owner-required"), Bool),
    opt("mesh_node_label", "Node certificate label", PRIVACY,
        "Human label attached to this node's ownership certificate.",
        Flag("--node-label"), Text),
    opt("mesh_guardrails", "Mesh guardrails", PRIVACY,
        "Server-side mesh guardrail mode for hosted backends.",
        Flag("--mesh-guardrails"), NativeKind::Enum { values: &["disabled", "metrics", "enforce"] }),
    opt("mesh_analytics", "Usage analytics", PRIVACY,
        "MESH_LLM_ANALYTICS: turn Mesh LLM's own anonymous usage reporting on or off. Leave unset to keep Mesh LLM's default.",
        Env("MESH_LLM_ANALYTICS"), Bool),
    opt("mesh_no_default_plugins", "Skip default plugins", SERVER,
        "Don't install Mesh LLM's default plugins on first run (--no-default-plugins).",
        Flag("--no-default-plugins"), Bool),
    opt("mesh_log_format", "Log format", LOGGING,
        "Output format for runtime events.",
        Flag("--log-format"), NativeKind::Enum { values: &["pretty", "json"] }),
    opt("mesh_debug", "Debug output", LOGGING,
        "Enable mesh runtime debug output (--debug).",
        Flag("--debug"), Bool),
    opt("mesh_debug_native_verbose", "Verbose native logs", LOGGING,
        "MESH_LLM_DEBUG_NATIVE_VERBOSE: verbose llama.cpp native logs. Only takes effect together with Debug output.",
        Env("MESH_LLM_DEBUG_NATIVE_VERBOSE"), Bool),
    opt("mesh_swarm_capture", "Swarm debug capture dir", LOGGING,
        "Write passive swarm debug capture JSONL to this local directory (opt-in, no telemetry egress).",
        Flag("--swarm-capture"), Text),
];

/// `audiocpp_server` (audio.cpp v0.7.1). Backend, device, threads and the
/// loaded-model limit are Ryu's audio.cpp runtime settings; the config file,
/// listen address, web UI and busy timeout are managed by Core. audio.cpp
/// parses the first occurrence of a flag, so a native option wins over the
/// same flag in the additional arguments.
#[rustfmt::skip]
const AUDIOCPP_SERVER: &[NativeOption] = &[
    opt("audiocpp_idle_unload_ms", "Idle unload (ms)", MODEL,
        "Unload every resident model after this many milliseconds with no model load or run. The next request reloads it. 0 (default) disables idle unload.",
        Flag("--idle-unload-ms"), int(Some(0), Some(2_147_483_647))),
    opt("audiocpp_min_free_memory_mb", "Minimum free memory (MiB)", GPU,
        "Refuse a model load unless host RAM and GPU memory each keep at least this many MiB free after it. 0 (default) disables the guard.",
        Flag("--min-free-memory-mb"), int(Some(0), Some(2_147_483_647))),
    opt("audiocpp_graph_optimizer", "Graph optimizer", CPU,
        "ENGINE_GRAPH_OPTIMIZER: on by default; turn it off to disable ggml graph rewrites when diagnosing backend problems.",
        Env("ENGINE_GRAPH_OPTIMIZER"), Bool),
    opt("audiocpp_voice_dir", "Voice library folder", SERVER,
        "Folder of reference voices (*.wav plus a prompt_text file of <name>|<transcript> lines) shared by all TTS models. When blank, the built-in demo voices are used.",
        Flag("--voice-dir"), Text),
    opt("audiocpp_log", "Debug logging", LOGGING,
        "Enable audio.cpp's verbose engine log with trace and timing lines (--log).",
        Flag("--log"), Bool),
    opt("audiocpp_log_file", "Log file", LOGGING,
        "Write audio.cpp's engine log to this file. Setting it also enables logging.",
        Flag("--log-file"), Text),
];

/// The Ryu Audio TTS sidecar (`python -m ryu_tts`, ryu-voice v0.1.2). It has no
/// command-line surface, so every row is an environment variable read by the
/// sidecar or its libraries (kokoro-onnx, huggingface_hub).
#[rustfmt::skip]
const RYU_TTS: &[NativeOption] = &[
    opt("ryutts_onnx_provider", "ONNX execution provider (Kokoro)", GPU,
        "ONNX_PROVIDER: the onnxruntime execution provider Kokoro loads its model on. The default install ships plain onnxruntime, so accelerated providers need an accelerated onnxruntime build; an unavailable one is logged as a warning.",
        Env("ONNX_PROVIDER"),
        NativeKind::Enum { values: &[
            "CPUExecutionProvider", "CUDAExecutionProvider", "TensorrtExecutionProvider",
            "ROCMExecutionProvider", "DmlExecutionProvider", "CoreMLExecutionProvider",
            "OpenVINOExecutionProvider", "QNNExecutionProvider",
        ] }),
    opt("ryutts_kokoro_log_level", "Kokoro log level", SERVER,
        "LOG_LEVEL: verbosity of the kokoro-onnx logger (default WARNING). DEBUG logs providers, versions and phonemes.",
        Env("LOG_LEVEL"), NativeKind::Enum { values: PY_LOG_LEVELS }),
    opt("ryutts_espeak_library", "eSpeak NG library path", MODEL,
        "PHONEMIZER_ESPEAK_LIBRARY: absolute path to an espeak-ng shared library used for phonemization instead of the bundled copy.",
        Env("PHONEMIZER_ESPEAK_LIBRARY"), Text),
    opt("ryutts_kitten_model", "KittenTTS model", MODEL,
        "RYU_KITTEN_MODEL: which KittenTTS model the kitten engine loads (default KittenML/kitten-tts-mini-0.8). Applies only when the kitten engine is installed.",
        Env("RYU_KITTEN_MODEL"),
        NativeKind::Enum { values: &["KittenML/kitten-tts-mini-0.8", "KittenML/kitten-tts-nano-0.1"] }),
    opt("hf_hub_offline", "Hugging Face offline mode", MODEL,
        "HF_HUB_OFFLINE: never contact the Hugging Face Hub and serve only cached models. Audio model installs and first downloads of Hub-hosted engines fail while this is on.",
        Env("HF_HUB_OFFLINE"), Bool),
    opt("hf_hub_disable_telemetry", "Disable Hugging Face telemetry", MODEL,
        "HF_HUB_DISABLE_TELEMETRY: stop huggingface_hub from sending usage telemetry when the sidecar downloads models.",
        Env("HF_HUB_DISABLE_TELEMETRY"), Bool),
    opt("hf_hub_download_timeout", "Hub download timeout (s)", MODEL,
        "HF_HUB_DOWNLOAD_TIMEOUT: seconds to wait for Hugging Face file downloads (default 10).",
        Env("HF_HUB_DOWNLOAD_TIMEOUT"), int(Some(1), None)),
    opt("hf_hub_etag_timeout", "Hub metadata timeout (s)", MODEL,
        "HF_HUB_ETAG_TIMEOUT: seconds to wait for Hugging Face metadata requests before using the cached copy (default 10).",
        Env("HF_HUB_ETAG_TIMEOUT"), int(Some(1), None)),
];

const OLLAMA_KV_TYPES: &[&str] = &[
    "f16", "bf16", "q8_0", "q5_1", "q5_0", "q4_1", "q4_0", "iq4_nl", "f32",
];

/// `ollama serve` server environment (Ollama v0.40). Applied only when Ryu
/// starts the daemon; an adopted Ollama keeps its own environment.
#[rustfmt::skip]
const OLLAMA_SERVE: &[NativeOption] = &[
    opt("ollama_flash_attention", "Flash attention", GPU,
        "OLLAMA_FLASH_ATTENTION: force flash attention on (true) or off (false). Unset lets Ollama pick auto when the GPU supports it.",
        Env("OLLAMA_FLASH_ATTENTION"), Bool),
    opt("ollama_kv_cache_type", "KV cache type", GPU,
        "OLLAMA_KV_CACHE_TYPE: K/V cache type passed to llama-server (default f16). Quantized types need flash attention.",
        Env("OLLAMA_KV_CACHE_TYPE"), NativeKind::Enum { values: OLLAMA_KV_TYPES }),
    opt("ollama_gpu_overhead", "Reserved VRAM (bytes)", GPU,
        "OLLAMA_GPU_OVERHEAD: VRAM per GPU to leave free.",
        Env("OLLAMA_GPU_OVERHEAD"), int(Some(0), None)),
    opt("ollama_sched_spread", "Spread across GPUs", GPU,
        "OLLAMA_SCHED_SPREAD: always schedule a model across all GPUs.",
        Env("OLLAMA_SCHED_SPREAD"), Bool),
    opt("ollama_vulkan", "Vulkan backend", GPU,
        "OLLAMA_VULKAN: set false to skip Vulkan backend discovery. Unset leaves it on.",
        Env("OLLAMA_VULKAN"), Bool),
    opt("ollama_igpu_enable", "Integrated GPUs", GPU,
        "OLLAMA_IGPU_ENABLE: force integrated GPUs on (true) or off (false). Unset uses Ollama's per-backend default.",
        Env("OLLAMA_IGPU_ENABLE"), Bool),
    opt("ollama_context_length", "Default context length", CONTEXT,
        "OLLAMA_CONTEXT_LENGTH: server-wide default context when a request or Modelfile sets no num_ctx. Unset picks 4k/32k/256k by VRAM. The Context size setting overrides it for the active model.",
        Env("OLLAMA_CONTEXT_LENGTH"), int(Some(1), None)),
    opt("ollama_num_parallel", "Parallel requests", SCHEDULER,
        "OLLAMA_NUM_PARALLEL: requests each model serves at once.",
        Env("OLLAMA_NUM_PARALLEL"), int(Some(1), None)),
    opt("ollama_max_loaded_models", "Max loaded models", SCHEDULER,
        "OLLAMA_MAX_LOADED_MODELS: maximum models loaded at once per GPU. Unset lets Ollama decide.",
        Env("OLLAMA_MAX_LOADED_MODELS"), int(Some(1), None)),
    opt("ollama_max_queue", "Max queued requests", SCHEDULER,
        "OLLAMA_MAX_QUEUE: maximum requests waiting before Ollama rejects new ones.",
        Env("OLLAMA_MAX_QUEUE"), int(Some(1), None)),
    opt("ollama_keep_alive", "Keep alive", SCHEDULER,
        "OLLAMA_KEEP_ALIVE: how long a model stays loaded, e.g. 5m, 1h, -1.",
        Env("OLLAMA_KEEP_ALIVE"), Text),
    opt("ollama_load_timeout", "Load timeout", SCHEDULER,
        "OLLAMA_LOAD_TIMEOUT, e.g. 5m.",
        Env("OLLAMA_LOAD_TIMEOUT"), Text),
    opt("ollama_max_transfer_streams", "Pull transfer streams", SCHEDULER,
        "OLLAMA_MAX_TRANSFER_STREAMS: parallel streams for safetensors model pulls and pushes (default 4). Has no effect on GGUF.",
        Env("OLLAMA_MAX_TRANSFER_STREAMS"), int(Some(1), None)),
    opt("ollama_noprune", "Keep unused blobs", SCHEDULER,
        "OLLAMA_NOPRUNE: do not prune unused model blobs on startup.",
        Env("OLLAMA_NOPRUNE"), Bool),
    opt("ollama_no_cloud", "Disable Ollama cloud", SERVER,
        "OLLAMA_NO_CLOUD: turn off Ollama cloud features (remote inference and web search).",
        Env("OLLAMA_NO_CLOUD"), Bool),
    opt("ollama_debug", "Debug logging", LOGGING,
        "OLLAMA_DEBUG: 0 is info (default), 1 is debug, 2 is trace.",
        Env("OLLAMA_DEBUG"), NativeKind::Enum { values: &["0", "1", "2"] }),
];

/// Option pairs that must not be emitted together for an engine. Validation
/// rejects a map that sets both to `true`; at spawn only the first is emitted.
const CONFLICTS: &[(&str, &str, &str)] = &[
    // whisper-server exits at startup when both are set.
    ("whispercpp", "tinydiarize", "diarize"),
];

/// Options that only apply when another boolean option is `true`; at spawn the
/// dependent one is dropped otherwise (the runtime refuses to start).
const REQUIRES: &[(&str, &str, &str)] = &[
    // clap `requires = "split"`.
    ("mesh-llm", "mesh_auto_balance", "mesh_split"),
];

/// Options that cannot be set while another option holds a specific enum
/// value: `(engine, option, value, dependent)`. Validation rejects the pair;
/// at spawn the dependent one is dropped.
const VALUE_CONFLICTS: &[(&str, &str, &str, &str)] = &[
    // oMLX `parser.error`: a custom ceiling needs the guard on.
    ("omlx", "omlx_memory_guard", "off", "omlx_memory_guard_gb"),
];

/// Whether `key` is set to the enum value `expected` (string form).
fn has_value(values: &Map<String, Value>, key: &str, expected: &str) -> bool {
    match values.get(key) {
        Some(Value::String(s)) => s == expected,
        Some(Value::Number(n)) => n.to_string() == expected,
        _ => false,
    }
}

fn is_true(values: &Map<String, Value>, key: &str) -> bool {
    values.get(key).and_then(Value::as_bool) == Some(true)
}

/// Whether `key` must be skipped for `engine` given the other `values`.
fn suppressed(engine: &str, key: &str, values: &Map<String, Value>) -> bool {
    let engine = canonical_engine_id(engine);
    CONFLICTS
        .iter()
        .any(|(id, first, second)| *id == engine && *second == key && is_true(values, first))
        || REQUIRES.iter().any(|(id, dependent, required)| {
            *id == engine && *dependent == key && !is_true(values, required)
        })
        || VALUE_CONFLICTS
            .iter()
            .any(|(id, option, value, dependent)| {
                *id == engine
                    && *dependent == key
                    && has_value(values, option, value)
                    && values.get(*dependent).is_some_and(|v| !v.is_null())
            })
}

/// The canonical catalog id for an engine id or one of its aliases.
fn canonical_engine_id(engine_id: &str) -> &'static str {
    match engine_id.trim().to_ascii_lowercase().as_str() {
        "llamacpp" | "llama.cpp" | "llama" => "llamacpp",
        "llamacpp-embed" => "llamacpp-embed",
        "llamacpp-rerank" => "llamacpp-rerank",
        "llamacpp-classify" => "llamacpp-classify",
        "llamacpp-speech" => "llamacpp-speech",
        "outetts" => "outetts",
        "whispercpp" => "whispercpp",
        "sdcpp" => "sdcpp",
        "vllm" => "vllm",
        "sglang" => "sglang",
        "mlx" => "mlx",
        "mlx-vlm" | "mlxvlm" => "mlx-vlm",
        "mlx-serve" | "mlxserve" => "mlx-serve",
        "omlx" => "omlx",
        "apfel" => "apfel",
        "mesh-llm" | "meshllm" => "mesh-llm",
        "audiocpp" => "audiocpp",
        "ryutts" => "ryutts",
        "ollama" => "ollama",
        _ => "",
    }
}

/// The native option catalog for an engine id (the same ids Core uses for
/// engine preferences: `llamacpp`, `llamacpp-embed`, `whispercpp`, `sdcpp`, …).
/// Engines Ryu does not launch itself (Lemonade, llama-swap, Docker Model
/// Runner, FreeToken, Magnitude) or that run in-process (Parakeet) return an
/// empty slice: there is no process to pass options to.
pub fn native_options(engine_id: &str) -> &'static [NativeOption] {
    match canonical_engine_id(engine_id) {
        "llamacpp" | "llamacpp-embed" | "llamacpp-rerank" | "llamacpp-classify"
        | "llamacpp-speech" => LLAMA_SERVER,
        "outetts" => LLAMA_TTS,
        "whispercpp" => WHISPER_SERVER,
        "sdcpp" => SD_SERVER,
        "vllm" => VLLM,
        "sglang" => SGLANG,
        "mlx" => MLX_LM,
        "mlx-vlm" => MLX_VLM,
        "mlx-serve" => MLX_SERVE,
        "omlx" => OMLX_SERVE,
        "apfel" => APFEL_SERVE,
        "mesh-llm" => MESH_LLM,
        "audiocpp" => AUDIOCPP_SERVER,
        "ryutts" => RYU_TTS,
        "ollama" => OLLAMA_SERVE,
        _ => &[],
    }
}

/// Every engine id that has a native catalog, for validation and docs.
pub const NATIVE_ENGINE_IDS: &[&str] = &[
    "llamacpp",
    "llamacpp-embed",
    "llamacpp-rerank",
    "llamacpp-classify",
    "llamacpp-speech",
    "outetts",
    "whispercpp",
    "sdcpp",
    "vllm",
    "sglang",
    "mlx",
    "mlx-vlm",
    "mlx-serve",
    "omlx",
    "apfel",
    "mesh-llm",
    "audiocpp",
    "ryutts",
    "ollama",
];

/// A value in its emitted string form, or `None` when it does not fit `kind`
/// (wrong JSON type, out of range, unknown enum value, empty or NUL text).
/// `Some("")` is never returned; a `false` boolean yields `Some("false")` so
/// callers can tell it apart from a mismatch.
fn render_value(kind: NativeKind, value: &Value) -> Option<String> {
    match kind {
        NativeKind::Int { min, max } => {
            let n = value.as_i64()?;
            if min.is_some_and(|m| n < m) || max.is_some_and(|m| n > m) {
                return None;
            }
            Some(n.to_string())
        }
        NativeKind::Float { min, max } => {
            let n = value.as_f64()?;
            if !n.is_finite() || min.is_some_and(|m| n < m) || max.is_some_and(|m| n > m) {
                return None;
            }
            Some(n.to_string())
        }
        NativeKind::Text => {
            let s = value.as_str()?.trim();
            (!s.is_empty() && !s.contains('\0')).then(|| s.to_owned())
        }
        NativeKind::Bool => value.as_bool().map(|b| b.to_string()),
        // Numeric enums (bit widths, levels) may arrive as JSON numbers.
        NativeKind::Enum { values } => {
            let s = match value {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                _ => return None,
            };
            values.contains(&s.as_str()).then_some(s)
        }
    }
}

/// CLI arguments for the `Flag` options of `engine_id`'s catalog that are set
/// in `values`, in catalog order. Options that conflict with an earlier one, or
/// that need another option that is not set, are skipped.
pub fn native_args(engine_id: &str, values: &Map<String, Value>) -> Vec<String> {
    let mut out = Vec::new();
    if values.is_empty() {
        return out;
    }
    for option in native_options(engine_id) {
        let NativeTarget::Flag(flag) = option.target else {
            continue;
        };
        if suppressed(engine_id, option.key, values) {
            continue;
        }
        let Some(rendered) = values
            .get(option.key)
            .and_then(|v| render_value(option.kind, v))
        else {
            continue;
        };
        match option.kind {
            NativeKind::Bool => {
                if rendered == "true" {
                    out.push(flag.to_owned());
                }
            }
            _ => {
                out.push(flag.to_owned());
                out.push(rendered);
            }
        }
    }
    out
}

/// Environment variables for the `Env` options of `engine_id`'s catalog that
/// are set in `values`. Booleans become `1`/`0`.
pub fn native_env(engine_id: &str, values: &Map<String, Value>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for option in native_options(engine_id) {
        let NativeTarget::Env(name) = option.target else {
            continue;
        };
        let Some(rendered) = values
            .get(option.key)
            .and_then(|v| render_value(option.kind, v))
        else {
            continue;
        };
        let rendered = match option.kind {
            NativeKind::Bool => if rendered == "true" { "1" } else { "0" }.to_owned(),
            _ => rendered,
        };
        out.push((name.to_owned(), rendered));
    }
    out
}

/// Check `values` against a catalog. With `Some(engine_id)` every key must be
/// in that engine's catalog. With `None` (per-model settings, which can apply
/// to any engine) only keys some catalog lists are shape-checked, and a value
/// passes when any catalog listing the key accepts it; unknown keys pass, so a
/// key a later build stops cataloguing never blocks saving the rest (builders
/// ignore it). `null` values are accepted and mean "unset". Options that
/// cannot be combined are rejected together. Returns a user-facing message for
/// the first problem found.
pub fn validate_native(engine_id: Option<&str>, values: &Map<String, Value>) -> Result<(), String> {
    for (key, value) in values {
        if value.is_null() {
            continue;
        }
        let candidates: Vec<&NativeOption> = match engine_id {
            Some(id) => native_options(id).iter().filter(|o| o.key == key).collect(),
            None => NATIVE_ENGINE_IDS
                .iter()
                .flat_map(|id| native_options(id).iter())
                .filter(|o| o.key == key)
                .collect(),
        };
        let Some(first) = candidates.first() else {
            match engine_id {
                Some(id) => {
                    return Err(format!("unknown native option `{key}` for engine `{id}`"));
                }
                None => continue,
            }
        };
        if !candidates
            .iter()
            .any(|o| render_value(o.kind, value).is_some())
        {
            return Err(format!("invalid value for `{}` ({key})", first.label));
        }
    }
    for (id, a, b) in CONFLICTS {
        let applies = engine_id.is_none_or(|engine| canonical_engine_id(engine) == *id);
        if applies && is_true(values, a) && is_true(values, b) {
            let label = |key: &str| {
                native_options(id)
                    .iter()
                    .find(|o| o.key == key)
                    .map_or(key.to_owned(), |o| o.label.to_owned())
            };
            return Err(format!(
                "`{}` and `{}` cannot be combined",
                label(a),
                label(b)
            ));
        }
    }
    for (id, option, value, dependent) in VALUE_CONFLICTS {
        let applies = engine_id.is_none_or(|engine| canonical_engine_id(engine) == *id);
        if applies
            && has_value(values, option, value)
            && values.get(*dependent).is_some_and(|v| !v.is_null())
        {
            let label = |key: &str| {
                native_options(id)
                    .iter()
                    .find(|o| o.key == key)
                    .map_or(key.to_owned(), |o| o.label.to_owned())
            };
            return Err(format!(
                "`{}` cannot be set when `{}` is {value}",
                label(dependent),
                label(option)
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn keys_are_unique_within_each_catalog() {
        for id in NATIVE_ENGINE_IDS {
            let options = native_options(id);
            assert!(!options.is_empty(), "{id} has a catalog");
            let mut seen = std::collections::HashSet::new();
            for o in options {
                assert!(seen.insert(o.key), "{id}: duplicate key {}", o.key);
            }
        }
    }

    #[test]
    fn shared_keys_have_the_same_shape_in_every_catalog() {
        // One per-model map applies to whichever engine serves the model, so a
        // key must never mean different value shapes in different catalogs.
        let mut kinds: std::collections::HashMap<&str, NativeKind> = Default::default();
        for id in NATIVE_ENGINE_IDS {
            for o in native_options(id) {
                let kind = std::mem::discriminant(&o.kind);
                if let Some(existing) = kinds.get(o.key) {
                    assert_eq!(std::mem::discriminant(existing), kind, "{} differs", o.key);
                } else {
                    kinds.insert(o.key, o.kind);
                }
            }
        }
    }

    #[test]
    fn catalogs_never_expose_core_managed_flags() {
        let managed = [
            "--host",
            "--port",
            "--model",
            "-m",
            "--mmproj",
            "--pooling",
            "--embeddings",
            "--reranking",
            "--listen-ip",
            "--listen-port",
            "--diffusion-model",
            "--output",
            "--prompt",
            "--api-key",
            // Core passes these for one runtime or another.
            "--serve",
            "--model-dir",
            "--permissive",
            "--no-ui",
            "--headless",
            "--base-path",
            "--busy-timeout-ms",
            // mlx_vlm.server secondary models, reload, and per-runtime auth.
            "--image-model",
            "--tts-model",
            "--stt-model",
            "--embedding-model",
            "--decision-model",
            "--reranker-model",
            "--reload",
            "--token",
            "--token-auto",
            "--api-key-env",
            "--api-key-strict",
            "--lan-share",
            "--listen-all",
            "--bind-ip",
            "--console",
            "--auto-update",
            "--client",
            "--mcp",
        ];
        // Mesh LLM owns its models; Core never passes it `--model`. llama-server
        // keeps its web UI flag: Core does not set it.
        let exempt = |id: &str, flag: &str| {
            (id == "mesh-llm" && flag == "--model")
                || (id.starts_with("llamacpp") && flag == "--no-ui")
        };
        for id in NATIVE_ENGINE_IDS {
            for o in native_options(id) {
                if let NativeTarget::Flag(flag) = o.target {
                    assert!(
                        exempt(id, flag) || !managed.contains(&flag),
                        "{id} exposes managed flag {flag}"
                    );
                }
            }
        }
    }

    #[test]
    fn engine_specific_managed_flags_stay_out_of_their_catalogs() {
        let cases: &[(&str, &[&str])] = &[
            // Core passes `--config <server.json> --no-ui` and owns the runtime
            // settings written into that config.
            (
                "audiocpp",
                &[
                    "--config",
                    "--no-ui",
                    "--ui",
                    "--ui-management",
                    "--cors-origins",
                    "--backend",
                    "--device",
                    "--threads",
                    "--max-loaded-models",
                    "--busy-timeout-ms",
                    "--model-spec-override",
                    "--list-devices",
                ],
            ),
            // apfel serve rejects sampling/context flags; auth and MCP stay off.
            (
                "apfel",
                &[
                    "--temperature",
                    "--top-p",
                    "--seed",
                    "--max-tokens",
                    "-s",
                    "--system",
                    "--context-strategy",
                    "--context-max-turns",
                    "--token",
                    "--token-auto",
                    "--public-health",
                    "--no-origin-check",
                    "--footgun",
                    "--mcp",
                ],
            ),
            // Typed LaunchConfig fields for these runtimes.
            (
                "mlx-serve",
                &["--ctx-size", "--lan-discover", "--lan-name", "--stream"],
            ),
            (
                "mesh-llm",
                &["--ctx-size", "--parallel", "--draft", "--draft-max"],
            ),
            (
                "omlx",
                &[
                    "--model-dir",
                    "--host",
                    "--port",
                    "--max-concurrent-requests",
                ],
            ),
        ];
        for (id, flags) in cases {
            for o in native_options(id) {
                if let NativeTarget::Flag(flag) = o.target {
                    assert!(!flags.contains(&flag), "{id} exposes {flag}");
                }
            }
        }
    }

    #[test]
    fn env_only_catalogs_never_override_core_environment() {
        let managed = [
            "PYTHONPATH",
            "RYU_TTS_HOST",
            "RYU_TTS_PORT",
            "RYU_EXT_TOKEN",
            "HF_HOME",
            "HF_TOKEN",
            "RYU_KOKORO_MODEL",
            "RYU_KOKORO_VOICES",
            "OMLX_HOST",
            "OMLX_PORT",
            "OMLX_API_KEY",
            "OMLX_MODEL_DIR",
            "OMLX_BASE_PATH",
            "MLX_VLM_SERVER_API_KEY",
            "MLX_VLM_MODEL_PATHS",
            "APFEL_TOKEN",
            "APFEL_MCP",
        ];
        for id in NATIVE_ENGINE_IDS {
            for o in native_options(id) {
                if let NativeTarget::Env(name) = o.target {
                    assert!(!managed.contains(&name), "{id} exposes managed env {name}");
                }
            }
        }
        // The Ryu Audio sidecar has no command line at all.
        assert!(native_options("ryutts")
            .iter()
            .all(|o| matches!(o.target, NativeTarget::Env(_))));
    }

    #[test]
    fn engines_ryu_does_not_launch_have_no_catalog() {
        for id in [
            "lemonade",
            "llama-swap",
            "docker-model-runner",
            "freetoken",
            "magnitude",
            "parakeet",
        ] {
            assert!(native_options(id).is_empty(), "{id}");
            assert!(!NATIVE_ENGINE_IDS.contains(&id), "{id}");
        }
    }

    #[test]
    fn engine_aliases_resolve_to_the_same_catalog() {
        assert_eq!(native_options("mlxvlm"), native_options("mlx-vlm"));
        assert_eq!(native_options("mlxserve"), native_options("mlx-serve"));
        assert_eq!(native_options("meshllm"), native_options("mesh-llm"));
        assert_eq!(native_options("llama.cpp"), native_options("llamacpp"));
    }

    #[test]
    fn mlx_vlm_prefix_cache_and_queue_knobs_are_environment() {
        let values = map(json!({
            "mlx_vlm_apc_enabled": true,
            "mlx_vlm_token_queue_timeout": 0.0,
            "mlx_vlm_max_kv_size": 8192,
        }));
        assert_eq!(
            native_env("mlx-vlm", &values),
            vec![
                ("MLX_VLM_TOKEN_QUEUE_TIMEOUT".to_owned(), "0".to_owned()),
                ("APC_ENABLED".to_owned(), "1".to_owned()),
            ]
        );
        assert_eq!(
            native_args("mlx-vlm", &values),
            vec!["--max-kv-size", "8192"]
        );
    }

    #[test]
    fn omlx_prefers_environment_and_keeps_flag_rows_in_catalog_order() {
        let values = map(json!({
            "omlx_max_concurrent_requests": 4,
            "omlx_cache_enabled": false,
            "omlx_hot_cache_max_size": "8GB",
            "omlx_memory_guard": "safe",
        }));
        assert_eq!(
            native_env("omlx", &values),
            vec![
                ("OMLX_MAX_CONCURRENT_REQUESTS".to_owned(), "4".to_owned()),
                ("OMLX_CACHE_ENABLED".to_owned(), "0".to_owned()),
            ]
        );
        assert_eq!(
            native_args("omlx", &values),
            vec!["--memory-guard", "safe", "--hot-cache-max-size", "8GB"]
        );
    }

    #[test]
    fn ryu_tts_options_render_as_environment() {
        let values = map(json!({
            "ryutts_onnx_provider": "CPUExecutionProvider",
            "hf_hub_offline": true,
        }));
        assert_eq!(
            native_env("ryutts", &values),
            vec![
                (
                    "ONNX_PROVIDER".to_owned(),
                    "CPUExecutionProvider".to_owned()
                ),
                ("HF_HUB_OFFLINE".to_owned(), "1".to_owned()),
            ]
        );
        assert!(native_args("ryutts", &values).is_empty());
    }

    #[test]
    fn dependent_and_conflicting_options_are_not_emitted_together() {
        let auto_only = map(json!({ "mesh_auto_balance": true }));
        assert!(native_args("mesh-llm", &auto_only).is_empty());
        let both = map(json!({ "mesh_split": true, "mesh_auto_balance": true }));
        assert_eq!(
            native_args("mesh-llm", &both),
            vec!["--split", "--auto-balance"]
        );

        let diarize = map(json!({ "tinydiarize": true, "diarize": true }));
        assert_eq!(native_args("whispercpp", &diarize), vec!["--tinydiarize"]);
        assert!(validate_native(Some("whispercpp"), &diarize).is_err());
        assert!(validate_native(None, &diarize).is_err());
        let one = map(json!({ "tinydiarize": true, "diarize": false }));
        assert!(validate_native(Some("whispercpp"), &one).is_ok());

        // oMLX refuses `--memory-guard off` with `--memory-guard-gb`.
        let guard_off = map(json!({ "omlx_memory_guard": "off", "omlx_memory_guard_gb": 24.0 }));
        assert_eq!(
            native_args("omlx", &guard_off),
            vec!["--memory-guard", "off"]
        );
        assert!(validate_native(Some("omlx"), &guard_off).is_err());
        assert!(validate_native(None, &guard_off).is_err());
        let guard_on = map(json!({ "omlx_memory_guard": "safe", "omlx_memory_guard_gb": 24.0 }));
        assert_eq!(
            native_args("omlx", &guard_on),
            vec!["--memory-guard", "safe", "--memory-guard-gb", "24"]
        );
        assert!(validate_native(Some("omlx"), &guard_on).is_ok());
        let cleared = map(json!({ "omlx_memory_guard": "off", "omlx_memory_guard_gb": null }));
        assert!(validate_native(Some("omlx"), &cleared).is_ok());
    }

    #[test]
    fn mlx_serve_integer_rows_stay_within_upstream_parse_widths() {
        let over = map(json!({ "default_max_tokens": 4_294_967_296_i64 }));
        assert!(validate_native(Some("mlx-serve"), &over).is_err());
        let max = map(json!({ "default_top_k": 4_294_967_295_i64 }));
        assert!(validate_native(Some("mlx-serve"), &max).is_ok());
        let budget = map(json!({ "reasoning_budget": 2_147_483_648_i64 }));
        assert!(validate_native(Some("mlx-serve"), &budget).is_err());
    }

    #[test]
    fn numeric_enums_accept_numbers_and_strings() {
        let values = map(json!({ "max_lora_rank": 64, "optimization_level": "0" }));
        assert_eq!(
            native_args("vllm", &values),
            vec!["--optimization-level", "0", "--max-lora-rank", "64"]
        );
        assert!(validate_native(Some("vllm"), &map(json!({ "max_lora_rank": 24 }))).is_err());
    }

    #[test]
    fn shared_keys_validate_against_any_catalog_that_lists_them() {
        // llama-tts allows seeds up to 4294967294; vLLM has no upper bound.
        assert!(validate_native(None, &map(json!({ "seed": 5_000_000_000_i64 }))).is_ok());
        assert!(
            validate_native(Some("outetts"), &map(json!({ "seed": 5_000_000_000_i64 }))).is_err()
        );
    }

    #[test]
    fn args_follow_catalog_order_and_value_shapes() {
        let values = map(json!({
            "split_mode": "row",
            "threads_batch": 8,
            "no_kv_offload": true,
            "swa_full": false,
            "slot_prompt_similarity": 0.5,
            "reasoning_format": "deepseek",
        }));
        assert_eq!(
            native_args("llamacpp", &values),
            vec![
                "--threads-batch",
                "8",
                "--split-mode",
                "row",
                "--no-kv-offload",
                "--reasoning-format",
                "deepseek",
                "--slot-prompt-similarity",
                "0.5",
            ]
        );
    }

    #[test]
    fn invalid_or_foreign_values_are_skipped_at_spawn() {
        let values = map(json!({
            "split_mode": "diagonal",
            "prio": 9,
            "threads_batch": "eight",
            "device": "   ",
            "enforce_eager": true,
        }));
        assert!(native_args("llamacpp", &values).is_empty());
        assert_eq!(native_args("vllm", &values), vec!["--enforce-eager"]);
    }

    #[test]
    fn satellite_tiers_share_the_llama_server_catalog() {
        let values = map(json!({ "no_warmup": true }));
        for id in [
            "llamacpp-embed",
            "llamacpp-rerank",
            "llamacpp-classify",
            "llamacpp-speech",
        ] {
            assert_eq!(native_args(id, &values), vec!["--no-warmup"], "{id}");
        }
    }

    #[test]
    fn env_options_render_booleans_as_digits() {
        let values = map(json!({
            "ollama_flash_attention": false,
            "ollama_kv_cache_type": "q8_0",
            "ollama_num_parallel": 2,
        }));
        assert_eq!(
            native_env("ollama", &values),
            vec![
                ("OLLAMA_FLASH_ATTENTION".to_owned(), "0".to_owned()),
                ("OLLAMA_KV_CACHE_TYPE".to_owned(), "q8_0".to_owned()),
                ("OLLAMA_NUM_PARALLEL".to_owned(), "2".to_owned()),
            ]
        );
        assert!(native_args("ollama", &values).is_empty());
    }

    #[test]
    fn validation_scopes_keys_to_the_engine() {
        let values = map(json!({ "vae_tiling": true }));
        assert!(validate_native(Some("sdcpp"), &values).is_ok());
        assert!(validate_native(Some("llamacpp"), &values).is_err());
        assert!(validate_native(None, &values).is_ok());
        assert!(validate_native(None, &map(json!({ "retired_option": 1 }))).is_ok());
        assert!(validate_native(None, &map(json!({ "vae_tiling": "yes" }))).is_err());
        assert!(validate_native(Some("sdcpp"), &map(json!({ "threads": "x" }))).is_err());
        assert!(validate_native(Some("sdcpp"), &map(json!({ "threads": null }))).is_ok());
    }

    #[test]
    fn catalog_serializes_for_the_settings_ui() {
        let value = serde_json::to_value(&native_options("ollama")[1]).unwrap();
        assert_eq!(
            value["target"],
            json!({ "type": "env", "name": "OLLAMA_KV_CACHE_TYPE" })
        );
        assert_eq!(
            value["kind"],
            json!({ "type": "enum", "values": OLLAMA_KV_TYPES })
        );
        let int = serde_json::to_value(&native_options("llamacpp")[0]).unwrap();
        assert_eq!(int["kind"], json!({ "type": "int", "min": -1 }));
    }
}
