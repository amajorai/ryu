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
    /// True on unified-memory machines (Apple Silicon) where RAM doubles as VRAM.
    pub unified_memory: bool,
    /// Detected OS label, e.g. `"windows"`, `"macos"`, `"linux"`.
    pub os: String,
}

impl DeviceInfo {
    /// Probe the current machine. Never fails — unknown fields stay `None`.
    pub fn detect() -> Self {
        let total_ram_bytes = total_ram_bytes();
        let gpu = detect_gpu();

        // On unified-memory machines the GPU shares system RAM, so report RAM as
        // the VRAM pool too (that's the number that governs GPU-class fit there).
        let (vram_bytes, gpu_name, unified_memory) = match gpu {
            Some(GpuInfo::Discrete { vram_bytes, name }) => (Some(vram_bytes), Some(name), false),
            Some(GpuInfo::Unified { name }) => (total_ram_bytes, Some(name), true),
            None => (None, None, false),
        };

        DeviceInfo {
            ram_human: total_ram_bytes.map(human_bytes).unwrap_or_default(),
            total_ram_bytes,
            vram_human: vram_bytes.map(human_bytes).unwrap_or_default(),
            vram_bytes,
            gpu_name,
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
            FitVerdict::TooBig => "Too large for your device",
            FitVerdict::Cpu => "Runs on your CPU (slower, no GPU)",
            FitVerdict::Partial => "Runs with partial GPU offload (slower)",
            FitVerdict::Ok => "Runs on your GPU",
            FitVerdict::Great => "Runs great — fully on your GPU",
            FitVerdict::Unknown => "Can't check your device",
        }
    }
}

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

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
///   `partial`; only fits system RAM → unreachable here (GPU present) so falls
///   to `partial`/`too_big`.
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
        // Doesn't fit VRAM — can we spill the rest into system RAM?
        if let Some(ram) = ram {
            if ram >= sys_need {
                return FitVerdict::Partial;
            }
        }
        return FitVerdict::TooBig;
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

enum GpuInfo {
    /// Discrete GPU with its own VRAM (NVIDIA via nvidia-smi).
    Discrete { vram_bytes: u64, name: String },
    /// Unified-memory GPU (Apple Silicon) — shares system RAM.
    Unified { name: String },
}

/// Best-effort GPU probe. Apple Silicon is unified memory; otherwise we ask
/// `nvidia-smi` for the largest discrete NVIDIA GPU. Returns `None` when no
/// supported GPU is found (the fit estimate then falls back to the CPU path).
fn detect_gpu() -> Option<GpuInfo> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Some(GpuInfo::Unified {
            name: "Apple Silicon (unified memory)".to_string(),
        });
    }

    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        nvidia_gpu()
    }
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
            unified_memory: unified,
            os: "test".into(),
        }
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
    fn detect_never_panics() {
        let _ = DeviceInfo::detect();
    }
}
