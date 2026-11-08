use std::collections::BTreeSet;

use rusqlite::{params, Connection};
use ryu_crypto::FieldCipher;

use super::super::Keyring;
use super::{rewrap_wrapping, PRUNE_GRACE_MILLIS};

const DAY: i64 = 24 * 3600 * 1000;

fn master() -> FieldCipher {
    FieldCipher::new(&[9u8; 32])
}

fn set_created(conn: &Connection, version: u32, created_at: i64) {
    conn.execute(
        "UPDATE vault_keyring SET created_at = ?1 WHERE version = ?2",
        params![created_at, version],
    )
    .unwrap();
}

#[test]
fn rotation_is_due_only_after_the_period_and_never_when_disabled() {
    let conn = Connection::open_in_memory().unwrap();
    let keyring = Keyring::load(&conn, master()).unwrap();
    set_created(&conn, 1, 1_000);
    assert!(!keyring.rotation_due(&conn, 1_000 + DAY - 1, DAY).unwrap());
    assert!(keyring.rotation_due(&conn, 1_000 + DAY, DAY).unwrap());
    assert!(!keyring.rotation_due(&conn, 1_000 + DAY * 10, 0).unwrap());
    keyring.seal();
    assert!(!keyring.rotation_due(&conn, 1_000 + DAY, DAY).unwrap());
}

#[test]
fn pruning_skips_active_referenced_and_recently_superseded_keys() {
    let conn = Connection::open_in_memory().unwrap();
    let keyring = Keyring::load(&conn, master()).unwrap();
    let (v1, n1, c1) = keyring.encrypt(b"one").unwrap();
    keyring.rotate(&conn).unwrap();
    keyring.rotate(&conn).unwrap();
    keyring.rotate(&conn).unwrap();
    // v2 was superseded long ago, v3 just now, v4 is active.
    set_created(&conn, 3, 0);
    let now = PRUNE_GRACE_MILLIS * 4;
    set_created(&conn, 4, now - 10);

    let referenced = BTreeSet::from([v1]);
    let prunable = keyring
        .prunable_versions(&conn, &referenced, now, PRUNE_GRACE_MILLIS)
        .unwrap();
    assert_eq!(
        prunable,
        vec![2],
        "v1 is referenced, v3 is in its grace window"
    );

    keyring.delete_versions(&conn, &prunable).unwrap();
    keyring.forget_versions(&prunable);
    assert_eq!(keyring.status().key_versions, vec![1, 3, 4]);
    assert_eq!(keyring.decrypt(v1, &n1, &c1).unwrap(), b"one");
    let reloaded = Keyring::load(&conn, master()).unwrap();
    assert_eq!(reloaded.status().key_versions, vec![1, 3, 4]);
    assert_eq!(reloaded.active_version(), 4);

    // Once nothing references v1 and the grace is over, v1 and v3 go too.
    let later = keyring
        .prunable_versions(
            &conn,
            &BTreeSet::new(),
            now + PRUNE_GRACE_MILLIS,
            PRUNE_GRACE_MILLIS,
        )
        .unwrap();
    assert_eq!(later, vec![1, 3]);
    assert!(
        keyring.delete_versions(&conn, &[4]).is_err(),
        "the active key stays"
    );
}

#[test]
fn pruning_refuses_while_sealed() {
    let conn = Connection::open_in_memory().unwrap();
    let keyring = Keyring::load(&conn, master()).unwrap();
    keyring.rotate(&conn).unwrap();
    keyring.seal();
    assert!(keyring
        .prunable_versions(&conn, &BTreeSet::new(), i64::MAX / 2, 0)
        .is_err());
}

#[test]
fn kek_rewrap_moves_data_keys_and_the_audit_key_to_the_new_master() {
    let conn = Connection::open_in_memory().unwrap();
    let keyring = Keyring::load(&conn, master()).unwrap();
    let audit_key = crate::vault::audit::load_or_create_key(&conn, keyring.master()).unwrap();
    let (version, nonce, ct) = keyring.encrypt(b"guarded").unwrap();
    keyring.rotate(&conn).unwrap();

    let new = FieldCipher::new(&[4u8; 32]);
    let report = rewrap_wrapping(&conn, &master(), &new).unwrap();
    assert_eq!(report.data_keys, 2);
    assert_eq!(report.meta_entries, 1);
    assert!(!report.shamir);

    let reopened = Keyring::load(&conn, new.clone()).unwrap();
    assert_eq!(reopened.decrypt(version, &nonce, &ct).unwrap(), b"guarded");
    assert_eq!(
        crate::vault::audit::load_or_create_key(&conn, &new).unwrap(),
        audit_key
    );
    assert!(
        Keyring::load(&conn, master()).is_err(),
        "the old master key no longer opens the keyring"
    );
}

#[test]
fn kek_rewrap_with_the_wrong_old_key_changes_nothing() {
    let conn = Connection::open_in_memory().unwrap();
    let keyring = Keyring::load(&conn, master()).unwrap();
    let (version, nonce, ct) = keyring.encrypt(b"guarded").unwrap();
    let wrong = FieldCipher::new(&[1u8; 32]);
    assert!(rewrap_wrapping(&conn, &wrong, &FieldCipher::new(&[4u8; 32])).is_err());
    let reopened = Keyring::load(&conn, master()).unwrap();
    assert_eq!(reopened.decrypt(version, &nonce, &ct).unwrap(), b"guarded");
}

#[test]
fn kek_rewrap_leaves_share_wrapped_data_keys_alone() {
    let conn = Connection::open_in_memory().unwrap();
    let keyring = Keyring::load(&conn, master()).unwrap();
    let (version, nonce, ct) = keyring.encrypt(b"guarded").unwrap();
    let shares = keyring.init_shamir(&conn, 3, 2).unwrap();
    let report = rewrap_wrapping(&conn, &master(), &FieldCipher::new(&[4u8; 32])).unwrap();
    assert!(report.shamir);
    assert_eq!(report.data_keys, 0);

    let sealed = Keyring::load(&conn, FieldCipher::new(&[4u8; 32])).unwrap();
    sealed.submit_share(&conn, &shares[0]).unwrap();
    sealed.submit_share(&conn, &shares[1]).unwrap();
    assert_eq!(sealed.decrypt(version, &nonce, &ct).unwrap(), b"guarded");
}
