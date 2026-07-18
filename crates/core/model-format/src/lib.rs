//! Model weight formats and the engine-capability registry.
//!
//! This is the dependency root for engine-aware (format-aware) model handling.
//! It is pure data + logic with no I/O, so it stays trivially testable and can
//! be consumed by `model_catalog`, the sidecar providers, the chat adapters,
//! and the HTTP server without any of them depending on each other.
//!
//! The design rule it encodes: a MODEL has a format; an ENGINE declares which
//! formats it can serve; the engine to run a given model is DERIVED from the
//! model's format (never a per-agent slot, never an inline `match`). Per-node
//! support is injected (`supported_on_node`) so platform gating (e.g. MLX on
//! Apple Silicon only) reuses the existing catalog mechanism.

use serde::{Deserialize, Serialize};

/// A model weight format. The wire value (kebab-case) is what catalog
/// descriptors carry and what Hugging Face's `filter=` param uses where
/// applicable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelFormat {
    /// llama.cpp / ollama single-file quantized weights (`.gguf`).
    Gguf,
    /// HF-native safetensors repo (vLLM / sglang auto-resolve at serve time).
    Safetensors,
    /// Apple MLX-format weights (the `mlx-community/*` org convention).
    Mlx,
}

impl Default for ModelFormat {
    /// Every legacy on-disk record predates the `format` field and is GGUF.
    fn default() -> Self {
        ModelFormat::Gguf
    }
}

impl ModelFormat {
    /// All formats Ryu knows how to catalog. Used to fan out catalog queries —
    /// the FULL set, regardless of node support, so incompatible models still
    /// surface and get annotated rather than hidden.
    pub const ALL: &'static [ModelFormat] = &[
        ModelFormat::Gguf,
        ModelFormat::Safetensors,
        ModelFormat::Mlx,
    ];

    /// The stable wire string for this format.
    pub fn as_str(self) -> &'static str {
        match self {
            ModelFormat::Gguf => "gguf",
            ModelFormat::Safetensors => "safetensors",
            ModelFormat::Mlx => "mlx",
        }
    }

    /// Parse a wire string back into a format. Unknown strings fall back to the
    /// default (GGUF) so a stale client never breaks the catalog.
    pub fn from_wire(s: &str) -> ModelFormat {
        match s.trim().to_ascii_lowercase().as_str() {
            "safetensors" => ModelFormat::Safetensors,
            "mlx" => ModelFormat::Mlx,
            _ => ModelFormat::Gguf,
        }
    }

    /// The HF Hub `filter=` value for a single-format catalog query, when the
    /// Hub supports filtering by it. `None` means there is no direct filter and
    /// the caller must scope/infer the format another way (see `mlx`).
    pub fn hf_filter(self) -> Option<&'static str> {
        match self {
            ModelFormat::Gguf => Some("gguf"),
            ModelFormat::Safetensors => Some("safetensors"),
            // MLX has no `filter=mlx`; it is an org/tag convention. Catalog
            // queries fall back to `author=mlx-community`.
            ModelFormat::Mlx => None,
        }
    }

    /// Whether install produces ONE file (`~/.ryu/models/<stem>.gguf`) or a
    /// repo SNAPSHOT directory (`~/.ryu/models/<slug>/`). Drives the install
    /// primitive and the device-fit strategy.
    pub fn is_single_file(self) -> bool {
        matches!(self, ModelFormat::Gguf)
    }

    /// Whether per-file device-fit + quant-file selection applies (GGUF only).
    /// Snapshot formats get a coarse repo-level verdict instead.
    pub fn has_per_file_quant(self) -> bool {
        matches!(self, ModelFormat::Gguf)
    }

    /// Repo-relative file extensions that constitute the installable weight +
    /// config set for this format. Used by the format-aware tree enumerator so
    /// a snapshot install mirrors the right files.
    pub fn weight_extensions(self) -> &'static [&'static str] {
        match self {
            ModelFormat::Gguf => &[".gguf"],
            // Snapshots need weights + the config/tokenizer files the engine
            // resolves at serve time.
            ModelFormat::Safetensors | ModelFormat::Mlx => {
                &[".safetensors", ".json", ".txt", ".model"]
            }
        }
    }
}

/// One engine's format support, declared as DATA (never an inline `match` in
/// the picker — that would recreate the lock the whole design avoids).
#[derive(Debug, Clone)]
pub struct EngineCapability {
    /// Sidecar name; matches `crate::sidecar::active_engine::LOCAL_ENGINES`.
    pub engine: &'static str,
    /// Formats this engine can serve.
    pub formats: &'static [ModelFormat],
}

/// THE capability table. Adding an engine = one row here (plus its provider
/// module + main registration, which already exist for current engines).
/// Order matters: it is the recommendation tiebreaker (earlier = preferred).
///
/// NOTE: `omlx` is intentionally absent — it serves a model-dir, not a
/// resolvable single model, so it stays outside format-derived activation.
/// Adding it would route format-derived installs into an engine that serves
/// nothing until a model is manually placed in its dir.
pub fn engine_capabilities() -> &'static [EngineCapability] {
    &[
        EngineCapability {
            engine: "llamacpp",
            formats: &[ModelFormat::Gguf],
        },
        EngineCapability {
            engine: "ollama",
            formats: &[ModelFormat::Gguf],
        },
        EngineCapability {
            engine: "vllm",
            formats: &[ModelFormat::Safetensors],
        },
        EngineCapability {
            engine: "sglang",
            formats: &[ModelFormat::Safetensors],
        },
        EngineCapability {
            engine: "mlx",
            formats: &[ModelFormat::Mlx],
        },
        EngineCapability {
            engine: "mlx-vlm",
            formats: &[ModelFormat::Mlx],
        },
    ]
}

/// Every engine that can serve `fmt`, in recommendation order (data-driven).
pub fn engines_for_format(fmt: ModelFormat) -> Vec<&'static str> {
    engine_capabilities()
        .iter()
        .filter(|c| c.formats.contains(&fmt))
        .map(|c| c.engine)
        .collect()
}

/// The format(s) an engine serves (reverse lookup, for UI/annotation).
pub fn formats_for_engine(engine: &str) -> &'static [ModelFormat] {
    engine_capabilities()
        .iter()
        .find(|c| c.engine == engine)
        .map(|c| c.formats)
        .unwrap_or(&[])
}

/// A human-facing engine label for the "needs X" annotation shown when a model
/// is not runnable on the current node.
pub fn engine_display_name(engine: &str) -> &'static str {
    match engine {
        "llamacpp" => "llama.cpp",
        "ollama" => "Ollama",
        "vllm" => "vLLM",
        "sglang" => "SGLang",
        "mlx" => "MLX",
        "mlx-vlm" => "MLX-VLM",
        _ => "another engine",
    }
}

/// The "needs X" label for an incompatible model: the display name of the first
/// engine that could serve its format, or a generic fallback.
pub fn needs_engine_label(fmt: ModelFormat) -> Option<String> {
    engines_for_format(fmt)
        .first()
        .map(|e| engine_display_name(e).to_string())
}

/// Deterministic engine picker. `resident` is the currently active local engine
/// name, if any. Prefers a resident engine that serves this format and is
/// node-supported, else the first node-SUPPORTED engine for the format
/// (registry order = recommendation), else `None` (no installed/supported
/// engine on this node — annotate-only).
///
/// `supported` is injected so this module stays I/O-free and unit-testable; in
/// production pass `crate::catalog::registry::supported_on_node`.
pub fn pick_engine(
    fmt: ModelFormat,
    resident: Option<&str>,
    supported: impl Fn(&str) -> bool,
) -> Option<&'static str> {
    let candidates = engines_for_format(fmt);
    if let Some(r) = resident {
        if let Some(found) = candidates.iter().copied().find(|c| *c == r) {
            if supported(found) {
                return Some(found);
            }
        }
    }
    candidates.into_iter().find(|c| supported(c))
}

/// Per-node availability of a format: true iff at least one engine serving it is
/// supported on this node. Drives the compatibility verdict.
pub fn format_supported_on_node(fmt: ModelFormat, supported: impl Fn(&str) -> bool) -> bool {
    engines_for_format(fmt).into_iter().any(|e| supported(e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_wire_roundtrips() {
        for f in ModelFormat::ALL {
            assert_eq!(ModelFormat::from_wire(f.as_str()), *f);
        }
        // Unknown falls back to the GGUF default.
        assert_eq!(ModelFormat::from_wire("totally-bogus"), ModelFormat::Gguf);
    }

    #[test]
    fn capability_lookups_are_data_driven() {
        assert_eq!(
            engines_for_format(ModelFormat::Gguf),
            vec!["llamacpp", "ollama"]
        );
        assert_eq!(
            engines_for_format(ModelFormat::Safetensors),
            vec!["vllm", "sglang"]
        );
        assert_eq!(engines_for_format(ModelFormat::Mlx), vec!["mlx", "mlx-vlm"]);
        // omlx is deliberately not in the table.
        assert!(!engine_capabilities().iter().any(|c| c.engine == "omlx"));
        assert_eq!(formats_for_engine("vllm"), &[ModelFormat::Safetensors]);
        assert_eq!(formats_for_engine("omlx"), &[] as &[ModelFormat]);
    }

    #[test]
    fn pick_prefers_resident_when_it_serves_and_is_supported() {
        // ollama is resident and serves GGUF and is supported -> keep it,
        // even though llamacpp is earlier in the table.
        let picked = pick_engine(ModelFormat::Gguf, Some("ollama"), |_| true);
        assert_eq!(picked, Some("ollama"));
    }

    #[test]
    fn pick_falls_to_first_supported_when_resident_does_not_serve() {
        // llamacpp resident but we want safetensors -> first supported st engine.
        let picked = pick_engine(ModelFormat::Safetensors, Some("llamacpp"), |_| true);
        assert_eq!(picked, Some("vllm"));
    }

    #[test]
    fn pick_skips_resident_when_unsupported() {
        // mlx resident (e.g. config drift) but node does not support mlx -> the
        // next supported candidate, here mlx-vlm only if supported.
        let picked = pick_engine(ModelFormat::Mlx, Some("mlx"), |e| e == "mlx-vlm");
        assert_eq!(picked, Some("mlx-vlm"));
    }

    #[test]
    fn pick_none_when_no_engine_supported() {
        // Non-Apple-Silicon node: nothing serves MLX -> annotate-only.
        let picked = pick_engine(ModelFormat::Mlx, None, |_| false);
        assert_eq!(picked, None);
    }

    #[test]
    fn format_support_follows_engine_support() {
        // GGUF supported because llamacpp is supported.
        assert!(format_supported_on_node(ModelFormat::Gguf, |e| e == "llamacpp"));
        // MLX unsupported when neither mlx engine is supported.
        assert!(!format_supported_on_node(ModelFormat::Mlx, |e| e == "llamacpp"));
    }

    #[test]
    fn single_file_only_for_gguf() {
        assert!(ModelFormat::Gguf.is_single_file());
        assert!(!ModelFormat::Safetensors.is_single_file());
        assert!(!ModelFormat::Mlx.is_single_file());
    }
}
