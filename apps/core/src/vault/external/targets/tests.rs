//! Secret-sync target tests against a local fake (see [`super::fake`]) of the
//! GitHub, Vercel, AWS Secrets Manager and Google Cloud Secret Manager
//! endpoints Core calls. No live service is contacted.

use serde_json::{json, Value};

use super::fake::{serve, Fake};
use crate::plugin_secrets::{
    PluginSecretStore, SecretCoords, SecretMetadataPatch, SecretScope, VersionSource, WriteRequest,
};
use crate::vault::audit::{AuditActor, AuditFilter};
use crate::vault::external::{DestinationInput, SourceInput, StoreInput, StoreRecord};

const VALUE: &str = "sync-value-never-logged";
const SA_PEM: &str = include_str!("../../../pi_config/fixtures/chatgpt-plan-test-private.pem");

fn actor() -> AuditActor {
    AuditActor::new("operator", None)
}

async fn write(store: &PluginSecretStore, path: &str, name: &str, value: &str) {
    let coords = SecretCoords {
        scope: SecretScope::Node,
        scope_id: "node-1".into(),
        environment: "default".into(),
        path: path.into(),
        binding: None,
        name: name.into(),
    };
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

async fn create_store(store: &PluginSecretStore, body: Value) -> anyhow::Result<StoreRecord> {
    let input: StoreInput = serde_json::from_value(body).unwrap();
    store.external_store_create(input, &actor()).await
}

async fn destination(
    store: &PluginSecretStore,
    store_id: &str,
    path: &str,
    remote: &str,
) -> anyhow::Result<String> {
    let input: DestinationInput = serde_json::from_value(json!({
        "storeId": store_id, "environment": "default", "path": path, "remotePath": remote,
    }))
    .unwrap();
    Ok(store
        .external_destination_create(input, "node-1", &actor())
        .await?
        .id)
}

async fn audit_text(store: &PluginSecretStore) -> String {
    let conn = store.conn.lock().await;
    let rows = crate::vault::audit::list(
        &conn,
        &AuditFilter {
            limit: 500,
            ..AuditFilter::default()
        },
    )
    .unwrap();
    serde_json::to_string(&rows).unwrap()
}

#[tokio::test]
async fn github_actions_values_are_sealed_to_the_environment_key() {
    let fake = Fake::new();
    let address = serve(fake.clone()).await;
    let store = PluginSecretStore::in_memory().unwrap();
    let record = create_store(&store, json!({
        "name": "gh", "kind": "github-actions", "address": address, "authMethod": "token",
        "repository": "acme/app", "githubEnvironment": "prod", "credentials": { "token": "gh-1" },
    }))
    .await
    .unwrap();
    let listed = serde_json::to_string(&store.external_store_list().await.unwrap()).unwrap();
    assert!(listed.contains("\"repository\":\"acme/app\"") && !listed.contains("gh-1"));
    store
        .external_store_test(&record.id, &actor())
        .await
        .unwrap();
    write(&store, "/ci", "TOKEN", VALUE).await;
    write(&store, "/ci", "REGION", "eu").await;
    destination(&store, &record.id, "/ci", "APP_")
        .await
        .unwrap();
    assert_eq!(store.external_tick().await.pushed, 1);
    let pushed = fake.with(|f| f.github.clone());
    let base = "/repos/acme/app/environments/prod/secrets";
    assert_eq!(
        pushed.get(&format!("{base}/APP_TOKEN")).map(String::as_str),
        Some(VALUE)
    );
    assert_eq!(
        pushed
            .get(&format!("{base}/APP_REGION"))
            .map(String::as_str),
        Some("eu")
    );
    assert!(!audit_text(&store).await.contains(VALUE));

    // GitHub is write-only: no source can pull from it.
    let input: SourceInput = serde_json::from_value(json!({
        "storeId": record.id, "environment": "default", "path": "/in", "mode": "sync",
    }))
    .unwrap();
    let error = store
        .external_source_create(input, "node-1", &actor())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("push-only"));
}

#[tokio::test]
async fn one_reserved_github_name_aborts_the_push_before_any_upload() {
    let fake = Fake::new();
    let address = serve(fake.clone()).await;
    let store = PluginSecretStore::in_memory().unwrap();
    let record = create_store(
        &store,
        json!({
            "name": "gh", "kind": "github-actions", "address": address, "authMethod": "token",
            "repository": "acme/app", "credentials": { "token": "gh-1" },
        }),
    )
    .await
    .unwrap();
    write(&store, "/ci", "A_OK", "1").await;
    write(&store, "/ci", "GITHUB_TOKEN", "2").await;
    let id = destination(&store, &record.id, "/ci", "").await.unwrap();
    let error = store.external_push(&id, &actor()).await.unwrap_err();
    assert!(error.to_string().contains("GITHUB_TOKEN"));
    assert!(fake.with(|f| f.github.is_empty()));
    let listed = store.external_destination_list().await.unwrap();
    assert_eq!(listed[0].last_status.as_deref(), Some("error"));
    assert_eq!(listed[0].failures, 1);
}

#[tokio::test]
async fn vercel_upserts_every_key_for_the_configured_targets() {
    let fake = Fake::new();
    let address = serve(fake.clone()).await;
    let store = PluginSecretStore::in_memory().unwrap();
    let record = create_store(&store, json!({
        "name": "vc", "kind": "vercel", "address": address, "authMethod": "token",
        "projectId": "prj_1", "teamId": "team_1", "vercelTargets": ["production", "preview", "production"],
        "credentials": { "token": "vc-1" },
    }))
    .await
    .unwrap();
    assert_eq!(record.options.vercel_targets, ["production", "preview"]);
    store
        .external_store_test(&record.id, &actor())
        .await
        .unwrap();
    write(&store, "/web", "API_URL", VALUE).await;
    destination(&store, &record.id, "/web", "").await.unwrap();
    assert_eq!(store.external_tick().await.pushed, 1);
    let (query, body) = fake.with(|f| f.vercel.last().cloned()).unwrap();
    assert_eq!(query, "upsert=true&teamId=team_1");
    assert_eq!(
        body,
        json!([{ "key": "API_URL", "value": VALUE, "type": "encrypted", "target": ["production", "preview"] }])
    );
}

#[tokio::test]
async fn vercel_entries_rejected_in_a_success_reply_fail_the_push() {
    let fake = Fake::new();
    let address = serve(fake.clone()).await;
    fake.with(|f| f.vercel_reject.push("TAKEN".into()));
    let store = PluginSecretStore::in_memory().unwrap();
    let record = create_store(
        &store,
        json!({
            "name": "vc", "kind": "vercel", "address": address, "authMethod": "token",
            "projectId": "prj_1", "credentials": { "token": "vc-1" },
        }),
    )
    .await
    .unwrap();
    write(&store, "/web", "API_URL", "fine").await;
    write(&store, "/web", "TAKEN", VALUE).await;
    let id = destination(&store, &record.id, "/web", "").await.unwrap();
    let error = store.external_push(&id, &actor()).await.unwrap_err();
    let text = error.to_string();
    assert!(text.contains("TAKEN (ENV_CONFLICT)"), "{text}");
    assert!(!text.contains(VALUE) && !text.contains("API_URL"));
    let listed = store.external_destination_list().await.unwrap();
    assert_eq!(listed[0].last_status.as_deref(), Some("error"));
    assert_eq!(listed[0].failures, 1);
    assert!(!serde_json::to_string(&listed).unwrap().contains(VALUE));
    assert!(!audit_text(&store).await.contains(VALUE));
}

#[tokio::test]
async fn invalid_vercel_names_abort_before_any_request() {
    let fake = Fake::new();
    let address = serve(fake.clone()).await;
    let store = PluginSecretStore::in_memory().unwrap();
    let record = create_store(
        &store,
        json!({
            "name": "vc", "kind": "vercel", "address": address, "authMethod": "token",
            "projectId": "prj_1", "credentials": { "token": "vc-1" },
        }),
    )
    .await
    .unwrap();
    let credentials = crate::vault::external::StoreCredentials {
        token: Some("vc-1".into()),
        ..Default::default()
    };
    for bad in ["1ST", "has-dash", "dot.name", ""] {
        let values = [
            ("OK".to_owned(), "1".to_owned()),
            (bad.to_owned(), "2".to_owned()),
        ]
        .into();
        let error = super::vercel::push(&record, &credentials, &values)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("not a valid Vercel"), "{bad}");
    }
    assert!(fake.with(|f| f.vercel.is_empty()));
    assert!(super::vercel::is_valid_env_name("_Api_2"));
}

#[test]
fn vercel_rejections_report_only_sent_names_and_plain_codes() {
    let sent = [("A".to_owned(), "secret".to_owned())].into();
    let body = json!({ "failed": [
        { "error": { "code": "ENV_CONFLICT", "key": "A", "message": "secret" } },
        { "error": { "code": "bad code; secret", "key": "NOT_SENT" } },
    ] });
    assert_eq!(
        super::vercel::rejected_entries(&body, &sent),
        ["A (ENV_CONFLICT)", "unknown key (rejected)"]
    );
    assert!(super::vercel::rejected_entries(&json!({ "failed": [] }), &sent).is_empty());
    assert!(super::vercel::rejected_entries(&Value::Null, &sent).is_empty());
}

#[tokio::test]
async fn aws_keeps_one_signed_json_secret_and_never_wipes_it() {
    let fake = Fake::new();
    let address = serve(fake.clone()).await;
    let store = PluginSecretStore::in_memory().unwrap();
    let record = create_store(&store, json!({
        "name": "aws", "kind": "aws-secrets-manager", "address": address, "authMethod": "access-key",
        "region": "us-east-1", "pathPrefix": "ryu",
        "credentials": { "accessKeyId": "AKIDTEST", "secretAccessKey": "aws-secret" },
    }))
    .await
    .unwrap();
    store
        .external_store_test(&record.id, &actor())
        .await
        .unwrap();
    write(&store, "/api", "DB_URL", VALUE).await;
    let id = destination(&store, &record.id, "/api", "prod/api")
        .await
        .unwrap();
    assert_eq!(store.external_push(&id, &actor()).await.unwrap(), 1);
    assert_eq!(
        fake.with(|f| f.aws.get("ryu/prod/api").cloned()),
        Some(json!({ "DB_URL": VALUE }).to_string())
    );
    // Unchanged: read, no new version.
    store.external_push(&id, &actor()).await.unwrap();
    let calls = fake.with(|f| f.aws_calls.clone());
    assert_eq!(
        calls,
        [
            "ListSecrets",
            "GetSecretValue",
            "CreateSecret",
            "GetSecretValue"
        ]
    );
    // An emptied folder never wipes the remote secret.
    store
        .soft_delete(
            SecretCoords {
                scope: SecretScope::Node,
                scope_id: "node-1".into(),
                environment: "default".into(),
                path: "/api".into(),
                binding: None,
                name: "DB_URL".into(),
            },
            &actor(),
        )
        .await
        .unwrap();
    let error = store.external_push(&id, &actor()).await.unwrap_err();
    assert!(error.to_string().contains("refusing to wipe"));
    assert!(fake.with(|f| f.aws.contains_key("ryu/prod/api")));
    assert_eq!(fake.with(|f| f.aws_bad_signatures), 0);
}

#[tokio::test]
async fn gcp_service_accounts_add_versions_only_for_changed_values() {
    let fake = Fake::new();
    let address = serve(fake.clone()).await;
    let key = json!({
        "type": "service_account", "client_email": "sync@proj-1.iam.gserviceaccount.com",
        "private_key": SA_PEM, "token_uri": format!("{address}/token"),
    })
    .to_string();
    let store = PluginSecretStore::in_memory().unwrap();
    let record = create_store(
        &store,
        json!({
            "name": "gcp", "kind": "gcp-secret-manager", "address": address,
            "authMethod": "service-account", "projectId": "proj-1",
            "credentials": { "serviceAccountKey": key },
        }),
    )
    .await
    .unwrap();
    store
        .external_store_test(&record.id, &actor())
        .await
        .unwrap();
    let listed = serde_json::to_string(&store.external_store_list().await.unwrap()).unwrap();
    assert!(!listed.contains("PRIVATE KEY"));
    write(&store, "/svc", "A", VALUE).await;
    let id = destination(&store, &record.id, "/svc", "app-")
        .await
        .unwrap();
    store.external_push(&id, &actor()).await.unwrap();
    store.external_push(&id, &actor()).await.unwrap();
    write(&store, "/svc", "A", "rotated").await;
    store.external_push(&id, &actor()).await.unwrap();
    assert_eq!(
        fake.with(|f| f.gcp.get("app-A").cloned()),
        Some(vec![VALUE.to_owned(), "rotated".to_owned()])
    );
    let claims = fake.with(|f| f.gcp_assertions.last().cloned()).unwrap();
    assert_eq!(claims["iss"], "sync@proj-1.iam.gserviceaccount.com");
    assert_eq!(claims["aud"], format!("{address}/token"));
    assert!(!audit_text(&store).await.contains("rotated"));
}

#[tokio::test]
async fn target_settings_are_validated_before_anything_is_stored() {
    let store = PluginSecretStore::in_memory().unwrap();
    let cases = [
        json!({ "name": "a", "kind": "github-actions", "authMethod": "token", "credentials": { "token": "t" } }),
        json!({ "name": "b", "kind": "github-actions", "authMethod": "token", "repository": "no-slash", "credentials": { "token": "t" } }),
        json!({ "name": "c", "kind": "vercel", "authMethod": "token", "credentials": { "token": "t" } }),
        json!({ "name": "d", "kind": "vercel", "authMethod": "token", "projectId": "p", "vercelTargets": ["staging"], "credentials": { "token": "t" } }),
        json!({ "name": "e", "kind": "aws-secrets-manager", "authMethod": "access-key", "credentials": { "accessKeyId": "a", "secretAccessKey": "s" } }),
        json!({ "name": "f", "kind": "aws-secrets-manager", "authMethod": "token", "region": "us-east-1", "credentials": { "token": "t" } }),
        json!({ "name": "g", "kind": "aws-secrets-manager", "authMethod": "access-key", "region": "us-east-1", "credentials": { "accessKeyId": "a" } }),
        json!({ "name": "h", "kind": "gcp-secret-manager", "authMethod": "service-account", "projectId": "p", "credentials": { "serviceAccountKey": "{\"type\":\"user\"}" } }),
        json!({ "name": "i", "kind": "gcp-secret-manager", "authMethod": "token", "projectId": "p", "pathPrefix": "x", "credentials": { "token": "t" } }),
        json!({ "name": "j", "kind": "openbao", "address": "https://bao.example.com", "authMethod": "access-key", "credentials": { "accessKeyId": "a", "secretAccessKey": "s" } }),
    ];
    for case in cases {
        let name = case["name"].clone();
        assert!(
            create_store(&store, case).await.is_err(),
            "{name} was accepted"
        );
    }
    assert!(store.external_store_list().await.unwrap().is_empty());

    // Public API addresses are the default.
    let gh = create_store(
        &store,
        json!({
            "name": "gh", "kind": "github-actions", "authMethod": "token", "repository": "acme/app",
            "credentials": { "token": "t" },
        }),
    )
    .await
    .unwrap();
    assert_eq!(gh.address, "https://api.github.com");
    let aws = create_store(&store, json!({
        "name": "aws", "kind": "aws-secrets-manager", "authMethod": "access-key", "region": "eu-west-1",
        "credentials": { "accessKeyId": "a", "secretAccessKey": "s" },
    }))
    .await
    .unwrap();
    assert_eq!(
        aws.address,
        "https://secretsmanager.eu-west-1.amazonaws.com"
    );
    // Flat targets take a name prefix; AWS needs a secret name.
    assert!(destination(&store, &gh.id, "/ci", "nested/path")
        .await
        .is_err());
    assert!(destination(&store, &gh.id, "/ci", "1APP").await.is_err());
    assert!(destination(&store, &aws.id, "/ci", "").await.is_err());
    assert!(destination(&store, &gh.id, "/ci", "APP_").await.is_ok());
}

#[test]
fn github_names_and_sigv4_keys_follow_the_platform_rules() {
    use super::github::is_valid_secret_name;
    assert!(is_valid_secret_name("APP_TOKEN"));
    assert!(!is_valid_secret_name("GITHUB_TOKEN") && !is_valid_secret_name("github_x"));
    assert!(!is_valid_secret_name("9LIVES") && !is_valid_secret_name("A-B"));
    // AWS's published signing-key example.
    let key = super::aws::signing_key(
        "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        "20120215",
        "us-east-1",
        "iam",
    );
    assert_eq!(
        hex::encode(key),
        "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d"
    );
}

#[tokio::test]
async fn oversized_vercel_values_fail_before_any_request() {
    let store = PluginSecretStore::in_memory().unwrap();
    // Nothing listens on port 1: the push must fail on the value, not the network.
    let record = create_store(
        &store,
        json!({
            "name": "vc", "kind": "vercel", "address": "http://127.0.0.1:1", "authMethod": "token",
            "projectId": "prj_1", "credentials": { "token": "vc-1" },
        }),
    )
    .await
    .unwrap();
    let credentials = crate::vault::external::StoreCredentials {
        token: Some("vc-1".into()),
        ..Default::default()
    };
    let values = [("BIG".to_owned(), "x".repeat(64 * 1024 + 1))].into();
    let error = super::vercel::push(&record, &credentials, &values)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("larger than Vercel allows"));
    assert_eq!(
        super::vercel::push(&record, &credentials, &Default::default())
            .await
            .unwrap(),
        0
    );
}

#[test]
fn gcp_ids_and_service_account_keys_are_checked_without_echoing_them() {
    use super::gcp::{is_valid_secret_id, ServiceAccountKey};
    assert!(is_valid_secret_id("app-DB_URL"));
    assert!(
        !is_valid_secret_id("")
            && !is_valid_secret_id("a.b")
            && !is_valid_secret_id(&"a".repeat(256))
    );
    let key = |private_key: &str, token_uri: &str| {
        json!({
            "type": "service_account", "client_email": "a@b.iam.gserviceaccount.com",
            "private_key": private_key, "token_uri": token_uri,
        })
        .to_string()
    };
    let parsed =
        ServiceAccountKey::parse(&key(SA_PEM, "https://oauth2.googleapis.com/token")).unwrap();
    assert!(!format!("{parsed:?}").contains("PRIVATE KEY"));
    let bad_pem = ServiceAccountKey::parse(&key("not-a-key-secret", "")).unwrap_err();
    assert!(!bad_pem.to_string().contains("not-a-key-secret"));
    // The token exchange URL passes the same egress guard as store addresses.
    assert!(ServiceAccountKey::parse(&key(SA_PEM, "http://169.254.169.254/token")).is_err());
    assert!(ServiceAccountKey::parse("{not json").is_err());
}
