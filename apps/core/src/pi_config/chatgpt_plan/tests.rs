use super::*;

fn signed_identity(claims: &serde_json::Value) -> String {
    let mut header = jsonwebtoken::Header::new(Algorithm::RS256);
    header.kid = Some("chatgpt-plan-test".to_owned());
    jsonwebtoken::encode(
        &header,
        claims,
        &jsonwebtoken::EncodingKey::from_rsa_pem(include_bytes!(
            "../fixtures/chatgpt-plan-test-private.pem"
        ))
        .unwrap(),
    )
    .unwrap()
}

fn identity_claims() -> serde_json::Value {
    let now = now_seconds().unwrap();
    serde_json::json!({ "iss": ISSUER, "aud": "oaiapp_test", "sub": "verified-subject",
        "iat": now, "exp": now + 3600, "nonce": "test-nonce",
        "email": "test@example.com", "email_verified": true })
}

#[test]
fn signed_identity_requires_signature_issuer_audience_expiry_nonce_and_subject() {
    let keys: JwkSet =
        serde_json::from_str(include_str!("../fixtures/chatgpt-plan-test-jwks.json")).unwrap();
    let claims = identity_claims();
    let token = signed_identity(&claims);
    assert!(verify_identity(
        &token,
        &keys,
        "oaiapp_test",
        Some("test-nonce"),
        Some("verified-subject")
    )
    .is_ok());
    for missing in ["iss", "aud", "sub", "exp", "iat", "nonce"] {
        let mut missing_claims = claims.clone();
        missing_claims.as_object_mut().unwrap().remove(missing);
        assert!(
            verify_identity(
                &signed_identity(&missing_claims),
                &keys,
                "oaiapp_test",
                Some("test-nonce"),
                Some("verified-subject")
            )
            .is_err(),
            "{missing}"
        );
    }
    for (field, invalid) in [
        ("iss", serde_json::json!("https://attacker.example")),
        ("aud", serde_json::json!("oaiapp_other")),
        ("exp", serde_json::json!(now_seconds().unwrap() - 100)),
        ("iat", serde_json::json!(now_seconds().unwrap() + 60)),
        ("nonce", serde_json::json!("other-nonce")),
        ("sub", serde_json::json!("other-subject")),
    ] {
        let mut invalid_claims = claims.clone();
        invalid_claims[field] = invalid;
        assert!(
            verify_identity(
                &signed_identity(&invalid_claims),
                &keys,
                "oaiapp_test",
                Some("test-nonce"),
                Some("verified-subject")
            )
            .is_err(),
            "{field}"
        );
    }
    let wrong_algorithm = jsonwebtoken::encode(
        &jsonwebtoken::Header::new(Algorithm::HS256),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(b"synthetic-test-secret"),
    )
    .unwrap();
    assert!(verify_identity(
        &wrong_algorithm,
        &keys,
        "oaiapp_test",
        Some("test-nonce"),
        None
    )
    .is_err());
    let mut tampered = token.into_bytes();
    let last = tampered.last_mut().unwrap();
    *last = if *last == b'A' { b'B' } else { b'A' };
    assert!(verify_identity(
        std::str::from_utf8(&tampered).unwrap(),
        &keys,
        "oaiapp_test",
        Some("test-nonce"),
        None
    )
    .is_err());
}

#[test]
fn identity_permission_does_not_imply_plan_use() {
    let make = |scope: &str| {
        credential(
            TokenResponse {
                access_token: Some("synthetic-access".to_owned()),
                refresh_token: Some("synthetic-refresh".to_owned()),
                id_token: Some("synthetic-id-token".to_owned()),
                token_type: Some("Bearer".to_owned()),
                expires_in: Some(3600),
                scope: Some(scope.to_owned()),
            },
            IdentityClaims {
                sub: "subject".to_owned(),
                exp: 3600,
                iat: 0,
                nonce: None,
                email: Some("unverified@example.com".to_owned()),
                email_verified: Some(false),
            },
            "oaiapp_test".to_owned(),
            format!("urn:uuid:{}", uuid::Uuid::new_v4()),
            None,
            None,
        )
        .unwrap()
    };
    let identity_only = make("openid profile email offline_access");
    assert!(!identity_only.plan_authorized());
    assert!(identity_only.registration().email.is_none());
    let plan = make(SCOPES);
    assert!(plan.plan_authorized());
    assert!(Credential::from_value(&serde_json::to_value(plan).unwrap()).is_ok());
}

#[test]
fn identity_only_signin_requires_no_access_or_refresh_token() {
    let identity = credential(
        TokenResponse {
            access_token: None,
            refresh_token: None,
            id_token: Some("synthetic-identity".to_owned()),
            token_type: None,
            expires_in: None,
            scope: Some("openid profile email".to_owned()),
        },
        IdentityClaims {
            sub: "subject".to_owned(),
            exp: 3600,
            iat: 0,
            nonce: None,
            email: Some("test@example.com".to_owned()),
            email_verified: Some(true),
        },
        "oaiapp_identity".to_owned(),
        format!("urn:uuid:{}", uuid::Uuid::new_v4()),
        None,
        None,
    )
    .unwrap();
    assert!(!identity.plan_authorized());
    assert!(identity.credential().is_err());
    let saved = serde_json::to_value(identity).unwrap();
    assert_eq!(saved["state"], "identity-only");
    assert!(saved.get("access").is_none());
    assert!(StoredAccount::from_value(&saved).is_ok());
}

#[test]
fn disconnected_account_keeps_registration_and_drops_all_tokens() {
    let credential = Credential {
        kind: "oauth".to_owned(),
        flow: "chatgpt-plan".to_owned(),
        access: "synthetic-access".to_owned(),
        refresh: Some("synthetic-refresh".to_owned()),
        expires: 1,
        client_id: "oaiapp_test".to_owned(),
        host_id: format!("urn:uuid:{}", uuid::Uuid::new_v4()),
        issuer: ISSUER.to_owned(),
        subject: "subject".to_owned(),
        id_token: "synthetic-id".to_owned(),
        email: Some("test@example.com".to_owned()),
        scopes: SCOPES.split_whitespace().map(str::to_owned).collect(),
    };
    let connected = StoredAccount::Connected(credential.clone());
    let stored = serde_json::to_value(&connected).unwrap();
    assert_eq!(stored["access"], "synthetic-access");
    assert!(StoredAccount::from_value(&stored)
        .unwrap()
        .credential()
        .is_ok());
    let disconnected = StoredAccount::Disconnected(connected.registration());
    let stored = serde_json::to_value(&disconnected).unwrap();
    for field in ["access", "refresh", "idToken", "scopes", "expires"] {
        assert!(stored.get(field).is_none(), "{field}");
    }
    let saved = StoredAccount::from_value(&stored).unwrap();
    assert!(saved.matches_registration(&connected));
    assert!(saved.credential().is_err());
    assert!(saved.id_token_hint().is_none());
}

#[test]
fn dynamic_entrypoint_is_never_a_saved_registration() {
    assert!(!valid_client_id(DYNAMIC_CLIENT));
    assert!(!valid_client_id(""));
    assert!(!valid_client_id("client with spaces"));
    assert!(valid_client_id("oaiapp_test-client"));
    assert!(valid_host_id(&format!("urn:uuid:{}", uuid::Uuid::new_v4())));
    assert!(!valid_host_id("user@example.com"));
}

#[test]
fn host_registration_survives_restart_and_invalid_data_does_not_rotate_it() {
    super::super::tests::with_temp_dir(|| {
        let first = host_id().unwrap();
        assert_eq!(host_id().unwrap(), first);
        super::super::write_secret_file(
            &super::super::config_dir().join("chatgpt-plan-host-id"),
            "invalid-existing-host",
        )
        .unwrap();
        assert!(host_id().is_err());
    });
}

#[tokio::test]
async fn new_registration_binds_the_exact_loopback_callback_and_pkce() {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let redirect = format!(
        "http://127.0.0.1:{}/auth/callback",
        listener.local_addr().unwrap().port()
    );
    let mut attempt = LoginAttempt {
        listener,
        client: http_client().unwrap(),
        endpoints: Endpoints {
            issuer: ISSUER.to_owned(),
            authorization_endpoint: format!("{ISSUER}/api/accounts/authorize"),
            token_endpoint: format!("{ISSUER}/api/accounts/oauth/token"),
            jwks_uri: format!("{ISSUER}/.well-known/jwks.json"),
            revocation_endpoint: format!("{ISSUER}/api/accounts/oauth/revoke"),
        },
        state: random_value(32),
        nonce: random_value(32),
        verifier: random_value(64),
        redirect: redirect.clone(),
        host_id: format!("urn:uuid:{}", uuid::Uuid::new_v4()),
        existing: None,
        pending_client: None,
        enable_plan_use: false,
    };
    let url = reqwest::Url::parse(&attempt.authorization_url().unwrap()).unwrap();
    let query: std::collections::HashMap<_, _> = url.query_pairs().collect();
    assert_eq!(query["client_id"], DYNAMIC_CLIENT);
    assert_eq!(query["redirect_uri"], redirect);
    assert_eq!(query["resource"], RESOURCE);
    assert_eq!(query["agent_name_hint"], "Ryu");
    assert_eq!(query["state"], attempt.state);
    assert_eq!(query["nonce"], attempt.nonce);
    assert_eq!(query["code_challenge_method"], "S256");
    assert_eq!(
        query["code_challenge"],
        URL_SAFE_NO_PAD.encode(Sha256::digest(attempt.verifier.as_bytes()))
    );
    assert!(!query.contains_key("client_secret"));
    drop(query);
    attempt.pending_client = Some("oaiapp_retained".to_owned());
    attempt.state = random_value(32);
    attempt.nonce = random_value(32);
    attempt.verifier = random_value(64);
    let retried = reqwest::Url::parse(&attempt.authorization_url().unwrap()).unwrap();
    let query: std::collections::HashMap<_, _> = retried.query_pairs().collect();
    assert_eq!(query["client_id"], "oaiapp_retained");
    assert!(!query.contains_key("agent_name_hint"));
    assert!(!query.contains_key("id_token_hint"));
}

#[tokio::test]
async fn callback_exchanges_with_issued_client_and_verifies_identity_before_returning_tokens() {
    use axum::{extract::Form, routing::post, Json};
    for (valid_nonce, expired_code) in [(true, false), (false, false), (true, true)] {
        let callback_listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let redirect = format!(
            "http://127.0.0.1:{}/auth/callback",
            callback_listener.local_addr().unwrap().port()
        );
        let state = random_value(32);
        let nonce = random_value(32);
        let verifier = random_value(64);
        let mut claims = identity_claims();
        claims["nonce"] = serde_json::json!(if valid_nonce {
            nonce.as_str()
        } else {
            "wrong-nonce"
        });
        let tokens = serde_json::json!({ "access_token":"synthetic-issued-access", "refresh_token":"synthetic-issued-refresh",
            "id_token": signed_identity(&claims), "token_type":"Bearer", "expires_in":3600, "scope":SCOPES });
        let captured = Arc::new(Mutex::new(None));
        let capture = captured.clone();
        let token_route = post(
            move |Form(form): Form<std::collections::HashMap<String, String>>| {
                let capture = capture.clone();
                let tokens = tokens.clone();
                async move {
                    *capture.lock().unwrap() = Some(form);
                    if expired_code {
                        (
                            StatusCode::BAD_REQUEST,
                            Json(
                                serde_json::json!({"error":"invalid_grant", "error_description":"synthetic-secret-must-not-escape"}),
                            ),
                        )
                    } else {
                        (StatusCode::OK, Json(tokens))
                    }
                }
            },
        );
        let mock = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let base = format!("http://{}", mock.local_addr().unwrap());
        let app = Router::new().route("/token", token_route).route(
            "/jwks",
            get(|| async {
                Json(
                    serde_json::from_str::<serde_json::Value>(include_str!(
                        "../fixtures/chatgpt-plan-test-jwks.json"
                    ))
                    .unwrap(),
                )
            }),
        );
        let upstream = tokio::spawn(axum::serve(mock, app).into_future());
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let attempt = LoginAttempt {
            listener: callback_listener,
            client: client.clone(),
            endpoints: Endpoints {
                issuer: ISSUER.to_owned(),
                authorization_endpoint: format!("{base}/authorize"),
                token_endpoint: format!("{base}/token"),
                jwks_uri: format!("{base}/jwks"),
                revocation_endpoint: format!("{base}/revoke"),
            },
            state: state.clone(),
            nonce,
            verifier: verifier.clone(),
            redirect: redirect.clone(),
            host_id: format!("urn:uuid:{}", uuid::Uuid::new_v4()),
            existing: None,
            pending_client: None,
            enable_plan_use: false,
        };
        let completion = tokio::spawn(attempt.complete());
        let callback = client
            .get(&redirect)
            .query(&[
                ("state", state.as_str()),
                ("code", "test-code"),
                ("client_id", "oaiapp_test"),
            ])
            .send()
            .await
            .unwrap();
        assert_eq!(callback.status(), StatusCode::OK);
        let result = completion.await.unwrap();
        assert_eq!(result.is_ok(), valid_nonce && !expired_code);
        if expired_code {
            let error = result.as_ref().err().unwrap();
            assert_eq!(retry_registration(error).as_deref(), Some("oaiapp_test"));
            assert!(!error
                .to_string()
                .contains("synthetic-secret-must-not-escape"));
        }
        if let Ok(saved) = result {
            assert!(saved.plan_authorized());
        }
        let form = captured.lock().unwrap().take().unwrap();
        assert_eq!(form["client_id"], "oaiapp_test");
        assert_eq!(form["code_verifier"], verifier);
        assert_eq!(form["redirect_uri"], redirect);
        assert_eq!(form["resource"], RESOURCE);
        assert_eq!(form["grant_type"], "authorization_code");
        assert!(!form.contains_key("client_secret"));
        upstream.abort();
    }
}

#[tokio::test]
async fn callback_rejects_wrong_state_and_consumes_valid_state_once() {
    let (tx, rx) = oneshot::channel();
    let state = Arc::new(CallbackState {
        expected: "expected-state".to_owned(),
        sender: Mutex::new(Some(tx)),
    });
    let query = |state: &str| Callback {
        state: Some(state.to_owned()),
        code: Some("code".to_owned()),
        client_id: Some("oaiapp_test".to_owned()),
        error: None,
    };
    assert_eq!(
        accept(&state, query("wrong-state")),
        CallbackOutcome::Unverified
    );
    assert_eq!(
        accept(&state, query("expected-state")),
        CallbackOutcome::Received
    );
    assert_eq!(
        accept(&state, query("expected-state")),
        CallbackOutcome::AlreadyUsed
    );
    assert_eq!(rx.await.unwrap().code.as_deref(), Some("code"));
}

#[tokio::test]
async fn callback_page_keeps_its_status_and_is_in_the_readers_language() {
    for (outcome, status) in [
        (CallbackOutcome::Received, StatusCode::OK),
        (CallbackOutcome::Unverified, StatusCode::BAD_REQUEST),
        (
            CallbackOutcome::Unavailable,
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
        (CallbackOutcome::AlreadyUsed, StatusCode::GONE),
    ] {
        assert_eq!(callback_page(outcome, "en").status(), status);
    }
    let page = |locale| async move {
        let response = callback_page(CallbackOutcome::Received, locale);
        assert_eq!(response.headers()["content-language"], locale);
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        String::from_utf8(body.to_vec()).unwrap()
    };
    let english = page("en").await;
    assert!(english.contains("<html lang=\"en\" dir=\"ltr\">"));
    assert!(english.contains("Authorization received. Return to Ryu to check the connection."));
    let japanese = page("ja").await;
    assert!(japanese.contains("<html lang=\"ja\" dir=\"ltr\">"));
    let detail =
        crate::i18n::Message::new(crate::i18n::messages::LOGIN_CHATGPT_CALLBACK_RECEIVED_MESSAGE)
            .render("ja");
    assert!(japanese.contains(&detail));
    assert!(page("ar").await.contains("dir=\"rtl\""));
}

#[test]
fn actionable_sign_in_failures_are_coded_core_messages() {
    let failure = anyhow::Error::new(SignInFailure::TimedOut);
    let typed = failure.downcast_ref::<SignInFailure>().copied();
    assert_eq!(typed, Some(SignInFailure::TimedOut));
    assert_eq!(SignInFailure::TimedOut.code(), "chatgpt_plan_timed_out");
    assert_eq!(
        failure.to_string(),
        "ChatGPT sign-in timed out. Start again."
    );
}
