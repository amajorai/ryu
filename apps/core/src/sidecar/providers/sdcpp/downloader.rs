//! stable-diffusion.cpp downloader: fetches the prebuilt server binary (plus the
//! `stable-diffusion.dll` it links against) and the default diffusion model(s)
//! so image generation works right after install. The image default is chosen
//! per node from its RAM and free disk ([`select_image_tier`]): the
//! [`ImageTier::Standard`] stack is a stable-diffusion.cpp-compatible Qwen Image
//! 2.1 GGUF plus its Qwen3-VL text/vision encoder and VAE (~11.1 GB); weaker
//! machines get the single-file [`ImageTier::Lite`] SDXL base checkpoint
//! (~2.8 GB), and a machine that fits neither gets no local image model. The
//! video default is Wan2.1 T2V 1.3B (multi-file: transformer GGUF + umt5-xxl +
//! VAE, ~6.0 GB), fetched lazily on first use and refused up front when it does
//! not fit ([`video_stack_block_reason`]).
//! Wan image-to-video and first/last-frame transformers are user catalog
//! installs; their CLIP-vision H / Wan2.2 VAE companions are fetched lazily by
//! [`StableDiffusionDownloader::ensure_frame_companions`] once such a model is
//! the active diffusion model.
//!
//! Like whisper.cpp, stable-diffusion.cpp publishes platform-specific archives
//! in its GitHub releases. Each archive bundles `sd-server` alongside the
//! shared library it needs, so the whole archive must be extracted together.
//! Targets without a matching asset return a clear "build from source" error
//! rather than silently marking the engine installed.
//!
//! Pinning a release tag (not `/latest`) keeps installs reproducible. The model
//! file is a swappable default, not a lock: `RYU_SD_MODEL` overrides the path the
//! server loads, and the model catalog can install any other diffusion GGUF.

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use ryu_sidecar_runtime::layout::{EngineGroup, Modality};

use crate::model_catalog::device::{
    fits_in_system_ram, has_disk_space_for, human_bytes, system_ram_need_bytes, DeviceInfo,
    DISK_HEADROOM_BYTES,
};

use crate::sidecar::download_manager::{
    build_http_client, engine_dir, extract_all_to_dir_from, model_family_dir, tmp_dir,
    ProgressCallback, VersionStore,
};

/// Pinned stable-diffusion.cpp release that ships the Windows server asset.
/// The release tag this build installs — pinned; see
/// `catalog::registry::installer_pin`.
pub const TARGET_VERSION: &str = "master-890-74988b2";

/// Prebuilt sd-server release asset within [`TARGET_VERSION`], per platform. The
/// asset names embed the commit (`74988b2`), not the full tag, so they are pinned
/// explicitly rather than derived. The release ships prebuilt server binaries
/// for Windows x64, macOS Apple-Silicon arm64, and Linux x86_64; each archive
/// bundles `sd-server` alongside the shared library it links against, so the
/// whole archive is extracted into `engines/image/sdcpp/` together.
/// Targets without a matching asset (Windows arm64, Intel mac, non-x86_64 Linux)
/// accept an operator-placed `sd-server` and otherwise refuse with build-from-
/// source instructions in [`StableDiffusionDownloader::ensure_binary`]; the
/// catalog gate (`catalog::registry::supported_on_node("sdcpp")`) matches.
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const PLATFORM_ASSET: &str = "sd-master-74988b2-bin-win-cpu-x64.zip";
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const PLATFORM_SHA256: &str = "24fcac70fadc41eb3524837893f1cb7ea54895fe4d807f88ef7afdeee8bd484b";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const PLATFORM_ASSET: &str = "sd-master-74988b2-bin-Darwin-macOS-26.6.2-arm64.zip";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const PLATFORM_SHA256: &str = "fbffe2165d2e34098a673a3398286880d7dc1cdf2625e87ebb8b6235aac51553";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const PLATFORM_ASSET: &str = "sd-master-74988b2-bin-Linux-Ubuntu-24.04-x86_64.zip";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const PLATFORM_SHA256: &str = "04f7b4db880167c1b7b25eefcde27aa301301568eadb17623876eb3b8c938198";

/// Default diffusion model: Qwen Image 2.1's Q4_K GGUF converted by the
/// stable-diffusion.cpp maintainer. Qwen Image 2.1 needs its matching VAE and
/// Qwen3-VL text encoder; the vision projector is also provisioned so the same
/// default can handle image editing. Every URL is pinned to the source-repo
/// commit and every file carries its SHA-256 for an atomic, verifiable install.
/// Override with `RYU_SD_MODEL` or install another diffusion GGUF via the model
/// catalog.
const DEFAULT_MODEL_FILE: &str = "qwen_image_2.1-Q4_K.gguf";
const DEFAULT_MODEL_URL: &str = "https://huggingface.co/leejet/Qwen-Image-2.1-GGUF/resolve/cc11433936a06e9765f7c0c0b1f0436cfd2b9856/qwen_image_2.1-Q4_K.gguf";
const DEFAULT_MODEL_SHA256: &str =
    "29f9c83c249ff0292fb2943fceddfa2319b446601866c82a4f8be062abea72c2";
const DEFAULT_VAE_FILE: &str = "qwen_image_2.1_vae_bf16.safetensors";
const DEFAULT_VAE_URL: &str = "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/ace0edeb3791a594ddfa36ed5f41a178a394e921/vae/qwen_image_2.1_vae_bf16.safetensors";
const DEFAULT_VAE_SHA256: &str = "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9";
const DEFAULT_LLM_FILE: &str = "Qwen3VL-8B-Instruct-Q4_K_M.gguf";
const DEFAULT_LLM_URL: &str = "https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/resolve/f982a07559d4a2f6c8744d840bf6fccab30eea96/Qwen3VL-8B-Instruct-Q4_K_M.gguf";
const DEFAULT_LLM_SHA256: &str = "67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2";
const DEFAULT_LLM_VISION_FILE: &str = "mmproj-Qwen3VL-8B-Instruct-F16.gguf";
const DEFAULT_LLM_VISION_URL: &str = "https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/resolve/f982a07559d4a2f6c8744d840bf6fccab30eea96/mmproj-Qwen3VL-8B-Instruct-F16.gguf";
const DEFAULT_LLM_VISION_SHA256: &str =
    "ca524100ebf825c9a870db1c580d03879e0da0ab2541697e2458e64891cf9d38";
const MODEL_STORE_KEY: &str = "sd-model:qwen-image-2.1-q4-k";
const VAE_STORE_KEY: &str = "sd-model:qwen-image-2.1-vae-bf16";
const LLM_STORE_KEY: &str = "sd-model:qwen3-vl-8b-q4-k-m";
const LLM_VISION_STORE_KEY: &str = "sd-model:qwen3-vl-8b-mmproj-f16";

/// Download sizes of the Standard stack's four files at the pinned revisions
/// (Hugging Face `x-linked-size`), in the order [`StableDiffusionDownloader`]
/// fetches them. They drive the tier choice before anything is downloaded.
const DEFAULT_MODEL_BYTES: u64 = 4_197_494_816;
const DEFAULT_VAE_BYTES: u64 = 675_509_688;
const DEFAULT_LLM_BYTES: u64 = 5_027_784_800;
const DEFAULT_LLM_VISION_BYTES: u64 = 1_159_029_824;
/// Everything the Standard (Qwen Image 2.1) tier loads at once: ~11.06 GB. The
/// bundled sd-server is a CPU build, so all of it must sit in system RAM.
pub const STANDARD_STACK_BYTES: u64 =
    DEFAULT_MODEL_BYTES + DEFAULT_VAE_BYTES + DEFAULT_LLM_BYTES + DEFAULT_LLM_VISION_BYTES;

/// Lite image default: the SDXL base 1.0 Q4_K single-file checkpoint (CLIP-L,
/// CLIP-G and VAE embedded), so `sd-server` loads it with `-m` alone. It was
/// verified on the CPU build through Core
/// (`docs/proof/1.0-readiness-20260917/evidence/sd-model-compatibility-20260918.json`).
/// Pinned to the source-repo commit with its SHA-256, like the Standard files.
const LITE_MODEL_FILE: &str = "sd_xl_base_1.0_0_Q4_K.gguf";
const LITE_MODEL_URL: &str = "https://huggingface.co/kostakoff/stable-diffusion-xl-base-1.0-GGUF/resolve/ca58fb3aced770f3dffddabf01725b29207305ef/sd_xl_base_1.0_0_Q4_K.gguf";
const LITE_MODEL_SHA256: &str = "51ab2be4ec58905b4cbfe5c0d2f3d0cdc5b0192e8e85dbe9a00481858c8389b0";
const LITE_MODEL_STORE_KEY: &str = "sd-model:sdxl-base-1.0-q4-k";
/// The Lite tier's whole footprint: ~2.8 GB.
pub const LITE_STACK_BYTES: u64 = 2_797_752_960;

/// Optional SDXL text encoders. An SDXL install from before the Qwen Image 2.1
/// default may still have them beside the checkpoint, and they are passed when
/// present; the Lite tier never downloads them because its checkpoint embeds
/// both encoders.
const LEGACY_SDXL_CLIP_L_FILE: &str = "sdxl_clip_l.safetensors";
const LEGACY_SDXL_CLIP_G_FILE: &str = "sdxl_clip_g.safetensors";
const LEGACY_SDXL_VAE_FILE: &str = "sdxl_vae.safetensors";

/// Default video model: Wan2.1 T2V 1.3B — the smallest real text-to-video model
/// stable-diffusion.cpp supports (Apache-2.0). Like the image default it is
/// multi-file: the diffusion transformer GGUF (Q8_0, ~1.6 GB) plus the umt5-xxl
/// text encoder (~4.1 GB Q5_K_M) and the Wan 2.1 VAE (~0.25 GB). Video is
/// GPU-preferred and ~6.0 GB in total, so it is NOT bundled at onboarding — it is
/// downloaded lazily the first time the active diffusion model is a video model
/// (see `StableDiffusionManager::start`), after [`video_stack_block_reason`]
/// confirms it fits. `sd-server` loads it with `--t5xxl --vae`.
pub const VIDEO_MODEL_FILE: &str = "wan2.1_t2v_1.3b-q8_0.gguf";
const VIDEO_MODEL_URL: &str =
    "https://huggingface.co/calcuis/wan-1.3b-gguf/resolve/main/wan2.1_t2v_1.3b-q8_0.gguf";
pub const VIDEO_T5XXL_FILE: &str = "umt5-xxl-encoder-Q5_K_M.gguf";
/// Pinned to the encoder repo commit with its LFS SHA-256; shared by the
/// default video model and every Wan frame model.
const VIDEO_T5XXL_URL: &str = "https://huggingface.co/city96/umt5-xxl-encoder-gguf/resolve/b535255bee98c2b0a59ea7c0ae2dcd0c6657b3b7/umt5-xxl-encoder-Q5_K_M.gguf";
const VIDEO_T5XXL_SHA256: &str = "eaea358bb438c5d211721a4feecc162000e3636e9cb96f51e216f1f44ebd12ce";
pub const VIDEO_VAE_FILE: &str = "wan_2.1_vae.safetensors";
/// Pinned to the repackaging repo commit with its LFS SHA-256.
const VIDEO_VAE_URL: &str = "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/123acf1cc74bccbb9bfff8ac1ee72edc08c2341d/split_files/vae/wan_2.1_vae.safetensors";
const VIDEO_VAE_SHA256: &str = "2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b";
const VIDEO_MODEL_STORE_KEY: &str = "sd-video:wan2.1-t2v-1.3b-q8_0";
const VIDEO_T5XXL_STORE_KEY: &str = "sd-video:umt5-xxl-q5-k-m";
const VIDEO_VAE_STORE_KEY: &str = "sd-video:wan2.1-vae";
const VIDEO_MODEL_BYTES: u64 = 1_587_083_488;
const VIDEO_T5XXL_BYTES: u64 = 4_145_878_880;
const VIDEO_VAE_BYTES: u64 = 253_815_318;
/// Everything the Wan2.1 video default loads at once: ~5.99 GB.
pub const VIDEO_STACK_BYTES: u64 = VIDEO_MODEL_BYTES + VIDEO_T5XXL_BYTES + VIDEO_VAE_BYTES;

/// CLIP-vision H image encoder that Wan2.1 image-to-video and first/last-frame
/// models condition on (`--clip_vision`, ~1.26 GB). Pinned to the repackaging
/// repo commit with its LFS SHA-256. Never bundled: it is fetched only when the
/// active local diffusion model is a Wan2.1 I2V/FLF2V transformer (see
/// [`super::frame_models`]).
pub const VIDEO_CLIP_VISION_FILE: &str = "clip_vision_h.safetensors";
const VIDEO_CLIP_VISION_URL: &str = "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/123acf1cc74bccbb9bfff8ac1ee72edc08c2341d/split_files/clip_vision/clip_vision_h.safetensors";
const VIDEO_CLIP_VISION_SHA256: &str =
    "64a7ef761bfccbadbaa3da77366aac4185a6c58fa5de5f589b42a65bcc21f161";
const VIDEO_CLIP_VISION_STORE_KEY: &str = "sd-video:clip-vision-h";
/// Wan2.2 VAE, used only by the Wan2.2 TI2V 5B model (~1.4 GB). Every other Wan
/// model, including Wan2.2 I2V A14B, uses the Wan2.1 VAE above.
pub const VIDEO_WAN22_VAE_FILE: &str = "wan2.2_vae.safetensors";
const VIDEO_WAN22_VAE_URL: &str = "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/ee6f4a40737a995bf5818954cfce6d59443b0f04/split_files/vae/wan2.2_vae.safetensors";
const VIDEO_WAN22_VAE_SHA256: &str =
    "e40321bd36b9709991dae2530eb4ac303dd168276980d3e9bc4b6e2b75fed156";
const VIDEO_WAN22_VAE_STORE_KEY: &str = "sd-video:wan2.2-vae";

/// Local stems (GGUF filename minus `.gguf`) of the default image and video
/// models. These are the values the `local-diffusion-model` preference stores,
/// and what the spawn side matches against to attach companion files.
pub const IMAGE_DEFAULT_STEM: &str = "qwen_image_2.1-Q4_K";
/// Prefix shared by the official Qwen Image 2.1 GGUF quantizations. A user can
/// install Q4_0/Q5_0/Q8_0 from the model catalog and reuse the same companions.
pub const IMAGE_MODEL_STEM_PREFIX: &str = "qwen_image_2.1-";
/// Preference stem used by the retired HyperX artifact. Existing nodes may
/// still have it persisted; it is ignored so a corrupt model cannot remain the
/// active default after the compatible artifact is selected.
pub const LEGACY_IMAGE_DEFAULT_STEM: &str = "sdxl_base_1.0_Q8_0";
/// The SDXL base checkpoint: the [`ImageTier::Lite`] default, and the image
/// default before Qwen Image 2.1, so an explicit selection from then still
/// resolves to the same file.
pub const LEGACY_SDXL_DEFAULT_STEM: &str = "sd_xl_base_1.0_0_Q4_K";
pub const VIDEO_DEFAULT_STEM: &str = "wan2.1_t2v_1.3b-q8_0";

pub fn is_qwen_image_stem(stem: &str) -> bool {
    stem == IMAGE_DEFAULT_STEM || stem.starts_with(IMAGE_MODEL_STEM_PREFIX)
}

/// `<data dir>/engines/image/sdcpp` — the whole sd.cpp release archive
/// (`sd-server`, `sd-cli`, and the shared library they link against) is
/// extracted here, never loose in `bin/`, so its libraries cannot collide with
/// another engine's.
pub fn install_dir() -> PathBuf {
    engine_dir(EngineGroup::Image, "sdcpp")
}

/// Path of the installed `sd-server` executable inside [`install_dir`].
pub fn server_binary_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "sd-server.exe"
    } else {
        "sd-server"
    };
    install_dir().join(name)
}

/// `<data dir>/models/image/sdcpp` — the bundled image weights: the diffusion
/// model, its VAE, and the Qwen3-VL text encoder + vision projector it needs.
pub fn image_models_dir() -> PathBuf {
    model_family_dir(Modality::Image, "sdcpp")
}

/// `<data dir>/models/video/sdcpp` — the Wan2.1 transformer, umt5 encoder and
/// Wan VAE.
pub fn video_models_dir() -> PathBuf {
    model_family_dir(Modality::Video, "sdcpp")
}

pub fn default_model_path() -> PathBuf {
    image_models_dir().join(DEFAULT_MODEL_FILE)
}

pub fn image_vae_path() -> PathBuf {
    image_models_dir().join(DEFAULT_VAE_FILE)
}

pub fn image_llm_path() -> PathBuf {
    image_models_dir().join(DEFAULT_LLM_FILE)
}

pub fn image_llm_vision_path() -> PathBuf {
    image_models_dir().join(DEFAULT_LLM_VISION_FILE)
}

/// The [`ImageTier::Lite`] checkpoint (stem [`LEGACY_SDXL_DEFAULT_STEM`]).
pub fn lite_model_path() -> PathBuf {
    image_models_dir().join(LITE_MODEL_FILE)
}

/// The Standard stack's files with their download sizes.
fn standard_stack_files() -> [(PathBuf, u64); 4] {
    [
        (default_model_path(), DEFAULT_MODEL_BYTES),
        (image_vae_path(), DEFAULT_VAE_BYTES),
        (image_llm_path(), DEFAULT_LLM_BYTES),
        (image_llm_vision_path(), DEFAULT_LLM_VISION_BYTES),
    ]
}

/// Bytes still to download from `files` (those not yet on disk).
fn missing_bytes(files: &[(PathBuf, u64)]) -> u64 {
    files
        .iter()
        .filter(|(path, _)| !path.exists())
        .map(|(_, bytes)| bytes)
        .sum()
}

/// True when every Standard (Qwen Image 2.1) file is on disk.
pub fn standard_stack_installed() -> bool {
    missing_bytes(&standard_stack_files()) == 0
}

/// True when the Lite (SDXL base) checkpoint is on disk.
pub fn lite_model_installed() -> bool {
    lite_model_path().exists()
}

pub fn legacy_sdxl_clip_l_path() -> PathBuf {
    image_models_dir().join(LEGACY_SDXL_CLIP_L_FILE)
}

pub fn legacy_sdxl_clip_g_path() -> PathBuf {
    image_models_dir().join(LEGACY_SDXL_CLIP_G_FILE)
}

pub fn legacy_sdxl_vae_path() -> PathBuf {
    image_models_dir().join(LEGACY_SDXL_VAE_FILE)
}

pub fn video_model_path() -> PathBuf {
    video_models_dir().join(VIDEO_MODEL_FILE)
}

pub fn video_t5xxl_path() -> PathBuf {
    video_models_dir().join(VIDEO_T5XXL_FILE)
}

pub fn video_vae_path() -> PathBuf {
    video_models_dir().join(VIDEO_VAE_FILE)
}

/// Where a diffusion GGUF selected by local stem lives: the sd.cpp image dir,
/// then the video dir, then the catalog's chat-model dir (a diffusion GGUF
/// installed through the model catalog). Returns the first candidate that
/// exists, or `None`.
pub fn resolve_stem_path(stem: &str) -> Option<PathBuf> {
    let file = format!("{stem}.gguf");
    [
        image_models_dir().join(&file),
        video_models_dir().join(&file),
        crate::model_catalog::installed::model_file_path(stem),
    ]
    .into_iter()
    .find(|p| p.exists())
}

/// CLIP-vision H encoder for Wan image-to-video / first-last-frame models,
/// beside the other Wan companions in `models/video/sdcpp/`.
pub fn video_clip_vision_path() -> PathBuf {
    video_models_dir().join(VIDEO_CLIP_VISION_FILE)
}

/// Wan2.2 VAE (the TI2V 5B companion), in `models/video/sdcpp/`.
pub fn video_wan22_vae_path() -> PathBuf {
    video_models_dir().join(VIDEO_WAN22_VAE_FILE)
}

// ── Hardware-tiered image default ────────────────────────────────────────────

/// Which bundled image default a node installs, decided by [`select_image_tier`]
/// from the RAM and free disk of the Core node that serves the request (local
/// or remote — each node decides for itself). Serialized as `"standard"`,
/// `"lite"` or `"none"` in `LocalStackStatus::image_tier`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageTier {
    /// Qwen Image 2.1 Q4_K + Qwen3-VL-8B encoders + VAE (~11.1 GB).
    Standard,
    /// SDXL base 1.0 Q4_K single-file checkpoint (~2.8 GB).
    Lite,
    /// Neither fits: no local image model; image generation needs a cloud
    /// provider (`provider: "openrouter" | "replicate" | "fal"`).
    None,
}

impl ImageTier {
    pub fn as_str(self) -> &'static str {
        match self {
            ImageTier::Standard => "standard",
            ImageTier::Lite => "lite",
            ImageTier::None => "none",
        }
    }

    /// Parse an `RYU_IMAGE_TIER` value; unknown spellings are `None` (ignored).
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "standard" => Some(ImageTier::Standard),
            "lite" => Some(ImageTier::Lite),
            "none" | "off" => Some(ImageTier::None),
            _ => None,
        }
    }

    /// Heaviest first: a request may lower the tier, never raise it past what
    /// the hardware allows.
    fn rank(self) -> u8 {
        match self {
            ImageTier::None => 0,
            ImageTier::Lite => 1,
            ImageTier::Standard => 2,
        }
    }
}

/// The operator's tier request, from `RYU_IMAGE_TIER` (`standard` | `lite` |
/// `none`), env-only like `RYU_SD_MODEL`. It can always lower the tier (e.g.
/// `none` to keep a node cloud-only); it can raise it only when the hardware is
/// unknown, never past what the node's RAM/disk definitively rule out.
pub fn requested_image_tier() -> Option<ImageTier> {
    std::env::var("RYU_IMAGE_TIER")
        .ok()
        .and_then(|raw| ImageTier::parse(&raw))
}

/// The tier a node gets, plus — when that is below Standard — why, as one
/// sentence with the real numbers for the onboarding warning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageTierChoice {
    pub tier: ImageTier,
    pub downgrade_reason: Option<String>,
}

/// What [`select_image_tier`] needs beyond the hardware probe. Kept separate
/// from the filesystem so the decision is a pure function and testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageTierInputs {
    /// Standard-stack bytes not yet on disk (0 = fully installed).
    pub standard_missing_bytes: u64,
    /// Lite-checkpoint bytes not yet on disk (0 = installed).
    pub lite_missing_bytes: u64,
    /// [`requested_image_tier`].
    pub requested: Option<ImageTier>,
}

impl ImageTierInputs {
    /// Read the install state from disk and the request from the environment.
    pub fn from_disk() -> Self {
        Self {
            standard_missing_bytes: missing_bytes(&standard_stack_files()),
            lite_missing_bytes: if lite_model_installed() {
                0
            } else {
                LITE_STACK_BYTES
            },
            requested: requested_image_tier(),
        }
    }
}

/// Fingerprint of the `sd-server` on disk (its size), recorded beside the pinned
/// version when Core installs the CPU archive.
fn binary_fingerprint(path: &std::path::Path) -> Option<String> {
    std::fs::metadata(path)
        .ok()
        .map(|meta| format!("size:{}", meta.len()))
}

/// Whether the recorded install state says the `sd-server` on disk is the pinned
/// CPU archive. No recorded version means the operator placed the binary
/// themselves, which the downloader docs invite for CUDA and Metal builds. A
/// fingerprint that no longer matches means it was swapped after the install. An
/// install that recorded no fingerprint (older releases) stays treated as the
/// bundled CPU build, so its RAM guard keeps working.
fn bundled_cpu_server_matches(
    version: Option<&str>,
    recorded: Option<&str>,
    on_disk: Option<&str>,
) -> bool {
    if version.is_none() {
        return false;
    }
    match recorded.filter(|value| value.starts_with("size:")) {
        Some(recorded) => on_disk == Some(recorded),
        None => true,
    }
}

/// Whether the installed `sd-server` is the pinned CPU archive Core downloaded,
/// so system RAM (not VRAM) governs what it can load.
pub fn bundled_cpu_server_in_use() -> bool {
    let store = VersionStore::load();
    bundled_cpu_server_matches(
        store.versions.get("sdcpp").map(String::as_str),
        store.checksums.get("sdcpp").map(String::as_str),
        binary_fingerprint(&server_binary_path()).as_deref(),
    )
}

/// The device as the sd-server build sees its memory. The bundled CPU build
/// loads everything into system RAM, so the device is unchanged. An
/// operator-supplied GPU build loads the weights into VRAM, so a larger VRAM
/// pool stands in for RAM in the fit checks and a model that fits the GPU is
/// not refused for the host's smaller RAM.
pub fn memory_pool_device(device: &DeviceInfo, cpu_build: bool) -> DeviceInfo {
    let mut pool = device.clone();
    if cpu_build {
        return pool;
    }
    if let Some(vram) = device.vram_bytes {
        if device.total_ram_bytes.is_none_or(|ram| vram > ram) {
            pool.total_ram_bytes = Some(vram);
            pool.ram_human = if device.vram_human.is_empty() {
                human_bytes(vram)
            } else {
                device.vram_human.clone()
            };
        }
    }
    pool
}

/// Whether a media stack may be installed/run on `device`.
enum StackCheck {
    Fits,
    /// RAM undetectable: never a refusal, but not a reason to pick the
    /// heaviest default either.
    Unknown(String),
    Blocked(String),
}

/// `label` is the stack's name, `total_bytes` what it loads at once (RAM — the
/// bundled sd-server is a CPU build, so system RAM governs, not VRAM) and
/// `missing_bytes` what is still to download (disk).
fn check_stack(label: &str, total_bytes: u64, missing: u64, device: &DeviceInfo) -> StackCheck {
    if let Some(reason) = media_stack_block_reason(label, total_bytes, missing, device) {
        return StackCheck::Blocked(reason);
    }
    if fits_in_system_ram(total_bytes, device).is_none() {
        return StackCheck::Unknown(format!(
            "this computer's memory could not be detected, so the lighter image model was \
             chosen over {label}"
        ));
    }
    StackCheck::Fits
}

/// Why `label` (loading `total_bytes` into RAM, `missing` still to download)
/// cannot be installed or run on `device`, with the real numbers; `None` when it
/// fits or the hardware is unknown (an unknown never refuses).
pub fn media_stack_block_reason(
    label: &str,
    total_bytes: u64,
    missing: u64,
    device: &DeviceInfo,
) -> Option<String> {
    if fits_in_system_ram(total_bytes, device) == Some(false) {
        return Some(format!(
            "{label} ({}) needs about {} of memory to run on the CPU, but this computer has {}",
            human_bytes(total_bytes),
            human_bytes(system_ram_need_bytes(total_bytes)),
            device.ram_human,
        ));
    }
    if missing > 0 && has_disk_space_for(missing, device) == Some(false) {
        return Some(format!(
            "{label} needs {} of free disk space ({} download plus {} kept in reserve), but only \
             {} is free",
            human_bytes(missing.saturating_add(DISK_HEADROOM_BYTES)),
            human_bytes(missing),
            human_bytes(DISK_HEADROOM_BYTES),
            device.disk_free_human,
        ));
    }
    None
}

const STANDARD_LABEL: &str = "Qwen Image 2.1";
const LITE_LABEL: &str = "the SDXL image model";

/// Pick the image default for `device`.
///
/// Thresholds (`system_ram_need_bytes` = weights × 1.2 + 1.5 GiB; disk keeps
/// `DISK_HEADROOM_BYTES` = 2 GiB free after the download):
/// - **Standard** when RAM is known and ≥ ~13.9 GiB (11.06 GB stack) and the
///   missing files fit on disk — or when the stack is already fully installed
///   and RAM is not known to be too small (an install is never discarded on an
///   unknown).
/// - **Lite** when RAM is unknown or ≥ ~4.6 GiB (2.8 GB checkpoint) and it fits
///   on disk. Unknown RAM picks Lite, not Standard: it is a default, not a
///   refusal, and the 2.8 GB model cannot freeze an undetectable small machine
///   the way the 11 GB stack could. `RYU_IMAGE_TIER=standard` overrides that.
/// - **None** otherwise: no local image model; image generation needs a cloud
///   provider.
pub fn select_image_tier(device: &DeviceInfo, inputs: &ImageTierInputs) -> ImageTierChoice {
    let standard = check_stack(
        STANDARD_LABEL,
        STANDARD_STACK_BYTES,
        inputs.standard_missing_bytes,
        device,
    );
    let lite = check_stack(
        LITE_LABEL,
        LITE_STACK_BYTES,
        inputs.lite_missing_bytes,
        device,
    );
    let standard_installed = inputs.standard_missing_bytes == 0;

    let (best, best_reason, standard_unknown) = match (&standard, &lite) {
        (StackCheck::Fits, _) => (ImageTier::Standard, None, false),
        (StackCheck::Unknown(_), _) if standard_installed => (ImageTier::Standard, None, true),
        (StackCheck::Unknown(why), StackCheck::Fits | StackCheck::Unknown(_)) => {
            (ImageTier::Lite, Some(why.clone()), true)
        }
        (StackCheck::Blocked(why), StackCheck::Fits | StackCheck::Unknown(_)) => {
            (ImageTier::Lite, Some(why.clone()), false)
        }
        (StackCheck::Unknown(why) | StackCheck::Blocked(why), StackCheck::Blocked(lite_why)) => {
            (ImageTier::None, Some(format!("{why}; {lite_why}")), false)
        }
    };

    match inputs.requested {
        // A request at or below the hardware's best is honoured as-is.
        Some(requested) if requested.rank() <= best.rank() => ImageTierChoice {
            tier: requested,
            downgrade_reason: (requested != ImageTier::Standard)
                .then(|| format!("RYU_IMAGE_TIER={} is set", requested.as_str())),
        },
        // Raising Standard past an unknown RAM reading is allowed: an unknown
        // never refuses an explicit request.
        Some(ImageTier::Standard) if standard_unknown => ImageTierChoice {
            tier: ImageTier::Standard,
            downgrade_reason: None,
        },
        _ => ImageTierChoice {
            tier: best,
            downgrade_reason: best_reason,
        },
    }
}

/// True when `RYU_SD_MODEL` names a file that exists: the operator supplied
/// the model, so no bundled default is downloaded or required.
pub fn sd_model_override_present() -> bool {
    std::env::var_os("RYU_SD_MODEL").is_some_and(|custom| PathBuf::from(custom).exists())
}

/// [`select_image_tier`] for this node, probed now (free disk changes between
/// calls, so this is not cached).
pub fn select_image_tier_for_this_node() -> ImageTierChoice {
    select_image_tier(&DeviceInfo::detect(), &ImageTierInputs::from_disk())
}

/// The onboarding warning for a choice below Standard; `None` for Standard.
pub fn image_tier_warning(choice: &ImageTierChoice) -> Option<String> {
    let reason = choice.downgrade_reason.as_deref().unwrap_or("");
    match choice.tier {
        ImageTier::Standard => None,
        ImageTier::Lite => Some(format!(
            "Installed the lighter SDXL image model (~2.8 GB) instead of Qwen Image 2.1 \
             (~11.1 GB): {reason}. You can still install other image models from the model \
             catalog."
        )),
        // An operator opt-out is not a hardware shortfall — say so plainly.
        ImageTier::None if reason.starts_with("RYU_IMAGE_TIER") => Some(format!(
            "No local image model was installed ({reason}). Image generation needs a cloud \
             provider (OpenRouter, Replicate or fal) instead."
        )),
        ImageTier::None => Some(format!(
            "This computer doesn't have enough memory or disk for a local image model ({reason}), \
             so none was installed. Image generation needs a cloud provider (OpenRouter, \
             Replicate or fal) instead."
        )),
    }
}

/// Why the Wan2.1 video default cannot be downloaded or run here (RAM for the
/// whole ~6.0 GB stack, disk for the files still missing); `None` when it fits
/// or the hardware is unknown.
pub fn video_stack_block_reason(device: &DeviceInfo) -> Option<String> {
    let missing = missing_bytes(&[
        (video_model_path(), VIDEO_MODEL_BYTES),
        (video_t5xxl_path(), VIDEO_T5XXL_BYTES),
        (video_vae_path(), VIDEO_VAE_BYTES),
    ]);
    media_stack_block_reason("The Wan2.1 video model", VIDEO_STACK_BYTES, missing, device)
}

/// URL of the prebuilt sd-server archive for this platform (CPU build — no CUDA,
/// so it runs without extra runtimes). GPU users can swap in a CUDA/Metal build
/// manually. Only compiled on targets that have a `PLATFORM_ASSET`.
#[cfg(any(
    all(target_os = "windows", target_arch = "x86_64"),
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "linux", target_arch = "x86_64")
))]
fn archive_url() -> String {
    format!(
        "https://github.com/leejet/stable-diffusion.cpp/releases/download/{TARGET_VERSION}/{PLATFORM_ASSET}"
    )
}

pub struct StableDiffusionDownloader {
    client: reqwest::Client,
    on_progress: Option<ProgressCallback>,
}

impl StableDiffusionDownloader {
    pub fn new() -> Self {
        Self {
            client: build_http_client(),
            on_progress: None,
        }
    }

    pub fn with_progress(mut self, cb: ProgressCallback) -> Self {
        self.on_progress = Some(cb);
        self
    }

    /// Ensure both the sd-server binary and this node's image default (chosen by
    /// [`select_image_tier_for_this_node`]) are present. Returns the installed
    /// version string on success. Fails before downloading anything when the
    /// node fits no local image model. The video model is NOT fetched here — see
    /// [`Self::ensure_video_default`] (lazy, on first use).
    pub async fn ensure_installed(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<String> {
        let choice = select_image_tier_for_this_node();
        // An existing `RYU_SD_MODEL` is the operator's own model: it needs only
        // the binary, whatever tier the bundled defaults would get.
        if choice.tier == ImageTier::None && !sd_model_override_present() {
            anyhow::bail!(
                "{}",
                image_tier_warning(&choice).unwrap_or_else(|| "no local image model fits".into())
            );
        }
        self.ensure_installed_for_tier(downloads, choice.tier).await
    }

    /// [`Self::ensure_installed`] for an already-chosen tier (onboarding picks
    /// it once so its status and warning describe what was downloaded).
    /// [`ImageTier::None`] installs nothing and succeeds, unless an existing
    /// `RYU_SD_MODEL` needs the binary.
    pub async fn ensure_installed_for_tier(
        &self,
        downloads: &crate::downloads::DownloadCenter,
        tier: ImageTier,
    ) -> Result<String> {
        if tier == ImageTier::None && !sd_model_override_present() {
            return Ok(TARGET_VERSION.to_string());
        }
        self.ensure_binary(downloads).await?;
        self.ensure_default_model(downloads, tier).await?;
        Ok(TARGET_VERSION.to_string())
    }

    #[cfg(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64")
    ))]
    async fn ensure_binary(&self, downloads: &crate::downloads::DownloadCenter) -> Result<()> {
        let dest = server_binary_path();
        let store = VersionStore::load();
        if dest.exists() && store.versions.get("sdcpp").map(String::as_str) == Some(TARGET_VERSION)
        {
            tracing::info!("sd-server {TARGET_VERSION} already installed — skipping");
            return Ok(());
        }

        let url = archive_url();
        tracing::info!("downloading stable-diffusion.cpp from {url}");

        // Download the archive through the center to a deterministic temp dest,
        // then read it back to extract.
        let archive_dest = tmp_dir().join(format!("sdcpp-{TARGET_VERSION}.zip"));
        let archive_path = downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Media,
                role: crate::downloads::DownloadRole::Engine,
                label: "stable-diffusion.cpp".to_string(),
                url,
                dest: archive_dest,
                sha256: Some(PLATFORM_SHA256.to_string()),
                version_record: None,
            })
            .await
            .context("downloading stable-diffusion.cpp archive")?;
        // Streamed from disk rather than read whole into memory first.
        let archive = std::io::BufReader::new(
            std::fs::File::open(&archive_path)
                .context("opening downloaded stable-diffusion.cpp archive")?,
        );

        // Extract the whole archive — sd-server links against a sibling shared
        // library (Windows `stable-diffusion.dll`, macOS `.dylib`, Linux `.so`),
        // so they must land together in the engine's own dir. Clear the previous
        // build first so an upgrade never leaves a stale library beside the new
        // binary.
        let engine = install_dir();
        if engine.exists() {
            tokio::fs::remove_dir_all(&engine)
                .await
                .with_context(|| format!("clearing {}", engine.display()))?;
        }
        let extract_to = engine.clone();
        let written =
            tokio::task::spawn_blocking(move || extract_all_to_dir_from(archive, &extract_to))
                .await
                .context("spawn_blocking for zip extraction")??;

        let server_name = server_binary_path()
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("sd-server")
            .to_string();
        if !written.iter().any(|f| f == &server_name) {
            anyhow::bail!(
                "stable-diffusion.cpp archive did not contain {server_name} (got: {})",
                written.join(", ")
            );
        }

        // The zip extractor does not preserve unix exec bits, so the extracted
        // `sd-server` (and any sibling `sd-*` executables) would be non-runnable.
        // Mark them executable on unix (mirrors how the whisper/llama binaries are
        // chmod'd after extraction).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for f in &written {
                if f.starts_with("sd-") && !f.contains('.') {
                    let path = engine.join(f);
                    if let Ok(meta) = std::fs::metadata(&path) {
                        let mut perms = meta.permissions();
                        perms.set_mode(0o755);
                        let _ = std::fs::set_permissions(&path, perms);
                    }
                }
            }
        }

        // The size of the extracted binary rides along as the checksum, so a later
        // operator swap to a GPU build is recognised (`bundled_cpu_server_in_use`).
        VersionStore::record_persisted(
            "sdcpp",
            TARGET_VERSION,
            &binary_fingerprint(&server_binary_path()).unwrap_or_default(),
        )
        .context("writing versions.json")?;

        // The extracted binaries are in place; drop the temp archive.
        let _ = tokio::fs::remove_file(&archive_path).await;

        tracing::info!(
            "stable-diffusion.cpp {TARGET_VERSION} installed ({} files) at {}",
            written.len(),
            dest.display()
        );
        Ok(())
    }

    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64")
    )))]
    async fn ensure_binary(&self, _downloads: &crate::downloads::DownloadCenter) -> Result<()> {
        let dest = server_binary_path();
        if dest.exists() {
            return Ok(());
        }
        anyhow::bail!(
            "stable-diffusion.cpp has no prebuilt server binary for this platform \
             (supported: Windows x64, macOS arm64, Linux x86_64). Build it from source \
             (e.g. `cmake -B build -DSD_BUILD_EXAMPLES=ON && cmake --build build --config \
             Release`) and place the resulting `sd-server` binary at {}.",
            dest.display()
        );
    }

    /// Download `tier`'s image default into `models/image/sdcpp/` if absent —
    /// only that tier's files. Standard: the stable-diffusion.cpp-compatible
    /// Qwen Image 2.1 GGUF, Qwen3-VL text and vision encoders, and matching VAE.
    /// Lite: the single-file SDXL base checkpoint. Honors a `RYU_SD_MODEL`
    /// override pointing at an existing file (companions are then unknown to the
    /// engine, so it is spawned with `-m` alone).
    async fn ensure_default_model(
        &self,
        downloads: &crate::downloads::DownloadCenter,
        tier: ImageTier,
    ) -> Result<()> {
        if sd_model_override_present() {
            tracing::info!("RYU_SD_MODEL set to an existing file — skipping model download");
            return Ok(());
        }

        let models_dir = image_models_dir();
        tokio::fs::create_dir_all(&models_dir)
            .await
            .with_context(|| format!("creating {}", models_dir.display()))?;

        match tier {
            ImageTier::Standard => self.ensure_standard_stack(downloads).await?,
            ImageTier::Lite => self.ensure_lite_model(downloads).await?,
            ImageTier::None => return Ok(()),
        }
        tracing::info!("stable diffusion model installed ({} tier)", tier.as_str());
        Ok(())
    }

    /// The Lite checkpoint. A file already at the path is kept even without a
    /// version-store row: it is the same pinned artifact the SDXL default used
    /// to bundle, and re-fetching 2.8 GB to stamp a row would only cost the user.
    async fn ensure_lite_model(&self, downloads: &crate::downloads::DownloadCenter) -> Result<()> {
        if lite_model_installed() {
            tracing::info!("SDXL base (Q4_K) already present — skipping");
            return Ok(());
        }
        self.ensure_file(
            downloads,
            crate::downloads::DownloadKind::Media,
            crate::downloads::DownloadRole::ImageModel,
            "SDXL base 1.0 (Q4_K)",
            LITE_MODEL_URL,
            lite_model_path(),
            LITE_MODEL_STORE_KEY,
            LITE_MODEL_FILE,
            Some(LITE_MODEL_SHA256),
        )
        .await
    }

    async fn ensure_standard_stack(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<()> {
        self.ensure_file(
            downloads,
            crate::downloads::DownloadKind::Media,
            crate::downloads::DownloadRole::ImageModel,
            "Qwen Image 2.1 (Q4_K)",
            DEFAULT_MODEL_URL,
            default_model_path(),
            MODEL_STORE_KEY,
            DEFAULT_MODEL_FILE,
            Some(DEFAULT_MODEL_SHA256),
        )
        .await?;
        self.ensure_file(
            downloads,
            crate::downloads::DownloadKind::Media,
            crate::downloads::DownloadRole::ImageModel,
            "Qwen Image 2.1 VAE",
            DEFAULT_VAE_URL,
            image_vae_path(),
            VAE_STORE_KEY,
            DEFAULT_VAE_FILE,
            Some(DEFAULT_VAE_SHA256),
        )
        .await?;
        self.ensure_file(
            downloads,
            crate::downloads::DownloadKind::Media,
            crate::downloads::DownloadRole::ImageModel,
            "Qwen3-VL-8B text encoder (Q4_K_M)",
            DEFAULT_LLM_URL,
            image_llm_path(),
            LLM_STORE_KEY,
            DEFAULT_LLM_FILE,
            Some(DEFAULT_LLM_SHA256),
        )
        .await?;
        self.ensure_file(
            downloads,
            crate::downloads::DownloadKind::Media,
            crate::downloads::DownloadRole::ImageModel,
            "Qwen3-VL-8B vision projector (F16)",
            DEFAULT_LLM_VISION_URL,
            image_llm_vision_path(),
            LLM_VISION_STORE_KEY,
            DEFAULT_LLM_VISION_FILE,
            Some(DEFAULT_LLM_VISION_SHA256),
        )
        .await?;
        Ok(())
    }

    /// Download the default video model into `models/video/sdcpp/` if absent: the Wan2.1
    /// T2V 1.3B diffusion transformer plus the umt5-xxl text encoder and Wan VAE.
    /// Called lazily by [`StableDiffusionManager`](crate::sidecar::providers::sdcpp::StableDiffusionManager)
    /// when a video model is the active diffusion model. Each file that already
    /// exists is skipped individually. Refuses before downloading anything when
    /// the ~6.0 GB stack does not fit this node's RAM or free disk
    /// ([`video_stack_block_reason`]); an unknown never refuses.
    pub async fn ensure_video_default(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<()> {
        if let Some(reason) = video_stack_block_reason(&DeviceInfo::detect()) {
            anyhow::bail!("{reason}. Video generation needs a bigger node or a cloud provider.");
        }
        let models_dir = video_models_dir();
        tokio::fs::create_dir_all(&models_dir)
            .await
            .with_context(|| format!("creating {}", models_dir.display()))?;

        self.ensure_file(
            downloads,
            crate::downloads::DownloadKind::Media,
            crate::downloads::DownloadRole::VideoModel,
            "Wan2.1 T2V 1.3B video model (Q8_0)",
            VIDEO_MODEL_URL,
            video_model_path(),
            VIDEO_MODEL_STORE_KEY,
            VIDEO_MODEL_FILE,
            None,
        )
        .await?;
        self.ensure_file(
            downloads,
            crate::downloads::DownloadKind::Media,
            crate::downloads::DownloadRole::VideoModel,
            "umt5-xxl text encoder (Q5_K_M)",
            VIDEO_T5XXL_URL,
            video_t5xxl_path(),
            VIDEO_T5XXL_STORE_KEY,
            VIDEO_T5XXL_FILE,
            Some(VIDEO_T5XXL_SHA256),
        )
        .await?;
        self.ensure_file(
            downloads,
            crate::downloads::DownloadKind::Media,
            crate::downloads::DownloadRole::VideoModel,
            "Wan 2.1 VAE",
            VIDEO_VAE_URL,
            video_vae_path(),
            VIDEO_VAE_STORE_KEY,
            VIDEO_VAE_FILE,
            Some(VIDEO_VAE_SHA256),
        )
        .await?;

        tracing::info!("Wan2.1 video model installed");
        Ok(())
    }

    /// Download the companion encoders a Wan image-to-video or
    /// first/last-frame model needs, skipping each one already installed. The
    /// diffusion transformer itself is the user's catalog install; this only
    /// fetches what [`super::frame_models::WanFrameModel::companions`] lists.
    /// Called lazily by `StableDiffusionManager::start` when such a model is
    /// the active diffusion model, never at onboarding.
    pub async fn ensure_frame_companions(
        &self,
        downloads: &crate::downloads::DownloadCenter,
        companions: &[super::frame_models::FrameCompanion],
    ) -> Result<()> {
        let models_dir = video_models_dir();
        tokio::fs::create_dir_all(&models_dir)
            .await
            .with_context(|| format!("creating {}", models_dir.display()))?;
        for companion in companions {
            let source = frame_companion_source(*companion);
            self.ensure_file(
                downloads,
                crate::downloads::DownloadKind::Media,
                crate::downloads::DownloadRole::VideoModel,
                source.label,
                source.url,
                companion.path(),
                source.store_key,
                source.version,
                Some(source.sha256),
            )
            .await?;
        }
        Ok(())
    }

    /// Download one diffusion weight file unless it is already installed (file
    /// present AND recorded in the version store). Each file carries its own
    /// store key so the fast-path skip works per artifact.
    async fn ensure_file(
        &self,
        downloads: &crate::downloads::DownloadCenter,
        kind: crate::downloads::DownloadKind,
        role: crate::downloads::DownloadRole,
        label: &str,
        url: &str,
        dest: PathBuf,
        store_key: &str,
        version: &str,
        sha256: Option<&str>,
    ) -> Result<()> {
        if dest.exists() && VersionStore::load().checksums.contains_key(store_key) {
            tracing::info!("{label} already installed — skipping");
            return Ok(());
        }

        tracing::info!("downloading {label} from {url}");
        downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind,
                role,
                label: label.to_string(),
                url: url.to_string(),
                dest,
                sha256: sha256.map(str::to_owned),
                version_record: Some(crate::downloads::VersionRecord {
                    store_key: store_key.to_string(),
                    version: version.to_string(),
                }),
            })
            .await
            .context(format!("downloading {label}"))?;
        Ok(())
    }
}

/// Where a Wan frame-model companion downloads from. Every entry is pinned to
/// a source-repo commit and carries its LFS SHA-256.
struct FrameCompanionSource {
    label: &'static str,
    url: &'static str,
    store_key: &'static str,
    version: &'static str,
    sha256: &'static str,
}

fn frame_companion_source(companion: super::frame_models::FrameCompanion) -> FrameCompanionSource {
    use super::frame_models::FrameCompanion;
    match companion {
        FrameCompanion::TextEncoder => FrameCompanionSource {
            label: "umt5-xxl text encoder (Q5_K_M)",
            url: VIDEO_T5XXL_URL,
            store_key: VIDEO_T5XXL_STORE_KEY,
            version: VIDEO_T5XXL_FILE,
            sha256: VIDEO_T5XXL_SHA256,
        },
        FrameCompanion::Wan21Vae => FrameCompanionSource {
            label: "Wan 2.1 VAE",
            url: VIDEO_VAE_URL,
            store_key: VIDEO_VAE_STORE_KEY,
            version: VIDEO_VAE_FILE,
            sha256: VIDEO_VAE_SHA256,
        },
        FrameCompanion::Wan22Vae => FrameCompanionSource {
            label: "Wan 2.2 VAE",
            url: VIDEO_WAN22_VAE_URL,
            store_key: VIDEO_WAN22_VAE_STORE_KEY,
            version: VIDEO_WAN22_VAE_FILE,
            sha256: VIDEO_WAN22_VAE_SHA256,
        },
        FrameCompanion::ClipVision => FrameCompanionSource {
            label: "CLIP-vision H image encoder",
            url: VIDEO_CLIP_VISION_URL,
            store_key: VIDEO_CLIP_VISION_STORE_KEY,
            version: VIDEO_CLIP_VISION_FILE,
            sha256: VIDEO_CLIP_VISION_SHA256,
        },
    }
}

impl Default for StableDiffusionDownloader {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    #[cfg(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64")
    ))]
    #[test]
    fn platform_archive_has_a_pinned_sha256() {
        assert_eq!(super::PLATFORM_SHA256.len(), 64);
        assert!(super::PLATFORM_SHA256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit()));
    }

    use super::{
        image_tier_warning, media_stack_block_reason, select_image_tier, ImageTier,
        ImageTierInputs, LITE_STACK_BYTES, STANDARD_STACK_BYTES, VIDEO_STACK_BYTES,
    };
    use crate::model_catalog::device::DeviceInfo;

    const GIB: u64 = 1024 * 1024 * 1024;

    fn device(ram_gib: Option<u64>, disk_gib: Option<u64>) -> DeviceInfo {
        let total_ram_bytes = ram_gib.map(|g| g * GIB);
        let disk_free_bytes = disk_gib.map(|g| g * GIB);
        DeviceInfo {
            ram_human: total_ram_bytes
                .map(crate::model_catalog::device::human_bytes)
                .unwrap_or_default(),
            total_ram_bytes,
            vram_bytes: None,
            vram_human: String::new(),
            gpu_name: None,
            gpu_vendor: None,
            unified_memory: false,
            os: "linux".into(),
            disk_free_human: disk_free_bytes
                .map(crate::model_catalog::device::human_bytes)
                .unwrap_or_default(),
            disk_free_bytes,
        }
    }

    /// Nothing installed, no `RYU_IMAGE_TIER`.
    fn fresh() -> ImageTierInputs {
        ImageTierInputs {
            standard_missing_bytes: STANDARD_STACK_BYTES,
            lite_missing_bytes: LITE_STACK_BYTES,
            requested: None,
        }
    }

    fn tier(ram_gib: Option<u64>, disk_gib: Option<u64>, inputs: ImageTierInputs) -> ImageTier {
        select_image_tier(&device(ram_gib, disk_gib), &inputs).tier
    }

    #[test]
    fn stack_sizes_match_the_pinned_files() {
        assert_eq!(STANDARD_STACK_BYTES, 11_059_819_128);
        assert_eq!(LITE_STACK_BYTES, 2_797_752_960);
        assert_eq!(VIDEO_STACK_BYTES, 5_986_777_686);
    }

    #[test]
    fn standard_needs_about_14_gib_of_ram_and_room_on_disk() {
        assert_eq!(tier(Some(32), Some(500), fresh()), ImageTier::Standard);
        assert_eq!(tier(Some(16), Some(500), fresh()), ImageTier::Standard);
        // 13.9 GiB need: a 12 GiB or 8 GiB machine gets Lite.
        assert_eq!(tier(Some(12), Some(500), fresh()), ImageTier::Lite);
        assert_eq!(tier(Some(8), Some(500), fresh()), ImageTier::Lite);
        // Plenty of RAM but too little disk for 10.3 GiB + 2 GiB reserve.
        assert_eq!(tier(Some(32), Some(10), fresh()), ImageTier::Lite);
        // Disk unknown never downgrades.
        assert_eq!(tier(Some(32), None, fresh()), ImageTier::Standard);
    }

    #[test]
    fn a_machine_that_fits_neither_gets_no_local_image_model() {
        // Lite needs ~4.6 GiB of RAM and ~4.6 GiB of disk (2.6 GiB + 2 GiB).
        assert_eq!(tier(Some(4), Some(500), fresh()), ImageTier::None);
        assert_eq!(tier(Some(32), Some(4), fresh()), ImageTier::None);
        let choice = select_image_tier(&device(Some(4), Some(500)), &fresh());
        let warning = image_tier_warning(&choice).unwrap();
        assert!(warning.contains("cloud provider"), "{warning}");
        assert!(warning.contains("this computer has 4.0 GB"), "{warning}");
    }

    #[test]
    fn unknown_ram_picks_lite_but_keeps_an_installed_standard_stack() {
        assert_eq!(tier(None, Some(500), fresh()), ImageTier::Lite);
        let installed = ImageTierInputs {
            standard_missing_bytes: 0,
            ..fresh()
        };
        assert_eq!(tier(None, Some(500), installed), ImageTier::Standard);
        // Installed but known too small: Lite, never a crash-sized default.
        assert_eq!(tier(Some(8), Some(500), installed), ImageTier::Lite);
        // An installed stack needs no disk.
        assert_eq!(tier(Some(32), Some(1), installed), ImageTier::Standard);
    }

    #[test]
    fn downgrade_reasons_carry_the_numbers() {
        let choice = select_image_tier(&device(Some(8), Some(500)), &fresh());
        assert_eq!(choice.tier, ImageTier::Lite);
        let reason = choice.downgrade_reason.unwrap();
        assert!(reason.contains("Qwen Image 2.1"), "{reason}");
        assert!(reason.contains("this computer has 8.0 GB"), "{reason}");

        let choice = select_image_tier(&device(Some(32), Some(10)), &fresh());
        assert!(choice
            .downgrade_reason
            .unwrap()
            .contains("only 10.0 GB is free"));
        assert_eq!(
            image_tier_warning(&select_image_tier(&device(Some(32), Some(500)), &fresh())),
            None
        );
    }

    #[test]
    fn requested_tier_can_lower_but_never_raise_past_the_hardware() {
        let request = |t| ImageTierInputs {
            requested: Some(t),
            ..fresh()
        };
        assert_eq!(
            tier(Some(32), Some(500), request(ImageTier::Lite)),
            ImageTier::Lite
        );
        assert_eq!(
            tier(Some(32), Some(500), request(ImageTier::None)),
            ImageTier::None
        );
        assert_eq!(
            tier(Some(8), Some(500), request(ImageTier::Standard)),
            ImageTier::Lite
        );
        assert_eq!(
            tier(Some(4), Some(500), request(ImageTier::Lite)),
            ImageTier::None
        );
        // Unknown RAM never refuses an explicit request.
        assert_eq!(
            tier(None, Some(500), request(ImageTier::Standard)),
            ImageTier::Standard
        );
        // …but known-short disk still does.
        assert_eq!(
            tier(None, Some(10), request(ImageTier::Standard)),
            ImageTier::Lite
        );
        assert_eq!(ImageTier::parse(" Standard "), Some(ImageTier::Standard));
        assert_eq!(ImageTier::parse("off"), Some(ImageTier::None));
        assert_eq!(ImageTier::parse("huge"), None);
    }

    #[test]
    fn image_tier_serializes_as_snake_case() {
        assert_eq!(serde_json::to_string(&ImageTier::Lite).unwrap(), "\"lite\"");
        assert_eq!(ImageTier::None.as_str(), "none");
    }

    #[test]
    fn video_stack_is_refused_when_ram_or_disk_is_short_and_never_on_unknowns() {
        let reason = media_stack_block_reason(
            "Wan",
            VIDEO_STACK_BYTES,
            VIDEO_STACK_BYTES,
            &device(Some(4), Some(500)),
        )
        .unwrap();
        assert!(reason.contains("memory"), "{reason}");
        let reason = media_stack_block_reason(
            "Wan",
            VIDEO_STACK_BYTES,
            VIDEO_STACK_BYTES,
            &device(Some(16), Some(6)),
        )
        .unwrap();
        assert!(reason.contains("free disk"), "{reason}");
        assert_eq!(
            media_stack_block_reason(
                "Wan",
                VIDEO_STACK_BYTES,
                VIDEO_STACK_BYTES,
                &device(Some(16), Some(500))
            ),
            None
        );
        assert_eq!(
            media_stack_block_reason(
                "Wan",
                VIDEO_STACK_BYTES,
                VIDEO_STACK_BYTES,
                &device(None, None)
            ),
            None
        );
        // Already downloaded: disk no longer matters.
        assert_eq!(
            media_stack_block_reason("Wan", VIDEO_STACK_BYTES, 0, &device(Some(16), Some(1))),
            None
        );
    }

    #[test]
    fn lite_artifact_is_pinned_to_a_commit_with_its_sha256() {
        assert!(super::LITE_MODEL_URL.contains(
            "/resolve/ca58fb3aced770f3dffddabf01725b29207305ef/sd_xl_base_1.0_0_Q4_K.gguf"
        ));
        assert_eq!(super::LITE_MODEL_SHA256.len(), 64);
        assert_eq!(
            super::LITE_MODEL_FILE,
            format!("{}.gguf", super::LEGACY_SDXL_DEFAULT_STEM)
        );
    }

    #[test]
    fn frame_model_companions_are_pinned_to_a_commit_and_checksum() {
        use super::super::frame_models::FrameCompanion;
        for companion in [
            FrameCompanion::TextEncoder,
            FrameCompanion::Wan21Vae,
            FrameCompanion::Wan22Vae,
            FrameCompanion::ClipVision,
        ] {
            let source = super::frame_companion_source(companion);
            let url = source.url;
            assert!(!url.contains("/resolve/main/"), "{url} is not pinned");
            let commit = url
                .split("/resolve/")
                .nth(1)
                .and_then(|rest| rest.split('/').next())
                .unwrap_or_default();
            assert_eq!(commit.len(), 40, "{url} is not pinned to a commit");
            assert_eq!(source.sha256.len(), 64, "{url}");
            assert!(source.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()));
            // The download lands where the launch plan points `sd-server`.
            let file = companion.path();
            let name = file.file_name().and_then(|name| name.to_str()).unwrap();
            assert!(url.ends_with(&format!("/{name}")), "{url} vs {name}");
            assert_eq!(source.version, name);
        }
    }

    #[test]
    fn a_gpu_build_is_sized_against_vram_not_host_ram() {
        let mut gpu_box = device(Some(12), Some(500));
        gpu_box.vram_bytes = Some(24 * GIB);
        gpu_box.vram_human = "24 GB".into();
        // The bundled CPU build is refused for 12 GiB of RAM; a swapped-in GPU
        // build loads the same stack into 24 GiB of VRAM.
        assert!(media_stack_block_reason(
            "Standard",
            STANDARD_STACK_BYTES,
            0,
            &super::memory_pool_device(&gpu_box, true)
        )
        .is_some());
        assert!(media_stack_block_reason(
            "Standard",
            STANDARD_STACK_BYTES,
            0,
            &super::memory_pool_device(&gpu_box, false)
        )
        .is_none());
        // A GPU build never shrinks the pool below host RAM.
        let mut small_gpu = device(Some(32), Some(500));
        small_gpu.vram_bytes = Some(4 * GIB);
        assert_eq!(
            super::memory_pool_device(&small_gpu, false).total_ram_bytes,
            Some(32 * GIB)
        );
    }

    #[test]
    fn only_an_unmodified_pinned_install_counts_as_the_cpu_build() {
        use super::bundled_cpu_server_matches as cpu;
        // Operator-placed: Core never recorded an install.
        assert!(!cpu(None, None, Some("size:10")));
        // Installed by Core, binary untouched.
        assert!(cpu(Some("v"), Some("size:10"), Some("size:10")));
        // Swapped for another build after the install.
        assert!(!cpu(Some("v"), Some("size:10"), Some("size:99")));
        assert!(!cpu(Some("v"), Some("size:10"), None));
        // Installs from before the fingerprint existed keep their RAM guard.
        assert!(cpu(Some("v"), None, Some("size:10")));
        assert!(cpu(Some("v"), Some(""), Some("size:10")));
    }

    #[test]
    fn default_image_artifact_is_pinned_qwen_image_2_1() {
        assert_eq!(super::DEFAULT_MODEL_FILE, "qwen_image_2.1-Q4_K.gguf");
        assert!(super::DEFAULT_MODEL_URL.contains("leejet/Qwen-Image-2.1-GGUF/resolve/"));
        assert_eq!(super::IMAGE_DEFAULT_STEM, "qwen_image_2.1-Q4_K");
        assert!(super::is_qwen_image_stem("qwen_image_2.1-Q8_0"));
        assert_eq!(
            super::DEFAULT_VAE_FILE,
            "qwen_image_2.1_vae_bf16.safetensors"
        );
        assert_eq!(super::DEFAULT_LLM_FILE, "Qwen3VL-8B-Instruct-Q4_K_M.gguf");
        assert_ne!(super::IMAGE_DEFAULT_STEM, super::LEGACY_IMAGE_DEFAULT_STEM);
        assert_ne!(super::IMAGE_DEFAULT_STEM, super::LEGACY_SDXL_DEFAULT_STEM);
    }
}
