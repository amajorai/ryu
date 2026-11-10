//! Payment-card placeholders on approved merchant requests.

use super::*;

async fn put_card(store: &PluginSecretStore, merchants: &[&str]) {
    put_card_with_cvc(store, merchants, Some("8317")).await;
}

async fn put_card_with_cvc(store: &PluginSecretStore, merchants: &[&str], cvc: Option<&str>) {
    use chrono::Datelike as _;
    let mut values = serde_json::json!({
        "cardholder": "Ada Lovelace",
        "number": "4242 4242 4242 4242",
        "expMonth": "12",
        "expYear": (chrono::Utc::now().year() + 2).to_string(),
    });
    if let Some(cvc) = cvc {
        values["cvc"] = serde_json::json!(cvc);
    }
    let input: crate::vault::items::ItemPut = serde_json::from_value(serde_json::json!({
        "kind": "card",
        "values": values,
        "merchants": merchants,
    }))
    .unwrap();
    store
        .item_put(
            "visa",
            input,
            &AuditActor::new("user", Some("u1")),
            crate::vault::items::PutAccess::FULL,
        )
        .await
        .unwrap();
}

const CARD_BODY: &str = r#"{"card":"__CARD_visa_NUMBER__","cvc":"__CARD_visa_CVC__","exp":"__CARD_visa_EXP_MONTH__/__CARD_visa_EXP_YEAR__"}"#;

fn card_post(host: &str, extra: &str) -> String {
    format!(
        "POST {host} HTTP/1.1\r\nHost: upstream\r\n{extra}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{CARD_BODY}",
        CARD_BODY.len()
    )
}

#[tokio::test]
async fn card_placeholders_substitute_only_on_approved_https_merchant_requests() {
    use crate::vault::items::cards::ApproveInput;
    let store = leak_store();
    put_card(store, &["localhost"]).await;
    let (upstream, upstream_ca, mut seen) = fake_tls_upstream().await;
    // No service covers the merchant: the card alone makes it intercepted
    // even though the environment denies unmatched hosts.
    let (token, session) = mint(store, &["svc"]).await;
    let config = BrokerConfig {
        extra_upstream_roots_pem: vec![upstream_ca],
        ..loopback_config()
    };
    let port = start(store, config).await;

    // First use: no approval yet, nothing is forwarded.
    let mut tls = intercepted_tls(store, port, upstream, &token).await;
    tls.write_all(card_post("/pay", "").as_bytes())
        .await
        .unwrap();
    let response = read_message(&mut tls).await;
    assert!(response.starts_with("HTTP/1.1 428"), "{response}");
    assert!(response.contains("card_approval_required"), "{response}");
    assert!(response.contains("\"last4\":\"4242\""), "{response}");
    assert!(!response.contains("4242424242424242"), "{response}");
    let approvals = store.card_approvals(None, None).await.unwrap();
    assert_eq!(approvals.len(), 1);
    let approval = &approvals[0];
    assert_eq!(approval.requester, format!("broker_session:{}", session.id));
    assert_eq!(approval.agent, "operator");
    assert!(response.contains(&approval.approve_path()), "{response}");
    assert!(seen.try_recv().is_err(), "nothing reached upstream");

    store
        .card_approve(
            &approval.id,
            &ApproveInput::default(),
            &AuditActor::new("user", Some("u1")),
            "user:u1",
        )
        .await
        .unwrap();
    let mut tls = intercepted_tls(store, port, upstream, &token).await;
    tls.write_all(card_post("/pay", "").as_bytes())
        .await
        .unwrap();
    let response = read_message(&mut tls).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let request = seen.recv().await.unwrap();
    let year = {
        use chrono::Datelike as _;
        chrono::Utc::now().year() + 2
    };
    assert!(
        request.contains(&format!(
            r#"{{"card":"4242424242424242","cvc":"8317","exp":"12/{year}"}}"#
        )),
        "{request}"
    );

    // The single-use approval is spent: the next use is pending again.
    let mut tls = intercepted_tls(store, port, upstream, &token).await;
    tls.write_all(card_post("/pay", "").as_bytes())
        .await
        .unwrap();
    let response = read_message(&mut tls).await;
    assert!(response.starts_with("HTTP/1.1 428"), "{response}");

    let rows = log_rows(store).await;
    let outcomes: Vec<&str> = rows.iter().map(|row| row.outcome.as_str()).collect();
    assert!(outcomes.contains(&"card_approval_required"), "{outcomes:?}");
    assert!(!serde_json::to_string(&rows)
        .unwrap()
        .contains("4242424242424242"));
}

#[tokio::test]
async fn a_placeholder_for_a_missing_card_field_is_refused_and_refunded() {
    use crate::vault::items::cards::ApproveInput;
    let store = leak_store();
    // The security code is optional and this card stores none.
    put_card_with_cvc(store, &["localhost"], None).await;
    let (upstream, upstream_ca, mut seen) = fake_tls_upstream().await;
    let (token, _) = mint(store, &["svc"]).await;
    let config = BrokerConfig {
        extra_upstream_roots_pem: vec![upstream_ca],
        ..loopback_config()
    };
    let port = start(store, config).await;
    let mut tls = intercepted_tls(store, port, upstream, &token).await;
    tls.write_all(card_post("/pay", "").as_bytes())
        .await
        .unwrap();
    let response = read_message(&mut tls).await;
    assert!(response.starts_with("HTTP/1.1 428"), "{response}");
    let approvals = store.card_approvals(None, None).await.unwrap();
    store
        .card_approve(
            &approvals[0].id,
            &ApproveInput::default(),
            &AuditActor::new("user", Some("u1")),
            "user:u1",
        )
        .await
        .unwrap();

    // The request asks for the missing code: refused before sending, the
    // literal placeholder never leaves, and the one-use approval survives.
    let mut tls = intercepted_tls(store, port, upstream, &token).await;
    tls.write_all(card_post("/pay", "").as_bytes())
        .await
        .unwrap();
    let response = read_message(&mut tls).await;
    assert!(response.starts_with("HTTP/1.1 409"), "{response}");
    assert!(response.contains("card_field_missing"), "{response}");
    assert!(!response.contains("4242424242424242"), "{response}");
    assert!(seen.try_recv().is_err(), "nothing reached upstream");

    // The refunded approval still covers a request that needs no code.
    let body = r#"{"card":"__CARD_visa_NUMBER__"}"#;
    let mut tls = intercepted_tls(store, port, upstream, &token).await;
    tls.write_all(
        format!(
            "POST /pay HTTP/1.1\r\nHost: upstream\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    let response = read_message(&mut tls).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(seen
        .recv()
        .await
        .unwrap()
        .contains(r#"{"card":"4242424242424242"}"#));
}

#[tokio::test]
async fn card_placeholders_stay_untouched_off_the_merchant_allowlist_or_over_http() {
    let store = leak_store();
    put_card(store, &["localhost"]).await;
    let (upstream, mut seen) = fake_http_upstream().await;
    let (token, _) = mint(store, &["svc"]).await;
    let port = start(store, loopback_config()).await;
    let auth = format!("Proxy-Authorization: Bearer {token}\r\n");

    // Plain HTTP to the merchant: nothing is substituted, so under `deny`
    // the merchant entry does not open egress to the host.
    let response = send_raw(
        port,
        card_post(&format!("http://localhost:{upstream}/pay"), &auth),
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 403"), "{response}");
    assert!(response.contains("denies unmatched hosts"), "{response}");
    assert!(seen.try_recv().is_err(), "nothing reached upstream");

    // Another host (passthrough): untouched as well.
    {
        let conn = store.conn.lock().await;
        settings::put(&conn, "default", UnmatchedHostPolicy::Passthrough, "").unwrap();
    }
    let response = send_raw(
        port,
        card_post(&format!("http://127.0.0.1:{upstream}/pay"), &auth),
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let request = seen.recv().await.unwrap();
    assert!(request.contains(CARD_BODY), "{request}");

    // Both were recorded as blocked uses, and no approval was filed.
    assert!(store.card_approvals(None, None).await.unwrap().is_empty());
    let coords = crate::vault::items::ItemCoords::new(None, None, "visa").unwrap();
    let events = store
        .item_events(
            &coords,
            0,
            100,
            0,
            crate::vault::items::EventScope::CurrentItem,
        )
        .await
        .unwrap();
    let blocked: Vec<_> = events
        .iter()
        .filter(|event| event.name == "card_use_blocked")
        .map(|event| event.data["reason"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(blocked, vec!["insecure_scheme", "merchant_not_allowed"]);
}

async fn blocked_reasons(store: &PluginSecretStore) -> Vec<String> {
    let coords = crate::vault::items::ItemCoords::new(None, None, "visa").unwrap();
    store
        .item_events(
            &coords,
            0,
            100,
            0,
            crate::vault::items::EventScope::CurrentItem,
        )
        .await
        .unwrap()
        .iter()
        .filter(|event| event.name == "card_use_blocked")
        .map(|event| event.data["reason"].as_str().unwrap_or_default().to_owned())
        .collect()
}

#[tokio::test]
async fn sessions_use_only_cards_their_minter_may_use() {
    let store = leak_store();
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    put_card(store, &["localhost"]).await;
    let (upstream, upstream_ca, mut seen) = fake_tls_upstream().await;
    // A service covers the upstream, so the request is intercepted for it.
    add_service(
        store,
        test_service("shop", "localhost", Some(upstream), "/"),
    )
    .await;
    // A member with no capability on the card minted this session.
    let member = MinterScope {
        subjects: vec!["user:u2".into()],
        manager: false,
    };
    let (token, _) = mint_as(store, &["shop"], "user:u2", member).await;
    let (other_upstream, _, _) = fake_tls_upstream().await;
    let config = BrokerConfig {
        extra_upstream_roots_pem: vec![upstream_ca],
        ..loopback_config()
    };
    let port = start(store, config).await;

    let mut tls = intercepted_tls(store, port, upstream, &token).await;
    tls.write_all(card_post("/pay", "").as_bytes())
        .await
        .unwrap();
    let response = read_message(&mut tls).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let request = seen.recv().await.unwrap();
    assert!(request.contains(CARD_BODY), "{request}");
    assert!(!request.contains("4242424242424242"), "{request}");
    assert!(store.card_approvals(None, None).await.unwrap().is_empty());
    assert_eq!(blocked_reasons(store).await, vec!["denied"]);

    // The card's merchant host does not open egress under `deny` for a
    // session that may not use the card.
    let connect = format!(
        "CONNECT localhost:{other_upstream} HTTP/1.1\r\nHost: localhost\r\nProxy-Authorization: Bearer {token}\r\n\r\n"
    );
    let denied = send_raw(port, connect).await;
    assert!(denied.starts_with("HTTP/1.1 403"), "{denied}");
}

#[tokio::test]
async fn an_unreachable_merchant_does_not_spend_the_approval() {
    use crate::vault::items::cards::{ApprovalStatus, ApproveInput};
    let store = leak_store();
    put_card(store, &["localhost"]).await;
    let closed = {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap().port()
    };
    let (token, _) = mint(store, &["svc"]).await;
    let port = start(store, loopback_config()).await;

    let mut tls = intercepted_tls(store, port, closed, &token).await;
    tls.write_all(card_post("/pay", "").as_bytes())
        .await
        .unwrap();
    let response = read_message(&mut tls).await;
    assert!(response.starts_with("HTTP/1.1 428"), "{response}");
    let id = store.card_approvals(None, None).await.unwrap()[0]
        .id
        .clone();
    store
        .card_approve(
            &id,
            &ApproveInput::default(),
            &AuditActor::new("user", Some("u1")),
            "user:u1",
        )
        .await
        .unwrap();

    let mut tls = intercepted_tls(store, port, closed, &token).await;
    tls.write_all(card_post("/pay", "").as_bytes())
        .await
        .unwrap();
    let response = read_message(&mut tls).await;
    assert!(response.starts_with("HTTP/1.1 502"), "{response}");
    let approval = store.card_approval(&id).await.unwrap().unwrap();
    assert_eq!(
        (approval.status, approval.uses),
        (ApprovalStatus::Approved, 0)
    );
}

#[tokio::test]
async fn a_card_without_merchants_records_a_blocked_use() {
    let store = leak_store();
    put_card(store, &[]).await;
    let (upstream, mut seen) = fake_http_upstream().await;
    {
        let conn = store.conn.lock().await;
        settings::put(&conn, "default", UnmatchedHostPolicy::Passthrough, "").unwrap();
    }
    let (token, _) = mint(store, &["svc"]).await;
    let port = start(store, loopback_config()).await;
    let auth = format!("Proxy-Authorization: Bearer {token}\r\n");
    let response = send_raw(
        port,
        card_post(&format!("http://127.0.0.1:{upstream}/pay"), &auth),
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(seen.recv().await.unwrap().contains(CARD_BODY));
    assert_eq!(blocked_reasons(store).await, vec!["no_merchants"]);
}
