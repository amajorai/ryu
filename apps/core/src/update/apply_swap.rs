//! The self-replace step of the update apply path: swap a verified binary into
//! the slot of a live executable without ever leaving that slot empty.

use anyhow::{Context, Result};
use std::path::Path;

/// In-place replace of the currently running executable.
///
/// The new binary is first copied NEXT TO the live one (`<exe>.new`), so the
/// final step is a same-directory rename even when the staging dir is on another
/// volume. The live binary is then renamed aside to `<exe>.old` (allowed while
/// running, on Windows too) and `<exe>.new` moved into its slot. If that last
/// move fails, the backup is renamed back: a failed update must never leave the
/// node with no Core binary at its own path. The caller must restart the process
/// for the new binary to take effect.
pub(super) fn replace_current_exe(new_binary: &Path) -> Result<()> {
    let current = std::env::current_exe().context("resolving current exe")?;
    replace_exe_at(&current, new_binary)
}

/// Swap `new_binary` into `current`, never leaving `current` missing.
///
/// The new binary is first copied next to the live one (`<exe>.new`, same
/// volume, so the final step is a rename), and only then is the live binary
/// moved aside. If copying fails (disk full, AV lock) the live exe is untouched;
/// if the final rename fails the original is moved back.
pub(super) fn replace_exe_at(current: &Path, new_binary: &Path) -> Result<()> {
    let backup = current.with_extension("old");
    let incoming = current.with_extension("new");
    let _ = std::fs::remove_file(&incoming);
    // Copy rather than rename so it works across volumes (the staging dir may be
    // on a different drive).
    std::fs::copy(new_binary, &incoming)
        .with_context(|| format!("staging new exe at {}", incoming.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&incoming, std::fs::Permissions::from_mode(0o755))
            .with_context(|| format!("marking {} executable", incoming.display()))?;
    }
    // Opened for writing: on Windows `FlushFileBuffers` refuses a read-only handle.
    std::fs::OpenOptions::new()
        .write(true)
        .open(&incoming)
        .and_then(|file| file.sync_all())
        .with_context(|| format!("flushing {}", incoming.display()))?;

    // Best-effort: remove a stale backup from a prior update.
    let _ = std::fs::remove_file(&backup);
    if let Err(error) = std::fs::rename(current, &backup) {
        let _ = std::fs::remove_file(&incoming);
        return Err(error)
            .with_context(|| format!("renaming live exe aside to {}", backup.display()));
    }
    if let Err(error) = std::fs::rename(&incoming, current) {
        // Put the original back so the node still has a binary to start.
        let _ = std::fs::rename(&backup, current);
        let _ = std::fs::remove_file(&incoming);
        return Err(error).with_context(|| format!("installing new exe at {}", current.display()));
    }
    let _ = std::fs::remove_file(new_binary);
    Ok(())
}

/// Whether the running Core lives inside a macOS `.app` bundle (the desktop's
/// bundled sidecar). Swapping a file inside a signed bundle breaks its code
/// signature, and the bundle is the native updater's to replace.
pub(super) fn running_inside_app_bundle() -> bool {
    std::env::current_exe()
        .map(|exe| exe.to_string_lossy().contains(".app/Contents/"))
        .unwrap_or(false)
}

/// Clean up the `<exe>.old` backup left by a previous self-update. Called once
/// on Core startup so the staging crumbs don't accumulate.
pub fn cleanup_stale_backup() {
    if let Ok(current) = std::env::current_exe() {
        let backup = current.with_extension("old");
        if backup.exists() {
            let _ = std::fs::remove_file(backup);
        }
    }
}

#[cfg(test)]
#[path = "apply_swap_tests.rs"]
mod tests;
