//! Compat mode: a Shadow that an older Core (one that delivers no sealing key)
//! starts on a store that was never sealed keeps capturing in plaintext, as
//! before sealing. Its own process: the sealing state is process-global.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use shadow_core::seal::{self, SealingState};

fn event_bytes(marker: &str) -> Vec<u8> {
    let mut event: HashMap<&str, rmpv::Value> = HashMap::new();
    event.insert("ts", rmpv::Value::from(1_708_300_800_000_000u64));
    event.insert("track", rmpv::Value::from(3u8));
    event.insert("type", rmpv::Value::from("test"));
    event.insert("window_title", rmpv::Value::from(marker));
    rmp_serde::to_vec(&event).unwrap()
}

fn files_under(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                out.push(path);
            }
        }
    }
    out
}

#[test]
fn an_older_core_without_a_key_keeps_capturing_in_plaintext() {
    std::env::remove_var("RYU_MASTER_KEY");
    let dir = tempfile::tempdir().unwrap();
    seal::set_started_by_core(true);
    shadow_core::init_storage(dir.path().to_string_lossy().into_owned()).unwrap();

    assert_eq!(seal::state(), SealingState::Compat);
    assert_eq!(
        seal::health()["sealing"],
        serde_json::json!("waiting for a Ryu update")
    );
    seal::require_writable().expect("compat mode accepts capture writes");

    shadow_core::write_event(event_bytes("compat-window-marker")).unwrap();

    // The open event segment is the pre-sealing plaintext frame log.
    let segment = files_under(&dir.path().join("events"))
        .into_iter()
        .find(|path| path.extension().is_some_and(|ext| ext == "msgpack"))
        .expect("an open event segment");
    let bytes = std::fs::read(&segment).unwrap();
    assert!(!bytes.starts_with(b"RYU-"), "not a sealed log");
    assert!(bytes
        .windows(b"compat-window-marker".len())
        .any(|window| window == b"compat-window-marker"));

    // The timeline keeps the plaintext column it kept before sealing.
    let conn = rusqlite::Connection::open(dir.path().join("indices").join("timeline.db")).unwrap();
    let title: String = conn
        .query_row("SELECT window_title FROM events_index LIMIT 1", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(title, "compat-window-marker");

    // Media files are written in plaintext too.
    let media_root = dir.path().join("media");
    let keyframe = media_root.join("keyframes").join("compat.jpg");
    std::fs::create_dir_all(keyframe.parent().unwrap()).unwrap();
    shadow_core::media::write_sealed_media_in(&media_root, &keyframe, b"jpeg bytes").unwrap();
    assert_eq!(std::fs::read(&keyframe).unwrap(), b"jpeg bytes");

    // Nothing was recorded as sealed, so the first start with a key seals
    // these as legacy plaintext; once a key is recorded, compat is over.
    assert!(seal::store_never_sealed(
        &conn,
        &dir.path().join("indices").join("search")
    ));
    seal::install_fixed_key_for_tests();
    seal::check_store_keys(&conn).unwrap();
    assert!(!seal::store_never_sealed(
        &conn,
        &dir.path().join("indices").join("search")
    ));
}
