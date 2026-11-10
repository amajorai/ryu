//! Copying a data folder: relocation (`migrate`) and profile-to-profile copies.

use super::*;

// ── Copy / move ──────────────────────────────────────────────────────────────────

/// Recursively copy `from` into `to`, invoking `on_bytes` with cumulative bytes.
pub(super) fn copy_tree(
    from: &Path,
    to: &Path,
    copied: &mut u64,
    on_bytes: &mut dyn FnMut(u64),
) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        let ft = entry.file_type()?;
        if ft.is_dir() {
            copy_tree(&src, &dst, copied, on_bytes)?;
        } else if ft.is_file() {
            let bytes = std::fs::copy(&src, &dst)?;
            *copied += bytes;
            on_bytes(*copied);
        } else if ft.is_symlink() {
            copy_symlink(&src, &dst)?;
        }
        // Other special files (sockets, FIFOs) are skipped.
    }
    Ok(())
}

/// Recreate the symlink at `src` as `dst` with its target copied verbatim.
///
/// Core writes relative symlinks into the data dir (llama.cpp's
/// `libfoo.dylib -> libfoo.N.dylib` aliases, links inside installed bundles), so
/// they resolve the same way in the copied tree. Links are never followed, which
/// also keeps a directory link from causing a loop or an escape.
#[cfg(unix)]
fn copy_symlink(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(std::fs::read_link(src)?, dst)
}

/// Ryu creates no symlinks on this platform. Refuse rather than silently drop one,
/// because a move deletes the source after the copy.
#[cfg(not(unix))]
fn copy_symlink(src: &Path, _dst: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        format!("cannot copy symlink {}", src.display()),
    ))
}

/// Files and directories that must NOT travel when copying one profile's data to
/// another, because they identify the NODE or the RUNNING PROCESS rather than the
/// user's content. Paths are relative to the data dir.
///
/// Copying these is not merely untidy — each has a concrete failure:
///   - `secrets/core.token` minted once with `create_new(true)`; a copy makes the
///                     target claim the source's node identity, and
///                     `/api/node/init` then answers 409 `already_initialized` forever.
///   - `state/nodes.json` entries carry absolute URLs with a HARDCODED port. Copying
///                     `http://127.0.0.1:7980` into a profile that listens on 9980
///                     leaves it pointing at the wrong stack — the source's.
///   - `secrets/auth.json` legacy active-account sign-in token, sealed with the Core
///                     master key and excluded because it identifies the source
///                     node's account session.
///   - `secrets/node-auth.token` this node's minted `RYU_TOKEN` (see
///                     `crate::node_token`). A copy would hand another machine THIS
///                     node's admittance secret — a credential leak, not just a
///                     wrong identity.
///   - `secrets/master.key`, `secrets/memory.key` raw master-key material.
///                     [`copy_profile`] moves the key through the profile-scoped
///                     keychain first and aborts when it cannot, so a raw copy is
///                     never needed; carrying one (notably a retired legacy
///                     `memory.key`) would leave a decryption key in a tree that
///                     can be shared or snapshotted without the source keychain.
///   - `secrets/node-control.token`, `secrets/gateway-relay.token`,
///     `secrets/gateway-durable.token`, `secrets/bootstrap-ack.token`,
///     `secrets/gateway-relay.key` the node's control-plane credentials.
///   - `state/ryu-core.pid` the source's live process id.
///   - `.reset-pending` a pending node wipe would fire on the target instead.
///   - `bin/`          binaries plus `.version` markers keyed to the APP version, so
///                     a same-version copy makes the target adopt the source's
///                     binaries and skip its own download — defeating the entire
///                     point of a canary profile, which exists to run a different
///                     build.
///   - `tmp/`, `cache/` regenerable, and often large.
const PROFILE_COPY_EXCLUDE: &[&str] = &[
    ".reset-pending",
    "bin",
    "cache",
    "secrets/auth.json",
    "secrets/bootstrap-ack.token",
    "secrets/core.token",
    "secrets/gateway-durable.token",
    "secrets/gateway-relay.key",
    "secrets/gateway-relay.token",
    "secrets/master.key",
    "secrets/memory.key",
    "secrets/node-auth.token",
    "secrets/node-control.token",
    "state/nodes.json",
    "state/ryu-core.pid",
    "tmp",
];

/// Whether `rel` (a `/`-separated path relative to the data dir) is excluded
/// from a profile copy.
pub fn is_profile_copy_excluded(rel: &str) -> bool {
    PROFILE_COPY_EXCLUDE.contains(&rel)
}

/// Recursively copy `from` into `to`, skipping the node-identity and runtime
/// entries named by their data-dir-relative path (a nested `cache/` inside a
/// plugin's data is the plugin's business, so only exact relative paths match).
pub(super) fn copy_tree_filtered(
    from: &Path,
    to: &Path,
    copied: &mut u64,
    on_bytes: &mut dyn FnMut(u64),
) -> std::io::Result<()> {
    copy_tree_filtered_at(from, to, "", copied, on_bytes)
}

fn copy_tree_filtered_at(
    from: &Path,
    to: &Path,
    rel_prefix: &str,
    copied: &mut u64,
    on_bytes: &mut dyn FnMut(u64),
) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        let rel = format!("{rel_prefix}{}", name.to_string_lossy());
        if is_profile_copy_excluded(&rel) {
            continue;
        }
        let src = entry.path();
        let dst = to.join(&name);
        let ft = entry.file_type()?;
        if ft.is_dir() {
            // Only descend with filtering where an excluded path can live.
            if PROFILE_COPY_EXCLUDE
                .iter()
                .any(|excluded| excluded.starts_with(&format!("{rel}/")))
            {
                copy_tree_filtered_at(&src, &dst, &format!("{rel}/"), copied, on_bytes)?;
            } else {
                copy_tree(&src, &dst, copied, on_bytes)?;
            }
        } else if ft.is_file() {
            let bytes = std::fs::copy(&src, &dst)?;
            *copied += bytes;
            on_bytes(*copied);
        } else if ft.is_symlink() {
            copy_symlink(&src, &dst)?;
        }
    }
    Ok(())
}

/// Copy one profile's data directory into another profile's, carrying the master
/// key across so the copied data stays readable.
///
/// Unlike [`migrate`], this deliberately does NOT touch any pointer file: both
/// profiles remain usable and each keeps resolving its own data dir. It is a
/// "give canary a copy of my stable state to test against", not a relocation.
///
/// **Core must be stopped for both profiles.** Every store runs in WAL mode, so
/// copying a live `.db` captures a torn snapshot.
///
/// Ordering is the safety property: the key is moved FIRST and any failure aborts
/// before a single file is written. The alternative — copy, then discover the key
/// cannot travel — leaves a directory full of ciphertext nothing can read, and
/// there is no rekey path to recover it.
pub fn copy_profile(
    from: &Path,
    to: &Path,
    from_suffix: &str,
    to_suffix: &str,
) -> std::io::Result<()> {
    // `check_target` probes writability by creating the directory, so a refusal
    // AFTER that point would leave an empty dir behind and contradict the "nothing
    // was copied" the caller is told. Remember whether it existed first, and undo
    // the probe on any abort.
    let target_pre_existed = to.exists();
    let undo_probe = || {
        if !target_pre_existed {
            // Only ever removes a directory we created and left empty; a populated
            // one means the copy got further than these guards and must survive.
            let _ = std::fs::remove_dir(to);
        }
    };

    // Same guardrails as a relocation: absolute, non-overlapping, and — critically
    // — an EMPTY target. Merging into a profile that already has data is
    // unrecoverable, and this is reachable from a Settings button.
    let validation = validate_target(from, to, true);
    if let Some(err) = validation.error {
        undo_probe();
        return Err(std::io::Error::other(err));
    }

    // Retired keys the source holds in its keychain are stored per profile, so
    // the copied retired-key index would name slots the target does not have.
    // Carry them first: the copy is idempotent, so a refusal of the main key
    // below leaves nothing a retry would trip over.
    if let Err(error) =
        ryu_crypto::custody::copy_retired_keys_between_profiles(from, from_suffix, to_suffix)
    {
        undo_probe();
        return Err(std::io::Error::other(format!(
            "the source profile's retired master keys could not be carried to the '{to_suffix}' \
             profile, so data sealed under them would not open there. Nothing was copied. \
             ({error:#})"
        )));
    }

    match ryu_crypto::copy_master_key_between_profiles(from_suffix, to_suffix) {
        ryu_crypto::KeyCopy::Copied => {}
        ryu_crypto::KeyCopy::DestinationOccupied => {
            undo_probe();
            return Err(std::io::Error::other(format!(
                "the '{to_suffix}' profile already has its own master key. Copying onto it \
                 would leave data sealed under two different keys with no way to recover \
                 either. Reset that profile first if you want to replace it."
            )));
        }
        ryu_crypto::KeyCopy::SourceMissing => {
            undo_probe();
            return Err(std::io::Error::other(
                "the source profile has no master key in the keychain, so the copied data \
                 could not be decrypted by the target. Nothing was copied.",
            ));
        }
        ryu_crypto::KeyCopy::Unavailable => {
            undo_probe();
            return Err(std::io::Error::other(
                "could not read or write the OS keychain, so the master key cannot travel \
                 with the data. Nothing was copied — a copy without the key produces a \
                 profile that looks healthy but cannot read its own messages.",
            ));
        }
    }

    let total = paths::dir_size(from);
    let mut copied = 0u64;
    let mut on_bytes = |done: u64| {
        emit(&Progress {
            phase: "copy",
            copied_bytes: done,
            total_bytes: total,
        });
    };
    copy_tree_filtered(from, to, &mut copied, &mut on_bytes)?;
    emit(&Progress {
        phase: "done",
        copied_bytes: total,
        total_bytes: total,
    });
    Ok(())
}

/// Relocate the data folder: copy `from` → `to`, then (on success) update the

/// pointer so the next Core start resolves to `to`. With `move_source=true` the
/// source is removed after a verified copy (cross-drive safe, unlike `rename`).
pub fn migrate(from: &Path, to: &Path, move_source: bool) -> std::io::Result<()> {
    let total = paths::dir_size(from);
    emit(&Progress {
        phase: "copy",
        copied_bytes: 0,
        total_bytes: total,
    });

    let mut copied = 0u64;
    let mut last_emit = 0u64;
    copy_tree(from, to, &mut copied, &mut |c| {
        // Throttle progress to ~every 16 MB to avoid flooding stdout.
        if c - last_emit >= 16 * 1024 * 1024 || c == total {
            last_emit = c;
            emit(&Progress {
                phase: "copy",
                copied_bytes: c,
                total_bytes: total,
            });
        }
    })?;
    emit(&Progress {
        phase: "copy",
        copied_bytes: total,
        total_bytes: total,
    });

    paths::set_data_dir(Some(to)).map_err(|e| {
        std::io::Error::other(format!("copied data but failed to update pointer: {e}"))
    })?;

    if move_source {
        emit(&Progress {
            phase: "cleanup",
            copied_bytes: total,
            total_bytes: total,
        });
        if let Err(e) = std::fs::remove_dir_all(from) {
            eprintln!(
                "data-path migrate: copied and switched to {}, but could not remove {}: {e}",
                to.display(),
                from.display()
            );
        }
    }
    Ok(())
}
