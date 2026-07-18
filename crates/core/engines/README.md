# ryu-engines

The engine-agnostic *inference-configuration* primitive — the "advanced model
settings" surface (jan.ai / LM Studio parity) implemented once and translated per
engine into OpenAI-compat bodies, `llama-server` CLI args, and Ollama Modelfile
params.

## Role in the decomposition

An extracted Core capability crate (L0), **compiled into Core by default** and
consumed as a NON-optional path dependency — providers + adapters build
launch/sampling args unconditionally. ZERO dependency on `apps/core`.

## Key API — two layers, two lifetimes

- `SamplingConfig` — **per-request** generation knobs (temperature, top_p, top_k,
  min_p, penalties, mirostat, DRY, seed, …). No engine restart. `apply_to_body`
  merges them into the outbound JSON, translating field names per engine; `merge`
  layers per-agent defaults with per-request overrides; `ollama_modelfile_params`
  emits the Ollama form.
- `LaunchConfig` — **engine-launch** flags (context size, GPU layers, MoE offload,
  chat template/jinja, speculative draft, quantization, continuous-batching).
  Keyed per model (one resident `llama-server` serves every agent). `to_args`
  builds the per-engine CLI vector; `apply_llamacpp_batching_defaults` fills
  memory-aware slot defaults; `to_ollama_modelfile` emits the Modelfile form.
- `Engine` — the target enum (llama.cpp / Ollama / vLLM / SGLang / MLX / Other);
  `from_name`, `is_local`.

## Nothing hardcoded

Both layers carry a raw passthrough escape hatch — `SamplingConfig::extra`
(arbitrary body fields) and `LaunchConfig::extra_args` (raw CLI args) — so a
sampler or research flag the typed surface doesn't enumerate works the day the
engine build supports it, with no Core code change. Per-engine field translation
is verified against each engine's source (e.g. llama.cpp `b9670` MTP spec-decode,
the `--spec-draft-n-max` rename).

## Dependencies

Depends on `ryu-model-catalog` only for hardware detection
(`device::DeviceInfo::detect`, `default_parallel_slots`) that feeds the batching
defaults. No cycle — `ryu-model-catalog` never depends back.

## Scope boundary (swap seam)

Owns engine *configuration/translation* only. It does NOT own the provider launch
lifecycle (`sidecar/providers`, sidecar-kernel-coupled), the runtime
priority-admission queue (deferred to `ryu-queue`), or the embed surface
(`Embedder`/`Reranker`, deferred to `ryu-rag`).
