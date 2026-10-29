//! Session Box create, refusal, and label tests.

use super::*;

#[tokio::test]
async fn box_session_create_sends_size_desktop_and_labels_then_polls_after_202() {
    let created = r#"{"ok":true,"box":{"id":"bx_0123456789abcdef0123456789abcdef","status":"provisioning","size":"large"}}"#;
    let (base, captured) = fake_box(vec![(202, created), (200, created), (200, READY_BOX)]).await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let id = client
        .create_disposable(&session_spec(BoxSize::Large), "idem-session")
        .await
        .unwrap();
    assert_eq!(id.0, BOX_ID);
    let requests = captured.lock().unwrap().clone();
    assert_eq!(requests.len(), 3);
    let body = requests[0].json();
    assert_eq!(body["size"], "large");
    assert_eq!(body["type"], "large");
    assert_eq!(body["desktop"], true);
    assert_eq!(
        body["labels"],
        json!({"owner": "user-hash", "session": "conv-1"})
    );
    assert_eq!(body["network"], "egress");
    assert_eq!(body["ttlSeconds"], 14_400);
}

#[tokio::test]
async fn box_session_create_ignores_the_env_size() {
    let _env_lock = crate::box_backend::test_env::lock_box_env().await;
    struct Restore(Option<String>);
    impl Drop for Restore {
        fn drop(&mut self) {
            match &self.0 {
                Some(value) => std::env::set_var(crate::box_backend::ENV_BOX_SIZE, value),
                None => std::env::remove_var(crate::box_backend::ENV_BOX_SIZE),
            }
        }
    }
    let _restore = Restore(std::env::var(crate::box_backend::ENV_BOX_SIZE).ok());
    std::env::set_var(crate::box_backend::ENV_BOX_SIZE, "large");
    let (base, captured) = fake_box(vec![(201, READY_BOX), (200, READY_BOX)]).await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let mut spec = session_spec(BoxSize::Small);
    spec.labels.clear();
    spec.desktop = false;
    client.create_disposable(&spec, "idem").await.unwrap();
    let body = captured.lock().unwrap()[0].json();
    assert_eq!(body["size"], "small");
    assert_eq!(body["desktop"], false);
    assert!(body.get("labels").is_none());
}

#[tokio::test]
async fn box_session_capacity_503_with_retry_after_is_typed() {
    let (base, _captured) = fake_box_with_headers(vec![
        (
            503,
            "Retry-After: 30\r\n",
            r#"{"ok":false,"error":{"code":"capacity_unavailable","message":"no capacity"}}"#,
        ),
        (503, "Retry-After: 30\r\n", r#"{"ok":false}"#),
    ])
    .await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let error = client
        .create_disposable(&session_spec(BoxSize::Small), "idem")
        .await
        .unwrap_err();
    assert_eq!(error, BoxApiError::Capacity { retry_after: 30 });
    let error = client.resume(&workspace()).await.unwrap_err();
    assert_eq!(error, BoxApiError::Capacity { retry_after: 30 });
}

#[tokio::test]
async fn box_session_typed_refusals() {
    let (base, _captured) = fake_box(vec![
        (
            402,
            r#"{"ok":false,"error":{"code":"insufficient_credits","message":"top up"}}"#,
        ),
        (
            429,
            r#"{"ok":false,"error":{"code":"quota_exceeded","message":"limit"}}"#,
        ),
        (404, r#"{"ok":false,"error":{"code":"not_found"}}"#),
        (
            403,
            r#"{"ok":false,"error":{"code":"billing_owner_mismatch"}}"#,
        ),
    ])
    .await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    assert_eq!(
        client
            .create_disposable(&session_spec(BoxSize::Small), "idem")
            .await
            .unwrap_err(),
        BoxApiError::InsufficientCredits
    );
    assert_eq!(client.limits().await.unwrap_err(), BoxApiError::Quota);
    assert_eq!(
        client.status(&workspace()).await.unwrap_err(),
        BoxApiError::NotFound
    );
    assert_eq!(
        client
            .park(&workspace(), ParkReason::Idle)
            .await
            .unwrap_err(),
        BoxApiError::BillingOwnerMismatch
    );
}

#[tokio::test]
async fn box_session_create_rejects_invalid_labels_locally() {
    let client = BoxSessionClient::with_endpoint("http://127.0.0.1:9/v1", "box_token");
    let mut spec = session_spec(BoxSize::Small);
    spec.labels.insert("Bad Key".into(), "x".into());
    assert_eq!(
        client
            .create_disposable(&spec, "idem")
            .await
            .unwrap_err()
            .code(),
        "invalid_request"
    );
    let mut spec = session_spec(BoxSize::Small);
    spec.labels.insert("long".into(), "v".repeat(65));
    assert!(client.create_disposable(&spec, "idem").await.is_err());
    let mut spec = session_spec(BoxSize::Small);
    for index in 0..9 {
        spec.labels.insert(format!("k{index}"), "v".into());
    }
    assert!(client.create_disposable(&spec, "idem").await.is_err());
}

#[tokio::test]
async fn box_session_lifecycle_methods_hit_their_routes() {
    let provisioning = r#"{"ok":true,"type":"box.resumed","box":{"id":"bx_0123456789abcdef0123456789abcdef","status":"provisioning","size":"large"}}"#;
    let (base, captured) = fake_box(vec![
            (202, r#"{"ok":true,"status":"stopping"}"#),
            (202, provisioning),
            (200, READY_BOX),
            (200, READY_BOX),
            (
                200,
                r#"{"ok":true,"running":1,"maxRunning":3,"stored":2,"maxStored":20,"resourceUnits":4,"maxResourceUnits":6}"#,
            ),
        ])
        .await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    client
        .park(&workspace(), ParkReason::Balance)
        .await
        .unwrap();
    let resumed = client.resume(&workspace()).await.unwrap();
    assert_eq!(resumed.status, crate::box_types::BoxStatus::Ready);
    assert_eq!(resumed.size, BoxSize::Large);
    let view = client.status(&workspace()).await.unwrap();
    assert_eq!(view.desktop.unwrap().viewers, 1);
    assert_eq!(
        view.running_since.as_deref(),
        Some("2026-10-19T04:00:00.000Z")
    );
    assert_eq!(view.placement.unwrap()["serverType"], "cx43");
    let limits = client.limits().await.unwrap();
    assert_eq!(
        limits,
        BoxLimits {
            running: 1,
            max_running: 3,
            stored: 2,
            max_stored: 20,
        }
    );
    let requests = captured.lock().unwrap().clone();
    assert!(requests[0]
        .request_line()
        .starts_with(&format!("POST /v1/boxes/{BOX_ID}/stop ")));
    assert_eq!(requests[0].json(), json!({"reason": "balance"}));
    assert!(requests[1]
        .request_line()
        .starts_with(&format!("POST /v1/boxes/{BOX_ID}/resume ")));
    assert!(requests[2]
        .request_line()
        .starts_with(&format!("GET /v1/boxes/{BOX_ID} ")));
    assert!(requests[3]
        .request_line()
        .starts_with(&format!("GET /v1/boxes/{BOX_ID} ")));
    assert!(requests[4].request_line().starts_with("GET /v1/limits "));
}
