//! Corruption-safe JSON file persistence for small Core-owned state stores.
//!
//! Missing files resolve to `T::default()`. Every other read or parse failure is
//! returned to the caller, so a later mutation can never reinterpret corrupt
//! state as an empty document and overwrite it. Mutations are serialized per
//! path within the process and replace the destination atomically.

use std::collections::HashMap;
use std::fs::File;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{Context, Result};
use serde::de::DeserializeOwned;
use serde::Serialize;

fn path_locks() -> &'static Mutex<HashMap<PathBuf, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_for(path: &Path) -> Arc<Mutex<()>> {
    let mut locks = path_locks()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    locks
        .entry(path.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn read_unlocked<T>(path: &Path) -> Result<T>
where
    T: Default + DeserializeOwned,
{
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(T::default()),
        Err(error) => {
            return Err(error).with_context(|| format!("reading JSON store {}", path.display()))
        }
    };
    serde_json::from_str(&raw).with_context(|| format!("parsing JSON store {}", path.display()))
}

fn write_unlocked<T>(path: &Path, value: &T) -> Result<()>
where
    T: Serialize,
{
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)
        .with_context(|| format!("creating JSON store directory {}", parent.display()))?;

    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .with_context(|| format!("creating temporary JSON store beside {}", path.display()))?;
    serde_json::to_writer_pretty(temporary.as_file_mut(), value)
        .with_context(|| format!("serializing JSON store {}", path.display()))?;
    temporary
        .as_file_mut()
        .write_all(b"\n")
        .with_context(|| format!("finishing JSON store {}", path.display()))?;
    temporary
        .as_file_mut()
        .sync_all()
        .with_context(|| format!("syncing JSON store {}", path.display()))?;
    temporary
        .persist(path)
        .map_err(|error| error.error)
        .with_context(|| format!("atomically replacing JSON store {}", path.display()))?;

    // Best-effort durability for the directory entry. Some platforms/filesystems
    // do not allow opening a directory as a file, so replacement success remains
    // authoritative and the sync error is intentionally ignored.
    if let Ok(directory) = File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

/// Read a JSON store. A missing path is `T::default()`; corruption is an error.
pub fn read_or_default<T>(path: &Path) -> Result<T>
where
    T: Default + DeserializeOwned,
{
    let lock = lock_for(path);
    let _guard = lock.lock().unwrap_or_else(|error| error.into_inner());
    read_unlocked(path)
}

/// Serialize one read-modify-write mutation for `path` and replace it atomically.
/// The closure is not called when the existing file is unreadable or malformed.
pub fn mutate<T, R, F>(path: &Path, mutation: F) -> Result<R>
where
    T: Default + DeserializeOwned + Serialize,
    F: FnOnce(&mut T) -> Result<R>,
{
    let lock = lock_for(path);
    let _guard = lock.lock().unwrap_or_else(|error| error.into_inner());
    let mut value = read_unlocked(path)?;
    let result = mutation(&mut value)?;
    write_unlocked(path, &value)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn missing_is_default_but_corruption_is_not() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.json");
        let empty: BTreeMap<String, u64> = read_or_default(&path).unwrap();
        assert!(empty.is_empty());

        std::fs::write(&path, "{not-json").unwrap();
        let before = std::fs::read_to_string(&path).unwrap();
        let result = mutate::<BTreeMap<String, u64>, _, _>(&path, |state| {
            state.insert("lost".into(), 1);
            Ok(())
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn concurrent_mutations_preserve_every_key() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.json");
        let mut threads = Vec::new();
        for index in 0..24_u64 {
            let path = path.clone();
            threads.push(std::thread::spawn(move || {
                mutate::<BTreeMap<String, u64>, _, _>(&path, |state| {
                    state.insert(format!("key-{index}"), index);
                    Ok(())
                })
                .unwrap();
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }
        let stored: BTreeMap<String, u64> = read_or_default(&path).unwrap();
        assert_eq!(stored.len(), 24);
        assert_eq!(stored.get("key-23"), Some(&23));
    }
}
