//! Compat mode never applies to a store that already holds sealed data: a
//! Shadow without a key refuses capture writes there, even when Core started
//! it. Its own process: the sealing state is process-global.

use shadow_core::seal::{self, SealingState};

#[test]
fn a_sealed_store_without_a_key_refuses_writes_even_under_core() {
    std::env::remove_var("RYU_MASTER_KEY");
    let dir = tempfile::tempdir().unwrap();
    let indices = dir.path().join("indices");
    std::fs::create_dir_all(&indices).unwrap();
    {
        let conn = rusqlite::Connection::open(indices.join("timeline.db")).unwrap();
        ryu_crypto::content_sqlite::record_store_kcv(&conn, seal::TIMELINE_STORE, "recorded-kcv")
            .unwrap();
    }
    seal::set_started_by_core(true);
    shadow_core::init_storage(dir.path().to_string_lossy().into_owned()).unwrap();

    assert_eq!(seal::state(), SealingState::NoKey);
    assert!(seal::require_writable().is_err());
    assert!(shadow_core::write_event(vec![0x80]).is_err());
}
