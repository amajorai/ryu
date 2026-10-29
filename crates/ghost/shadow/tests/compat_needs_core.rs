//! A Shadow started by hand (not by Core) without a key never enters compat
//! mode: capture writes are refused. Its own process: the sealing state is
//! process-global.

use shadow_core::seal::{self, SealingState};

#[test]
fn a_shadow_started_by_hand_without_a_key_refuses_writes() {
    std::env::remove_var("RYU_MASTER_KEY");
    let dir = tempfile::tempdir().unwrap();
    seal::set_started_by_core(false);
    shadow_core::init_storage(dir.path().to_string_lossy().into_owned()).unwrap();

    assert_eq!(seal::state(), SealingState::NoKey);
    assert!(seal::require_writable().is_err());
    assert!(shadow_core::write_event(vec![0x80]).is_err());
    let events = dir.path().join("events");
    assert!(events
        .read_dir()
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(true));
}
