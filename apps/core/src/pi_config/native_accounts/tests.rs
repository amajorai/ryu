use super::*;

fn manager() -> (NativeAccounts, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let cli = directory.path().join(if cfg!(windows) {
        "kiro-cli.exe"
    } else {
        "kiro-cli"
    });
    let accounts =
        NativeAccounts::new(AccountVault::in_memory().unwrap(), directory.path(), &cli).unwrap();
    (accounts, directory)
}

fn connected(accounts: &NativeAccounts, id: &str, subject: &str) {
    let (value, mut record) = accounts.read(id).unwrap();
    record.state = ConnectionState::Connected;
    record.identity = Some(NativeIdentity {
        subject: subject.into(),
        issuer: "fixture".into(),
    });
    record.credential_revision = 1;
    assert!(accounts
        .vault
        .replace_credential(SCOPE, id, &value, serde_json::to_value(record).unwrap())
        .unwrap());
}

#[test]
fn pending_registration_is_sealed_and_cannot_launch() {
    let (accounts, _directory) = manager();
    let info = accounts.create("Personal").unwrap();
    assert!(!info.verified);
    assert_eq!(info.state, ConnectionState::Pending);
    assert!(accounts.capture(&info.account_id).is_err());
    assert_eq!(accounts.vault.list(SCOPE).unwrap()[0].kind, KIND);
    assert!(accounts
        .vault
        .credential(SCOPE, &info.account_id)
        .unwrap()
        .is_some());
    let public = serde_json::to_string(&accounts.list().unwrap()).unwrap();
    assert!(!public.contains("custodyNamespace"));
    assert!(!public.contains("identityEpoch"));
}

#[test]
fn every_vendor_home_and_aws_file_is_account_local() {
    let (accounts, _directory) = manager();
    let a = accounts.create("A").unwrap();
    let b = accounts.create("B").unwrap();
    connected(&accounts, &a.account_id, "a");
    connected(&accounts, &b.account_id, "b");
    let first = accounts.capture(&a.account_id).unwrap();
    let second = accounts.capture(&b.account_id).unwrap();
    for key in [
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "KIRO_HOME",
        "AWS_SHARED_CREDENTIALS_FILE",
        "AWS_CONFIG_FILE",
    ] {
        assert_ne!(first.env[key], second.env[key]);
        assert!(Path::new(&first.env[key]).starts_with(&accounts.root));
    }
    assert!(!first.affinity.resume_matches(&second.affinity));
    assert_ne!(
        first.affinity.process_identity(),
        second.affinity.process_identity()
    );
}

#[test]
fn switching_does_not_mutate_an_existing_capture() {
    let (accounts, _directory) = manager();
    let a = accounts.create("A").unwrap();
    let b = accounts.create("B").unwrap();
    connected(&accounts, &a.account_id, "a");
    connected(&accounts, &b.account_id, "b");
    accounts.select(&a.account_id).unwrap();
    let launch = accounts.capture_active().unwrap();
    accounts.select(&b.account_id).unwrap();
    assert_eq!(launch.affinity.account_id, a.account_id);
    assert_eq!(
        accounts.capture_active().unwrap().affinity.account_id,
        b.account_id
    );
}

#[test]
fn pending_creation_preserves_ready_active_selection_atomically() {
    let (accounts, _directory) = manager();
    let a = accounts.create("A").unwrap();
    assert!(accounts.vault.active_info(SCOPE).unwrap().is_none());
    connected(&accounts, &a.account_id, "a");
    accounts.select(&a.account_id).unwrap();
    let b = accounts.create("B").unwrap();
    assert!(!b.active);
    assert_eq!(
        accounts.capture_active().unwrap().affinity.account_id,
        a.account_id
    );
}

#[test]
fn durable_conversation_binding_rejects_switch_removal_and_restart_mismatch() {
    let (accounts, _directory) = manager();
    let a = accounts.create("A").unwrap();
    let b = accounts.create("B").unwrap();
    connected(&accounts, &a.account_id, "a");
    connected(&accounts, &b.account_id, "b");
    accounts.select(&a.account_id).unwrap();
    let first = accounts.capture_conversation(Some("chat"), "kiro").unwrap();
    accounts.select(&b.account_id).unwrap();
    assert_eq!(
        accounts
            .capture_conversation(Some("chat"), "kiro")
            .unwrap()
            .affinity,
        first.affinity
    );
    assert_eq!(
        accounts
            .capture_conversation(Some("new-chat"), "kiro")
            .unwrap()
            .affinity
            .account_id,
        b.account_id
    );
    let restarted = NativeAccounts::new(
        accounts.vault.clone(),
        accounts.root.parent().unwrap().parent().unwrap(),
        &accounts.cli,
    )
    .unwrap();
    assert_eq!(
        restarted
            .capture_conversation(Some("chat"), "kiro")
            .unwrap()
            .affinity,
        first.affinity
    );
    accounts.remove(&a.account_id).unwrap();
    assert!(restarted
        .capture_conversation(Some("chat"), "kiro")
        .is_err());
}

#[test]
fn disconnected_and_removed_accounts_cannot_silently_rebind() {
    let (accounts, _directory) = manager();
    let a = accounts.create("A").unwrap();
    connected(&accounts, &a.account_id, "a");
    let old = accounts.capture(&a.account_id).unwrap();
    accounts.disconnect(&a.account_id).unwrap();
    assert!(accounts.capture(&a.account_id).is_err());
    assert!(accounts.select(&a.account_id).is_err());
    connected(&accounts, &a.account_id, "a");
    assert!(!old
        .affinity
        .resume_matches(&accounts.capture(&a.account_id).unwrap().affinity));
    assert!(accounts.remove(&a.account_id).unwrap());
    assert!(accounts.capture(&a.account_id).is_err());
}

#[test]
fn credential_rotation_reuses_identity_but_not_live_process() {
    let (accounts, _directory) = manager();
    let a = accounts.create("A").unwrap();
    connected(&accounts, &a.account_id, "a");
    let before = accounts.capture(&a.account_id).unwrap();
    let (expected, mut record) = accounts.read(&a.account_id).unwrap();
    record.credential_revision += 1;
    assert!(accounts
        .vault
        .replace_credential(
            SCOPE,
            &a.account_id,
            &expected,
            serde_json::to_value(record).unwrap()
        )
        .unwrap());
    let after = accounts.capture(&a.account_id).unwrap();
    assert!(before.affinity.resume_matches(&after.affinity));
    assert_ne!(
        before.affinity.process_identity(),
        after.affinity.process_identity()
    );
}

#[test]
fn opaque_account_and_display_identity_are_not_credentials() {
    let (accounts, _directory) = manager();
    accounts
        .vault
        .upsert(SCOPE, "opaque", "Email", "opaque", None)
        .unwrap();
    assert!(accounts.capture("opaque").is_err());
    assert!(parse_identity(br#"{"email":"test@example.com","loggedIn":true}"#).is_err());
    assert!(parse_identity(br#"{"subject":"principal"}"#).is_err());
    assert!(parse_identity(br#"{"userId":"","issuer":"fixture"}"#).is_err());
    assert!(parse_identity(b"Not logged in").is_err());
    assert_eq!(
        parse_identity(br#"{"userId":"principal","identityProvider":"fixture"}"#).unwrap(),
        NativeIdentity {
            subject: "principal".into(),
            issuer: "fixture".into()
        }
    );
}

#[test]
fn native_boundary_identifies_configured_vendor_auth_overrides_case_insensitively() {
    for name in [
        "AWS_ACCESS_KEY_ID",
        "AWS_BEARER_TOKEN_BEDROCK",
        "aws_profile",
        "KIRO_ACCESS_TOKEN",
        "Q_TOKEN",
    ] {
        assert!(is_vendor_auth_env(name));
    }
    assert!(!is_vendor_auth_env("PATH"));
    assert!(!is_vendor_auth_env("SYSTEMROOT"));
}

#[test]
fn vault_failure_never_returns_a_connected_account() {
    let (accounts, _directory) = manager();
    accounts.vault.reject_writes_for_test().unwrap();
    assert!(accounts.create("A").is_err());
    assert!(accounts.list().unwrap().is_empty());
}

#[test]
fn hostile_custody_namespace_cannot_escape_the_managed_root() {
    let (accounts, _directory) = manager();
    let a = accounts.create("A").unwrap();
    let (expected, mut record) = accounts.read(&a.account_id).unwrap();
    record.custody_namespace = "../../global".into();
    assert!(accounts
        .vault
        .replace_credential(
            SCOPE,
            &a.account_id,
            &expected,
            serde_json::to_value(record).unwrap()
        )
        .unwrap());
    assert!(accounts.capture(&a.account_id).is_err());
    assert!(accounts.begin_login(&a.account_id).is_err());
}

#[tokio::test]
async fn stale_login_completion_cannot_resurrect_removed_account() {
    let (accounts, _directory) = manager();
    let a = accounts.create("A").unwrap();
    let (attempt, _) = accounts.begin_login(&a.account_id).unwrap();
    accounts.remove(&a.account_id).unwrap();
    assert!(accounts.finish_login(attempt).await.is_err());
    assert!(accounts.list().unwrap().is_empty());
}

#[tokio::test]
async fn cancelled_login_completion_cannot_restore_disconnected_account() {
    let (accounts, _directory) = manager();
    let a = accounts.create("A").unwrap();
    let (attempt, _) = accounts.begin_login(&a.account_id).unwrap();
    accounts.disconnect(&a.account_id).unwrap();
    assert!(accounts.finish_login(attempt).await.is_err());
    assert_eq!(
        accounts.list().unwrap()[0].state,
        ConnectionState::Disconnected
    );
}

#[test]
fn simultaneous_authorization_operations_are_rejected_per_account() {
    let (accounts, _directory) = manager();
    let a = accounts.create("A").unwrap();
    let b = accounts.create("B").unwrap();
    let (attempt, _) = accounts.begin_login(&a.account_id).unwrap();
    assert!(accounts.begin_login(&a.account_id).is_err());
    assert!(accounts.begin_login(&b.account_id).is_ok());
    drop(attempt);
    assert!(accounts.begin_login(&a.account_id).is_ok());
}

#[cfg(unix)]
#[test]
fn redirected_profile_directory_is_rejected() {
    let (accounts, directory) = manager();
    let a = accounts.create("A").unwrap();
    let (_, record) = accounts.read(&a.account_id).unwrap();
    let home = accounts.root.join(&record.custody_namespace);
    let external = directory.path().join("external");
    std::fs::create_dir(&external).unwrap();
    std::fs::remove_dir_all(&home).unwrap();
    std::os::unix::fs::symlink(external, &home).unwrap();
    assert!(accounts.begin_login(&a.account_id).is_err());
}

#[tokio::test]
async fn process_fixture_requires_login_then_machine_identity() {
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    let (accounts, _directory) = manager();
    #[cfg(windows)]
    let accounts = NativeAccounts {
        cli: accounts.cli.with_extension("cmd"),
        ..accounts
    };
    #[cfg(windows)]
    {
        std::fs::write(&accounts.cli, "@echo off\r\nif \"%~1\"==\"login\" (\r\n echo fixture > \"%KIRO_HOME%\\auth\"\r\n exit /b 0\r\n)\r\nif \"%~1\"==\"whoami\" (\r\n if not exist \"%KIRO_HOME%\\auth\" exit /b 1\r\n echo {\"userId\":\"principal\",\"issuer\":\"fixture\"}\r\n exit /b 0\r\n)\r\nif \"%~1\"==\"logout\" (\r\n del \"%KIRO_HOME%\\auth\"\r\n exit /b 0\r\n)\r\nexit /b 1\r\n").unwrap();
    }
    #[cfg(unix)]
    {
        std::fs::write(&accounts.cli, "#!/bin/sh\ncase \"$1\" in\nlogin) echo fixture > \"$KIRO_HOME/auth\" ;;\nwhoami) test -f \"$KIRO_HOME/auth\" || exit 1; echo '{\"userId\":\"principal\",\"issuer\":\"fixture\"}' ;;\nlogout) rm -f \"$KIRO_HOME/auth\" ;;\nesac\n").unwrap();
        std::fs::set_permissions(&accounts.cli, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let a = accounts.create("A").unwrap();
    let b = accounts.create("B").unwrap();
    accounts.login(&a.account_id).await.unwrap();
    let captured = accounts.capture(&a.account_id).unwrap();
    accounts.verify_capture(&captured).await.unwrap();
    assert!(accounts.capture(&b.account_id).is_err());
    accounts.logout(&a.account_id).await.unwrap();
    assert!(accounts.verify_capture(&captured).await.is_err());
}

#[test]
fn custody_homes_are_owner_only_and_wiped_on_remove() {
    let (accounts, _directory) = manager();
    let a = accounts.create("A").unwrap();
    let b = accounts.create("B").unwrap();
    connected(&accounts, &a.account_id, "a");
    connected(&accounts, &b.account_id, "b");
    let first = accounts.capture(&a.account_id).unwrap();
    let second = accounts.capture(&b.account_id).unwrap();
    let home = PathBuf::from(&first.env["HOME"]);
    let kept = PathBuf::from(&second.env["HOME"]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&home).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }
    // What the vendor CLI would leave behind after a login.
    let token_store = home.join(".local/share/kiro-cli/data.sqlite3");
    std::fs::create_dir_all(token_store.parent().unwrap()).unwrap();
    std::fs::write(&token_store, b"vendor-refresh-token").unwrap();
    std::fs::write(&first.env["AWS_SHARED_CREDENTIALS_FILE"], b"aws-secret").unwrap();

    assert!(accounts.remove(&a.account_id).unwrap());
    assert!(!home.exists(), "removed account home must be wiped");
    assert!(kept.exists(), "another account's home must survive");
    assert!(!accounts.remove(&a.account_id).unwrap());
}
