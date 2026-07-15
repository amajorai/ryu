use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::registry::ModelRegistry;
use crate::sidecar::adapters::acp::binary_in_path;
use crate::win_process::NoWindow;
use crate::sidecar::providers::llamacpp::LlamaCppDownloader;
use crate::sidecar::providers::outetts::OuteTtsDownloader;
use crate::sidecar::providers::whispercpp::WhisperCppDownloader;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupStatus {
    pub installed_sidecars: HashSet<String>,
    pub installation_path: PathBuf,
}

impl SetupStatus {
    pub fn new() -> Self {
        let installation_path = crate::paths::ryu_dir().join("bin");

        Self {
            installed_sidecars: HashSet::new(),
            installation_path,
        }
    }
}

/// Outcome of the `install_local_stack` routine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalStackStatus {
    /// True if llama-server binary is present and version-stamped.
    pub llamacpp_installed: bool,
    /// True if the GGUF weight file is present and checksum-verified.
    pub gguf_installed: bool,
    /// True if the nomic embedding GGUF is present. Downloaded here (like the
    /// chat model) so the `llamacpp-embed` engine can serve it for real semantic
    /// RAG; the engine never downloads it itself.
    pub embed_gguf_installed: bool,
    /// True if the bge reranker GGUF is present. Downloaded here (like the
    /// embedding model) so the `llamacpp-rerank` server can serve it for neural
    /// reranking of Spaces RAG; the server never downloads it itself. The server
    /// stays off by default (not in `startup_order`) — lazily started on first
    /// Space search — so this reflects "downloaded and ready", not "running".
    pub reranker_gguf_installed: bool,
    /// True if the whisper.cpp voice (STT) engine + its default GGML model are
    /// present. Voice is an opt-in sidecar (not in `startup_order`), so this
    /// reflects "downloaded and ready to start", not "running".
    pub whisper_installed: bool,
    /// True if the parakeet v3 ONNX speech model is present. Downloaded here by
    /// default (like the other models); the parakeet engine only serves it.
    pub parakeet_installed: bool,
    /// True if the Silero VAD ONNX model is present. Downloaded here by default so
    /// voice mode's neural endpointing works with no setup; VAD *inference* is
    /// gated behind the `voice-vad` build feature and falls back to energy VAD.
    pub vad_installed: bool,
    /// True if the OuteTTS (text-to-speech) binary + GGUF models are present.
    /// Downloaded here by default so spoken replies (e.g. the island companion's
    /// speak-aloud) work with no setup; the engine only renders, it never
    /// downloads. Opt-in to *run* (not in `startup_order`). OuteTTS is now the
    /// *fallback* TTS engine — the cross-surface default is Kokoro (below).
    pub outetts_installed: bool,
    /// True if the Kokoro 82M (default TTS) model artifacts are present. Downloaded
    /// here by default — like the Gemma chat GGUF — so the default voice works with
    /// no setup; the Python TTS sidecar's `kokoro-onnx` backend only serves them.
    pub kokoro_installed: bool,
    /// True if the stable-diffusion.cpp image engine (server binary + default
    /// diffusion model) is present. Downloaded here by default so text-to-image
    /// works with no setup on platforms with a prebuilt server (Windows x64,
    /// macOS arm64, Linux x86_64); the sidecar stays opt-in to *run* (lazily
    /// started on the first `/api/images/generate`). Heaviest bundled default
    /// (~1.76 GB model), so its failure is non-fatal and never blocks anything.
    pub sdcpp_installed: bool,
    /// Non-fatal warning messages surfaced to the UI (e.g. download failed).
    pub warnings: Vec<String>,
}

impl LocalStackStatus {
    /// Whether both the binary and the weight file are ready for chat.
    ///
    /// Chat readiness intentionally does **not** depend on `whisper_installed`:
    /// voice is a bundled extra, and a whisper download failure (e.g. on a
    /// non-Windows host with no prebuilt server) must never block chat.
    pub fn is_ready(&self) -> bool {
        self.llamacpp_installed && self.gguf_installed
    }
}

pub struct SetupManager {
    status: Arc<RwLock<SetupStatus>>,
}

impl SetupManager {
    pub fn new() -> Self {
        Self {
            status: Arc::new(RwLock::new(SetupStatus::new())),
        }
    }

    /// Check if a sidecar is installed
    pub async fn is_installed(&self, name: &str) -> bool {
        self.status.read().await.installed_sidecars.contains(name)
    }

    /// Seed the in-memory installed set from the persisted `versions.json`
    /// (the canonical on-disk record) so a Core restart knows what is already
    /// installed BEFORE `start_all` runs.
    ///
    /// Without this the installed set starts empty on every boot and is only
    /// repopulated asynchronously by the background `install_local_stack` task.
    /// `start_all` is spawned concurrently, so when it wins the race it sees the
    /// resident local engine (`llamacpp`) as not-installed and **skips it for the
    /// whole session** — the gateway then has no provider and every chat through
    /// it (e.g. the flagship `ryu` agent) hangs forever after the `start` event.
    /// Seeding from `versions.json` reproduces a clean, non-racing boot.
    ///
    /// `names` are the sidecars to consider (the startup order). Each is marked
    /// installed when `versions.json` records a version for it. `llamacpp-embed`
    /// shares the `llama-server` binary with `llamacpp`, so its presence is
    /// derived from `llamacpp` (mirroring [`Self::install_local_stack`]).
    pub async fn seed_installed_from_disk(&self, names: &[String]) {
        let store = crate::sidecar::download_manager::VersionStore::load();
        let mut status = self.status.write().await;
        for name in names {
            // Use the raw `versions` map, not `installed_version()`: engine
            // version strings like llama.cpp's `b9670` are not semver and would
            // fail to parse, but their presence as a key still means "installed".
            if store.versions.contains_key(name) {
                status.installed_sidecars.insert(name.clone());
            }
        }
        if store.versions.contains_key("llamacpp") {
            status
                .installed_sidecars
                .insert("llamacpp-embed".to_string());
        }
    }

    /// Mark a sidecar as installed after successful download
    pub async fn mark_installed(&self, name: &str) {
        self.status
            .write()
            .await
            .installed_sidecars
            .insert(name.to_string());
        tracing::info!("Sidecar '{}' marked as installed", name);
    }

    /// Remove a sidecar (uninstall)
    pub async fn uninstall(&self, name: &str) {
        self.status.write().await.installed_sidecars.remove(name);
        tracing::info!("Sidecar '{}' uninstalled", name);
    }

    /// Remove a sidecar and its data directory
    pub async fn uninstall_with_data(&self, name: &str) -> anyhow::Result<()> {
        self.status.write().await.installed_sidecars.remove(name);

        let data_dir = crate::paths::ryu_dir().join("data").join(name);
        crate::sidecar::remove_dir(&data_dir).await;

        tracing::info!("Sidecar '{}' uninstalled with data", name);
        Ok(())
    }

    /// Get list of all installed sidecars
    pub async fn list_installed(&self) -> Vec<String> {
        self.status
            .read()
            .await
            .installed_sidecars
            .iter()
            .cloned()
            .collect()
    }

    /// Get installation path
    pub async fn get_installation_path(&self) -> PathBuf {
        self.status.read().await.installation_path.clone()
    }

    /// Ensure the default ACP agent (configured via `RYU_DEFAULT_AGENT` /
    /// `registry.json` / built-in literal `"ryu"`) is installed on first Core
    /// start. Satisfies AC1 and AC3 of U041.
    ///
    /// **Idempotent**: skips the npx install when:
    /// - The agent's binary is already in PATH (mirrors VersionStore skip), OR
    /// - This process has already marked it installed via [`SetupManager`].
    ///
    /// **Non-fatal**: install failures are logged as warnings but never panic or
    /// block Core from coming up. The desktop surfaces availability via
    /// `GET /api/agents` (the `enabled: true` flag is config-derived, not
    /// gated on this install).
    ///
    /// Currently only the `"ryu"` / `"acp:pi"` defaults are supported inline
    /// (both run pi-acp via npx). Any other configured agent id is not
    /// auto-installed (it may be an OpenAI-compat agent that needs no npx
    /// install, or another npx CLI agent fetched on first use) — that is a
    /// follow-on.
    pub async fn ensure_default_agent_installed(&self) {
        let registry = crate::registry::ProviderRegistry::load();
        let agent_id = &registry.default_agent_id;

        // Both the flagship `ryu` agent and bare `acp:pi` run the pi-acp adapter
        // via npx (ryu binds pi as its engine, see `ryu_pi_acp_cmd`). Warming
        // pi-acp covers both. Any other agent id is treated as already-available
        // (e.g. OpenAI-compat servers started separately, or other npx CLI agents
        // fetched on first use). This guard is explicit rather than a silent
        // no-op to keep the logic auditable.
        if agent_id != "acp:pi" && agent_id != "ryu" {
            tracing::debug!(
                agent_id = %agent_id,
                "ensure_default_agent_installed: no auto-install path for this agent id; skipping"
            );
            return;
        }

        // The flagship `ryu` agent runs Core's OWN managed Pi engine — a
        // customized base, separate from the user's PATH pi (the `acp:pi`
        // agent). Warming pi-acp below only fetches the ACP *adapter*; the
        // engine itself (`@earendil-works/pi-coding-agent`) must be installed
        // into the private prefix `ryu_pi_acp_cmd` resolves. Without this, Ryu
        // always falls back to bare `pi` on PATH → ENOENT when none is present.
        if agent_id == "ryu" {
            self.ensure_ryu_managed_pi().await;
        }

        // AC3 idempotency guard 1: process-level cache (fast path).
        if self.is_installed("pi-acp").await {
            tracing::debug!(
                "ensure_default_agent_installed: pi-acp already marked installed; skipping"
            );
            return;
        }

        // AC3 idempotency guard 2: binary already in PATH (survives restarts).
        if binary_in_path("pi") {
            tracing::info!(
                "ensure_default_agent_installed: pi binary already in PATH; marking installed"
            );
            self.mark_installed("pi-acp").await;
            return;
        }

        tracing::info!(
            "ensure_default_agent_installed: triggering npx-based auto-install of pi-acp"
        );

        // Build the platform-specific install command.
        // We use `npx -y pi-acp --version` (a cheap side-effect-free call) to
        // let npx download + cache pi-acp in its cache dir. The real spawn_cmd
        // used by the ACP adapter (`pi_acp_cmd()`) is what runs on chat — we
        // only need npx to fetch the package here.
        #[cfg(target_os = "windows")]
        let (prog, args): (&str, Vec<&str>) =
            ("cmd", vec!["/c", "npx", "-y", "pi-acp", "--version"]);
        #[cfg(not(target_os = "windows"))]
        let (prog, args): (&str, Vec<&str>) = ("npx", vec!["-y", "pi-acp", "--version"]);

        let result = tokio::process::Command::new(prog)
            .args(&args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .no_window()
            .status()
            .await;

        match result {
            Ok(status) if status.success() => {
                self.mark_installed("pi-acp").await;
                tracing::info!("ensure_default_agent_installed: pi-acp installed successfully");
            }
            Ok(status) => {
                tracing::warn!(
                    exit_code = ?status.code(),
                    "ensure_default_agent_installed: pi-acp install exited with non-zero status; \
                     chat with acp:pi will require manual install"
                );
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "ensure_default_agent_installed: pi-acp install failed (npx not in PATH?); \
                     chat with acp:pi will require manual install"
                );
            }
        }
    }

    /// Install Ryu's own managed Pi engine (`@earendil-works/pi-coding-agent`)
    /// into the private prefix [`acp::managed_pi_dir`], so the flagship `ryu`
    /// agent has a self-contained Pi base independent of the user's PATH pi.
    ///
    /// **Idempotent**: skips when the bin shim already exists. **Non-fatal**:
    /// install failures warn and never block startup — the route falls back to
    /// the user's pi (then the plain-LLM default) until the install succeeds.
    ///
    /// Installs with `bun add` (the repo's standard package manager) into a
    /// dedicated prefix. We point `PI_ACP_PI_COMMAND` at the in-place shim under
    /// `node_modules/.bin/` (see [`acp::managed_pi_binary`]) rather than copying
    /// it, because bun/npm bin shims are not relocatable.
    async fn ensure_ryu_managed_pi(&self) {
        use crate::sidecar::adapters::acp;
        let pi_bin = acp::managed_pi_binary();
        if pi_bin.exists() {
            tracing::debug!("ensure_ryu_managed_pi: managed Pi already installed; skipping");
            return;
        }
        let pi_dir = acp::managed_pi_dir();
        if let Err(e) = std::fs::create_dir_all(&pi_dir) {
            tracing::warn!(error = %e, "ensure_ryu_managed_pi: could not create managed Pi dir");
            return;
        }

        tracing::info!(
            dir = %pi_dir.display(),
            "ensure_ryu_managed_pi: installing @earendil-works/pi-coding-agent via bun"
        );

        // On Windows `bun` is `bun.exe`; wrap in `cmd /c` so PATH resolution and
        // the `.exe` extension are handled by the shell, mirroring the npx warm
        // above. POSIX invokes `bun` directly.
        #[cfg(target_os = "windows")]
        let (prog, args): (&str, Vec<&str>) = (
            "cmd",
            vec!["/c", "bun", "add", "@earendil-works/pi-coding-agent"],
        );
        #[cfg(not(target_os = "windows"))]
        let (prog, args): (&str, Vec<&str>) =
            ("bun", vec!["add", "@earendil-works/pi-coding-agent"]);

        let result = tokio::process::Command::new(prog)
            .args(&args)
            .current_dir(&pi_dir)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .no_window()
            .status()
            .await;

        // bun produces a `pi.exe` shim, but pi-acp can only spawn a `.cmd`/`.bat`
        // reliably on Windows (it uses `shell:true` for those; a bare `.exe` is
        // spawned `shell:false` and fails to launch the bun trampoline in Core's
        // process context). So synthesize a tiny `.cmd` wrapper next to the bun
        // shim that forwards to it — this is the path `managed_pi_binary` resolves.
        #[cfg(target_os = "windows")]
        if matches!(&result, Ok(s) if s.success()) {
            let bin_dir = pi_dir.join("node_modules").join(".bin");
            if bin_dir.join("pi.exe").exists() {
                // `%~dp0` is the wrapper's own directory, so it resolves the
                // sibling bun shim no matter where pi-acp invokes the wrapper.
                if let Err(e) = std::fs::write(bin_dir.join("pi.cmd"), "@\"%~dp0pi.exe\" %*\r\n") {
                    tracing::warn!(error = %e, "ensure_ryu_managed_pi: could not write pi.cmd wrapper");
                }
            }
        }

        match result {
            Ok(status) if status.success() && pi_bin.exists() => {
                tracing::info!("ensure_ryu_managed_pi: managed Pi engine installed");
            }
            Ok(status) => {
                tracing::warn!(
                    exit_code = ?status.code(),
                    shim_present = pi_bin.exists(),
                    "ensure_ryu_managed_pi: bun add did not produce the Pi shim; \
                     Ryu will fall back to the user's pi until installed"
                );
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "ensure_ryu_managed_pi: bun add failed (bun not on PATH?); \
                     Ryu will fall back to the user's pi"
                );
            }
        }
    }

    /// Install the bundled local inference stack during onboarding.
    ///
    /// This is the zero-setup routine: it downloads llama-server and the default
    /// Gemma GGUF weight so a fresh install can chat immediately with no API key.
    ///
    /// **Non-fatal by design.** Download or checksum failures produce warnings that
    /// onboarding surfaces to the user, but never abort the overall onboarding flow.
    /// Chat falls back per U4 (the plain-LLM / env-configured route) when the local
    /// stack is unavailable.
    ///
    /// Both steps read their URLs and checksums from [`ModelRegistry::from_env`] so
    /// the bundled model is swappable without recompiling.
    pub async fn install_local_stack(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> LocalStackStatus {
        let registry = ModelRegistry::from_env();
        let mut warnings = Vec::<String>::new();

        // Step 1 — llama-server binary.
        let llamacpp_installed = match LlamaCppDownloader::new().ensure_installed(downloads).await {
            Ok(()) => {
                self.mark_installed("llamacpp").await;
                // The embeddings sidecar shares this same `llama-server` binary,
                // so installing it here makes `llamacpp-embed` eligible to
                // auto-start (`start_all` skips sidecars not marked installed).
                // It downloads its own nomic GGUF on first start.
                self.mark_installed("llamacpp-embed").await;
                tracing::info!("onboarding: llama.cpp binary installed");
                true
            }
            Err(e) => {
                let msg = format!("llama.cpp install failed (chat will fall back): {e:#}");
                tracing::warn!("{}", msg);
                warnings.push(msg);
                false
            }
        };

        // Step 2 — GGUF weight file. Only attempted if binary installed.
        // If the binary failed, downloading the model is pointless — skip and warn.
        let gguf_installed = if llamacpp_installed {
            let model_id = registry.local_chat_model.id.clone();
            match downloads
                .download_blocking(crate::model_catalog::gguf_download_spec(
                    &registry.local_chat_model,
                    &format!("{model_id} (chat model)"),
                ))
                .await
            {
                Ok(path) => {
                    self.mark_installed(&format!("gguf:{model_id}")).await;
                    // Auto-install the matching vision adapter for the default
                    // model, bound to its stem, so a multimodal default (e.g.
                    // Gemma) accepts images out of the box. Best-effort: a failure
                    // (or a text-only default) leaves the model chatting as text.
                    let mmproj = {
                        let endpoint = crate::model_catalog::HfEndpoint::huggingface();
                        let client = reqwest::Client::new();
                        match crate::model_catalog::repo_from_hf_url(
                            &registry.local_chat_model.weight_url,
                        ) {
                            Some(repo) => match crate::model_catalog::install_companion_mmproj(
                                &client, &endpoint, &repo, &model_id, downloads,
                            )
                            .await
                            {
                                Ok(Some(name)) => {
                                    tracing::info!(
                                        "onboarding: vision adapter {name} installed for {model_id}"
                                    );
                                    Some(name)
                                }
                                Ok(None) => None,
                                Err(e) => {
                                    tracing::warn!(
                                        "onboarding: vision adapter install failed for {model_id} \
                                         (chat works as text-only): {e:#}"
                                    );
                                    None
                                }
                            },
                            None => None,
                        }
                    };
                    // Record catalog provenance so the model-catalog "Installed"
                    // view resolves this default to its real Hugging Face repo,
                    // name, and quantization (not an origin-less `local:` card).
                    if let Err(e) = crate::model_catalog::record_default_download(
                        &model_id,
                        &registry.local_chat_model.weight_url,
                        None,
                        mmproj,
                    ) {
                        tracing::warn!("recording chat model provenance failed: {e:#}");
                    }
                    tracing::info!(
                        "onboarding: GGUF {} installed at {}",
                        model_id,
                        path.display()
                    );
                    true
                }
                Err(e) => {
                    let msg = format!(
                        "GGUF model {model_id} download failed (chat will fall back): {e:#}"
                    );
                    tracing::warn!("{}", msg);
                    warnings.push(msg);
                    false
                }
            }
        } else {
            warnings.push(
                "GGUF download skipped because llama.cpp binary was not installed".to_owned(),
            );
            false
        };

        // Step 3 — nomic embedding GGUF (downloaded here, like the chat model).
        //
        // Onboarding is the *single owner* of every default model download — the
        // same pattern as the Gemma chat model above. The `llamacpp-embed` engine
        // only *serves* this file (it never downloads), so there is no concurrent
        // double-download race against its auto-start. Non-fatal: a failure
        // degrades RAG to the local hashing embedder and never blocks chat.
        let embed_gguf_installed = if llamacpp_installed {
            let id = registry.local_embed_model.id.clone();
            match downloads
                .download_blocking(crate::model_catalog::gguf_download_spec(
                    &registry.local_embed_model,
                    &format!("{id} (embedding model)"),
                ))
                .await
            {
                Ok(path) => {
                    self.mark_installed(&format!("gguf:{id}")).await;
                    // Record catalog provenance so the embedding default resolves
                    // to its real Hugging Face repo in the installed-only view.
                    if let Err(e) = crate::model_catalog::record_default_download(
                        &id,
                        &registry.local_embed_model.weight_url,
                        None,
                        None,
                    ) {
                        tracing::warn!("recording embed model provenance failed: {e:#}");
                    }
                    tracing::info!(
                        "onboarding: embedding GGUF {} installed at {}",
                        id,
                        path.display()
                    );
                    true
                }
                Err(e) => {
                    let msg = format!(
                        "embedding GGUF {id} download failed (RAG will use local hashing): {e:#}"
                    );
                    tracing::warn!("{}", msg);
                    warnings.push(msg);
                    false
                }
            }
        } else {
            warnings.push(
                "embedding GGUF download skipped because llama.cpp binary was not installed"
                    .to_owned(),
            );
            false
        };

        // Step 3.5 — bge reranker GGUF (downloaded here, like the embedding model).
        //
        // Auto-downloaded so Spaces RAG can neural-rerank with zero setup. The
        // `llamacpp-rerank` server only *serves* this file (it never downloads),
        // and stays off by default (not in `startup_order`) — the Spaces search
        // path lazily starts it on first use. Non-fatal: a failure degrades Spaces
        // reranking to the vector order (fail-open) and never blocks chat or RAG.
        let reranker_gguf_installed = if llamacpp_installed {
            let id = registry.local_reranker_model.id.clone();
            match downloads
                .download_blocking(crate::model_catalog::gguf_download_spec(
                    &registry.local_reranker_model,
                    &format!("{id} (reranker model)"),
                ))
                .await
            {
                Ok(path) => {
                    self.mark_installed(&format!("gguf:{id}")).await;
                    if let Err(e) = crate::model_catalog::record_default_download(
                        &id,
                        &registry.local_reranker_model.weight_url,
                        None,
                        None,
                    ) {
                        tracing::warn!("recording reranker model provenance failed: {e:#}");
                    }
                    tracing::info!(
                        "onboarding: reranker GGUF {} installed at {}",
                        id,
                        path.display()
                    );
                    true
                }
                Err(e) => {
                    let msg = format!(
                        "reranker GGUF {id} download failed (Spaces RAG will skip reranking): {e:#}"
                    );
                    tracing::warn!("{}", msg);
                    warnings.push(msg);
                    false
                }
            }
        } else {
            warnings.push(
                "reranker GGUF download skipped because llama.cpp binary was not installed"
                    .to_owned(),
            );
            false
        };

        // Step 4 — whisper.cpp voice (STT) engine + default GGML model.
        //
        // Bundled-by-default extra: a fresh install can transcribe audio with no
        // setup, mirroring the zero-setup chat stack. This is independent of chat
        // readiness — a failure here (e.g. no prebuilt whisper server on
        // non-Windows) is surfaced as a warning and never blocks `is_ready`.
        // `ensure_installed` fetches both the server binary and the default
        // `ggml-base.en.bin` model in one call. The engine stays opt-in to *run*
        // (not in `startup_order`); installing it only makes it ready to start.
        let whisper_installed = match WhisperCppDownloader::new()
            .ensure_installed(downloads)
            .await
        {
            Ok(version) => {
                self.mark_installed("whispercpp").await;
                tracing::info!("onboarding: whisper.cpp voice engine {version} installed");
                true
            }
            Err(e) => {
                let msg = format!("whisper.cpp install failed (voice will be unavailable): {e:#}");
                tracing::warn!("{}", msg);
                warnings.push(msg);
                false
            }
        };

        // Step 5 — parakeet v3 ONNX speech model (downloaded here by default).
        //
        // Like whisper, the model is bundled up front so the parakeet speech
        // engine has it ready; the engine only serves it. Non-fatal — a failure
        // (e.g. offline) warns and never blocks chat. Note: parakeet *inference*
        // is gated behind the `voice-parakeet` build feature; the model download
        // is independent so the bits are in place when a feature build runs.
        let parakeet_installed =
            match crate::sidecar::providers::parakeet::ParakeetDownloader::new()
                .ensure_model(downloads)
                .await
            {
                Ok(dir) => {
                    self.mark_installed("parakeet").await;
                    tracing::info!(
                        "onboarding: parakeet speech model installed at {}",
                        dir.display()
                    );
                    true
                }
                Err(e) => {
                    let msg =
                        format!("parakeet model download failed (parakeet STT unavailable): {e:#}");
                    tracing::warn!("{}", msg);
                    warnings.push(msg);
                    false
                }
            };

        // Step 5.5 — Silero VAD ONNX model (downloaded here by default).
        //
        // Bundled up front so voice mode's noise-robust neural endpointing works
        // with zero setup. Like parakeet, VAD *inference* is gated behind the
        // `voice-vad` build feature; this model download is independent so the
        // bits are in place when a feature build runs. Tiny (~1.8 MB) and non-fatal
        // — a failure degrades voice mode to the always-compiled energy VAD.
        let vad_installed = match downloads
            .download_blocking(crate::voice::vad::silero_download_spec())
            .await
        {
            Ok(path) => {
                self.mark_installed("vad-model:silero-v4").await;
                tracing::info!(
                    "onboarding: Silero VAD model installed at {}",
                    path.display()
                );
                true
            }
            Err(e) => {
                let msg =
                    format!("Silero VAD model download failed (voice uses energy VAD): {e:#}");
                tracing::warn!("{}", msg);
                warnings.push(msg);
                false
            }
        };

        // Step 6 — OuteTTS (text-to-speech) binary + GGUF models.
        //
        // Bundled-by-default extra so a fresh install can *speak* with no setup
        // (the island companion speaks replies aloud by default). `ensure_installed`
        // fetches the `llama-tts` binary (from the llama.cpp release) plus the
        // OuteTTS + WavTokenizer GGUFs in one call. Non-fatal and independent of
        // chat readiness — a failure warns and never blocks chat. Stays opt-in to
        // *run* (not in `startup_order`); the `/api/voice/speak` data path renders
        // on demand once the bits are present.
        let outetts_installed = match OuteTtsDownloader::new().ensure_installed(downloads).await {
            Ok(_version) => {
                self.mark_installed("outetts").await;
                tracing::info!("onboarding: OuteTTS text-to-speech engine installed");
                true
            }
            Err(e) => {
                let msg = format!("OuteTTS install failed (spoken replies unavailable): {e:#}");
                tracing::warn!("{}", msg);
                warnings.push(msg);
                false
            }
        };

        // Step 7 — Kokoro 82M (the cross-surface default TTS engine) model artifacts.
        //
        // Kokoro is the default TTS engine id everywhere (`DEFAULT_TTS_ENGINE`). Its
        // ONNX weights + voice pack are downloaded here, exactly like the Gemma chat
        // GGUF (Step 2) and the OuteTTS GGUFs (Step 6), so the default voice works
        // with zero setup. The Python TTS sidecar's `kokoro-onnx` backend only
        // *serves* these files. When the sidecar runtime can be provisioned (its code
        // is installed), we also create its venv + mark `ryutts` installed so it
        // auto-starts and Kokoro is live by default. Non-fatal throughout: any failure
        // (or an un-provisioned sidecar) degrades to the OuteTTS fallback at runtime.
        let kokoro_installed =
            match crate::sidecar::providers::ryutts::kokoro::KokoroDownloader::new()
                .ensure_installed(downloads)
                .await
            {
                Ok(_) => {
                    match crate::sidecar::providers::ryutts::ensure_kokoro_runtime().await {
                        Ok(true) => {
                            self.mark_installed("ryutts").await;
                            // Persist so a restart re-seeds `ryutts` as installed and
                            // `start_all` brings the default TTS engine up automatically.
                            if let Err(e) =
                                crate::sidecar::download_manager::VersionStore::record_persisted(
                                    "ryutts",
                                    "kokoro-82m-v1.0",
                                    "installed",
                                )
                            {
                                tracing::warn!("recording ryutts install failed: {e:#}");
                            }
                            tracing::info!(
                            "onboarding: Kokoro 82M default TTS installed + sidecar provisioned"
                        );
                        }
                        Ok(false) => {
                            tracing::info!(
                            "onboarding: Kokoro 82M model downloaded; TTS sidecar code not \
                             installed yet — run `bun run dev:tts` (or install it) to serve Kokoro. \
                             OuteTTS is the runtime fallback until then."
                        );
                        }
                        Err(e) => {
                            let msg = format!(
                            "Kokoro TTS runtime provisioning failed (TTS falls back to OuteTTS): {e:#}"
                        );
                            tracing::warn!("{}", msg);
                            warnings.push(msg);
                        }
                    }
                    true
                }
                Err(e) => {
                    let msg = format!(
                        "Kokoro 82M model download failed (TTS falls back to OuteTTS): {e:#}"
                    );
                    tracing::warn!("{}", msg);
                    warnings.push(msg);
                    false
                }
            };

        // Step 8 — stable-diffusion.cpp image engine (server binary + default model).
        //
        // Bundled-by-default so text-to-image works zero-setup, mirroring the STT/
        // TTS engines. `ensure_installed` fetches the prebuilt sd-server binary for
        // the platform (Windows x64 / macOS arm64 / Linux x86_64) plus the default
        // SD v1.4 Q8_0 GGUF (~1.76 GB). Non-fatal and independent of everything
        // else — on a platform with no prebuilt server (Intel mac, arm Linux) it
        // warns and never blocks. The engine stays opt-in to *run* (not in
        // `startup_order`); the `/api/images/generate` route lazily starts it.
        let sdcpp_installed =
            match crate::sidecar::providers::sdcpp::StableDiffusionDownloader::new()
                .ensure_installed(downloads)
                .await
            {
                Ok(_version) => {
                    self.mark_installed("sdcpp").await;
                    tracing::info!("onboarding: stable-diffusion.cpp image engine installed");
                    true
                }
                Err(e) => {
                    let msg = format!("image engine (sdcpp) install skipped/failed: {e:#}");
                    tracing::warn!("{}", msg);
                    warnings.push(msg);
                    false
                }
            };

        let status = LocalStackStatus {
            llamacpp_installed,
            gguf_installed,
            embed_gguf_installed,
            reranker_gguf_installed,
            whisper_installed,
            parakeet_installed,
            vad_installed,
            outetts_installed,
            kokoro_installed,
            sdcpp_installed,
            warnings,
        };

        if status.is_ready() {
            tracing::info!(
                "onboarding: local stack ready — model={}",
                registry.local_chat_model.id
            );
        } else {
            tracing::warn!(
                "onboarding: local stack incomplete — llamacpp={} gguf={}; chat will use fallback provider",
                llamacpp_installed,
                gguf_installed,
            );
        }

        status
    }
}
