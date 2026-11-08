use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::json;

use super::super::redis;
use super::iam::{iam_sign, xml_text, IAM_ENDPOINT};
use super::*;
use crate::plugin_secrets::{PluginSecretStore, SecretScope};
use crate::vault::audit::AuditActor;
use crate::vault::now_millis;

fn target() -> SecretCoords {
    SecretCoords::root(SecretScope::Node, "local", None, "CACHE_PASSWORD")
}

fn redis_input(url: &str) -> StaticRoleInput {
    serde_json::from_value(json!({
        "provider": { "kind": "valkey", "connectionUrl": url, "username": "app" },
        "rotationPeriodSecs": 3600,
    }))
    .unwrap()
}

#[test]
fn providers_validate_their_targets() {
    let ok: StaticProvider = serde_json::from_value(json!({
        "kind": "postgres", "connectionUrl": "postgres://a:b@db/x", "username": "app_user"
    }))
    .unwrap();
    assert!(ok.validate().is_ok());
    assert_eq!(ok.summary()["username"], "app_user");
    for bad in [
        json!({ "kind": "postgres", "connectionUrl": "mysql://db", "username": "app" }),
        json!({ "kind": "postgres", "connectionUrl": "postgres://db", "username": "a\"b" }),
        json!({ "kind": "postgres", "connectionUrl": "postgres://db", "username": "app",
                    "rotationStatements": ["SELECT 1"] }),
        json!({ "kind": "redis", "connectionUrl": "redis://h", "username": "default" }),
        json!({ "kind": "webhook", "url": "http://example.com", "signingSecret": "x".repeat(16), "username": "u" }),
        json!({ "kind": "aws-iam", "accessKeyId": "", "secretAccessKey": "s", "userName": "ci" }),
        json!({ "kind": "aws-iam", "accessKeyId": "A", "secretAccessKey": "s", "userName": "bad name" }),
    ] {
        let provider: StaticProvider = serde_json::from_value(bad.clone()).unwrap();
        assert!(provider.validate().is_err(), "{bad}");
    }
    assert_eq!(provider_kinds().len(), 6);
}

#[tokio::test]
async fn redis_roles_rotate_into_kv_versions() {
    let (url, log) = redis::tests::fake_server(false).await;
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let role = store
        .static_put_role("cache", &redis_input(&url), target(), &actor)
        .await
        .unwrap();
    assert_eq!(role.provider, "redis");
    assert!(
        role.next_rotation_at <= now_millis(),
        "a new role is due at once"
    );
    assert!(store.static_read("cache", &actor).await.is_err());

    assert_eq!(store.static_rotate_due().await.unwrap(), 1);
    let (info, first) = store.static_read("cache", &actor).await.unwrap();
    assert_eq!(first.len(), 32);
    assert!(info.last_rotated_at.is_some());
    assert!(!info.pending);
    assert!(info.next_rotation_at > now_millis());
    assert_eq!(
        store.static_rotate_due().await.unwrap(),
        0,
        "not due again yet"
    );

    store.static_rotate("cache", &actor).await.unwrap();
    let (_, second) = store.static_read("cache", &actor).await.unwrap();
    assert_ne!(first, second);
    let versions = store.list_versions(&target()).await.unwrap();
    assert_eq!(versions.len(), 2);

    let log = log.lock().unwrap().clone();
    let setusers: Vec<&Vec<String>> = log.iter().filter(|cmd| cmd[0] == "ACL").collect();
    assert_eq!(setusers[0][..4], ["ACL", "SETUSER", "app", "resetpass"]);
    assert_eq!(setusers[0][4], format!(">{first}"));
    assert_eq!(setusers[1][4], format!(">{second}"));
}

#[tokio::test]
async fn failed_rotations_keep_the_old_value_and_retry_the_same_credential() {
    let failing = Arc::new(AtomicBool::new(false));
    let (url, log) = redis::tests::fake_server_with(failing.clone()).await;
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    store
        .static_put_role("cache", &redis_input(&url), target(), &actor)
        .await
        .unwrap();
    store.static_rotate("cache", &actor).await.unwrap();
    let (_, before) = store.static_read("cache", &actor).await.unwrap();

    failing.store(true, Ordering::SeqCst);
    assert!(store.static_rotate("cache", &actor).await.is_err());
    let info = store.static_role("cache").await.unwrap();
    assert!(info.pending);
    assert!(info
        .last_error
        .as_deref()
        .unwrap()
        .contains("ACL SETUSER failed"));
    assert!(!info.last_error.as_deref().unwrap().contains('>'));
    let (_, unchanged) = store.static_read("cache", &actor).await.unwrap();
    assert_eq!(unchanged, before, "the previous version stays current");

    failing.store(false, Ordering::SeqCst);
    store.static_rotate("cache", &actor).await.unwrap();
    let (info, after) = store.static_read("cache", &actor).await.unwrap();
    assert!(!info.pending);
    assert!(info.last_error.is_none());
    let log = log.lock().unwrap().clone();
    let sets: Vec<&Vec<String>> = log.iter().filter(|cmd| cmd[0] == "ACL").collect();
    assert_eq!(sets.len(), 3);
    assert_eq!(
        sets[1][4], sets[2][4],
        "the retry reuses the pending password"
    );
    assert_eq!(sets[2][4], format!(">{after}"));
}

#[tokio::test]
async fn schedule_edits_keep_the_clock_and_target_changes_reset_it() {
    let (url, _) = redis::tests::fake_server(false).await;
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    store
        .static_put_role("cache", &redis_input(&url), target(), &actor)
        .await
        .unwrap();
    let rotated = store.static_rotate("cache", &actor).await.unwrap();
    let mut slower = redis_input(&url);
    slower.rotation_period_secs = 7200;
    let edited = store
        .static_put_role("cache", &slower, target(), &actor)
        .await
        .unwrap();
    assert_eq!(edited.last_rotated_at, rotated.last_rotated_at);
    assert_eq!(
        edited.next_rotation_at,
        rotated.last_rotated_at.unwrap() + 7_200_000
    );
    let mut moved = target();
    moved.name = "OTHER_PASSWORD".into();
    let retargeted = store
        .static_put_role("cache", &slower, moved, &actor)
        .await
        .unwrap();
    assert!(retargeted.next_rotation_at <= now_millis());

    let mut too_fast = redis_input(&url);
    too_fast.rotation_period_secs = 10;
    assert!(store
        .static_put_role("cache", &too_fast, target(), &actor)
        .await
        .is_err());
    store.static_delete_role("cache", &actor).await.unwrap();
    assert!(store.static_delete_role("cache", &actor).await.is_err());
}

fn aws_input(user: &str, current: Option<&str>) -> StaticRoleInput {
    serde_json::from_value(json!({
        "provider": { "kind": "aws-iam", "accessKeyId": "AKIAADMIN", "secretAccessKey": "s",
                      "userName": user, "currentAccessKeyId": current },
        "rotationPeriodSecs": 3600,
    }))
    .unwrap()
}

#[tokio::test]
async fn aws_re_puts_keep_the_live_key_id_and_the_pending_key() {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    store
        .static_put_role("ci", &aws_input("ci", Some("AKIAORIG")), target(), &actor)
        .await
        .unwrap();
    // Simulate a completed rotation (live key AKIANEW) followed by a
    // created-but-unwritten key.
    let (_, mut state) = store.static_state("ci").await.unwrap();
    if let StaticProvider::AwsIam {
        current_access_key_id,
        ..
    } = &mut state.provider
    {
        *current_access_key_id = Some("AKIANEW".into());
    }
    state.pending = Some(json!({ "accessKeyId": "AKIAPEND", "secretAccessKey": "x" }).to_string());
    {
        let conn = store.conn.lock().await;
        store.static_seal_state(&conn, "ci", &state).unwrap();
    }

    // Re-sending the original body (stale key id) changes nothing managed.
    let mut slower = aws_input("ci", Some("AKIAORIG"));
    slower.rotation_period_secs = 7200;
    let info = store
        .static_put_role("ci", &slower, target(), &actor)
        .await
        .unwrap();
    assert!(info.pending, "the pending key is kept");
    let (_, kept) = store.static_state("ci").await.unwrap();
    assert_eq!(kept.pending, state.pending);
    assert!(matches!(
        &kept.provider,
        StaticProvider::AwsIam { current_access_key_id: Some(id), .. } if id == "AKIANEW"
    ));
    store
        .static_put_role("ci", &aws_input("ci", None), target(), &actor)
        .await
        .unwrap();
    let (_, kept) = store.static_state("ci").await.unwrap();
    assert!(matches!(
        &kept.provider,
        StaticProvider::AwsIam { current_access_key_id: Some(id), .. } if id == "AKIANEW"
    ));

    // Re-pointing the role while a key is pending is refused.
    let error = store
        .static_put_role("ci", &aws_input("other-user", None), target(), &actor)
        .await
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<VaultError>(),
        Some(VaultError::Conflict(_))
    ));
    let mut moved = target();
    moved.name = "OTHER".into();
    assert!(store
        .static_put_role("ci", &aws_input("ci", None), moved, &actor)
        .await
        .is_err());
}

/// A fake IAM endpoint: tracks the user's live keys, enforces AWS's
/// two-key limit, and can fail `DeleteAccessKey` on demand.
#[derive(Default)]
struct FakeIam {
    keys: Vec<String>,
    created: usize,
    fail_delete: bool,
}

async fn fake_iam(initial: &str) -> (String, Arc<std::sync::Mutex<FakeIam>>) {
    use axum::http::StatusCode;
    let fake = Arc::new(std::sync::Mutex::new(FakeIam {
        keys: vec![initial.to_owned()],
        ..FakeIam::default()
    }));
    let state = fake.clone();
    let handler = move |body: String| {
        let state = state.clone();
        async move {
            let form: BTreeMap<String, String> = url::form_urlencoded::parse(body.as_bytes())
                .into_owned()
                .collect();
            let mut iam = state.lock().unwrap();
            let error = |status: StatusCode, code: &str| {
                (status, format!("<Error><Code>{code}</Code></Error>"))
            };
            match form.get("Action").map(String::as_str) {
                Some("CreateAccessKey") if iam.keys.len() >= 2 => {
                    error(StatusCode::CONFLICT, "LimitExceeded")
                }
                Some("CreateAccessKey") => {
                    iam.created += 1;
                    let id = format!("AKIANEW{}", iam.created);
                    iam.keys.push(id.clone());
                    (
                        StatusCode::OK,
                        format!(
                            "<AccessKey><AccessKeyId>{id}</AccessKeyId>\
                                 <SecretAccessKey>s{id}</SecretAccessKey></AccessKey>"
                        ),
                    )
                }
                Some("DeleteAccessKey") if iam.fail_delete => {
                    error(StatusCode::INTERNAL_SERVER_ERROR, "ServiceFailure")
                }
                Some("DeleteAccessKey") => {
                    let id = form.get("AccessKeyId").cloned().unwrap_or_default();
                    if iam.keys.contains(&id) {
                        iam.keys.retain(|key| key != &id);
                        (StatusCode::OK, "<DeleteAccessKeyResponse/>".to_owned())
                    } else {
                        error(StatusCode::NOT_FOUND, "NoSuchEntity")
                    }
                }
                _ => error(StatusCode::BAD_REQUEST, "InvalidAction"),
            }
        }
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = axum::Router::new().fallback(handler);
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });
    (format!("http://{addr}/"), fake)
}

#[tokio::test]
async fn aws_keys_that_fail_to_delete_are_kept_and_retried() {
    let (endpoint, iam) = fake_iam("AKIAORIG").await;
    IAM_ENDPOINT.with(|cell| *cell.borrow_mut() = Some(endpoint));
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    store
        .static_put_role("ci", &aws_input("ci", Some("AKIAORIG")), target(), &actor)
        .await
        .unwrap();

    // The new key is written but the old one cannot be deleted: the
    // rotation completes and keeps the old id for a retry.
    iam.lock().unwrap().fail_delete = true;
    let info = store.static_rotate("ci", &actor).await.unwrap();
    assert!(!info.pending);
    assert!(info.last_error.as_deref().unwrap().contains("AKIAORIG"));
    let (_, state) = store.static_state("ci").await.unwrap();
    assert_eq!(state.retired_access_keys, ["AKIAORIG"]);
    assert!(matches!(
        &state.provider,
        StaticProvider::AwsIam { current_access_key_id: Some(id), .. } if id == "AKIANEW1"
    ));
    assert_eq!(iam.lock().unwrap().keys, ["AKIAORIG", "AKIANEW1"]);

    // A same-account edit keeps the retired id; re-pointing is refused.
    let info = store
        .static_put_role("ci", &aws_input("ci", None), target(), &actor)
        .await
        .unwrap();
    assert!(!info.pending);
    assert_eq!(
        store
            .static_state("ci")
            .await
            .unwrap()
            .1
            .retired_access_keys,
        ["AKIAORIG"]
    );
    let error = store
        .static_put_role("ci", &aws_input("other-user", None), target(), &actor)
        .await
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<VaultError>(),
        Some(VaultError::Conflict(_))
    ));

    // The next rotation deletes the retired key first (AWS allows only
    // two keys), then the key it replaces.
    iam.lock().unwrap().fail_delete = false;
    let info = store.static_rotate("ci", &actor).await.unwrap();
    assert!(info.last_error.is_none());
    let (_, state) = store.static_state("ci").await.unwrap();
    assert!(state.retired_access_keys.is_empty());
    assert_eq!(iam.lock().unwrap().keys, ["AKIANEW2"]);
    let (_, value) = store.static_read("ci", &actor).await.unwrap();
    assert!(value.contains("AKIANEW2"));
    IAM_ENDPOINT.with(|cell| *cell.borrow_mut() = None);
}

#[tokio::test]
async fn redis_admin_credential_edits_keep_a_pending_password() {
    let failing = Arc::new(AtomicBool::new(true));
    let (url, _) = redis::tests::fake_server_with(failing.clone()).await;
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    store
        .static_put_role("cache", &redis_input(&url), target(), &actor)
        .await
        .unwrap();
    assert!(store.static_rotate("cache", &actor).await.is_err());
    let (_, before) = store.static_state("cache").await.unwrap();
    assert!(before.pending.is_some());
    // New admin password, same host and user: the pending password stays.
    let edited_url = url.replace("s3cret", "n3w-admin");
    let info = store
        .static_put_role("cache", &redis_input(&edited_url), target(), &actor)
        .await
        .unwrap();
    assert!(info.pending);
    let (_, after) = store.static_state("cache").await.unwrap();
    assert_eq!(after.pending, before.pending);
}

#[test]
fn iam_requests_are_sigv4_signed_for_iam() {
    let headers = iam_sign(
        "AKIDEXAMPLE",
        "secret",
        "Action=CreateAccessKey&UserName=ci&Version=2010-05-08",
        "20260101T000000Z",
    );
    let auth = &headers
        .iter()
        .find(|(name, _)| name == "authorization")
        .unwrap()
        .1;
    assert!(auth.starts_with(
        "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260101/us-east-1/iam/aws4_request"
    ));
    assert_eq!(
            xml_text("<CreateAccessKeyResult><AccessKey><AccessKeyId>AKIA1</AccessKeyId></AccessKey></CreateAccessKeyResult>", "AccessKeyId"),
            Some("AKIA1")
        );
}
