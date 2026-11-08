//! Identity helpers for route tests and the box rollout gate tests.

use super::*;

fn pkcs8_v1(seed: &[u8; 32]) -> Vec<u8> {
    let mut der = vec![
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
        0x20,
    ];
    der.extend_from_slice(seed);
    der
}

/// Mint an Ed25519-signed Better Auth-shaped JWT whose public key is pinned
/// in Core's JWKS cache, so it passes the production offline verifier.
pub(in crate::server) async fn signed_user_jwt(
    flags: Option<serde_json::Value>,
    exp_offset: i64,
) -> String {
    let extra = flags.map_or_else(|| json!({}), |flags| json!({ "ryu_flags": flags }));
    signed_user_jwt_with_claims(extra, exp_offset).await
}

/// Sign a test user JWT whose payload is the defaults plus `extra`'s keys.
pub(in crate::server) async fn signed_user_jwt_with_claims(
    extra: serde_json::Value,
    exp_offset: i64,
) -> String {
    use base64::Engine as _;
    use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header};
    let seed = [42u8; 32];
    let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
    let public_x =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signing.verifying_key().to_bytes());
    let issuer = crate::identity_verify::install_test_verification_key(
        FLAG_TEST_KID,
        DecodingKey::from_ed_components(&public_x).expect("public key decodes"),
    )
    .await;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default();
    let mut claims = json!({
        "id": "user-box",
        "sub": "user-box",
        "email": "user-box@example.com",
        "orgs": [],
        "iss": issuer,
        "aud": issuer,
        "iat": now,
        "exp": now + exp_offset,
    });
    if let serde_json::Value::Object(extra) = extra {
        for (key, value) in extra {
            claims[key] = value;
        }
    }
    let mut header = Header::new(Algorithm::EdDSA);
    header.kid = Some(FLAG_TEST_KID.to_owned());
    jsonwebtoken::encode(
        &header,
        &claims,
        &EncodingKey::from_ed_der(&pkcs8_v1(&seed)),
    )
    .expect("token signs")
}

pub(super) fn auth_for(
    principal: crate::authorization::Principal,
    caller: Option<crate::identity_verify::VerifiedCaller>,
    token: Option<String>,
) -> ResolvedAuthorization {
    use crate::authorization::*;
    ResolvedAuthorization {
        context: AuthorizationContext {
            credential: CredentialKind::ManagedUserJwt,
            principal,
            capabilities: CapabilitySet::new([Capability::GatewayRoute, Capability::ToolsExec]),
            constraints: GrantConstraints::default(),
            issued_at: 0,
            expires_at: None,
        },
        bindings: crate::authorization::RequestBindings::default(),
        caller,
        verified_user_jwt: token,
    }
}

/// Build the auth a request with this verified user JWT resolves to.
pub(in crate::server) async fn cloud_auth(token: String) -> ResolvedAuthorization {
    let (claims, _) = crate::identity_verify::verify_jwt_with_expiry(&token)
        .await
        .expect("test token verifies");
    let caller = crate::identity_verify::to_caller_for_org(&claims, None);
    auth_for(
        crate::authorization::Principal::User {
            subject_id: caller.user_id.clone(),
        },
        Some(caller),
        Some(token),
    )
}

pub(in crate::server) fn denial_code(error: &ApiError) -> (StatusCode, String) {
    (
        error.0,
        error.1 .0["error"]["code"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    )
}

#[tokio::test]
async fn box_gate_lets_a_local_owner_without_cloud_identity_through() {
    let auth = auth_for(crate::authorization::Principal::Owner, None, None);
    assert_eq!(box_feature_subject(&auth), BoxFeatureSubject::LocalOwner);
    assert!(require_box_backend_feature(&auth).await.is_ok());
}

#[tokio::test]
async fn box_gate_requires_the_signed_flag_for_a_verified_cloud_caller() {
    let enabled = cloud_auth(signed_user_jwt(Some(json!([BOX_BACKEND_FLAG])), 600).await).await;
    assert!(require_box_backend_feature(&enabled).await.is_ok());

    let expected = (
        StatusCode::FORBIDDEN,
        "cloud_environment_feature_unavailable".to_owned(),
    );
    for flags in [
        None,
        Some(json!([])),
        Some(json!(["some.other_flag"])),
        Some(json!({ BOX_BACKEND_FLAG: true })),
    ] {
        let auth = cloud_auth(signed_user_jwt(flags.clone(), 600).await).await;
        let error = require_box_backend_feature(&auth)
            .await
            .expect_err("a claim without the flag fails closed");
        assert_eq!(denial_code(&error), expected, "{flags:?}");
    }
}

#[tokio::test]
async fn box_gate_fails_closed_without_a_verifiable_claim() {
    let expected = (
        StatusCode::FORBIDDEN,
        "cloud_environment_feature_unavailable".to_owned(),
    );
    // A user principal with no JWT at all (e.g. a non-JWT user credential).
    let user = auth_for(
        crate::authorization::Principal::User {
            subject_id: "user-box".into(),
        },
        None,
        None,
    );
    assert_eq!(
        box_feature_subject(&user),
        BoxFeatureSubject::Cloud { token: None }
    );
    let error = require_box_backend_feature(&user).await.unwrap_err();
    assert_eq!(denial_code(&error), expected);

    // An owner principal that does carry a verified caller is a cloud caller.
    let enabled = cloud_auth(signed_user_jwt(Some(json!([BOX_BACKEND_FLAG])), 600).await).await;
    let owner_with_caller = auth_for(
        crate::authorization::Principal::Owner,
        enabled.caller.clone(),
        None,
    );
    let error = require_box_backend_feature(&owner_with_caller)
        .await
        .unwrap_err();
    assert_eq!(denial_code(&error), expected);

    // A token that no longer verifies (expired since admission) carries nothing.
    let mut expired = enabled.clone();
    expired.verified_user_jwt = Some(signed_user_jwt(Some(json!([BOX_BACKEND_FLAG])), -3600).await);
    let error = require_box_backend_feature(&expired).await.unwrap_err();
    assert_eq!(denial_code(&error), expected);
}

#[tokio::test]
async fn box_gate_reads_the_org_the_claim_was_evaluated_for() {
    let token = signed_user_jwt_with_claims(
        json!({ "ryu_flags": [BOX_BACKEND_FLAG], "ryu_flags_org": "org-a" }),
        600,
    )
    .await;
    let flags = crate::identity_verify::verified_feature_flags(&token)
        .await
        .expect("token verifies");
    assert_eq!(flags.org.as_deref(), Some("org-a"));
    assert!(flags.keys.contains(BOX_BACKEND_FLAG));

    let legacy = signed_user_jwt(Some(json!([BOX_BACKEND_FLAG])), 600).await;
    let flags = crate::identity_verify::verified_feature_flags(&legacy)
        .await
        .expect("token verifies");
    assert_eq!(flags.org, None);
}

#[test]
fn box_gate_refuses_a_claim_evaluated_for_another_org() {
    use crate::identity_verify::VerifiedFeatureFlags;
    let expected = (
        StatusCode::FORBIDDEN,
        "cloud_environment_feature_unavailable".to_owned(),
    );
    let claim = |org: Option<&str>| VerifiedFeatureFlags {
        keys: [BOX_BACKEND_FLAG.to_owned()].into_iter().collect(),
        org: org.map(str::to_owned),
    };

    // Same org, a personal node, or a claim with no org context: allowed.
    assert!(box_backend_flag_decision(Some(&claim(Some("org-a"))), Some("org-a")).is_ok());
    assert!(box_backend_flag_decision(Some(&claim(Some("org-a"))), None).is_ok());
    assert!(box_backend_flag_decision(Some(&claim(None)), Some("org-a")).is_ok());

    // Evaluated for another org than the node's: refused.
    let error = box_backend_flag_decision(Some(&claim(Some("org-b"))), Some("org-a"))
        .expect_err("a claim for another org fails closed");
    assert_eq!(denial_code(&error), expected);

    // The org never opens a flag the claim does not carry.
    let closed = VerifiedFeatureFlags {
        keys: std::collections::BTreeSet::new(),
        org: Some("org-a".into()),
    };
    let error = box_backend_flag_decision(Some(&closed), Some("org-a")).unwrap_err();
    assert_eq!(denial_code(&error), expected);
    let error = box_backend_flag_decision(None, Some("org-a")).unwrap_err();
    assert_eq!(denial_code(&error), expected);
}

#[test]
fn save_gate_applies_only_when_box_is_newly_selected() {
    let boxed = box_environment();
    let mut auto = boxed.clone();
    auto.environments[0].runtime.backend = "auto".into();
    let empty = Snapshot::default();

    assert!(newly_selects_box(&empty, &boxed));
    assert!(newly_selects_box(&auto, &boxed));
    // Editing an environment that was already box keeps working.
    let mut edited = boxed.clone();
    edited.environments[0].name = "Renamed".into();
    assert!(!newly_selects_box(&boxed, &edited));
    // Leaving box, or saving non-box environments, never needs the flag.
    assert!(!newly_selects_box(&boxed, &auto));
    assert!(!newly_selects_box(&empty, &auto));
    // A copy under a fresh id is a new selection.
    let mut copied = boxed.clone();
    copied.environments[0].id = "copied-environment".into();
    assert!(newly_selects_box(&boxed, &copied));
}
