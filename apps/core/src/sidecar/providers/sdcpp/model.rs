//! Diffusion model resolution: which weights and companions `sd-server` loads,
//! and whether this node can run them.

use super::{downloader, frame_models};
use crate::sidecar::providers::llamacpp;

/// How the active diffusion model was chosen — decides which companion files
/// (text encoders / VAE) `sd-server` needs, if any.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ModelKind {
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
pub(super) fn memory_device() -> crate::model_catalog::device::DeviceInfo {
    downloader::memory_pool_device(
        llamacpp::variant::device(),
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
pub(super) async fn resolved_model() -> (std::path::PathBuf, ModelKind) {
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
pub(super) fn installed_default_image(
    standard_installed: bool,
    lite_installed: bool,
    standard_fits_ram: Option<bool>,
) -> Option<ModelKind> {
    if standard_installed && standard_fits_ram != Some(false) {
        return Some(ModelKind::DefaultImage);
    }
    lite_installed.then_some(ModelKind::LiteImage)
}

pub(super) fn default_image_path(kind: ModelKind) -> std::path::PathBuf {
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
pub(super) fn unavailable_message(choice: &downloader::ImageTierChoice) -> Option<String> {
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
pub(super) fn loaded_bytes(
    model: &std::path::Path,
    companions: &[(String, std::path::PathBuf)],
) -> u64 {
    std::iter::once(model)
        .chain(companions.iter().map(|(_, path)| path.as_path()))
        .filter_map(|path| std::fs::metadata(path).ok())
        .map(|meta| meta.len())
        .sum()
}

/// [`loaded_bytes`] for what `sd-server` is actually launched with: a Wan frame
/// model builds its own arguments (the transformer pair and its companions), so
/// its weight paths come from [`model_args`] rather than [`companion_args`].
pub(super) fn launch_loaded_bytes(
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
pub(super) fn video_inputs_for(
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
pub(super) fn launch_refusal(stem: &str, model: &std::path::Path) -> Option<String> {
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
pub(super) fn companion_args(kind: ModelKind) -> Vec<(String, std::path::PathBuf)> {
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
pub(super) fn sdxl_companions(
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
pub(super) fn model_flag(kind: ModelKind) -> &'static str {
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
pub(super) fn model_args(kind: ModelKind, model: &std::path::Path) -> anyhow::Result<Vec<String>> {
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
