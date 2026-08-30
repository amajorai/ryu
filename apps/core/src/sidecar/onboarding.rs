use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::registry::ModelRegistry;
use crate::sidecar::adapters::acp::binary_in_path;
use crate::sidecar::providers::llamacpp::LlamaCppDownloader;
use crate::sidecar::providers::outetts::OuteTtsDownloader;
use crate::sidecar::providers::whispercpp::WhisperCppDownloader;
use crate::win_process::NoWindow;

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

/// The sidecars that SHARE `llamacpp`'s `llama-server` binary and therefore have no
/// install step of their own: installing (or re-seeding) `llamacpp` is what makes
/// each of them startable.
///
/// This list is load-bearing, not bookkeeping. `SidecarManager::start_sidecar`
/// refuses anything absent from the installed set, and three of these four are not in
/// `startup_order`, so a name missing here can only ever fail its lazy start with
/// `"'<name>' is not installed"` at `debug!` level — a feature that is silently and
/// permanently dead on every node. `llamacpp-rerank` was exactly that: neural
/// reranking of Spaces RAG could never start anywhere, because the Spaces search path
/// lazily starts it but nothing marked it installed. Both writers of the installed set
/// ([`SetupManager::install_local_stack`] on a fresh install and
/// [`SetupManager::seed_installed_from_disk`] on every restart) consume this one list
/// so the two can never drift again.
const LLAMACPP_DERIVED_SIDECARS: &[&str] = &[
    // Embeddings server — auto-starts (it IS in `startup_order`), serves the nomic
    // GGUF for real semantic RAG.
    "llamacpp-embed",
    // Reranker server — lazily started by the Spaces search path.
    "llamacpp-rerank",
    // Classify tier — lazily started by Core's gateway config-push path. Spelled
    // from the sidecar's own const, not a literal: this list is the installed-set
    // gate, so a name that drifts from `Sidecar::name()` makes every lazy start fail
    // `"'…' is not installed"` and the guardrail dies silently (both consumers fail
    // open). The const is the only spelling any of the three sites now uses.
    crate::sidecar::providers::llamacpp::classify::CLASSIFY_SIDECAR_NAME,
    // Speech Processing — lazily started by the dictation cleanup route.
    crate::sidecar::providers::llamacpp::speech::SPEECH_PROCESSING_SIDECAR_NAME,
];

/// First-party desktop tools that are part of the default local closure. They
/// use their own global-download-backed `start()` installers, so a fresh node
/// must be eligible for `start_all` even before `versions.json` has a row. A
/// failed download is still non-fatal; the next Core launch retries it.
#[cfg(not(debug_assertions))]
pub(crate) const PREINSTALLED_SIDECARS: &[&str] = &["shadow", "ghost"];

/// Development Core is owned by the local turbo/dev processes and must not fetch
/// production Ghost/Shadow archives into the developer's profile.
#[cfg(debug_assertions)]
pub(crate) const PREINSTALLED_SIDECARS: &[&str] = &[];

/// Whether [`SetupManager::seed_installed_from_disk`] may mark `name` installed
/// from a `versions.json` row.
///
/// The mesh daemon is the ONE entry whose installed-ness is not decided by
/// `versions.json`. It is in `startup_order`, so seeding it from a version row
/// would make `start_all` try to start it on EVERY boot for anyone who ever
/// installed the binaries — and `TailscaleManager::start` bails immediately when
/// the mesh is off, so the only product of that is a failed-start error in the
/// log of a user who never enabled the mesh. Before the downloader existed the
/// row could not exist and the question never arose; now first run PRE-INSTALLS
/// the client (`crate::mesh_host::MESH_PREINSTALL_PREF_KEY`), so a mesh-OFF
/// machine has a tailscale row from boot 2 onward and this skip is what keeps a
/// tailnet daemon from starting on a node nobody enabled.
///
/// `main()` marks the daemon from the authoritative signal
/// (`ryu_mesh::is_enabled()`) right after the seed call; keep that the single
/// source, and see also `POST /api/mesh/config`.
pub(crate) fn seeds_from_version_store(name: &str) -> bool {
    name != "tailscale"
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
    /// True if the 270M classifier GGUF is present. Downloaded here (like the
    /// reranker) so the `llamacpp-classify` server can serve it as the cheap
    /// classify tier; the server never downloads it. The server stays off by
    /// default (not in `startup_order`) — lazily started when a pushed gateway
    /// config selects the tier — so this reflects "downloaded and ready", not
    /// "running". Deliberately NOT part of [`LocalStackStatus::is_ready`]: a
    /// classifier download failure must never gate chat.
    pub classifier_gguf_installed: bool,
    /// True if the S1-mini Q4_K_M Speech Processing GGUF is present. It is
    /// downloaded here by default and served by the lazy `llamacpp-speech`
    /// sidecar; a failure is non-fatal and dictation falls back to raw ASR text.
    pub speech_processing_gguf_installed: bool,
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
    /// (~4.6 GB SDXL base incl. text encoders + VAE), so its failure is
    /// non-fatal and never blocks anything.
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
    /// `names` are the sidecars to consider (the startup order). Normal entries
    /// are marked installed when `versions.json` records a version for them.
    /// [`PREINSTALLED_SIDECARS`] are eligible on a fresh node as well: their
    /// `start()` path owns the first global download and records the durable
    /// version after it succeeds. The
    /// [`LLAMACPP_DERIVED_SIDECARS`] share the `llama-server` binary with `llamacpp`,
    /// so their presence is derived from `llamacpp` (mirroring
    /// [`Self::install_local_stack`]) — three of the four are not in `names` at all
    /// (never in `startup_order`, so they must not auto-start), so without the
    /// derivation a Core restart would leave their lazy starts permanently
    /// "not installed".
    pub async fn seed_installed_from_disk(&self, names: &[String]) {
        let store = crate::sidecar::download_manager::VersionStore::load();
        let mut status = self.status.write().await;
        for name in names {
            if PREINSTALLED_SIDECARS.contains(&name.as_str()) {
                status.installed_sidecars.insert(name.clone());
                continue;
            }
            // The mesh daemon is seeded from the mesh pref, never from a version
            // row — see [`seeds_from_version_store`].
            if !seeds_from_version_store(name) {
                continue;
            }
            // Use the raw `versions` map, not `installed_version()`: engine
            // version strings like llama.cpp's `b9670` are not semver and would
            // fail to parse, but their presence as a key still means "installed".
            if store.versions.contains_key(name) {
                status.installed_sidecars.insert(name.clone());
            }
        }
        if store.versions.contains_key("llamacpp") {
            for derived in LLAMACPP_DERIVED_SIDECARS {
                status.installed_sidecars.insert((*derived).to_string());
            }
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
    /// the bundled model is swappable without recompiling —
    /// `RYU_LOCAL_{CHAT,EMBED,RERANKER,CLASSIFIER,SPEECH}_MODEL_{ID,URL,SHA256}`, env-only.
    ///
    /// `from_env` is the right constructor here precisely *because* those triples
    /// have no `registry.json` key: this function is the moment that writes
    /// `~/.ryu/models/<id>.gguf`, and a llama.cpp sidecar reads the same id back at
    /// serve time arbitrarily later. A per-call file read would let an operator edit
    /// the id between those two moments, leaving the sidecar hunting a weight nobody
    /// downloaded and blaming this function in the error. See
    /// `registry::LocalModelEntry`.
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
                // Every sidecar that shares this same `llama-server` binary becomes
                // startable with it. `llamacpp-embed` is in `startup_order`, so this
                // makes it eligible to auto-start (`start_all` skips sidecars not
                // marked installed); `llamacpp-rerank` and `llamacpp-classify` are
                // not, so this never auto-starts them — but `start_sidecar` refuses
                // anything absent from the installed set, so without the mark their
                // lazy starts (Spaces search / the gateway config push) could only
                // ever fail "not installed". Each downloads no binary of its own; the
                // GGUFs they serve come from the steps below.
                for derived in LLAMACPP_DERIVED_SIDECARS {
                    self.mark_installed(derived).await;
                }
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

        // ── Steps 2–9 register together ───────────────────────────────────────
        //
        // Everything below depends only on step 1 (the llama.cpp binary, for the
        // GGUF steps) and on nothing else here, so the steps are *registered*
        // concurrently rather than awaited one after another.
        //
        // This is not "download everything at once": the DownloadCenter's
        // concurrency gate still decides how many actually stream, and the rest sit
        // in `Queued`. Registering them together is what gives the gate something
        // to schedule — and what makes the queue visible. Awaiting each step in
        // turn (as this did) meant the gate never saw more than one candidate, so
        // a first run downloaded the chat model, then the embedder, then the
        // reranker, then the classifier, strictly in file order, with no way for
        // the user to see what was still coming.
        //
        // `tokio::join!` polls in argument order, and the gate hands out permits
        // first-come-first-served, so the chat model — the one thing that unblocks
        // actually using the app — still claims the first slot.
        let chat_step = async {
            let mut warnings = Vec::<String>::new();
            // Step 2 — GGUF weight file. Only attempted if binary installed.
            // If the binary failed, downloading the model is pointless — skip and warn.
            let gguf_installed = if llamacpp_installed {
                let model_id = registry.local_chat_model.id.clone();
                match downloads
                    .resume_and_download_blocking(crate::model_catalog::gguf_download_spec(
                        &registry.local_chat_model.id,
                        &registry.local_chat_model.weight_url,
                        &registry.local_chat_model.sha256,
                        &format!("{model_id} (chat model)"),
                        crate::downloads::DownloadRole::ChatModel,
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
            (gguf_installed, warnings)
        };

        let embed_step = async {
            let mut warnings = Vec::<String>::new();
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
                        &registry.local_embed_model.id,
                        &registry.local_embed_model.weight_url,
                        &registry.local_embed_model.sha256,
                        &format!("{id} (embedding model)"),
                        crate::downloads::DownloadRole::EmbeddingModel,
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
            (embed_gguf_installed, warnings)
        };

        let reranker_step = async {
            let mut warnings = Vec::<String>::new();
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
                        &registry.local_reranker_model.id,
                        &registry.local_reranker_model.weight_url,
                        &registry.local_reranker_model.sha256,
                        &format!("{id} (reranker model)"),
                        crate::downloads::DownloadRole::RerankerModel,
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
            (reranker_gguf_installed, warnings)
        };

        let classifier_step = async {
            let mut warnings = Vec::<String>::new();
            // Step 3.6 — 270M classifier GGUF (downloaded here, like the reranker).
            //
            // Same posture as every other bundled default: unconditional, sequential,
            // non-fatal. `install_local_stack` runs on a background task, so nothing
            // here blocks Core's HTTP API or the desktop; and at ~241 MB this step adds
            // roughly half of what the reranker (~438 MB) directly before it already
            // costs, after every chat-critical download has completed. The
            // `llamacpp-classify` server only *serves* this file (it never downloads),
            // and stays off by default — Core's gateway config-push path lazily starts
            // it when a pushed config selects the classify tier.
            //
            // Non-fatal, but be precise about WHAT degrades — the earlier claim that a
            // failure leaves the inspector "resolving to the gateway's default model,
            // which is the behaviour that existed before this tier" is no longer true.
            // The gateway now defaults `inspector.model` to the classify id
            // (`de_inspector_model`) and routes that id to the `classify` provider, so
            // without this file the guardrail's model has nowhere to run: the sidecar
            // cannot start, the provider call is refused, and the inspector /
            // smart-routing classifier / LLM-judge evaluators FAIL OPEN — traffic is
            // allowed unscanned. Degraded, never broken, and never blocking chat, but the
            // degradation is "no guardrail verdict", not "a different model".
            let classifier_gguf_installed = if llamacpp_installed {
                let id = registry.local_classifier_model.id.clone();
                match downloads
                    .download_blocking(crate::model_catalog::gguf_download_spec(
                        &registry.local_classifier_model.id,
                        &registry.local_classifier_model.weight_url,
                        &registry.local_classifier_model.sha256,
                        &format!("{id} (classifier model)"),
                        crate::downloads::DownloadRole::ClassifierModel,
                    ))
                    .await
                {
                    Ok(path) => {
                        self.mark_installed(&format!("gguf:{id}")).await;
                        if let Err(e) = crate::model_catalog::record_default_download(
                            &id,
                            &registry.local_classifier_model.weight_url,
                            None,
                            None,
                        ) {
                            tracing::warn!("recording classifier model provenance failed: {e:#}");
                        }
                        tracing::info!(
                            "onboarding: classifier GGUF {} installed at {}",
                            id,
                            path.display()
                        );
                        true
                    }
                    Err(e) => {
                        // Surfaced to the user in `warnings`, so it has to say what
                        // actually happens: the guardrail does not run at all (it fails
                        // OPEN and traffic is allowed), rather than running on some other
                        // model. `inspector.model` IS this id and routes to the `classify`
                        // provider the missing weights would have served.
                        let msg = format!(
                            "classifier GGUF {id} download failed — the firewall inspector, \
                         smart-routing classifier and LLM-judge evaluators cannot run and \
                         will fail open (traffic allowed unscanned) until it is \
                         downloaded: {e:#}"
                        );
                        tracing::warn!("{}", msg);
                        warnings.push(msg);
                        false
                    }
                }
            } else {
                warnings.push(
                    "classifier GGUF download skipped because llama.cpp binary was not installed"
                        .to_owned(),
                );
                false
            };
            (classifier_gguf_installed, warnings)
        };

        let speech_processing_step = async {
            let mut warnings = Vec::<String>::new();
            // Step 3.7 — S1-mini Speech Processing GGUF.
            //
            // S1-mini is the post-ASR cleanup stage, not a second chat model. It
            // is downloaded alongside the other default local weights, while
            // its dedicated llama.cpp server remains lazy so a user who turns
            // cleanup off does not pay its resident memory cost.
            let speech_processing_gguf_installed = if llamacpp_installed {
                let id = registry.local_speech_model.id.clone();
                match downloads
                    .resume_and_download_blocking(crate::model_catalog::gguf_download_spec(
                        &registry.local_speech_model.id,
                        &registry.local_speech_model.weight_url,
                        &registry.local_speech_model.sha256,
                        &format!("{id} (Speech Processing model)"),
                        crate::downloads::DownloadRole::SpeechModel,
                    ))
                    .await
                {
                    Ok(path) => {
                        self.mark_installed(&format!("gguf:{id}")).await;
                        if let Err(e) = crate::model_catalog::record_default_download(
                            &id,
                            &registry.local_speech_model.weight_url,
                            None,
                            None,
                        ) {
                            tracing::warn!(
                                "recording Speech Processing model provenance failed: {e:#}"
                            );
                        }
                        tracing::info!(
                            "onboarding: Speech Processing GGUF {} installed at {}",
                            id,
                            path.display()
                        );
                        true
                    }
                    Err(e) => {
                        let msg = format!(
                            "Speech Processing GGUF {id} download failed (dictation will use raw ASR text): {e:#}"
                        );
                        tracing::warn!("{msg}");
                        warnings.push(msg);
                        false
                    }
                }
            } else {
                warnings.push(
                    "Speech Processing GGUF download skipped because llama.cpp binary was not installed"
                        .to_owned(),
                );
                false
            };
            (speech_processing_gguf_installed, warnings)
        };

        let whisper_step = async {
            let mut warnings = Vec::<String>::new();
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
                    let msg =
                        format!("whisper.cpp install failed (voice will be unavailable): {e:#}");
                    tracing::warn!("{}", msg);
                    warnings.push(msg);
                    false
                }
            };
            (whisper_installed, warnings)
        };

        let parakeet_step = async {
            let mut warnings = Vec::<String>::new();
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
                        // Persist under the SIDECAR name, not just the model's own
                        // `parakeet-model:v3-int8` store key. `seed_installed_from_disk`
                        // looks up `versions.json` by sidecar name, so without this row
                        // the in-memory `mark_installed` above died at process exit and
                        // `start_all` skipped parakeet as "not installed" on every
                        // subsequent boot — the engine then never loaded, and the Voice
                        // settings row reported "Not running" forever. Same reason
                        // `ryutts` records one below.
                        if let Err(e) =
                            crate::sidecar::download_manager::VersionStore::record_persisted(
                                "parakeet",
                                crate::sidecar::providers::parakeet::MODEL_DIR_NAME,
                                "v3-int8",
                            )
                        {
                            tracing::warn!("recording parakeet install failed: {e:#}");
                        }
                        tracing::info!(
                            "onboarding: parakeet speech model installed at {}",
                            dir.display()
                        );
                        true
                    }
                    Err(e) => {
                        let msg = format!(
                            "parakeet model download failed (parakeet Voice Recognition unavailable): {e:#}"
                        );
                        tracing::warn!("{}", msg);
                        warnings.push(msg);
                        false
                    }
                };
            (parakeet_installed, warnings)
        };

        let vad_step = async {
            let mut warnings = Vec::<String>::new();
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
            (vad_installed, warnings)
        };

        let outetts_step = async {
            let mut warnings = Vec::<String>::new();
            // Step 6 — OuteTTS (text-to-speech) binary + GGUF models.
            //
            // Bundled-by-default extra so a fresh install can *speak* with no setup
            // (the island companion speaks replies aloud by default). `ensure_installed`
            // fetches the `llama-tts` binary (from the llama.cpp release) plus the
            // OuteTTS + WavTokenizer GGUFs in one call. Non-fatal and independent of
            // chat readiness — a failure warns and never blocks chat. Stays opt-in to
            // *run* (not in `startup_order`); the `/api/voice/speak` data path renders
            // on demand once the bits are present.
            let outetts_installed = match OuteTtsDownloader::new().ensure_installed(downloads).await
            {
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
            (outetts_installed, warnings)
        };

        let kokoro_step = async {
            let mut warnings = Vec::<String>::new();
            // Step 7 — Kokoro 82M (the cross-surface default TTS engine): runtime, then
            // model artifacts.
            //
            // Kokoro is the default TTS engine id everywhere (`DEFAULT_TTS_ENGINE`), and
            // the Python TTS sidecar's `kokoro-onnx` backend is the only thing that can
            // serve it — the ONNX weights + voice pack are inert without it. So the
            // runtime is provisioned FIRST and the ~330 MB of weights are fetched only
            // once something can actually play them.
            //
            // That ordering is the fix for a real waste: the weights used to download
            // unconditionally while `ensure_kokoro_runtime` bailed on literally every
            // install (nothing ever created `~/.ryu/tts-sidecar` — see the WHY on that
            // function). Every user paid for a model that was never once served. A node
            // with no usable Python still pays nothing now, and still speaks: the
            // built-in OuteTTS engine from Step 6 is the runtime fallback, and
            // `POST /api/voice/speak` falls back to it per-request.
            //
            // Non-fatal throughout — chat readiness never depends on any of this.
            let runtime_ready =
                match crate::sidecar::providers::ryutts::ensure_kokoro_runtime().await {
                    Ok(ready) => ready,
                    Err(e) => {
                        let msg = format!(
                            "Kokoro Audio runtime provisioning failed (Audio uses OuteTTS): {e:#}"
                        );
                        tracing::warn!("{}", msg);
                        warnings.push(msg);
                        false
                    }
                };
            let kokoro_installed = if runtime_ready {
                match crate::sidecar::providers::ryutts::kokoro::KokoroDownloader::new()
                    .ensure_installed(downloads)
                    .await
                {
                    Ok(_) => {
                        self.mark_installed("ryutts").await;
                        // Persist so a restart re-seeds `ryutts` as installed and
                        // `start_all` brings the default Audio engine up automatically.
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
                            "onboarding: Kokoro 82M default Audio installed + sidecar provisioned"
                        );
                        true
                    }
                    Err(e) => {
                        let msg = format!(
                            "Kokoro 82M model download failed (Audio falls back to OuteTTS): {e:#}"
                        );
                        tracing::warn!("{}", msg);
                        warnings.push(msg);
                        false
                    }
                }
            } else {
                tracing::info!(
                    "onboarding: Kokoro Audio sidecar not provisionable on this node — skipping the \
                 Kokoro model download. Spoken output uses the built-in OuteTTS engine."
                );
                false
            };
            (kokoro_installed, warnings)
        };

        let sdcpp_step = async {
            let mut warnings = Vec::<String>::new();
            // Step 8 — stable-diffusion.cpp image engine (server binary + default model).
            //
            // Bundled-by-default so text-to-image works zero-setup, mirroring the STT/
            // TTS engines. `ensure_installed` fetches the prebuilt sd-server binary for
            // the platform (Windows x64 / macOS arm64 / Linux x86_64) plus the default
            // SDXL base model — the Q8_0 UNet GGUF with its CLIP-L / CLIP-G text
            // encoders and VAE (~4.6 GB total). The video default (Wan2.1) is not part
            // of onboarding; it is downloaded lazily on first use. Non-fatal and
            // independent of everything else — on a platform with no prebuilt server
            // (Intel mac, arm Linux) it warns and never blocks. The engine stays opt-in
            // to *run* (not in `startup_order`); the `/api/images/generate` route
            // lazily starts it.
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
            (sdcpp_installed, warnings)
        };

        let (
            (gguf_installed, w_chat),
            (embed_gguf_installed, w_embed),
            (reranker_gguf_installed, w_rerank),
            (classifier_gguf_installed, w_classify),
            (speech_processing_gguf_installed, w_speech_processing),
            (whisper_installed, w_whisper),
            (parakeet_installed, w_parakeet),
            (vad_installed, w_vad),
            (outetts_installed, w_outetts),
            (kokoro_installed, w_kokoro),
            (sdcpp_installed, w_sdcpp),
        ) = tokio::join!(
            chat_step,
            embed_step,
            reranker_step,
            classifier_step,
            speech_processing_step,
            whisper_step,
            parakeet_step,
            vad_step,
            outetts_step,
            kokoro_step,
            sdcpp_step,
        );
        // Merged in step order, so the warning list a user reads stays stable even
        // though the steps themselves no longer finish in that order.
        for w in [
            w_chat,
            w_embed,
            w_rerank,
            w_classify,
            w_speech_processing,
            w_whisper,
            w_parakeet,
            w_vad,
            w_outetts,
            w_kokoro,
            w_sdcpp,
        ] {
            warnings.extend(w);
        }

        let status = LocalStackStatus {
            llamacpp_installed,
            gguf_installed,
            embed_gguf_installed,
            reranker_gguf_installed,
            classifier_gguf_installed,
            speech_processing_gguf_installed,
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

#[cfg(test)]
mod onboarding_tests {
    use super::*;

    // ── LocalStackStatus::is_ready ──────────────────────────────────────────

    fn blank_status() -> LocalStackStatus {
        LocalStackStatus {
            llamacpp_installed: false,
            gguf_installed: false,
            embed_gguf_installed: false,
            reranker_gguf_installed: false,
            classifier_gguf_installed: false,
            speech_processing_gguf_installed: false,
            whisper_installed: false,
            parakeet_installed: false,
            vad_installed: false,
            outetts_installed: false,
            kokoro_installed: false,
            sdcpp_installed: false,
            warnings: Vec::new(),
        }
    }

    #[test]
    fn is_ready_requires_binary_and_weights() {
        let mut s = blank_status();
        assert!(!s.is_ready(), "nothing installed → not ready");

        s.llamacpp_installed = true;
        assert!(!s.is_ready(), "binary without weights → not ready");

        s.gguf_installed = true;
        assert!(s.is_ready(), "binary + weights → ready");
    }

    #[test]
    fn is_ready_ignores_voice_and_extras() {
        // Chat readiness must NOT depend on whisper/parakeet/tts/image extras — a
        // voice download failure must never block chat.
        let mut s = blank_status();
        s.llamacpp_installed = true;
        s.gguf_installed = true;
        // Every extra stays false; readiness still holds.
        assert!(s.is_ready());

        // And a fully-loaded extras set with NO chat stack is still not ready.
        let extras = LocalStackStatus {
            whisper_installed: true,
            parakeet_installed: true,
            speech_processing_gguf_installed: true,
            vad_installed: true,
            outetts_installed: true,
            kokoro_installed: true,
            sdcpp_installed: true,
            embed_gguf_installed: true,
            reranker_gguf_installed: true,
            classifier_gguf_installed: true,
            ..blank_status()
        };
        assert!(!extras.is_ready());
    }

    #[test]
    fn local_stack_status_serde_round_trips() {
        let mut s = blank_status();
        s.llamacpp_installed = true;
        s.warnings.push("gguf failed".into());
        let json = serde_json::to_string(&s).unwrap();
        let back: LocalStackStatus = serde_json::from_str(&json).unwrap();
        assert!(back.llamacpp_installed);
        assert!(!back.gguf_installed);
        assert_eq!(back.warnings, vec!["gguf failed".to_string()]);
    }

    // ── SetupStatus ─────────────────────────────────────────────────────────

    #[test]
    fn setup_status_new_points_at_bin_dir() {
        let s = SetupStatus::new();
        assert!(s.installed_sidecars.is_empty());
        assert!(s.installation_path.ends_with("bin"));
    }

    // ── SetupManager (in-memory set — hermetic, no fs/network) ───────────────

    #[tokio::test]
    async fn mark_and_query_installed() {
        let mgr = SetupManager::new();
        assert!(!mgr.is_installed("llamacpp").await);

        mgr.mark_installed("llamacpp").await;
        assert!(mgr.is_installed("llamacpp").await);
        assert!(!mgr.is_installed("whispercpp").await);
    }

    /// `llamacpp-rerank` was absent from BOTH writers of the installed set, and
    /// `start_sidecar` refuses anything not in it — so the lazy start on the Spaces
    /// search path could only ever fail `"not installed"` at `debug!`, meaning neural
    /// reranking of Spaces RAG had never worked on any node. The list is the fix, so
    /// the list is what is pinned: a name dropped from it silently kills that
    /// sidecar's only start path.
    #[tokio::test]
    async fn llamacpp_derived_sidecars_are_all_startable_once_llamacpp_is() {
        assert!(
            LLAMACPP_DERIVED_SIDECARS.contains(&"llamacpp-rerank"),
            "rerank shares the llama-server binary and has no other install step"
        );
        assert!(LLAMACPP_DERIVED_SIDECARS.contains(&"llamacpp-embed"));
        assert!(LLAMACPP_DERIVED_SIDECARS.contains(
            &crate::sidecar::providers::llamacpp::speech::SPEECH_PROCESSING_SIDECAR_NAME
        ));
        // Asserted against the SIDECAR'S OWN CONST, and additionally against what
        // `Sidecar::name()` returns. A literal here would pass while the list and the
        // sidecar disagreed, which is precisely the `"not installed"` dead-lazy-start
        // failure this test exists to catch.
        assert!(LLAMACPP_DERIVED_SIDECARS
            .contains(&crate::sidecar::providers::llamacpp::classify::CLASSIFY_SIDECAR_NAME));
        assert!(
            LLAMACPP_DERIVED_SIDECARS.contains(&crate::sidecar::Sidecar::name(
                &crate::sidecar::providers::llamacpp::classify::LlamaCppClassifyManager::new()
            ))
        );

        // The install path's marking loop, exercised without a DownloadCenter or disk.
        let mgr = SetupManager::new();
        mgr.mark_installed("llamacpp").await;
        for derived in LLAMACPP_DERIVED_SIDECARS {
            mgr.mark_installed(derived).await;
        }
        for derived in LLAMACPP_DERIVED_SIDECARS {
            assert!(
                mgr.is_installed(derived).await,
                "{derived} must be installed once llamacpp is, or start_sidecar refuses it"
            );
        }
    }

    #[tokio::test]
    async fn mark_installed_is_idempotent() {
        let mgr = SetupManager::new();
        mgr.mark_installed("llamacpp").await;
        mgr.mark_installed("llamacpp").await;
        let installed = mgr.list_installed().await;
        assert_eq!(
            installed.iter().filter(|n| *n == "llamacpp").count(),
            1,
            "double-mark must not duplicate (set semantics)"
        );
    }

    #[tokio::test]
    async fn uninstall_removes_only_named() {
        let mgr = SetupManager::new();
        mgr.mark_installed("llamacpp").await;
        mgr.mark_installed("whispercpp").await;

        mgr.uninstall("llamacpp").await;
        assert!(!mgr.is_installed("llamacpp").await);
        assert!(mgr.is_installed("whispercpp").await);
    }

    #[tokio::test]
    async fn uninstall_absent_is_noop() {
        let mgr = SetupManager::new();
        // Removing something never installed must not panic or error.
        mgr.uninstall("ghost").await;
        assert!(mgr.list_installed().await.is_empty());
    }

    #[tokio::test]
    async fn list_installed_reflects_all_marks() {
        let mgr = SetupManager::new();
        mgr.mark_installed("a").await;
        mgr.mark_installed("b").await;
        mgr.mark_installed("c").await;
        let mut got = mgr.list_installed().await;
        got.sort();
        assert_eq!(got, vec!["a", "b", "c"]);
    }

    // The invariant the mesh pre-install rests on: first run now stages the
    // tailscale client on a mesh-OFF node, so `versions.json` has a tailscale row
    // from boot 2 onward. If the seed ever consumed that row, `start_all` would
    // spawn a tailnet daemon on machines whose owner never enabled the mesh —
    // exactly the posture change the pre-install was designed NOT to make.
    #[test]
    fn version_store_seed_skips_the_mesh_daemon() {
        assert!(
            !seeds_from_version_store("tailscale"),
            "a tailscale version row must never mark the mesh daemon installed — \
             `main()` marks it from `ryu_mesh::is_enabled()` instead"
        );
        // Everything else still seeds, or a restart loses its installed engines.
        for name in ["llamacpp", "whispercpp", "ollama", "ryutts", "parakeet"] {
            assert!(seeds_from_version_store(name), "{name} must seed from disk");
        }
    }

    // The same skip through the real seed path: no matter what this machine's
    // `versions.json` holds, seeding must not mark the daemon installed.
    #[tokio::test]
    async fn seed_installed_from_disk_never_marks_tailscale() {
        let mgr = SetupManager::new();
        mgr.seed_installed_from_disk(&["tailscale".to_string()])
            .await;
        assert!(!mgr.is_installed("tailscale").await);
    }

    #[test]
    fn shadow_and_ghost_are_the_eager_preinstall_set() {
        if cfg!(debug_assertions) {
            assert!(PREINSTALLED_SIDECARS.is_empty());
        } else {
            assert_eq!(PREINSTALLED_SIDECARS, &["shadow", "ghost"]);
        }
    }

    #[tokio::test]
    async fn seed_installed_from_disk_marks_preinstalled_tools_before_download() {
        if cfg!(debug_assertions) {
            return;
        }
        let mgr = SetupManager::new();
        mgr.seed_installed_from_disk(&["shadow".to_string(), "ghost".to_string()])
            .await;
        assert!(mgr.is_installed("shadow").await);
        assert!(mgr.is_installed("ghost").await);
    }

    #[tokio::test]
    async fn installation_path_ends_in_bin() {
        let mgr = SetupManager::new();
        let p = mgr.get_installation_path().await;
        assert!(p.ends_with("bin"));
    }
}
