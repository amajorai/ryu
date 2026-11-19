//! `/v1/auth/*` login and token self routes.

use super::fixture_test::*;

#[tokio::test]
async fn approle_login_and_token_self_routes() {
    let fixture = fixture(vec![all_caps("default/app/**")]).await;
    let (status, body) = call(
        &fixture.app,
        "POST",
        "/v1/auth/approle/login",
        None,
        Some(json!({ "role_id": fixture.role_id, "secret_id": "sid_wrong" })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body, json!({ "errors": ["permission denied"] }));
    assert!(!body.to_string().contains("sid_wrong"));

    let token = login(&fixture).await;
    let (status, body) = call(
        &fixture.app,
        "GET",
        "/v1/auth/token/lookup-self",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["display_name"], "ci");
    assert!(!body.to_string().contains(&token));

    let (status, body) = call(
        &fixture.app,
        "GET",
        "/v1/sys/internal/ui/mounts/secret/app/db",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["options"]["version"], "2");

    let (status, _) = call(
        &fixture.app,
        "POST",
        "/v1/auth/token/revoke-self",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = call(
        &fixture.app,
        "GET",
        "/v1/auth/token/lookup-self",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body, json!({ "errors": ["permission denied"] }));
}

#[tokio::test]
async fn jwt_login_does_not_reveal_identity_names() {
    let fixture = fixture(vec![all_caps("default/app/**")]).await;
    let mut seen = Vec::new();
    // An unknown identity and an existing AppRole identity look the same.
    for role in ["no-such-identity", "ci"] {
        let (status, body) = call(
            &fixture.app,
            "POST",
            "/v1/auth/jwt/login",
            None,
            Some(json!({ "role": role, "jwt": "e30.e30.sig" })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{role}: {body}");
        assert!(!body.to_string().contains("e30.e30.sig"));
        seen.push(body);
    }
    assert_eq!(seen[0], seen[1]);
}

/// A CA, a client certificate it signed, and the client's key.
struct ClientPki {
    ca_pem: String,
    leaf_pem: String,
    leaf_key: rcgen::KeyPair,
}

fn client_pki(cn: &str) -> ClientPki {
    let ca_key = rcgen::KeyPair::generate().unwrap();
    let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    ca_params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "compat CA");
    let ca_cert = ca_params.self_signed(&ca_key).unwrap();
    let issuer = rcgen::Issuer::new(ca_params, ca_key);
    let leaf_key = rcgen::KeyPair::generate().unwrap();
    let mut leaf_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    leaf_params
        .distinguished_name
        .push(rcgen::DnType::CommonName, cn);
    let leaf = leaf_params.signed_by(&leaf_key, &issuer).unwrap();
    ClientPki {
        ca_pem: ca_cert.pem(),
        leaf_pem: leaf.pem(),
        leaf_key,
    }
}

/// The proof-of-possession JWT a cert login carries, signed by the client key.
fn cert_proof(key: &rcgen::KeyPair, identity: &str) -> String {
    let now = chrono::Utc::now().timestamp();
    let encoding = jsonwebtoken::EncodingKey::from_ec_pem(key.serialize_pem().as_bytes()).unwrap();
    jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::ES256),
        &json!({
            "aud": crate::vault::auth_methods::CERT_LOGIN_AUDIENCE,
            "sub": identity,
            "iat": now,
            "exp": now + 60,
            "jti": uuid::Uuid::new_v4().to_string(),
        }),
        &encoding,
    )
    .unwrap()
}

#[tokio::test]
async fn cert_login_issues_a_token_and_refuses_like_the_native_route() {
    let fixture = fixture(vec![all_caps("default/app/**")]).await;
    let pki = client_pki("node-compat");
    fixture
        .store
        .machine_create(
            "mesh",
            AuthMethod::Cert(crate::vault::auth_methods::CertAuthConfig {
                ca_pem: pki.ca_pem.clone(),
                allowed_common_names: vec!["node-*".into()],
                allowed_dns_sans: vec![],
                allowed_uri_sans: vec![],
            }),
            vec!["ci".into()],
            Some(600),
            &AuditActor::new("user", Some("admin")),
        )
        .await
        .unwrap();
    let body = |name: &str, proof: String| json!({ "name": name, "certificate_pem": pki.leaf_pem, "proof": proof });

    let (status, reply) = call(
        &fixture.app,
        "POST",
        "/v1/auth/cert/login",
        None,
        Some(body("mesh", cert_proof(&pki.leaf_key, "mesh"))),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    let token = reply["auth"]["client_token"].as_str().unwrap().to_owned();
    assert!(token.starts_with("rvt_"));
    assert_eq!(reply["auth"]["policies"], json!(["ci"]));
    assert!(reply["auth"]["lease_duration"].as_i64().unwrap() > 0);
    let (status, _) = call(
        &fixture.app,
        "GET",
        "/v1/auth/token/lookup-self",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // A bad proof and an unknown identity get the same refusal, on /v1 and
    // from the native login response.
    for (name, proof) in [
        ("mesh", "not-a-jwt".to_owned()),
        ("nobody", cert_proof(&pki.leaf_key, "nobody")),
    ] {
        let (status, reply) = call(
            &fixture.app,
            "POST",
            "/v1/auth/cert/login",
            None,
            Some(body(name, proof.clone())),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{name}: {reply}");
        assert_eq!(reply, json!({ "errors": ["permission denied"] }));
        let native = crate::server::vault_api::login_token_response(
            fixture.store.cert_login(name, &pki.leaf_pem, &proof).await,
        );
        assert_eq!(native.status(), StatusCode::FORBIDDEN);
    }
}

/// AWS IAM and Kubernetes logins take Vault's snake_case bodies, refuse every
/// unknown identity with the same 403 the native routes give (so names cannot
/// be enumerated), and reject a malformed body with 400. Their success path
/// needs STS or a TokenReview API and is covered by the store tests.
#[tokio::test]
async fn aws_and_kubernetes_logins_refuse_unknown_identities_like_the_native_routes() {
    let fixture = fixture(vec![all_caps("default/app/**")]).await;
    let aws = json!({
        "role": "nobody",
        "iam_http_request_method": "POST",
        "iam_request_url": "aHR0cHM6Ly9zdHMuYW1hem9uYXdzLmNvbS8=",
        "iam_request_body": "",
        "iam_request_headers": "e30=",
    });
    let kubernetes = json!({ "role": "nobody", "jwt": "header.payload.signature" });
    for (uri, body) in [
        ("/v1/auth/aws/login", aws),
        ("/v1/auth/kubernetes/login", kubernetes),
    ] {
        let (status, reply) = call(&fixture.app, "POST", uri, None, Some(body)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{uri}: {reply}");
        assert_eq!(reply, json!({ "errors": ["permission denied"] }));
        let (status, reply) =
            call(&fixture.app, "POST", uri, None, Some(json!({ "jwt": "x" }))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}: {reply}");
        assert_eq!(reply, json!({ "errors": ["failed to parse JSON input"] }));
    }
    let native = crate::server::vault_api::login_token_response(
        fixture
            .store
            .kubernetes_login("nobody", "header.payload.signature")
            .await,
    );
    assert_eq!(native.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn logins_are_refused_while_sealed() {
    let fixture = fixture(vec![all_caps("default/app/**")]).await;
    seal(&fixture);
    for (uri, body) in [
        (
            "/v1/auth/approle/login",
            json!({ "role_id": fixture.role_id, "secret_id": fixture.secret_id }),
        ),
        ("/v1/auth/jwt/login", json!({ "role": "ci", "jwt": "x" })),
        (
            "/v1/auth/cert/login",
            json!({ "name": "ci", "certificate_pem": "x", "proof": "x" }),
        ),
        (
            "/v1/auth/kubernetes/login",
            json!({ "role": "ci", "jwt": "x" }),
        ),
    ] {
        let (status, reply) = call(&fixture.app, "POST", uri, None, Some(body)).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{uri}: {reply}");
        assert_eq!(reply, json!({ "errors": ["Vault is sealed"] }));
    }
    unseal(&fixture).await;
    login(&fixture).await;
}
