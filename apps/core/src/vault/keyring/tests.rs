use super::*;

fn master() -> FieldCipher {
    FieldCipher::new(&[9u8; 32])
}

#[test]
fn auto_mode_creates_a_key_and_round_trips() {
    let conn = Connection::open_in_memory().unwrap();
    let keyring = Keyring::load(&conn, master()).unwrap();
    assert_eq!(keyring.active_version(), 1);
    let (version, nonce, ct) = keyring.encrypt(b"hello").unwrap();
    assert_eq!(version, 1);
    assert_eq!(keyring.decrypt(version, &nonce, &ct).unwrap(), b"hello");

    // A reload unwraps the same key.
    let reloaded = Keyring::load(&conn, master()).unwrap();
    assert_eq!(reloaded.decrypt(version, &nonce, &ct).unwrap(), b"hello");
}

#[test]
fn legacy_rows_decrypt_with_the_master_key_in_auto_mode() {
    let conn = Connection::open_in_memory().unwrap();
    let keyring = Keyring::load(&conn, master()).unwrap();
    let (nonce, ct) = master().encrypt(b"legacy").unwrap();
    assert_eq!(
        keyring.decrypt(LEGACY_KEY_VERSION, &nonce, &ct).unwrap(),
        b"legacy"
    );
}

#[test]
fn rotation_keeps_old_versions_readable() {
    let conn = Connection::open_in_memory().unwrap();
    let keyring = Keyring::load(&conn, master()).unwrap();
    let (v1, n1, c1) = keyring.encrypt(b"one").unwrap();
    let v2 = keyring.rotate(&conn).unwrap();
    assert_eq!(v2, 2);
    let (v, _, _) = keyring.encrypt(b"two").unwrap();
    assert_eq!(v, 2);
    assert_eq!(keyring.decrypt(v1, &n1, &c1).unwrap(), b"one");
    assert_eq!(keyring.status().key_versions, vec![1, 2]);
}

#[test]
fn manual_seal_in_auto_mode_unseals_from_the_master_key() {
    let conn = Connection::open_in_memory().unwrap();
    let keyring = Keyring::load(&conn, master()).unwrap();
    keyring.seal();
    assert!(keyring.encrypt(b"x").is_err());
    keyring.unseal_auto(&conn).unwrap();
    assert!(keyring.encrypt(b"x").is_ok());
}
