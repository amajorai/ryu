# ryu-model-catalog

The orchestration behind Ryu's "browse and install a model" experience: Hugging Face
search/detail restricted to GGUF (llama.cpp-runnable) models, per-file **device-fit
verdicts**, stats, and checksum-verified install. All logic lives here so every
surface (desktop/mobile/CLI/extension) reuses the same search, ranking, and install
through one Core HTTP API.

## Role in the decomposition

An extracted **Core capability crate**, compiled into `apps/core` as the in-process
default. Choosing *which* model to run and downloading its weights is *what runs* →
**Core**; the Gateway still governs every model *call* (routing/budgets/policy) — this
crate never makes an inference call.

Zero dependency on `apps/core`. Five cross-cutting couplings invert through the narrow
**`ModelCatalogHost`** trait (implemented in `apps/core/src/model_catalog_host.rs`,
installed at boot via `set_global_host`): the `~/.ryu` data dir, Hugging Face bearer
auth, the active-model preference, the per-node engine-support gate, and the bundled
default-model repos. Production `host()` panics if unset. **That trait is the swap
seam.** Downloads route through `ryu-downloads`; `ModelFormat` comes from
`ryu-model-format`.

## Modules

- `lib.rs` — `ModelCatalogHost` seam, search/detail/install orchestration.
- `device` — RAM detection + `FitVerdict` ("runs on your device") estimation.
- `gguf` — GGUF quant-tree inspection with real file sizes.
- `capabilities` — per-model capability overrides.
- `installed` — installed-model provenance tracking.
- `aa` / `models_dev` — Artificial Analysis + models.dev metadata sources (degrade
  silently when no API key is configured).
- `llmfit`, `win_process` — fit heuristics and Windows process helpers.

## Consumed as

Compiled-into-Core crate; served over Core's `/api/models/*` catalog routes.

Deps: reqwest, tokio, serde, async-trait, urlencoding, ryu-downloads,
ryu-model-format.
