//! Clearing a profile's data dir and the auxiliary roots a node reset misses.

use super::*;

/// Auxiliary roots a node reset does NOT reach, and where each lives.
///
/// `apply_pending_reset` wipes the DATA dir and nothing else, which leaves a
/// "reset" node still carrying its gateway config and data-path pointer. Users
/// reasonably read "reset node" as "this node is blank" and then find their old
/// gateway settings intact. (Shadow captures and Ghost state live under the data
/// dir's `services/`, so the reset already reaches them.)
pub fn auxiliary_roots(config_dir: Option<&Path>, suffix: &str) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    if let Some(config) = config_dir {
        out.push((
            "gateway config + data-path pointer".to_string(),
            config.join(format!("ryu{suffix}")),
        ));
    }
    out
}

/// How much of a profile's DATA dir a clean removes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanDepth {
    /// Leave the data dir alone entirely — only the auxiliary roots go. This is
    /// what "deep clean" meant before it grew a profile axis.
    None,
    /// Clear the data dir but KEEP the multi-GB downloads (`bin/`, `models/`), so
    /// the next start does not re-fetch engines and models.
    State,
    /// Remove the data dir outright — the fresh-install path.
    Full,
}

/// Remove a profile's data dir to the requested depth. Returns what was removed.
///
/// Deliberately does NOT touch the master key, in either the keychain or
/// `master.key`. A node reset preserves it for the same reason: the key is node
/// IDENTITY, and removing it while any sealed data survives anywhere makes that
/// data permanently unreadable with no rekey path. Clearing a profile's data is
/// recoverable by re-syncing; losing its key is not.
pub fn clean_profile_data(home: &Path, suffix: &str, depth: CleanDepth) -> Vec<String> {
    if depth == CleanDepth::None {
        return Vec::new();
    }
    let dir = home.join(format!(".ryu{suffix}"));
    if !dir.exists() {
        return Vec::new();
    }
    // Same containment rule as everything else here: computed from a home dir and
    // a suffix, so a bug in either must not aim a recursive delete elsewhere.
    if dir.strip_prefix(home).map(|r| r.components().count()) != Ok(1) {
        eprintln!("data-path clean: refusing {} (outside home)", dir.display());
        return Vec::new();
    }
    let mut removed = Vec::new();
    match depth {
        CleanDepth::None => {}
        CleanDepth::Full => {
            if std::fs::remove_dir_all(&dir).is_ok() {
                removed.push(format!("data dir (full) — {}", dir.display()));
            }
        }
        CleanDepth::State => {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                return removed;
            };
            let mut cleared = 0usize;
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                // The multi-GB downloads survive a `state` clean — re-fetching an
                // engine is the slowest possible way to get back to a clean node.
                if name == layout::top::BIN
                    || name == layout::top::MODELS
                    || name == layout::top::ENGINES
                {
                    continue;
                }
                let path = entry.path();
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                let ok = if is_dir && name == layout::top::SECRETS {
                    // Keep the key custody files; every token/credential goes.
                    scrub_secrets_keeping_keys(&path)
                } else if is_dir {
                    std::fs::remove_dir_all(&path).is_ok()
                } else {
                    std::fs::remove_file(&path).is_ok()
                };
                if ok {
                    cleared += 1;
                }
            }
            if cleared > 0 {
                removed.push(format!(
                    "data dir ({cleared} entries, kept bin/engines/models/keys) — {}",
                    dir.display()
                ));
            }
        }
    }
    removed
}

/// Delete every entry of a `secrets/` dir except the key custody files.
fn scrub_secrets_keeping_keys(secrets: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(secrets) else {
        return false;
    };
    let mut ok = true;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if BACKUP_KEPT_SECRETS.contains(&name.to_string_lossy().as_ref()) {
            continue;
        }
        let path = entry.path();
        let result = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        ok &= result.is_ok();
    }
    ok
}

/// Remove the auxiliary roots above. Returns what was actually removed.
///
/// Every path is re-checked against `$HOME` before deletion: these are computed
/// from a home dir and a profile suffix, and a bug in either would otherwise aim a
/// recursive delete somewhere arbitrary.
pub fn deep_clean(home: &Path, config_dir: Option<&Path>, suffix: &str) -> Vec<String> {
    let mut removed = Vec::new();
    for (label, path) in auxiliary_roots(config_dir, suffix) {
        if !path.exists() {
            continue;
        }
        // Never delete the home dir itself, and never anything outside it.
        let inside = path
            .strip_prefix(home)
            .is_ok_and(|rel| rel.components().count() >= 1);
        if !inside {
            eprintln!(
                "data-path deep-clean: refusing {} (outside home)",
                path.display()
            );
            continue;
        }
        match std::fs::remove_dir_all(&path) {
            Ok(()) => removed.push(format!("{label} — {}", path.display())),
            Err(e) => eprintln!(
                "data-path deep-clean: could not remove {}: {e}",
                path.display()
            ),
        }
    }
    removed
}
