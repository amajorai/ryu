use serde_json::{json, Value};

use super::*;
use crate::vault::items::{ItemPatch, ItemPut, PutAccess};

const PAN: &str = "4242 4242 4242 4242";
const PAN_DIGITS: &str = "4242424242424242";
const CVC: &str = "8317";

fn actor() -> AuditActor {
    AuditActor::new("user", Some("u1"))
}

fn future_year() -> String {
    use chrono::Datelike as _;
    (chrono::Utc::now().year() + 2).to_string()
}

fn card_put(merchants: &[&str]) -> ItemPut {
    serde_json::from_value(json!({
        "kind": "card",
        "values": {
            "cardholder": "Ada Lovelace",
            "number": PAN,
            "expMonth": "7",
            "expYear": future_year(),
            "cvc": CVC,
            "postalCode": "94107",
            "country": "us",
        },
        "merchants": merchants,
    }))
    .unwrap()
}

fn coords(key: &str) -> ItemCoords {
    ItemCoords::new(None, None, key).unwrap()
}

async fn store_with_card(merchants: &[&str]) -> PluginSecretStore {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .item_put("visa", card_put(merchants), &actor(), PutAccess::FULL)
        .await
        .unwrap();
    store
}

fn broker_use(host: &str, session: &str) -> CardUseRequest {
    CardUseRequest {
        coords: coords("visa"),
        channel: CardChannel::Broker,
        merchant_host: host.to_owned(),
        requester: format!("broker_session:{session}"),
        agent: "machine:m1".to_owned(),
        actor: AuditActor::new("broker_session", Some(session)),
    }
}

fn code(error: &anyhow::Error) -> &'static str {
    error
        .downcast_ref::<VaultError>()
        .expect("typed vault error")
        .code()
}

/// Every string anywhere in `value`.
fn strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) => out.push(text.clone()),
        Value::Array(items) => items.iter().for_each(|item| strings(item, out)),
        Value::Object(map) => map.values().for_each(|item| strings(item, out)),
        _ => {}
    }
}

fn assert_no_card_secret(value: &Value) {
    let text = value.to_string();
    assert!(!text.contains(PAN_DIGITS), "PAN leaked: {text}");
    assert!(!text.contains(PAN), "PAN leaked: {text}");
    let mut all = Vec::new();
    strings(value, &mut all);
    assert!(!all.iter().any(|s| s == CVC), "CVC leaked: {text}");
}

async fn pending_id(store: &PluginSecretStore, request: &CardUseRequest) -> String {
    match store.card_use(request, None).await.unwrap() {
        CardUseOutcome::Pending(approval) => approval.id,
        other => panic!("expected a pending approval, got {other:?}"),
    }
}

#[test]
fn luhn_brand_and_number_rules() {
    assert!(luhn_valid(PAN_DIGITS));
    assert!(!luhn_valid("4242424242424241"));
    assert_eq!(
        normalize_card_number("4242-4242 4242-4242").unwrap(),
        PAN_DIGITS
    );
    for bad in [
        "4242424242424241",
        "42424242424",
        "4242a42424242424",
        "",
        &"4".repeat(20),
    ] {
        let error = normalize_card_number(bad).unwrap_err();
        assert!(
            !error.to_string().contains(bad) || bad.is_empty(),
            "{error}"
        );
    }
    for (number, brand) in [
        ("4242424242424242", "visa"),
        ("5555555555554444", "mastercard"),
        ("2223003122003222", "mastercard"),
        ("378282246310005", "amex"),
        ("6011111111111117", "discover"),
        ("3530111333300000", "jcb"),
        ("30569309025904", "diners"),
        ("6200000000000005", "unionpay"),
        ("9999999999999995", "unknown"),
    ] {
        assert_eq!(card_brand(number), brand, "{number}");
    }
    assert_eq!(last4(PAN_DIGITS), "4242");
}

#[test]
fn field_and_expiry_rules() {
    let fields = card_fields();
    let def = |name: &str| {
        fields
            .iter()
            .find(|field| field.name == name)
            .unwrap()
            .clone()
    };
    assert!(def("number").sensitive && def("cvc").sensitive);
    assert!(!def("expMonth").sensitive && !def("cardholder").sensitive);
    assert_eq!(normalize_card_value(&def("expMonth"), "7").unwrap(), "07");
    assert!(normalize_card_value(&def("expMonth"), "13").is_err());
    assert!(normalize_card_value(&def("expMonth"), "007").is_err());
    assert_eq!(normalize_card_value(&def("expYear"), "31").unwrap(), "2031");
    assert_eq!(
        normalize_card_value(&def("expYear"), "2031").unwrap(),
        "2031"
    );
    assert!(normalize_card_value(&def("expYear"), "1999").is_err());
    assert!(normalize_card_value(&def("cvc"), "12").is_err());
    assert!(normalize_card_value(&def("cvc"), "12345").is_err());
    assert_eq!(normalize_card_value(&def("country"), "gb").unwrap(), "GB");
    // 2024-03-15 UTC.
    let march_2024 = 1_710_460_800_000;
    assert!(is_expired("02", "2024", march_2024));
    assert!(
        !is_expired("03", "2024", march_2024),
        "valid through its month"
    );
    assert!(check_new_expiry("01", "2024", march_2024).is_err());
    assert!(check_new_expiry("12", "2099", march_2024).is_err());
    assert!(check_new_expiry("12", "2027", march_2024).is_ok());
}

#[test]
fn placeholders_and_keys_follow_the_grammar() {
    for ok in ["visa", "corp-amex", "a_b", "A1"] {
        assert!(is_valid_card_key(ok), "{ok}");
    }
    for bad in ["", "_a", "a_", "a__b", "a.b", &"a".repeat(41)] {
        assert!(!is_valid_card_key(bad), "{bad}");
    }
    let parsed = parse_placeholder("__CARD_corp_visa_EXP_MONTH__").unwrap();
    assert_eq!(
        (parsed.key.as_str(), parsed.field),
        ("corp_visa", "expMonth")
    );
    assert_eq!(
        parse_placeholder("__CARD_visa_NAME__").unwrap().field,
        "cardholder"
    );
    assert!(parse_placeholder("__CARD_visa_PIN__").is_none());
    assert!(parse_placeholder("__OPENAI_KEY__").is_none());
    let mut found = Vec::new();
    find_placeholders(
        r#"{"n":"__CARD_visa_NUMBER__","c":"__CARD_visa_CVC__","x":"__CARD_","k":"__KEY__"}"#,
        &mut found,
    );
    let fields: Vec<_> = found.iter().map(|p| p.field).collect();
    assert_eq!(fields, vec!["number", "cvc"]);
    for (_, field) in PLACEHOLDER_FIELDS {
        let token = placeholder_for("visa", field).unwrap();
        assert!(
            crate::vault::broker::substitute::is_valid_placeholder(&token),
            "{token}"
        );
        assert_eq!(parse_placeholder(&token).unwrap().field, field);
    }
    let merchants =
        normalize_merchants(&["Shop.Example.com".into(), "*.pay.example".into()]).unwrap();
    assert_eq!(merchants, vec!["*.pay.example", "shop.example.com"]);
    assert!(merchant_allows(&merchants, "checkout.pay.example"));
    assert!(!merchant_allows(&merchants, "pay.example"));
    assert!(!merchant_allows(&merchants, "evil.example.com"));
    assert!(normalize_merchants(&["https://shop.example.com".into()]).is_err());
}

#[tokio::test]
async fn cards_store_brand_and_last4_and_never_expose_the_number() {
    let store = store_with_card(&["shop.example.com"]).await;
    let view = store.item_get(&coords("visa"), true).await.unwrap();
    let card = view.card.clone().unwrap();
    assert_eq!(card.brand.as_deref(), Some("visa"));
    assert_eq!(card.last4.as_deref(), Some("4242"));
    assert_eq!(card.exp_month.as_deref(), Some("07"));
    assert_eq!(card.placeholders["number"], "__CARD_visa_NUMBER__");
    assert_eq!(view.status, ItemStatus::Ready);
    let view = serde_json::to_value(&view).unwrap();
    assert_no_card_secret(&view);
    assert_eq!(view["fields"][0]["value"], "Ada Lovelace");

    let listed = serde_json::to_value(store.item_list(None, None).await.unwrap()).unwrap();
    assert_no_card_secret(&listed);
    assert_eq!(listed[0]["card"]["last4"], "4242");

    // A PUT never confirms the number or CVC, even when they match; without
    // them an identical PUT is unchanged. Different merchants conflict.
    let error = store
        .item_put(
            "visa",
            card_put(&["shop.example.com"]),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_conflict");
    let mut without_secrets = card_put(&["shop.example.com"]);
    without_secrets.values.remove("number");
    without_secrets.values.remove("cvc");
    store
        .item_put("visa", without_secrets, &actor(), PutAccess::FULL)
        .await
        .unwrap();
    let error = store
        .item_put(
            "visa",
            card_put(&["other.example"]),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_conflict");

    // The plain reveal path refuses the number and CVC.
    let error = store
        .item_reveal(&coords("visa"), "number", &actor())
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_denied");
    assert_eq!(
        store
            .item_reveal(&coords("visa"), "postalCode", &actor())
            .await
            .unwrap(),
        "94107"
    );

    // Run a full use cycle, then scan everything a human or agent can see.
    let request = broker_use("shop.example.com", "s1");
    let id = pending_id(&store, &request).await;
    store
        .card_approve(&id, &ApproveInput::default(), &actor(), "user:u1")
        .await
        .unwrap();
    assert!(matches!(
        store.card_use(&request, None).await.unwrap(),
        CardUseOutcome::Granted { .. }
    ));
    store
        .card_use(&broker_use("evil.example", "s1"), None)
        .await
        .unwrap();
    let events = store
        .item_events(
            &coords("visa"),
            0,
            500,
            0,
            crate::vault::items::EventScope::History,
        )
        .await
        .unwrap();
    let names: Vec<_> = events.iter().map(|event| event.name.as_str()).collect();
    for expected in [
        "created",
        "card_approval_requested",
        "card_approval_approved",
        "card_used",
        "card_use_blocked",
    ] {
        assert!(names.contains(&expected), "{names:?}");
    }
    assert_no_card_secret(&serde_json::to_value(&events).unwrap());
    let approvals = store.card_approvals(None, None).await.unwrap();
    assert_no_card_secret(&serde_json::to_value(&approvals).unwrap());

    // No plaintext PAN in any text column of any table (audit included).
    let conn = store.conn.lock().await;
    let tables: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .unwrap();
        let rows = stmt.query_map([], |row| row.get(0)).unwrap();
        rows.collect::<rusqlite::Result<_>>().unwrap()
    };
    let mut audit_actions = Vec::new();
    for table in tables {
        let mut stmt = conn.prepare(&format!("SELECT * FROM \"{table}\"")).unwrap();
        let columns = stmt.column_count();
        let mut rows = stmt.query([]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            for index in 0..columns {
                if let Ok(Some(text)) = row.get::<_, Option<String>>(index) {
                    assert!(!text.contains(PAN_DIGITS), "PAN in {table}: {text}");
                }
            }
        }
        if table == "vault_audit" {
            let mut stmt = conn
                .prepare("SELECT action, details FROM vault_audit")
                .unwrap();
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .unwrap();
            for row in rows {
                let (action, details) = row.unwrap();
                let details: Value = serde_json::from_str(&details).unwrap_or(Value::Null);
                assert_no_card_secret(&details);
                if action.starts_with("card.") {
                    // New audit rows carry the approval id, never card details.
                    for detail in ["last4", "brand", "merchant", "requester", "grantSubject"] {
                        assert!(
                            details["details"].get(detail).is_none(),
                            "{action}: {details}"
                        );
                    }
                    // Nor the (sealed) requester or agent subjects.
                    assert!(
                        !details.to_string().contains("machine:m1"),
                        "{action}: {details}"
                    );
                    assert!(!details.to_string().contains("shop.example.com"));
                }
                audit_actions.push(action);
            }
        }
    }
    assert!(
        audit_actions.iter().any(|action| action == "card.use"),
        "{audit_actions:?}"
    );
    assert!(audit_actions
        .iter()
        .any(|action| action == "card.use_blocked"));
}

#[tokio::test]
async fn invalid_cards_are_refused_without_echoing_values() {
    let store = PluginSecretStore::in_memory().unwrap();
    let put = |values: Value, extra: Value| -> ItemPut {
        let mut body = json!({ "kind": "card", "values": values });
        if let (Value::Object(map), Value::Object(extra)) = (&mut body, extra) {
            map.extend(extra);
        }
        serde_json::from_value(body).unwrap()
    };
    let bad_number = "4242424242424241";
    let error = store
        .item_put(
            "visa",
            put(json!({ "number": bad_number }), json!({})),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_invalid_request");
    assert!(!error.to_string().contains(bad_number), "{error}");
    let error = store
        .item_put(
            "visa",
            put(json!({ "expMonth": "1", "expYear": "2020" }), json!({})),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("past"), "{error}");
    let error = store
        .item_put(
            "visa",
            put(
                json!({}),
                json!({ "fields": [{ "name": "x", "type": "text" }] }),
            ),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("fixed schema"), "{error}");
    let error = store
        .item_put(
            "bad.key",
            put(json!({}), json!({})),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_invalid_request");
    let login: ItemPut = serde_json::from_value(json!({
        "kind": "login",
        "fields": [{ "name": "u", "type": "text" }],
        "merchants": ["shop.example.com"],
    }))
    .unwrap();
    assert!(store
        .item_put("l", login, &actor(), PutAccess::FULL)
        .await
        .is_err());
    // A card collected later is pending until its required values arrive.
    let (_, view) = store
        .item_put(
            "later",
            put(json!({}), json!({ "merchants": ["shop.example.com"] })),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap();
    assert_eq!(view.status, ItemStatus::PendingCollection);
    assert!(view.card.unwrap().last4.is_none());
}

#[tokio::test]
async fn patches_revalidate_and_refresh_card_metadata() {
    let store = store_with_card(&["shop.example.com"]).await;
    let view = store.item_get(&coords("visa"), false).await.unwrap();
    let patch = |version: i64, values: Value, merchants: Option<Value>| -> ItemPatch {
        let mut body =
            json!({ "expectedVersion": version, "expectedId": view.id, "values": values });
        if let Some(merchants) = merchants {
            body["merchants"] = merchants;
        }
        serde_json::from_value(body).unwrap()
    };
    let error = store
        .item_patch(
            "visa",
            patch(1, json!({ "expYear": "2020" }), None),
            &actor(),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("past"), "{error}");
    let updated = store
        .item_patch(
            "visa",
            patch(
                1,
                json!({ "number": "5555 5555 5555 4444" }),
                Some(json!(["*.shop.example"])),
            ),
            &actor(),
        )
        .await
        .unwrap();
    let card = updated.card.unwrap();
    assert_eq!(card.brand.as_deref(), Some("mastercard"));
    assert_eq!(card.last4.as_deref(), Some("4444"));
    assert_eq!(card.merchants, vec!["*.shop.example"]);
}

#[tokio::test]
async fn merchant_lock_blocks_other_hosts_and_reveals_need_no_host() {
    let store = store_with_card(&["shop.example.com", "*.pay.example"]).await;
    for host in ["evil.example", "pay.example", "shop.example.com.evil"] {
        assert!(matches!(
            store.card_use(&broker_use(host, "s1"), None).await.unwrap(),
            CardUseOutcome::Blocked("merchant_not_allowed")
        ));
    }
    assert!(store.card_approvals(None, None).await.unwrap().is_empty());
    assert!(matches!(
        store
            .card_use(&broker_use("checkout.pay.example", "s1"), None)
            .await
            .unwrap(),
        CardUseOutcome::Pending(_)
    ));
}

#[tokio::test]
async fn approvals_gate_every_use() {
    let store = store_with_card(&["shop.example.com"]).await;
    let request = broker_use("shop.example.com", "s1");

    // Pending, deduplicated until decided.
    let first = pending_id(&store, &request).await;
    assert_eq!(pending_id(&store, &request).await, first);

    // Once: exactly one use.
    let approved = store
        .card_approve(&first, &ApproveInput::default(), &actor(), "user:u1")
        .await
        .unwrap();
    assert_eq!(approved.status, ApprovalStatus::Approved);
    assert_eq!(approved.max_uses, Some(1));
    match store.card_use(&request, None).await.unwrap() {
        CardUseOutcome::Granted {
            values,
            approval_id,
            ..
        } => {
            assert_eq!(approval_id, first);
            assert_eq!(values["number"], PAN_DIGITS);
            assert_eq!(values["cvc"], CVC);
            assert_eq!(values["expMonth"], "07");
        }
        other => panic!("expected a grant, got {other:?}"),
    }
    let consumed = store.card_approval(&first).await.unwrap().unwrap();
    assert_eq!(consumed.status, ApprovalStatus::Consumed);
    let second = pending_id(&store, &request).await;
    assert_ne!(second, first);

    // A decided request cannot be decided again.
    assert!(store
        .card_approve(&first, &ApproveInput::default(), &actor(), "user:u1")
        .await
        .is_err());

    // Reject: the next use files a new request.
    store
        .card_decline(&second, false, Some("no"), &actor(), "user:u1")
        .await
        .unwrap();
    assert_eq!(
        store.card_approval(&second).await.unwrap().unwrap().status,
        ApprovalStatus::Rejected
    );
    let third = pending_id(&store, &request).await;

    // Agent grant with a use cap covers other sessions of the same agent at
    // that merchant only.
    let grant: ApproveInput = serde_json::from_value(json!({
        "mode": "grant", "subject": "agent", "ttlSecs": 600, "maxUses": 2,
    }))
    .unwrap();
    let granted = store
        .card_approve(&third, &grant, &actor(), "user:u1")
        .await
        .unwrap();
    assert_eq!(granted.grant_subject.as_deref(), Some("machine:m1"));
    let other_session = broker_use("shop.example.com", "s2");
    for request in [&request, &other_session] {
        assert!(matches!(
            store.card_use(request, None).await.unwrap(),
            CardUseOutcome::Granted { .. }
        ));
    }
    assert!(matches!(
        store.card_use(&other_session, None).await.unwrap(),
        CardUseOutcome::Pending(_)
    ));
    let mut stranger = broker_use("shop.example.com", "s3");
    stranger.agent = "machine:m2".into();
    assert!(matches!(
        store.card_use(&stranger, None).await.unwrap(),
        CardUseOutcome::Pending(_)
    ));

    // TTL: an expired grant releases nothing; revoke ends a live grant.
    let fourth = pending_id(&store, &broker_use("shop.example.com", "s4")).await;
    let session_grant: ApproveInput =
        serde_json::from_value(json!({ "mode": "grant", "subject": "session" })).unwrap();
    let live = store
        .card_approve(&fourth, &session_grant, &actor(), "user:u1")
        .await
        .unwrap();
    let ttl = live.grant_expires_at.unwrap() - live.decided_at.unwrap();
    assert_eq!(ttl, DEFAULT_GRANT_TTL_SECS * 1000);
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE vault_card_approvals SET grant_expires_at = 1 WHERE id = ?1",
            params![fourth],
        )
        .unwrap();
    }
    assert!(matches!(
        store
            .card_use(&broker_use("shop.example.com", "s4"), None)
            .await
            .unwrap(),
        CardUseOutcome::Pending(_)
    ));
    assert_eq!(
        store.card_approval(&fourth).await.unwrap().unwrap().status,
        ApprovalStatus::Expired
    );

    let s5 = broker_use("shop.example.com", "s5");
    let fifth = pending_id(&store, &s5).await;
    store
        .card_approve(&fifth, &session_grant, &actor(), "user:u1")
        .await
        .unwrap();
    store
        .card_decline(&fifth, true, None, &actor(), "user:u1")
        .await
        .unwrap();
    assert!(matches!(
        store.card_use(&s5, None).await.unwrap(),
        CardUseOutcome::Pending(_)
    ));

    // Grant limits are validated.
    let too_long: ApproveInput =
        serde_json::from_value(json!({ "mode": "grant", "ttlSecs": 86_401 })).unwrap();
    let sixth = pending_id(&store, &broker_use("shop.example.com", "s6")).await;
    assert!(store
        .card_approve(&sixth, &too_long, &actor(), "user:u1")
        .await
        .is_err());
}

#[tokio::test]
async fn reveals_are_single_use_field_bound_approvals_by_another_human() {
    let store = store_with_card(&["shop.example.com"]).await;
    let request = CardUseRequest {
        coords: coords("visa"),
        channel: CardChannel::Reveal,
        merchant_host: String::new(),
        requester: "user:u1".into(),
        agent: "user:u1".into(),
        actor: actor(),
    };
    // A reveal names its field.
    assert_eq!(
        code(&store.card_use(&request, None).await.unwrap_err()),
        "vault_invalid_request"
    );
    let id = match store.card_use(&request, Some("cvc")).await.unwrap() {
        CardUseOutcome::Pending(approval) => {
            assert_eq!(approval.field, "cvc");
            approval.id
        }
        other => panic!("expected a pending approval, got {other:?}"),
    };
    let grant: ApproveInput = serde_json::from_value(json!({ "mode": "grant" })).unwrap();
    assert!(store
        .card_approve(&id, &grant, &actor(), "user:u2")
        .await
        .is_err());
    // The requester cannot approve their own reveal.
    assert_eq!(
        code(
            &store
                .card_approve(&id, &ApproveInput::default(), &actor(), "user:u1")
                .await
                .unwrap_err()
        ),
        "vault_denied"
    );
    store
        .card_approve(&id, &ApproveInput::default(), &actor(), "user:u2")
        .await
        .unwrap();
    // A `cvc` approval does not release the number.
    assert!(matches!(
        store.card_use(&request, Some("number")).await.unwrap(),
        CardUseOutcome::Pending(_)
    ));
    match store.card_use(&request, Some("cvc")).await.unwrap() {
        CardUseOutcome::Granted { values, .. } => {
            assert_eq!(values.len(), 1);
            assert_eq!(values["cvc"], CVC);
        }
        other => panic!("expected a grant, got {other:?}"),
    }
}

#[tokio::test]
async fn approvals_release_only_through_their_channel() {
    let store = store_with_card(&["shop.example.com"]).await;
    let fill = CardUseRequest {
        coords: coords("visa"),
        channel: CardChannel::Fill,
        merchant_host: "shop.example.com".into(),
        requester: "user:u1".into(),
        agent: "user:u1".into(),
        actor: actor(),
    };
    // A session the same human minted: its agent subject is `user:u1`.
    let mut broker = broker_use("shop.example.com", "s1");
    broker.agent = "user:u1".into();

    // A fill approval never covers a broker substitution.
    let fill_id = pending_id(&store, &fill).await;
    store
        .card_approve(&fill_id, &ApproveInput::default(), &actor(), "user:u2")
        .await
        .unwrap();
    assert!(matches!(
        store.card_use(&broker, None).await.unwrap(),
        CardUseOutcome::Pending(_)
    ));
    assert_eq!(
        store.card_approval(&fill_id).await.unwrap().unwrap().uses,
        0
    );

    // A broker grant to the agent `user:u1` never releases values to a
    // fill by that user.
    let broker_id = match store.card_use(&broker, None).await.unwrap() {
        CardUseOutcome::Pending(approval) => approval.id,
        other => panic!("expected a pending approval, got {other:?}"),
    };
    let agent_grant: ApproveInput =
        serde_json::from_value(json!({ "mode": "grant", "subject": "agent" })).unwrap();
    // The minting human may approve their own agent's broker request.
    let granted = store
        .card_approve(&broker_id, &agent_grant, &actor(), "user:u1")
        .await
        .unwrap();
    assert_eq!(granted.grant_subject.as_deref(), Some("user:u1"));
    assert!(matches!(
        store.card_use(&fill, None).await.unwrap(),
        CardUseOutcome::Granted { approval_id, .. } if approval_id == fill_id
    ));
    assert!(matches!(
        store.card_use(&fill, None).await.unwrap(),
        CardUseOutcome::Pending(_)
    ));
    assert!(matches!(
        store.card_use(&broker, None).await.unwrap(),
        CardUseOutcome::Granted { approval_id, .. } if approval_id == broker_id
    ));

    // A fill requester cannot approve their own fill; the local operator
    // (root equivalent) may confirm its own.
    let pending = pending_id(&store, &fill).await;
    assert_eq!(
        code(
            &store
                .card_approve(&pending, &ApproveInput::default(), &actor(), "user:u1")
                .await
                .unwrap_err()
        ),
        "vault_denied"
    );
    let mut operator_fill = fill.clone();
    operator_fill.requester = "operator".into();
    operator_fill.agent = "operator".into();
    let operator_pending = pending_id(&store, &operator_fill).await;
    store
        .card_approve(
            &operator_pending,
            &ApproveInput::default(),
            &AuditActor::new("operator", None),
            "operator",
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn failed_forwards_return_the_use_and_approvals_audit_fail_closed() {
    let store = store_with_card(&["shop.example.com"]).await;
    let request = broker_use("shop.example.com", "s1");
    let id = pending_id(&store, &request).await;

    // An approval no audit device accepts is not recorded.
    crate::vault::audit_devices::set_fail_closed_for_test(Some(true));
    let refused = store
        .card_approve(&id, &ApproveInput::default(), &actor(), "user:u1")
        .await;
    crate::vault::audit_devices::set_fail_closed_for_test(None);
    assert_eq!(code(&refused.unwrap_err()), "vault_audit_unavailable");
    assert_eq!(
        store.card_approval(&id).await.unwrap().unwrap().status,
        ApprovalStatus::Pending
    );

    store
        .card_approve(&id, &ApproveInput::default(), &actor(), "user:u1")
        .await
        .unwrap();
    assert!(matches!(
        store.card_use(&request, None).await.unwrap(),
        CardUseOutcome::Granted { .. }
    ));
    assert_eq!(
        store.card_approval(&id).await.unwrap().unwrap().status,
        ApprovalStatus::Consumed
    );
    // The request never reached the merchant: the single use comes back.
    assert!(store
        .card_use_refund(&request, &id, "upstream_unreachable")
        .await
        .unwrap());
    let refunded = store.card_approval(&id).await.unwrap().unwrap();
    assert_eq!(
        (refunded.status, refunded.uses),
        (ApprovalStatus::Approved, 0)
    );
    assert!(matches!(
        store.card_use(&request, None).await.unwrap(),
        CardUseOutcome::Granted { .. }
    ));
    // Each refund returns one spent use; an unused approval has none.
    assert!(store
        .card_use_refund(&request, &id, "upstream_unreachable")
        .await
        .unwrap());
    assert!(!store
        .card_use_refund(&request, &id, "upstream_unreachable")
        .await
        .unwrap());
}

#[test]
fn only_the_fixed_schema_makes_a_card() {
    assert!(is_card_item(CARD_KIND, &card_fields()));
    let mut legacy = card_fields();
    legacy.truncate(2);
    assert!(!is_card_item(CARD_KIND, &legacy));
    assert!(!is_card_item("login", &card_fields()));
}

#[tokio::test]
async fn fail_closed_audit_withholds_card_values_and_keeps_the_grant() {
    let store = store_with_card(&["shop.example.com"]).await;
    let request = broker_use("shop.example.com", "s1");
    let id = pending_id(&store, &request).await;
    store
        .card_approve(&id, &ApproveInput::default(), &actor(), "user:u1")
        .await
        .unwrap();
    crate::vault::audit_devices::set_fail_closed_for_test(Some(true));
    let outcome = store.card_use(&request, None).await;
    crate::vault::audit_devices::set_fail_closed_for_test(None);
    assert_eq!(code(&outcome.unwrap_err()), "vault_audit_unavailable");
    let approval = store.card_approval(&id).await.unwrap().unwrap();
    assert_eq!(
        (approval.status, approval.uses),
        (ApprovalStatus::Approved, 0)
    );
    assert!(matches!(
        store.card_use(&request, None).await.unwrap(),
        CardUseOutcome::Granted { .. }
    ));
}

#[tokio::test]
async fn deleting_a_card_revokes_its_grants_and_bindings() {
    let store = store_with_card(&["shop.example.com"]).await;
    let request = broker_use("shop.example.com", "s1");
    let id = pending_id(&store, &request).await;
    let grant: ApproveInput = serde_json::from_value(json!({ "mode": "grant" })).unwrap();
    store
        .card_approve(&id, &grant, &actor(), "user:u1")
        .await
        .unwrap();
    assert_eq!(store.card_bindings("default").await.unwrap().len(), 1);
    store
        .item_delete(&coords("visa"), None, &actor())
        .await
        .unwrap();
    assert!(store.card_bindings("default").await.unwrap().is_empty());
    assert_eq!(
        store.card_approval(&id).await.unwrap().unwrap().status,
        ApprovalStatus::Revoked
    );
}

fn file_contains(path: &std::path::Path, needle: &str) -> bool {
    std::fs::read(path)
        .map(|bytes| bytes.windows(needle.len()).any(|w| w == needle.as_bytes()))
        .unwrap_or(false)
}

#[tokio::test]
async fn card_merchants_expiry_and_approval_fields_are_sealed_at_rest() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plugin-secrets.db");
    let store = PluginSecretStore::open(path.clone()).unwrap();
    store
        .item_put(
            "visa",
            card_put(&["merchant-marker.example"]),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap();
    let pending = store
        .card_use(&broker_use("merchant-marker.example", "s1"), None)
        .await
        .unwrap();
    let CardUseOutcome::Pending(approval) = pending else {
        panic!("expected a pending approval");
    };
    store
        .card_decline(
            &approval.id,
            false,
            Some("note-marker"),
            &actor(),
            "user:u2",
        )
        .await
        .unwrap();
    {
        let conn = store.conn.lock().await;
        let (brand, last4, sealed): (String, String, String) = conn
            .query_row(
                "SELECT brand, last4, sealed_meta FROM vault_card_meta",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((brand.as_str(), last4.as_str()), ("visa", "4242"));
        assert!(sealed.starts_with("encb:v1:"));
        let (host, requester, note): (String, String, String) = conn
            .query_row(
                "SELECT merchant_host, requester, note FROM vault_card_approvals",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        for value in [host, requester, note] {
            assert!(value.starts_with("encb:v1:"), "{value}");
        }
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").ok();
    }
    for file in [path.clone(), dir.path().join("plugin-secrets.db-wal")] {
        assert!(!file_contains(&file, "note-marker"), "{}", file.display());
        assert!(
            !file_contains(&file, "merchant-marker"),
            "{}",
            file.display()
        );
    }
    // Reads still show everything.
    let card = store
        .item_get(&coords("visa"), true)
        .await
        .unwrap()
        .card
        .unwrap();
    assert_eq!(card.merchants, vec!["merchant-marker.example"]);
    assert_eq!(card.exp_month.as_deref(), Some("07"));
    let approvals = store.card_approvals(None, None).await.unwrap();
    assert_eq!(approvals[0].merchant_host, "merchant-marker.example");
    assert_eq!(approvals[0].note, "note-marker");
    assert_eq!(
        store.card_bindings("default").await.unwrap()[0]
            .merchants
            .len(),
        1
    );
}

#[tokio::test]
async fn legacy_plaintext_card_rows_are_sealed_once_and_backups_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plugin-secrets.db");
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE vault_card_meta (
                 item_id TEXT PRIMARY KEY, environment TEXT NOT NULL, path TEXT NOT NULL,
                 item_key TEXT NOT NULL, brand TEXT, last4 TEXT, exp_month TEXT, exp_year TEXT,
                 merchants TEXT NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE vault_card_approvals (
                 id TEXT PRIMARY KEY, item_id TEXT NOT NULL, environment TEXT NOT NULL,
                 path TEXT NOT NULL, item_key TEXT NOT NULL, brand TEXT, last4 TEXT,
                 channel TEXT NOT NULL, merchant_host TEXT NOT NULL, requester TEXT NOT NULL,
                 agent TEXT NOT NULL, status TEXT NOT NULL, mode TEXT, grant_subject TEXT,
                 max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, requested_at INTEGER NOT NULL,
                 request_expires_at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER,
                 grant_expires_at INTEGER, note TEXT NOT NULL DEFAULT '',
                 field TEXT NOT NULL DEFAULT '');
             INSERT INTO vault_card_meta VALUES ('i1', 'default', '/', 'visa', 'visa', '4242',
                 '07', '2099', '[\"legacy-merchant.example\"]', 1);
             INSERT INTO vault_card_approvals (id, item_id, environment, path, item_key, channel,
                 merchant_host, requester, agent, status, requested_at, request_expires_at, note)
             VALUES ('cap_1', 'i1', 'default', '/', 'visa', 'broker', 'legacy-merchant.example',
                 'broker_session:legacy', 'machine:legacy', 'rejected', 1, 2, 'legacy-note');",
        )
        .unwrap();
        conn.execute(
            "VACUUM INTO ?1",
            params![dir
                .path()
                .join("plugin-secrets.db.v3.bak")
                .to_string_lossy()
                .to_string()],
        )
        .unwrap();
    }
    assert!(seal_legacy_card_rows(&Connection::open(&path).unwrap()).unwrap() > 0);
    // The scrub debt committed with the seal, so a crash before the scrub
    // still leaves it for the next open.
    assert!(card_scrub_owed(&Connection::open(&path).unwrap()).unwrap());
    remove_plaintext_card_backups(&path);
    assert!(!dir.path().join("plugin-secrets.db.v3.bak").exists());
    let conn = Connection::open(&path).unwrap();
    // Second run: nothing left to seal, values unchanged.
    let before: String = conn
        .query_row("SELECT sealed_meta FROM vault_card_meta", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(seal_legacy_card_rows(&conn).unwrap(), 0);
    let after: String = conn
        .query_row("SELECT sealed_meta FROM vault_card_meta", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(before, after);
    assert!(!has_column(&conn, "vault_card_meta", "merchants").unwrap());
    assert!(!has_column(&conn, "vault_card_meta", "exp_month").unwrap());
    let meta = load_meta(&conn, "i1").unwrap().unwrap();
    assert_eq!(meta.merchants, vec!["legacy-merchant.example"]);
    assert_eq!(meta.exp_year.as_deref(), Some("2099"));
    let approval = get(&conn, "cap_1").unwrap().unwrap();
    assert_eq!(approval.requester, "broker_session:legacy");
    assert_eq!(approval.note, "legacy-note");
    // A sealed value moved to another row does not open there.
    conn.execute(
        "UPDATE vault_card_approvals SET note = requester WHERE id = 'cap_1'",
        [],
    )
    .unwrap();
    assert!(get(&conn, "cap_1").is_err());
    assert!(list(&conn, None, None).unwrap().is_empty());
}

#[test]
fn opening_fifty_cards_of_metadata_unseals_every_row() {
    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    for index in 0..50 {
        let id = format!("i{index}");
        let sealed = seal_meta(
            &id,
            &SealedMeta {
                merchants: vec!["shop.example.com".into()],
                exp_month: Some("07".into()),
                exp_year: Some("2099".into()),
            },
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vault_card_meta (item_id, environment, path, item_key, brand, last4,
                 sealed_meta, updated_at) VALUES (?1, 'default', '/', ?1, 'visa', '4242', ?2, 1)",
            params![id, sealed],
        )
        .unwrap();
    }
    // Every row opens and unseals to its own metadata. Wall-clock bounds are
    // left to benchmarks: a debug build on a shared machine cannot assert them.
    for index in 0..50 {
        let meta = load_meta(&conn, &format!("i{index}"))
            .unwrap()
            .expect("card metadata row loads");
        assert_eq!(meta.brand.as_deref(), Some("visa"));
        assert_eq!(meta.last4.as_deref(), Some("4242"));
        assert_eq!(meta.merchants, vec!["shop.example.com".to_owned()]);
        assert_eq!(meta.exp_month.as_deref(), Some("07"));
        assert_eq!(meta.exp_year.as_deref(), Some("2099"));
    }
}

#[tokio::test]
async fn first_sealing_open_scrubs_deleted_legacy_card_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plugin-secrets.db");
    drop(PluginSecretStore::open(path.clone()).unwrap());
    {
        // An older build: no secure_delete, a plaintext approval later deleted,
        // and no content-seal record for the store yet.
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "PRAGMA secure_delete = OFF;
             INSERT INTO vault_card_approvals (id, item_id, environment, path, item_key,
                 channel, merchant_host, requester, agent, status, requested_at,
                 request_expires_at, note)
             VALUES ('cap_old', 'gone', 'default', '/', 'visa', 'broker',
                 'deleted-merchant-marker.example', 'broker_session:old', 'machine:old',
                 'rejected', 1, 2, 'deleted-note-marker');
             PRAGMA wal_checkpoint(TRUNCATE);
             DELETE FROM vault_card_approvals WHERE id = 'cap_old';
             PRAGMA wal_checkpoint(TRUNCATE);",
        )
        .unwrap();
        conn.execute(
            "DELETE FROM ryu_content_seal WHERE store = ?1",
            params![CARD_STORE],
        )
        .unwrap();
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
    }
    assert!(
        file_contains(&path, "deleted-note-marker"),
        "precondition: the deleted row's bytes remain in a free page"
    );
    let store = PluginSecretStore::open(path.clone()).unwrap();
    {
        let conn = store.conn.lock().await;
        assert!(!card_scrub_owed(&conn).unwrap());
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").ok();
    }
    for file in [path.clone(), dir.path().join("plugin-secrets.db-wal")] {
        assert!(
            !file_contains(&file, "deleted-note-marker"),
            "{}",
            file.display()
        );
        assert!(
            !file_contains(&file, "deleted-merchant-marker"),
            "{}",
            file.display()
        );
    }
}

#[tokio::test]
async fn approved_grants_keep_their_subjects_sealed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plugin-secrets.db");
    let store = PluginSecretStore::open(path.clone()).unwrap();
    store
        .item_put(
            "visa",
            card_put(&["shop.example.com"]),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap();
    let mut request = broker_use("shop.example.com", "s1");
    request.agent = "machine:agent-subject-marker".to_owned();
    let id = pending_id(&store, &request).await;
    let grant: ApproveInput = serde_json::from_value(json!({
        "mode": "grant", "subject": "agent", "ttlSecs": 600,
    }))
    .unwrap();
    let granted = store
        .card_approve(&id, &grant, &actor(), "user:u1")
        .await
        .unwrap();
    assert_eq!(
        granted.grant_subject.as_deref(),
        Some("machine:agent-subject-marker")
    );
    // Another session of the same agent is covered by the agent grant.
    let mut other_session = broker_use("shop.example.com", "s2");
    other_session.agent = request.agent.clone();
    assert!(matches!(
        store.card_use(&other_session, None).await.unwrap(),
        CardUseOutcome::Granted { .. }
    ));
    // A different agent is not.
    assert!(matches!(
        store
            .card_use(&broker_use("shop.example.com", "s3"), None)
            .await
            .unwrap(),
        CardUseOutcome::Pending(_)
    ));
    {
        let conn = store.conn.lock().await;
        let stored: String = conn
            .query_row(
                "SELECT grant_subject FROM vault_card_approvals WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, GRANT_SUBJECT_AGENT);
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").ok();
    }
    // Not in the approval row, the audit log or the item events.
    for file in [path.clone(), dir.path().join("plugin-secrets.db-wal")] {
        assert!(
            !file_contains(&file, "agent-subject-marker"),
            "{}",
            file.display()
        );
    }
}

#[test]
fn legacy_plaintext_grant_subjects_become_markers() {
    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    conn.execute_batch(
        "INSERT INTO vault_card_approvals (id, item_id, environment, path, item_key, channel,
             merchant_host, requester, agent, status, grant_subject, requested_at,
             request_expires_at, grant_expires_at)
         VALUES ('cap_s', 'i1', 'default', '/', 'visa', 'broker', 'shop.example.com',
                 'broker_session:legacy', 'machine:legacy', 'approved', 'broker_session:legacy',
                 1, 2, 9999999999999),
                ('cap_a', 'i1', 'default', '/', 'visa', 'broker', 'shop.example.com',
                 'broker_session:legacy', 'machine:legacy', 'approved', 'machine:legacy',
                 1, 2, 9999999999999);",
    )
    .unwrap();
    assert!(seal_legacy_card_rows(&conn).unwrap() > 0);
    for (id, marker, subject) in [
        ("cap_s", GRANT_SUBJECT_REQUESTER, "broker_session:legacy"),
        ("cap_a", GRANT_SUBJECT_AGENT, "machine:legacy"),
    ] {
        let stored: String = conn
            .query_row(
                "SELECT grant_subject FROM vault_card_approvals WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, marker);
        let approval = get(&conn, id).unwrap().unwrap();
        assert_eq!(approval.grant_subject.as_deref(), Some(subject));
    }
    assert_eq!(seal_legacy_card_rows(&conn).unwrap(), 0, "idempotent");
}

#[test]
fn a_key_adoption_reseals_card_metadata_and_approvals() {
    let root_a = [51u8; 32];
    let root_b = [53u8; 32];
    let under_a = ContentCipher::from_root(&root_a, CARD_STORE);
    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    let meta = SealedMeta {
        merchants: vec!["rotated.example".into()],
        exp_month: Some("07".into()),
        exp_year: Some("2099".into()),
    };
    conn.execute(
        "INSERT INTO vault_card_meta (item_id, environment, path, item_key, brand, last4,
             sealed_meta, updated_at) VALUES ('i1', 'default', '/', 'visa', 'visa', '4242', ?1, 1)",
        params![seal_meta_with(&under_a, "i1", &meta).unwrap()],
    )
    .unwrap();
    let sealed = |column: &str, value: &str| {
        under_a
            .seal_text(value, &approval_context(column, "cap_r"))
            .unwrap()
    };
    conn.execute(
        "INSERT INTO vault_card_approvals (id, item_id, environment, path, item_key, channel,
             merchant_host, requester, agent, status, requested_at, request_expires_at, note)
         VALUES ('cap_r', 'i1', 'default', '/', 'visa', 'broker', ?1, ?2, ?3, 'rejected', 1, 2, ?4)",
        params![
            sealed("merchant_host", "rotated.example"),
            sealed("requester", "broker_session:r"),
            sealed("agent", "machine:r"),
            sealed("note", "rotated-note")
        ],
    )
    .unwrap();
    // Adopt root B, keeping A as a retired key.
    let rotated = ContentCipher::from_root(&root_b, CARD_STORE).with_retired_roots(&[root_a]);
    assert_eq!(seal_legacy_card_rows_with(&conn, &rotated).unwrap(), 5);
    assert_eq!(
        seal_legacy_card_rows_with(&conn, &rotated).unwrap(),
        0,
        "idempotent"
    );
    // Every value now opens under B alone.
    let only_b = ContentCipher::from_root(&root_b, CARD_STORE);
    let stored_meta: String = conn
        .query_row("SELECT sealed_meta FROM vault_card_meta", [], |row| {
            row.get(0)
        })
        .unwrap();
    let opened = only_b
        .open_text(&stored_meta, &ContentContext::for_id(META_PURPOSE, "i1"))
        .unwrap();
    assert!(!opened.needs_reseal);
    assert!(opened.value.contains("rotated.example"));
    let values: Vec<String> = conn
        .query_row(
            "SELECT merchant_host, requester, agent, note FROM vault_card_approvals",
            [],
            |row| (0..4).map(|index| row.get(index)).collect(),
        )
        .unwrap();
    for ((column, stored), expected) in SEALED_APPROVAL_COLUMNS.iter().zip(&values).zip([
        "rotated.example",
        "broker_session:r",
        "machine:r",
        "rotated-note",
    ]) {
        let opened = only_b
            .open_text(stored, &approval_context(column, "cap_r"))
            .unwrap();
        assert!(!opened.needs_reseal, "{column}");
        assert_eq!(opened.value, expected);
    }
}
