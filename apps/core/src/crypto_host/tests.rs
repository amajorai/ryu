use super::*;

fn conversations_with(path: &Path, bodies: &[String]) {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch(
        "CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT,
                                content TEXT NOT NULL, created_at INTEGER)",
    )
    .unwrap();
    for (i, body) in bodies.iter().enumerate() {
        conn.execute(
            "INSERT INTO messages (id, content) VALUES (?1, ?2)",
            rusqlite::params![format!("m{i}"), body],
        )
        .unwrap();
    }
}

#[test]
fn crypto_host_probe_tells_the_right_key_from_a_wrong_one() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("conversations.db");
    assert_eq!(
        probe_conversations(&db, &FieldCipher::new(&[1; 32])),
        KeyProbe::NoSealedData
    );
    let right = FieldCipher::new(&[1; 32]);
    conversations_with(
        &db,
        &[
            "plaintext legacy body".to_owned(),
            right.seal("hello").unwrap(),
            right.seal("again").unwrap(),
        ],
    );
    assert_eq!(probe_conversations(&db, &right), KeyProbe::Passed);
    assert_eq!(
        probe_conversations(&db, &FieldCipher::new(&[2; 32])),
        KeyProbe::Failed
    );
    assert_eq!(sealed_sample(&db).len(), 2);
}

#[test]
fn crypto_host_probe_reads_the_newest_sealed_messages() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("conversations.db");
    let lost = FieldCipher::new(&[3; 32]);
    let current = FieldCipher::new(&[4; 32]);
    let mut bodies: Vec<String> = (0..6)
        .map(|i| lost.seal(&format!("old {i}")).unwrap())
        .collect();
    bodies.push(current.seal("newest").unwrap());
    conversations_with(&db, &bodies);
    assert_eq!(probe_conversations(&db, &current), KeyProbe::Passed);
    assert_eq!(probe_conversations(&db, &lost), KeyProbe::Passed);
    assert_eq!(
        probe_conversations(&db, &FieldCipher::new(&[5; 32])),
        KeyProbe::Failed
    );
    // Newest and oldest ends, without duplicates.
    let sample = sealed_sample(&db);
    assert_eq!(sample.len(), 6);
    assert_eq!(sample[0], bodies[6]);
}

#[test]
fn crypto_host_probe_tolerates_missing_tables() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("conversations.db");
    rusqlite::Connection::open(&db)
        .unwrap()
        .execute_batch("CREATE TABLE other (x TEXT)")
        .unwrap();
    assert_eq!(
        probe_conversations(&db, &FieldCipher::new(&[1; 32])),
        KeyProbe::NoSealedData
    );
}

#[test]
fn crypto_host_keys_cli_parses_sources() {
    let words = |s: &str| s.split(' ').map(str::to_owned).collect::<Vec<_>>();
    assert_eq!(
        parse_adopt_from(&words("--from file")).unwrap(),
        AdoptFrom::File
    );
    assert_eq!(
        parse_adopt_from(&words("--from=keychain")).unwrap(),
        AdoptFrom::Keychain
    );
    assert_eq!(
        parse_adopt_from(&words("--from retired:abcd")).unwrap(),
        AdoptFrom::Retired("abcd".to_owned())
    );
    assert!(parse_adopt_from(&words("--from retired:")).is_err());
    assert!(parse_adopt_from(&words("--from cloud")).is_err());
    assert!(parse_adopt_from(&[]).is_err());
    assert_eq!(
        parse_adopt_args(&words("--from keychain --accept-unreadable")).unwrap(),
        (AdoptFrom::Keychain, true)
    );
    assert_eq!(
        parse_adopt_args(&words("--accept-unreadable --from=file")).unwrap(),
        (AdoptFrom::File, true)
    );
    assert_eq!(
        parse_adopt_args(&words("--from file")).unwrap(),
        (AdoptFrom::File, false)
    );
    assert!(keys_command(&words("explode")).is_err());
    assert!(keys_command(&words("retire")).is_err());
}

/// A host bound to an explicit data folder, so the status test never
/// touches the process data dir.
struct DirHost(PathBuf);

impl CryptoHost for DirHost {
    fn keyring_account_suffix(&self) -> String {
        "-ryu-core-status-test".to_owned()
    }

    fn ryu_dir(&self) -> PathBuf {
        self.0.clone()
    }
}

#[test]
fn crypto_host_status_reports_kcvs_and_never_key_material() {
    use base64::Engine as _;
    use ryu_sidecar_runtime::layout;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let key = [5u8; 32];
    let kcv = ryu_crypto::content::key_check_value(&key);
    let encoded = base64::engine::general_purpose::STANDARD.encode(key);
    let key_path = layout::secret_path(root, "master.key");
    std::fs::create_dir_all(key_path.parent().unwrap()).unwrap();
    std::fs::write(&key_path, &encoded).unwrap();
    let record = custody::KcvRecord {
        v: 1,
        kcv: kcv.clone(),
        custody: "file".to_owned(),
        written_at: 0,
    };
    let record_path = layout::state_path(root, "master-key.kcv");
    std::fs::create_dir_all(record_path.parent().unwrap()).unwrap();
    std::fs::write(&record_path, serde_json::to_vec(&record).unwrap()).unwrap();
    let db_dir = layout::db_dir(root);
    std::fs::create_dir_all(&db_dir).unwrap();
    for (name, store_kcv) in [("notes.db", kcv.as_str()), ("other.db", "00ff00ff")] {
        let conn = rusqlite::Connection::open(db_dir.join(name)).unwrap();
        ryu_crypto::content_sqlite::record_store_kcv(&conn, name, store_kcv).unwrap();
    }

    let report = custody::master_key_report_for(&DirHost(root.to_path_buf())).unwrap();
    assert_eq!(
        report.recorded.as_ref().map(|r| r.kcv.as_str()),
        Some(kcv.as_str())
    );
    let status = format_status(
        &report,
        &ryu_crypto::content_sqlite::recorded_store_kcvs(&db_dir),
    );
    assert!(status.contains(&format!("recorded key: {kcv}")), "{status}");
    assert!(
        status.lines().any(|line| line.contains("file")
            && line.contains(&kcv)
            && line.contains("matches the recorded key")),
        "{status}"
    );
    assert!(
        status
            .lines()
            .any(|line| line.contains("notes.db") && line.contains("(current key)")),
        "{status}"
    );
    assert!(
        status
            .lines()
            .any(|line| line.contains("other.db") && line.contains("(NO available key)")),
        "{status}"
    );
    assert!(!status.contains(&encoded), "key material leaked: {status}");
    assert!(!status
        .split_whitespace()
        .any(|word| word.len() == 44 && word.ends_with('=')));
}

#[test]
fn crypto_host_tests_run_in_an_isolated_data_dir_and_record_no_kcv() {
    assert!(!CoreCryptoHost.records_kcv());
    let cipher = ryu_crypto::global_cipher().unwrap();
    let sealed = cipher.seal("x").unwrap();
    assert_eq!(cipher.open(&sealed).unwrap(), "x");
    if crate::paths::ryu_dir() == test_data_dir() {
        assert_eq!(
            custody::read_kcv_record(&crate::paths::ryu_dir()).unwrap(),
            None,
            "a test run never records a key check value"
        );
    } else {
        // A caller-provided RYU_DIR is honoured as-is.
        assert!(std::env::var_os("RYU_DIR").is_some());
    }
    assert_ne!(
        crate::paths::ryu_dir(),
        crate::paths::default_ryu_dir(),
        "ryu-core unit tests never use the real profile data folder"
    );
}

#[test]
fn crypto_host_data_format_marker_is_written_and_checked() {
    let dir = tempfile::tempdir().unwrap();
    custody::write_data_format(dir.path()).unwrap();
    custody::check_data_format(dir.path()).unwrap();
    let marker = custody::read_data_format(dir.path()).unwrap().unwrap();
    assert_eq!(marker.min_reader, custody::SUPPORTED_MIN_READER);
}

#[test]
fn crypto_host_content_ciphers_resolve_under_the_test_host() {
    let cipher = ryu_crypto::content_cipher("crypto-host-test.db").unwrap();
    let context = ryu_crypto::ContentContext::for_id("t.c", "1");
    let sealed = cipher.seal_text("body", &context).unwrap();
    assert_eq!(cipher.open_text(&sealed, &context).unwrap().value, "body");
    let plugin = ryu_crypto::plugin_content_cipher("@ryu/notes", "notes.db").unwrap();
    let delivered = ryu_crypto::plugin_cipher_for_process("@ryu/notes")
        .unwrap()
        .content_cipher("notes.db");
    let sealed = plugin.seal_text("shared", &context).unwrap();
    assert_eq!(
        delivered.open_text(&sealed, &context).unwrap().value,
        "shared"
    );
}
