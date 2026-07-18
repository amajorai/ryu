# ryu-model-format

The model weight-format primitive: the `ModelFormat` enum, its wire/serde
mapping, and the pure format → engine capability tables.

## Role in the decomposition

A **leaf** capability crate (L0) — pure data + logic, no I/O, ZERO dependency on
`apps/core`. It is the dependency root for engine-aware (format-aware) model
handling: the model catalog, sidecar providers, chat adapters, and catalog
sources all reference these format types **without depending on each other**.
Compiled into Core as a NON-optional path dependency and re-exported as
`crate::model_format`.

## Key API

- `ModelFormat` — `Gguf` (default; every legacy record predates the field) /
  `Safetensors` / `Mlx`, with kebab-case wire values. Helpers: `ALL`, `as_str`,
  `from_wire`, `hf_filter`, `is_single_file`, `has_per_file_quant`,
  `weight_extensions`.
- `EngineCapability` + `engine_capabilities()` — the static table of which formats
  each engine can serve.
- Derivation functions: `engines_for_format`, `formats_for_engine`,
  `engine_display_name`, `needs_engine_label`, `pick_engine`, and
  `format_supported_on_node` (per-node gating via an injected `supported` fn, e.g.
  MLX on Apple Silicon only).

## Design rule it encodes

A MODEL has a format; an ENGINE declares which formats it can serve; the engine to
run a given model is **derived** from the model's format — never a per-agent slot,
never an inline `match`. Per-node support is injected so platform gating reuses the
existing catalog mechanism.

## Swap seam

The capability table is the seam: adding an engine or a format is a table edit
here, and every downstream consumer picks it up unchanged.
