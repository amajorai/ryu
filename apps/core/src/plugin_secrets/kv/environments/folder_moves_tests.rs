use super::*;

fn store() -> PluginSecretStore {
    PluginSecretStore::in_memory().unwrap()
}

fn actor() -> AuditActor {
    AuditActor::new("user", Some("admin-1"))
}

fn at(scope_id: &str, environment: &str, path: &str, name: &str) -> SecretCoords {
    SecretCoords {
        scope: SecretScope::User,
        scope_id: scope_id.to_owned(),
        environment: environment.to_owned(),
        path: path.to_owned(),
        binding: None,
        name: name.to_owned(),
    }
}

async fn put(store: &PluginSecretStore, coords: SecretCoords, value: &str) {
    store
        .write_secret(WriteRequest {
            coords,
            value: Some(value),
            patch: SecretMetadataPatch::default(),
            actor: &actor(),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap();
}

fn allow_all(_: &SecretCoords, _: &SecretCoords) -> bool {
    true
}

fn message(error: &anyhow::Error) -> String {
    error.to_string()
}

#[test]
fn paths_rebase_only_inside_the_moved_folder() {
    assert_eq!(rebase_path("/a", "/a", "/b").as_deref(), Some("/b"));
    assert_eq!(rebase_path("/a/x/y", "/a", "/b/c").as_deref(), Some("/b/c/x/y"));
    assert_eq!(rebase_path("/a/x", "/a", "/").as_deref(), Some("/x"));
    assert_eq!(rebase_path("/ab", "/a", "/b"), None);
    assert_eq!(rebase_path("/", "/a", "/b"), None);
}

#[tokio::test]
async fn a_folder_rename_carries_values_history_subfolders_and_imports() {
    let store = store();
    let actor = actor();
    put(&store, at("u1", "dev", "/app", "TOKEN"), "one").await;
    put(&store, at("u1", "dev", "/app", "TOKEN"), "two").await;
    put(&store, at("u1", "dev", "/app/db", "PASSWORD"), "pw").await;
    put(&store, at("u1", "dev", "/apple", "KEEP"), "stays").await;
    store.create_folder("dev", "/app/empty").await.unwrap();
    store
        .add_import(
            &FolderImport {
                id: String::new(),
                environment: "dev".into(),
                path: "/other".into(),
                source_environment: "dev".into(),
                source_path: "/app/db".into(),
                position: 0,
            },
            &actor,
        )
        .await
        .unwrap();

    let report = store
        .move_folder("dev", "app", "dev", "/svc/api", &actor, allow_all)
        .await
        .unwrap();
    assert_eq!(report.values, 2);
    assert_eq!(report.folders, 1);
    assert_eq!(report.imports, 1);
    assert_eq!(report.to_path, "/svc/api");

    let moved = at("u1", "dev", "/svc/api", "TOKEN");
    assert_eq!(store.reveal(&moved, None, &actor).await.unwrap(), "two");
    assert_eq!(store.reveal(&moved, Some(1), &actor).await.unwrap(), "one");
    assert_eq!(store.list_versions(&moved).await.unwrap().len(), 2);
    assert!(store
        .secret_info(&at("u1", "dev", "/app", "TOKEN"))
        .await
        .unwrap()
        .is_none());
    let folders = store.list_folders("dev").await.unwrap();
    assert!(folders.contains(&"/svc/api/db".to_owned()), "{folders:?}");
    assert!(folders.contains(&"/svc/api/empty".to_owned()), "{folders:?}");
    assert!(!folders.contains(&"/app".to_owned()), "{folders:?}");
    assert!(folders.contains(&"/apple".to_owned()), "{folders:?}");
    let imports = store.list_imports().await.unwrap();
    assert_eq!(imports[0].source_path, "/svc/api/db");
}

#[tokio::test]
async fn a_folder_move_refuses_collisions_self_nesting_root_and_any_refused_value() {
    let store = store();
    let actor = actor();
    put(&store, at("u1", "dev", "/a", "TOKEN"), "a").await;
    put(&store, at("u2", "dev", "/a", "OTHER"), "b").await;
    put(&store, at("u1", "dev", "/b", "TOKEN"), "taken").await;

    let collision = store
        .move_folder("dev", "/a", "dev", "/b", &actor, allow_all)
        .await
        .unwrap_err();
    assert!(message(&collision).contains("already exist"), "{collision}");
    let nested = store
        .move_folder("dev", "/a", "dev", "/a/inner", &actor, allow_all)
        .await
        .unwrap_err();
    assert!(message(&nested).contains("own sub-folder"), "{nested}");
    assert!(store
        .move_folder("dev", "/", "dev", "/z", &actor, allow_all)
        .await
        .is_err());
    // u2's value is not the caller's to move: the whole move is refused and
    // the refusal names no value.
    let refused = store
        .move_folder("dev", "/a", "prod", "/a", &actor, |old, _| {
            old.scope_id == "u1"
        })
        .await
        .unwrap_err();
    assert!(message(&refused).contains("1 value(s)"), "{refused}");
    assert!(!message(&refused).contains("OTHER"), "{refused}");
    // Nothing moved.
    assert!(store
        .secret_info(&at("u1", "dev", "/a", "TOKEN"))
        .await
        .unwrap()
        .is_some());
    // Across environments with everything allowed.
    let report = store
        .move_folder("dev", "/a", "prod", "/a", &actor, allow_all)
        .await
        .unwrap();
    assert_eq!(report.values, 2);
    assert_eq!(
        store
            .reveal(&at("u2", "prod", "/a", "OTHER"), None, &actor)
            .await
            .unwrap(),
        "b"
    );
}

#[tokio::test]
async fn a_value_moves_and_renames_within_its_scope_and_is_audited() {
    let store = store();
    let actor = actor();
    put(&store, at("u1", "dev", "/", "OLD_NAME"), "v").await;
    put(&store, at("u1", "dev", "/x", "BUSY"), "w").await;
    let moved = store
        .move_secret(
            at("u1", "dev", "/", "OLD_NAME"),
            at("u1", "prod", "/x", "NEW_NAME"),
            &actor,
        )
        .await
        .unwrap();
    assert_eq!(moved.environment, "prod");
    assert_eq!(moved.path, "/x");
    assert_eq!(moved.name, "NEW_NAME");
    let missing = store
        .move_secret(
            at("u1", "dev", "/", "OLD_NAME"),
            at("u1", "dev", "/", "ANY"),
            &actor,
        )
        .await
        .unwrap_err();
    assert!(message(&missing).contains("not_found"), "{missing}");
    let taken = store
        .move_secret(
            at("u1", "prod", "/x", "NEW_NAME"),
            at("u1", "dev", "/x", "BUSY"),
            &actor,
        )
        .await
        .unwrap_err();
    assert!(message(&taken).contains("already exists"), "{taken}");
    let rescoped = store
        .move_secret(
            at("u1", "prod", "/x", "NEW_NAME"),
            at("u2", "prod", "/x", "NEW_NAME"),
            &actor,
        )
        .await
        .unwrap_err();
    assert!(message(&rescoped).contains("scope"), "{rescoped}");

    let conn = store.conn.lock().await;
    let rows = crate::vault::audit::list(
        &conn,
        &crate::vault::audit::AuditFilter {
            limit: 50,
            action: Some("secret.move".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name.as_deref(), Some("OLD_NAME"));
}
