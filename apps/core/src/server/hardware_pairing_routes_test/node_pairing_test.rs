use super::*;

#[tokio::test]
async fn begin_refuses_a_key_bound_elsewhere_a_full_node_and_a_node_without_an_identity() {
    let harness = Harness::new();

    // A key bound to another device is refused for a new device id.
    let first = Device::new("bound");
    let begun = harness.begin_and_reveal(&first).await;
    assert_eq!(harness.confirm(&first, &begun).await.status, StatusCode::OK);
    let mut clone = Device::new("clone");
    clone.secret = first.secret;
    clone.public = first.public;
    let clone_reply = harness.post(BEGIN, &clone.begin_body()).await;
    assert_eq!(
        clone_reply.status,
        StatusCode::CONFLICT,
        "{}",
        clone_reply.text
    );
    assert_eq!(clone_reply.code(), "already_paired");

    // At most four pairings are pending; the fifth is told to wait.
    let crowded = Harness::new();
    for index in 0..4 {
        crowded.begin(&Device::new(&format!("crowd{index}"))).await;
    }
    let overflow = crowded
        .post(BEGIN, &Device::new("crowd-extra").begin_body())
        .await;
    assert_eq!(
        overflow.status,
        StatusCode::TOO_MANY_REQUESTS,
        "{}",
        overflow.text
    );
    assert_eq!(overflow.code(), "too_many_pending");

    // Without a sealed node key there is no identity to pair against.
    let unsealed = Harness::without_identity();
    let device = Device::new("no-identity");
    let reply = unsealed.post(BEGIN, &device.begin_body()).await;
    assert_eq!(
        reply.status,
        StatusCode::SERVICE_UNAVAILABLE,
        "{}",
        reply.text
    );
    assert_eq!(reply.code(), "node_identity_unavailable");
    assert!(!unsealed.registered(&device).await);
}

#[tokio::test]
async fn legacy_pairing_is_a_426_once_the_node_preference_turns_it_off_and_registers_nothing() {
    let harness = Harness::new();
    let legacy = |device_id: &str, nonce: &str| json!({ "device_id": device_id, "pairing_nonce": nonce, "device_type": "watch" });

    // On by default: a legacy device registers at the legacy level.
    let open = harness
        .post(LEGACY, &legacy("rhw_legacy_open", "0123456789abcdef"))
        .await;
    assert_eq!(open.status, StatusCode::OK, "{}", open.text);
    let opened = open.json();
    assert!(opened["device_token"].as_str().unwrap().starts_with("rht_"));
    assert_eq!(opened["node_url"], NODE_URL);
    let record = harness
        .state
        .hardware
        .get("rhw_legacy_open")
        .await
        .unwrap()
        .expect("registered");
    assert_eq!(record.protocol_level, PROTOCOL_LEVEL_LEGACY);
    assert_eq!(record.noise_pubkey, None);
    let replay = harness
        .post(LEGACY, &legacy("rhw_legacy_open", "0123456789abcdef"))
        .await;
    assert_eq!(replay.status, StatusCode::CONFLICT, "{}", replay.text);
    assert_eq!(replay.code(), "already_paired");

    // Off: 426 with the v2-required code, no device and no spent nonce.
    for off in ["false", " False "] {
        harness
            .state
            .preferences
            .set(hardware_public::LEGACY_PAIRING_PREF, off)
            .await
            .unwrap();
        let refused = harness
            .post(LEGACY, &legacy("rhw_legacy_off", "fedcba9876543210"))
            .await;
        assert_eq!(
            refused.status,
            StatusCode::UPGRADE_REQUIRED,
            "{off:?}: {}",
            refused.text
        );
        assert_eq!(refused.code(), "pairing_v2_required");
        assert!(
            !harness
                .state
                .hardware
                .get("rhw_legacy_off")
                .await
                .unwrap()
                .is_some(),
            "{off:?}: the refused legacy pairing registered a device"
        );
        assert!(
            !harness
                .state
                .hardware
                .nonce_consumed("rhw_legacy_off", "fedcba9876543210")
                .await
                .unwrap(),
            "{off:?}: the refused legacy pairing spent its nonce"
        );
    }

    // Pairing v2 is unaffected by the preference.
    let device = Device::new("while-legacy-off");
    let begun = harness.begin_and_reveal(&device).await;
    assert_eq!(
        harness.confirm(&device, &begun).await.status,
        StatusCode::OK
    );

    // Anything but "false" turns it back on.
    harness
        .state
        .preferences
        .set(hardware_public::LEGACY_PAIRING_PREF, "true")
        .await
        .unwrap();
    let back = harness
        .post(LEGACY, &legacy("rhw_legacy_off", "fedcba9876543210"))
        .await;
    assert_eq!(back.status, StatusCode::OK, "{}", back.text);
}

#[tokio::test]
async fn every_pairing_route_needs_the_node_bearer_and_a_refusal_changes_nothing() {
    let harness = Harness::new();
    let fingerprint = harness.node_fingerprint().await;
    let device = Device::new("unauthorized");
    let begun = harness.begin_and_reveal(&device).await;
    let credentials: [(&str, Option<&str>); 3] = [
        ("no bearer", None),
        ("a wrong bearer", Some("not-the-node-token")),
        (
            "the node token with another case",
            Some("HARDWARE-PAIRING-ROUTES-NODE-TOKEN"),
        ),
    ];
    for (label, bearer) in credentials {
        let calls = [
            (
                LEGACY,
                json!({ "device_id": "rhw_unauth", "pairing_nonce": "0123456789abcdef", "device_type": "watch" }),
            ),
            (BEGIN, Device::new("unauth-begin").begin_body()),
            (
                REVEAL,
                json!({ "pairing_id": begun.pairing_id, "device_rand": b64(&device.rand) }),
            ),
            (CONFIRM, device.confirm_body(&begun, None)),
            (CANCEL, json!({ "pairing_id": begun.pairing_id })),
            (RESET, json!({})),
        ];
        for (uri, body) in calls {
            let reply = harness.send(uri, Some(body.to_string()), bearer).await;
            assert_eq!(
                reply.status,
                StatusCode::UNAUTHORIZED,
                "{label}: {uri}: {}",
                reply.text
            );
        }
    }
    // Nothing happened: the legacy device was not registered, the revealed
    // pairing was neither confirmed nor cancelled, the node key is the same,
    // and the refused begins took none of the four pending slots.
    assert!(harness
        .state
        .hardware
        .get("rhw_unauth")
        .await
        .unwrap()
        .is_none());
    assert!(!harness.registered(&device).await);
    assert_eq!(
        harness.pending(&begun).await.expect("untouched").state,
        PendingState::Revealed
    );
    assert_eq!(harness.node_fingerprint().await, fingerprint);
    for index in 0..3 {
        harness.begin(&Device::new(&format!("slot{index}"))).await;
    }
    // Three more fit beside the revealed one; a fifth would not.
    let overflow = harness
        .post(BEGIN, &Device::new("slot-overflow").begin_body())
        .await;
    assert_eq!(
        overflow.status,
        StatusCode::TOO_MANY_REQUESTS,
        "{}",
        overflow.text
    );

    // The bearer is what admits the same calls.
    assert_eq!(
        harness.confirm(&device, &begun).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn identity_reset_flags_secure_devices_and_drops_pairings_started_under_the_old_key() {
    let harness = Harness::new();
    let secure = Device::new("secure");
    let begun = harness.begin_and_reveal(&secure).await;
    assert_eq!(
        harness.confirm(&secure, &begun).await.status,
        StatusCode::OK
    );
    let legacy = harness
        .post(
            LEGACY,
            &json!({ "device_id": "rhw_reset_legacy", "pairing_nonce": "0123456789abcdef", "device_type": "watch" }),
        )
        .await;
    assert_eq!(legacy.status, StatusCode::OK, "{}", legacy.text);
    let stale = Device::new("stale");
    let stale_begun = harness.begin_and_reveal(&stale).await;
    assert_eq!(stale_begun.node_fingerprint, begun.node_fingerprint);

    let reset = harness.post(RESET, &json!({})).await;
    assert_eq!(reset.status, StatusCode::OK, "{}", reset.text);
    let reset = reset.json();
    assert_ne!(reset["node_fingerprint"], json!(begun.node_fingerprint));
    assert_eq!(
        reset["node_fingerprint"],
        json!(harness.node_fingerprint().await)
    );
    assert_eq!(
        reset["devices_needing_repair"],
        json!([secure.id]),
        "only the key-pinned device must re-pair: {reset}"
    );
    assert!(
        harness
            .state
            .hardware
            .get(&secure.id)
            .await
            .unwrap()
            .unwrap()
            .needs_repair
    );
    assert!(
        !harness
            .state
            .hardware
            .get("rhw_reset_legacy")
            .await
            .unwrap()
            .unwrap()
            .needs_repair
    );

    // Reset drops every pending pairing, because each one is bound to the old
    // node key: the pairing that was revealed under it can neither be
    // confirmed nor revealed again, and nothing is registered.
    assert!(harness.pending(&stale_begun).await.is_none());
    let late = harness.confirm(&stale, &stale_begun).await;
    assert_eq!(late.status, StatusCode::NOT_FOUND, "{}", late.text);
    assert_eq!(late.code(), "unknown_or_expired");
    let late_reveal = harness.reveal(&stale, &stale_begun).await;
    assert_eq!(
        late_reveal.status,
        StatusCode::NOT_FOUND,
        "{}",
        late_reveal.text
    );
    assert!(!harness.registered(&stale).await);

    // A new pairing runs against the new key.
    let fresh = Device::new("fresh");
    let fresh_begun = harness.begin_and_reveal(&fresh).await;
    assert_ne!(fresh_begun.node_pub, begun.node_pub);
    assert_eq!(
        harness.confirm(&fresh, &fresh_begun).await.status,
        StatusCode::OK
    );

    // Without a sealed node key the reset is refused and nothing changes.
    let unsealed = Harness::without_identity();
    let refused = unsealed.post(RESET, &json!({})).await;
    assert_eq!(
        refused.status,
        StatusCode::SERVICE_UNAVAILABLE,
        "{}",
        refused.text
    );
    assert_eq!(refused.code(), "node_identity_unavailable");
}

/// The tests above mount `hardware_public`'s handlers on a router of their
/// own, so this pins the production registration: each handler is mounted
/// once, on the protected router (behind the node bearer), at its path.
#[test]
fn the_pairing_handlers_are_mounted_once_on_the_protected_router_at_their_paths() {
    // The protected route table is split across the `protected_routes_*`
    // functions that `create_router` merges under the auth layer stack.
    let source = crate::server::tests::source_text::router_source();
    for (path, handler) in [
        (LEGACY, "pair_device"),
        (BEGIN, "pair_begin"),
        (REVEAL, "pair_reveal"),
        (CONFIRM, "pair_confirm"),
        (CANCEL, "pair_cancel"),
        (RESET, "hardware_identity_reset"),
    ] {
        let needle = format!("post(hardware_public::{handler})");
        assert_eq!(
            source.matches(&needle).count(),
            1,
            "{handler} is mounted once"
        );
        let at = source.find(&needle).unwrap();
        let table = source[..at]
            .rfind("fn protected_routes_")
            .unwrap_or_else(|| {
                panic!("{handler} is registered before the protected route table starts")
            });
        assert!(
            !source[table..at].contains("\n}\n"),
            "{handler} is registered outside the protected route table"
        );
        let route = source[..at].rfind(".route(").expect("a route registration");
        assert!(
            source[route..at].contains(&format!("\"{path}\"")),
            "{handler} is not registered at {path}"
        );
    }
}
