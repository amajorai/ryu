//! Which **build** of llama.cpp this node runs: the CPU build, or one of the
//! accelerated builds (Metal, CUDA, Vulkan).
//!
//! Upstream publishes one release archive per backend, and they are not
//! interchangeable — a CUDA archive will not load without an NVIDIA driver, a
//! Vulkan archive needs a Vulkan ICD, and the CPU archive runs anywhere. Ryu
//! picks for the user: [`LlamaVariant::resolve`] reads the machine's detected
//! GPU and answers with the fastest build that machine can actually run,
//! falling back to `Cpu` on hardware with no usable GPU. A user who wants to
//! override that (a broken driver, an OOM-ing card, a deliberate CPU run) picks
//! a variant explicitly and it is honoured — except that an accelerated variant
//! is **refused** on a node with no usable GPU, because installing it there
//! produces a binary that cannot start.
//!
//! Only one variant is installed at a time. It lives in its own directory
//! (`<data dir>/engines/chat/llamacpp/`) rather than loose in `bin/`, because the
//! backends ship *different* `ggml-*` shared libraries under the *same* names:
//! extracting Vulkan over CUDA in a shared directory leaves a mixed set that
//! llama.cpp's dynamic backend loader will happily pick up and fail on. The
//! directory is wiped whenever the variant changes, so the resident set is
//! always exactly one backend's files.

use std::path::PathBuf;

use crate::model_catalog::device::{has_usable_gpu, DeviceInfo, GpuVendor};
use crate::sidecar::download_manager::engine_dir;
use ryu_sidecar_runtime::layout::EngineGroup;

/// Preference key holding the user's acceleration choice: `auto` (the default)
/// or one of [`LlamaVariant::as_str`].
pub const VARIANT_PREF: &str = "engine.llamacpp.variant";

/// The literal stored in [`VARIANT_PREF`] meaning "let Ryu pick for this
/// machine". This is the default, and the only value most users ever have.
pub const AUTO: &str = "auto";

/// A llama.cpp release backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LlamaVariant {
    /// Portable CPU build. Runs on every machine Ryu supports.
    Cpu,
    /// Apple Metal. macOS on Apple Silicon only — and it is the *same* archive
    /// as the macOS CPU build (upstream ships no separate CPU asset for Apple
    /// Silicon), so on that platform the two variants differ only by whether
    /// layers are offloaded to the GPU at launch.
    Metal,
    /// NVIDIA CUDA. Windows x64 only — upstream publishes no Linux CUDA binary
    /// release, so Linux NVIDIA machines take the Vulkan path.
    Cuda,
    /// Vulkan: one archive that covers NVIDIA, AMD and Intel GPUs with no
    /// vendor runtime to install. The default accelerated path everywhere CUDA
    /// is unavailable.
    Vulkan,
}

impl LlamaVariant {
    pub fn as_str(self) -> &'static str {
        match self {
            LlamaVariant::Cpu => "cpu",
            LlamaVariant::Metal => "metal",
            LlamaVariant::Cuda => "cuda",
            LlamaVariant::Vulkan => "vulkan",
        }
    }

    /// Parse a stored/requested variant name. `auto` is deliberately NOT a
    /// variant — it is the absence of a choice, resolved by [`Self::resolve`].
    pub fn parse(s: &str) -> Option<LlamaVariant> {
        match s.trim().to_ascii_lowercase().as_str() {
            "cpu" => Some(LlamaVariant::Cpu),
            "metal" => Some(LlamaVariant::Metal),
            "cuda" => Some(LlamaVariant::Cuda),
            "vulkan" => Some(LlamaVariant::Vulkan),
            _ => None,
        }
    }

    /// Plain-language name for a picker. Deliberately free of jargon the user
    /// would have to look up: the acronym is in `as_str`, the sentence is here.
    pub fn label(self) -> &'static str {
        match self {
            LlamaVariant::Cpu => "CPU only",
            LlamaVariant::Metal => "Apple GPU (Metal)",
            LlamaVariant::Cuda => "NVIDIA GPU (CUDA)",
            LlamaVariant::Vulkan => "GPU (Vulkan)",
        }
    }

    /// One line explaining the trade-off, for the same picker.
    pub fn description(self) -> &'static str {
        match self {
            LlamaVariant::Cpu => "Works on any machine. Slower, but never fails to start.",
            LlamaVariant::Metal => "Runs on your Mac's built-in GPU. Fastest option here.",
            LlamaVariant::Cuda => "Runs on your NVIDIA graphics card. Fastest option here.",
            LlamaVariant::Vulkan => "Runs on your graphics card. Much faster than CPU.",
        }
    }

    /// True for the builds that need a working GPU driver to start at all.
    pub fn needs_gpu(self) -> bool {
        !matches!(self, LlamaVariant::Cpu)
    }

    /// The upstream release-asset platform slug for this variant on THIS
    /// platform, or `None` when upstream publishes no such build here (e.g.
    /// Vulkan on macOS, CUDA anywhere but Windows x64).
    pub fn asset_slug(self) -> Option<&'static str> {
        match self {
            LlamaVariant::Cpu => Some(cpu_slug()),
            LlamaVariant::Metal => {
                // Metal is compiled into the macOS arm64 build; there is no
                // separate asset. Intel Macs have no Metal-capable build.
                (cfg!(target_os = "macos") && cfg!(target_arch = "aarch64"))
                    .then_some("macos-arm64")
            }
            LlamaVariant::Cuda => (cfg!(target_os = "windows") && cfg!(target_arch = "x86_64"))
                .then(cuda_slug)
                .flatten(),
            LlamaVariant::Vulkan => {
                if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
                    Some("win-vulkan-x64")
                } else if cfg!(target_os = "linux") {
                    if cfg!(target_arch = "aarch64") {
                        Some("ubuntu-vulkan-arm64")
                    } else {
                        Some("ubuntu-vulkan-x64")
                    }
                } else {
                    None
                }
            }
        }
    }

    /// Whether this variant can be installed on this node *right now*: upstream
    /// publishes the build for this platform, AND (for accelerated builds) the
    /// machine actually has a GPU worth running it on.
    ///
    /// This is the gate behind "don't offer the GPU build on GPU-less
    /// hardware": a `false` here means the install path refuses and the picker
    /// shows the option disabled with [`Self::unavailable_reason`].
    pub fn available_on(self, device: &DeviceInfo) -> bool {
        if self.asset_slug().is_none() {
            return false;
        }
        if !self.needs_gpu() {
            return true;
        }
        if !has_usable_gpu(device) {
            return false;
        }
        match self {
            // CUDA needs an NVIDIA card specifically; a Radeon with 24 GB of
            // VRAM clears the usable-GPU floor but cannot run a CUDA build.
            LlamaVariant::Cuda => device.gpu_vendor == Some(GpuVendor::Nvidia),
            LlamaVariant::Metal => device.gpu_vendor == Some(GpuVendor::Apple),
            _ => true,
        }
    }

    /// Why this variant is not offered, in words a non-technical user can act
    /// on. `None` when it *is* available.
    pub fn unavailable_reason(self, device: &DeviceInfo) -> Option<&'static str> {
        if self.available_on(device) {
            return None;
        }
        if self.asset_slug().is_none() {
            return Some("Not available for this computer's operating system");
        }
        Some(match self {
            LlamaVariant::Cuda => "Needs an NVIDIA graphics card",
            LlamaVariant::Metal => "Needs an Apple Silicon Mac",
            _ => "No graphics card detected on this computer",
        })
    }

    /// The build to install on `device`, honouring an explicit `requested`
    /// choice when it is installable and falling back to the best build this
    /// machine can run otherwise.
    ///
    /// `requested` is the raw preference value: `auto`/empty (the default) means
    /// "decide for me". An explicit accelerated choice on a machine that cannot
    /// run it degrades to the auto answer rather than failing — the user asked
    /// for a working engine, not for a specific archive.
    pub fn resolve(requested: Option<&str>, device: &DeviceInfo) -> LlamaVariant {
        let auto = Self::auto_for(device);
        match requested.map(str::trim).filter(|s| !s.is_empty()) {
            None => auto,
            Some(s) if s.eq_ignore_ascii_case(AUTO) => auto,
            Some(s) => match Self::parse(s) {
                Some(v) if v.available_on(device) => v,
                Some(v) => {
                    tracing::warn!(
                        "llama.cpp variant '{}' requested but not installable here ({}); \
                         using '{}' instead",
                        v.as_str(),
                        v.unavailable_reason(device).unwrap_or("unsupported"),
                        auto.as_str()
                    );
                    auto
                }
                None => {
                    tracing::warn!("unknown llama.cpp variant '{s}'; using '{}'", auto.as_str());
                    auto
                }
            },
        }
    }

    /// The fastest build this machine can actually run. Order of preference:
    /// Metal on Apple Silicon, CUDA on Windows + NVIDIA, Vulkan on any other
    /// machine with a usable GPU, CPU otherwise.
    pub fn auto_for(device: &DeviceInfo) -> LlamaVariant {
        for candidate in [
            LlamaVariant::Metal,
            LlamaVariant::Cuda,
            LlamaVariant::Vulkan,
        ] {
            if candidate.available_on(device) {
                return candidate;
            }
        }
        LlamaVariant::Cpu
    }

    /// Every variant, in picker order.
    pub const ALL: &'static [LlamaVariant] = &[
        LlamaVariant::Cpu,
        LlamaVariant::Metal,
        LlamaVariant::Cuda,
        LlamaVariant::Vulkan,
    ];
}

/// The portable CPU asset for this platform. Note `ubuntu-arm64`: upstream does
/// publish an ARM Linux build, which an older fallback here mapped to the x64
/// asset (an archive that cannot execute on ARM).
fn cpu_slug() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        #[cfg(target_arch = "x86_64")]
        return "win-cpu-x64";
        #[cfg(not(target_arch = "x86_64"))]
        return "win-cpu-arm64";
    }
    #[cfg(target_os = "macos")]
    {
        // No separate CPU asset exists for macOS; the platform build is used
        // with GPU offload switched off at launch (see `LaunchConfig`).
        #[cfg(target_arch = "aarch64")]
        return "macos-arm64";
        #[cfg(not(target_arch = "aarch64"))]
        return "macos-x64";
    }
    #[cfg(target_os = "linux")]
    {
        #[cfg(target_arch = "aarch64")]
        return "ubuntu-arm64";
        #[cfg(not(target_arch = "aarch64"))]
        return "ubuntu-x64";
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    return "ubuntu-x64";
}

/// Upstream ships two Windows CUDA builds, one per CUDA major line. The driver
/// reports the highest CUDA runtime it supports in `nvidia-smi`'s header
/// (`CUDA Version: 13.0`); pick the newest build that driver can load, and
/// answer `None` when the driver is too old for either — the caller then falls
/// through to Vulkan rather than installing a build that cannot initialize.
#[cfg(target_os = "windows")]
fn cuda_slug() -> Option<&'static str> {
    match driver_cuda_version() {
        Some((major, minor)) if major > 13 || (major == 13 && minor >= 3) => {
            Some("win-cuda-13.3-x64")
        }
        Some((major, minor)) if major > 12 || (major == 12 && minor >= 4) => {
            Some("win-cuda-12.4-x64")
        }
        _ => None,
    }
}

#[cfg(not(target_os = "windows"))]
fn cuda_slug() -> Option<&'static str> {
    None
}

/// Highest CUDA runtime version the installed NVIDIA driver supports, parsed
/// from `nvidia-smi`'s banner line. Cached: the driver cannot change while Core
/// runs, and the probe spawns a process.
#[cfg(target_os = "windows")]
fn driver_cuda_version() -> Option<(u32, u32)> {
    use crate::win_process::NoWindow;
    use std::sync::OnceLock;
    static CACHED: OnceLock<Option<(u32, u32)>> = OnceLock::new();
    *CACHED.get_or_init(|| {
        let out = std::process::Command::new("nvidia-smi")
            .no_window()
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        parse_cuda_banner(&String::from_utf8_lossy(&out.stdout))
    })
}

/// Extract `(major, minor)` from an `nvidia-smi` banner containing
/// `CUDA Version: 12.4`. Split out so it is testable on every platform.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
fn parse_cuda_banner(stdout: &str) -> Option<(u32, u32)> {
    let idx = stdout.find("CUDA Version:")?;
    let rest = stdout[idx + "CUDA Version:".len()..].trim_start();
    let token: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let (major, minor) = token.split_once('.')?;
    Some((major.parse().ok()?, minor.parse().ok()?))
}

// ── Install layout ────────────────────────────────────────────────────────────

/// Directory holding the currently installed llama.cpp build (binaries plus the
/// backend's own `ggml-*` shared libraries). One variant at a time; wiped on a
/// variant change so two backends' libraries never mix.
pub fn install_dir() -> PathBuf {
    engine_dir(EngineGroup::Chat, "llamacpp")
}

/// Executable name with the platform's extension.
pub fn exe_name(stem: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

/// Path to the installed `llama-server`. This is the single resolver every
/// llama.cpp consumer uses (chat engine, embeddings, reranker, classifier), so
/// the install layout is defined in exactly one place.
pub fn server_path() -> PathBuf {
    install_dir().join(exe_name("llama-server"))
}

/// Path to the installed `llama-tts` (used by the OuteTTS voice engine).
pub fn tts_path() -> PathBuf {
    install_dir().join(exe_name("llama-tts"))
}

/// Marker file recording which variant is installed in [`install_dir`].
fn marker_path() -> PathBuf {
    install_dir().join(".variant")
}

/// The variant currently on disk, or `None` when nothing is installed (or the
/// marker predates variants). Deliberately a separate file rather than a suffix
/// on the `versions.json` entry: that entry feeds
/// `catalog::registry::installer_pin`'s update comparison, and a decorated
/// version string there would advertise a permanent phantom update.
pub fn installed_variant() -> Option<LlamaVariant> {
    std::fs::read_to_string(marker_path())
        .ok()
        .and_then(|s| LlamaVariant::parse(&s))
}

/// Record `variant` as the one installed in [`install_dir`].
pub fn record_installed(variant: LlamaVariant) -> std::io::Result<()> {
    std::fs::create_dir_all(install_dir())?;
    std::fs::write(marker_path(), variant.as_str())
}

/// The machine's hardware, probed once per Core process.
///
/// [`DeviceInfo::detect`] shells out (`nvidia-smi`, and PowerShell's CIM host on
/// Windows, which costs hundreds of milliseconds). The answer cannot change
/// while Core runs — a GPU is not hot-plugged — and this sits on the engine
/// start path, so it is cached rather than re-probed per call.
pub fn device() -> &'static DeviceInfo {
    use std::sync::OnceLock;
    static CACHED: OnceLock<DeviceInfo> = OnceLock::new();
    CACHED.get_or_init(DeviceInfo::detect)
}

/// Resolve the variant to install/run from the persisted preference, probing
/// the machine for the auto answer. Falls back to the auto pick when
/// preferences are unreadable — never to a GPU build the node cannot run.
pub async fn resolve_from_preferences() -> LlamaVariant {
    let device = device();
    let requested = match crate::server::preferences::PreferencesStore::open_default() {
        Ok(prefs) => prefs.get(VARIANT_PREF).await.ok().flatten(),
        Err(e) => {
            tracing::warn!("could not read llama.cpp variant preference: {e}");
            None
        }
    };
    LlamaVariant::resolve(requested.as_deref(), device)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GB: u64 = 1024 * 1024 * 1024;

    fn device(vram: Option<u64>, vendor: Option<GpuVendor>, unified: bool) -> DeviceInfo {
        DeviceInfo {
            total_ram_bytes: Some(32 * GB),
            ram_human: String::new(),
            vram_bytes: vram,
            vram_human: String::new(),
            gpu_name: None,
            gpu_vendor: vendor,
            unified_memory: unified,
            os: std::env::consts::OS.to_string(),
            disk_free_bytes: None,
            disk_free_human: String::new(),
        }
    }

    fn no_gpu() -> DeviceInfo {
        device(None, None, false)
    }

    fn nvidia() -> DeviceInfo {
        device(Some(16 * GB), Some(GpuVendor::Nvidia), false)
    }

    fn apple() -> DeviceInfo {
        device(Some(32 * GB), Some(GpuVendor::Apple), true)
    }

    #[test]
    fn variant_names_round_trip() {
        for v in LlamaVariant::ALL {
            assert_eq!(LlamaVariant::parse(v.as_str()), Some(*v));
        }
        // `auto` is the absence of a choice, never a variant.
        assert_eq!(LlamaVariant::parse("auto"), None);
        assert_eq!(LlamaVariant::parse("CPU"), Some(LlamaVariant::Cpu));
        assert_eq!(LlamaVariant::parse("nonsense"), None);
    }

    #[test]
    fn cpu_is_installable_on_every_machine() {
        // The whole point of the CPU build: no hardware precondition at all.
        assert!(LlamaVariant::Cpu.available_on(&no_gpu()));
        assert!(LlamaVariant::Cpu.available_on(&nvidia()));
        assert!(LlamaVariant::Cpu.available_on(&apple()));
        assert!(LlamaVariant::Cpu.asset_slug().is_some());
    }

    #[test]
    fn gpu_builds_are_refused_without_a_usable_gpu() {
        let bare = no_gpu();
        for v in [
            LlamaVariant::Metal,
            LlamaVariant::Cuda,
            LlamaVariant::Vulkan,
        ] {
            assert!(
                !v.available_on(&bare),
                "{} must not be installable on a GPU-less node",
                v.as_str()
            );
            assert!(v.unavailable_reason(&bare).is_some());
        }
        // ...and an integrated part under the VRAM floor counts as no GPU.
        let weak = device(Some(2 * GB), Some(GpuVendor::Intel), false);
        assert!(!LlamaVariant::Vulkan.available_on(&weak));
    }

    #[test]
    fn cuda_requires_an_nvidia_card() {
        let radeon = device(Some(24 * GB), Some(GpuVendor::Amd), false);
        assert!(!LlamaVariant::Cuda.available_on(&radeon));
    }

    #[test]
    fn auto_falls_back_to_cpu_without_a_gpu() {
        assert_eq!(LlamaVariant::auto_for(&no_gpu()), LlamaVariant::Cpu);
        assert_eq!(
            LlamaVariant::resolve(None, &no_gpu()),
            LlamaVariant::Cpu,
            "an unset preference must resolve, not error"
        );
        assert_eq!(
            LlamaVariant::resolve(Some("auto"), &no_gpu()),
            LlamaVariant::Cpu
        );
    }

    #[test]
    fn an_explicit_cpu_choice_is_honoured_on_gpu_hardware() {
        // The escape hatch: broken driver, OOM-ing card, or just a deliberate
        // CPU run. This must NOT be second-guessed by auto-detection.
        assert_eq!(
            LlamaVariant::resolve(Some("cpu"), &nvidia()),
            LlamaVariant::Cpu
        );
        assert_eq!(
            LlamaVariant::resolve(Some("cpu"), &apple()),
            LlamaVariant::Cpu
        );
    }

    #[test]
    fn an_uninstallable_choice_degrades_to_auto() {
        // Asking for CUDA on a machine with no NVIDIA card yields a working
        // engine (the auto pick), never a broken install.
        let picked = LlamaVariant::resolve(Some("cuda"), &no_gpu());
        assert_eq!(picked, LlamaVariant::auto_for(&no_gpu()));
        assert!(picked.available_on(&no_gpu()));
        // Same for a garbage value in the preference store.
        assert_eq!(
            LlamaVariant::resolve(Some("gpu-please"), &no_gpu()),
            LlamaVariant::Cpu
        );
    }

    #[test]
    fn auto_never_picks_a_build_this_machine_cannot_run() {
        for dev in [no_gpu(), nvidia(), apple()] {
            let picked = LlamaVariant::auto_for(&dev);
            assert!(
                picked.available_on(&dev),
                "auto picked {} which is not installable here",
                picked.as_str()
            );
        }
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn apple_silicon_auto_picks_metal() {
        assert_eq!(LlamaVariant::auto_for(&apple()), LlamaVariant::Metal);
        // Metal and CPU share one archive on this platform — they differ only
        // by GPU offload at launch.
        assert_eq!(
            LlamaVariant::Metal.asset_slug(),
            LlamaVariant::Cpu.asset_slug()
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_nvidia_takes_the_vulkan_path() {
        // Upstream publishes no Linux CUDA binary release, so CUDA must not be
        // offered there even with an NVIDIA card present.
        assert!(LlamaVariant::Cuda.asset_slug().is_none());
        assert_eq!(LlamaVariant::auto_for(&nvidia()), LlamaVariant::Vulkan);
    }

    #[test]
    fn cuda_banner_is_parsed() {
        let banner = "| NVIDIA-SMI 550.54.14  Driver Version: 550.54.14  CUDA Version: 12.4  |";
        assert_eq!(parse_cuda_banner(banner), Some((12, 4)));
        assert_eq!(parse_cuda_banner("CUDA Version: 13.10 "), Some((13, 10)));
        assert_eq!(parse_cuda_banner("no gpu here"), None);
    }

    #[test]
    fn the_cpu_build_launches_with_gpu_offload_off() {
        // On Apple Silicon the CPU and Metal variants are the SAME archive, so
        // `--n-gpu-layers 0` is the only thing that makes "CPU only" mean CPU.
        // If this flag stops reaching the spawn args, the CPU choice silently
        // becomes a GPU run on the platform where it matters most.
        let mut launch = crate::inference::LaunchConfig::default();
        launch.gpu_layers = Some(0);
        let args = launch.to_args(crate::inference::Engine::LlamaCpp);
        let ngl = args
            .iter()
            .position(|a| a == "--n-gpu-layers")
            .expect("the CPU build must pass --n-gpu-layers");
        assert_eq!(args.get(ngl + 1).map(String::as_str), Some("0"));
    }

    #[test]
    fn install_paths_are_variant_scoped() {
        // The binary lives in its own engine dir, never loose in `bin/`, or two
        // backends' identically-named ggml libraries would overwrite each other.
        let server = server_path();
        assert!(server.starts_with(install_dir()));
        assert!(install_dir().ends_with("engines/chat/llamacpp"));
        assert!(server
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("llama-server"));
    }
}
