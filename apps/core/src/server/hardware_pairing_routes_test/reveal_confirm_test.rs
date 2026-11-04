use super::*;

#[tokio::test]
async fn a_device_pairs_through_begin_reveal_and_confirm_and_is_registered_only_by_the_press() {
    let harness = Harness::new();
    let device = Device::new("happy");

    let begin = harness.post(BEGIN, &device.begin_body()).await;
    assert_eq!(begin.status, StatusCode::OK, "{}", begin.text);
    let begun = begin.json();
    assert_eq!(begun["expires_in"], 180, "{}", begin.text);
    let begun = Begun {
        pairing_id: begun["pairing_id"].as_str().unwrap().to_owned(),
        node_pub: begun["node_pub"].as_str().unwrap().to_owned(),
        node_fingerprint: begun["node_fingerprint"].as_str().unwrap().to_owned(),
    };
    assert_eq!(begun.node_fingerprint, harness.node_fingerprint().await);
    let pending = harness.pending(&begun).await.expect("a begun pairing");
    assert_eq!(pending.state, PendingState::Begun);
    assert_eq!(pending.device_id, device.id);
    assert_eq!(pending.node_url, NODE_URL);
    assert!(
        !harness.registered(&device).await,
        "begin registers nothing"
    );

    // Reveal opens the commitment and returns the code the user compares; the
    // device derives the same transcript, code and fingerprint on its own.
    let reveal = harness.reveal(&device, &begun).await;
    assert_eq!(reveal.status, StatusCode::OK, "{}", reveal.text);
    let hash = device.transcript_hash(&begun);
    let revealed = reveal.json();
    assert_eq!(revealed["transcript_hash"], b64(&hash));
    assert_eq!(revealed["sas"], pair_crypto::sas(&hash));
    assert_eq!(revealed["sas"].as_str().unwrap().len(), 6);
    assert_eq!(
        revealed["device_fingerprint"],
        pair_crypto::fingerprint(&device.public)
    );
    assert_eq!(
        harness.pending(&begun).await.unwrap().state,
        PendingState::Revealed
    );
    assert!(
        !harness.registered(&device).await,
        "reveal alone does not register the device"
    );

    // The press: the confirm tag the device derives is accepted, the device is
    // registered at the secure level, and its credentials are only sealed.
    let wifi = json!({ "ssid": "HomeNet", "psk": "correct horse battery" });
    let confirm = harness
        .post(CONFIRM, &device.confirm_body(&begun, Some(wifi)))
        .await;
    assert_eq!(confirm.status, StatusCode::OK, "{}", confirm.text);
    assert!(
        !confirm.text.contains("correct horse battery"),
        "the Wi-Fi key is sealed, not returned: {}",
        confirm.text
    );
    let confirmed = confirm.json();
    let relay_token = confirmed["relay_token"].as_str().unwrap();
    assert!(relay_token.starts_with("rhr_"), "{relay_token}");
    assert_eq!(confirmed["device"]["device_id"], device.id);
    assert_eq!(confirmed["device"]["secure"], true);
    assert_eq!(
        confirmed["device"]["key_fingerprint"],
        pair_crypto::fingerprint(&device.public)
    );
    let sealed = pair_crypto::b64u_decode(confirmed["sealed_credentials"].as_str().unwrap())
        .expect("sealed credentials are base64url");
    assert!(
        !String::from_utf8_lossy(&sealed).contains("rht_"),
        "the device token is not readable in the sealed blob"
    );
    let credentials = pair_crypto::open_credentials(&device.keys(&begun), &hash, &sealed)
        .expect("the device opens its credentials");
    assert!(credentials.device_token.starts_with("rht_"));
    assert_eq!(credentials.node_url, NODE_URL);
    assert_eq!(credentials.wifi_ssid.as_deref(), Some("HomeNet"));
    assert_eq!(
        credentials.wifi_psk.as_deref(),
        Some("correct horse battery")
    );

    let record = harness
        .state
        .hardware
        .get(&device.id)
        .await
        .unwrap()
        .expect("the device is registered");
    assert_eq!(record.protocol_level, PROTOCOL_LEVEL_SECURE);
    assert_eq!(record.noise_pubkey, Some(b64(&device.public)));
    assert_eq!(record.key_verification.as_deref(), Some("sas"));
    assert_eq!(record.key_source.as_deref(), Some("ble"));
    assert_eq!(record.token_hash, hash_token(&credentials.device_token));
    assert_eq!(record.relay_token_hash, Some(hash_token(relay_token)));
    assert!(!record.needs_repair);
    assert!(
        harness.pending(&begun).await.is_none(),
        "the pending is spent"
    );

    // Single use: a replayed confirm or reveal finds nothing.
    let replay = harness.confirm(&device, &begun).await;
    assert_eq!(replay.status, StatusCode::NOT_FOUND, "{}", replay.text);
    assert_eq!(replay.code(), "unknown_or_expired");
    let reveal_again = harness.reveal(&device, &begun).await;
    assert_eq!(reveal_again.status, StatusCode::NOT_FOUND);

    // The paired device cannot begin again.
    let again = harness.post(BEGIN, &device.begin_body()).await;
    assert_eq!(again.status, StatusCode::CONFLICT, "{}", again.text);
    assert_eq!(again.code(), "already_paired");
}

#[tokio::test]
async fn confirm_before_reveal_and_a_second_reveal_are_refused_and_leave_the_pairing_usable() {
    let harness = Harness::new();
    let device = Device::new("order");
    let begun = harness.begin(&device).await;

    let early = harness.confirm(&device, &begun).await;
    assert_eq!(early.status, StatusCode::CONFLICT, "{}", early.text);
    assert_eq!(early.code(), "bad_state");
    assert_eq!(
        harness.pending(&begun).await.expect("still pending").state,
        PendingState::Begun,
        "a refused confirm does not consume the pairing"
    );
    assert!(!harness.registered(&device).await);

    let revealed = harness.reveal(&device, &begun).await;
    assert_eq!(revealed.status, StatusCode::OK, "{}", revealed.text);
    let second = harness.reveal(&device, &begun).await;
    assert_eq!(second.status, StatusCode::CONFLICT, "{}", second.text);
    assert_eq!(second.code(), "bad_state");
    assert_eq!(
        harness.pending(&begun).await.expect("still pending").state,
        PendingState::Revealed,
        "a refused second reveal does not consume the pairing"
    );

    let confirmed = harness.confirm(&device, &begun).await;
    assert_eq!(confirmed.status, StatusCode::OK, "{}", confirmed.text);
    assert!(harness.registered(&device).await);
}

#[tokio::test]
async fn a_cancelled_pairing_cannot_be_revealed_or_confirmed_and_cancel_is_idempotent() {
    let harness = Harness::new();
    let device = Device::new("cancel");
    let begun = harness.begin_and_reveal(&device).await;

    let cancelled = harness
        .post(
            CANCEL,
            &json!({ "pairing_id": begun.pairing_id, "reason": "user" }),
        )
        .await;
    assert_eq!(cancelled.status, StatusCode::OK, "{}", cancelled.text);
    assert_eq!(cancelled.json(), json!({ "ok": true }));
    assert!(harness.pending(&begun).await.is_none());

    let confirm = harness.confirm(&device, &begun).await;
    assert_eq!(confirm.status, StatusCode::NOT_FOUND, "{}", confirm.text);
    assert_eq!(confirm.code(), "unknown_or_expired");
    let reveal = harness.reveal(&device, &begun).await;
    assert_eq!(reveal.status, StatusCode::NOT_FOUND, "{}", reveal.text);
    assert!(!harness.registered(&device).await);

    // A second cancel, an unknown id and a mismatch report all answer ok.
    for body in [
        json!({ "pairing_id": begun.pairing_id }),
        json!({ "pairing_id": "never-begun" }),
        json!({ "pairing_id": b64(&[9u8; 16]), "reason": "mismatch" }),
    ] {
        let reply = harness.post(CANCEL, &body).await;
        assert_eq!(reply.status, StatusCode::OK, "{body}: {}", reply.text);
        assert_eq!(reply.json(), json!({ "ok": true }));
    }

    // A mismatch report drops a live pairing as well.
    let other = Device::new("mismatch");
    let live = harness.begin_and_reveal(&other).await;
    let mismatch = harness
        .post(
            CANCEL,
            &json!({ "pairing_id": live.pairing_id, "reason": "mismatch" }),
        )
        .await;
    assert_eq!(mismatch.status, StatusCode::OK);
    assert!(harness.pending(&live).await.is_none());
    assert_eq!(
        harness.confirm(&other, &live).await.status,
        StatusCode::NOT_FOUND
    );
    assert!(!harness.registered(&other).await);
}

#[tokio::test]
async fn an_expired_pairing_is_unknown_to_reveal_confirm_and_cancel() {
    let harness = Harness::new();
    let begin_device = Device::new("expired-begun");
    let reveal_device = Device::new("expired-revealed");
    let now = now_ms();
    let node_pub = harness
        .state
        .hardware
        .node_identity()
        .await
        .unwrap()
        .public();
    let seed = |device: &Device, marker: u8, state: PendingState| {
        let revealed = state == PendingState::Revealed;
        let pairing_id = [marker; 16];
        let begun = Begun {
            pairing_id: b64(&pairing_id),
            node_pub: b64(&node_pub),
            node_fingerprint: String::new(),
        };
        let transcript = revealed.then(|| b64(&device.transcript_hash(&begun)));
        (
            PendingPairing {
                pairing_id: begun.pairing_id.clone(),
                device_id: device.id.clone(),
                device_type: DeviceType::Necklace,
                pairing_nonce: device.nonce.clone(),
                device_pub: b64(&device.public),
                device_commit: b64(&pair_crypto::commit(&device.public, &device.rand)),
                key_source: "ble".into(),
                node_url: NODE_URL.into(),
                device_rand: revealed.then(|| b64(&device.rand)),
                transcript_hash: transcript,
                state,
                created_at: now - 200_000,
                // Expired one second ago.
                expires_at: now - 1_000,
            },
            begun,
        )
    };
    let (begun_row, begun) = seed(&begin_device, 1, PendingState::Begun);
    let (revealed_row, revealed) = seed(&reveal_device, 2, PendingState::Revealed);
    for row in [&begun_row, &revealed_row] {
        harness
            .state
            .hardware
            .insert_pending_pairing(row, now - 300_000)
            .await
            .unwrap();
    }

    let reveal = harness.reveal(&begin_device, &begun).await;
    assert_eq!(reveal.status, StatusCode::NOT_FOUND, "{}", reveal.text);
    assert_eq!(reveal.code(), "unknown_or_expired");
    let confirm = harness.confirm(&reveal_device, &revealed).await;
    assert_eq!(confirm.status, StatusCode::NOT_FOUND, "{}", confirm.text);
    assert_eq!(confirm.code(), "unknown_or_expired");
    assert!(!harness.registered(&reveal_device).await);
    assert!(!harness.registered(&begin_device).await);
    let cancel = harness
        .post(CANCEL, &json!({ "pairing_id": revealed.pairing_id }))
        .await;
    assert_eq!(cancel.status, StatusCode::OK, "{}", cancel.text);

    // The same rows, unexpired, would have been accepted: expiry is the only
    // reason the refusals above happened.
    let live = Device::new("not-expired");
    let live_begun = harness.begin_and_reveal(&live).await;
    assert_eq!(
        harness.confirm(&live, &live_begun).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn a_wrong_reveal_or_a_wrong_confirm_tag_burns_the_attempt_and_registers_nothing() {
    let harness = Harness::new();

    let committed = Device::new("bad-reveal");
    let begun = harness.begin(&committed).await;
    let wrong = harness
        .post(
            REVEAL,
            &json!({ "pairing_id": begun.pairing_id, "device_rand": b64(&[0xAB; 16]) }),
        )
        .await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED, "{}", wrong.text);
    assert_eq!(wrong.code(), "commitment_mismatch");
    assert!(
        harness.pending(&begun).await.is_none(),
        "the attempt is burned"
    );
    let retry = harness.reveal(&committed, &begun).await;
    assert_eq!(retry.status, StatusCode::NOT_FOUND, "{}", retry.text);

    let pressed = Device::new("bad-tag");
    let begun = harness.begin_and_reveal(&pressed).await;
    let wrong_tag = harness
        .post(
            CONFIRM,
            &json!({
                "pairing_id": begun.pairing_id,
                "confirm_tag": b64(&[0u8; 32]),
                "key_verification": "sas",
            }),
        )
        .await;
    assert_eq!(
        wrong_tag.status,
        StatusCode::UNAUTHORIZED,
        "{}",
        wrong_tag.text
    );
    assert_eq!(wrong_tag.code(), "confirmation_mismatch");
    assert!(!harness.registered(&pressed).await);
    assert!(
        harness.pending(&begun).await.is_none(),
        "the attempt is burned"
    );
    let retry = harness.confirm(&pressed, &begun).await;
    assert_eq!(retry.status, StatusCode::NOT_FOUND, "{}", retry.text);
    assert!(!harness.registered(&pressed).await);
}

#[tokio::test]
async fn malformed_bodies_are_a_bad_request_that_does_not_echo_the_body() {
    let harness = Harness::new();
    for uri in [BEGIN, REVEAL, CONFIRM, CANCEL] {
        for body in ["{ not json: secret-marker", "{}", "[]", "\"secret-marker\""] {
            let reply = harness.post_raw(uri, body).await;
            assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{uri} {body}");
            assert_eq!(reply.code(), "bad_request", "{uri} {body}");
            assert!(
                !reply.text.contains("secret-marker"),
                "{uri}: the rejection echoed the body: {}",
                reply.text
            );
        }
    }

    // Well-formed JSON with a field the protocol refuses.
    let device = Device::new("fields");
    let refused = |field: &'static str, value: Value| {
        let mut body = device.begin_body();
        body[field] = value;
        body
    };
    for (label, body) in [
        (
            "a nonce that is not lowercase hex",
            refused("pairing_nonce", json!("ABCDEF0123456789ABCDEF0123456789")),
        ),
        ("a short nonce", refused("pairing_nonce", json!("abc123"))),
        (
            "an unknown device type",
            refused("device_type", json!("toaster")),
        ),
        ("an unknown key source", refused("key_source", json!("nfc"))),
        ("an unknown policy", refused("policy", json!("tap_only"))),
        (
            "a device key of the wrong length",
            refused("device_pub", json!(b64(&[1u8; 16]))),
        ),
        (
            "a device id with a slash",
            refused("device_id", json!("rhn/evil")),
        ),
    ] {
        let reply = harness.post(BEGIN, &body).await;
        assert_eq!(
            reply.status,
            StatusCode::BAD_REQUEST,
            "{label}: {}",
            reply.text
        );
        assert_eq!(reply.code(), "bad_request", "{label}");
    }
    assert!(!harness.registered(&device).await);

    // A confirm that names an unknown verification method, or a pairing id that
    // is not 16 bytes, is refused before it can consume anything.
    let pressed = Device::new("verification");
    let begun = harness.begin_and_reveal(&pressed).await;
    let mut maybe = pressed.confirm_body(&begun, None);
    maybe["key_verification"] = json!("maybe");
    let maybe = harness.post(CONFIRM, &maybe).await;
    assert_eq!(maybe.status, StatusCode::BAD_REQUEST, "{}", maybe.text);
    let mut short = pressed.confirm_body(&begun, None);
    short["pairing_id"] = json!("short");
    let short = harness.post(CONFIRM, &short).await;
    assert_eq!(short.status, StatusCode::BAD_REQUEST, "{}", short.text);
    assert_eq!(
        harness.pending(&begun).await.expect("untouched").state,
        PendingState::Revealed
    );
}
