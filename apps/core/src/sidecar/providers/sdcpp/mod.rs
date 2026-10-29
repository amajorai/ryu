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

pub use downloader::StableDiffusionDownloader;

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

/// How the active diffusion model was chosen — decides which companion files
/// (text encoders / VAE) `sd-server` needs, if any.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ModelKind {
    /// `RYU_SD_MODEL` override — a single explicit file, no companions.
    EnvOverride,
    /// The bundled default image model (Qwen Image 2.1) — Qwen3-VL text and
    /// vision encoders plus the matching VAE.
    DefaultImage,
    /// A user-selected Qwen Image 2.1 quantization — it reuses the bundled
    /// Qwen3-VL encoders and VAE.
    KnownImage,
    /// The bundled Lite default (SDXL base single-file checkpoint), chosen when
    /// no preference is set and the Standard stack is absent or too large.
    LiteImage,
    /// An explicitly selected SDXL base checkpoint (the image default before
    /// Qwen Image 2.1, same file as [`ModelKind::LiteImage`]).
    Sdxl,
    /// The default video model (Wan2.1) — umt5-xxl / VAE, provisioned lazily.
    KnownVideo,
    /// A user-installed Wan image-to-video or first/last-frame transformer —
    /// its companions (umt5-xxl, VAE, CLIP-vision H) are provisioned lazily.
    FrameVideo(frame_models::WanFrameModel),
    /// Some other installed diffusion GGUF — single `-m`, no companions.
    Other,
}

/// This node's memory as the installed `sd-server` build uses it: system RAM for
/// the bundled CPU archive, the larger of RAM and VRAM for an operator-placed
/// GPU build (see [`downloader::memory_pool_device`]).
fn memory_device() -> crate::model_catalog::device::DeviceInfo {
    downloader::memory_pool_device(
        super::llamacpp::variant::device(),
        downloader::bundled_cpu_server_in_use(),
    )
}

/// Resolve the diffusion model and its kind in priority order:
/// 1. `RYU_SD_MODEL` environment variable (testing / manual override).
/// 2. User-selected active diffusion model from preferences
///    (`local-diffusion-model` pref key → stem → `models/image/sdcpp/<stem>.gguf`,
///    then `models/video/sdcpp/`, then a catalog install in `models/chat/`).
/// 3. The bundled default: an installed Standard stack that fits this node's
///    RAM, else an installed Lite checkpoint, else the path of the tier this
///    node would install (missing — `start` explains how to get it).
async fn resolved_model() -> (std::path::PathBuf, ModelKind) {
    if let Ok(p) = std::env::var("RYU_SD_MODEL") {
        return (std::path::PathBuf::from(p), ModelKind::EnvOverride);
    }
    if let Some(stem) = active_diffusion_model_stem().await {
        if stem == downloader::LEGACY_IMAGE_DEFAULT_STEM {
            tracing::warn!(
                "ignoring legacy incompatible SDXL preference {stem}; using the compatible default"
            );
        } else {
            if let Some(path) = downloader::resolve_stem_path(&stem) {
                let kind = if stem == downloader::VIDEO_DEFAULT_STEM {
                    ModelKind::KnownVideo
                } else if let Some(frame_model) = frame_models::WanFrameModel::from_stem(&stem) {
                    ModelKind::FrameVideo(frame_model)
                } else if downloader::is_qwen_image_stem(&stem) {
                    ModelKind::KnownImage
                } else if stem == downloader::LEGACY_SDXL_DEFAULT_STEM {
                    ModelKind::Sdxl
                } else {
                    ModelKind::Other
                };
                return (path, kind);
            }
        }
    }
    let device = &memory_device();
    let standard_fits =
        crate::model_catalog::device::fits_in_system_ram(downloader::STANDARD_STACK_BYTES, device);
    match installed_default_image(
        downloader::standard_stack_installed(),
        downloader::lite_model_installed(),
        standard_fits,
    ) {
        Some(kind) => (default_image_path(kind), kind),
        None => {
            let choice =
                downloader::select_image_tier(device, &downloader::ImageTierInputs::from_disk());
            let kind = if choice.tier == downloader::ImageTier::Lite {
                ModelKind::LiteImage
            } else {
                ModelKind::DefaultImage
            };
            (default_image_path(kind), kind)
        }
    }
}

/// Which installed bundled default to load when no preference is set: the
/// Standard stack unless RAM is known to be too small for it (an unknown keeps
/// an existing install), else the Lite checkpoint. `None` when neither usable
/// default is on disk.
fn installed_default_image(
    standard_installed: bool,
    lite_installed: bool,
    standard_fits_ram: Option<bool>,
) -> Option<ModelKind> {
    if standard_installed && standard_fits_ram != Some(false) {
        return Some(ModelKind::DefaultImage);
    }
    lite_installed.then_some(ModelKind::LiteImage)
}

fn default_image_path(kind: ModelKind) -> std::path::PathBuf {
    if kind == ModelKind::LiteImage {
        downloader::lite_model_path()
    } else {
        downloader::default_model_path()
    }
}

/// Why local text-to-image cannot work on this node at all — no `RYU_SD_MODEL`,
/// no selected or bundled model on disk, and this node's hardware fits no
/// image tier — so the image route can answer with the cloud alternative
/// instead of a generic "engine not reachable". `None` whenever a local model
/// exists or could be installed.
pub async fn local_image_unavailable_reason() -> Option<String> {
    if std::env::var_os("RYU_SD_MODEL").is_some() {
        return None;
    }
    let (model, kind) = resolved_model().await;
    if model.exists() || !matches!(kind, ModelKind::DefaultImage | ModelKind::LiteImage) {
        return None;
    }
    let choice =
        downloader::select_image_tier(&memory_device(), &downloader::ImageTierInputs::from_disk());
    unavailable_message(&choice)
}

/// The user-facing refusal for a node that fits no local image model.
fn unavailable_message(choice: &downloader::ImageTierChoice) -> Option<String> {
    (choice.tier == downloader::ImageTier::None).then(|| {
        format!(
            "No local image model fits this computer ({}). Choose a cloud image provider \
             (OpenRouter, Replicate or fal) instead.",
            choice
                .downgrade_reason
                .as_deref()
                .unwrap_or("not enough memory or disk")
        )
    })
}

/// Total bytes `sd-server` would load for `model` plus its companions, from
/// the files on disk (a missing file counts 0, so the sum never overstates).
fn loaded_bytes(model: &std::path::Path, companions: &[(String, std::path::PathBuf)]) -> u64 {
    std::iter::once(model)
        .chain(companions.iter().map(|(_, path)| path.as_path()))
        .filter_map(|path| std::fs::metadata(path).ok())
        .map(|meta| meta.len())
        .sum()
}

/// [`loaded_bytes`] for what `sd-server` is actually launched with: a Wan frame
/// model builds its own arguments (the transformer pair and its companions), so
/// its weight paths come from [`model_args`] rather than [`companion_args`].
fn launch_loaded_bytes(
    kind: ModelKind,
    model: &std::path::Path,
    companions: &[(String, std::path::PathBuf)],
) -> u64 {
    if matches!(kind, ModelKind::FrameVideo(_)) {
        if let Ok(args) = model_args(kind, model) {
            return args
                .iter()
                .filter(|arg| !arg.starts_with('-'))
                .filter_map(|path| std::fs::metadata(path).ok())
                .map(|meta| meta.len())
                .sum();
        }
    }
    loaded_bytes(model, companions)
}

/// What the active local diffusion model accepts as video reference input.
///
/// Derived from the same resolution [`resolved_model`] uses to launch
/// `sd-server`, so a preferred model that is not installed classifies as the
/// default the engine actually runs, never as the missing preference.
pub async fn active_video_inputs() -> ryu_image::video::LocalVideoInputs {
    let (path, kind) = resolved_model().await;
    video_inputs_for(kind, &path)
}

/// Frame support for a resolved model. Only a recognized Wan frame model that
/// the sidecar launches with its companions qualifies: an `RYU_SD_MODEL`
/// override or an unrecognized preference loads with `-m` alone, so frames are
/// refused for them instead of being sent to a model that cannot use them. An
/// A14B transformer whose other half is not installed cannot launch, so it
/// reports no frame support either.
fn video_inputs_for(
    kind: ModelKind,
    model: &std::path::Path,
) -> ryu_image::video::LocalVideoInputs {
    match kind {
        ModelKind::FrameVideo(frame_model) if frame_model.transformers_installed(model) => {
            frame_model.inputs()
        }
        _ => ryu_image::video::LocalVideoInputs::default(),
    }
}

/// Why an installed diffusion model cannot become the active sd-server model,
/// or `None` when it can. A Wan2.2 A14B transformer whose other half is not
/// installed would leave the media engine (image generation included) unable
/// to start, so the model switch refuses it up front.
pub fn activation_refusal(stem: &str) -> Option<String> {
    frame_models::WanFrameModel::from_stem(stem)?;
    launch_refusal(
        stem,
        &crate::model_catalog::installed::model_file_path(stem),
    )
}

/// [`activation_refusal`] for a model stored at `model`.
fn launch_refusal(stem: &str, model: &std::path::Path) -> Option<String> {
    let frame_model = frame_models::WanFrameModel::from_stem(stem)?;
    frame_model.launch_args(model).err()
}

/// Read the user's active diffusion model preference (a local GGUF stem). Returns
/// `None` when no preference is set or the preferences store cannot be opened.
async fn active_diffusion_model_stem() -> Option<String> {
    let prefs = crate::server::preferences::PreferencesStore::open_default().ok()?;
    let raw = prefs
        .get(crate::model_catalog::installed::ACTIVE_DIFFUSION_MODEL_PREF)
        .await
        .ok()??;
    let stem = raw.trim();
    if stem.is_empty() {
        return None;
    }
    Some(stem.to_string())
}

/// Extra `sd-server` flags to load a multi-file diffusion model. Qwen Image 2.1
/// and Wan ship as a diffusion model plus separate text encoders and a VAE, so
/// the spawn must pass them explicitly; a single-file GGUF needs only `-m`.
/// The SDXL base checkpoint embeds its encoders, so its CLIP files are passed
/// only when an older install left them on disk.
fn companion_args(kind: ModelKind) -> Vec<(String, std::path::PathBuf)> {
    match kind {
        ModelKind::DefaultImage | ModelKind::KnownImage => vec![
            ("--llm".to_string(), downloader::image_llm_path()),
            (
                "--llm_vision".to_string(),
                downloader::image_llm_vision_path(),
            ),
            ("--vae".to_string(), downloader::image_vae_path()),
        ],
        ModelKind::LiteImage | ModelKind::Sdxl => sdxl_companions(
            downloader::legacy_sdxl_clip_l_path(),
            downloader::legacy_sdxl_clip_g_path(),
        ),
        ModelKind::KnownVideo => vec![
            ("--t5xxl".to_string(), downloader::video_t5xxl_path()),
            ("--vae".to_string(), downloader::video_vae_path()),
        ],
        // Frame models build their own arguments (`--diffusion-model`, pair
        // and companions) through `frame_models::WanFrameModel::launch_args`.
        ModelKind::FrameVideo(_) | ModelKind::EnvOverride | ModelKind::Other => Vec::new(),
    }
}

/// The optional SDXL `--clip_l` / `--clip_g` companions that exist on disk.
fn sdxl_companions(
    clip_l: std::path::PathBuf,
    clip_g: std::path::PathBuf,
) -> Vec<(String, std::path::PathBuf)> {
    [("--clip_l", clip_l), ("--clip_g", clip_g)]
        .into_iter()
        .filter(|(_, path)| path.exists())
        .map(|(flag, path)| (flag.to_string(), path))
        .collect()
}

/// The `sd-server` flag that loads the diffusion weights. Qwen Image 2.1 and
/// Wan ship *split* diffusion GGUFs (transformer only, unprefixed tensor names);
/// the pinned stable-diffusion.cpp (`master-890-74988b2`) loads those only via
/// `--diffusion-model`, which prefixes `model.diffusion_model.` at load time,
/// while `-m` expects a full checkpoint (`src/pipeline/diffusion_engine.cpp`
/// `init_model_loader`; upstream `docs/qwen_image.md` and `docs/wan.md`). A
/// single-file checkpoint (SDXL base, env override, other GGUFs) keeps `-m`.
fn model_flag(kind: ModelKind) -> &'static str {
    match kind {
        ModelKind::DefaultImage
        | ModelKind::KnownImage
        | ModelKind::KnownVideo
        | ModelKind::FrameVideo(_) => "--diffusion-model",
        ModelKind::EnvOverride | ModelKind::LiteImage | ModelKind::Sdxl | ModelKind::Other => "-m",
    }
}

/// The model-loading `sd-server` arguments for a resolved model: the weights
/// under [`model_flag`] plus their companions, or a Wan frame model's own
/// launch plan (transformer pair, companions, CPU offload).
fn model_args(kind: ModelKind, model: &std::path::Path) -> anyhow::Result<Vec<String>> {
    if let ModelKind::FrameVideo(frame_model) = kind {
        return frame_model.launch_args(model).map_err(anyhow::Error::msg);
    }
    let mut args = vec![
        model_flag(kind).to_owned(),
        model.to_string_lossy().into_owned(),
    ];
    for (flag, path) in companion_args(kind) {
        args.push(flag);
        args.push(path.to_string_lossy().into_owned());
    }
    Ok(args)
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
mod tests {
    use super::*;

    /// Image and video generation call `start()` on every request. With our own
    /// child already serving, that repeat start must not brand it an adopted
    /// external server, or the next stop() (a diffusion-model switch, uninstall)
    /// would leave the old child running.
    #[cfg(unix)]
    #[tokio::test]
    async fn repeat_start_with_our_child_running_keeps_ownership() {
        let manager = StableDiffusionManager::new();
        manager
            .process
            .start_path_with_args("sleep", &["30".to_owned()])
            .await
            .expect("spawn stand-in child");

        manager.start().await.expect("repeat start is a no-op");
        assert!(!manager.adopted_external.load(Ordering::Relaxed));

        manager.stop().await.expect("stop our child");
        assert!(!manager.process.is_running());
    }

    /// The media engine's port is pinned (release 8101, dev 9101) and no longer
    /// shares the classify tier's 8083.
    #[test]
    fn sd_port_base_is_pinned_and_distinct_from_classify() {
        assert_eq!(SD_PORT_BASE, 8101);
        assert_eq!(crate::profile::port_for(SD_PORT_BASE, "dev"), 9101);
        assert_ne!(
            SD_PORT_BASE,
            super::super::llamacpp::classify::CLASSIFY_PORT_BASE
        );
    }

    #[test]
    fn qwen_image_defaults_load_text_vision_and_vae_companions() {
        let args = companion_args(ModelKind::DefaultImage);
        let flags: Vec<&str> = args.iter().map(|(flag, _)| flag.as_str()).collect();
        assert_eq!(flags, ["--llm", "--llm_vision", "--vae"]);
        assert!(args[0].1.ends_with("Qwen3VL-8B-Instruct-Q4_K_M.gguf"));
        assert!(args[1].1.ends_with("mmproj-Qwen3VL-8B-Instruct-F16.gguf"));
        assert!(args[2].1.ends_with("qwen_image_2.1_vae_bf16.safetensors"));
    }

    /// The Lite checkpoint embeds both encoders, so it launches with `-m` alone;
    /// an older SDXL install that left its CLIP files keeps passing them.
    #[test]
    fn sdxl_clip_companions_are_passed_only_when_present() {
        let dir = tempfile::tempdir().unwrap();
        let clip_l = dir.path().join("sdxl_clip_l.safetensors");
        let clip_g = dir.path().join("sdxl_clip_g.safetensors");

        assert!(sdxl_companions(clip_l.clone(), clip_g.clone()).is_empty());

        std::fs::write(&clip_g, b"g").unwrap();
        let args = sdxl_companions(clip_l.clone(), clip_g.clone());
        let flags: Vec<&str> = args.iter().map(|(flag, _)| flag.as_str()).collect();
        assert_eq!(flags, ["--clip_g"]);

        std::fs::write(&clip_l, b"l").unwrap();
        let args = sdxl_companions(clip_l.clone(), clip_g.clone());
        let flags: Vec<&str> = args.iter().map(|(flag, _)| flag.as_str()).collect();
        assert_eq!(flags, ["--clip_l", "--clip_g"]);
        assert_eq!(args[0].1, clip_l);
        assert_eq!(args[1].1, clip_g);
    }

    #[test]
    fn installed_standard_wins_unless_ram_rules_it_out() {
        use ModelKind::{DefaultImage, LiteImage};
        assert_eq!(
            installed_default_image(true, true, Some(true)),
            Some(DefaultImage)
        );
        // An unknown RAM reading never discards an existing install.
        assert_eq!(
            installed_default_image(true, false, None),
            Some(DefaultImage)
        );
        // Known too small: fall to the Lite checkpoint when it is there…
        assert_eq!(
            installed_default_image(true, true, Some(false)),
            Some(LiteImage)
        );
        // …and to nothing (the tier decides what to install) when it is not.
        assert_eq!(installed_default_image(true, false, Some(false)), None);
        assert_eq!(
            installed_default_image(false, true, Some(true)),
            Some(LiteImage)
        );
        assert_eq!(installed_default_image(false, false, Some(true)), None);
        assert_eq!(default_image_path(LiteImage), downloader::lite_model_path());
        assert_eq!(
            default_image_path(DefaultImage),
            downloader::default_model_path()
        );
    }

    #[test]
    fn only_a_none_tier_turns_into_the_cloud_refusal() {
        let none = downloader::ImageTierChoice {
            tier: downloader::ImageTier::None,
            downgrade_reason: Some("only 2.0 GB of memory".into()),
        };
        let message = unavailable_message(&none).expect("none tier refuses");
        assert!(message.contains("only 2.0 GB of memory"), "{message}");
        assert!(message.contains("cloud image provider"), "{message}");
        let lite = downloader::ImageTierChoice {
            tier: downloader::ImageTier::Lite,
            downgrade_reason: Some("x".into()),
        };
        assert_eq!(unavailable_message(&lite), None);
    }

    #[test]
    fn loaded_bytes_sums_the_model_and_present_companions() {
        let dir = tempfile::tempdir().unwrap();
        let model = dir.path().join("m.gguf");
        let vae = dir.path().join("vae.safetensors");
        std::fs::write(&model, [0u8; 10]).unwrap();
        std::fs::write(&vae, [0u8; 5]).unwrap();
        let companions = vec![
            ("--vae".to_string(), vae),
            ("--llm".to_string(), dir.path().join("absent.gguf")),
        ];
        assert_eq!(loaded_bytes(&model, &companions), 15);
    }

    #[test]
    fn frame_model_launch_bytes_count_the_whole_a14b_pair() {
        use frame_models::WanFrameModel;
        let dir = tempfile::tempdir().unwrap();
        let low = dir.path().join("Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf");
        let high = dir.path().join("Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf");
        std::fs::write(&low, [0u8; 7]).unwrap();
        std::fs::write(&high, [0u8; 11]).unwrap();
        let kind = ModelKind::FrameVideo(WanFrameModel::Wan22I2vA14b);
        // The pair counts in full (plus any companion a dev machine has on disk);
        // measuring only the model would report 7.
        assert!(launch_loaded_bytes(kind, &low, &companion_args(kind)) >= 18);
        // A single-transformer model keeps the plain sum.
        assert_eq!(
            launch_loaded_bytes(ModelKind::Other, &low, &companion_args(ModelKind::Other)),
            7
        );
    }

    #[test]
    fn split_qwen_image_and_wan_models_load_as_standalone_diffusion_models() {
        assert_eq!(model_flag(ModelKind::DefaultImage), "--diffusion-model");
        assert_eq!(model_flag(ModelKind::KnownImage), "--diffusion-model");
        assert_eq!(model_flag(ModelKind::KnownVideo), "--diffusion-model");
        assert_eq!(
            model_flag(ModelKind::FrameVideo(frame_models::WanFrameModel::Wan21I2v)),
            "--diffusion-model"
        );
        assert_eq!(model_flag(ModelKind::LiteImage), "-m");
        assert_eq!(model_flag(ModelKind::Sdxl), "-m");
        assert_eq!(model_flag(ModelKind::EnvOverride), "-m");
        assert_eq!(model_flag(ModelKind::Other), "-m");
    }

    async fn models_fixture(model_id: &'static str) -> u16 {
        use axum::{routing::get, Json, Router};
        let app = Router::new().route(
            "/v1/models",
            get(move || async move {
                Json(serde_json::json!({ "data": [{ "id": model_id, "object": "model" }] }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        port
    }

    /// A long-lived stand-in for the spawned child, so readiness sees it alive.
    async fn sleeping_child() -> ProcessHandle {
        let process = ProcessHandle::new();
        process
            .start_path_with_args("sleep", &["30".to_owned()])
            .await
            .expect("spawn sleep");
        process
    }

    #[tokio::test]
    async fn sd_server_readiness_requires_its_models_identity() {
        let client = reqwest::Client::new();
        let stderr = super::super::readiness::StderrTail::default();
        let timeout = std::time::Duration::from_secs(5);

        let process = sleeping_child().await;
        let port = models_fixture(SD_SERVER_MODEL_ID).await;
        wait_for_sd_server(&client, port, &process, &stderr, timeout)
            .await
            .expect("sd-server listing sd-cpp-local is ready");

        // A llama.cpp server (e.g. the classify tier) answering on the port is
        // not sd-server, even though a TCP connect would have succeeded.
        let port = models_fixture("gemma-3-270m-it-qat-Q4_0").await;
        let error = wait_for_sd_server(&client, port, &process, &stderr, timeout)
            .await
            .expect_err("a foreign listener must not count as ready");
        assert!(
            error.to_string().contains("served model mismatch"),
            "{error:#}"
        );
        let _ = process.stop().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sd_server_exit_fails_fast_with_its_stderr_tail() {
        let client = reqwest::Client::new();
        let stderr = super::super::readiness::StderrTail::default();
        let process = ProcessHandle::new();
        process
            .start_path_with_args_capturing_stderr(
                "sh",
                &[
                    "-c".to_owned(),
                    "echo 'error: failed to load diffusion model' >&2; exit 1".to_owned(),
                ],
                "sdcpp-test",
                stderr.clone(),
            )
            .await
            .expect("spawn sh");
        // Port 9 (discard) is never an sd-server; the child exit must win long
        // before the 60 s timeout.
        let started = std::time::Instant::now();
        let error = wait_for_sd_server(
            &client,
            9,
            &process,
            &stderr,
            std::time::Duration::from_secs(60),
        )
        .await
        .expect_err("exited child is not ready");
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        let message = format!("{error:#}");
        assert!(
            message.contains("exited before becoming ready"),
            "{message}"
        );
        assert!(
            message.contains("failed to load diffusion model"),
            "{message}"
        );
    }

    #[test]
    fn image_and_video_weights_live_in_their_own_modality_dirs() {
        assert!(downloader::default_model_path()
            .parent()
            .unwrap()
            .ends_with("models/image/sdcpp"));
        // The Qwen3-VL text encoder belongs with the image weights, not with
        // the chat models the catalog scans.
        assert!(downloader::image_llm_path()
            .parent()
            .unwrap()
            .ends_with("models/image/sdcpp"));
        assert!(downloader::video_t5xxl_path()
            .parent()
            .unwrap()
            .ends_with("models/video/sdcpp"));
        // Wan frame-model companions sit with the other Wan weights.
        for companion in [
            downloader::video_clip_vision_path(),
            downloader::video_wan22_vae_path(),
        ] {
            assert!(companion.parent().unwrap().ends_with("models/video/sdcpp"));
        }
        assert!(downloader::server_binary_path()
            .parent()
            .unwrap()
            .ends_with("engines/image/sdcpp"));
    }

    #[test]
    fn only_recognized_frame_models_report_local_frame_support() {
        use frame_models::WanFrameModel;
        use ryu_image::video::LocalVideoInputs;
        let dir = std::env::temp_dir().join(format!("ryu-sd-frames-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let flf2v = dir.join("wan2.1-flf2v-14b-720p-Q4_K_M.gguf");
        std::fs::write(&flf2v, b"weights").unwrap();

        // A recognized frame model reports its frames.
        assert_eq!(
            video_inputs_for(ModelKind::FrameVideo(WanFrameModel::Wan21Flf2v), &flf2v),
            LocalVideoInputs {
                first_frame: true,
                last_frame: true
            }
        );
        // The same file loaded without companions (`RYU_SD_MODEL`, or an
        // unrecognized preference) cannot use frames.
        for kind in [ModelKind::Other, ModelKind::EnvOverride] {
            assert_eq!(video_inputs_for(kind, &flf2v), LocalVideoInputs::default());
        }
        // The default text-to-video and image models are text-only.
        assert_eq!(
            video_inputs_for(ModelKind::KnownVideo, &downloader::video_model_path()),
            LocalVideoInputs::default()
        );
        assert_eq!(
            video_inputs_for(ModelKind::DefaultImage, &downloader::default_model_path()),
            LocalVideoInputs::default()
        );
        // Half of an A14B pair cannot launch, so it claims nothing.
        let low = dir.join("Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf");
        std::fs::write(&low, b"weights").unwrap();
        assert_eq!(
            video_inputs_for(ModelKind::FrameVideo(WanFrameModel::Wan22I2vA14b), &low),
            LocalVideoInputs::default()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn frame_models_launch_with_diffusion_model_instead_of_m() {
        use frame_models::WanFrameModel;
        let model = std::path::Path::new("/models/wan2.1-i2v-14b-480p-Q4_K_M.gguf");
        let args = model_args(ModelKind::FrameVideo(WanFrameModel::Wan21I2v), model).unwrap();
        assert_eq!(args[..2], ["--diffusion-model", &*model.to_string_lossy()]);
        assert!(args.iter().any(|arg| arg == "--clip_vision"));
        assert!(!args.iter().any(|arg| arg == "-m"));

        let image = model_args(ModelKind::DefaultImage, &downloader::default_model_path()).unwrap();
        assert_eq!(image[0], "--diffusion-model");
        assert!(image.iter().any(|arg| arg == "--llm"));
    }

    #[test]
    fn an_incomplete_a14b_pair_is_refused_as_the_active_model() {
        // Only the low-noise half is installed, so the launch plan fails and
        // the switch must refuse it before the sidecar downloads anything.
        let dir = std::env::temp_dir().join(format!("ryu-sd-activate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stem = "Wan2.2-I2V-A14B-LowNoise-Q4_K_M";
        let low = dir.join(format!("{stem}.gguf"));
        std::fs::write(&low, b"weights").unwrap();
        let reason = launch_refusal(stem, &low).expect("incomplete pair refused");
        assert!(
            reason.contains("Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf"),
            "{reason}"
        );
        std::fs::write(dir.join("Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf"), b"w").unwrap();
        assert_eq!(launch_refusal(stem, &low), None);
        // Non-frame models are never refused here.
        for other in [
            downloader::IMAGE_DEFAULT_STEM,
            downloader::VIDEO_DEFAULT_STEM,
        ] {
            assert_eq!(
                launch_refusal(other, &dir.join(format!("{other}.gguf"))),
                None
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn video_model_still_receives_its_separate_vae() {
        let args = companion_args(ModelKind::KnownVideo);
        assert!(args.iter().any(|(flag, _)| flag == "--t5xxl"));
        assert!(args.iter().any(|(flag, _)| flag == "--vae"));
    }
}
