//! Browser credential fills: the request bodies, the 404→409 mapping, the
//! echo details, local validation, and that no value reaches `Debug` or an
//! error.

use super::*;

const FILL_ID: &str = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const VALUE: &str = "hunter2-correct-horse";
const PREPARED: &str = r#"{"ok":true,"type":"browser.fill.prepared","fillId":"AbCdEfGhIjKlMnOpQrStUvWxYz012345","pageUrl":"https://example.com/login","tab":{"id":"t1","url":"https://example.com/login"}}"#;

fn target() -> BrowserFillTarget {
    BrowserFillTarget {
        element_ref: "@e3".into(),
        tab_id: Some("t1".into()),
        field: BrowserFillField::Password,
        page_hosts: vec!["example.com".into(), "www.example.com".into()],
        bind_hosts: vec!["example.com".into(), "www.example.com".into()],
        submit_urls: vec!["https://example.com/session".into()],
    }
}

fn placeholder(value: &str) -> BrowserFillValue {
    BrowserFillValue::Placeholder {
        value: SecretString::new(value),
        submit_urls: vec!["https://example.com/session".into()],
        unbound: false,
        ttl_seconds: DEFAULT_FILL_TTL_SECONDS,
        submit: true,
    }
}

#[tokio::test]
async fn prepare_sends_the_camel_case_target_and_reads_the_service_fill_id() {
    let (base, captured) = fake_box(vec![(201, PREPARED)]).await;
    let client = BoxSessionClient::with_endpoint(base.clone(), "box_token");
    assert_eq!(client.endpoint(), base);
    let prepared = client
        .browser_fill_prepare(&workspace(), &target())
        .await
        .unwrap();
    assert_eq!(prepared.fill_id, FILL_ID);
    assert_eq!(prepared.page_url, "https://example.com/login");
    assert_eq!(prepared.tab["id"], "t1");
    let requests = captured.lock().unwrap().clone();
    assert_eq!(
        requests[0].request_line(),
        format!("POST /v1/boxes/{BOX_ID}/browser-fills HTTP/1.1")
    );
    assert_eq!(
        requests[0].json(),
        json!({
            "ref": "@e3",
            "tabId": "t1",
            "field": "password",
            "pageHosts": ["example.com", "www.example.com"],
            "bindHosts": ["example.com", "www.example.com"],
            "submitUrls": ["https://example.com/session"],
        })
    );
}

#[tokio::test]
async fn a_prepare_404_reads_as_browser_fill_unsupported() {
    let (base, _) = fake_box(vec![(404, r#"{"error":{"code":"not_found"}}"#)]).await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let failure = client
        .browser_fill_prepare(&workspace(), &target())
        .await
        .unwrap_err();
    assert!(
        matches!(&failure.error, BoxApiError::Http { status: 409, code, .. } if code == BROWSER_FILL_UNSUPPORTED)
    );
    assert!(failure.box_cannot_fill());
}

#[tokio::test]
async fn an_echoed_refusal_keeps_its_hosts_and_fill_ids() {
    let body = r#"{"ok":false,"code":"browser_fill_echoed","error":{"code":"browser_fill_echoed","message":"This site echoed a filled value, so fills for it are blocked in this Box.","details":{"hosts":["example.com"],"fillIds":["Zyx-987_abc","../bad"]}}}"#;
    let (base, _) = fake_box(vec![(409, body)]).await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let failure = client
        .browser_fill_prepare(&workspace(), &target())
        .await
        .unwrap_err();
    assert_eq!(failure.code(), Some(BROWSER_FILL_ECHOED));
    assert!(failure.box_cannot_fill());
    assert_eq!(
        failure.echoed,
        Some(BrowserFillEchoed {
            hosts: vec!["example.com".into()],
            fill_ids: vec!["Zyx-987_abc".into()],
        })
    );
}

#[tokio::test]
async fn conflict_and_busy_are_not_an_unsafe_box() {
    let (base, _) = fake_box(vec![
        (
            409,
            r#"{"error":{"code":"conflict","message":"page refused"}}"#,
        ),
        (409, r#"{"error":{"code":"box_busy","message":"4 fills"}}"#),
    ])
    .await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    for _ in 0..2 {
        let failure = client
            .browser_fill_prepare(&workspace(), &target())
            .await
            .unwrap_err();
        assert!(!failure.box_cannot_fill());
        assert!(failure.echoed.is_none());
    }
}

#[tokio::test]
async fn a_malformed_prepare_answer_is_refused() {
    let (base, _) = fake_box(vec![(
        201,
        r#"{"ok":true,"fillId":"../x","pageUrl":"https://example.com/","tab":{}}"#,
    )])
    .await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let failure = client
        .browser_fill_prepare(&workspace(), &target())
        .await
        .unwrap_err();
    assert!(
        matches!(&failure.error, BoxApiError::Http { status: 502, code, .. } if code == "invalid_response")
    );
}

#[tokio::test]
async fn a_bad_target_or_id_is_refused_before_any_request() {
    let (base, captured) = fake_box(Vec::new()).await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let mut long_ref = target();
    long_ref.element_ref = "@".repeat(33);
    let mut three_pages = target();
    three_pages.page_hosts.push("evil.example".into());
    let mut no_bind = target();
    no_bind.bind_hosts.clear();
    for bad in [long_ref, three_pages, no_bind] {
        assert!(client
            .browser_fill_prepare(&workspace(), &bad)
            .await
            .is_err());
    }
    let other = WorkspaceId("bx_nope".into());
    assert!(client
        .browser_fill_prepare(&other, &target())
        .await
        .is_err());
    let too_long = "a".repeat(81);
    for fill_id in ["", "../escape", "a/b", too_long.as_str()] {
        assert!(client
            .browser_fill_commit(&workspace(), fill_id, &placeholder(VALUE))
            .await
            .is_err());
        assert!(client
            .browser_fill_status(&workspace(), fill_id)
            .await
            .is_err());
        assert!(client
            .browser_fill_cancel(&workspace(), fill_id)
            .await
            .is_err());
    }
    assert!(captured.lock().unwrap().is_empty());
}

#[tokio::test]
async fn commit_sends_placeholder_and_text_bodies() {
    let committed = r#"{"ok":true,"type":"browser.fill.committed","fillId":"AbCdEfGhIjKlMnOpQrStUvWxYz012345","filled":true,"protected":true,"tab":{"id":"t1"}}"#;
    let text = r#"{"ok":true,"type":"browser.fill.committed","fillId":"AbCdEfGhIjKlMnOpQrStUvWxYz012345","filled":true,"protected":false,"tab":{"id":"t1"}}"#;
    let (base, captured) = fake_box(vec![(200, committed), (200, text)]).await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let protected = client
        .browser_fill_commit(&workspace(), FILL_ID, &placeholder(VALUE))
        .await
        .unwrap();
    assert!(protected.filled && protected.protected);
    let plain = client
        .browser_fill_commit(
            &workspace(),
            FILL_ID,
            &BrowserFillValue::Text {
                value: SecretString::new("agent@example.com"),
                submit: false,
            },
        )
        .await
        .unwrap();
    assert!(plain.filled && !plain.protected);
    let requests = captured.lock().unwrap().clone();
    assert_eq!(
        requests[0].request_line(),
        format!("POST /v1/boxes/{BOX_ID}/browser-fills/{FILL_ID} HTTP/1.1")
    );
    assert_eq!(
        requests[0].json(),
        json!({
            "mode": "placeholder",
            "value": VALUE,
            "submitUrls": ["https://example.com/session"],
            "unbound": false,
            "ttlSeconds": 45,
            "submit": true,
        })
    );
    assert_eq!(
        requests[1].json(),
        json!({ "mode": "text", "value": "agent@example.com", "submit": false })
    );
}

#[tokio::test]
async fn no_value_reaches_debug_or_a_local_refusal() {
    let (base, captured) = fake_box(Vec::new()).await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    assert!(!format!("{:?}", placeholder(VALUE)).contains(VALUE));
    let text = BrowserFillValue::Text {
        value: SecretString::new(VALUE),
        submit: true,
    };
    assert!(!format!("{text:?}").contains(VALUE));
    let bad_values = [
        placeholder(&format!("{VALUE}\nsecond-line")),
        placeholder(&format!("{VALUE}__RYU_SECRET_x")),
        placeholder(&"x".repeat(1025)),
        BrowserFillValue::Placeholder {
            value: SecretString::new(VALUE),
            submit_urls: Vec::new(),
            unbound: false,
            ttl_seconds: 45,
            submit: false,
        },
        BrowserFillValue::Placeholder {
            value: SecretString::new(VALUE),
            submit_urls: Vec::new(),
            unbound: true,
            ttl_seconds: 61,
            submit: false,
        },
        BrowserFillValue::Text {
            value: SecretString::new(format!("{VALUE}\r")),
            submit: false,
        },
    ];
    for bad in &bad_values {
        let failure = client
            .browser_fill_commit(&workspace(), FILL_ID, bad)
            .await
            .unwrap_err();
        assert!(!failure.to_string().contains(VALUE));
        assert!(!format!("{failure:?}").contains(VALUE));
    }
    assert!(captured.lock().unwrap().is_empty());
}

#[tokio::test]
async fn status_reads_every_outcome_and_cancel_is_idempotent() {
    let (base, captured) = fake_box(vec![
        (
            200,
            r#"{"ok":true,"type":"browser.fill","fillId":"f1","state":"consumed","consumed":{"method":"POST","path":"/session"}}"#,
        ),
        (
            200,
            r#"{"ok":true,"type":"browser.fill","fillId":"f1","state":"echoed","echoed":{"host":"example.com","path":"/me"}}"#,
        ),
        (200, r#"{"ok":true,"state":"sideways"}"#),
        (204, ""),
        (404, r#"{"error":{"code":"not_found"}}"#),
        (503, r#"{"error":{"code":"driver_unavailable"}}"#),
    ])
    .await;
    let client = BoxSessionClient::with_endpoint(base, "box_token");
    let consumed = client
        .browser_fill_status(&workspace(), "f1")
        .await
        .unwrap();
    assert_eq!(consumed.state, BrowserFillState::Consumed);
    assert_eq!(consumed.consumed, Some(("POST".into(), "/session".into())));
    let echoed = client
        .browser_fill_status(&workspace(), "f1")
        .await
        .unwrap();
    assert_eq!(echoed.state, BrowserFillState::Echoed);
    assert_eq!(echoed.echoed, Some(("example.com".into(), "/me".into())));
    assert!(client
        .browser_fill_status(&workspace(), "f1")
        .await
        .is_err());
    client
        .browser_fill_cancel(&workspace(), "f1")
        .await
        .unwrap();
    client
        .browser_fill_cancel(&workspace(), "f1")
        .await
        .unwrap();
    assert!(client
        .browser_fill_cancel(&workspace(), "f1")
        .await
        .is_err());
    let requests = captured.lock().unwrap().clone();
    assert_eq!(
        requests[0].request_line(),
        format!("GET /v1/boxes/{BOX_ID}/browser-fills/f1 HTTP/1.1")
    );
    assert_eq!(
        requests[3].request_line(),
        format!("DELETE /v1/boxes/{BOX_ID}/browser-fills/f1 HTTP/1.1")
    );
}

#[test]
fn fields_and_states_round_trip_their_wire_names() {
    for field in [
        BrowserFillField::Username,
        BrowserFillField::Email,
        BrowserFillField::Password,
        BrowserFillField::Totp,
    ] {
        assert_eq!(BrowserFillField::parse(field.wire_name()), Some(field));
    }
    assert_eq!(
        crate::box_session::browser_fill_types::BrowserFillField::parse("Password"),
        None
    );
    assert_eq!(
        BrowserFillState::parse("revoked"),
        Some(BrowserFillState::Revoked)
    );
    assert!(is_browser_fill_id(FILL_ID));
    assert!(!is_browser_fill_id("a b"));
}
