//! `GET /api/vault/sys/metrics`: counts by state, liveness by time, the
//! Prometheus text form, and the `read` on `sys/metrics` requirement.

use super::*;
use crate::server::vault_api::tests::{caller, ctx, node, parts};

#[tokio::test]
async fn counts_follow_state_and_time_and_render_as_prometheus() {
    let admin = ctx(None, None, true, Vec::new());
    for name in ["A", "B", "C"] {
        let (status, _) = parts(put_secret_with(&admin, name, json!({ "value": "v" })).await).await;
        assert_eq!(status, StatusCode::OK);
    }
    let body: DeleteSecretBody = serde_json::from_value(json!({})).unwrap();
    let (status, _) = parts(delete_secret_with(&admin, "C", body).await).await;
    assert_eq!(status, StatusCode::OK);
    let now = crate::vault::now_millis();
    {
        let conn = admin.store.conn.lock().await;
        let gauges = metrics_snapshot(&conn, now);
        let value = |name: &str, state: Option<&str>| {
            gauges
                .iter()
                .find(|gauge| {
                    gauge.name == name
                        && state.is_none_or(|state| gauge.labels.contains(&("state", state)))
                })
                .map(|gauge| gauge.value)
                .unwrap()
        };
        assert_eq!(value("ryu_vault_values", Some("active")), 2);
        assert_eq!(value("ryu_vault_values", Some("deleted")), 1);
        assert_eq!(value("ryu_vault_tokens_active", None), 0);
        assert!(value("ryu_vault_audit_rows", None) >= 4);

        let text = prometheus_text(&gauges);
        assert_eq!(text.matches("# TYPE ryu_vault_values gauge").count(), 1);
        assert!(
            text.contains("ryu_vault_values{state=\"active\"} 2\n"),
            "{text}"
        );
        assert!(
            text.contains("ryu_vault_values{state=\"deleted\"} 1\n"),
            "{text}"
        );
        assert!(text.contains("ryu_vault_policies 0\n"), "{text}");
        // Counts only: no value or name leaks into the exposition.
        assert!(!text.contains("\"A\"") && !text.contains(" v\n"));
    }

    let (status, body) = parts(vault_metrics_with(&admin, Some("prometheus")).await).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.starts_with("# HELP ryu_vault_values"), "{body}");
    let (status, body) = parts(vault_metrics_with(&admin, None).await).await;
    assert_eq!(status, StatusCode::OK);
    let json: Value = serde_json::from_str(&body).unwrap();
    assert!(json["metrics"].as_array().unwrap().iter().any(|metric| {
        metric["name"] == "ryu_vault_values"
            && metric["labels"]["state"] == "active"
            && metric["value"] == 2
    }));
    let (status, _) = parts(vault_metrics_with(&admin, Some("xml")).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_member_without_read_on_sys_metrics_is_refused() {
    let member = ctx(
        Some(node(NodeScope::Org, None, None)),
        Some(caller("user-1", OrgRole::Member, &[])),
        false,
        Vec::new(),
    );
    let (status, _) = parts(vault_metrics_with(&member, None).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let reader = ctx(
        Some(node(NodeScope::Org, None, None)),
        Some(caller("user-1", OrgRole::Member, &[])),
        false,
        vec![Policy {
            name: "metrics".into(),
            description: String::new(),
            rules: vec![PolicyRule {
                path: "sys/metrics".into(),
                capabilities: vec![Capability::Read],
                ..Default::default()
            }],
        }],
    );
    let (status, _) = parts(vault_metrics_with(&reader, None).await).await;
    assert_eq!(status, StatusCode::OK);
}

#[test]
fn a_store_without_the_tables_reads_as_zero() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    assert!(metrics_snapshot(&conn, 0)
        .iter()
        .all(|gauge| gauge.value == 0));
}

#[tokio::test]
async fn retry_leases_waiting_for_their_revoke_are_counted() {
    let admin = ctx(None, None, true, Vec::new());
    let pending = |gauges: &[Gauge]| {
        gauges
            .iter()
            .find(|gauge| gauge.name == "ryu_vault_leases_pending_revoke")
            .map(|gauge| gauge.value)
            .unwrap()
    };
    let now = crate::vault::now_millis();
    assert_eq!(pending(&metrics_snapshot(&*admin.store.conn.lock().await, now)), 0);
    admin
        .store
        .lease_record_for_revoke(
            crate::vault::leases::NewLease {
                role: "any",
                provider: "webhook",
                issued_to: None,
                ttl_secs: 0,
                max_ttl_secs: 0,
                renewable: false,
                revoke_data: &Value::Null,
            },
            None,
        )
        .await
        .unwrap();
    // Recorded already expired (`expires_at` is its creation time).
    let later = crate::vault::now_millis() + 1;
    let gauges = metrics_snapshot(&*admin.store.conn.lock().await, later);
    assert_eq!(pending(&gauges), 1);
    // So it is not a live lease.
    let live = gauges
        .iter()
        .find(|gauge| gauge.name == "ryu_vault_leases_active")
        .map(|gauge| gauge.value);
    assert_eq!(live, Some(0));
}
