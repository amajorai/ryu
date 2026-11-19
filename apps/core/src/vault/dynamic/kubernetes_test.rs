//! Kubernetes provider tests against a scripted API server.

use super::*;
use crate::vault::dynamic::http::tests::{fake_api, Seen};

fn config(host: &str) -> KubernetesConfig {
    KubernetesConfig {
        host: host.to_owned(),
        service_account_jwt: "ryu-admin-token".into(),
        ca_pem: None,
        namespace: "apps".into(),
        service_account_name: None,
        kubernetes_role_name: Some("reader".into()),
        kubernetes_role_type: KubernetesRoleType::Role,
        cluster_role_binding: false,
        audiences: vec![],
        username_prefix: None,
        egress: TargetEgress::Trusted,
    }
}

fn token_answer(seen: &Seen) -> (u16, Value) {
    if seen.path.ends_with("/token") {
        (
            201,
            json!({ "status": { "token": "minted.jwt", "expirationTimestamp": "2026-11-09T12:00:00Z" } }),
        )
    } else {
        (201, json!({}))
    }
}

#[test]
fn validation_requires_exactly_one_mode() {
    let mut config = config("https://k8s.example.com:6443");
    config.validate().unwrap();
    config.service_account_name = Some("ci".into());
    assert!(config.validate().is_err());
    config.kubernetes_role_name = None;
    config.validate().unwrap();
    config.namespace = "Bad_NS".into();
    assert!(config.validate().is_err());
    config.namespace = "apps".into();
    config.cluster_role_binding = true;
    assert!(
        config.validate().is_err(),
        "a cluster binding needs a ClusterRole"
    );
    config.kubernetes_role_type = KubernetesRoleType::ClusterRole;
    config.validate().unwrap();
    config.host = "http://k8s.example.com".into();
    assert!(config.validate().is_err());
    config.host = "https://k8s.example.com".into();
    config.ca_pem = Some("not pem".into());
    assert!(config.validate().is_err());
    let summary = config.summary().to_string();
    assert!(!summary.contains("ryu-admin-token"), "{summary}");
}

#[tokio::test]
async fn existing_accounts_get_a_token_with_a_ten_minute_floor() {
    let (base, log) = fake_api(token_answer).await;
    let mut config = config(&base);
    config.kubernetes_role_name = None;
    config.service_account_name = Some("ci".into());
    config.audiences = vec!["vault".into()];
    let issued = issue(&config, "ci", 60).await.unwrap();
    assert_eq!(issued.data["token"], "minted.jwt");
    assert_eq!(issued.data["serviceAccountName"], "ci");
    assert_eq!(issued.ttl_cap_secs, Some(600));
    assert_eq!(issued.revoke_data, Value::Null);
    let log = log.lock().unwrap().clone();
    assert_eq!(log.len(), 1);
    assert_eq!(
        log[0].path,
        "/api/v1/namespaces/apps/serviceaccounts/ci/token"
    );
    assert_eq!(
        log[0].authorization.as_deref(),
        Some("Bearer ryu-admin-token")
    );
    assert_eq!(log[0].json()["spec"]["expirationSeconds"], 600);
    assert_eq!(log[0].json()["spec"]["audiences"], json!(["vault"]));
    // Nothing to delete upstream.
    revoke(&config, &issued.revoke_data).await.unwrap();
}

#[tokio::test]
async fn generated_accounts_are_bound_and_deleted_on_revoke() {
    let (base, log) = fake_api(|seen| {
        if seen.method == "DELETE" && seen.path.contains("rolebindings") {
            (404, json!({ "message": "already gone" }))
        } else {
            token_answer(seen)
        }
    })
    .await;
    let config = config(&base);
    let issued = issue(&config, "web-reader", 3600).await.unwrap();
    let name = issued.data["serviceAccountName"].clone();
    assert!(name.starts_with("ryu-webreader-"), "{name}");
    assert_eq!(issued.ttl_cap_secs, Some(3600));
    revoke(&config, &issued.revoke_data).await.unwrap();
    let log = log.lock().unwrap().clone();
    let calls: Vec<(String, String)> = log
        .iter()
        .map(|seen| (seen.method.clone(), seen.path.clone()))
        .collect();
    assert_eq!(
        calls,
        [
            (
                "POST".into(),
                "/api/v1/namespaces/apps/serviceaccounts".into()
            ),
            (
                "POST".into(),
                "/apis/rbac.authorization.k8s.io/v1/namespaces/apps/rolebindings".into()
            ),
            (
                "POST".into(),
                format!("/api/v1/namespaces/apps/serviceaccounts/{name}/token")
            ),
            (
                "DELETE".into(),
                format!("/apis/rbac.authorization.k8s.io/v1/namespaces/apps/rolebindings/{name}")
            ),
            (
                "DELETE".into(),
                format!("/api/v1/namespaces/apps/serviceaccounts/{name}")
            ),
        ]
    );
    let binding = log[1].json();
    assert_eq!(binding["roleRef"]["kind"], "Role");
    assert_eq!(binding["roleRef"]["name"], "reader");
    assert_eq!(binding["subjects"][0]["name"], name.as_str());
    assert_eq!(binding["metadata"]["labels"][MANAGED_BY], "ryu");
}

#[tokio::test]
async fn a_failed_binding_removes_the_half_made_account() {
    let (base, log) = fake_api(|seen| {
        if seen.method == "POST" && seen.path.contains("clusterrolebindings") {
            (403, json!({ "message": "forbidden: cannot bind" }))
        } else {
            (200, json!({}))
        }
    })
    .await;
    let mut config = config(&base);
    config.kubernetes_role_type = KubernetesRoleType::ClusterRole;
    config.cluster_role_binding = true;
    let error = issue(&config, "admin", 600)
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("forbidden: cannot bind"), "{error}");
    assert!(error.contains("cleanup ran"), "{error}");
    let log = log.lock().unwrap().clone();
    assert_eq!(log.last().unwrap().method, "DELETE");
    assert!(log
        .last()
        .unwrap()
        .path
        .contains("/serviceaccounts/ryu-admin-"));
}

#[tokio::test]
async fn malformed_lease_accounts_are_never_deleted() {
    let (base, log) = fake_api(|_| (200, json!({}))).await;
    let config = config(&base);
    assert!(
        revoke(&config, &json!({ "serviceAccount": "../../secrets" }))
            .await
            .is_err()
    );
    assert!(log.lock().unwrap().is_empty());
}
