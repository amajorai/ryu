//! Key-state tests (formerly carried inline by every satellite's `seal_keys.rs`).

use std::path::PathBuf;

use rand::RngCore as _;

use super::*;
use crate::ContentContext;

const ID: &str = "@ryu/test";

fn tmp() -> PathBuf {
    let mut nonce = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut nonce);
    let dir = std::env::temp_dir().join(format!(
        "ryu-seal-keys-{}",
        nonce.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn subkey(n: u8) -> PluginCipher {
    PluginCipher::from_subkey_b64(
        ID,
        &base64::engine::general_purpose::STANDARD.encode([n; 32]),
    )
    .unwrap()
}

#[test]
fn delivered_key_seals() {
    let keys = PluginKeys::resolve_with(ID, &tmp(), true, true, false, || Ok(subkey(1))).unwrap();
    assert_eq!(keys.source(), Some(KeySource::Delivered));
    assert!(keys.can_seal());
}

#[test]
fn under_core_without_a_key_is_compat_and_never_creates_a_root() {
    let dir = tmp();
    let keys = PluginKeys::resolve_with(ID, &dir, false, true, false, || unreachable!()).unwrap();
    assert!(!keys.can_seal());
    assert!(!dir.join("secrets").exists());
    assert!(matches!(
        keys.store_state("s.db", None, false),
        StoreSeal::Compat
    ));
    assert!(matches!(
        keys.store_state("s.db", Some("abc"), false),
        StoreSeal::Unhealthy(_)
    ));
    assert!(matches!(
        keys.store_state("s.db", None, true),
        StoreSeal::Unhealthy(_)
    ));
}

#[test]
fn standalone_root_is_generated_once_and_pinned() {
    let dir = tmp();
    let first = PluginKeys::resolve_with(ID, &dir, false, false, false, || unreachable!()).unwrap();
    assert_eq!(first.source(), Some(KeySource::Standalone));
    let again = PluginKeys::resolve_with(ID, &dir, false, false, false, || unreachable!()).unwrap();
    let kcv = |keys: &PluginKeys| keys.content_cipher("s.db").unwrap().kcv().to_owned();
    assert_eq!(kcv(&first), kcv(&again));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(dir.join("secrets").join(STANDALONE_ROOT_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    // A later RYU_MASTER_KEY is refused while the root file exists.
    assert!(PluginKeys::resolve_with(ID, &dir, false, false, true, || Ok(subkey(2))).is_err());
}

#[test]
fn standalone_master_key_is_pinned_and_a_different_one_refused() {
    let dir = tmp();
    PluginKeys::resolve_with(ID, &dir, false, false, true, || Ok(subkey(3))).unwrap();
    PluginKeys::resolve_with(ID, &dir, false, false, true, || Ok(subkey(3))).unwrap();
    let error =
        PluginKeys::resolve_with(ID, &dir, false, false, true, || Ok(subkey(4))).unwrap_err();
    assert!(error.to_string().contains("different key"), "{error}");
    // Unsetting the master key does not silently generate a new root either.
    assert!(PluginKeys::resolve_with(ID, &dir, false, false, false, || unreachable!()).is_err());
}

#[test]
fn a_store_recorded_under_another_key_is_unhealthy() {
    let keys = PluginKeys::sealing(subkey(5), KeySource::Delivered);
    let other = PluginKeys::sealing(subkey(6), KeySource::Delivered);
    let recorded = other.content_cipher("s.db").unwrap().kcv().to_owned();
    let state = keys.store_state("s.db", Some(&recorded), true);
    assert!(matches!(state, StoreSeal::Unhealthy(_)));
    assert!(state.ensure_writable().is_err());
    assert!(state
        .seal_text("x", &ContentContext::for_id("t.c", "1"))
        .is_err());
    let own = keys.content_cipher("s.db").unwrap().kcv().to_owned();
    assert!(keys.store_state("s.db", Some(&own), true).is_sealing());
}

#[test]
fn compat_refuses_to_pass_sealed_values_through() {
    let sealing =
        PluginKeys::sealing(subkey(7), KeySource::Delivered).store_state("s.db", None, false);
    let ctx = ContentContext::for_id("t.c", "1");
    let sealed = sealing.seal_text("hello", &ctx).unwrap();
    assert!(StoreSeal::Compat.open_text(&sealed, &ctx).is_err());
    assert_eq!(StoreSeal::Compat.open_text("plain", &ctx).unwrap(), "plain");
    assert_eq!(StoreSeal::Compat.seal_text("plain", &ctx).unwrap(), "plain");
    assert_eq!(sealing.open_text(&sealed, &ctx).unwrap(), "hello");
}

#[test]
fn compat_escapes_envelope_lookalikes_and_a_key_reseals_them() {
    let ctx = ContentContext::for_id("t.c", "1");
    for lookalike in ["encb:v1:hello", "encb:v2:x", "encb:raw:y"] {
        let stored = StoreSeal::Compat.seal_text(lookalike, &ctx).unwrap();
        assert_ne!(stored, lookalike);
        // Readable without a key, and unchanged by a round trip.
        assert_eq!(
            StoreSeal::Compat.open_text(&stored, &ctx).unwrap(),
            lookalike
        );
        // With a key it opens to the same value and is marked for resealing.
        let sealing =
            PluginKeys::sealing(subkey(8), KeySource::Delivered).store_state("s.db", None, false);
        let (value, reseal) = sealing.open_text_detailed(&stored, &ctx).unwrap();
        assert_eq!(value, lookalike);
        assert!(reseal);
        let sealed = sealing.seal_text(&value, &ctx).unwrap();
        assert_eq!(sealing.open_text(&sealed, &ctx).unwrap(), lookalike);
    }
    // A BLOB that starts with a Ryu magic cannot be stored keyless.
    assert!(StoreSeal::Compat.seal_bytes(b"RYU-CB01tail", &ctx).is_err());
    assert_eq!(
        StoreSeal::Compat.seal_bytes(b"plain", &ctx).unwrap(),
        b"plain"
    );
}
