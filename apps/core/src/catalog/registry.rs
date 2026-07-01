#[derive(Debug, Clone)]
pub enum SidecarSource {
    Github { repo: &'static str },
    Npm { package: &'static str },
    Docker { image: &'static str },
    Pip { package: &'static str },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SidecarCategory {
    Agent,
    Tool,
    Provider,
    /// A voice engine (STT/TTS runtime) — e.g. whisper.cpp. Distinct from
    /// `Provider`: voice engines are *not* mutually-exclusive with the resident
    /// chat engine (you run whisper alongside llama.cpp, not instead of it), so
    /// they are never part of `LOCAL_ENGINES` / the active-engine swap.
    Voice,
    /// A generative-media engine (text-to-image / -video runtime) — e.g.
    /// stable-diffusion.cpp. Like `Voice`, it runs *alongside* the resident chat
    /// engine and is never part of the chat-engine swap.
    Media,
    /// An embedding engine (text→vector runtime) — e.g. a llama.cpp `--embeddings`
    /// instance. Runs *alongside* the resident chat engine (powers semantic RAG),
    /// never part of the chat-engine swap.
    Embedding,
    /// A sandbox / code-execution backend (an isolated exec runtime) — e.g.
    /// wasmtime, Docker, microsandbox, OpenSandbox. Like `Voice`/`Media`, a
    /// sandbox is NOT mutually-exclusive: multiple backends coexist and one is
    /// chosen per call (a default + per-call override), so it is never part of
    /// `LOCAL_ENGINES` / the active-engine swap. Every sandbox backend except the
    /// built-in wasmtime is a detect-only external CLI Ryu never installs; the
    /// picker reads live availability from `/api/sandbox/backend`, not the
    /// catalog's install state.
    Sandbox,
}

impl SidecarCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            SidecarCategory::Agent => "agent",
            SidecarCategory::Tool => "tool",
            SidecarCategory::Provider => "provider",
            SidecarCategory::Voice => "voice",
            SidecarCategory::Media => "media",
            SidecarCategory::Embedding => "embedding",
            SidecarCategory::Sandbox => "sandbox",
        }
    }
}

#[derive(Debug, Clone)]
pub struct CatalogEntry {
    pub name: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
    pub category: SidecarCategory,
    pub source: SidecarSource,
    pub deprecated: bool,
    pub recommended: bool,
}

/// The OS families a catalog entry can run on. An empty slice means "every
/// platform" (the common case). Surfaced to clients as the `platforms` list so a
/// UI can label an entry (e.g. "macOS only"). Display-only — the authoritative
/// "can this node actually run it" answer is [`supported_on_node`], which also
/// accounts for CPU architecture.
pub fn required_platforms(name: &str) -> &'static [&'static str] {
    match name {
        // MLX is Apple's array framework — Apple Silicon macOS only. The vision
        // (mlx-vlm) and oMLX engines build on the same framework, so they share
        // the gate.
        "mlx" | "mlx-vlm" | "omlx" => &["macos"],
        // Tailscale mesh daemon (#478): there is no auto-download yet — the
        // sidecar PATH-adopts an official client install on every platform. This
        // `[linux]` label reserves the future Linux-only downloader and gates the
        // generic install route there; display + install-gate only.
        "tailscale" => &["linux"],
        // microsandbox (msb microVMs) and OpenSandbox (osb) are external CLIs
        // backed by hypervisors/secure-container runtimes that exist only on
        // Linux/macOS — never Windows. Display + node-support gate only.
        "microsandbox" | "opensandbox" => &["linux", "macos"],
        _ => &[],
    }
}

/// Whether THIS Core node can actually install/run `name`, given its own OS and
/// CPU architecture. The NODE is authoritative — not the client driving it — so
/// a remote desktop on Windows correctly sees a macOS-only engine as unsupported
/// when (and only when) the Core node it targets isn't an Apple Silicon Mac.
///
/// Most entries are unconstrained. MLX is the one platform-locked entry today and
/// needs arm64 macOS specifically: `std::env::consts::OS == "macos"` is also true
/// on Intel Macs, where `pip install mlx-lm` fails, so the arch is part of the gate.
pub fn supported_on_node(name: &str) -> bool {
    match name {
        "mlx" | "mlx-vlm" | "omlx" => cfg!(target_os = "macos") && cfg!(target_arch = "aarch64"),
        other => {
            let platforms = required_platforms(other);
            platforms.is_empty() || platforms.contains(&std::env::consts::OS)
        }
    }
}

pub fn static_registry() -> Vec<CatalogEntry> {
    vec![
        // Agents
        CatalogEntry {
            name: "zeroclaw",
            display_name: "ZeroClaw",
            description: "Native binary · fast autonomous agent (default)",
            category: SidecarCategory::Agent,
            source: SidecarSource::Github {
                repo: "ryu-org/zeroclaw",
            },
            deprecated: false,
            recommended: true,
        },
        CatalogEntry {
            name: "openclaw",
            display_name: "OpenClaw",
            description: "npm global package · cross-platform JS agent",
            category: SidecarCategory::Agent,
            source: SidecarSource::Npm {
                package: "@ryu/openclaw",
            },
            deprecated: false,
            recommended: false,
        },
        CatalogEntry {
            name: "nanoclaw",
            display_name: "NanoClaw",
            description: "Docker sandbox isolation · macOS M1 / Win x86 only",
            category: SidecarCategory::Agent,
            source: SidecarSource::Docker {
                image: "ryu-org/nanoclaw",
            },
            deprecated: false,
            recommended: false,
        },
        CatalogEntry {
            name: "picoclaw",
            display_name: "PicoClaw",
            description: "Lightweight native binary · minimal footprint · embeddable",
            category: SidecarCategory::Agent,
            source: SidecarSource::Github {
                repo: "ryu-org/picoclaw",
            },
            deprecated: false,
            recommended: false,
        },
        CatalogEntry {
            name: "nemoclaw",
            display_name: "NemoClaw",
            description: "NVIDIA NeMo · built-in privacy & safety guardrails",
            category: SidecarCategory::Agent,
            source: SidecarSource::Github {
                repo: "ryu-org/nemoclaw",
            },
            deprecated: false,
            recommended: false,
        },
        CatalogEntry {
            name: "ironclaw",
            display_name: "IronClaw",
            description: "NEAR AI agent · autonomous workflows with blockchain integration",
            category: SidecarCategory::Agent,
            source: SidecarSource::Github {
                repo: "ryu-org/ironclaw",
            },
            deprecated: false,
            recommended: false,
        },
        // Tools
        CatalogEntry {
            name: "agentbrowser",
            display_name: "Agent Browser",
            description: "AI-powered web browsing tool — navigate, extract, and interact with web pages",
            category: SidecarCategory::Tool,
            source: SidecarSource::Npm {
                package: "agentbrowser",
            },
            deprecated: false,
            recommended: true,
        },
        CatalogEntry {
            name: "temporal",
            display_name: "Temporal",
            description: "Workflow engine for predictable, durable workflows",
            category: SidecarCategory::Tool,
            source: SidecarSource::Github {
                repo: "temporalio/temporal",
            },
            deprecated: false,
            recommended: false,
        },
        CatalogEntry {
            name: "spider",
            display_name: "Spider",
            description: "Web crawler — more than just search",
            category: SidecarCategory::Tool,
            source: SidecarSource::Github {
                repo: "spider-rs/spider",
            },
            deprecated: false,
            recommended: true,
        },
        CatalogEntry {
            name: "llmfit",
            display_name: "LLMFit",
            description: "Hardware-aware LLM model recommendations",
            category: SidecarCategory::Tool,
            source: SidecarSource::Github {
                repo: "ryu-org/llmfit",
            },
            deprecated: false,
            recommended: true,
        },
        CatalogEntry {
            name: "qmd",
            display_name: "QMD",
            description: "Markdown knowledge base search tool",
            category: SidecarCategory::Tool,
            source: SidecarSource::Npm {
                package: "@ryu/qmd",
            },
            deprecated: false,
            recommended: false,
        },
        CatalogEntry {
            name: "shadow",
            display_name: "Shadow",
            description: "Personal intelligence engine — screen capture & OCR",
            category: SidecarCategory::Tool,
            source: SidecarSource::Github {
                repo: "ryu-org/shadow",
            },
            deprecated: false,
            recommended: true,
        },
        CatalogEntry {
            name: "ghost",
            display_name: "Ghost",
            description: "MCP server — AI eyes and hands for any desktop app",
            category: SidecarCategory::Tool,
            source: SidecarSource::Github {
                repo: "ryu-org/ghost",
            },
            deprecated: false,
            recommended: true,
        },
        // Providers
        CatalogEntry {
            name: "llamacpp",
            display_name: "LlamaCpp",
            description: "Wide range of model support (default)",
            category: SidecarCategory::Provider,
            source: SidecarSource::Github {
                repo: "ggml-org/llama.cpp",
            },
            deprecated: false,
            recommended: true,
        },
        CatalogEntry {
            name: "ollama",
            display_name: "Ollama",
            description: "Wrapper on llama.cpp with predefined models",
            category: SidecarCategory::Provider,
            source: SidecarSource::Github {
                repo: "ollama/ollama",
            },
            deprecated: false,
            recommended: false,
        },
        CatalogEntry {
            name: "vllm",
            display_name: "vLLM",
            description: "High-throughput GPU inference · requires python ≥3.9",
            category: SidecarCategory::Provider,
            source: SidecarSource::Pip { package: "vllm" },
            deprecated: false,
            recommended: false,
        },
        CatalogEntry {
            name: "sglang",
            display_name: "SGLang",
            description: "Fast serving runtime · RadixAttention · requires python ≥3.9",
            category: SidecarCategory::Provider,
            source: SidecarSource::Pip { package: "sglang" },
            deprecated: false,
            recommended: false,
        },
        CatalogEntry {
            name: "mlx",
            display_name: "MLX (text)",
            description: "Apple Silicon inference · mlx-lm · text-only · macOS (arm64) only · requires python ≥3.9",
            category: SidecarCategory::Provider,
            source: SidecarSource::Pip { package: "mlx-lm" },
            deprecated: false,
            recommended: false,
        },
        // MLX-VLM — the vision/omni sibling of mlx-lm. Same OpenAI-compat chat
        // endpoint, plus image/audio/video input, so it is the recommended
        // (default) MLX engine for Apple Silicon while mlx-lm stays available.
        CatalogEntry {
            name: "mlx-vlm",
            display_name: "MLX (vision)",
            description: "Apple Silicon inference · mlx-vlm · text + vision/omni · macOS (arm64) only · requires python ≥3.9",
            category: SidecarCategory::Provider,
            source: SidecarSource::Pip { package: "mlx-vlm" },
            deprecated: false,
            recommended: true,
        },
        // oMLX — high-performance Apple-Silicon server (continuous batching +
        // RAM/SSD KV cache). Not on PyPI: PATH-adopted with a best-effort install
        // (Homebrew / pip-from-git), so it is opt-in and not recommended-by-default.
        CatalogEntry {
            name: "omlx",
            display_name: "oMLX",
            description: "Apple Silicon inference · oMLX · continuous batching + SSD KV cache · multi-model · macOS (arm64) only · Homebrew/git install",
            category: SidecarCategory::Provider,
            source: SidecarSource::Github {
                repo: "jundot/omlx",
            },
            deprecated: false,
            recommended: false,
        },
        // Docker Model Runner — an adopt-only engine. Ryu downloads nothing; it
        // routes to Docker's built-in OpenAI-compatible model server (Docker
        // Desktop 4.40+ / Docker Engine + `model` plugin) once the user enables
        // host TCP access on :12434. Models are pulled via `docker model pull`.
        CatalogEntry {
            name: "docker-model-runner",
            display_name: "Docker Model Runner",
            description: "Run models via Docker · OpenAI-compatible · requires Docker Desktop 4.40+ with Model Runner + host TCP access (:12434)",
            category: SidecarCategory::Provider,
            source: SidecarSource::Docker {
                image: "docker/model-runner",
            },
            deprecated: false,
            recommended: false,
        },
        // NOTE: the local embeddings server (`llamacpp-embed`) is intentionally
        // NOT a catalog/Store entry — it is backing infrastructure, not a
        // user-pickable engine. It auto-starts (startup_order) and serves the
        // embedding model downloaded by onboarding, exactly like the chat model
        // is never a Store entry. The embedding *model* lives in the Models tab.
        //
        // Voice engines (STT/TTS) — managed separately from the resident chat
        // engine; can run alongside any provider above.
        CatalogEntry {
            name: "whispercpp",
            display_name: "whisper.cpp",
            description: "Local speech-to-text · OpenAI-compatible · CPU-friendly GGML models",
            category: SidecarCategory::Voice,
            source: SidecarSource::Github {
                repo: "ggml-org/whisper.cpp",
            },
            deprecated: false,
            recommended: false,
        },
        // NOTE: parakeet is NOT a catalog/Store entry — it is a speech *model*
        // (NVIDIA Parakeet TDT ONNX), downloaded by onboarding and browsable in
        // the Models tab. whisper.cpp is the user-facing speech engine; parakeet
        // is served in-process via `/api/voice/transcribe?engine=parakeet`.
        //
        // Text-to-speech (voice generation) — runs the OuteTTS GGUF on the shared
        // llama.cpp `llama-tts` binary; consumed by `POST /api/voice/speak`.
        CatalogEntry {
            name: "outetts",
            display_name: "OuteTTS",
            description: "Local text-to-speech · OuteTTS + WavTokenizer (GGUF) · runs on llama.cpp · CPU-friendly",
            category: SidecarCategory::Voice,
            source: SidecarSource::Github {
                repo: "edwko/OuteTTS",
            },
            deprecated: false,
            recommended: false,
        },
        // Universal multi-engine TTS — a small Python sidecar (apps/tts-sidecar)
        // that fronts many TTS engines (KittenTTS, Pocket TTS, …) behind one
        // contract. Consumed by `POST /api/voice/speak?engine=<id>`; the engine
        // set is whatever the sidecar registry serves (nothing hardcoded).
        CatalogEntry {
            name: "ryutts",
            display_name: "Ryu TTS (multi-engine)",
            description: "Universal local text-to-speech · swap between KittenTTS, Pocket TTS, and more · CPU-friendly · voice cloning on supported engines",
            category: SidecarCategory::Voice,
            source: SidecarSource::Github {
                repo: "jamiepine/voicebox",
            },
            deprecated: false,
            recommended: false,
        },
        // Generative-media engines (text-to-image / -video) — managed separately
        // from the resident chat engine; can run alongside any provider above.
        CatalogEntry {
            name: "sdcpp",
            display_name: "Stable Diffusion (image + video)",
            description: "Local text-to-image and text/image-to-video · stable-diffusion.cpp · GGUF · OpenAI-compatible · CPU-friendly (GPU recommended for video)",
            category: SidecarCategory::Media,
            source: SidecarSource::Github {
                repo: "leejet/stable-diffusion.cpp",
            },
            deprecated: false,
            recommended: false,
        },
        // Fine-tuning runtime — a Python sidecar (apps/unsloth-sidecar) wrapping the
        // Apache-2.0 Unsloth library (+ TRL) for LoRA/QLoRA training. A Tool, not a
        // Provider: it produces models (consumed via `/api/finetune/*`) rather than
        // serving the chat engine. Opt-in; training needs an NVIDIA CUDA GPU.
        CatalogEntry {
            name: "unsloth",
            display_name: "Unsloth (fine-tuning)",
            description: "Local LoRA/QLoRA fine-tuning · Unsloth + TRL · 2x faster, ~70% less VRAM · exports GGUF for serving · needs an NVIDIA GPU",
            category: SidecarCategory::Tool,
            source: SidecarSource::Github {
                repo: "unslothai/unsloth",
            },
            deprecated: false,
            recommended: false,
        },
        // ── Sandbox backends (code-execution runtimes) ───────────────────────
        // Detect-only externals except the built-in wasmtime. Selected per call
        // or as the node default via `/api/sandbox/backend`; never installed
        // through the catalog (the `source` below is provenance only).
        CatalogEntry {
            name: "wasmtime",
            display_name: "Wasmtime (WASM · built-in)",
            description: "In-process WASM/WASI sandbox · default · deny-by-default · no external deps",
            category: SidecarCategory::Sandbox,
            source: SidecarSource::Github {
                repo: "bytecodealliance/wasmtime",
            },
            deprecated: false,
            recommended: true,
        },
        CatalogEntry {
            name: "docker",
            display_name: "Docker",
            description: "Run commands in Docker containers · detect-only (Core never bundles Docker)",
            category: SidecarCategory::Sandbox,
            source: SidecarSource::Docker { image: "docker" },
            deprecated: false,
            recommended: false,
        },
        CatalogEntry {
            name: "microsandbox",
            display_name: "microsandbox",
            description: "microVM isolation via the msb CLI · detect-only · Linux/macOS only",
            category: SidecarCategory::Sandbox,
            source: SidecarSource::Github {
                repo: "superradcompany/microsandbox",
            },
            deprecated: false,
            recommended: false,
        },
        CatalogEntry {
            name: "opensandbox",
            display_name: "OpenSandbox",
            description: "gVisor / Kata / Firecracker via the osb CLI · detect-only · Linux/macOS only",
            category: SidecarCategory::Sandbox,
            source: SidecarSource::Github {
                repo: "opensandbox-group/OpenSandbox",
            },
            deprecated: false,
            recommended: false,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_has_correct_count() {
        let r = static_registry();
        // 26 base entries + 4 sandbox backends (wasmtime, docker, microsandbox,
        // opensandbox). NOTE: this is a global count over a shared tree — if a
        // concurrent feature adds a catalog row, rebase this number with it.
        assert_eq!(r.len(), 30);
    }

    #[test]
    fn registry_recommended_entries() {
        let r = static_registry();
        let recommended: Vec<&str> = r.iter().filter(|e| e.recommended).map(|e| e.name).collect();
        assert!(recommended.contains(&"zeroclaw"));
        assert!(recommended.contains(&"ghost"));
        assert!(recommended.contains(&"llamacpp"));
        // The default-installed tool apps are all recommended.
        assert!(recommended.contains(&"agentbrowser"));
        assert!(recommended.contains(&"spider"));
        assert!(recommended.contains(&"shadow"));
        assert!(recommended.contains(&"llmfit"));
    }

    #[test]
    fn removed_entries_are_absent() {
        // These were dropped from the Store/Services catalog. Keep this test so a
        // future re-add is a deliberate decision, not an accident.
        let r = static_registry();
        let names: Vec<&str> = r.iter().map(|e| e.name).collect();
        for gone in [
            "restate",
            "claw-patrol",
            "secureclaw",
            "openshell",
            "promptfoo",
            "screenpipe",
        ] {
            assert!(
                !names.contains(&gone),
                "{gone} should be absent from the catalog"
            );
        }
    }

    #[test]
    fn all_entries_have_nonempty_description() {
        for entry in static_registry() {
            assert!(
                !entry.description.is_empty(),
                "{} has empty description",
                entry.name
            );
        }
    }

    #[test]
    fn categories_are_correct() {
        let r = static_registry();
        let agents: Vec<_> = r
            .iter()
            .filter(|e| e.category == SidecarCategory::Agent)
            .collect();
        let tools: Vec<_> = r
            .iter()
            .filter(|e| e.category == SidecarCategory::Tool)
            .collect();
        let providers: Vec<_> = r
            .iter()
            .filter(|e| e.category == SidecarCategory::Provider)
            .collect();
        let voice: Vec<_> = r
            .iter()
            .filter(|e| e.category == SidecarCategory::Voice)
            .collect();
        let media: Vec<_> = r
            .iter()
            .filter(|e| e.category == SidecarCategory::Media)
            .collect();
        let embedding: Vec<_> = r
            .iter()
            .filter(|e| e.category == SidecarCategory::Embedding)
            .collect();
        let sandbox: Vec<_> = r
            .iter()
            .filter(|e| e.category == SidecarCategory::Sandbox)
            .collect();
        assert_eq!(agents.len(), 6);
        // agentbrowser, temporal, spider, llmfit, qmd, shadow, ghost (+ a
        // concurrently-added tool in this shared tree).
        assert_eq!(tools.len(), 8);
        // llamacpp, ollama, vllm, sglang, mlx, mlx-vlm, omlx (last three Apple
        // Silicon only), docker-model-runner (adopt-only).
        assert_eq!(providers.len(), 8);
        // whisper.cpp + OuteTTS + Ryu TTS multi-engine sidecar (parakeet is a
        // model, not a Store engine entry).
        assert_eq!(voice.len(), 3);
        assert_eq!(media.len(), 1);
        // No embedding *engine* is a Store entry — the embeddings server is
        // backing infra (auto-started), not user-pickable.
        assert_eq!(embedding.len(), 0);
        // wasmtime (built-in) + docker + microsandbox + opensandbox.
        assert_eq!(sandbox.len(), 4);
    }

    #[test]
    fn seeded_entries_have_nonempty_source_and_valid_category() {
        let seeded_names = ["agentbrowser", "spider", "shadow", "ghost", "llmfit"];
        let r = static_registry();
        for name in seeded_names {
            let entry = r
                .iter()
                .find(|e| e.name == name)
                .unwrap_or_else(|| panic!("{name} missing from registry"));
            let source_nonempty = match &entry.source {
                SidecarSource::Github { repo } => !repo.is_empty(),
                SidecarSource::Npm { package } => !package.is_empty(),
                SidecarSource::Docker { image } => !image.is_empty(),
                SidecarSource::Pip { package } => !package.is_empty(),
            };
            assert!(source_nonempty, "{name} has empty source");
            assert!(
                entry.category == SidecarCategory::Tool
                    || entry.category == SidecarCategory::Agent
                    || entry.category == SidecarCategory::Provider,
                "{name} has unexpected category"
            );
        }
    }
}
