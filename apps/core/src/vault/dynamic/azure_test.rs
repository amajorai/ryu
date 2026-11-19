//! Azure provider tests against a scripted Entra ID and Microsoft Graph.

use super::*;
use crate::vault::dynamic::http::tests::{fake_api, Seen};

const APP_OBJECT: &str = "11111111-2222-3333-4444-555555555555";
const KEY_ID: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

fn config(base: &str) -> AzureConfig {
    AzureConfig {
        tenant_id: "contoso.onmicrosoft.com".into(),
        client_id: "99999999-8888-7777-6666-555555555555".into(),
        client_secret: "acting-app-secret".into(),
        application_object_id: APP_OBJECT.into(),
        environment: AzureEnvironment::Public,
        egress: TargetEgress::Trusted,
        endpoints: AzureEndpoints {
            login: Some(base.to_owned()),
            graph: Some(base.to_owned()),
        },
    }
}

fn entra(seen: &Seen) -> (u16, Value) {
    match (seen.method.as_str(), seen.path.as_str()) {
        ("POST", "/contoso.onmicrosoft.com/oauth2/v2.0/token") => {
            (200, json!({ "access_token": "graph-at" }))
        }
        ("GET", path) if path.starts_with("/v1.0/applications/") => {
            (200, json!({ "appId": "target-app-id" }))
        }
        ("POST", path) if path.ends_with("/addPassword") => (
            200,
            json!({ "keyId": KEY_ID, "secretText": "minted~secret", "endDateTime": "2026-11-09T12:00:00Z" }),
        ),
        ("POST", path) if path.ends_with("/removePassword") => (204, Value::Null),
        _ => (400, json!({ "error": { "message": "unexpected" } })),
    }
}

#[test]
fn validation_checks_ids() {
    let mut config = config("http://127.0.0.1:1");
    config.validate().unwrap();
    config.tenant_id = "11111111-2222-3333-4444-555555555555".into();
    config.validate().unwrap();
    config.tenant_id = "../evil".into();
    assert!(config.validate().is_err());
    config.tenant_id = "contoso.onmicrosoft.com".into();
    config.application_object_id = "not-a-guid".into();
    assert!(config.validate().is_err());
    let summary = config.summary().to_string();
    assert!(!summary.contains("acting-app-secret"), "{summary}");
}

#[tokio::test]
async fn secrets_are_added_with_an_end_date_and_removed_on_revoke() {
    let (base, log) = fake_api(entra).await;
    let config = config(&base);
    let issued = issue(&config, "ci-deploy", 3600).await.unwrap();
    assert_eq!(issued.data["clientId"], "target-app-id");
    assert_eq!(issued.data["clientSecret"], "minted~secret");
    assert_eq!(issued.data["tenantId"], "contoso.onmicrosoft.com");
    revoke(&config, &issued.revoke_data).await.unwrap();
    let log = log.lock().unwrap().clone();
    let grant: std::collections::HashMap<String, String> =
        url::form_urlencoded::parse(log[0].body.as_bytes())
            .into_owned()
            .collect();
    assert_eq!(grant["grant_type"], "client_credentials");
    assert_eq!(grant["scope"], "https://graph.microsoft.com/.default");
    assert_eq!(
        log[1].path,
        format!("/v1.0/applications/{APP_OBJECT}?$select=appId")
    );
    let added = log[2].json();
    assert!(added["passwordCredential"]["displayName"]
        .as_str()
        .unwrap()
        .starts_with("ryu-cideploy-"));
    let end = chrono::DateTime::parse_from_rfc3339(
        added["passwordCredential"]["endDateTime"].as_str().unwrap(),
    )
    .unwrap();
    let left = end.timestamp() - chrono::Utc::now().timestamp();
    assert!((3590..=3600).contains(&left), "{left}");
    assert_eq!(log[2].authorization.as_deref(), Some("Bearer graph-at"));
    assert_eq!(
        log[4].path,
        format!("/v1.0/applications/{APP_OBJECT}/removePassword")
    );
    assert_eq!(log[4].json(), json!({ "keyId": KEY_ID }));
}

#[tokio::test]
async fn token_failures_surface_the_entra_message() {
    let (base, _) = fake_api(|_| {
        (
            401,
            json!({ "error": "invalid_client", "error_description": "AADSTS7000215: Invalid client secret." }),
        )
    })
    .await;
    let error = issue(&config(&base), "x", 600)
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("AADSTS7000215"), "{error}");
    assert!(!error.contains("acting-app-secret"), "{error}");
}

#[tokio::test]
async fn malformed_key_ids_are_never_sent() {
    let (base, log) = fake_api(entra).await;
    assert!(revoke(&config(&base), &json!({ "keyId": "x\"}" }))
        .await
        .is_err());
    assert!(log.lock().unwrap().is_empty());
}
