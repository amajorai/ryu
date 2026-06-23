//! llama.cpp process management.

use std::path::PathBuf;
use std::process::Child;

use anyhow::{Context, Result};

/// Startup options for the llama-server process.
pub struct LlamaCppStartOptions {
    /// Port to bind (default 8080 — matches `local_engine_base_url("llamacpp")`).
    pub port: u16,
    /// Path to the GGUF model file to serve. When `None`, llama-server starts
    /// without a model and responds to completions requests with an error; this
    /// is acceptable for binary-install-only tests but not for real chat.
    pub model_path: Option<PathBuf>,
    /// Path to the multimodal projector ("vision adapter", `mmproj-*.gguf`) to
    /// load alongside the model (passed as `--mmproj`). `Some` makes llama-server
    /// accept image inputs for a vision model; `None` (the default) is a normal
    /// text-only launch. Resolved by the on-disk convention via
    /// [`mmproj_for_model`] so the served model always gets its bound adapter.
    pub mmproj_path: Option<PathBuf>,
    /// Context window size in tokens (passed as `--ctx-size`). 0 = engine default.
    /// Superseded by `launch.ctx_size` when that is set (advanced inference).
    pub ctx_size: u32,
    /// When `true`, start llama-server in embeddings mode (`--embeddings`), which
    /// enables the OpenAI-compatible `/v1/embeddings` endpoint. Used by the
    /// dedicated `llamacpp-embed` sidecar that serves the nomic embedding model.
    pub embeddings: bool,
    /// Advanced per-model launch config (context size, GPU layers, MoE offload,
    /// chat template, speculative draft model, ...). Translated to `llama-server`
    /// flags via `LaunchConfig::to_args(Engine::LlamaCpp)` and appended after the
    /// base `--model`/`--port`/`--host`. Empty by default (no extra flags).
    pub launch: crate::inference::LaunchConfig,
}

impl Default for LlamaCppStartOptions {
    fn default() -> Self {
        // Resolve the default model path from the registry so the model is
        // swappable via env without recompiling.
        let registry = crate::registry::ModelRegistry::from_env();
        let model_path = {
            let p = registry.local_chat_model.weight_path();
            if p.exists() {
                Some(p)
            } else {
                None
            }
        };
        // Auto-load the bound vision adapter for the default model too, so the
        // no-options `start()` path is vision-capable when the projector is on
        // disk (onboarding installs it for a multimodal default).
        let mmproj_path = model_path.as_deref().and_then(mmproj_for_model);
        Self {
            port: 8080,
            model_path,
            mmproj_path,
            ctx_size: 0,
            embeddings: false,
            launch: crate::inference::LaunchConfig::default(),
        }
    }
}

/// Derive the multimodal-projector ("vision adapter") path bound to a GGUF model
/// by the on-disk convention (`<model>.gguf` → `<model>.mmproj.gguf`), returning
/// it only when the file is actually present. This is how llama.cpp learns which
/// adapter to load for a vision model with no separate config: the model catalog
/// stores the projector beside the weights under this exact name, so both a fresh
/// launch and a runtime active-model switch resolve it the same way.
pub fn mmproj_for_model(model_path: &std::path::Path) -> Option<PathBuf> {
    let s = model_path.to_string_lossy();
    let base = s.strip_suffix(".gguf").unwrap_or(s.as_ref());
    let candidate = PathBuf::from(format!("{base}.mmproj.gguf"));
    candidate.exists().then_some(candidate)
}

pub struct LlamaCppProcess {
    binary_path: PathBuf,
    child: Option<Child>,
}

impl LlamaCppProcess {
    pub fn new(binary_path: PathBuf) -> Self {
        Self {
            binary_path,
            child: None,
        }
    }

    /// Start the llama.cpp server using the default options (model from registry).
    pub async fn start(&mut self) -> Result<()> {
        self.start_with(LlamaCppStartOptions::default()).await
    }

    /// Start the llama.cpp server with explicit options.
    ///
    /// Passes `--model <path>` when `options.model_path` is `Some`; without a model
    /// the server still starts but every `/v1/chat/completions` request will fail.
    /// Callers that want zero-setup chat should call [`LlamaCppProcess::start`] which
    /// resolves the model from the registry automatically.
    pub async fn start_with(&mut self, options: LlamaCppStartOptions) -> Result<()> {
        let binary_path = self.binary_path.clone();
        let port_str = options.port.to_string();
        let model_path = options.model_path.clone();
        let mmproj_path = options.mmproj_path.clone();
        let ctx_size = options.ctx_size;
        let embeddings = options.embeddings;
        // Advanced launch flags (-ngl, --cpu-moe, --chat-template-file,
        // --model-draft, ...). `to_args` emits `--ctx-size` itself when
        // `launch.ctx_size` is set, so we fall back to the plain `ctx_size`
        // field only when the launch config does not pin a context size (keeps
        // the embeddings sidecar, which has no launch config, working).
        let launch_has_ctx = options.launch.ctx_size.is_some();
        let launch_args = options.launch.to_args(crate::inference::Engine::LlamaCpp);

        let child = tokio::task::spawn_blocking(move || {
            let mut cmd = std::process::Command::new(&binary_path);
            cmd.arg("--port")
                .arg(&port_str)
                .arg("--host")
                .arg("127.0.0.1");

            if let Some(model) = &model_path {
                cmd.arg("--model").arg(model);
            }

            // Vision adapter: `--mmproj` loads the multimodal projector so the
            // model accepts image inputs. Only set when an adapter is bound to
            // this model (resolved by the on-disk convention); text-only models
            // launch without it.
            if let Some(mmproj) = &mmproj_path {
                cmd.arg("--mmproj").arg(mmproj);
            }

            if !launch_has_ctx && ctx_size > 0 {
                cmd.arg("--ctx-size").arg(ctx_size.to_string());
            }

            if embeddings {
                // Enable the /v1/embeddings endpoint. `--pooling mean` matches
                // nomic-embed-text's training (mean pooling over token states).
                cmd.arg("--embeddings").arg("--pooling").arg("mean");
            }

            // Advanced inference launch flags, appended last (research flags via
            // `extra_args` ride along here too).
            for arg in &launch_args {
                cmd.arg(arg);
            }

            cmd.spawn()
        })
        .await
        .context("spawn_blocking for llama.cpp server")??;

        self.child = Some(child);
        Ok(())
    }

    pub async fn stop(&mut self) -> Result<()> {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        self.child.is_some() && self.binary_path.exists()
    }

    /// OS process id of the running llama-server child, when one is held.
    pub fn pid(&self) -> Option<u32> {
        self.child.as_ref().map(|c| c.id())
    }
}
