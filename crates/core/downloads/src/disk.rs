//! Free-space preflight for downloads: refuse a transfer that cannot fit on the
//! destination volume before any byte is written, instead of filling the disk
//! and failing half-way through a multi-GB model.

use std::path::Path;

/// Free space kept in reserve after a download so the OS, swap, and Ryu's own
/// databases never hit a full disk because an artifact filled it. The model
/// catalog re-exports this as `ryu_model_catalog::device::DISK_HEADROOM_BYTES`
/// to disable an install up front with the same number.
pub const DISK_HEADROOM_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Free bytes on the filesystem that would contain `path`: the disk whose mount
/// point is the longest prefix of `path`. The longest existing ancestor is
/// canonicalized (so a symlinked data dir resolves to its real volume) and the
/// missing remainder re-appended, so it also works for a directory that does
/// not exist yet. `None` when no mount matches. `dunce` keeps a Windows path in
/// `C:\` form: the `\\?\C:\` verbatim form `std::fs::canonicalize` returns
/// never matches a `C:\` mount point.
pub fn available_space_for(path: &Path) -> Option<u64> {
    use sysinfo::Disks;
    let resolved = path
        .ancestors()
        .find_map(|ancestor| {
            dunce::canonicalize(ancestor)
                .ok()
                .map(|canon| canon.join(path.strip_prefix(ancestor).unwrap_or(Path::new(""))))
        })
        .unwrap_or_else(|| path.to_path_buf());
    let disks = Disks::new_with_refreshed_list();
    let mut best: Option<(usize, u64)> = None;
    for disk in disks.list() {
        let mount = disk.mount_point();
        if resolved.starts_with(mount) {
            let len = mount.as_os_str().len();
            if best.is_none_or(|(b, _)| len > b) {
                best = Some((len, disk.available_space()));
            }
        }
    }
    best.map(|(_, free)| free)
}

/// The refusal for writing `needed` more bytes when `free` bytes are available,
/// or `None` when it fits with [`DISK_HEADROOM_BYTES`] to spare. An unknown free
/// space (`None`) never refuses.
pub(crate) fn shortfall(needed: u64, free: Option<u64>) -> Option<String> {
    let free = free?;
    if free >= needed.saturating_add(DISK_HEADROOM_BYTES) {
        return None;
    }
    Some(format!(
        "Not enough free disk space: needs {} (plus {} kept in reserve), {} free",
        human_bytes(needed),
        human_bytes(DISK_HEADROOM_BYTES),
        human_bytes(free),
    ))
}

/// Format a byte count as `"x.y GB"` / `"n MB"`, matching the catalog's sizes.
fn human_bytes(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    const GB: f64 = MB * 1024.0;
    let b = bytes as f64;
    if b >= GB {
        format!("{:.1} GB", b / GB)
    } else if b >= MB {
        format!("{} MB", (b / MB).round() as u64)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn shortfall_keeps_the_reserve_and_never_refuses_unknown() {
        assert_eq!(shortfall(10 * GIB, None), None);
        assert_eq!(shortfall(GIB, Some(3 * GIB)), None);
        let refusal = shortfall(GIB, Some(2 * GIB)).expect("reserve not met");
        assert_eq!(
            refusal,
            "Not enough free disk space: needs 1.0 GB (plus 2.0 GB kept in reserve), 2.0 GB free"
        );
        assert!(shortfall(5 * GIB, Some(512 * 1024 * 1024))
            .expect("refused")
            .ends_with("512 MB free"));
    }

    #[test]
    fn probe_finds_the_volume_of_a_missing_path() {
        let missing = std::env::temp_dir().join("ryu-disk-probe-missing/a/b");
        // Every supported CI host mounts the temp dir somewhere.
        assert!(available_space_for(&missing).is_some());
    }
}
