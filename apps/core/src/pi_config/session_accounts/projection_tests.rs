use super::*;

#[test]
fn projection_rejects_tokens_inside_actual_sdk_refresh_window() {
    let directory = tempfile::tempdir().unwrap();
    let credential = json!({"type":"oauth", "access":"fixture-access", "refresh":"must-stay-sealed",
        "expires":super::super::now_unix().saturating_mul(1000).saturating_add(60_000)});
    assert!(publish_credential(directory.path(), "github-copilot", &credential).is_err());
    assert!(!directory.path().join("auth.json").exists());
}

#[test]
fn access_projection_retains_expiry_metadata_and_withholds_refresh() {
    let directory = tempfile::tempdir().unwrap();
    let credential = json!({"type":"oauth", "access":"fixture-access", "refresh":"must-stay-sealed", "expires":4_000_000_000_000_u64,
        "enterpriseDomain":"copilot.example.test", "accountId":"fixture-account"});
    publish_credential(directory.path(), "github-copilot", &credential).unwrap();
    let projected: Value =
        serde_json::from_str(&std::fs::read_to_string(directory.path().join("auth.json")).unwrap())
            .unwrap();
    assert_eq!(projected.as_object().unwrap().len(), 1);
    let projected = &projected["github-copilot"];
    assert_eq!(projected["expires"], credential["expires"]);
    assert_eq!(
        projected["enterpriseDomain"],
        credential["enterpriseDomain"]
    );
    assert_eq!(projected["accountId"], credential["accountId"]);
    assert_eq!(projected["refresh"], "");
    assert_eq!(credential["refresh"], "must-stay-sealed");
}

#[test]
fn api_key_session_env_carries_the_sealed_key_and_projection_is_removed() {
    super::super::accounts::with_test_vault(|vault| {
        let scope = super::super::accounts::provider_scope("xai");
        vault
            .upsert(
                &scope,
                "only",
                "only",
                super::super::accounts::KIND_API_KEY,
                Some(json!("fixture-session-env-key")),
            )
            .unwrap();
        let captured = SessionAccount {
            provider_id: "xai".to_owned(),
            account_id: "only".to_owned(),
            session_key: "fixture-session".to_owned(),
            credential_kind: super::super::accounts::KIND_API_KEY.to_owned(),
        };
        assert_eq!(
            captured.secret_env().unwrap(),
            vec![(
                super::super::secret_env::SESSION_KEY_ENV.to_owned(),
                "fixture-session-env-key".to_owned()
            )]
        );
        let oauth = SessionAccount {
            credential_kind: super::super::accounts::KIND_OAUTH.to_owned(),
            ..captured.clone()
        };
        assert!(oauth.secret_env().unwrap().is_empty());
    });

    let root = tempfile::tempdir().unwrap();
    let session = root.path().join("fixture-session");
    publish_auth(
        &session,
        "github-copilot",
        json!({"type":"oauth", "access":"fixture-access", "refresh":"", "expires":1}),
    )
    .unwrap();
    std::fs::write(root.path().join("stray-file"), "keep").unwrap();
    assert!(session.join("auth.json").exists());
    assert_eq!(sweep_projections_in(root.path()), 1);
    assert!(!session.join("auth.json").exists());
    assert!(
        session.exists(),
        "only the credential projection is removed"
    );
    assert!(root.path().join("stray-file").exists());
    publish_auth(
        &session,
        "github-copilot",
        json!({"type":"api_key","key":"${RYU_PI_SESSION_KEY}"}),
    )
    .unwrap();
    remove_projection_in(&session);
    assert!(!session.join("auth.json").exists());
}

#[test]
fn boot_sweep_removes_legacy_provider_list_copies_with_plaintext_keys() {
    let root = tempfile::tempdir().unwrap();
    let session = root.path().join("legacy-session");
    std::fs::create_dir_all(&session).unwrap();
    // A verbatim copy an older build left: another provider's literal key and
    // the Core node bearer as a literal header.
    let legacy = json!({
        "providers": {
            "custom": { "apiKey": "fixture-legacy-custom-key" },
            "ryu-node": { "headers": { "x-ryu-node-token": "fixture-legacy-node-token" } }
        }
    });
    std::fs::write(session.join("models.json"), legacy.to_string()).unwrap();
    std::fs::write(
        session.join("models-store.json"),
        json!({"custom": {"models": [{"headers": {"Authorization": "Bearer fixture-legacy-custom-key"}}]}})
            .to_string(),
    )
    .unwrap();
    std::fs::write(session.join("settings.json"), "{}").unwrap();

    assert_eq!(sweep_projections_in(root.path()), 2);
    for entry in walk(&session) {
        let bytes = std::fs::read(&entry).unwrap();
        for secret in ["fixture-legacy-custom-key", "fixture-legacy-node-token"] {
            assert!(
                !bytes
                    .windows(secret.len())
                    .any(|window| window == secret.as_bytes()),
                "{} still holds {secret}",
                entry.display()
            );
        }
    }
    assert!(!session.join("models.json").exists());
    assert!(!session.join("models-store.json").exists());
    assert!(
        session.join("settings.json").exists(),
        "non-secret assets stay"
    );
    assert_eq!(sweep_projections_in(root.path()), 0);
}

fn walk(directory: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(directory).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            files.extend(walk(&path));
        } else {
            files.push(path);
        }
    }
    files
}

#[test]
fn projection_survives_until_the_last_instance_sharing_it_exits() {
    let root = tempfile::tempdir().unwrap();
    let session = root.path().join("shared-session");
    let key = format!("lease-{}", uuid::Uuid::new_v4().simple());
    let older = ProjectionLease::acquire(key.clone(), session.clone());
    publish_auth(
        &session,
        "xai",
        json!({"type":"api_key","key":"${RYU_PI_SESSION_KEY}"}),
    )
    .unwrap();
    // A replacement instance for the same conversation spawns while the older
    // one drains its in-flight turn.
    let newer = ProjectionLease::acquire(key.clone(), session.clone());
    drop(older);
    assert!(
        session.join("auth.json").exists(),
        "the live instance keeps its credential"
    );
    drop(newer);
    assert!(!session.join("auth.json").exists());

    // A later instance takes a fresh lease and its prepare_turn rewrites.
    let later = ProjectionLease::acquire(key, session.clone());
    publish_auth(
        &session,
        "xai",
        json!({"type":"api_key","key":"${RYU_PI_SESSION_KEY}"}),
    )
    .unwrap();
    assert!(session.join("auth.json").exists());
    drop(later);
    assert!(!session.join("auth.json").exists());
}

#[test]
fn republishing_replaces_the_projection_in_place_without_stray_temporaries() {
    // Every turn republishes over the previous turn's projection; this must
    // work while no other handle is open, including on Windows.
    let root = tempfile::tempdir().unwrap();
    let session = root.path().join("republished-session");
    for access in ["fixture-first-access", "fixture-second-access"] {
        publish_auth(
            &session,
            "github-copilot",
            json!({"type":"oauth", "access":access, "refresh":"", "expires":1}),
        )
        .unwrap();
    }
    let projected: Value =
        serde_json::from_str(&std::fs::read_to_string(session.join("auth.json")).unwrap()).unwrap();
    assert_eq!(
        projected["github-copilot"]["access"],
        "fixture-second-access"
    );
    let names: Vec<_> = std::fs::read_dir(&session)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names, vec![std::ffi::OsString::from("auth.json")]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(session.join("auth.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
