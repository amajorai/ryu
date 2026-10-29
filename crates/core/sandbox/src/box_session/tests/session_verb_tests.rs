//! Session Box lifecycle, desktop, and credential tests.

use super::*;

#[tokio::test]
async fn box_session_resume_of_a_live_box_does_not_poll() {
    let (base, captured) = fake_box(vec![(200, READY_BOX)]).await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let view = client.resume(&workspace()).await.unwrap();
    assert!(view.status.is_live());
    assert_eq!(captured.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn box_session_resume_reports_a_waived_minimum() {
    const WAIVED: &str = r#"{"ok":true,"type":"box.resumed","box":{"id":"bx_0123456789abcdef0123456789abcdef","status":"ready","size":"small","runningSince":"2026-10-20T10:20:00.000Z","billing":{"minimumWaived":true,"paidHourEndsAt":"2026-10-20T11:00:00.000Z","waiver":"bw1.payload.signature"}}}"#;
    let (base, _captured) = fake_box(vec![(200, WAIVED)]).await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let view = client.resume(&workspace()).await.unwrap();
    assert!(view.minimum_waived());
    assert_eq!(
        view.minimum_waiver().as_deref(),
        Some("bw1.payload.signature")
    );
    // An older Box service says nothing: the minimum applies.
    let (base, _captured) = fake_box(vec![(200, READY_BOX)]).await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let older = client.resume(&workspace()).await.unwrap();
    assert!(!older.minimum_waived());
    assert_eq!(older.minimum_waiver(), None);
}

#[tokio::test]
async fn box_session_desktop_token_action_browser_credential_and_keepalive() {
    let token = r#"{"ok":true,"type":"access_token.created","token":"dt_secret","expiresAt":"2026-10-19T04:00:30.000Z","protocols":["ryu.desktop.v1","ryu.token.dt_secret"],"url":"wss://box.ryu.dev/v1/boxes/bx_0123456789abcdef0123456789abcdef/desktop/ws"}"#;
    let screenshot = r#"{"ok":true,"image":"iVBORw0KGgo=","width":1280,"height":800}"#;
    let tabs = r#"{"ok":true,"tabs":[{"id":"t1","url":"https://example.com"}]}"#;
    let (base, captured) = fake_box(vec![
        (201, token),
        (200, screenshot),
        (200, tabs),
        (204, ""),
        (200, r#"{"ok":true}"#),
    ])
    .await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let minted = client
        .mint_desktop_token(
            &workspace(),
            &DesktopTokenRequest {
                origin: "https://app.ryu.dev".into(),
                sub: "user-1".into(),
                view_only: true,
            },
        )
        .await
        .unwrap();
    assert_eq!(minted.token.expose_secret(), "dt_secret");
    assert_eq!(
        minted.url.as_deref(),
        Some("wss://box.ryu.dev/v1/boxes/bx_0123456789abcdef0123456789abcdef/desktop/ws")
    );
    assert_eq!(minted.protocols.len(), 2);
    assert!(!format!("{:?}", minted.token).contains("dt_secret"));

    let result = client
        .desktop_action(
            &workspace(),
            &json!({"action": "screenshot", "maxWidth": 1024}),
        )
        .await
        .unwrap();
    assert_eq!(result["width"], 1280);
    let result = client
        .browser_call(&workspace(), "tabs", &Value::Null)
        .await
        .unwrap();
    assert_eq!(result["tabs"][0]["id"], "t1");
    let key = format!("gwb1.{}.{}", "ab".repeat(8), "c".repeat(64));
    client
        .put_session_credential(
            &workspace(),
            &SessionCredential {
                gateway_url: "https://gateway.ryu.dev".into(),
                key: SecretString::new(key.clone()),
                expires_at: "2026-10-19T04:20:00.000Z".into(),
            },
        )
        .await
        .unwrap();
    client.keepalive(&workspace(), 42, 1_234).await.unwrap();

    let requests = captured.lock().unwrap().clone();
    assert!(requests[0]
        .request_line()
        .starts_with(&format!("POST /v1/boxes/{BOX_ID}/access-tokens ")));
    assert_eq!(
        requests[0].json(),
        json!({"scope": "desktop", "origin": "https://app.ryu.dev", "sub": "user-1", "viewOnly": true})
    );
    assert!(requests[1]
        .request_line()
        .starts_with(&format!("POST /v1/boxes/{BOX_ID}/desktop/actions ")));
    assert_eq!(
        requests[1].json(),
        json!({"action": "screenshot", "maxWidth": 1024})
    );
    assert!(requests[2]
        .request_line()
        .starts_with(&format!("POST /v1/boxes/{BOX_ID}/browser/tabs ")));
    assert_eq!(requests[2].json(), json!({}));
    assert!(requests[3]
        .request_line()
        .starts_with(&format!("PUT /v1/boxes/{BOX_ID}/session-credential ")));
    assert_eq!(
        requests[3].json(),
        json!({"gatewayUrl": "https://gateway.ryu.dev", "key": key, "expiresAt": "2026-10-19T04:20:00.000Z"})
    );
    assert!(requests[4]
        .request_line()
        .starts_with(&format!("POST /v1/boxes/{BOX_ID}/keepalive ")));
    assert_eq!(
        requests[4].json(),
        json!({"tickIndex": 42, "accruedMicroUsd": 1234})
    );
}

#[tokio::test]
async fn box_session_desktop_token_drops_relative_and_token_bearing_urls() {
    let relative = r#"{"token":"dt_1","expiresAt":"2026-10-19T04:00:30.000Z","protocols":["ryu.desktop.v1"],"url":"/v1/boxes/bx_0123456789abcdef0123456789abcdef/desktop/ws"}"#;
    let bearing = r#"{"token":"dt_2","expiresAt":"2026-10-19T04:00:30.000Z","protocols":["ryu.desktop.v1"],"url":"wss://box.ryu.dev/v1/boxes/x/desktop/ws?access_token=dt_2"}"#;
    let no_protocols = r#"{"token":"dt_3","expiresAt":"2026-10-19T04:00:30.000Z","protocols":[]}"#;
    let (base, _captured) =
        fake_box(vec![(201, relative), (201, bearing), (201, no_protocols)]).await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let request = DesktopTokenRequest {
        origin: "http://127.0.0.1:1420".into(),
        sub: "owner".into(),
        view_only: false,
    };
    assert_eq!(
        client
            .mint_desktop_token(&workspace(), &request)
            .await
            .unwrap()
            .url,
        None
    );
    assert_eq!(
        client
            .mint_desktop_token(&workspace(), &request)
            .await
            .unwrap()
            .url,
        None
    );
    assert_eq!(
        client
            .mint_desktop_token(&workspace(), &request)
            .await
            .unwrap_err()
            .code(),
        "invalid_response"
    );
}

#[tokio::test]
async fn box_session_session_methods_validate_locally() {
    let client = BoxSessionClient::with_endpoint("http://127.0.0.1:9/v1", "box_token");
    let bad_id = WorkspaceId("../bx".into());
    assert_eq!(
        client
            .park(&bad_id, ParkReason::User)
            .await
            .unwrap_err()
            .code(),
        "invalid_request"
    );
    assert!(client
        .desktop_action(&workspace(), &json!({"x": 1}))
        .await
        .is_err());
    assert!(client
        .browser_call(&workspace(), "../admin", &Value::Null)
        .await
        .is_err());
    assert!(client
        .browser_call(&workspace(), "navigate", &json!(["https://example.com"]))
        .await
        .is_err());
    let credential = SessionCredential {
        gateway_url: "https://gateway.ryu.dev".into(),
        key: SecretString::new("rgw_fleet_bearer"),
        expires_at: "2026-10-19T04:20:00.000Z".into(),
    };
    assert!(client
        .put_session_credential(&workspace(), &credential)
        .await
        .is_err());
    assert!(client
        .mint_desktop_token(
            &workspace(),
            &DesktopTokenRequest {
                origin: String::new(),
                sub: "u".into(),
                view_only: false,
            },
        )
        .await
        .is_err());
}

#[tokio::test]
async fn box_session_bearer_is_never_logged() {
    let secret = "rbx1.tenant-secret-payload.signature";
    let (base, _captured) = fake_box_with_headers(vec![
        (
            500,
            "",
            r#"{"ok":false,"error":{"code":"internal","message":"boom"}}"#,
        ),
        (503, "Retry-After: 12\r\n", r#"{"ok":false}"#),
    ])
    .await;
    let client = BoxSessionClient::with_endpoint(base, secret);
    let rendered = format!("{client:?}");
    assert!(!rendered.contains(secret), "{rendered}");
    let error = client.status(&workspace()).await.unwrap_err();
    assert!(!error.to_string().contains(secret));
    assert!(!format!("{error:?}").contains(secret));
    let error = client.keepalive(&workspace(), 1, 1).await.unwrap_err();
    assert_eq!(error, BoxApiError::Capacity { retry_after: 12 });
    let unreachable = BoxSessionClient::with_endpoint("http://127.0.0.1:9/v1", secret);
    let error = unreachable.limits().await.unwrap_err();
    assert_eq!(error.code(), "transport");
    assert!(!error.to_string().contains(secret));
}

#[tokio::test]
async fn box_session_resolve_uses_the_credential_source() {
    let credential = box_credential::BoxCredential {
        base: Url::parse("https://box.ryu.dev/v1/").unwrap(),
        token: SecretString::new("rbx1.core.sig"),
        public_base: Some(Url::parse("wss://box.ryu.dev").unwrap()),
        billing_owner: BillingOwner::CoreTick,
        expires_at: Some(4_000_000_000),
    };
    let client = BoxSessionClient::from_credential(&credential);
    assert_eq!(client.base, "https://box.ryu.dev/v1");
    assert_eq!(client.billing_owner(), BillingOwner::CoreTick);
    assert_eq!(
        client.public_base().map(Url::as_str),
        Some("wss://box.ryu.dev/")
    );
    assert!(!format!("{client:?}").contains("rbx1.core.sig"));
    let env_client = BoxSessionClient::with_endpoint("http://127.0.0.1:8090/v1/", "t");
    assert_eq!(env_client.base, "http://127.0.0.1:8090/v1");
    assert_eq!(env_client.billing_owner(), BillingOwner::None);
    assert!(env_client.public_base().is_none());
}
