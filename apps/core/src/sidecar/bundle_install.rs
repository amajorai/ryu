//! Safe install of a `local` sidecar **bundle** asset (see
//! `LocalProcessSpec::bundles`): a `tar.gz` release asset that holds a program which
//! cannot ship as one executable file — the motivating case is a macOS `.app`
//! (Electron) bundle, whose main executable sits next to frameworks, helper apps and
//! the symlinks those frameworks rely on.
//!
//! The general-purpose extractors in `download_manager` are not used here on purpose:
//! they write every entry as a plain file (a symlink becomes an empty file), drop the
//! executable bits, and silently *skip* unsafe paths. A code-signed application bundle
//! needs its symlinks and modes intact, and an archive that tries to escape its root is
//! a hostile artifact to be refused outright, not partially installed.
//!
//! Guarantees of [`install_bundle`]:
//!   - the archive's SHA-256 is checked against the expected digest before a single
//!     byte is extracted (the `DownloadCenter` already verified it on download; this
//!     re-check makes the installer self-contained against a swapped file at rest);
//!   - every entry path is relative and free of `..`; anything else aborts the install;
//!   - nothing is ever written *through* a symlink (each parent component is checked
//!     with `symlink_metadata`, and files are created with `create_new`);
//!   - a symlink entry must be relative and lexically stay inside the root, and after
//!     extraction every symlink is canonicalized and must resolve inside the root
//!     (dangling or escaping links abort the install);
//!   - hard links may only reference an earlier regular file inside the root (copied);
//!   - device nodes, FIFOs and other special entries are refused;
//!   - executable bits are preserved (normalized to `0o755` / `0o644`);
//!   - total expanded bytes and the entry count are capped (decompression bomb guard);
//!   - the install is atomic: extraction goes into a sibling staging directory that is
//!     renamed over the destination only once it is complete, verified, and stamped
//!     with its version marker, so a crash mid-install never leaves a half-tree that a
//!     later boot would mistake for an installed bundle.

use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context};

/// Version marker written inside an installed bundle directory. The resolver reuses
/// an installed bundle only when this matches the running Core version (the single
/// release train keeps Core and app sidecars in lockstep).
pub(crate) const BUNDLE_VERSION_MARKER: &str = ".ryu-version";

/// Expanded-size cap for a bundle. An Electron `.app` is ~250-300 MB unpacked; 1 GiB
/// leaves headroom while still bounding a hostile archive.
pub(crate) const BUNDLE_EXTRACT_CAP_BYTES: u64 = 1024 * 1024 * 1024;

/// Entry-count cap for a bundle archive.
const BUNDLE_MAX_ENTRIES: usize = 100_000;

/// Lower-case hex SHA-256 of a file, streamed.
pub(crate) fn sha256_file(path: &Path) -> anyhow::Result<String> {
    use sha2::{Digest, Sha256};
    let mut file = fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let mut hasher = Sha256::new();
    io::copy(&mut file, &mut hasher).with_context(|| format!("hashing {}", path.display()))?;
    Ok(hex::encode(hasher.finalize()))
}

/// Normalize an archive entry path to plain `Normal` components, refusing anything
/// absolute, drive-prefixed, or containing `..`. `.` components are dropped.
fn safe_relative(path: &Path) -> anyhow::Result<PathBuf> {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                bail!("unsafe archive entry path '{}'", path.display())
            }
        }
    }
    if out.as_os_str().is_empty() {
        bail!("empty archive entry path");
    }
    Ok(out)
}

/// Refuse to touch `root/rel` when any existing component between `root` and the
/// entry itself is a symlink — writing through one could land outside `root`.
fn ensure_no_symlink_ancestors(root: &Path, rel: &Path) -> anyhow::Result<()> {
    let mut cursor = root.to_path_buf();
    let components: Vec<_> = rel.components().collect();
    for component in components.iter().take(components.len().saturating_sub(1)) {
        cursor.push(component);
        match fs::symlink_metadata(&cursor) {
            Ok(meta) if meta.file_type().is_symlink() => bail!(
                "archive entry '{}' would be written through a symlink",
                rel.display()
            ),
            Ok(meta) if !meta.is_dir() => bail!(
                "archive entry '{}' has a non-directory parent",
                rel.display()
            ),
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e).with_context(|| format!("inspecting {}", cursor.display())),
        }
    }
    Ok(())
}

/// Lexically resolve a symlink `target` relative to the link's own parent `link_rel`
/// (both root-relative) and require the result to stay inside the root.
fn symlink_target_stays_inside(link_rel: &Path, target: &Path) -> bool {
    if target.as_os_str().is_empty() || target.has_root() {
        return false;
    }
    let mut depth: Vec<std::ffi::OsString> = link_rel
        .parent()
        .map(|p| {
            p.components()
                .filter_map(|c| match c {
                    Component::Normal(part) => Some(part.to_owned()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    for component in target.components() {
        match component {
            Component::Normal(part) => depth.push(part.to_owned()),
            Component::CurDir => {}
            Component::ParentDir => {
                if depth.pop().is_none() {
                    return false;
                }
            }
            Component::RootDir | Component::Prefix(_) => return false,
        }
    }
    true
}

#[cfg(unix)]
fn set_mode(path: &Path, executable: bool) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if executable { 0o755 } else { 0o644 };
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .with_context(|| format!("chmod {}", path.display()))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _executable: bool) -> anyhow::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn create_symlink(target: &Path, link: &Path) -> anyhow::Result<()> {
    std::os::unix::fs::symlink(target, link)
        .with_context(|| format!("creating symlink {}", link.display()))
}

#[cfg(not(unix))]
fn create_symlink(_target: &Path, link: &Path) -> anyhow::Result<()> {
    bail!(
        "archive symlink '{}' is not supported on this platform",
        link.display()
    )
}

/// Extract a `tar.gz` bundle into `dest` (which must not already contain entries
/// the archive names). See the module docs for the safety rules.
pub(crate) fn extract_bundle_tar_gz(
    archive: &Path,
    dest: &Path,
    max_total_bytes: u64,
) -> anyhow::Result<()> {
    use tar::EntryType;

    fs::create_dir_all(dest).with_context(|| format!("creating {}", dest.display()))?;
    let file = fs::File::open(archive).with_context(|| format!("opening {}", archive.display()))?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(io::BufReader::new(file)));

    let mut total: u64 = 0;
    let mut symlinks: Vec<PathBuf> = Vec::new();
    for (index, entry) in tar.entries().context("reading tar entries")?.enumerate() {
        if index >= BUNDLE_MAX_ENTRIES {
            bail!("bundle has too many entries (cap {BUNDLE_MAX_ENTRIES})");
        }
        let mut entry = entry.context("reading tar entry")?;
        let entry_type = entry.header().entry_type();
        if matches!(
            entry_type,
            EntryType::XGlobalHeader
                | EntryType::XHeader
                | EntryType::GNULongName
                | EntryType::GNULongLink
        ) {
            continue;
        }
        let raw_path = entry.path().context("reading tar entry path")?.into_owned();
        let rel = safe_relative(&raw_path)?;
        ensure_no_symlink_ancestors(dest, &rel)?;
        let out = dest.join(&rel);

        match entry_type {
            EntryType::Directory => {
                if let Ok(meta) = fs::symlink_metadata(&out) {
                    if !meta.is_dir() {
                        bail!(
                            "archive directory '{}' collides with a non-directory",
                            rel.display()
                        );
                    }
                    continue;
                }
                fs::create_dir_all(&out)
                    .with_context(|| format!("creating dir {}", out.display()))?;
            }
            EntryType::Regular | EntryType::Continuous => {
                if let Some(parent) = out.parent() {
                    fs::create_dir_all(parent)
                        .with_context(|| format!("creating dir {}", parent.display()))?;
                }
                let executable = entry
                    .header()
                    .mode()
                    .map(|m| m & 0o111 != 0)
                    .unwrap_or(false);
                // `create_new` refuses an existing path, including a planted symlink.
                let mut target = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&out)
                    .with_context(|| format!("creating {}", out.display()))?;
                let remaining = max_total_bytes.saturating_sub(total);
                let written = io::copy(
                    &mut (&mut entry).take(remaining.saturating_add(1)),
                    &mut target,
                )
                .with_context(|| format!("writing {}", out.display()))?;
                if written > remaining {
                    bail!(
                        "bundle expands past the {max_total_bytes}-byte cap (decompression bomb?)"
                    );
                }
                total += written;
                drop(target);
                set_mode(&out, executable)?;
            }
            EntryType::Symlink => {
                let target = entry
                    .link_name()
                    .context("reading symlink target")?
                    .ok_or_else(|| anyhow::anyhow!("symlink '{}' has no target", rel.display()))?
                    .into_owned();
                if !symlink_target_stays_inside(&rel, &target) {
                    bail!(
                        "archive symlink '{}' -> '{}' escapes the bundle root",
                        rel.display(),
                        target.display()
                    );
                }
                if let Some(parent) = out.parent() {
                    fs::create_dir_all(parent)
                        .with_context(|| format!("creating dir {}", parent.display()))?;
                }
                create_symlink(&target, &out)?;
                symlinks.push(out);
            }
            EntryType::Link => {
                let target = entry
                    .link_name()
                    .context("reading hard link target")?
                    .ok_or_else(|| anyhow::anyhow!("hard link '{}' has no target", rel.display()))?
                    .into_owned();
                let source_rel = safe_relative(&target)?;
                ensure_no_symlink_ancestors(dest, &source_rel)?;
                let source = dest.join(&source_rel);
                let meta = fs::symlink_metadata(&source).with_context(|| {
                    format!("hard link '{}' targets a missing entry", rel.display())
                })?;
                if !meta.is_file() {
                    bail!("hard link '{}' must target a regular file", rel.display());
                }
                if let Some(parent) = out.parent() {
                    fs::create_dir_all(parent)
                        .with_context(|| format!("creating dir {}", parent.display()))?;
                }
                if total.saturating_add(meta.len()) > max_total_bytes {
                    bail!(
                        "bundle expands past the {max_total_bytes}-byte cap (decompression bomb?)"
                    );
                }
                let mut reader = fs::File::open(&source)
                    .with_context(|| format!("opening {}", source.display()))?;
                let mut writer = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&out)
                    .with_context(|| format!("creating {}", out.display()))?;
                total += io::copy(&mut reader, &mut writer)
                    .with_context(|| format!("writing {}", out.display()))?;
                fs::set_permissions(&out, meta.permissions())
                    .with_context(|| format!("chmod {}", out.display()))?;
            }
            other => bail!(
                "archive entry '{}' has unsupported type {other:?}",
                rel.display()
            ),
        }
    }

    // Lexical checks cannot see through chains of links; the filesystem can. Every
    // link must resolve, and resolve inside the root.
    let canonical_root = dest
        .canonicalize()
        .with_context(|| format!("canonicalizing {}", dest.display()))?;
    for link in &symlinks {
        let resolved = link.canonicalize().map_err(|e| {
            anyhow::anyhow!("archive symlink '{}' does not resolve: {e}", link.display())
        })?;
        if !resolved.starts_with(&canonical_root) {
            bail!(
                "archive symlink '{}' resolves outside the bundle root",
                link.display()
            );
        }
    }
    Ok(())
}

/// Verify, extract and atomically install a bundle archive into `dest_dir`, stamping
/// it with `version`. Returns the absolute path of `entrypoint` inside the installed
/// bundle. Blocking (hashing + extraction) — call from `spawn_blocking`.
pub(crate) fn install_bundle(
    archive: &Path,
    expected_sha256: &str,
    dest_dir: &Path,
    entrypoint: &str,
    version: &str,
) -> anyhow::Result<PathBuf> {
    let expected = expected_sha256.trim().to_ascii_lowercase();
    let actual = sha256_file(archive)?;
    if actual != expected {
        bail!(
            "bundle checksum mismatch for {}: expected {expected}, got {actual}",
            archive.display()
        );
    }
    let entry_rel = safe_relative(Path::new(entrypoint))?;

    let parent = dest_dir
        .parent()
        .ok_or_else(|| anyhow::anyhow!("bundle dir {} has no parent", dest_dir.display()))?;
    let name = dest_dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow::anyhow!("bundle dir {} has no name", dest_dir.display()))?;
    fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    let nonce = uuid::Uuid::new_v4();
    let staging = parent.join(format!(".{name}.staging-{nonce}"));

    let staged = (|| -> anyhow::Result<()> {
        extract_bundle_tar_gz(archive, &staging, BUNDLE_EXTRACT_CAP_BYTES)?;
        let exe = staging.join(&entry_rel);
        let resolved = exe.canonicalize().map_err(|_| {
            anyhow::anyhow!("bundle does not contain the declared entrypoint '{entrypoint}'")
        })?;
        if !resolved.starts_with(staging.canonicalize()?) || !resolved.is_file() {
            bail!("bundle entrypoint '{entrypoint}' is not a file inside the bundle");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&resolved)?.permissions().mode();
            if mode & 0o111 == 0 {
                set_mode(&resolved, true)?;
            }
        }
        let marker = staging.join(BUNDLE_VERSION_MARKER);
        let _ = fs::remove_file(&marker);
        fs::write(&marker, version).with_context(|| format!("writing {}", marker.display()))?;
        Ok(())
    })();
    if let Err(e) = staged {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }

    // Swap: move any previous install aside, move the new one in, then drop the old.
    let old = parent.join(format!(".{name}.old-{nonce}"));
    let had_previous = fs::symlink_metadata(dest_dir).is_ok();
    if had_previous {
        fs::rename(dest_dir, &old)
            .with_context(|| format!("moving aside {}", dest_dir.display()))?;
    }
    if let Err(e) = fs::rename(&staging, dest_dir) {
        if had_previous {
            let _ = fs::rename(&old, dest_dir);
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(e).with_context(|| format!("installing {}", dest_dir.display()));
    }
    if had_previous {
        let _ = fs::remove_dir_all(&old);
    }
    Ok(dest_dir.join(entry_rel))
}

/// The installed entrypoint, when `dest_dir` holds a complete bundle stamped with
/// `version`. A missing or stale marker means "not installed".
pub(crate) fn installed_entrypoint(
    dest_dir: &Path,
    entrypoint: &str,
    version: &str,
) -> Option<PathBuf> {
    let marker = fs::read_to_string(dest_dir.join(BUNDLE_VERSION_MARKER)).ok()?;
    if marker.trim() != version {
        return None;
    }
    let exe = dest_dir.join(safe_relative(Path::new(entrypoint)).ok()?);
    exe.is_file().then_some(exe)
}

#[cfg(test)]
mod tests;
