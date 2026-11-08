//! `keys rotate` against a real vault file. The orchestration tests inject the
//! key installer; the end-to-end case runs the real custody swap in a child
//! process with its own data folder, so no other test sees its key change.

use std::path::Path;

use ryu_crypto::custody::{self, AdoptOutcome};
use ryu_crypto::FieldCipher;

use super::{rotate_with, ENV_MASTER_KEY};
use crate::plugin_secrets::PluginSecretStore;

const CHILD_ENV: &str = "RYU_CORE_KEYS_ROTATE_CHILD";

fn outcome() -> AdoptOutcome {
    AdoptOutcome {
        kcv: "new-kcv".to_owned(),
        custody: "file".to_owned(),
        retired: Some("old-kcv".to_owned()),
    }
}

/// A vault file under `dir` holding one plugin secret, sealed under the
/// process master key.
fn vault_with_secret(dir: &Path) -> std::path::PathBuf {
    let db = dir.join("plugin-secrets.db");
    let store = PluginSecretStore::open(db.clone()).unwrap();
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(store.set("plug", "token", "s3cret"))
        .unwrap();
    db
}

fn read_secret(db: &Path, master: FieldCipher) -> anyhow::Result<Option<String>> {
    let store = PluginSecretStore::from_connection(rusqlite::Connection::open(db)?, master)?;
    tokio::runtime::Builder::new_current_thread()
        .build()?
        .block_on(store.get("plug", "token"))
}

#[test]
fn rotate_rewraps_the_vault_under_the_installed_key() {
    let dir = tempfile::tempdir().unwrap();
    let db = vault_with_secret(dir.path());
    let mut installed = None;
    let done = rotate_with(&db, |key| {
        installed = Some(*key);
        Ok(outcome())
    })
    .unwrap();
    let new_key = installed.expect("the installer ran");
    let rewrap = done.rewrap.expect("the vault was rewrapped");
    assert_eq!(done.prepared_rows, Some(0));
    assert_eq!((rewrap.data_keys, rewrap.meta_entries), (1, 1));
    assert!(!rewrap.shamir);

    assert_eq!(
        read_secret(&db, FieldCipher::new(&new_key))
            .unwrap()
            .as_deref(),
        Some("s3cret")
    );
    assert!(
        read_secret(&db, ryu_crypto::global_cipher().unwrap()).is_err(),
        "the old master key alone no longer opens the vault keyring"
    );
    let conn = rusqlite::Connection::open(&db).unwrap();
    let audited: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM vault_audit WHERE action = 'sys.kek.rotate'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(audited, 1);
}

#[test]
fn a_failed_install_leaves_the_vault_on_the_current_key() {
    let dir = tempfile::tempdir().unwrap();
    let db = vault_with_secret(dir.path());
    let result = rotate_with(&db, |_| anyhow::bail!("retired set is full"));
    assert!(result.is_err());
    assert_eq!(
        read_secret(&db, ryu_crypto::global_cipher().unwrap())
            .unwrap()
            .as_deref(),
        Some("s3cret")
    );
}

#[test]
fn rotate_without_a_vault_only_installs_the_key() {
    let dir = tempfile::tempdir().unwrap();
    let done = rotate_with(&dir.path().join("plugin-secrets.db"), |_| Ok(outcome())).unwrap();
    assert!(done.rewrap.is_none());
    assert_eq!(done.adopted.kcv, "new-kcv");
}

#[test]
fn rotate_and_rewrap_take_no_arguments() {
    let extra = vec!["rotate".to_owned(), "--now".to_owned()];
    assert!(super::super::keys_command(&extra).is_err());
    let extra = vec!["rewrap-vault".to_owned(), "x".to_owned()];
    assert!(super::super::keys_command(&extra).is_err());
    let unknown = super::super::keys_command(&["spin".to_owned()]).unwrap_err();
    assert!(unknown.to_string().contains("rotate"));
}

/// The real `keys rotate`: a fresh master key in file custody, the old one
/// retired, and the vault opening under the new key alone.
#[test]
fn keys_rotate_swaps_the_master_key_and_rewraps_the_vault() {
    if std::env::var_os(CHILD_ENV).is_none() {
        let data_dir = tempfile::tempdir().unwrap();
        let test =
            "crypto_host::rotate::tests::keys_rotate_swaps_the_master_key_and_rewraps_the_vault";
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test, "--nocapture"])
            .env(CHILD_ENV, "1")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", data_dir.path())
            .env_remove(ENV_MASTER_KEY)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success() && stdout.contains("1 passed; 0 failed"),
            "isolated rotate failed:\n{stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let old = ryu_crypto::global_cipher().unwrap();
    let db = crate::paths::secret_path("plugin-secrets.db");
    let store = PluginSecretStore::open(db.clone()).unwrap();
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(store.set("plug", "token", "s3cret"))
        .unwrap();
    drop(store);

    let printed = super::super::keys_command(&["rotate".to_owned()]).unwrap();
    assert!(printed.contains("rotated the master key to"), "{printed}");
    assert!(
        printed.contains("vault data keys rewrapped: 1"),
        "{printed}"
    );

    let report = custody::master_key_report().unwrap();
    assert_eq!(report.retired.len(), 1);
    let file = std::fs::read_to_string(crate::paths::secret_path("master.key")).unwrap();
    let new_key = custody::decode_key_file(&file).expect("a key file");
    assert_eq!(
        read_secret(&db, FieldCipher::new(&new_key))
            .unwrap()
            .as_deref(),
        Some("s3cret")
    );
    assert!(read_secret(&db, old).is_err());
}

#[test]
fn rewrap_vault_finishes_an_interrupted_rotation() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("plugin-secrets.db");
    let (old_key, new_key) = ([1u8; 32], [2u8; 32]);
    {
        let store = PluginSecretStore::from_connection(
            rusqlite::Connection::open(&db).unwrap(),
            FieldCipher::new(&old_key),
        )
        .unwrap();
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(store.set("plug", "token", "s3cret"))
            .unwrap();
    }
    // After the custody swap the old key is retired: the master cipher still
    // opens the vault, but only through it.
    let master = FieldCipher::new(&new_key).with_retired(&[old_key]);
    let rewrap = super::rewrap_vault_at(&db, &master).unwrap();
    assert_eq!((rewrap.data_keys, rewrap.meta_entries), (1, 1));
    assert_eq!(
        read_secret(&db, FieldCipher::new(&new_key))
            .unwrap()
            .as_deref(),
        Some("s3cret")
    );
}
