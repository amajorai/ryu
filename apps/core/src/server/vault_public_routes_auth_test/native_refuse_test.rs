use super::*;

/// A caller who is not authenticated must not learn from a refused login which
/// machine identity names exist, which of them log in another way, which are
/// disabled, or why a credential failed: an unknown identity, an identity of
/// another auth method, a disabled identity and a wrong credential get one
/// status and byte-identical body. The operator still gets the real reason,
/// from the audit log.
#[tokio::test]
async fn native_identity_logins_refuse_every_failure_with_one_body() {
    if !in_isolated_process(
        module_path!(),
        "native_identity_logins_refuse_every_failure_with_one_body",
    ) {
        return;
    }
    let fixture = Fixture::new().await;
    // The Kubernetes identity pins its API server through the environment, and
    // its reviewer token variable is left unset: a login is then refused
    // before it makes any network call.
    std::env::set_var(
        "RYU_VAULT_K8S_HOST_PUBAUTH",
        "https://k8s.pubauth.test:6443",
    );
    let wrong_jwt = fixture.jwt(&fixture.other_key);
    let approle = fixture.store.machine_get(&fixture.approle).await.unwrap();

    let (jwt, jwt_off) = identity_pair(
        &fixture,
        "jwt",
        AuthMethod::Jwt(JwtConfig {
            issuer: ISSUER.into(),
            jwks_url: None,
            public_key_pem: Some(fixture.signing_key.public_key_pem()),
            audiences: vec![AUDIENCE.into()],
            bound_claims: BTreeMap::new(),
        }),
    )
    .await;
    let (cert, cert_off) = identity_pair(
        &fixture,
        "cert",
        AuthMethod::Cert(CertAuthConfig {
            ca_pem: test_ca_pem(),
            allowed_common_names: vec!["pubauth-node".into()],
            allowed_dns_sans: Vec::new(),
            allowed_uri_sans: Vec::new(),
        }),
    )
    .await;
    let (aws, aws_off) = identity_pair(
        &fixture,
        "aws",
        AuthMethod::AwsIam(AwsIamAuthConfig {
            bound_iam_principal_arns: vec!["arn:aws:iam::123456789012:role/pubauth".into()],
            server_id_header_value: Some("pubauth.test".into()),
            sts_endpoint: None,
        }),
    )
    .await;
    let (kubernetes, kubernetes_off) = identity_pair(
        &fixture,
        "k8s",
        AuthMethod::Kubernetes(KubernetesAuthConfig {
            host: "https://k8s.pubauth.test:6443".into(),
            ca_pem: None,
            reviewer_jwt_env: Some("RYU_VAULT_K8S_REVIEWER_PUBAUTH".into()),
            bound_service_account_names: vec!["pubauth".into()],
            bound_service_account_namespaces: vec!["pubauth".into()],
            audiences: Vec::new(),
        }),
    )
    .await;

    let (approle_on, approle_off) = identity_pair(
        &fixture,
        "approle",
        AuthMethod::AppRole {
            role_id: String::new(),
        },
    )
    .await;
    let logins = vec![
        NativeLogin {
            path: LOGIN_PATHS[1],
            action: "auth.jwt.login",
            enabled: jwt,
            disabled: jwt_off,
            body: Box::new(move |identity| json!({ "identity": identity, "jwt": wrong_jwt })),
        },
        NativeLogin {
            path: LOGIN_PATHS[2],
            action: "auth.cert.login",
            enabled: cert,
            disabled: cert_off,
            body: Box::new(
                |identity| json!({ "identity": identity, "certificatePem": "x", "proof": "x" }),
            ),
        },
        NativeLogin {
            path: LOGIN_PATHS[3],
            action: "auth.aws_iam.login",
            enabled: aws,
            disabled: aws_off,
            // A GET is not a signed `GetCallerIdentity`: refused before STS.
            body: Box::new(|identity| {
                json!({
                    "identity": identity,
                    "iamHttpRequestMethod": "GET",
                    "iamRequestUrl": "aHR0cHM6Ly9zdHMuYW1hem9uYXdzLmNvbS8=",
                    "iamRequestBody": "QWN0aW9uPUdldENhbGxlcklkZW50aXR5",
                    "iamRequestHeaders": "e30=",
                })
            }),
        },
        NativeLogin {
            path: LOGIN_PATHS[4],
            action: "auth.kubernetes.login",
            enabled: kubernetes,
            disabled: kubernetes_off,
            body: Box::new(|identity| json!({ "identity": identity, "jwt": "x" })),
        },
    ];

    let before = fingerprint(fixture.store).await;
    // Collected rather than asserted one by one, so a failing run lists every
    // route and case it got wrong.
    let mut problems: Vec<String> = Vec::new();
    for login in &logins {
        let cases = [
            ("an unknown identity", UNKNOWN_IDENTITY.to_owned()),
            ("an identity of another auth method", approle.name.clone()),
            ("a disabled identity", login.disabled.name.clone()),
            ("a wrong credential", login.enabled.name.clone()),
        ];
        let mut replies = Vec::new();
        for (label, name) in &cases {
            let body = (login.body)(name).to_string();
            let reply = fixture.call("POST", login.path, &[], Some(&body)).await;
            if reply.status != StatusCode::FORBIDDEN {
                problems.push(format!(
                    "{} {label}: answered {} {}",
                    login.path, reply.status, reply.text
                ));
            }
            for secret in [
                UNKNOWN_IDENTITY,
                approle.name.as_str(),
                login.enabled.name.as_str(),
                login.disabled.name.as_str(),
                "rvt_",
            ] {
                if reply.text.contains(secret) {
                    problems.push(format!(
                        "{} {label}: the body carries `{secret}`: {}",
                        login.path, reply.text
                    ));
                }
            }
            replies.push((*label, reply));
        }
        let (first_label, first) = &replies[0];
        for (label, reply) in &replies[1..] {
            if reply.text != first.text {
                problems.push(format!(
                    "{}: {label} answered `{}` but {first_label} answered `{}`",
                    login.path, reply.text, first.text
                ));
            }
        }
    }

    // AppRole already answers every failure alike; it stays that way.
    let role_id_of = |identity: &MachineIdentity| match &identity.auth {
        AuthMethod::AppRole { role_id } => role_id.clone(),
        other => panic!("an AppRole identity, got {other:?}"),
    };
    let approle_cases = [
        ("an unknown role id", "rid_unknown".to_owned()),
        ("a disabled identity", role_id_of(&approle_off)),
        ("a wrong secret id", role_id_of(&approle_on)),
    ];
    let mut approle_replies = Vec::new();
    for (label, role_id) in &approle_cases {
        let body = json!({ "roleId": role_id, "secretId": "sid_wrong" }).to_string();
        let reply = fixture.call("POST", LOGIN_PATHS[0], &[], Some(&body)).await;
        if reply.status != StatusCode::FORBIDDEN {
            problems.push(format!(
                "{} {label}: answered {} {}",
                LOGIN_PATHS[0], reply.status, reply.text
            ));
        }
        approle_replies.push((*label, reply));
    }
    for (label, reply) in &approle_replies[1..] {
        if reply.text != approle_replies[0].1.text {
            problems.push(format!(
                "{}: {label} answered `{}` but {} answered `{}`",
                LOGIN_PATHS[0], reply.text, approle_replies[0].0, approle_replies[0].1.text
            ));
        }
    }

    let after = fingerprint(fixture.store).await;
    let changed = changed_tables(&before, &after);
    if !changed.is_empty() {
        problems.push(format!("a refused login changed vault state: {changed:?}"));
    }

    // The reason a login was refused is for the operator: one denied audit
    // row per refusal, naming the attempted identity when it was unknown.
    for login in &logins {
        let rows = denied_login_rows(fixture.store, login.action).await;
        let recorded = |actor: Option<&str>, reason: &str, identity: Option<&str>| {
            rows.iter().any(|row| {
                row.actor.kind == "machine"
                    && row.actor.id.as_deref() == actor
                    && row.details["reason"]
                        .as_str()
                        .is_some_and(|text| text.contains(reason))
                    && identity.is_none_or(|name| row.details["identity"].as_str() == Some(name))
            })
        };
        if !recorded(None, "not_found", Some(UNKNOWN_IDENTITY)) {
            problems.push(format!(
                "{}: no denied `{}` row for the unknown identity: {rows:?}",
                login.path, login.action
            ));
        }
        if !recorded(
            Some(approle.id.as_str()),
            "does not use",
            Some(approle.name.as_str()),
        ) {
            problems.push(format!(
                "{}: no denied `{}` row for the identity of another auth method: {rows:?}",
                login.path, login.action
            ));
        }
        if !recorded(
            Some(login.disabled.id.as_str()),
            "disabled",
            Some(login.disabled.name.as_str()),
        ) {
            problems.push(format!(
                "{}: no denied `{}` row for the disabled identity: {rows:?}",
                login.path, login.action
            ));
        }
        if !recorded(Some(login.enabled.id.as_str()), "", None) {
            problems.push(format!(
                "{}: no denied `{}` row, with a reason, for the wrong credential: {rows:?}",
                login.path, login.action
            ));
        }
    }
    assert!(
        problems.is_empty(),
        "{} problem(s):\n{}",
        problems.len(),
        problems.join("\n")
    );
}

/// A login the audit log would not take stays a 503 the caller can retry, and
/// the audit row that records a refusal is best-effort: with fail-closed
/// auditing on, a refused login is still the same 403, never a 503 that would
/// set a refused identity apart. (A sealed vault has no route-level case: no
/// login touches the keyring. The status mapping is pinned by the unit tests
/// of `login_refusal`.)
#[tokio::test]
async fn native_jwt_login_keeps_a_fail_closed_audit_refusal_retryable() {
    if !in_isolated_process(
        module_path!(),
        "native_jwt_login_keeps_a_fail_closed_audit_refusal_retryable",
    ) {
        return;
    }
    let fixture = Fixture::new().await;
    let right_jwt = fixture.jwt(&fixture.signing_key);
    let wrong_jwt = fixture.jwt(&fixture.other_key);
    let login = json!({ "identity": fixture.jwt_identity, "jwt": right_jwt }).to_string();
    let unknown = json!({ "identity": UNKNOWN_IDENTITY, "jwt": right_jwt }).to_string();
    let wrong = json!({ "identity": fixture.jwt_identity, "jwt": wrong_jwt }).to_string();

    let refused = fixture
        .call("POST", LOGIN_PATHS[1], &[], Some(&unknown))
        .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.text);
    {
        let _fail_closed = FailClosed::on();
        for (label, body) in [("unknown identity", &unknown), ("wrong credential", &wrong)] {
            let reply = fixture.call("POST", LOGIN_PATHS[1], &[], Some(body)).await;
            assert_eq!(
                reply.status,
                StatusCode::FORBIDDEN,
                "{label} under fail-closed auditing: {}",
                reply.text
            );
            assert_eq!(
                reply.text, refused.text,
                "{label} under fail-closed auditing"
            );
        }
        let unavailable = fixture
            .call("POST", LOGIN_PATHS[1], &[], Some(&login))
            .await;
        assert_eq!(
            unavailable.status,
            StatusCode::SERVICE_UNAVAILABLE,
            "{}",
            unavailable.text
        );
        assert!(
            unavailable.text.contains("vault_audit_unavailable"),
            "{}",
            unavailable.text
        );
        assert!(!unavailable.text.contains("rvt_"), "{}", unavailable.text);
    }
    // The refusal was about the audit log, not the credential: with the audit
    // log back, the same login is admitted.
    let admitted = fixture
        .call("POST", LOGIN_PATHS[1], &[], Some(&login))
        .await;
    assert_eq!(admitted.status, StatusCode::OK, "{}", admitted.text);
    assert!(admitted.text.contains("rvt_"), "{}", admitted.text);
}

#[tokio::test]
async fn wrapping_routes_refuse_a_missing_or_wrong_wrap_token_and_keep_the_wrapped_value() {
    if !in_isolated_process(
        module_path!(),
        "wrapping_routes_refuse_a_missing_or_wrong_wrap_token_and_keep_the_wrapped_value",
    ) {
        return;
    }
    let fixture = Fixture::new().await;
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let payload = format!("wrapped-value-{tag}");
    let wrapped = fixture
        .store
        .wrap_response(
            json!({ "secret": payload }).to_string().as_bytes(),
            300,
            "pubauth/test",
            &fixture.admin,
        )
        .await
        .unwrap();
    let wrap_token = wrapped.token.clone().expect("a wrapping token");
    let machine_token = fixture.fresh_token().await.token;

    for path in WRAP_PATHS {
        let unknown_body = json!({ "token": UNKNOWN_WRAP_TOKEN }).to_string();
        let machine_body = json!({ "token": machine_token }).to_string();
        let cases: Vec<(&str, Vec<(&str, &str)>, Option<&str>, Option<StatusCode>)> = vec![
            (
                "no wrapping token",
                vec![],
                None,
                Some(StatusCode::BAD_REQUEST),
            ),
            (
                "an empty body",
                vec![],
                Some("{}"),
                Some(StatusCode::BAD_REQUEST),
            ),
            (
                "an empty wrapping token header",
                vec![("x-ryu-wrap-token", "")],
                None,
                Some(StatusCode::BAD_REQUEST),
            ),
            (
                "an unknown token in the body",
                vec![],
                Some(unknown_body.as_str()),
                None,
            ),
            (
                "an unknown token in the wrap header",
                vec![("x-ryu-wrap-token", UNKNOWN_WRAP_TOKEN)],
                None,
                None,
            ),
            (
                "a machine token as the wrapping token",
                vec![],
                Some(machine_body.as_str()),
                None,
            ),
            (
                "a machine token in the wrap header",
                vec![("x-ryu-wrap-token", machine_token.as_str())],
                None,
                None,
            ),
        ];
        for (label, headers, body, expected) in cases {
            fixture
                .assert_refused(
                    label,
                    ("POST", path, &headers, body),
                    expected,
                    &[payload.as_str(), wrap_token.as_str()],
                )
                .await;
        }
    }

    // The refusals left the real wrapped value intact: it describes itself,
    // unwraps once with the right token, and a replay is refused.
    let lookup = fixture
        .call(
            "POST",
            WRAP_PATHS[1],
            &[],
            Some(&json!({ "token": wrap_token }).to_string()),
        )
        .await;
    assert_eq!(lookup.status, StatusCode::OK, "{}", lookup.text);
    assert!(!lookup.text.contains(&payload), "{}", lookup.text);
    let unwrap_body = json!({ "token": wrap_token }).to_string();
    let unwrapped = fixture
        .call("POST", WRAP_PATHS[0], &[], Some(&unwrap_body))
        .await;
    assert_eq!(unwrapped.status, StatusCode::OK, "{}", unwrapped.text);
    assert!(unwrapped.text.contains(&payload), "{}", unwrapped.text);
    fixture
        .assert_refused(
            "a replayed wrapping token",
            ("POST", WRAP_PATHS[0], &[], Some(&unwrap_body)),
            None,
            &[payload.as_str()],
        )
        .await;
}
