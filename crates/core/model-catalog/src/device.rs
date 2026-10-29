//! Device hardware detection + model-fit estimation (the "runs on my device"
//! signal, llmfit-style — but computed natively in Core so every client
//! surface, desktop/mobile/extension, gets the same verdict from one place).
//!
//! Placement rationale (Core vs Gateway, see CLAUDE.md §1): deciding whether a
//! given model *can run* on this machine is an orchestration-side capability
//! question ("what runs"), so it lives in Core, never the Gateway.
//!
//! We detect total physical RAM **and** GPU VRAM with zero new dependencies,
//! using small platform-specific probes (PowerShell on Windows, `/proc/meminfo`
//! on Linux, `sysctl` on macOS for RAM; `nvidia-smi` for discrete NVIDIA VRAM;
//! Apple Silicon is treated as unified memory where RAM == VRAM). The fit
//! verdict is GPU-aware: a model that fits in VRAM runs fast (full offload), one
//! that only fits in VRAM+RAM runs slower (partial offload), and one that fits
//! in system RAM alone runs on CPU. An installed `llmfit` sidecar can refine
//! this later without changing the API.

use std::process::Command;

use serde::Serialize;

use crate::win_process::NoWindow;

/// What we know about the user's machine, for the model-fit estimate.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceInfo {
    /// Total physical RAM in bytes, when detectable.
    pub total_ram_bytes: Option<u64>,
    /// Human-friendly RAM string, e.g. `"32 GB"`. Empty when unknown.
    pub ram_human: String,
    /// GPU VRAM in bytes, when a discrete/unified GPU is detected.
    pub vram_bytes: Option<u64>,
    /// Human-friendly VRAM string, e.g. `"16 GB"`. Empty when unknown.
    pub vram_human: String,
    /// Detected GPU name, e.g. `"NVIDIA GeForce RTX 4080"`.
    pub gpu_name: Option<String>,
    /// Which GPU stack the detected adapter belongs to. Decides which
    /// accelerated engine build this machine can run (CUDA/Metal/Vulkan).
    pub gpu_vendor: Option<GpuVendor>,
    /// True on unified-memory machines (Apple Silicon) where RAM doubles as VRAM.
    pub unified_memory: bool,
    /// Detected OS label, e.g. `"windows"`, `"macos"`, `"linux"`.
    pub os: String,
    /// Free bytes on the volume that holds the models directory (where every
    /// model download lands), when detectable. Drives the "not enough disk"
    /// verdict, which blocks an install outright.
    pub disk_free_bytes: Option<u64>,
    /// Human-friendly free-disk string, e.g. `"42.0 GB"`. Empty when unknown.
    pub disk_free_human: String,
}

impl DeviceInfo {
    /// Probe the current machine. Never fails — unknown fields stay `None`.
    pub fn detect() -> Self {
        let total_ram_bytes = total_ram_bytes();
        let gpu = detect_gpu();

        // On unified-memory machines the GPU shares system RAM, so report RAM as
        // the VRAM pool too (that's the number that governs GPU-class fit there).
        let gpu_vendor = gpu.as_ref().map(|p| p.vendor);
        let (vram_bytes, gpu_name, unified_memory) = match gpu.map(|p| p.info) {
            // A discrete adapter whose size we could not read reports 0 here;
            // surface that as "unknown" rather than "zero-byte GPU" so the
            // usable-GPU floor and the fit estimate both take the unknown path.
            Some(GpuInfo::Discrete { vram_bytes, name }) => {
                ((vram_bytes > 0).then_some(vram_bytes), Some(name), false)
            }
            Some(GpuInfo::Unified { name }) => (total_ram_bytes, Some(name), true),
            None => (None, None, false),
        };

        let disk_free_bytes = models_disk_free_bytes();
        DeviceInfo {
            disk_free_human: disk_free_bytes.map(human_bytes).unwrap_or_default(),
            disk_free_bytes,
            ram_human: total_ram_bytes.map(human_bytes).unwrap_or_default(),
            total_ram_bytes,
            vram_human: vram_bytes.map(human_bytes).unwrap_or_default(),
            vram_bytes,
            gpu_name,
            gpu_vendor,
            unified_memory,
            os: std::env::consts::OS.to_string(),
        }
    }
}

/// The plain-language verdict for whether a specific model file fits this
/// device. Ordered worst → best so a UI can pick the right colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FitVerdict {
    /// Not enough free disk space on the models volume to store it at all.
    /// Blocks the install, like [`FitVerdict::TooBig`].
    NoSpace,
    /// Won't fit — would exhaust memory even spilling to system RAM.
    TooBig,
    /// Fits only in system RAM (no usable GPU) — runs, but on CPU and slower.
    Cpu,
    /// Doesn't fit in VRAM but fits in VRAM + system RAM — partial GPU offload,
    /// slower than full-GPU but faster than CPU-only.
    Partial,
    /// Fits comfortably in VRAM (or unified memory) — runs fully on the GPU.
    Ok,
    /// Fits in VRAM with lots of headroom — runs great, fully on the GPU.
    Great,
    /// Memory couldn't be detected, so we can't say.
    Unknown,
}

impl FitVerdict {
    pub fn as_str(self) -> &'static str {
        match self {
            FitVerdict::NoSpace => "no_space",
            FitVerdict::TooBig => "too_big",
            FitVerdict::Cpu => "cpu",
            FitVerdict::Partial => "partial",
            FitVerdict::Ok => "ok",
            FitVerdict::Great => "great",
            FitVerdict::Unknown => "unknown",
        }
    }

    /// A short, non-technical sentence a beginner can act on.
    pub fn label(self) -> &'static str {
        match self {
            FitVerdict::NoSpace => "Not enough free disk space to download it",
            FitVerdict::TooBig => "Too large for your device's memory",
            FitVerdict::Cpu => "Runs on your CPU only — may be slow",
            FitVerdict::Partial => "Only partly fits your GPU — may be slow",
            FitVerdict::Ok => "Runs on your GPU",
            FitVerdict::Great => "Runs great — fully on your GPU",
            FitVerdict::Unknown => "Can't check your device",
        }
    }
}

impl FitVerdict {
    /// Installing would crash the machine (out of memory) or fail mid-download
    /// (out of disk). Core refuses these installs; clients disable the button.
    pub fn blocks_install(self) -> bool {
        matches!(self, FitVerdict::NoSpace | FitVerdict::TooBig)
    }

    /// Runs, but slowly enough that the user should be warned first.
    pub fn is_slow(self) -> bool {
        matches!(self, FitVerdict::Cpu | FitVerdict::Partial)
    }
}

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

/// Free space kept in reserve after a download so the OS, swap, and Ryu's own
/// databases never hit a full disk because a model filled it. Re-exported from
/// the download center so the up-front verdict and the transfer-time refusal
/// share one number.
pub const DISK_HEADROOM_BYTES: u64 = ryu_downloads::DISK_HEADROOM_BYTES;

/// System RAM the model needs when it runs entirely on the CPU: weights plus
/// KV/activation overhead plus OS/app headroom. Same formula as the CPU branch
/// of [`estimate_fit`], exposed for CPU-only engines (the bundled sd.cpp server
/// is a CPU build) and for the human-readable refusal message.
pub fn system_ram_need_bytes(weight_bytes: u64) -> u64 {
    (weight_bytes as f64 * 1.2 + 1.5 * GIB) as u64
}

/// Whether `bytes` more data fits on the models volume with
/// [`DISK_HEADROOM_BYTES`] left over. `None` when free space is unknown.
pub fn has_disk_space_for(bytes: u64, device: &DeviceInfo) -> Option<bool> {
    device
        .disk_free_bytes
        .map(|free| free >= bytes.saturating_add(DISK_HEADROOM_BYTES))
}

/// Whether a model of `weight_bytes` fits in system RAM alone (CPU inference).
/// `None` when RAM is unknown.
pub fn fits_in_system_ram(weight_bytes: u64, device: &DeviceInfo) -> Option<bool> {
    device
        .total_ram_bytes
        .map(|ram| ram >= system_ram_need_bytes(weight_bytes))
}

/// The install-time verdict: [`FitVerdict::NoSpace`] when the download can't be
/// stored, otherwise the memory verdict from [`estimate_fit`]. Use this for
/// anything not yet on disk; an installed file only needs [`estimate_fit`].
pub fn estimate_install_fit(file_bytes: Option<u64>, device: &DeviceInfo) -> FitVerdict {
    if let Some(bytes) = file_bytes.filter(|b| *b > 0) {
        if has_disk_space_for(bytes, device) == Some(false) {
            return FitVerdict::NoSpace;
        }
    }
    estimate_fit(file_bytes, device)
}

/// Why installing `file_bytes` on `device` is refused, as one sentence with the
/// real numbers, or `None` when the install may proceed (including when the
/// size or the hardware is unknown — an unknown is never a refusal).
pub fn install_block_reason(file_bytes: Option<u64>, device: &DeviceInfo) -> Option<String> {
    let bytes = file_bytes.filter(|b| *b > 0)?;
    match estimate_install_fit(Some(bytes), device) {
        FitVerdict::NoSpace => Some(format!(
            "Not enough free disk space: this download is {} and needs {} free (with {} kept in \
             reserve), but only {} is free. Free up space or pick a smaller model.",
            human_bytes(bytes),
            human_bytes(bytes.saturating_add(DISK_HEADROOM_BYTES)),
            human_bytes(DISK_HEADROOM_BYTES),
            device.disk_free_human,
        )),
        FitVerdict::TooBig => Some(format!(
            "Too large for this device: a {} model needs about {} of memory to run, but this \
             computer has {}. Loading it could freeze or crash the machine — pick a smaller \
             model or quantization, or run it on a bigger node or in the cloud.",
            human_bytes(bytes),
            human_bytes(system_ram_need_bytes(bytes)),
            device.ram_human,
        )),
        _ => None,
    }
}

/// Memory-aware default for llama.cpp `--parallel` (server slots = the
/// continuous-batching width). Scales with the machine's usable inference
/// memory so a small laptop isn't pushed into KV-cache pressure while a
/// workstation gets real fan-out throughput. Loosely tied to Ryu's own fan-out
/// caps (delegate = 4) since that is the load that makes batching matter.
///
/// Prefers the GPU/unified pool when known (that is where KV lives on a GPU
/// run), else system RAM. Pairs with `--kv-unified` at spawn so the slots share
/// one KV buffer — the count is the batch width, not an `N×` memory multiplier.
pub fn default_parallel_slots(device: &DeviceInfo) -> u32 {
    let pool_bytes = device
        .vram_bytes
        .filter(|_| !device.unified_memory)
        .or(device.total_ram_bytes)
        .unwrap_or(0);
    let gib = (pool_bytes as f64) / GIB;
    if gib >= 32.0 {
        6
    } else if gib >= 16.0 {
        4
    } else if gib >= 8.0 {
        3
    } else {
        // Unknown or small: a modest default. The bundled chat model is tiny, so
        // even 2 slots fit; this still lets Ryu's fan-out batch a little.
        2
    }
}

/// Estimate whether a model weight of `file_bytes` fits on this `device`,
/// accounting for GPU VRAM, unified memory, and system-RAM fallback.
///
/// Heuristics (deliberately conservative so the "runs on your device" badge
/// never over-promises):
/// - **GPU need** ≈ weights × 1.2 (KV-cache + context live in VRAM too).
/// - **System need** ≈ weights × 1.2 + ~1.5 GB OS/app headroom.
/// - Unified memory (Apple): compare against total RAM as a GPU-class pool.
/// - Discrete GPU: fits in VRAM → `great`/`ok`; spills but fits VRAM+RAM →
///   `partial`; exceeds both → `too_big`; RAM unknown → `unknown` (never refuses).
/// - No GPU detected: system RAM only → `cpu` / `too_big`.
pub fn estimate_fit(file_bytes: Option<u64>, device: &DeviceInfo) -> FitVerdict {
    let Some(file) = file_bytes else {
        return FitVerdict::Unknown;
    };
    if file == 0 {
        return FitVerdict::Unknown;
    }
    let file = file as f64;
    let gpu_need = file * 1.2;
    let sys_need = file * 1.2 + 1.5 * GIB;

    // Unified memory (Apple Silicon): the single RAM pool is also VRAM.
    if device.unified_memory {
        if let Some(ram) = device.total_ram_bytes.map(|b| b as f64) {
            return tiered(ram, sys_need);
        }
        return FitVerdict::Unknown;
    }

    let ram = device.total_ram_bytes.map(|b| b as f64);

    // Discrete GPU path.
    if let Some(vram) = device.vram_bytes.map(|b| b as f64) {
        if vram >= gpu_need * 1.3 {
            return FitVerdict::Great;
        }
        if vram >= gpu_need {
            return FitVerdict::Ok;
        }
        // Doesn't fit VRAM: partial offload keeps part of the model on the GPU
        // and the rest in system RAM, so VRAM + RAM is the budget. An unknown
        // RAM figure never refuses.
        return match ram {
            Some(ram) if vram + ram >= sys_need => FitVerdict::Partial,
            Some(_) => FitVerdict::TooBig,
            None => FitVerdict::Unknown,
        };
    }

    // No GPU detected: CPU-only, system RAM governs.
    match ram {
        Some(ram) if ram >= sys_need => FitVerdict::Cpu,
        Some(_) => FitVerdict::TooBig,
        None => FitVerdict::Unknown,
    }
}

/// Headroom tiers for a single memory pool (used for unified memory).
fn tiered(pool: f64, need: f64) -> FitVerdict {
    if pool >= need * 1.5 {
        FitVerdict::Great
    } else if pool >= need * 1.15 {
        FitVerdict::Ok
    } else if pool >= need {
        FitVerdict::Partial
    } else {
        FitVerdict::TooBig
    }
}

/// Format a byte count as a friendly `"x.y GB"` / `"n MB"` string.
pub fn human_bytes(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    let b = bytes as f64;
    if b >= GIB {
        let v = b / GIB;
        if v >= 100.0 {
            format!("{} GB", v.round() as u64)
        } else {
            format!("{v:.1} GB")
        }
    } else if b >= MB {
        format!("{} MB", (b / MB).round() as u64)
    } else {
        format!("{bytes} B")
    }
}

// ── Disk probe ───────────────────────────────────────────────────────────────

/// Free bytes on the filesystem that would contain `path` (symlinks resolved on
/// the longest existing ancestor, Windows-safe). One probe for the whole node:
/// the download center's preflight uses the same function, so the catalog's
/// "not enough disk" verdict and the transfer-time refusal never disagree.
pub fn available_space_for(path: &std::path::Path) -> Option<u64> {
    ryu_downloads::available_space_for(path)
}

/// Free space on the volume holding `<data dir>/models`, where every model
/// download lands.
///
/// `None` when no catalog host is installed (so [`DeviceInfo::detect`] stays
/// infallible in processes that never ran `set_global_host`).
fn models_disk_free_bytes() -> Option<u64> {
    let root = crate::try_ryu_dir()?;
    available_space_for(&ryu_sidecar_runtime::layout::models_root(&root))
}

// ── Platform RAM probes (zero extra dependencies) ────────────────────────────

#[cfg(target_os = "windows")]
fn total_ram_bytes() -> Option<u64> {
    let out = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
        ])
        .no_window()
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<u64>()
        .ok()
}

#[cfg(target_os = "linux")]
fn total_ram_bytes() -> Option<u64> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
    for line in meminfo.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
            return Some(kb * 1024);
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn total_ram_bytes() -> Option<u64> {
    let out = Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .no_window()
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<u64>()
        .ok()
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn total_ram_bytes() -> Option<u64> {
    None
}

// ── GPU detection ────────────────────────────────────────────────────────────

struct GpuProbe {
    info: GpuInfo,
    vendor: GpuVendor,
}

enum GpuInfo {
    /// Discrete GPU with its own VRAM (NVIDIA via nvidia-smi, AMD/Intel via the
    /// platform display-adapter probe). Never constructed on Apple Silicon,
    /// where the probe short-circuits to unified memory.
    #[cfg_attr(all(target_os = "macos", target_arch = "aarch64"), allow(dead_code))]
    Discrete { vram_bytes: u64, name: String },
    /// Unified-memory GPU (Apple Silicon) — shares system RAM.
    Unified { name: String },
}

/// Which GPU stack the detected adapter belongs to. This is what decides which
/// accelerated build of an inference engine a machine can actually run — CUDA
/// needs NVIDIA, Metal needs Apple, and Vulkan covers the rest — so it is
/// detected here alongside VRAM rather than re-probed per engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GpuVendor {
    Nvidia,
    Amd,
    Intel,
    Apple,
    /// A display adapter we recognized as present but could not attribute.
    Other,
}

impl GpuVendor {
    pub fn as_str(self) -> &'static str {
        match self {
            GpuVendor::Nvidia => "nvidia",
            GpuVendor::Amd => "amd",
            GpuVendor::Intel => "intel",
            GpuVendor::Apple => "apple",
            GpuVendor::Other => "other",
        }
    }

    /// Classify an adapter by its product name, the one signal every platform
    /// probe gives us. Kept name-based (not PCI-id-based) because the Windows
    /// CIM query and the Linux `lspci` fallback both report names, not ids.
    pub fn from_name(name: &str) -> GpuVendor {
        let n = name.to_ascii_lowercase();
        if n.contains("nvidia")
            || n.contains("geforce")
            || n.contains("quadro")
            || n.contains("tesla")
        {
            GpuVendor::Nvidia
        } else if n.contains("amd") || n.contains("radeon") || n.contains("advanced micro") {
            GpuVendor::Amd
        } else if n.contains("intel") || n.contains("arc ") {
            GpuVendor::Intel
        } else if n.contains("apple") {
            GpuVendor::Apple
        } else {
            GpuVendor::Other
        }
    }
}

/// VRAM floor below which a discrete GPU is not worth building an accelerated
/// engine around: the weights would immediately spill to system RAM, so the
/// GPU build is slower than the CPU build *and* far more fragile (driver and
/// runtime dependencies). 4 GiB is the smallest pool that holds the bundled
/// chat model plus its KV cache with room to spare.
pub const USABLE_VRAM_FLOOR_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Whether this machine has a GPU worth running an accelerated engine build on.
///
/// This is the predicate behind "auto-detect the user's hardware": `false` means
/// the accelerated builds must not be offered *or* installed, because they would
/// either fail to load (no driver / no device) or run slower than the CPU build.
/// Unified-memory machines (Apple Silicon) always qualify — the GPU shares the
/// system pool, so there is no separate VRAM budget to fall short of.
pub fn has_usable_gpu(device: &DeviceInfo) -> bool {
    if device.unified_memory {
        return true;
    }
    match device.vram_bytes {
        Some(vram) => vram >= USABLE_VRAM_FLOOR_BYTES,
        // An adapter was named but its VRAM was unreadable. NVIDIA answers
        // through `nvidia-smi` (which always reports memory), so a nameless-size
        // adapter here is an integrated part; treat unknown as not usable rather
        // than install a GPU build on a machine that cannot run it.
        None => false,
    }
}

/// Best-effort GPU probe. Apple Silicon is unified memory; elsewhere we ask
/// `nvidia-smi` for the largest discrete NVIDIA GPU, and fall back to the
/// platform display-adapter list (Windows CIM / Linux sysfs+lspci) so AMD and
/// Intel GPUs are seen too. Returns `None` when no GPU is found (the fit
/// estimate then falls back to the CPU path).
fn detect_gpu() -> Option<GpuProbe> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Some(GpuProbe {
            info: GpuInfo::Unified {
                name: "Apple Silicon (unified memory)".to_string(),
            },
            vendor: GpuVendor::Apple,
        });
    }

    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        // NVIDIA first: `nvidia-smi` is the only probe that reports real VRAM
        // totals, and it is the vendor with a dedicated engine build.
        if let Some(info) = nvidia_gpu() {
            return Some(GpuProbe {
                info,
                vendor: GpuVendor::Nvidia,
            });
        }
        other_gpu()
    }
}

/// Non-NVIDIA display adapter probe (AMD, Intel, everything else). Returns the
/// adapter with the most VRAM, with `vram_bytes` only when the platform reports
/// a believable number — an unknown size is reported as a discrete adapter with
/// zero VRAM so [`has_usable_gpu`] declines it rather than guessing.
#[cfg(target_os = "windows")]
fn other_gpu() -> Option<GpuProbe> {
    // `AdapterRAM` is a 32-bit field that saturates at 4 GiB on large cards, so
    // it is a floor, not a total. That is the right direction for our use: we
    // only ever ask "is there at least N bytes".
    let out = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_VideoController | ForEach-Object { \"$($_.AdapterRAM)|$($_.Name)\" }",
        ])
        .no_window()
        .output()
        .ok()?;
    parse_adapter_lines(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(target_os = "linux")]
fn other_gpu() -> Option<GpuProbe> {
    // amdgpu and i915 both expose a VRAM total in sysfs; read it per card and
    // pair it with the human name from `lspci` when that is available.
    let mut best: Option<(u64, String)> = None;
    if let Ok(entries) = std::fs::read_dir("/sys/class/drm") {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            // Only whole cards ("card0"), never their connector children
            // ("card0-DP-1"), which have no device memory of their own.
            if !name.starts_with("card") || name.contains('-') {
                continue;
            }
            let device = entry.path().join("device");
            let vram = std::fs::read_to_string(device.join("mem_info_vram_total"))
                .ok()
                .and_then(|s| s.trim().parse::<u64>().ok())
                .unwrap_or(0);
            let label = lspci_name().unwrap_or_else(|| "GPU".to_string());
            if best.as_ref().map(|(b, _)| vram > *b).unwrap_or(true) {
                best = Some((vram, label));
            }
        }
    }
    let (vram_bytes, name) = best?;
    Some(GpuProbe {
        vendor: GpuVendor::from_name(&name),
        info: GpuInfo::Discrete { vram_bytes, name },
    })
}

/// First VGA/3D controller line from `lspci`, used only for the adapter's
/// human name (sysfs carries the memory total).
#[cfg(target_os = "linux")]
fn lspci_name() -> Option<String> {
    let out = Command::new("lspci").no_window().output().ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find(|l| l.contains("VGA compatible controller") || l.contains("3D controller"))
        .and_then(|l| l.split_once(": "))
        .map(|(_, name)| name.trim().to_string())
}

/// No display-adapter enumeration on this platform (macOS answers through the
/// unified-memory branch; anything else has no probe we trust).
#[cfg(not(any(target_os = "windows", target_os = "linux")))]
#[cfg_attr(all(target_os = "macos", target_arch = "aarch64"), allow(dead_code))]
fn other_gpu() -> Option<GpuProbe> {
    None
}

/// Parse `"<bytes>|<adapter name>"` lines into the largest adapter. Split out
/// from the Windows probe so the parsing is testable without a CIM host.
#[cfg(any(target_os = "windows", test))]
fn parse_adapter_lines(stdout: &str) -> Option<GpuProbe> {
    let mut best: Option<(u64, String)> = None;
    for line in stdout.lines() {
        let Some((bytes_str, name)) = line.split_once('|') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        // A blank/`null` AdapterRAM means "unknown", which we record as 0 so the
        // usable-GPU floor declines it.
        let bytes = bytes_str.trim().parse::<u64>().unwrap_or(0);
        if best.as_ref().map(|(b, _)| bytes > *b).unwrap_or(true) {
            best = Some((bytes, name.to_string()));
        }
    }
    let (vram_bytes, name) = best?;
    Some(GpuProbe {
        vendor: GpuVendor::from_name(&name),
        info: GpuInfo::Discrete { vram_bytes, name },
    })
}

/// Query `nvidia-smi` for total VRAM + name, picking the GPU with the most VRAM.
#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
fn nvidia_gpu() -> Option<GpuInfo> {
    let out = Command::new("nvidia-smi")
        .args([
            "--query-gpu=memory.total,name",
            "--format=csv,noheader,nounits",
        ])
        .no_window()
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut best: Option<(u64, String)> = None;
    for line in stdout.lines() {
        // Each line: "16384, NVIDIA GeForce RTX 4080"
        let (mib_str, name) = line.split_once(',')?;
        let Ok(mib) = mib_str.trim().parse::<u64>() else {
            continue;
        };
        let bytes = mib * 1024 * 1024;
        let name = name.trim().to_string();
        if best.as_ref().map(|(b, _)| bytes > *b).unwrap_or(true) {
            best = Some((bytes, name));
        }
    }
    best.map(|(vram_bytes, name)| GpuInfo::Discrete { vram_bytes, name })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(ram: Option<u64>, vram: Option<u64>, unified: bool) -> DeviceInfo {
        DeviceInfo {
            total_ram_bytes: ram,
            ram_human: String::new(),
            vram_bytes: vram,
            vram_human: String::new(),
            gpu_name: None,
            gpu_vendor: None,
            unified_memory: unified,
            os: "test".into(),
            disk_free_bytes: None,
            disk_free_human: String::new(),
        }
    }

    const GB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn install_fit_blocks_when_the_disk_cannot_hold_the_download() {
        let mut d = dev(Some(64 * GB), Some(24 * GB), false);
        d.disk_free_bytes = Some(5 * GB);
        d.disk_free_human = "5.0 GB".into();
        // 4 GB + 2 GB reserve > 5 GB free.
        assert_eq!(estimate_install_fit(Some(4 * GB), &d), FitVerdict::NoSpace);
        assert!(FitVerdict::NoSpace.blocks_install());
        let reason = install_block_reason(Some(4 * GB), &d).expect("refused");
        assert!(reason.contains("disk space"), "{reason}");
        // 2 GB + 2 GB reserve fits.
        assert_eq!(estimate_install_fit(Some(2 * GB), &d), FitVerdict::Great);
        assert!(install_block_reason(Some(2 * GB), &d).is_none());
        // Unknown free space never blocks.
        d.disk_free_bytes = None;
        assert_ne!(estimate_install_fit(Some(4 * GB), &d), FitVerdict::NoSpace);
    }

    #[test]
    fn install_block_reason_refuses_models_that_exceed_memory() {
        let mut d = dev(Some(8 * GB), None, false);
        d.ram_human = "8.0 GB".into();
        let reason = install_block_reason(Some(12 * GB), &d).expect("refused");
        assert!(reason.contains("8.0 GB"), "{reason}");
        // CPU-only fits are slow, not blocked.
        assert_eq!(estimate_fit(Some(3 * GB), &d), FitVerdict::Cpu);
        assert!(FitVerdict::Cpu.is_slow());
        assert!(!FitVerdict::Cpu.blocks_install());
        assert!(install_block_reason(Some(3 * GB), &d).is_none());
        // Unknown size or unknown hardware never blocks.
        assert!(install_block_reason(None, &d).is_none());
        assert!(install_block_reason(Some(12 * GB), &dev(None, None, false)).is_none());
    }

    #[test]
    fn system_ram_fit_ignores_vram() {
        // A big GPU does not help a CPU-only engine.
        let d = dev(Some(8 * GB), Some(24 * GB), false);
        assert_eq!(fits_in_system_ram(11 * GB, &d), Some(false));
        assert_eq!(fits_in_system_ram(3 * GB, &d), Some(true));
        assert_eq!(fits_in_system_ram(3 * GB, &dev(None, None, false)), None);
    }

    #[test]
    fn available_space_for_a_temp_path_is_reported() {
        let dir = std::env::temp_dir().join("ryu-device-disk-probe/not/yet/created");
        // Lexical lookup: a missing path still resolves to its volume (when the
        // platform exposes any disk at all).
        if let Some(free) = available_space_for(&std::env::temp_dir()) {
            assert_eq!(available_space_for(&dir), Some(free));
        }
    }

    #[test]
    fn gpu_vendor_is_classified_from_adapter_name() {
        assert_eq!(
            GpuVendor::from_name("NVIDIA GeForce RTX 4080"),
            GpuVendor::Nvidia
        );
        assert_eq!(
            GpuVendor::from_name("AMD Radeon RX 7900 XTX"),
            GpuVendor::Amd
        );
        assert_eq!(
            GpuVendor::from_name("Intel(R) Arc(TM) A770 Graphics"),
            GpuVendor::Intel
        );
        assert_eq!(GpuVendor::from_name("Apple M3 Max"), GpuVendor::Apple);
        assert_eq!(
            GpuVendor::from_name("Basic Display Adapter"),
            GpuVendor::Other
        );
    }

    #[test]
    fn usable_gpu_requires_real_vram_or_unified_memory() {
        // Apple Silicon: the GPU shares the system pool, always usable.
        assert!(has_usable_gpu(&dev(Some(16 * GB), Some(16 * GB), true)));
        // A 16 GB discrete card clears the floor.
        assert!(has_usable_gpu(&dev(Some(32 * GB), Some(16 * GB), false)));
        // A 2 GB integrated part does not — an accelerated build there is
        // slower than CPU and far more fragile.
        assert!(!has_usable_gpu(&dev(Some(16 * GB), Some(2 * GB), false)));
        // No GPU at all, and an adapter whose size we could not read.
        assert!(!has_usable_gpu(&dev(Some(16 * GB), None, false)));
    }

    #[test]
    fn adapter_lines_pick_the_largest_named_adapter() {
        let probe = parse_adapter_lines(
            "2147483648|Intel(R) UHD Graphics 630\n17179869184|NVIDIA GeForce RTX 4090\n",
        )
        .expect("an adapter");
        assert_eq!(probe.vendor, GpuVendor::Nvidia);
        match probe.info {
            GpuInfo::Discrete {
                vram_bytes,
                ref name,
            } => {
                assert_eq!(vram_bytes, 16 * GB);
                assert!(name.contains("4090"));
            }
            GpuInfo::Unified { .. } => panic!("expected a discrete adapter"),
        }
    }

    #[test]
    fn adapter_lines_tolerate_unknown_sizes_and_blank_rows() {
        // `AdapterRAM` comes back empty for some virtual adapters; the row is
        // still a real GPU, but with unknown VRAM (recorded as 0 so the usable
        // floor declines it).
        let probe = parse_adapter_lines("|Microsoft Basic Display Adapter\n |\n|AMD Radeon\n")
            .expect("an adapter");
        assert_eq!(probe.vendor, GpuVendor::Other);
        match probe.info {
            GpuInfo::Discrete { vram_bytes, .. } => assert_eq!(vram_bytes, 0),
            GpuInfo::Unified { .. } => panic!("expected a discrete adapter"),
        }
        assert!(parse_adapter_lines("").is_none());
    }

    #[test]
    fn human_bytes_formats() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(512 * 1024 * 1024), "512 MB");
        assert_eq!(
            human_bytes(3 * 1024 * 1024 * 1024 + 200 * 1024 * 1024),
            "3.2 GB"
        );
    }

    #[test]
    fn fit_unknown_without_memory() {
        assert_eq!(
            estimate_fit(Some(1_000_000_000), &dev(None, None, false)),
            FitVerdict::Unknown
        );
        assert_eq!(
            estimate_fit(None, &dev(Some(16_000_000_000), None, false)),
            FitVerdict::Unknown
        );
    }

    #[test]
    fn fit_great_when_model_fits_vram_with_headroom() {
        // 3 GB model on a 16 GB GPU → fully on GPU, great.
        let file = 3u64 * 1024 * 1024 * 1024;
        let vram = 16u64 * 1024 * 1024 * 1024;
        let ram = 32u64 * 1024 * 1024 * 1024;
        assert_eq!(
            estimate_fit(Some(file), &dev(Some(ram), Some(vram), false)),
            FitVerdict::Great
        );
    }

    #[test]
    fn fit_partial_when_model_exceeds_vram_but_fits_ram() {
        // 20 GB model, 16 GB VRAM, 64 GB RAM → spills to RAM, partial offload.
        let file = 20u64 * 1024 * 1024 * 1024;
        let vram = 16u64 * 1024 * 1024 * 1024;
        let ram = 64u64 * 1024 * 1024 * 1024;
        assert_eq!(
            estimate_fit(Some(file), &dev(Some(ram), Some(vram), false)),
            FitVerdict::Partial
        );
    }

    #[test]
    fn fit_too_big_when_exceeds_vram_and_ram() {
        // 40 GB model, 16 GB VRAM, 32 GB RAM → won't fit anywhere.
        let file = 40u64 * 1024 * 1024 * 1024;
        let vram = 16u64 * 1024 * 1024 * 1024;
        let ram = 32u64 * 1024 * 1024 * 1024;
        assert_eq!(
            estimate_fit(Some(file), &dev(Some(ram), Some(vram), false)),
            FitVerdict::TooBig
        );
    }

    #[test]
    fn fit_partial_when_model_fits_vram_plus_ram_but_not_ram_alone() {
        // 12 GiB VRAM + 16 GiB RAM, ~16.5 GB model (a 27B Q4_K_M): the model
        // exceeds VRAM and system RAM alone cannot hold it with headroom, but
        // partial offload fits in VRAM + RAM.
        let file = 16_500_000_000u64;
        let vram = 12u64 * 1024 * 1024 * 1024;
        let ram = 16u64 * 1024 * 1024 * 1024;
        assert_eq!(
            estimate_fit(Some(file), &dev(Some(ram), Some(vram), false)),
            FitVerdict::Partial
        );
    }

    #[test]
    fn fit_unknown_when_vram_is_too_small_and_ram_is_unknown() {
        // A 2 GiB GPU with a failed RAM probe must not refuse a 4 GB model.
        let vram = 2u64 * 1024 * 1024 * 1024;
        assert_eq!(
            estimate_fit(Some(4_000_000_000), &dev(None, Some(vram), false)),
            FitVerdict::Unknown
        );
    }

    #[test]
    fn fit_cpu_when_no_gpu_but_ram_fits() {
        // 4 GB model, no GPU, 32 GB RAM → runs on CPU.
        let file = 4u64 * 1024 * 1024 * 1024;
        let ram = 32u64 * 1024 * 1024 * 1024;
        assert_eq!(
            estimate_fit(Some(file), &dev(Some(ram), None, false)),
            FitVerdict::Cpu
        );
    }

    #[test]
    fn fit_unified_memory_uses_ram_pool() {
        // 4 GB model on a 32 GB Apple Silicon machine → great (unified).
        let file = 4u64 * 1024 * 1024 * 1024;
        let ram = 32u64 * 1024 * 1024 * 1024;
        assert_eq!(
            estimate_fit(Some(file), &dev(Some(ram), Some(ram), true)),
            FitVerdict::Great
        );
    }

    #[test]
    fn fit_ok_without_headroom_on_discrete_gpu() {
        // A model that fits VRAM but not with the 1.3x "great" margin → Ok.
        // gpu_need = file * 1.2. Pick vram between gpu_need and gpu_need*1.3.
        let file = 10u64 * 1024 * 1024 * 1024; // 10 GB
        let vram = 13u64 * 1024 * 1024 * 1024; // gpu_need=12GB, *1.3=15.6GB → Ok
        let ram = 32u64 * 1024 * 1024 * 1024;
        assert_eq!(
            estimate_fit(Some(file), &dev(Some(ram), Some(vram), false)),
            FitVerdict::Ok
        );
    }

    #[test]
    fn fit_zero_bytes_is_unknown() {
        // A zero-length weight (metadata-only / unknown size) can't be judged.
        assert_eq!(
            estimate_fit(
                Some(0),
                &dev(Some(16_000_000_000), Some(16_000_000_000), false)
            ),
            FitVerdict::Unknown
        );
    }

    #[test]
    fn fit_too_big_when_no_gpu_and_ram_too_small() {
        // 40 GB model, no GPU, 8 GB RAM → won't fit in system RAM either.
        let file = 40u64 * 1024 * 1024 * 1024;
        let ram = 8u64 * 1024 * 1024 * 1024;
        assert_eq!(
            estimate_fit(Some(file), &dev(Some(ram), None, false)),
            FitVerdict::TooBig
        );
    }

    #[test]
    fn fit_unified_unknown_without_ram() {
        // Unified-memory flag but no RAM figure → can't decide.
        assert_eq!(
            estimate_fit(Some(1_000_000_000), &dev(None, None, true)),
            FitVerdict::Unknown
        );
    }

    #[test]
    fn fit_unified_tiers_ok_and_partial_and_too_big() {
        // Exercise the `tiered` boundaries via the unified-memory path.
        // need = file*1.2 + 1.5GB. Use a 10 GB file: need ≈ 13.5 GB.
        let file = 10u64 * 1024 * 1024 * 1024;
        let need_gb = 13.5_f64;
        let gb = |g: f64| (g * GIB) as u64;
        // Ok band: need*1.15 <= pool < need*1.5.
        let ok_ram = gb(need_gb * 1.2);
        assert_eq!(
            estimate_fit(Some(file), &dev(Some(ok_ram), Some(ok_ram), true)),
            FitVerdict::Ok
        );
        // Partial band: need <= pool < need*1.15.
        let partial_ram = gb(need_gb * 1.05);
        assert_eq!(
            estimate_fit(Some(file), &dev(Some(partial_ram), Some(partial_ram), true)),
            FitVerdict::Partial
        );
        // Below need → too big.
        let small_ram = gb(need_gb * 0.5);
        assert_eq!(
            estimate_fit(Some(file), &dev(Some(small_ram), Some(small_ram), true)),
            FitVerdict::TooBig
        );
    }

    #[test]
    fn human_bytes_hundreds_of_gb_drops_decimal() {
        // >= 100 GB rounds to a whole number (no ".0").
        assert_eq!(human_bytes(128u64 * 1024 * 1024 * 1024), "128 GB");
        // Sub-MB falls through to raw bytes.
        assert_eq!(human_bytes(999), "999 B");
    }

    #[test]
    fn default_parallel_slots_scales_with_memory() {
        // >=32 GB pool → 6 slots (discrete VRAM preferred over RAM).
        let big = dev(Some(64 * GIB as u64), Some(40 * GIB as u64), false);
        assert_eq!(default_parallel_slots(&big), 6);
        // 16–32 GB → 4.
        let mid = dev(Some(20 * GIB as u64), None, false);
        assert_eq!(default_parallel_slots(&mid), 4);
        // 8–16 GB → 3.
        let small = dev(Some(10 * GIB as u64), None, false);
        assert_eq!(default_parallel_slots(&small), 3);
        // Unknown/tiny → 2.
        let tiny = dev(None, None, false);
        assert_eq!(default_parallel_slots(&tiny), 2);
        // Unified memory ignores the VRAM figure and uses total RAM.
        let unified = dev(Some(64 * GIB as u64), Some(64 * GIB as u64), true);
        assert_eq!(default_parallel_slots(&unified), 6);
    }

    #[test]
    fn fit_verdict_str_and_label_cover_all_variants() {
        for v in [
            FitVerdict::TooBig,
            FitVerdict::Cpu,
            FitVerdict::Partial,
            FitVerdict::Ok,
            FitVerdict::Great,
            FitVerdict::Unknown,
        ] {
            assert!(!v.as_str().is_empty());
            assert!(!v.label().is_empty());
        }
    }

    #[test]
    fn detect_never_panics() {
        let _ = DeviceInfo::detect();
    }
}
