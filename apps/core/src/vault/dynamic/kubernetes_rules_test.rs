//! Generated-role Kubernetes provider tests against a scripted API server.

use super::*;
use crate::vault::dynamic::http::tests::{fake_api, Seen};

fn config(host: &str) -> KubernetesRulesConfig {
    KubernetesRulesConfig {
        host: host.to_owned(),
        service_account_jwt: "ryu-admin-token".into(),
        ca_pem: None,
        namespace: "apps".into(),
        rules: vec![json!({
            "apiGroups": [""],
            "resources": ["pods"],
            "verbs": ["get", "list"],
        })],
        kubernetes_role_type: KubernetesRoleType::Role,
        cluster_role_binding: false,
        audiences: vec![],
        username_prefix: None,
        egress: TargetEgress::Trusted,
    }
}

fn answer(seen: &Seen) -> (u16, Value) {
    if seen.path.ends_with("/token") {
        (
            201,
            json!({ "status": { "token": "minted.jwt", "expirationTimestamp": "2026-11-11T12:00:00Z" } }),
        )
    } else {
        (201, json!({}))
    }
}

#[test]
fn rules_are_validated() {
    let mut role = config("https://k8s.example.com");
    role.validate().unwrap();
    role.rules = vec![];
    assert!(role.validate().is_err());
    role.rules = vec![json!({ "resources": ["pods"] })];
    assert!(role.validate().is_err(), "verbs are required");
    role.rules = vec![json!({ "verbs": ["get"], "resources": "pods" })];
    assert!(role.validate().is_err(), "fields are lists");
    role.rules = vec![json!({ "verbs": ["get"], "resources": ["pods"], "extra": [] })];
    assert!(role.validate().is_err(), "unknown fields are refused");
    role.rules = vec![json!({ "verbs": ["get"], "nonResourceURLs": ["/healthz"] })];
    assert!(
        role.validate().is_err(),
        "non-resource URLs need a ClusterRole"
    );
    role.kubernetes_role_type = KubernetesRoleType::ClusterRole;
    role.validate().unwrap();
    role.namespace = "Bad_NS".into();
    assert!(role.validate().is_err(), "base checks still apply");
    let summary = config("https://k8s.example.com").summary().to_string();
    assert!(!summary.contains("ryu-admin-token"), "{summary}");
}

#[tokio::test]
async fn a_lease_generates_a_role_binds_an_account_and_cleans_up() {
    let (base, log) = fake_api(answer).await;
    let role = config(&base);
    let issued = issue(&role, "pod-reader", 900).await.unwrap();
    let generated = issued.data["generatedRoleName"].clone();
    let account = issued.data["serviceAccountName"].clone();
    assert!(generated.starts_with("ryu-role-podreader-"), "{generated}");
    assert_eq!(issued.data["token"], "minted.jwt");
    assert_eq!(issued.ttl_cap_secs, Some(900));
    revoke(&role, &issued.revoke_data).await.unwrap();
    let log = log.lock().unwrap().clone();
    let calls: Vec<(String, String)> = log
        .iter()
        .map(|seen| (seen.method.clone(), seen.path.clone()))
        .collect();
    let roles = "/apis/rbac.authorization.k8s.io/v1/namespaces/apps/roles";
    let bindings = "/apis/rbac.authorization.k8s.io/v1/namespaces/apps/rolebindings";
    assert_eq!(
        calls,
        [
            ("POST".into(), roles.to_owned()),
            (
                "POST".into(),
                "/api/v1/namespaces/apps/serviceaccounts".into()
            ),
            ("POST".into(), bindings.to_owned()),
            (
                "POST".into(),
                format!("/api/v1/namespaces/apps/serviceaccounts/{account}/token")
            ),
            ("DELETE".into(), format!("{bindings}/{account}")),
            (
                "DELETE".into(),
                format!("/api/v1/namespaces/apps/serviceaccounts/{account}")
            ),
            ("DELETE".into(), format!("{roles}/{generated}")),
        ]
    );
    assert_eq!(log[0].json()["kind"], "Role");
    assert_eq!(log[0].json()["rules"][0]["verbs"], json!(["get", "list"]));
    assert_eq!(log[2].json()["roleRef"]["name"], generated.as_str());
}

#[tokio::test]
async fn a_failed_account_removes_the_generated_cluster_role() {
    let (base, log) = fake_api(|seen| {
        if seen.method == "POST" && seen.path.ends_with("/serviceaccounts") {
            (403, json!({ "message": "forbidden" }))
        } else {
            (200, json!({}))
        }
    })
    .await;
    let mut role = config(&base);
    role.kubernetes_role_type = KubernetesRoleType::ClusterRole;
    let error = issue(&role, "ops", 600).await.err().unwrap().to_string();
    assert!(error.contains("forbidden"), "{error}");
    assert!(error.contains("generated role"), "{error}");
    let last = log.lock().unwrap().last().unwrap().clone();
    assert_eq!(last.method, "DELETE");
    assert!(last
        .path
        .starts_with("/apis/rbac.authorization.k8s.io/v1/clusterroles/ryu-role-ops-"));
}

#[tokio::test]
async fn malformed_lease_roles_are_never_deleted() {
    let (base, log) = fake_api(|_| (200, json!({}))).await;
    let role = config(&base);
    for record in [
        json!({ "serviceAccount": "ryu-a-b" }),
        json!({ "serviceAccount": "ryu-a-b", "generatedRole": "../secrets" }),
    ] {
        assert!(revoke(&role, &record).await.is_err(), "{record}");
    }
    assert!(log.lock().unwrap().is_empty());
}
