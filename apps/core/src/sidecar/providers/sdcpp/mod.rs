//! stable-diffusion.cpp media engine (text-to-image, and text/image-to-video).
//!
//! Like the voice engines (whisper.cpp / parakeet), a generative-media engine is
//! **not** part of the mutually-exclusive `LOCAL_ENGINES` chat-engine swap — you
//! run sd-server *alongside* a resident chat engine. It is therefore managed as
//! an ordinary opt-in sidecar (install / start / stop) and consumed by the Core
//! `POST /api/images/generate` and `POST /api/video/generate` data paths
//! (`server::media`), which proxy requests to this server's OpenAI-compatible
//! `/v1/images/generations` and native `/sdcpp/v1/vid_gen` endpoints.
//!
//! Placement (Core vs Gateway, CLAUDE.md §1): this is **Core** — it decides *what
//! runs* (which local media engine renders the pixels). Per-attribute Gateway
//! routing of image/video slots is a separate, future enhancement.
//!
//! Lifecycle mirrors [`super::whispercpp::WhisperCppManager`]: adopt an
//! already-running server on the port rather than spawning a competing process;
//! otherwise spawn `sd-server` from `engines/image/sdcpp/` with a diffusion
//! model resolved from `RYU_SD_MODEL`, the active diffusion preference, or the
//! bundled default in `models/image/sdcpp/` — the hardware-tiered Qwen Image 2.1
//! (Standard) or SDXL base (Lite) stack, see [`downloader::select_image_tier`].
//! A model whose files would not fit this node's RAM is refused at start rather
//! than loaded into a machine it would freeze.

pub mod downloader;
pub mod frame_models;
mod model;

pub use downloader::StableDiffusionDownloader;
pub use model::{activation_refusal, active_video_inputs, local_image_unavailable_reason};
use model::{
    companion_args, launch_loaded_bytes, memory_device, model_args, resolved_model,
    unavailable_message, ModelKind,
};

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Context;

use crate::sidecar::{BoxFuture, HealthStatus, ProcessHandle, Sidecar};

/// Canonical (release) loopback port the sd-server media engine binds to.
/// Distinct from every other Core-managed engine (llama.cpp 8080-8083 incl. the
/// classify tier, mlx-vlm 8084, … audio.cpp 8091) so they coexist — enforced by
/// `providers::tests::local_engine_default_ports_are_unique_per_profile`. It
/// moved off 8083 (which the classify tier keeps) because the two clashed; the
/// port is Core-internal (no setting or saved URL persists it), so only an
/// sd-server a user launched by hand on the old port stops being adopted. The
/// readiness identity check ([`SD_SERVER_MODEL_ID`]) still refuses any foreign
/// listener. The concrete port is profile-aware — see [`sd_port`].
pub const SD_PORT_BASE: u16 = 8101;

/// Profile-aware media-engine port (release 8101, dev 9101, …). Both the spawn
/// side (`--listen-port`) and every client (`sd_base_url`) resolve the SAME port
/// through here, so a dev stack never adopts the release stack's sd-server.
pub fn sd_port() -> u16 {
    crate::profile::port(SD_PORT_BASE)
}

/// Loopback `host:port` the media engine binds to (profile-aware).
fn sd_addr() -> String {
    format!("127.0.0.1:{}", sd_port())
}

/// Base URL the media engine serves on once resident. The data paths post to
/// `{base}/v1/images/generations` (image) and `{base}/sdcpp/v1/vid_gen` (video).
pub fn sd_base_url() -> String {
    format!("http://{}", sd_addr())
}

/// The model id the pinned sd-server (`master-890-74988b2`,
/// `examples/server/routes_openai.cpp`) always lists on `GET /v1/models`,
/// whatever weights it loaded. sd-server only starts listening after the model
/// is loaded, so a `/v1/models` answer naming this id is both readiness and
/// identity — a llama.cpp server that ended up on the port lists its own GGUF
/// instead.
pub const SD_SERVER_MODEL_ID: &str = "sd-cpp-local";

/// Diffusion weights take a while to load; allow generous startup time.
const SD_READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Wait until the spawned sd-server on `port` serves `/v1/models` listing
/// [`SD_SERVER_MODEL_ID`], failing fast (with the stderr tail) if the child
/// exits first, and on a foreign listener serving some other model.
async fn wait_for_sd_server(
    client: &reqwest::Client,
    port: u16,
    process: &ProcessHandle,
    stderr: &super::readiness::StderrTail,
    timeout: std::time::Duration,
) -> anyhow::Result<()> {
    let probe = super::readiness::ReadyProbe {
        engine: "sd-server",
        port,
        health_path: None,
        expected_model: Some(SD_SERVER_MODEL_ID),
        timeout,
    };
    super::readiness::wait_until_ready(
        client,
        &probe,
        || process.is_running(),
        || stderr.snapshot(),
    )
    .await
}

/// Lifecycle manager for the stable-diffusion.cpp media sidecar.
pub struct StableDiffusionManager {
    process: ProcessHandle,
    /// `true` when an sd-server was already running before we tried to start it
    /// (adopted external). We don't own it, so `stop` leaves it alone.
    adopted_external: Arc<AtomicBool>,
    client: reqwest::Client,
    /// Global download center (#456); wired by main.rs via [`with_downloads`].
    /// The actual install runs through the engine-install route
    /// (`server::mod`), which passes its own center; this field keeps the
    /// manager uniform with the field-injection fan-out.
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl StableDiffusionManager {
    pub fn new() -> Self {
        Self {
            process: ProcessHandle::new(),
            adopted_external: Arc::new(AtomicBool::new(false)),
            client: reqwest::Client::builder()
                .user_agent("ryu-core/0.1")
                .timeout(std::time::Duration::from_secs(3))
                .build()
                .expect("reqwest client"),
            downloads: None,
        }
    }

    pub fn with_downloads(mut self, downloads: crate::downloads::DownloadCenter) -> Self {
        self.downloads = Some(downloads);
        self
    }

    fn binary_path() -> std::path::PathBuf {
        downloader::server_binary_path()
    }

    /// Returns `true` if an sd-server is already serving on its port. Only an
    /// sd-server identity (`/v1/models` listing [`SD_SERVER_MODEL_ID`]) is
    /// adopted; any other listener is refused by the busy-port check instead.
    async fn server_reachable(client: &reqwest::Client) -> bool {
        let Ok(response) = client
            .get(format!("{}/v1/models", sd_base_url()))
            .send()
            .await
        else {
            return false;
        };
        if !response.status().is_success() {
            return false;
        }
        response
            .json::<serde_json::Value>()
            .await
            .is_ok_and(|payload| {
                super::llamacpp::model_identity_matches(SD_SERVER_MODEL_ID, &payload)
            })
    }
}

impl Default for StableDiffusionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for StableDiffusionManager {
    fn name(&self) -> &'static str {
        "sdcpp"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        let client = self.client.clone();
        let downloads = self.downloads.clone();
        Box::pin(async move {
            // Our own child is already up: nothing to start. Without this guard the
            // reachability probe below would record our child as an adopted external
            // server, and the next stop() would leave it running.
            if process.is_running() {
                return Ok(());
            }
            // Adopt an already-running sd-server rather than spawning a competing
            // process that would fail to bind the port.
            if Self::server_reachable(&client).await {
                adopted_external.store(true, Ordering::Relaxed);
                tracing::info!(
                    "sd-server already running on {} — adopting existing server",
                    sd_addr()
                );
                return Ok(());
            }
            adopted_external.store(false, Ordering::Relaxed);

            let binary_path = Self::binary_path();
            if !binary_path.exists() {
                anyhow::bail!(
                    "sd-server binary not found at {}. Install the stable-diffusion.cpp \
                     media engine from the Store, or place an `sd-server` binary there.",
                    binary_path.display()
                );
            }

            let (model, kind) = resolved_model().await;

            // Resolve the launch plan before fetching anything: a Wan2.2 A14B
            // half whose sibling is missing cannot start, so its multi-GB
            // companions must not download first.
            let launch_args = model_args(kind, &model)?;

            // The video default is not bundled at onboarding (~6 GB, GPU-preferred);
            // provision it lazily the first time a video model is selected. Files
            // that already exist (e.g. the transformer GGUF installed via the model
            // catalog) are skipped individually by the downloader, which refuses
            // up front when the stack would not fit this node's RAM or disk.
            if kind == ModelKind::KnownVideo
                && (!downloader::video_model_path().exists()
                    || !downloader::video_t5xxl_path().exists()
                    || !downloader::video_vae_path().exists())
            {
                let dc = downloads.clone().ok_or_else(|| {
                    anyhow::anyhow!(
                        "default video model (Wan2.1) files missing and no download center wired"
                    )
                })?;
                downloader::StableDiffusionDownloader::new()
                    .ensure_video_default(&dc)
                    .await
                    .context("provisioning default Wan2.1 video model")?;
            }

            // A Wan image-to-video / first-last-frame transformer is the user's
            // catalog install; its umt5 / VAE / CLIP-vision companions are
            // fetched here, the first time it is the active model.
            if let ModelKind::FrameVideo(frame_model) = kind {
                let missing = frame_model.missing_companions();
                if !missing.is_empty() {
                    let dc = downloads.clone().ok_or_else(|| {
                        anyhow::anyhow!(
                            "Wan frame model companions missing and no download center wired"
                        )
                    })?;
                    downloader::StableDiffusionDownloader::new()
                        .ensure_frame_companions(&dc, &missing)
                        .await
                        .context("provisioning Wan frame model encoders")?;
                }
            }

            if !model.exists() {
                if matches!(kind, ModelKind::DefaultImage | ModelKind::LiteImage) {
                    let choice = downloader::select_image_tier(
                        &memory_device(),
                        &downloader::ImageTierInputs::from_disk(),
                    );
                    if let Some(message) = unavailable_message(&choice) {
                        anyhow::bail!("{message}");
                    }
                }
                anyhow::bail!(
                    "stable diffusion model not found at {}. Install the media engine from \
                     the Store (it bundles the image model that fits this computer), install \
                     a diffusion GGUF from the model catalog, or set RYU_SD_MODEL to a model \
                     path.",
                    model.display()
                );
            }

            let companions = companion_args(kind);
            // Never load weights that cannot fit: the bundled sd-server is a CPU
            // build, so the model and its companions all land in system RAM, and
            // overcommitting it freezes the machine. RYU_SD_MODEL is the
            // operator's explicit escape hatch and is not second-guessed.
            if kind != ModelKind::EnvOverride {
                let bytes = launch_loaded_bytes(kind, &model, &companions);
                if let Some(reason) = downloader::media_stack_block_reason(
                    "This diffusion model",
                    bytes,
                    0,
                    &memory_device(),
                ) {
                    anyhow::bail!("{reason}. Pick a smaller model or a cloud provider.");
                }
            }

            tracing::info!("sd-server starting ({})", binary_path.display());

            let mut args: Vec<String> = vec![
                "--listen-ip".into(),
                "127.0.0.1".into(),
                "--listen-port".into(),
                sd_port().to_string(),
            ];
            args.extend(launch_args);
            // Saved engine settings: catalog options, then raw args. The model,
            // companion weights and loopback binding Core chose stay
            // authoritative, so raw args cannot rebind them.
            let launch = super::engine_launch_config("sdcpp").await;
            let mut managed: Vec<String> = args
                .iter()
                .filter(|arg| arg.starts_with('-'))
                .cloned()
                .collect();
            managed.extend(["-m", "--model", "--diffusion-model"].map(str::to_owned));
            let managed: Vec<&str> = managed.iter().map(String::as_str).collect();
            args.extend(crate::inference::native_args("sdcpp", &launch.native));
            args.extend(super::strip_managed_args(&launch.extra_args, &managed));

            let program = binary_path.to_string_lossy().to_string();
            let port = sd_port();
            super::readiness::ensure_port_free("sd-server", port).await?;
            let stderr = super::readiness::StderrTail::default();
            process
                .start_path_with_args_capturing_stderr(&program, &args, "sdcpp", stderr.clone())
                .await
                .context("spawning sd-server process")?;

            if let Err(error) =
                wait_for_sd_server(&client, port, &process, &stderr, SD_READY_TIMEOUT).await
            {
                let _ = process.stop().await;
                return Err(error).context("sd-server readiness check failed");
            }

            tracing::info!("sd-server started on {}", sd_addr());
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        Box::pin(async move {
            if adopted_external.swap(false, Ordering::Relaxed) {
                tracing::info!("sd-server was an adopted external server — leaving it running");
                return Ok(());
            }
            process.stop().await.context("stopping sd-server process")?;
            tracing::info!("sd-server stopped");
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        let client = self.client.clone();
        Box::pin(async move {
            let owned_running = process.is_running();
            if !owned_running && !adopted_external.load(Ordering::Relaxed) {
                return HealthStatus::Unhealthy("sd-server process not running".into());
            }
            match client.get(sd_base_url()).send().await {
                Ok(_) => HealthStatus::Healthy,
                Err(e) => HealthStatus::Unhealthy(format!("health check failed: {e}")),
            }
        })
    }

    fn is_running(&self) -> bool {
        self.process.is_running() || self.adopted_external.load(Ordering::Relaxed)
    }

    fn pid(&self) -> Option<u32> {
        // `None` when we adopted an external sd-server we don't own.
        self.process.pid()
    }

    fn uninstall(&self, delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            crate::sidecar::remove_dir(&downloader::install_dir()).await;
            crate::sidecar::remove_from_version_store("sdcpp");

            if delete_data {
                // Only the weights this engine downloaded itself. Diffusion GGUFs
                // installed through the model catalog are removed there.
                crate::sidecar::remove_dir(&downloader::image_models_dir()).await;
                crate::sidecar::remove_dir(&downloader::video_models_dir()).await;
            }

            tracing::info!("sdcpp uninstalled");
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests;
