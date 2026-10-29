use super::*;

#[tokio::test]
async fn operation_idempotency_is_scoped_and_conflicts_fail_closed() {
    let directory = tempfile::tempdir().unwrap();
    let service = BackupService::open(directory.path().to_owned()).unwrap();
    let scope = BackupScope::Node;
    let (first, created) = service
        .begin("dest", &scope, "backup", "same-key", "hash-a".into())
        .await
        .unwrap();
    assert!(created);
    let (retry, created) = service
        .begin("dest", &scope, "backup", "same-key", "hash-a".into())
        .await
        .unwrap();
    assert!(!created);
    assert_eq!(retry.id, first.id);
    assert!(service
        .begin("dest", &scope, "backup", "same-key", "hash-b".into())
        .await
        .is_err());
    assert!(service
        .begin("dest", &scope, "restore", "same-key", "hash-a".into())
        .await
        .is_err());
    let app = BackupScope::App {
        app_id: "@ryu/example".into(),
        namespace: "default".into(),
        tenant: "alice".into(),
    };
    let (_, created) = service
        .begin("dest", &app, "backup", "same-key", "hash-a".into())
        .await
        .unwrap();
    assert!(created);
    drop(service);
    let restarted = BackupService::open(directory.path().to_owned()).unwrap();
    let recovered = restarted.operation(&first.id).await.unwrap();
    assert_eq!(recovered.status, "failed");
    assert!(recovered.error.unwrap().contains("interrupted"));
}

#[test]
fn malformed_state_is_never_overwritten_with_empty_defaults() {
    let directory = tempfile::tempdir().unwrap();
    let path = store::state_dir(directory.path());
    std::fs::create_dir_all(&path).unwrap();
    let original = b"{\"version\":999}";
    std::fs::write(path.join("state.json"), original).unwrap();
    assert!(BackupService::open(directory.path().to_owned()).is_err());
    assert_eq!(std::fs::read(path.join("state.json")).unwrap(), original);
}

#[test]
fn backup_boundaries_exclude_identity_and_staging_but_preserve_source_history_and_app_data() {
    for value in [
        "secrets/core.token",
        "plugins/node-auth.token",
        "state/backups",
        "cache",
        "state/chat-checkpoints",
        "secrets/master.key",
        "secrets/memory.key",
        "state/fleet-identity.json",
    ] {
        assert!(node_excluded(Path::new(value)), "{value}");
    }
    for value in [
        "db/conversations.db",
        "models/chat/custom-model.gguf",
        "files/blobs",
        "files/source-history",
        "plugin-data/app/config.json",
        "files/source-history/Cargo.lock",
        "state",
        "secrets",
    ] {
        assert!(!node_excluded(Path::new(value)), "{value}");
    }
}

#[test]
fn retention_never_prunes_another_node_or_an_unknown_source() {
    let record = |source: &str, id: &str| BackupRecord {
        version: 1,
        id: id.into(),
        source_node_id: source.into(),
        scope: BackupScope::Node,
        created_at: now(),
        bytes: 0,
        sha256: "hash".into(),
        object_key: "key".into(),
    };
    let candidates = retained_candidates(
        vec![
            record("alice-node", "a"),
            record("bob-node", "b"),
            record("", "legacy"),
        ],
        "alice-node",
    );
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].id, "a");
    assert!(retained_candidates(vec![record("", "legacy")], "").is_empty());
}

#[test]
fn restore_request_defaults_to_live_and_accepts_a_dry_run() {
    let live: super::RestoreBackup = serde_json::from_value(serde_json::json!({
        "destinationId": "destination",
        "backupId": "backup",
        "idempotencyKey": "request"
    }))
    .unwrap();
    assert!(!live.dry_run);

    let preview: super::RestoreBackup = serde_json::from_value(serde_json::json!({
        "destinationId": "destination",
        "backupId": "backup",
        "idempotencyKey": "request",
        "dryRun": true
    }))
    .unwrap();
    assert!(preview.dry_run);
}

#[test]
fn backup_scopes_accept_only_valid_space_ids_and_safe_app_namespaces() {
    assert!(scope_valid(&BackupScope::Node).is_ok());
    assert!(scope_valid(&BackupScope::Space {
        space_id: "018f2f37-b62f-7d84-9c50-526adbe4c8f2".into(),
    })
    .is_ok());
    assert!(scope_valid(&BackupScope::Space {
        space_id: "not-a-uuid".into(),
    })
    .is_err());

    let valid_app = BackupScope::App {
        app_id: "@ryu/research".into(),
        namespace: "default.v1_tools-2".into(),
        tenant: "org:acme".into(),
    };
    assert!(scope_valid(&valid_app).is_ok());

    for scope in [
        BackupScope::App {
            app_id: String::new(),
            namespace: "default".into(),
            tenant: "alice".into(),
        },
        BackupScope::App {
            app_id: "@ryu/research".into(),
            namespace: "../private".into(),
            tenant: "alice".into(),
        },
        BackupScope::App {
            app_id: "@ryu/research".into(),
            namespace: "default/tools".into(),
            tenant: "alice".into(),
        },
        BackupScope::App {
            app_id: "@ryu/research".into(),
            namespace: "default".into(),
            tenant: String::new(),
        },
    ] {
        assert!(
            scope_valid(&scope).is_err(),
            "unexpectedly accepted {scope:?}"
        );
    }
}

#[tokio::test]
async fn invalid_idempotency_keys_and_scopes_never_enter_the_queue() {
    let directory = tempfile::tempdir().unwrap();
    let service = BackupService::open(directory.path().to_owned()).unwrap();

    for key in [String::new(), "bad key".into(), "x".repeat(129)] {
        assert!(service
            .begin("dest", &BackupScope::Node, "backup", &key, "hash".into())
            .await
            .is_err());
    }
    assert!(service
        .begin(
            "dest",
            &BackupScope::Space {
                space_id: "invalid".into(),
            },
            "backup",
            "valid-key",
            "hash".into(),
        )
        .await
        .is_err());
    assert!(service.operations().await.is_empty());
}

#[tokio::test]
async fn queue_capacity_is_bounded_and_recent_operations_are_listed_first() {
    let directory = tempfile::tempdir().unwrap();
    let service = BackupService::open(directory.path().to_owned()).unwrap();

    let (first, created) = service
        .begin("dest", &BackupScope::Node, "backup", "first", "one".into())
        .await
        .unwrap();
    assert!(created);
    let (second, created) = service
        .begin("dest", &BackupScope::Node, "backup", "second", "two".into())
        .await
        .unwrap();
    assert!(created);

    let operations = service.operations().await;
    assert_eq!(
        operations
            .iter()
            .map(|operation| operation.id.as_str())
            .collect::<Vec<_>>(),
        [second.id.as_str(), first.id.as_str()]
    );
    assert_eq!(service.operation(&first.id).await.unwrap().id, first.id);
    assert!(service.operation("missing").await.is_none());

    for index in 2..16 {
        service
            .begin(
                "dest",
                &BackupScope::Node,
                "backup",
                &format!("pending-{index}"),
                format!("hash-{index}"),
            )
            .await
            .unwrap();
    }
    let error = service
        .begin(
            "dest",
            &BackupScope::Node,
            "backup",
            "overflow",
            "overflow".into(),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("queue is full"));
    assert_eq!(service.operations().await.len(), 16);
}

#[test]
fn staging_lives_in_the_data_dir_is_private_and_stale_jobs_are_swept() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let stage = super::stage_dir(root, "ryu-backup-").unwrap();
    assert!(stage.path().starts_with(super::staging_root(root)));
    assert!(super::staging_root(root).starts_with(root.join("tmp")));
    // Node snapshots skip the whole staging tree.
    assert!(node_excluded(Path::new("tmp")));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for dir in [super::staging_root(root), stage.path().to_path_buf()] {
            let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700, "{}", dir.display());
        }
    }
    // The plaintext archive is anonymous: nothing can open it by name.
    let mut scratch = super::plaintext_scratch(stage.path()).unwrap();
    std::io::Write::write_all(&mut scratch, b"sk-plaintext-archive-bytes").unwrap();
    // Unix unlinks it, so writing it adds no named file.
    #[cfg(unix)]
    assert_eq!(std::fs::read_dir(stage.path()).unwrap().count(), 0);
    // Windows cannot unlink an open file: the delete-on-close entry is listed,
    // but it is opened without sharing, so no one else can read it by name.
    #[cfg(not(unix))]
    for entry in std::fs::read_dir(stage.path()).unwrap() {
        let path = entry.unwrap().path();
        assert!(
            std::fs::File::open(&path).is_err(),
            "{} is readable by name",
            path.display()
        );
    }
    // A killed process closes the handle too, and the OS reclaims the file.
    drop(scratch);

    // Simulate a crash: leftovers in staging and a half-extracted recovery.
    let leftover = stage.path().join("snapshot.ryubak");
    std::fs::write(&leftover, b"ciphertext").unwrap();
    let recovered = super::store::state_dir(root).join("recovered");
    std::fs::create_dir_all(recovered.join(".ryu-restore-abc/secrets")).unwrap();
    std::fs::create_dir_all(recovered.join("finished-job")).unwrap();
    std::mem::forget(stage);
    BackupService::open(root.to_path_buf()).unwrap();
    assert_eq!(
        std::fs::read_dir(super::staging_root(root))
            .unwrap()
            .count(),
        0
    );
    assert!(!recovered.join(".ryu-restore-abc").exists());
    // A completed recovery is operator data and is kept.
    assert!(recovered.join("finished-job").exists());
}

#[test]
fn node_restore_installs_the_retired_keys_so_data_still_on_them_opens() {
    use base64::Engine as _;
    let recovery_key = [7u8; 32];
    let current = [0xA1u8; 32];
    let retired = [0xB2u8; 32];
    let cipher = ryu_crypto::FieldCipher::new(&recovery_key);
    let bundle = ryu_crypto::custody::seal_raw_key_bundle(&cipher, &current, &[retired]).unwrap();
    let recovery = json!({
        "version": 2,
        "sealedMasterKey": cipher
            .seal(&base64::engine::general_purpose::STANDARD.encode(current))
            .unwrap(),
        "sealedKeyBundle": bundle,
    });
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    // The snapshot carried the source's index, naming a keychain-held key.
    let retired_kcv = ryu_crypto::content::key_check_value(&retired);
    std::fs::create_dir_all(root.join("state")).unwrap();
    std::fs::write(
        ryu_sidecar_runtime::layout::state_path(root, "retired-keys.json"),
        serde_json::to_vec(&json!({
            "v": 1,
            "keys": [{ "kcv": retired_kcv, "custody": "keychain", "retired_at": 5 }],
        }))
        .unwrap(),
    )
    .unwrap();
    // A value and a sealed row still on the retired key.
    let on_retired = ryu_crypto::FieldCipher::new(&retired)
        .seal("old row")
        .unwrap();

    install_recovered_keys(root, &recovery, &recovery_key).unwrap();

    let read_key = |path: std::path::PathBuf| {
        ryu_crypto::custody::decode_key_file(&std::fs::read_to_string(path).unwrap()).unwrap()
    };
    assert_eq!(
        read_key(ryu_sidecar_runtime::layout::secret_path(root, "master.key")),
        current
    );
    let index = ryu_crypto::custody::read_retired_index(root).unwrap();
    assert_eq!(index.len(), 1);
    assert_eq!(index[0].kcv, retired_kcv);
    assert_eq!(index[0].custody, "file");
    let restored_retired = read_key(
        ryu_sidecar_runtime::layout::secrets_dir(root)
            .join("retired")
            .join(format!("{retired_kcv}.key")),
    );
    assert_eq!(
        ryu_crypto::FieldCipher::new(&restored_retired)
            .open(&on_retired)
            .unwrap(),
        "old row"
    );
    assert_eq!(
        ryu_crypto::custody::read_kcv_record(root)
            .unwrap()
            .unwrap()
            .kcv,
        ryu_crypto::content::key_check_value(&current)
    );
}

#[test]
fn node_restore_still_reads_recovery_files_with_only_the_master_key() {
    use base64::Engine as _;
    let recovery_key = [8u8; 32];
    let current = [0xC3u8; 32];
    let cipher = ryu_crypto::FieldCipher::new(&recovery_key);
    let recovery = json!({
        "version": 1,
        "sealedMasterKey": cipher
            .seal(&base64::engine::general_purpose::STANDARD.encode(current))
            .unwrap(),
    });
    let dir = tempfile::tempdir().unwrap();
    install_recovered_keys(dir.path(), &recovery, &recovery_key).unwrap();
    let text = std::fs::read_to_string(ryu_sidecar_runtime::layout::secret_path(
        dir.path(),
        "master.key",
    ))
    .unwrap();
    assert_eq!(
        ryu_crypto::custody::decode_key_file(&text).unwrap(),
        current
    );
    assert!(install_recovered_keys(dir.path(), &json!({}), &recovery_key).is_err());
}
