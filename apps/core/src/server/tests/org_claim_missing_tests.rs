use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::server::{
    is_bare_forbidden, org_access_not_in_session_response, org_claim_missing,
    ORG_ACCESS_NOT_IN_SESSION,
};
use crate::sidecar::control_plane::{NodeScope, RegisteredNode, RegisteredOrg};
use axum::http::StatusCode;
use axum::response::IntoResponse;

fn caller(org_id: Option<&str>) -> VerifiedCaller {
    VerifiedCaller {
        user_id: "member".to_owned(),
        email: None,
        email_verified: false,
        org_id: org_id.map(str::to_owned),
        role: OrgRole::Member,
        teams: Vec::new(),
    }
}

fn node(scope: NodeScope) -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: "org-1".to_owned(),
            name: "Acme".to_owned(),
            slug: None,
        },
        node_id: "node-1".to_owned(),
        scope,
        team_id: (scope == NodeScope::Team).then(|| "team-1".to_owned()),
        owner_user_id: (scope == NodeScope::Personal).then(|| "member".to_owned()),
    }
}

#[test]
fn a_jwt_without_the_node_org_claim_is_reported_on_org_and_team_nodes() {
    for scope in [NodeScope::Org, NodeScope::Team] {
        assert!(org_claim_missing(&node(scope), &caller(None)));
        assert!(org_claim_missing(&node(scope), &caller(Some("org-2"))));
        assert!(!org_claim_missing(&node(scope), &caller(Some("org-1"))));
    }
}

#[test]
fn a_personal_node_never_reports_a_missing_org_claim() {
    assert!(!org_claim_missing(
        &node(NodeScope::Personal),
        &caller(None)
    ));
}

#[tokio::test]
async fn the_refusal_is_a_coded_403_that_names_no_organization() {
    let response = org_access_not_in_session_response();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body = http_body_util::BodyExt::collect(response.into_body())
        .await
        .unwrap()
        .to_bytes();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["error"]["code"], ORG_ACCESS_NOT_IN_SESSION);
    let message = value["error"]["message"].as_str().unwrap();
    assert!(message.contains("authenticator app"));
    assert!(message.contains("sign in again"));
    assert!(!message.contains("Acme") && !message.contains("org-1"));
}

#[test]
fn only_a_bodyless_403_is_rewritten() {
    assert!(is_bare_forbidden(&StatusCode::FORBIDDEN.into_response()));
    assert!(!is_bare_forbidden(
        &StatusCode::UNAUTHORIZED.into_response()
    ));
    assert!(!is_bare_forbidden(
        &(
            StatusCode::FORBIDDEN,
            axum::Json(serde_json::json!({ "error": "vault_denied" }))
        )
            .into_response()
    ));
    assert!(!is_bare_forbidden(
        &(StatusCode::FORBIDDEN, "personal_node_owner_only").into_response()
    ));
}

/// Route `status` through `attach_verified_caller` for a caller resolved by
/// `require_auth`, on a node registered as `scope`.
async fn probe(
    scope: NodeScope,
    caller_org: Option<&str>,
    status: StatusCode,
) -> (StatusCode, serde_json::Value) {
    use tower::ServiceExt;
    let app = axum::Router::new()
        .route("/probe", axum::routing::get(move || async move { status }))
        .layer(axum::middleware::from_fn(
            crate::server::attach_verified_caller,
        ));
    let mut request = axum::http::Request::builder()
        .uri("/probe")
        .body(axum::body::Body::empty())
        .unwrap();
    request
        .extensions_mut()
        .insert(crate::server::ResolvedAuthorization {
            context: crate::authorization::AuthorizationContext::owner(0),
            bindings: crate::authorization::RequestBindings::default(),
            caller: Some(caller(caller_org)),
            verified_user_jwt: None,
        });
    let response = crate::sidecar::control_plane::with_test_node_binding(
        true,
        Some(node(scope)),
        app.oneshot(request),
    )
    .await
    .unwrap();
    let status = response.status();
    let body = http_body_util::BodyExt::collect(response.into_body())
        .await
        .unwrap()
        .to_bytes();
    let value = if body.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&body).unwrap()
    };
    (status, value)
}

#[tokio::test]
async fn a_bare_refusal_for_a_caller_without_the_org_claim_explains_itself() {
    let (status, body) = probe(NodeScope::Org, None, StatusCode::FORBIDDEN).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], ORG_ACCESS_NOT_IN_SESSION);

    let (status, body) = probe(NodeScope::Team, None, StatusCode::FORBIDDEN).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], ORG_ACCESS_NOT_IN_SESSION);
}

#[tokio::test]
async fn other_answers_pass_through_unchanged() {
    // A member refused for lacking a permission keeps the plain refusal.
    let (status, body) = probe(NodeScope::Org, Some("org-1"), StatusCode::FORBIDDEN).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body.is_null());
    // A personal node's owner-only refusal is not about org claims.
    let (status, body) = probe(NodeScope::Personal, None, StatusCode::FORBIDDEN).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body.is_null());
    // Only refusals are rewritten.
    let (status, body) = probe(NodeScope::Org, None, StatusCode::OK).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.is_null());
}
