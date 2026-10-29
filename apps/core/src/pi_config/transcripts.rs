//! Pi / pi-acp transcript lifetime.
//!
//! The managed Pi coding agent (a third-party binary) writes every session as
//! plaintext JSONL under `<PI_CODING_AGENT_DIR>/sessions/`, and pi-acp keeps its
//! ACP-session map in `<PI_CODING_AGENT_DIR>/.acp/session-map.json`. Ryu cannot
//! encrypt files another program reads and writes in its own format, so it limits
//! their scope and lifetime instead:
//!
//! - the Pi directories are owner-only (`0700`);
//! - deleting a conversation deletes the Pi transcripts of the native sessions
//!   bound to it ([`delete_sessions`]);
//! - removing a Pi account deletes the transcripts of the conversation session
//!   directories that used it (`account-sessions/<key>/sessions`);
//! - transcripts older than [`DEFAULT_MAX_AGE_DAYS`] are deleted
//!   ([`prune_older_than`], at most once a day).
//!
//! Ryu keeps its own (sealed) copy of every conversation, so a pruned Pi
//! transcript only means the next turn starts a fresh Pi session from Ryu's
//! history instead of resuming the old one.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// Environment override for the transcript age cap, in days (0 turns it off).
const MAX_AGE_DAYS_ENV: &str = "RYU_PI_TRANSCRIPT_MAX_AGE_DAYS";
/// Pi transcripts older than this are deleted.
pub const DEFAULT_MAX_AGE_DAYS: u64 = 30;

const SESSIONS_DIR: &str = "sessions";
const ACP_DIR: &str = ".acp";
const SESSION_MAP: &str = "session-map.json";
const ACCOUNT_SESSIONS_DIR: &str = "account-sessions";

/// Every Pi agent directory Core manages: the shared one and each
/// conversation's account-session directory.
fn agent_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![root.to_path_buf()];
    if let Ok(entries) = std::fs::read_dir(root.join(ACCOUNT_SESSIONS_DIR)) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                dirs.push(entry.path());
            }
        }
    }
    dirs
}

#[cfg(unix)]
fn restrict_dir(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
}

#[cfg(not(unix))]
fn restrict_dir(_path: &Path) {}

/// Make the Pi directories under `root` owner-only. Called before Pi spawns.
pub fn restrict_permissions(root: &Path) {
    restrict_dir(root);
    restrict_dir(&root.join(ACCOUNT_SESSIONS_DIR));
    for dir in agent_dirs(root) {
        restrict_dir(&dir);
        restrict_dir(&dir.join(SESSIONS_DIR));
        restrict_dir(&dir.join(ACP_DIR));
    }
}

/// Whether `path` lies inside `root` (both resolved), so a session map can never
/// make Core delete a file elsewhere.
fn inside(root: &Path, path: &Path) -> bool {
    match (std::fs::canonicalize(root), std::fs::canonicalize(path)) {
        (Ok(root), Ok(path)) => path.starts_with(root),
        _ => false,
    }
}

fn remove_file_quietly(path: &Path) -> bool {
    match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            tracing::warn!(%error, "could not remove a Pi transcript");
            false
        }
    }
}

fn write_map(path: &Path, map: &serde_json::Value) -> std::io::Result<()> {
    let text = format!("{}\n", serde_json::to_string_pretty(map)?);
    let temporary = path.with_extension("json.ryu-tmp");
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        std::io::Write::write_all(&mut file, text.as_bytes())?;
        file.sync_all()?;
    }
    std::fs::rename(&temporary, path)
}

/// Delete the Pi transcripts (and pi-acp map entries) of these native ACP
/// session ids, in the shared Pi directory and every account-session directory.
/// Returns how many transcript files were removed.
pub fn delete_sessions(root: &Path, native_session_ids: &[String]) -> usize {
    if native_session_ids.is_empty() {
        return 0;
    }
    let mut removed = 0;
    for dir in agent_dirs(root) {
        let map_path = dir.join(ACP_DIR).join(SESSION_MAP);
        let Ok(text) = std::fs::read_to_string(&map_path) else {
            continue;
        };
        let Ok(mut map) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let Some(sessions) = map
            .get_mut("sessions")
            .and_then(serde_json::Value::as_object_mut)
        else {
            continue;
        };
        let mut changed = false;
        for id in native_session_ids {
            let Some(entry) = sessions.remove(id) else {
                continue;
            };
            changed = true;
            if let Some(file) = entry.get("sessionFile").and_then(serde_json::Value::as_str) {
                let file = PathBuf::from(file);
                if inside(&dir, &file) && remove_file_quietly(&file) {
                    removed += 1;
                }
            }
        }
        if changed {
            if let Err(error) = write_map(&map_path, &map) {
                tracing::warn!(%error, "could not update the pi-acp session map");
            }
        }
    }
    removed
}

/// Delete the transcripts of the account-session directories `session_keys`
/// (their `sessions/` and pi-acp map). Used when the Pi account those
/// conversations ran under is removed.
pub fn delete_account_session_transcripts(root: &Path, session_keys: &[String]) -> usize {
    let mut removed = 0;
    for key in session_keys {
        if key.is_empty()
            || !key.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
        {
            continue;
        }
        let dir = root.join(ACCOUNT_SESSIONS_DIR).join(key);
        for name in [SESSIONS_DIR, ACP_DIR] {
            let path = dir.join(name);
            if std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_dir()) {
                match std::fs::remove_dir_all(&path) {
                    Ok(()) => removed += 1,
                    Err(error) => {
                        tracing::warn!(%error, "could not remove Pi account-session transcripts");
                    }
                }
            }
        }
    }
    removed
}

/// Delete Pi transcripts older than `max_age` (by modification time) in every
/// managed Pi directory, drop pi-acp map entries whose file is gone, and remove
/// emptied folders. Returns how many transcript files were removed.
pub fn prune_older_than(root: &Path, max_age: Duration) -> usize {
    let mut removed = 0;
    for dir in agent_dirs(root) {
        let sessions = dir.join(SESSIONS_DIR);
        removed += prune_tree(&sessions, max_age);
        let map_path = dir.join(ACP_DIR).join(SESSION_MAP);
        let Ok(text) = std::fs::read_to_string(&map_path) else {
            continue;
        };
        let Ok(mut map) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let Some(entries) = map
            .get_mut("sessions")
            .and_then(serde_json::Value::as_object_mut)
        else {
            continue;
        };
        let before = entries.len();
        entries.retain(|_, entry| {
            entry
                .get("sessionFile")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|file| Path::new(file).exists())
        });
        if entries.len() != before {
            if let Err(error) = write_map(&map_path, &map) {
                tracing::warn!(%error, "could not update the pi-acp session map");
            }
        }
    }
    removed
}

fn prune_tree(dir: &Path, max_age: Duration) -> usize {
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
            removed += prune_tree(&path, max_age);
            // Remove the folder only once it is empty.
            let _ = std::fs::remove_dir(&path);
        } else if kind.is_file() {
            let old = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| modified.elapsed().ok())
                .is_some_and(|age| age >= max_age);
            if old && remove_file_quietly(&path) {
                removed += 1;
            }
        }
    }
    removed
}

fn max_age_days() -> u64 {
    std::env::var(MAX_AGE_DAYS_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_MAX_AGE_DAYS)
}

/// Tighten permissions and apply the age cap, at most once a day per process,
/// on a background thread.
pub fn maintain_once_a_day(root: PathBuf) {
    use std::sync::Mutex;
    static LAST_RUN: Mutex<Option<std::time::Instant>> = Mutex::new(None);
    restrict_permissions(&root);
    let days = max_age_days();
    if days == 0 {
        return;
    }
    {
        let mut last = LAST_RUN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if last.is_some_and(|at| at.elapsed() < Duration::from_secs(24 * 60 * 60)) {
            return;
        }
        *last = Some(std::time::Instant::now());
    }
    let spawned = std::thread::Builder::new()
        .name("pi-transcript-prune".to_owned())
        .spawn(move || {
            let removed = prune_older_than(&root, Duration::from_secs(days * 24 * 60 * 60));
            if removed > 0 {
                tracing::info!(removed, "Pi: deleted transcripts older than {days} days");
            }
        });
    if let Err(error) = spawned {
        tracing::warn!(%error, "could not start the Pi transcript age cap");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_file(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(SESSIONS_DIR).join("--work--").join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{\"type\":\"message\",\"text\":\"transcript\"}\n").unwrap();
        path
    }

    fn write_session_map(dir: &Path, entries: &[(&str, &Path)]) {
        let mut sessions = serde_json::Map::new();
        for (id, file) in entries {
            sessions.insert(
                (*id).to_owned(),
                serde_json::json!({ "sessionId": id, "cwd": "/work", "sessionFile": file }),
            );
        }
        let acp = dir.join(ACP_DIR);
        std::fs::create_dir_all(&acp).unwrap();
        std::fs::write(
            acp.join(SESSION_MAP),
            serde_json::json!({ "version": 1, "sessions": sessions }).to_string(),
        )
        .unwrap();
    }

    #[test]
    fn deleting_a_conversation_removes_only_its_transcripts() {
        let root = tempfile::tempdir().unwrap();
        let shared = root.path();
        let account = shared.join(ACCOUNT_SESSIONS_DIR).join("abc123");
        let mine = session_file(shared, "1_mine.jsonl");
        let other = session_file(shared, "2_other.jsonl");
        let mine_in_account = session_file(&account, "3_mine.jsonl");
        write_session_map(shared, &[("s-mine", &mine), ("s-other", &other)]);
        write_session_map(&account, &[("s-mine-2", &mine_in_account)]);

        let removed = delete_sessions(shared, &["s-mine".to_owned(), "s-mine-2".to_owned()]);
        assert_eq!(removed, 2);
        assert!(!mine.exists());
        assert!(!mine_in_account.exists());
        assert!(other.exists());
        let map = std::fs::read_to_string(shared.join(ACP_DIR).join(SESSION_MAP)).unwrap();
        assert!(!map.contains("s-mine"));
        assert!(map.contains("s-other"));
    }

    #[test]
    fn a_session_map_cannot_point_outside_the_pi_directory() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("keep.txt");
        std::fs::write(&victim, "keep").unwrap();
        write_session_map(root.path(), &[("s", &victim)]);
        assert_eq!(delete_sessions(root.path(), &["s".to_owned()]), 0);
        assert!(victim.exists());
    }

    #[test]
    fn account_removal_and_age_cap_remove_transcripts() {
        let root = tempfile::tempdir().unwrap();
        let account = root.path().join(ACCOUNT_SESSIONS_DIR).join("key1");
        let file = session_file(&account, "1_a.jsonl");
        std::fs::write(account.join("auth.json"), "{}").unwrap();
        assert_eq!(
            delete_account_session_transcripts(
                root.path(),
                &["key1".to_owned(), "../x".to_owned()]
            ),
            1
        );
        assert!(!file.exists());
        assert!(account.join("auth.json").exists());

        let shared = session_file(root.path(), "2_b.jsonl");
        write_session_map(root.path(), &[("s", &shared)]);
        assert_eq!(prune_older_than(root.path(), Duration::from_secs(3600)), 0);
        assert!(shared.exists());
        assert_eq!(prune_older_than(root.path(), Duration::ZERO), 1);
        assert!(!shared.exists());
        assert!(!root.path().join(SESSIONS_DIR).join("--work--").exists());
        let map = std::fs::read_to_string(root.path().join(ACP_DIR).join(SESSION_MAP)).unwrap();
        assert!(!map.contains("\"s\""));
    }

    #[cfg(unix)]
    #[test]
    fn pi_directories_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        session_file(root.path(), "1.jsonl");
        std::fs::create_dir_all(root.path().join(ACP_DIR)).unwrap();
        restrict_permissions(root.path());
        for dir in [
            root.path().to_path_buf(),
            root.path().join(SESSIONS_DIR),
            root.path().join(ACP_DIR),
        ] {
            let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "{}", dir.display());
        }
    }
}
