//! Master-key bundles carried by exports and adopted by imports.

use super::*;

#[test]
fn export_carries_the_key_bundle_and_import_adopts_it_before_restoring() {
    use base64::Engine as _;
    let base = tempfile::tempdir().unwrap();
    let source_key = [0x41u8; 32];
    let target_key = [0x42u8; 32];
    // The source folder: a sealed row and its own key records.
    let src = base.path().join("src");
    std::fs::create_dir_all(src.join("secrets")).unwrap();
    std::fs::create_dir_all(src.join("state")).unwrap();
    std::fs::create_dir_all(src.join("db")).unwrap();
    let source_row = ryu_crypto::FieldCipher::new(&source_key)
        .seal("source row")
        .unwrap();
    std::fs::write(src.join("db/rows.txt"), &source_row).unwrap();
    std::fs::write(src.join("secrets/master.key"), "source-file-key").unwrap();
    std::fs::write(src.join("state/master-key.kcv"), "{\"kcv\":\"source\"}").unwrap();
    std::fs::write(src.join("state/retired-keys.json"), "[]").unwrap();
    let keys = FakeKeys {
        current: source_key,
        adopted: std::sync::Mutex::new(Vec::new()),
    };
    let out = base.path().join("backup.zip");
    export_zip_with(&src, &out, TEST_PASSPHRASE, EXPORT_MIN_ITERATIONS, &keys).unwrap();

    // The bundle sits inside the encrypted stream only.
    let raw = std::fs::read(&out).unwrap();
    let encoded_key = base64::engine::general_purpose::STANDARD.encode(source_key);
    assert!(!String::from_utf8_lossy(&raw).contains(&encoded_key));
    assert!(!String::from_utf8_lossy(&raw).contains(KEY_BUNDLE_ENTRY));
    let mut archive = open_test_archive(&out);
    assert!(archive.by_name(KEY_BUNDLE_ENTRY).is_ok());

    // A fresh install that already sealed a row of its own under its key.
    let target = base.path().join("target");
    std::fs::create_dir_all(target.join("secrets")).unwrap();
    std::fs::create_dir_all(target.join("db")).unwrap();
    std::fs::write(target.join("secrets/master.key"), "target-file-key").unwrap();
    let target_row = ryu_crypto::FieldCipher::new(&target_key)
        .seal("target row")
        .unwrap();
    std::fs::write(target.join("db/own.txt"), &target_row).unwrap();

    import_zip_with(&out, &target, Some(TEST_PASSPHRASE), &keys).unwrap();

    let adopted = keys.adopted.lock().unwrap();
    assert_eq!(adopted.len(), 1);
    let (to, bundle, key_file_then) = &adopted[0];
    assert_eq!(to, &target);
    assert!(bundle.contains(&encoded_key));
    // Adoption ran before any file was replaced.
    assert_eq!(key_file_then.as_deref(), Some(&b"target-file-key"[..]));
    // The archive's key file and key records are superseded by the bundle;
    // the bundle itself is never written into the folder.
    assert_eq!(
        std::fs::read(target.join("secrets/master.key")).unwrap(),
        b"target-file-key"
    );
    assert!(!target.join("state/master-key.kcv").exists());
    assert!(!target.join("state/retired-keys.json").exists());
    assert!(!target.join(KEY_BUNDLE_ENTRY).exists());
    // The restored store and the target's own row both open under the
    // adopted key with the target's previous key retired (what custody's
    // import does with the bundle).
    let adopted_cipher = ryu_crypto::FieldCipher::new(&source_key).with_retired(&[target_key]);
    let restored = std::fs::read_to_string(target.join("db/rows.txt")).unwrap();
    assert_eq!(adopted_cipher.open(&restored).unwrap(), "source row");
    assert_eq!(adopted_cipher.open(&target_row).unwrap(), "target row");
}

#[test]
fn export_of_a_non_active_folder_with_key_records_fails_closed() {
    let base = tempfile::tempdir().unwrap();
    let src = base.path().join("src");
    std::fs::create_dir_all(src.join("state")).unwrap();
    std::fs::write(src.join("state/master-key.kcv"), "{\"kcv\":\"source\"}").unwrap();
    let out = base.path().join("backup.zip");
    let error = export_zip_with(
        &src,
        &out,
        TEST_PASSPHRASE,
        EXPORT_MIN_ITERATIONS,
        &ForeignFolderKeys,
    )
    .unwrap_err();
    assert!(error.to_string().contains("active data folder"), "{error}");
    assert!(!out.exists(), "no archive was written");

    // A folder with no key records still exports without a bundle.
    let plain = base.path().join("plain");
    std::fs::create_dir_all(plain.join("db")).unwrap();
    std::fs::write(plain.join("db/rows.txt"), "plaintext").unwrap();
    export_zip_with(
        &plain,
        &out,
        TEST_PASSPHRASE,
        EXPORT_MIN_ITERATIONS,
        &ForeignFolderKeys,
    )
    .unwrap();
    assert!(out.exists());
}

#[test]
fn real_key_bundle_is_only_written_for_the_active_folder_and_opens_its_data() {
    use base64::Engine as _;
    let wrap = [9u8; 32];
    let other = tempfile::tempdir().unwrap();
    assert!(CustodyKeyBundles
        .seal_for(other.path(), &wrap)
        .unwrap()
        .is_none());
    let sealed = CustodyKeyBundles
        .seal_for(&paths::ryu_dir(), &wrap)
        .unwrap()
        .expect("the active folder always exports its key");
    let bundle: serde_json::Value =
        serde_json::from_str(&ryu_crypto::FieldCipher::new(&wrap).open(&sealed).unwrap()).unwrap();
    let current: [u8; 32] = base64::engine::general_purpose::STANDARD
        .decode(bundle["current"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let value = ryu_crypto::global_cipher().unwrap().seal("row").unwrap();
    assert_eq!(
        ryu_crypto::FieldCipher::new(&current).open(&value).unwrap(),
        "row"
    );
    assert_eq!(
        bundle["kcv"].as_str().unwrap(),
        ryu_crypto::key_check_value(&current)
    );
}

#[test]
fn adopting_into_another_folder_never_reaches_the_profile_keychain() {
    let target = tempfile::tempdir().unwrap();
    let command = adopt_child_command(Path::new("/bin/true"), target.path());
    let envs: std::collections::HashMap<_, _> = command
        .get_envs()
        .map(|(name, value)| {
            (
                name.to_string_lossy().into_owned(),
                value.map(|v| v.to_string_lossy().into_owned()),
            )
        })
        .collect();
    assert_eq!(
        envs.get("RYU_KEYCHAIN"),
        Some(&Some("off".to_owned())),
        "the child must keep the active folder's keychain slot untouched"
    );
    assert_eq!(
        envs.get(paths::RYU_DIR_ENV),
        Some(&Some(target.path().to_string_lossy().into_owned()))
    );
    assert!(
        !matches!(envs.get("RYU_MASTER_KEY"), Some(Some(_))),
        "the child must not inherit the active folder's env key"
    );
    let args: Vec<_> = command.get_args().collect();
    assert_eq!(args, ["data-path", ADOPT_KEY_BUNDLE_CMD]);
}

#[test]
fn a_bundle_in_an_unencrypted_archive_is_refused() {
    let base = tempfile::tempdir().unwrap();
    let legacy = base.path().join("legacy.zip");
    {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&legacy).unwrap());
        zip.start_file(KEY_BUNDLE_ENTRY, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"enc:v1:bogus").unwrap();
        zip.finish().unwrap();
    }
    let keys = FakeKeys {
        current: [1; 32],
        adopted: std::sync::Mutex::new(Vec::new()),
    };
    let target = base.path().join("target");
    std::fs::create_dir_all(&target).unwrap();
    let error = import_zip_with(&legacy, &target, None, &keys).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert!(keys.adopted.lock().unwrap().is_empty());
}

#[test]
fn a_bundle_less_archive_adopts_its_raw_key_instead_of_overwriting_the_target_key() {
    use base64::Engine as _;
    let base = tempfile::tempdir().unwrap();
    let archive_key = [0x51u8; 32];
    let legacy_key = [0x52u8; 32];
    let encoded = base64::engine::general_purpose::STANDARD.encode(archive_key);
    let encoded_legacy = base64::engine::general_purpose::STANDARD.encode(legacy_key);
    let archive = base.path().join("old.zip");
    bundle_less_archive(
        &archive,
        &[
            ("secrets/master.key", encoded.as_bytes()),
            ("secrets/memory.key", encoded_legacy.as_bytes()),
            ("db/rows.txt", b"archive row"),
        ],
    );
    // A file-custody target with its own key and key check value.
    let target = base.path().join("target");
    std::fs::create_dir_all(target.join("secrets")).unwrap();
    std::fs::create_dir_all(target.join("state")).unwrap();
    std::fs::write(target.join("secrets/master.key"), "target-file-key").unwrap();
    std::fs::write(target.join("state/master-key.kcv"), "{\"kcv\":\"target\"}").unwrap();
    let keys = FakeKeys {
        current: [0; 32],
        adopted: std::sync::Mutex::new(Vec::new()),
    };

    import_zip_with(&archive, &target, None, &keys).unwrap();

    let adopted = keys.adopted.lock().unwrap();
    assert_eq!(adopted.len(), 1, "the raw key goes through adoption");
    let (to, bundle, key_file_then) = &adopted[0];
    assert_eq!(to, &target);
    let bundle: serde_json::Value = serde_json::from_str(bundle).unwrap();
    assert_eq!(bundle["current"], encoded);
    assert_eq!(bundle["retired"], serde_json::json!([encoded_legacy]));
    // Adopted before any file was replaced, and the archive's key files are
    // never extracted over the target's (adoption retired that key).
    assert_eq!(key_file_then.as_deref(), Some(&b"target-file-key"[..]));
    assert_eq!(
        std::fs::read(target.join("secrets/master.key")).unwrap(),
        b"target-file-key"
    );
    assert!(!target.join("secrets/memory.key").exists());
    assert_eq!(
        std::fs::read(target.join("db/rows.txt")).unwrap(),
        b"archive row"
    );
}

#[test]
fn a_bundle_less_archive_with_a_malformed_key_restores_nothing() {
    let base = tempfile::tempdir().unwrap();
    let archive = base.path().join("old.zip");
    bundle_less_archive(
        &archive,
        &[
            ("db/rows.txt", b"archive row"),
            ("secrets/master.key", b"not a key"),
        ],
    );
    let target = base.path().join("target");
    std::fs::create_dir_all(&target).unwrap();
    let keys = FakeKeys {
        current: [0; 32],
        adopted: std::sync::Mutex::new(Vec::new()),
    };
    let error = import_zip_with(&archive, &target, None, &keys).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert!(keys.adopted.lock().unwrap().is_empty());
    assert!(!target.join("db/rows.txt").exists());
}

#[test]
fn a_bundle_less_archive_without_key_files_restores_as_before() {
    let base = tempfile::tempdir().unwrap();
    let archive = base.path().join("old.zip");
    bundle_less_archive(&archive, &[("db/rows.txt", b"archive row")]);
    let target = base.path().join("target");
    std::fs::create_dir_all(&target).unwrap();
    let keys = FakeKeys {
        current: [0; 32],
        adopted: std::sync::Mutex::new(Vec::new()),
    };
    import_zip_with(&archive, &target, None, &keys).unwrap();
    assert!(keys.adopted.lock().unwrap().is_empty());
    assert!(target.join("db/rows.txt").exists());
}

#[test]
fn a_bundle_less_archive_never_replaces_the_target_key_records() {
    // An export of a folder that is not the active one carries that
    // folder's key records but no key to adopt.
    let base = tempfile::tempdir().unwrap();
    let archive = base.path().join("other-folder.zip");
    bundle_less_archive(
        &archive,
        &[
            ("db/rows.txt", b"archive row"),
            ("state/master-key.kcv", b"{\"kcv\":\"foreign\"}"),
            (
                "state/retired-keys.json",
                b"[{\"kcv\":\"foreign-retired\"}]",
            ),
        ],
    );
    let target = base.path().join("target");
    std::fs::create_dir_all(target.join("state")).unwrap();
    std::fs::write(target.join("state/master-key.kcv"), "{\"kcv\":\"target\"}").unwrap();
    std::fs::write(
        target.join("state/retired-keys.json"),
        "[{\"kcv\":\"target-retired\"}]",
    )
    .unwrap();
    let keys = FakeKeys {
        current: [0; 32],
        adopted: std::sync::Mutex::new(Vec::new()),
    };

    import_zip_with(&archive, &target, None, &keys).unwrap();

    assert!(keys.adopted.lock().unwrap().is_empty());
    assert_eq!(
        std::fs::read(target.join("db/rows.txt")).unwrap(),
        b"archive row"
    );
    // The target's key check value and retired index still describe the
    // key it holds, so custody resolves it at the next boot.
    assert_eq!(
        std::fs::read_to_string(target.join("state/master-key.kcv")).unwrap(),
        "{\"kcv\":\"target\"}"
    );
    assert_eq!(
        std::fs::read_to_string(target.join("state/retired-keys.json")).unwrap(),
        "[{\"kcv\":\"target-retired\"}]"
    );

    // A fresh target records the key it holds at first boot: the foreign
    // check value is not restored, a retired index (which names keys the
    // target may or may not hold) is.
    let fresh = base.path().join("fresh");
    std::fs::create_dir_all(&fresh).unwrap();
    import_zip_with(&archive, &fresh, None, &keys).unwrap();
    assert!(!fresh.join("state/master-key.kcv").exists());
    assert!(fresh.join("state/retired-keys.json").exists());
}
