use super::*;

async fn write_direct(store: &PluginSecretStore, value: &str) -> i64 {
    store
        .write_secret(WriteRequest {
            coords: coords(),
            value: Some(value),
            patch: SecretMetadataPatch::default(),
            actor: &AuditActor::new("user", Some("admin")),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap()
        .version
}

async fn current_value(store: &PluginSecretStore) -> Option<String> {
    let context = SecretResolutionContext::node_only("node-1", Vec::new());
    store
        .resolve_vault_secret("prod:API_KEY", &context)
        .await
        .unwrap()
}

#[tokio::test]
async fn approval_does_not_overwrite_a_change_made_after_the_request() {
    let store = PluginSecretStore::in_memory().unwrap();
    let base = write_direct(&store, "v1").await;
    let request = store
        .create_change_request(
            coords(),
            ChangeOperation::Write,
            Some("proposed"),
            json!({}),
            1,
            &AuditActor::new("user", Some("dev")),
            &authority(),
        )
        .await
        .unwrap();
    assert_eq!(request.base_version, Some(base));
    // An urgent rotation lands while the request waits.
    write_direct(&store, "rotated").await;
    let error = store
        .approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(1))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("version"), "{error}");
    assert_eq!(current_value(&store).await.as_deref(), Some("rotated"));
    let reverted = store.change_request(&request.id).await.unwrap();
    assert_eq!(reverted.status, ChangeStatus::Pending);
    assert!(reverted.approvals.is_empty());
    assert!(reverted.has_value);
}

#[tokio::test]
async fn approval_applies_while_the_secret_is_still_at_the_base_version() {
    let store = PluginSecretStore::in_memory().unwrap();
    write_direct(&store, "v1").await;
    let request = store
        .create_change_request(
            coords(),
            ChangeOperation::Write,
            Some("proposed"),
            json!({}),
            1,
            &AuditActor::new("user", Some("dev")),
            &authority(),
        )
        .await
        .unwrap();
    let applied = store
        .approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(1))
        .await
        .unwrap();
    assert_eq!(applied.status, ChangeStatus::Applied);
    assert_eq!(current_value(&store).await.as_deref(), Some("proposed"));
}

#[tokio::test]
async fn a_delete_approval_does_not_remove_a_value_rotated_after_the_request() {
    let store = PluginSecretStore::in_memory().unwrap();
    write_direct(&store, "v1").await;
    let request = store
        .create_change_request(
            coords(),
            ChangeOperation::Delete,
            None,
            json!({}),
            1,
            &AuditActor::new("user", Some("dev")),
            &authority(),
        )
        .await
        .unwrap();
    write_direct(&store, "rotated").await;
    assert!(store
        .approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(1))
        .await
        .is_err());
    assert_eq!(current_value(&store).await.as_deref(), Some("rotated"));
    assert_eq!(
        store.change_request(&request.id).await.unwrap().status,
        ChangeStatus::Pending
    );
}

fn is_conflict(error: &anyhow::Error) -> bool {
    matches!(
        error.downcast_ref::<VaultError>(),
        Some(VaultError::Conflict(_))
    )
}

async fn request_write(store: &PluginSecretStore, expected: ChangeBase) -> Result<ChangeRequest> {
    store
        .create_change_request_from(
            expected,
            coords(),
            ChangeOperation::Write,
            Some("proposed"),
            json!({}),
            1,
            &AuditActor::new("user", Some("dev")),
            &authority(),
        )
        .await
}

#[tokio::test]
async fn a_stale_expected_version_is_refused_when_the_request_is_made() {
    let store = PluginSecretStore::in_memory().unwrap();
    let seen = write_direct(&store, "v1").await;
    // An admin rotates the value after the requester loaded it.
    let rotated = write_direct(&store, "rotated").await;
    let stale = ChangeBase {
        version: Some(seen),
        metadata_version: None,
    };
    let error = request_write(&store, stale).await.unwrap_err();
    assert!(is_conflict(&error), "{error}");
    assert!(store.list_change_requests(None).await.unwrap().is_empty());

    let current = ChangeBase {
        version: Some(rotated),
        metadata_version: None,
    };
    let request = request_write(&store, current).await.unwrap();
    assert_eq!(request.base_version, Some(rotated));
}

#[tokio::test]
async fn a_stale_expected_metadata_version_is_refused_when_the_request_is_made() {
    let store = PluginSecretStore::in_memory().unwrap();
    write_direct(&store, "v1").await;
    let seen = store
        .secret_info(&coords())
        .await
        .unwrap()
        .unwrap()
        .metadata_version;
    let stale = ChangeBase {
        version: None,
        metadata_version: Some(seen + 1),
    };
    assert!(is_conflict(
        &request_write(&store, stale).await.unwrap_err()
    ));
    let current = ChangeBase {
        version: None,
        metadata_version: Some(seen),
    };
    assert!(request_write(&store, current).await.is_ok());
}

#[tokio::test]
async fn a_write_approval_does_not_bring_back_a_value_deleted_after_the_request() {
    let store = PluginSecretStore::in_memory().unwrap();
    write_direct(&store, "v1").await;
    let request = request_write(&store, ChangeBase::default()).await.unwrap();
    // Deleted during an incident: the value version stays the same.
    assert!(store
        .soft_delete(coords(), &AuditActor::new("user", Some("admin")))
        .await
        .unwrap());
    let error = store
        .approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(1))
        .await
        .unwrap_err();
    assert!(is_conflict(&error), "{error}");
    let info = store.secret_info(&coords()).await.unwrap().unwrap();
    assert!(info.deleted_at.is_some());
    assert_eq!(info.version, request.base_version.unwrap());
    assert_eq!(
        store.change_request(&request.id).await.unwrap().status,
        ChangeStatus::Pending
    );
}

#[tokio::test]
async fn a_write_approval_does_not_overwrite_a_metadata_only_change() {
    let store = PluginSecretStore::in_memory().unwrap();
    write_direct(&store, "v1").await;
    let request = store
        .create_change_request(
            coords(),
            ChangeOperation::Write,
            None,
            json!({ "description": "requested" }),
            1,
            &AuditActor::new("user", Some("dev")),
            &authority(),
        )
        .await
        .unwrap();
    store
        .write_secret(WriteRequest {
            coords: coords(),
            value: None,
            patch: SecretMetadataPatch {
                description: Some("admin".into()),
                ..SecretMetadataPatch::default()
            },
            actor: &AuditActor::new("user", Some("admin")),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap();
    let error = store
        .approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(1))
        .await
        .unwrap_err();
    assert!(is_conflict(&error), "{error}");
    let info = store.secret_info(&coords()).await.unwrap().unwrap();
    assert_eq!(info.metadata.description, "admin");
}

#[tokio::test]
async fn a_write_approval_does_not_overwrite_a_value_restored_after_the_request() {
    let store = PluginSecretStore::in_memory().unwrap();
    write_direct(&store, "v1").await;
    let admin = AuditActor::new("user", Some("admin"));
    store.soft_delete(coords(), &admin).await.unwrap();
    let request = request_write(&store, ChangeBase::default()).await.unwrap();
    store.restore(coords(), &admin).await.unwrap();
    let error = store
        .approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(1))
        .await
        .unwrap_err();
    assert!(is_conflict(&error), "{error}");
    assert_eq!(current_value(&store).await.as_deref(), Some("v1"));
}
