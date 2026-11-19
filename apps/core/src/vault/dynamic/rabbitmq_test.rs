//! RabbitMQ provider tests against a scripted management API.

use super::*;
use crate::vault::dynamic::http::tests::fake_api;

fn config(base: &str) -> RabbitMqConfig {
    RabbitMqConfig {
        connection_uri: base.to_owned(),
        username: "admin".into(),
        password: "admin-pw".into(),
        ca_pem: None,
        tags: "management".into(),
        vhosts: BTreeMap::from([(
            "/".to_owned(),
            VhostPermission {
                configure: String::new(),
                write: "^orders$".into(),
                read: ".*".into(),
            },
        )]),
        vhost_topics: BTreeMap::from([(
            "/".to_owned(),
            BTreeMap::from([(
                "amq.topic".to_owned(),
                TopicPermission {
                    write: "^orders\\.".into(),
                    read: ".*".into(),
                },
            )]),
        )]),
        username_prefix: None,
        egress: TargetEgress::Trusted,
    }
}

#[test]
fn validation_checks_the_target_and_grants() {
    let mut role = config("https://rabbit.example.com:15671");
    role.validate().unwrap();
    role.connection_uri = "http://rabbit.example.com".into();
    assert!(role.validate().is_err());
    role.connection_uri = "https://rabbit.example.com".into();
    role.vhosts.clear();
    assert!(role.validate().is_err());
    let mut role = config("https://rabbit.example.com");
    role.tags = "administrator\nx".into();
    assert!(role.validate().is_err());
    let summary = config("https://rabbit.example.com").summary().to_string();
    assert!(!summary.contains("admin-pw"), "{summary}");
    assert_eq!(segment("/"), "%2F");
    assert_eq!(segment("a b"), "a%20b");
}

#[tokio::test]
async fn a_lease_is_a_user_with_vhost_and_topic_permissions() {
    let (base, log) = fake_api(|_| (201, Value::Null)).await;
    let config = config(&base);
    let issued = issue(&config, "orders").await.unwrap();
    let name = issued.data["username"].clone();
    assert!(name.starts_with("ryu_orders_"), "{name}");
    assert_eq!(issued.data["password"].len(), 36);
    revoke(&config, &issued.revoke_data).await.unwrap();
    let log = log.lock().unwrap().clone();
    let calls: Vec<(String, String)> = log
        .iter()
        .map(|seen| (seen.method.clone(), seen.path.clone()))
        .collect();
    assert_eq!(
        calls,
        [
            ("PUT".into(), format!("/api/users/{name}")),
            ("PUT".into(), format!("/api/permissions/%2F/{name}")),
            ("PUT".into(), format!("/api/topic-permissions/%2F/{name}")),
            ("DELETE".into(), format!("/api/users/{name}")),
        ]
    );
    let expected = format!("Basic {}", B64.encode("admin:admin-pw"));
    assert_eq!(log[0].authorization.as_deref(), Some(expected.as_str()));
    assert_eq!(log[0].json()["password"], issued.data["password"].as_str());
    assert_eq!(log[0].json()["tags"], "management");
    assert_eq!(log[1].json()["write"], "^orders$");
    assert_eq!(log[2].json()["exchange"], "amq.topic");
}

#[tokio::test]
async fn a_failed_grant_deletes_the_half_made_user() {
    let (base, log) = fake_api(|seen| {
        if seen.path.starts_with("/api/permissions/") {
            (400, json!({ "error": "bad_request", "reason": "no vhost" }))
        } else {
            (204, Value::Null)
        }
    })
    .await;
    let error = issue(&config(&base), "orders")
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("returned 400"), "{error}");
    assert!(error.contains("cleanup ran"), "{error}");
    assert_eq!(log.lock().unwrap().last().unwrap().method, "DELETE");
}

#[tokio::test]
async fn revocation_tolerates_a_gone_user_and_refuses_bad_records() {
    let (base, log) = fake_api(|_| (404, json!({ "error": "Object Not Found" }))).await;
    let config = config(&base);
    revoke(&config, &json!({ "username": "ryu_orders_abc" }))
        .await
        .unwrap();
    assert!(revoke(&config, &json!({ "username": "guest/../x" }))
        .await
        .is_err());
    assert_eq!(log.lock().unwrap().len(), 1);
}
