//! Codex transcript lifetime in the Ryu-owned Codex homes.
//!
//! Every Ryu-managed Codex spawn runs with `CODEX_HOME` set to a home under
//! the data folder (`runtimes/codex-safety-home`, or `runtimes/codex-home` on
//! the gateway-routed path). The third-party Codex binary writes each session
//! as a plaintext JSONL rollout under `<home>/sessions/YYYY/MM/DD/` (and
//! `archived_sessions/`), and keeps a prompt history in `<home>/history.jsonl`.
//! Ryu cannot encrypt files another program reads and writes in its own
//! format, so it limits their scope and lifetime instead:
//!
//! - the homes are owner-only (`0700`, see `set_private_directory_permissions`);
//! - the managed `config.toml` sets `history.persistence = "none"`, and a
//!   `history.jsonl` an earlier build let Codex write is deleted;
//! - deleting a conversation deletes the rollouts of the native sessions bound
//!   to it ([`delete_sessions`]);
//! - rollouts older than [`DEFAULT_MAX_AGE_DAYS`] are deleted
//!   ([`prune_older_than`], at most once a day per home).
//!
//! Ryu keeps its own (sealed) copy of every conversation, so a pruned rollout
//! only means the next turn starts a fresh Codex session from Ryu's history.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Environment override for the rollout age cap, in days (0 turns it off).
const MAX_AGE_DAYS_ENV: &str = "RYU_CODEX_TRANSCRIPT_MAX_AGE_DAYS";
/// Codex rollouts older than this are deleted.
pub const DEFAULT_MAX_AGE_DAYS: u64 = 30;

/// Folders Codex writes session rollouts to.
const SESSION_DIRS: [&str; 2] = ["sessions", "archived_sessions"];
/// Codex's prompt history file (disabled by the managed config).
pub const HISTORY_FILE: &str = "history.jsonl";

/// The Ryu-owned Codex homes.
pub fn managed_homes() -> Vec<PathBuf> {
    let mut homes = vec![super::safety_home(), super::codex_home()];
    homes.dedup();
    homes
}

/// Whether `id` is safe to match inside a file name (Codex session ids are
/// UUIDs).
fn plausible_session_id(id: &str) -> bool {
    id.len() >= 8
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn remove_file_quietly(path: &Path) -> bool {
    match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            tracing::warn!(%error, "could not remove a Codex transcript");
            false
        }
    }
}

/// Visit every regular file under `dir` (symlinks are not followed), removing
/// a folder once it is empty.
fn walk_files(dir: &Path, visit: &mut dyn FnMut(&Path, &std::fs::DirEntry) -> bool) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            removed += walk_files(&path, visit);
            let _ = std::fs::remove_dir(&path);
        } else if kind.is_file() && visit(&path, &entry) {
            removed += 1;
        }
    }
    removed
}

/// Delete the Codex rollouts of these native session ids in `homes`. Returns
/// how many files were removed.
pub fn delete_sessions(homes: &[PathBuf], native_session_ids: &[String]) -> usize {
    let suffixes: Vec<String> = native_session_ids
        .iter()
        .filter(|id| plausible_session_id(id))
        .map(|id| format!("-{id}.jsonl"))
        .collect();
    if suffixes.is_empty() {
        return 0;
    }
    let mut removed = 0;
    for home in homes {
        for name in SESSION_DIRS {
            removed += walk_files(&home.join(name), &mut |path, _| {
                let matches = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        suffixes
                            .iter()
                            .any(|suffix| name.ends_with(suffix.as_str()))
                    });
                matches && remove_file_quietly(path)
            });
        }
    }
    removed
}

/// Delete Codex rollouts older than `max_age` (by modification time) and any
/// prompt history file in `home`. Returns how many files were removed.
pub fn prune_older_than(home: &Path, max_age: Duration) -> usize {
    let mut removed = usize::from(remove_file_quietly(&home.join(HISTORY_FILE)));
    for name in SESSION_DIRS {
        removed += walk_files(&home.join(name), &mut |path, entry| {
            let old = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| modified.elapsed().ok())
                .is_some_and(|age| age >= max_age);
            old && remove_file_quietly(path)
        });
    }
    removed
}

fn max_age_days() -> u64 {
    std::env::var(MAX_AGE_DAYS_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_MAX_AGE_DAYS)
}

/// Apply the age cap to `home`, at most once a day per home and process, on a
/// background thread. Called before Codex spawns.
pub fn maintain_once_a_day(home: PathBuf) {
    static LAST_RUN: Mutex<Option<HashMap<PathBuf, Instant>>> = Mutex::new(None);
    // The prompt history is never wanted: drop it right away, whatever the cap.
    remove_file_quietly(&home.join(HISTORY_FILE));
    let days = max_age_days();
    if days == 0 {
        return;
    }
    {
        let mut last = LAST_RUN
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let runs = last.get_or_insert_with(HashMap::new);
        if runs
            .get(&home)
            .is_some_and(|at| at.elapsed() < Duration::from_secs(24 * 60 * 60))
        {
            return;
        }
        runs.insert(home.clone(), Instant::now());
    }
    let spawned = std::thread::Builder::new()
        .name("codex-transcript-prune".to_owned())
        .spawn(move || {
            let removed = prune_older_than(&home, Duration::from_secs(days * 24 * 60 * 60));
            if removed > 0 {
                tracing::info!(removed, "Codex: deleted transcripts older than {days} days");
            }
        });
    if let Err(error) = spawned {
        tracing::warn!(%error, "could not start the Codex transcript age cap");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "0199a0b1-2c3d-7e4f-8a9b-0c1d2e3f4a5b";
    const OTHER: &str = "0199a0b1-2c3d-7e4f-8a9b-ffffffffffff";

    fn rollout(home: &Path, dir: &str, id: &str) -> PathBuf {
        let path = home
            .join(dir)
            .join("2026/10/20")
            .join(format!("rollout-2026-10-20T10-00-00-{id}.jsonl"));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{\"type\":\"message\",\"text\":\"transcript\"}\n").unwrap();
        path
    }

    #[test]
    fn deleting_a_conversation_removes_only_its_rollouts() {
        let root = tempfile::tempdir().unwrap();
        let safety = root.path().join("codex-safety-home");
        let gateway = root.path().join("codex-home");
        let mine = rollout(&safety, "sessions", SESSION);
        let archived = rollout(&gateway, "archived_sessions", SESSION);
        let other = rollout(&safety, "sessions", OTHER);
        let removed = delete_sessions(
            &[safety.clone(), gateway.clone()],
            &[SESSION.to_owned(), "../../etc".to_owned()],
        );
        assert_eq!(removed, 2);
        assert!(!mine.exists());
        assert!(!archived.exists());
        assert!(other.exists(), "another conversation's rollout is kept");
        assert!(
            !gateway.join("archived_sessions/2026").exists(),
            "emptied folders are removed"
        );
    }

    #[test]
    fn the_age_cap_removes_old_rollouts_and_the_prompt_history() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("codex-safety-home");
        let rollout = rollout(&home, "sessions", SESSION);
        std::fs::write(home.join(HISTORY_FILE), "{\"text\":\"a prompt\"}\n").unwrap();
        // Nothing is old enough yet: only the history goes.
        assert_eq!(prune_older_than(&home, Duration::from_secs(3600)), 1);
        assert!(rollout.exists());
        assert!(!home.join(HISTORY_FILE).exists());
        assert_eq!(prune_older_than(&home, Duration::ZERO), 1);
        assert!(!rollout.exists());
    }
}
