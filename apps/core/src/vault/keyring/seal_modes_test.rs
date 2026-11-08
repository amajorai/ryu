use super::super::Keyring;
use rusqlite::Connection;
use ryu_crypto::FieldCipher;

use crate::vault::keyring::LEGACY_KEY_VERSION;

fn master() -> FieldCipher {
    FieldCipher::new(&[9u8; 32])
}

#[test]
fn shamir_mode_seals_on_reload_and_unseals_with_threshold_shares() {
    let conn = Connection::open_in_memory().unwrap();
    let keyring = Keyring::load(&conn, master()).unwrap();
    let (version, nonce, ct) = keyring.encrypt(b"guarded").unwrap();
    let shares = keyring.init_shamir(&conn, 5, 3).unwrap();
    assert_eq!(shares.len(), 5);

    let reloaded = Keyring::load(&conn, master()).unwrap();
    assert!(reloaded.is_sealed());
    assert!(reloaded.decrypt(version, &nonce, &ct).is_err());
    assert!(reloaded.encrypt(b"x").is_err());
    // Legacy reads are refused too.
    assert!(reloaded.decrypt(LEGACY_KEY_VERSION, &nonce, &ct).is_err());

    let status = reloaded.submit_share(&conn, &shares[0]).unwrap();
    assert_eq!(status.progress, 1);
    assert!(reloaded.submit_share(&conn, &shares[0]).is_err());
    reloaded.submit_share(&conn, &shares[3]).unwrap();
    let status = reloaded.submit_share(&conn, &shares[4]).unwrap();
    assert!(!status.sealed);
    assert_eq!(reloaded.decrypt(version, &nonce, &ct).unwrap(), b"guarded");

    // Rotation in shamir mode wraps with the root key.
    let v2 = reloaded.rotate(&conn).unwrap();
    reloaded.seal();
    let again = Keyring::load(&conn, master()).unwrap();
    for share in &shares[..3] {
        again.submit_share(&conn, share).unwrap();
    }
    assert_eq!(again.status().key_versions, vec![1, v2]);
}

#[test]
fn shares_from_another_vault_do_not_unseal() {
    let conn_a = Connection::open_in_memory().unwrap();
    let conn_b = Connection::open_in_memory().unwrap();
    let a = Keyring::load(&conn_a, master()).unwrap();
    let b = Keyring::load(&conn_b, master()).unwrap();
    let _ = a.init_shamir(&conn_a, 3, 2).unwrap();
    let foreign = b.init_shamir(&conn_b, 3, 2).unwrap();
    let sealed = Keyring::load(&conn_a, master()).unwrap();
    sealed.submit_share(&conn_a, &foreign[0]).unwrap();
    assert!(sealed.submit_share(&conn_a, &foreign[1]).is_err());
    assert!(sealed.is_sealed());
    assert_eq!(
        sealed.status().progress,
        0,
        "a failed attempt resets progress"
    );
}

#[test]
fn shamir_can_migrate_back_to_auto() {
    let conn = Connection::open_in_memory().unwrap();
    let keyring = Keyring::load(&conn, master()).unwrap();
    let (version, nonce, ct) = keyring.encrypt(b"v").unwrap();
    keyring.init_shamir(&conn, 3, 2).unwrap();
    keyring.migrate_to_auto(&conn).unwrap();
    let reloaded = Keyring::load(&conn, master()).unwrap();
    assert!(!reloaded.is_sealed());
    assert_eq!(reloaded.decrypt(version, &nonce, &ct).unwrap(), b"v");
}
