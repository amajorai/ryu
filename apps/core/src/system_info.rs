//! Live hardware snapshot for a Core node — the data behind the desktop node
//! selector's "what's this machine" view (CPU cores, RAM used/total, disk
//! used/total, GPU). Each node runs its own Core, so every client asks the node
//! it's pointed at and the numbers reflect *that* machine.
//!
//! Placement rationale (Core vs Gateway, see CLAUDE.md §1): describing the
//! machine that an agent *runs on* is an orchestration-side capability question
//! ("what runs"), so it lives in Core, never the Gateway.
//!
//! Static totals + GPU come from [`crate::model_catalog::device::DeviceInfo`]
//! (the same zero-dep probe the model-fit verdict uses); the *dynamic* numbers
//! (used RAM, disk used/total, CPU brand/cores) come from `sysinfo`, which
//! samples them in-process — no per-poll process spawns, and no fragile
//! `vm_stat`/`df` parsing across platforms.

use serde::Serialize;
use sysinfo::{Disks, System};

use crate::model_catalog::device::{human_bytes, DeviceInfo};

/// A point-in-time view of the node's hardware. `Option` fields stay `None` when
/// a value can't be detected (the UI then simply omits that stat).
#[derive(Debug, Clone, Serialize)]
pub struct SystemInfo {
    /// Machine hostname, e.g. `"jiawei-desktop"`.
    pub hostname: Option<String>,
    /// Detected OS label, e.g. `"windows"`, `"macos"`, `"linux"`.
    pub os: String,
    /// CPU model string, e.g. `"AMD Ryzen 9 7950X"`.
    pub cpu_name: Option<String>,
    /// Logical CPU count (cores × SMT threads) — the headline "cores" number.
    pub cpu_cores: Option<u32>,
    /// Physical CPU core count, when distinguishable from the logical count.
    pub physical_cores: Option<u32>,
    /// Total physical RAM in bytes.
    pub total_ram_bytes: Option<u64>,
    /// RAM currently in use, in bytes (the "current" of current/total).
    pub used_ram_bytes: Option<u64>,
    /// Human-friendly total RAM, e.g. `"32 GB"`. Empty when unknown.
    pub ram_human: String,
    /// Human-friendly used RAM, e.g. `"12.4 GB"`. Empty when unknown.
    pub used_ram_human: String,
    /// Total capacity of the system disk (the volume holding the home dir).
    pub total_disk_bytes: Option<u64>,
    /// Used space on the system disk, in bytes.
    pub used_disk_bytes: Option<u64>,
    /// Human-friendly total disk, e.g. `"512 GB"`. Empty when unknown.
    pub disk_human: String,
    /// Human-friendly used disk, e.g. `"210 GB"`. Empty when unknown.
    pub used_disk_human: String,
    /// GPU VRAM in bytes, when a discrete/unified GPU is detected.
    pub vram_bytes: Option<u64>,
    /// Human-friendly VRAM, e.g. `"16 GB"`. Empty when unknown.
    pub vram_human: String,
    /// Detected GPU name, e.g. `"NVIDIA GeForce RTX 4080"`.
    pub gpu_name: Option<String>,
    /// True on unified-memory machines (Apple Silicon) where RAM doubles as VRAM.
    pub unified_memory: bool,
    /// True when this Core is a **managed node** (`RYU_MANAGED_NODE`), e.g. a Ryu
    /// Cloud host with the gateway pre-provisioned with provider creds + the
    /// credits hook (A4 / #501). The desktop NodeSelector already polls this
    /// endpoint per node, so a reachable managed node identifies itself here.
    pub managed: bool,
    /// The org this managed node is bound to (after control-plane registration),
    /// so a client can show which org's wallet a managed node's usage hits.
    /// `None` on an unmanaged node or before registration succeeds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    /// Display name of the bound org, when known. `None` like [`Self::org_id`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_name: Option<String>,
}

impl SystemInfo {
    /// Probe the current machine. Never fails — undetectable fields stay `None`.
    pub fn detect() -> Self {
        let mut sys = System::new();
        sys.refresh_memory();
        sys.refresh_cpu_all();

        // GPU/VRAM + OS label reuse the model-fit probe (nvidia-smi / unified mem).
        let device = DeviceInfo::detect();

        // sysinfo reports memory in bytes; it can return 0 in some locked-down
        // sandboxes, so fall back to the device-probed total when that happens.
        let total_ram = sys.total_memory();
        let (total_ram_bytes, used_ram_bytes) = if total_ram > 0 {
            (Some(total_ram), Some(sys.used_memory()))
        } else {
            (device.total_ram_bytes, None)
        };

        let cpu_name = sys
            .cpus()
            .first()
            .map(|c| c.brand().trim().to_string())
            .filter(|s| !s.is_empty());
        let cpu_cores = std::thread::available_parallelism()
            .ok()
            .map(|n| n.get() as u32);
        let physical_cores = System::physical_core_count().map(|n| n as u32);

        let (total_disk_bytes, used_disk_bytes) = primary_disk();

        // Managed-node identity (A4 / #501): surface whether this Core is a
        // managed node and, if it has registered, the org it is bound to.
        let managed = crate::sidecar::gateway::managed_node();
        let registered_org = crate::sidecar::control_plane::registered_org();
        let (org_id, org_name) = match registered_org {
            Some(org) => (Some(org.id), Some(org.name)),
            None => (None, None),
        };

        SystemInfo {
            hostname: System::host_name(),
            os: device.os,
            cpu_name,
            cpu_cores,
            physical_cores,
            ram_human: total_ram_bytes.map(human_bytes).unwrap_or_default(),
            used_ram_human: used_ram_bytes.map(human_bytes).unwrap_or_default(),
            total_ram_bytes,
            used_ram_bytes,
            disk_human: total_disk_bytes.map(human_bytes).unwrap_or_default(),
            used_disk_human: used_disk_bytes.map(human_bytes).unwrap_or_default(),
            total_disk_bytes,
            used_disk_bytes,
            vram_bytes: device.vram_bytes,
            vram_human: device.vram_human,
            gpu_name: device.gpu_name,
            unified_memory: device.unified_memory,
            managed,
            org_id,
            org_name,
        }
    }
}

/// Capacity of the *system* disk — the volume that actually holds the user's
/// data — as `(total, used)` bytes. We deliberately pick the mount that contains
/// the home directory (the deepest-nested matching mount point) rather than
/// summing every mount or grabbing an arbitrary one, so "disk space" is
/// deterministic. Falls back to the largest disk when home can't be matched.
fn primary_disk() -> (Option<u64>, Option<u64>) {
    let disks = Disks::new_with_refreshed_list();
    if disks.list().is_empty() {
        return (None, None);
    }

    // Prefer the disk whose mount point is the longest prefix of the home dir.
    let mut best: Option<&sysinfo::Disk> = None;
    if let Some(home) = dirs::home_dir() {
        let mut best_len = 0usize;
        for disk in disks.list() {
            let mount = disk.mount_point();
            if home.starts_with(mount) && mount.as_os_str().len() >= best_len {
                best_len = mount.as_os_str().len();
                best = Some(disk);
            }
        }
    }
    // Fallback: the disk with the most total space (usually the system volume).
    let disk = best.or_else(|| disks.list().iter().max_by_key(|d| d.total_space()));

    match disk {
        Some(d) if d.total_space() > 0 => {
            let total = d.total_space();
            let used = total.saturating_sub(d.available_space());
            (Some(total), Some(used))
        }
        _ => (None, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_never_panics() {
        let info = SystemInfo::detect();
        // The OS label is always known on supported platforms.
        assert!(!info.os.is_empty());
    }

    #[test]
    fn primary_disk_used_never_exceeds_total() {
        if let (Some(total), Some(used)) = primary_disk() {
            assert!(used <= total, "used {used} must not exceed total {total}");
        }
    }
}
