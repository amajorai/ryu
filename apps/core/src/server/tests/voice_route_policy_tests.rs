use crate::authorization::{Capability, RoutePolicy};
use crate::server::route_policy;
use axum::http::Method;

#[test]
fn member_dictation_and_read_aloud_need_chat_capabilities() {
    assert_eq!(
        route_policy(&Method::POST, "/api/voice/transcribe"),
        RoutePolicy::requires([Capability::ChatWrite])
    );
    assert_eq!(
        route_policy(&Method::POST, "/api/voice/speak"),
        RoutePolicy::requires([Capability::ChatWrite])
    );
    for path in ["/api/voice/tts-engines", "/api/voice/tts-models"] {
        assert_eq!(
            route_policy(&Method::GET, path),
            RoutePolicy::requires([Capability::ChatRead]),
            "{path}"
        );
    }
}

#[test]
fn voice_installs_and_speech_processing_stay_owner_only() {
    for (method, path) in [
        (Method::POST, "/api/voice/tts-engines/install"),
        (Method::POST, "/api/voice/tts-models/install"),
        (Method::POST, "/api/voice/speech-processing"),
        (Method::POST, "/api/voice/speech-processing-model/install"),
        (Method::GET, "/api/voice/speech-processing-engines"),
        (Method::POST, "/api/voice/tts-engines"),
        (Method::GET, "/api/voice/transcribe/extra"),
    ] {
        assert_eq!(
            route_policy(&method, path),
            RoutePolicy::OwnerOnly,
            "{method} {path}"
        );
    }
}

const NODE_TOKEN: &str = "node-owner-secret";

fn acme_node() -> crate::sidecar::control_plane::RegisteredNode {
    use crate::sidecar::control_plane::{NodeScope, RegisteredNode, RegisteredOrg};
    RegisteredNode {
        org: RegisteredOrg {
            id: "org-acme".to_owned(),
            name: "Acme".to_owned(),
            slug: None,
        },
        node_id: "node-acme".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    }
}

fn bearer(token: &str) -> axum::http::HeaderMap {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
    headers
}

async fn grant(headers: axum::http::HeaderMap) -> Option<crate::server::MemberVoiceGrant> {
    crate::sidecar::control_plane::with_test_node_binding(
        true,
        Some(acme_node()),
        crate::server::authorize_member_voice_ticket_with_token(
            &headers,
            Some(NODE_TOKEN.to_owned()),
        ),
    )
    .await
}

#[tokio::test]
async fn a_chatting_member_gets_a_voice_grant_with_their_identity_and_expiry() {
    let idp = crate::server::multiplayer_journey_tests::TestIdentityProvider::start().await;
    let jwt = idp.mint("member-1", "org-acme", "member", &[]);
    let grant = grant(bearer(&jwt))
        .await
        .expect("a member who may chat may talk");
    assert_eq!(grant.caller.user_id, "member-1");
    assert!(grant.expires_at > chrono::Utc::now().timestamp());
    assert_eq!(grant.user_jwt.as_deref(), Some(jwt.as_str()));
}

#[tokio::test]
async fn credentials_chat_would_refuse_get_no_voice_grant() {
    let idp = crate::server::multiplayer_journey_tests::TestIdentityProvider::start().await;
    // A viewer cannot write chat, so cannot run a voice session either.
    let viewer = idp.mint("viewer-1", "org-acme", "viewer", &[]);
    assert!(grant(bearer(&viewer)).await.is_none());
    // A member of a different organization.
    let outsider = idp.mint("outsider-1", "org-other", "member", &[]);
    assert!(grant(bearer(&outsider)).await.is_none());
    // An identity header naming someone else than the bearer.
    let member = idp.mint("member-1", "org-acme", "member", &[]);
    let other = idp.mint("member-2", "org-acme", "member", &[]);
    let mut mismatched = bearer(&member);
    mismatched.insert(crate::server::USER_JWT_HEADER, other.parse().unwrap());
    assert!(grant(mismatched).await.is_none());
    // No credential, garbage, and the owner token (the issuer's own path).
    assert!(grant(axum::http::HeaderMap::new()).await.is_none());
    assert!(grant(bearer("not-a-credential")).await.is_none());
    assert!(grant(bearer(NODE_TOKEN)).await.is_none());
}

#[tokio::test]
async fn a_tokenless_node_never_admits_members() {
    let idp = crate::server::multiplayer_journey_tests::TestIdentityProvider::start().await;
    let jwt = idp.mint("member-1", "org-acme", "member", &[]);
    let headers = bearer(&jwt);
    let grant = crate::sidecar::control_plane::with_test_node_binding(
        true,
        Some(acme_node()),
        crate::server::authorize_member_voice_ticket_with_token(&headers, None),
    )
    .await;
    assert!(grant.is_none());
}

fn context(
    credential: crate::authorization::CredentialKind,
    client_id: Option<&str>,
) -> crate::authorization::AuthorizationContext {
    crate::authorization::AuthorizationContext {
        credential,
        principal: crate::authorization::Principal::User {
            subject_id: "member-1".into(),
        },
        capabilities: crate::authorization::CapabilitySet::new([
            Capability::ChatRead,
            Capability::ChatWrite,
        ]),
        constraints: crate::authorization::GrantConstraints {
            client_id: client_id.map(str::to_owned),
            ..Default::default()
        },
        issued_at: 0,
        expires_at: None,
    }
}

#[test]
fn only_member_sessions_reach_voice_http_with_chat_capabilities() {
    use crate::authorization::CredentialKind;
    let node_list = Some(crate::authorization::delegation::NODE_LIST_CLIENT_ID);
    let admitted = [
        context(CredentialKind::ManagedUserJwt, None),
        context(CredentialKind::ManagedDelegation, node_list),
    ];
    let refused = [
        context(CredentialKind::ManagedDelegation, Some("hosted-mcp-client")),
        context(CredentialKind::HostedOAuth, None),
        context(
            CredentialKind::PairedCapability {
                grant_id: "grant-1".into(),
            },
            None,
        ),
    ];
    for path in ["/api/voice/transcribe", "/api/voice/speak"] {
        for context in &admitted {
            assert_eq!(
                crate::server::credential_route_policy(&Method::POST, path, context, true),
                RoutePolicy::requires([Capability::ChatWrite]),
                "{path} {:?}",
                context.credential
            );
        }
        for context in &refused {
            assert_eq!(
                crate::server::credential_route_policy(&Method::POST, path, context, true),
                RoutePolicy::OwnerOnly,
                "{path} {:?}",
                context.credential
            );
        }
    }
}

#[test]
fn members_may_name_only_built_in_voices() {
    for voice in ["alba", "en_US-amy-medium", "af_heart", "v2.1"] {
        assert!(crate::server::voice::is_plain_voice_id(voice), "{voice}");
    }
    for voice in [
        "",
        "/home/owner/voice/reference-audio/me.wav",
        "../me.wav",
        ".hidden",
        "https://example.com/sample.wav",
        "C:\\voices\\me.wav",
        "voice with spaces",
        "owner.wav",
        "Sample.MP3",
        &"a".repeat(65),
    ] {
        assert!(!crate::server::voice::is_plain_voice_id(voice), "{voice}");
    }
}
