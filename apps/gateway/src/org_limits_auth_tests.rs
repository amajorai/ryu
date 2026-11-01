use super::*;
use crate::budget::BudgetWindow;
use crate::error::GatewayError;

#[tokio::test]
async fn rgw_auth_attributes_only_a_verified_jwt_and_enforces_member_caps() {
    use axum::{response::IntoResponse, routing::get, Router};
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use ed25519_dalek::{Signer, SigningKey};

    const ISSUER: &str = "https://auth.example";
    let app = Router::new().route(
        "/api/control-plane/gateway/resolve",
        get(|headers: axum::http::HeaderMap| async move {
            // Every resolve names the gateway process, so the plane can
            // count the gateways serving the org.
            if headers
                .get(crate::policy::GATEWAY_INSTANCE_HEADER)
                .and_then(|value| value.to_str().ok())
                != Some(crate::policy::gateway_instance_id())
            {
                return axum::http::StatusCode::BAD_REQUEST.into_response();
            }
            axum::Json(serde_json::json!({
                "organization": { "id": "org_test" },
                "standing": { "state": "active", "refuses": "none" },
                "activeGateways": 1,
                "credential": {
                    "id": "cred_9",
                    "purpose": "gateway_relay",
                    "allowedOperations": ["gateway.inference"]
                },
                "policyVersion": "pv1",
                "limits": {
                    "org": null,
                    "memberDefault": {
                        "budgetMicroUsd": 100, "budgetWindow": "daily",
                        "budgetAction": "stop", "downgradeModel": null,
                        "alertThresholdsPct": [], "rpm": 1, "tpm": null
                    },
                    "members": {}, "teams": {}, "keys": {}
                },
                "limitsSpend": {
                    "asOf": chrono::Utc::now().timestamp(),
                    "org": null,
                    "members": {
                        "user-7": {
                            "spentMicroUsd": 60,
                            "windowStart": BudgetWindow::Daily
                                .start(chrono::Utc::now().timestamp())
                        }
                    },
                    "teams": {}, "keys": {}
                }
            }))
            .into_response()
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let config = crate::config::GatewayConfig {
        auth: crate::config::AuthConfig {
            require_auth: true,
            master_key: None,
            api_keys: vec![],
        },
        ..Default::default()
    };
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    let mut state = crate::state::AppState::new_for_test(config, audit, evals);
    state.resolve_cache = Some(crate::policy::ResolveCache::for_test(
        format!("http://{address}"),
        reqwest::Client::new(),
    ));
    let verifier = crate::policy::UserJwtVerifier::for_test(ISSUER);
    let signing = SigningKey::from_bytes(&[4; 32]);
    verifier.install_key("kid1", signing.verifying_key()).await;
    state.user_jwt = Some(verifier);

    let encode = |value: serde_json::Value| URL_SAFE_NO_PAD.encode(value.to_string());
    let input = format!(
        "{}.{}",
        encode(serde_json::json!({ "alg": "EdDSA", "kid": "kid1" })),
        encode(serde_json::json!({
            "id": "user-7", "iss": ISSUER, "aud": ISSUER,
            "exp": chrono::Utc::now().timestamp() + 600,
            "orgs": [{ "id": "org_test", "role": "member" }],
            "teams": [{ "id": "team-a", "org": "org_test", "role": "member" }]
        }))
    );
    let jwt = format!(
        "{input}.{}",
        URL_SAFE_NO_PAD.encode(signing.sign(input.as_bytes()).to_bytes())
    );

    // Without a JWT the spoofable x-ryu-user-id is ignored.
    let anonymous = crate::pipeline::authenticate(
        &state,
        crate::pipeline::AuthInputs {
            raw_api_key: Some("Bearer rgw_token"),
            user_id: Some("spoofed".to_owned()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(anonymous.user_id, None);
    assert_eq!(anonymous.key_id().as_deref(), Some("cred_9"));

    let verified = crate::pipeline::authenticate(
        &state,
        crate::pipeline::AuthInputs {
            raw_api_key: Some("Bearer rgw_token"),
            user_id: Some("spoofed".to_owned()),
            user_jwt: Some(jwt),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(verified.user_id.as_deref(), Some("user-7"));
    assert_eq!(verified.team_id.as_deref(), Some("team-a"));
    // Both requests carry the cached resolution's fetch time, which dates
    // their budget figures for the credit gate.
    assert!(anonymous.budget_resolved_at.is_some());
    assert_eq!(verified.budget_resolved_at, anonymous.budget_resolved_at);
    let limit_ctx = verified.org_limits.as_deref().unwrap();
    assert_eq!(limit_ctx.team_ids, vec!["team-a".to_owned()]);
    assert_eq!(limit_ctx.active_gateways, Some(1));

    // memberDefault applies to the verified member: rpm 1, then a cap.
    assert!(check_request(&state, &verified).is_ok());
    assert!(
        matches!(
            check_request(&state, &verified),
            Err(GatewayError::RateLimited)
        ),
        "second request in the minute"
    );
    assert!(
        check_request(&state, &anonymous).is_ok(),
        "unattributed traffic has no member bucket"
    );
    assert!(evaluate_for(&state, &verified).decision.is_none());
    record_for(&state, &verified, 150);
    let decision = evaluate_for(&state, &verified).decision.unwrap();
    assert_eq!(decision.scope, BudgetScope::Member);
    assert_eq!(decision.action, BudgetAction::Stop);
    assert_eq!(decision.key, "user-7");
    // The fleet aggregate from the same resolve counts too: 60 reported
    // elsewhere plus 150 served here since the snapshot arrived.
    assert_eq!(decision.used, 210);
    server.abort();
}

#[tokio::test]
async fn rgw_auth_binds_team_and_personal_credentials_without_a_jwt() {
    use axum::{response::IntoResponse, routing::get, Router};
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use ed25519_dalek::{Signer, SigningKey};

    const ISSUER: &str = "https://auth.example";
    let app = Router::new().route(
        "/api/control-plane/gateway/resolve",
        get(|headers: axum::http::HeaderMap| async move {
            let binding = match headers
                .get("x-gateway-key")
                .and_then(|value| value.to_str().ok())
            {
                Some("rgw_team") => serde_json::json!({ "teamId": "team-a" }),
                Some("rgw_personal") => serde_json::json!({
                    "ownerUserId": "owner-1",
                    "ownerTeamIds": ["team-o"]
                }),
                _ => return axum::http::StatusCode::UNAUTHORIZED.into_response(),
            };
            let mut credential = serde_json::json!({
                "id": "cred_bound",
                "purpose": "gateway_relay",
                "allowedOperations": ["gateway.inference"]
            });
            for (key, value) in binding.as_object().unwrap() {
                credential[key] = value.clone();
            }
            axum::Json(serde_json::json!({
                "organization": { "id": "org_test" },
                "credential": credential,
                "standing": { "state": "active", "refuses": "none" },
                "limits": {
                    "org": null,
                    "memberDefault": null,
                    "members": { "owner-1": { "rpm": 1 } },
                    "teams": { "team-a": { "rpm": 1 }, "team-o": { "rpm": 5 } },
                    "keys": {}
                }
            }))
            .into_response()
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let config = crate::config::GatewayConfig {
        auth: crate::config::AuthConfig {
            require_auth: true,
            master_key: None,
            api_keys: vec![],
        },
        ..Default::default()
    };
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    let mut state = crate::state::AppState::new_for_test(config, audit, evals);
    state.resolve_cache = Some(crate::policy::ResolveCache::for_test(
        format!("http://{address}"),
        reqwest::Client::new(),
    ));
    let verifier = crate::policy::UserJwtVerifier::for_test(ISSUER);
    let signing = SigningKey::from_bytes(&[5; 32]);
    verifier.install_key("kid1", signing.verifying_key()).await;
    state.user_jwt = Some(verifier);

    // A verified org admin who is on neither bound team nor the owner.
    let encode = |value: serde_json::Value| URL_SAFE_NO_PAD.encode(value.to_string());
    let input = format!(
        "{}.{}",
        encode(serde_json::json!({ "alg": "EdDSA", "kid": "kid1" })),
        encode(serde_json::json!({
            "id": "user-7", "iss": ISSUER, "aud": ISSUER,
            "exp": chrono::Utc::now().timestamp() + 600,
            "orgs": [{ "id": "org_test", "role": "admin" }],
            "teams": [{ "id": "team-b", "org": "org_test", "role": "member" }]
        }))
    );
    let other_jwt = format!(
        "{input}.{}",
        URL_SAFE_NO_PAD.encode(signing.sign(input.as_bytes()).to_bytes())
    );
    let auth = |key: &'static str, jwt: Option<String>| {
        crate::pipeline::authenticate(
            &state,
            crate::pipeline::AuthInputs {
                raw_api_key: Some(key),
                user_jwt: jwt,
                ..Default::default()
            },
        )
    };

    // Team node, no JWT: attributed to the team, whose cap applies.
    let team = auth("Bearer rgw_team", None).await.unwrap();
    assert_eq!(team.user_id, None);
    assert_eq!(team.team_id.as_deref(), Some("team-a"));
    assert_eq!(
        team.org_limits.as_deref().unwrap().team_ids,
        vec!["team-a".to_owned()]
    );
    assert!(check_request(&state, &team).is_ok());
    assert!(
        check_request(&state, &team).is_err(),
        "team rpm applies without a JWT"
    );
    // A verified admin outside the team keeps their identity and teams,
    // and the team's cap still counts the request.
    let admin = auth("Bearer rgw_team", Some(other_jwt.clone()))
        .await
        .unwrap();
    assert_eq!(admin.user_id.as_deref(), Some("user-7"));
    assert_eq!(admin.team_id.as_deref(), Some("team-a"));
    assert_eq!(
        admin.org_limits.as_deref().unwrap().team_ids,
        vec!["team-a".to_owned(), "team-b".to_owned()]
    );
    assert!(check_request(&state, &admin).is_err());

    // Personal node, no JWT: the owner's member cap and teams apply, but
    // the node token alone carries no user identity.
    let personal = auth("Bearer rgw_personal", None).await.unwrap();
    assert_eq!(personal.user_id, None);
    assert_eq!(personal.team_id.as_deref(), Some("team-o"));
    let personal_limits = personal.org_limits.as_deref().unwrap();
    assert_eq!(personal_limits.bound_user_id.as_deref(), Some("owner-1"));
    assert_eq!(personal_limits.team_ids, vec!["team-o".to_owned()]);
    assert_eq!(
        subject_for(&personal).unwrap().user_id.as_deref(),
        Some("owner-1"),
        "spend counts against the owner's member bucket"
    );
    assert!(check_request(&state, &personal).is_ok());
    assert!(
        check_request(&state, &personal).is_err(),
        "owner member rpm applies without a JWT"
    );
    // Another account's JWT is ignored, never a 401, never its identity
    // or teams, and the owner's cap still applies.
    let switched = auth("Bearer rgw_personal", Some(other_jwt)).await.unwrap();
    assert_eq!(switched.user_id, None);
    assert_eq!(
        switched.org_limits.as_deref().unwrap().team_ids,
        vec!["team-o".to_owned()]
    );
    assert!(check_request(&state, &switched).is_err());
    server.abort();
}
