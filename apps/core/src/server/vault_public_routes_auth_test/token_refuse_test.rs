use super::*;

/// A child whose name matches no test exits 0 having run nothing, so the
/// parent must not read that as a pass: a renamed function or a typo in a
/// call site would otherwise leave its isolated case asserting nothing.
#[test]
#[should_panic(expected = "ran no test")]
fn an_isolated_child_that_matches_no_test_is_a_failure() {
    in_isolated_process(module_path!(), "no_such_vault_public_routes_test");
}

#[tokio::test]
async fn token_guarded_routes_refuse_a_missing_or_wrong_token_and_change_nothing() {
    if !in_isolated_process(
        module_path!(),
        "token_guarded_routes_refuse_a_missing_or_wrong_token_and_change_nothing",
    ) {
        return;
    }
    let fixture = Fixture::new().await;
    let valid = fixture.fresh_token().await.token;
    let revoked = fixture.revoked_token().await;
    let disabled = fixture.disabled_identity_token().await;
    let mut attempts = 0;
    for route in ROUTES {
        let uri = route.uri();
        let (status, needle) = match route.guard {
            Guard::Agent | Guard::Broker => (StatusCode::UNAUTHORIZED, "vault_token_invalid"),
            Guard::Compat => (StatusCode::FORBIDDEN, "permission denied"),
        };
        for (label, headers) in refused_credentials(route.guard, &valid, &revoked, &disabled) {
            let headers: Vec<(&str, &str)> = headers
                .iter()
                .map(|(name, value)| (*name, value.as_str()))
                .collect();
            let reply = fixture
                .assert_refused(
                    label,
                    (route.method, &uri, &headers, route.body),
                    Some(status),
                    &[
                        valid.as_str(),
                        revoked.as_str(),
                        disabled.as_str(),
                        fixture.secret_value.as_str(),
                    ],
                )
                .await;
            assert!(
                reply.text.contains(needle),
                "{label}: {} {uri} refused without `{needle}`: {}",
                route.method,
                reply.text
            );
            attempts += 1;
        }
    }
    // 22 agent routes x 8 credentials, 5 broker routes x 10, 15 compat routes
    // x 7: a route or a credential that silently stops being tried shows up
    // as a different count.
    assert_eq!(attempts, 22 * 8 + 5 * 10 + 15 * 7);
}

#[tokio::test]
async fn token_guarded_routes_admit_a_valid_token_so_the_refusals_are_credential_driven() {
    if !in_isolated_process(
        module_path!(),
        "token_guarded_routes_admit_a_valid_token_so_the_refusals_are_credential_driven",
    ) {
        return;
    }
    let fixture = Fixture::new().await;

    // The routes that return a secret return it to a valid token: the value a
    // refusal must never show is really there to be shown.
    let token = fixture.fresh_token().await.token;
    let reads = [
        (
            "x-ryu-vault-token",
            "GET",
            "/api/vault/agent/secrets/PUBAUTH_SECRET",
            None,
        ),
        (
            "x-ryu-vault-token",
            "POST",
            "/api/vault/agent/export",
            Some("{}"),
        ),
        ("x-vault-token", "GET", "/v1/secret/data/app/db", None),
    ];
    for (header, method, uri, body) in reads {
        let reply = fixture
            .call(method, uri, &[(header, token.as_str())], body)
            .await;
        assert_eq!(
            reply.status,
            StatusCode::OK,
            "{method} {uri}: {}",
            reply.text
        );
        assert!(
            reply.text.contains(&fixture.secret_value),
            "{method} {uri} did not return the secret: {}",
            reply.text
        );
    }

    for route in ROUTES {
        // A fresh token per route: some routes revoke the token they get.
        let token = fixture.fresh_token().await.token;
        let uri = route.uri();
        let header = match route.guard {
            Guard::Agent | Guard::Broker => "x-ryu-vault-token",
            Guard::Compat => "x-vault-token",
        };
        let reply = fixture
            .call(route.method, &uri, &[(header, token.as_str())], route.body)
            .await;
        assert_ne!(
            reply.status,
            StatusCode::UNAUTHORIZED,
            "{} {uri}: a valid token was refused as a credential: {}",
            route.method,
            reply.text
        );
        assert!(
            !reply.text.contains("vault_token_invalid"),
            "{} {uri}: a valid token was refused as a credential: {} {}",
            route.method,
            reply.status,
            reply.text
        );
        if route.guard == Guard::Compat {
            // The compat surface refuses with 403; a token holding every
            // capability is not refused.
            assert_ne!(
                reply.status,
                StatusCode::FORBIDDEN,
                "{} {uri}: a valid token with every capability was denied: {}",
                route.method,
                reply.text
            );
        }
    }
}

#[tokio::test]
async fn broker_routes_also_refuse_a_machine_token_in_the_session_slot() {
    if !in_isolated_process(
        module_path!(),
        "broker_routes_also_refuse_a_machine_token_in_the_session_slot",
    ) {
        return;
    }
    let fixture = Fixture::new().await;
    let valid = fixture.fresh_token().await.token;
    let bearer = format!("Bearer {valid}");
    // `rvb_` sessions are the second credential on the broker routes; a
    // machine token presented as a session credential is not one.
    for uri in [
        "/api/vault/agent/broker/discover",
        "/api/vault/agent/broker/proposals/sample",
        "/api/vault/agent/cards/approvals/sample",
    ] {
        for header in ["authorization", "proxy-authorization"] {
            fixture
                .assert_refused(
                    "machine token as session",
                    ("GET", uri, &[(header, bearer.as_str())], None),
                    Some(StatusCode::UNAUTHORIZED),
                    &[valid.as_str(), fixture.secret_value.as_str()],
                )
                .await;
        }
    }
}

#[tokio::test]
async fn machine_logins_refuse_wrong_credentials_mint_nothing_and_burn_no_secret_id() {
    if !in_isolated_process(
        module_path!(),
        "machine_logins_refuse_wrong_credentials_mint_nothing_and_burn_no_secret_id",
    ) {
        return;
    }
    let fixture = Fixture::new().await;
    let secret_id = fixture.new_secret_id().await;
    let right_jwt = fixture.jwt(&fixture.signing_key);
    let wrong_jwt = fixture.jwt(&fixture.other_key);
    let role_id = fixture.role_id.clone();
    let jwt_identity = fixture.jwt_identity.clone();
    let approle = fixture.approle.clone();

    // `(label, path, body, exact refusal status)`; `None` accepts any 4xx.
    //
    // Every identity login refuses with 403 whatever went wrong: an unknown
    // identity name, an identity that logs in another way and a wrong
    // credential all look the same, so a caller cannot learn which machine
    // identity names exist or how they log in. The bodies are compared in
    // `native_identity_logins_refuse_every_failure_with_one_body`.
    let denied = Some(StatusCode::FORBIDDEN);
    let attempts: Vec<(&str, &str, Value, Option<StatusCode>)> = vec![
        (
            "approle with a wrong secret id",
            LOGIN_PATHS[0],
            json!({ "roleId": role_id, "secretId": "sid_wrong" }),
            denied,
        ),
        (
            "approle with a wrong role id and a real secret id",
            LOGIN_PATHS[0],
            json!({ "roleId": "rid_wrong", "secretId": secret_id }),
            denied,
        ),
        (
            "approle with empty credentials",
            LOGIN_PATHS[0],
            json!({ "roleId": "", "secretId": "" }),
            denied,
        ),
        (
            "approle with no credentials at all",
            LOGIN_PATHS[0],
            json!({}),
            None,
        ),
        (
            "jwt signed by another key",
            LOGIN_PATHS[1],
            json!({ "identity": jwt_identity, "jwt": wrong_jwt }),
            denied,
        ),
        (
            "jwt that is not a jwt",
            LOGIN_PATHS[1],
            json!({ "identity": jwt_identity, "jwt": "not.a.jwt" }),
            denied,
        ),
        (
            "jwt that is empty",
            LOGIN_PATHS[1],
            json!({ "identity": jwt_identity, "jwt": "" }),
            denied,
        ),
        (
            "jwt for an unknown identity",
            LOGIN_PATHS[1],
            json!({ "identity": "nobody-pubauth", "jwt": right_jwt }),
            denied,
        ),
        (
            "jwt for an identity that logs in with an approle",
            LOGIN_PATHS[1],
            json!({ "identity": approle, "jwt": right_jwt }),
            denied,
        ),
        (
            "certificate login for an unknown identity",
            LOGIN_PATHS[2],
            json!({ "identity": "nobody-pubauth", "certificatePem": "x", "proof": "x" }),
            denied,
        ),
        (
            "certificate login for an approle identity",
            LOGIN_PATHS[2],
            json!({ "identity": approle, "certificatePem": "x", "proof": "x" }),
            denied,
        ),
        (
            "aws login for an unknown identity",
            LOGIN_PATHS[3],
            json!({
                "identity": "nobody-pubauth",
                "iamHttpRequestMethod": "POST",
                "iamRequestUrl": "aHR0cHM6Ly9zdHMuYW1hem9uYXdzLmNvbS8=",
                "iamRequestBody": "QWN0aW9uPUdldENhbGxlcklkZW50aXR5",
                "iamRequestHeaders": "e30=",
            }),
            denied,
        ),
        (
            "aws login for an approle identity",
            LOGIN_PATHS[3],
            json!({
                "identity": approle,
                "iamHttpRequestMethod": "POST",
                "iamRequestUrl": "aHR0cHM6Ly9zdHMuYW1hem9uYXdzLmNvbS8=",
                "iamRequestBody": "QWN0aW9uPUdldENhbGxlcklkZW50aXR5",
                "iamRequestHeaders": "e30=",
            }),
            denied,
        ),
        (
            "kubernetes login for an unknown identity",
            LOGIN_PATHS[4],
            json!({ "identity": "nobody-pubauth", "jwt": "x" }),
            denied,
        ),
        (
            "kubernetes login for an approle identity",
            LOGIN_PATHS[4],
            json!({ "identity": approle, "jwt": "x" }),
            denied,
        ),
        (
            "compat approle with a wrong secret id",
            COMPAT_LOGIN_PATHS[0],
            json!({ "role_id": role_id, "secret_id": "sid_wrong" }),
            denied,
        ),
        (
            "compat approle with a wrong role id and a real secret id",
            COMPAT_LOGIN_PATHS[0],
            json!({ "role_id": "rid_wrong", "secret_id": secret_id }),
            denied,
        ),
        (
            "compat approle with no credentials",
            COMPAT_LOGIN_PATHS[0],
            json!({}),
            None,
        ),
        (
            "compat jwt signed by another key",
            COMPAT_LOGIN_PATHS[1],
            json!({ "role": jwt_identity, "jwt": wrong_jwt }),
            denied,
        ),
        (
            "compat jwt for an unknown identity",
            COMPAT_LOGIN_PATHS[1],
            json!({ "role": "nobody-pubauth", "jwt": right_jwt }),
            denied,
        ),
        (
            "compat jwt with no credentials",
            COMPAT_LOGIN_PATHS[1],
            json!({}),
            None,
        ),
    ];
    for (label, path, body, expected) in &attempts {
        let reply = fixture
            .assert_refused(
                label,
                ("POST", path, &[], Some(&body.to_string())),
                *expected,
                &["rvt_", "client_token", fixture.secret_value.as_str()],
            )
            .await;
        assert!(
            !reply.status.is_success(),
            "{label}: {path} answered {}",
            reply.status
        );
    }

    // The same credentials, corrected, are accepted: the refusals above were
    // about the credential, and they did not consume the real secret id.
    let accepted = [
        (
            "approle",
            LOGIN_PATHS[0],
            json!({ "roleId": role_id, "secretId": secret_id }),
        ),
        (
            "jwt",
            LOGIN_PATHS[1],
            json!({ "identity": jwt_identity, "jwt": right_jwt }),
        ),
        (
            "compat approle",
            COMPAT_LOGIN_PATHS[0],
            json!({ "role_id": role_id, "secret_id": fixture.new_secret_id().await }),
        ),
        (
            "compat jwt",
            COMPAT_LOGIN_PATHS[1],
            json!({ "role": jwt_identity, "jwt": right_jwt }),
        ),
    ];
    for (label, path, body) in accepted {
        let reply = fixture
            .call("POST", path, &[], Some(&body.to_string()))
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{label}: {}", reply.text);
        assert!(reply.text.contains("rvt_"), "{label}: {}", reply.text);
    }
}
