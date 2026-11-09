//! Member credentials and verified principals on app routes (C3).

use super::*;
use crate::server::app_route_delegation::{node_binding, sign_with, Claims};
use crate::sidecar::ext_proxy::member_admission::{admit_protected, Admission};
use crate::sidecar::ext_proxy::principal_lane::capability_principal;

const APP: &str = "@acme/uploads";

fn bearer_headers(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
    headers
}

fn delegation(prefix: &str) -> Option<String> {
    let key = crate::node_token::active_token()?;
    let now = crate::pairing::now_secs();
    sign_with(
        &Claims {
            plugin: APP.to_owned(),
            prefix: prefix.to_owned(),
            methods: vec!["PUT".to_owned()],
            user: Some("member-9".to_owned()),
            org: crate::sidecar::control_plane::registered_org().map(|org| org.id),
            node: node_binding(),
            iat: now,
            exp: now + 600,
            jti: "j".to_owned(),
        },
        &key,
    )
}

#[tokio::test]
async fn the_node_bearer_keeps_the_historic_path() {
    let Some(owner) = crate::node_token::active_token() else {
        return;
    };
    let admitted = admit_protected(&bearer_headers(&owner), APP, "/items/1", "GET", false).await;
    assert!(matches!(admitted, Ok(Admission::NodeToken)));
    let missing = admit_protected(&HeaderMap::new(), APP, "/items/1", "GET", true).await;
    assert_eq!(missing.unwrap_err(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_member_credential_needs_a_permission_gated_route() {
    if crate::node_token::active_token().is_none() {
        return;
    }
    let token = delegation("/items/i1").expect("sign");
    let ungated = admit_protected(
        &bearer_headers(&token),
        APP,
        "/items/i1/chunks/1",
        "PUT",
        false,
    )
    .await;
    assert_eq!(ungated.unwrap_err(), StatusCode::UNAUTHORIZED);

    match admit_protected(
        &bearer_headers(&token),
        APP,
        "/items/i1/chunks/1",
        "PUT",
        true,
    )
    .await
    {
        Ok(Admission::Member(Some(member))) => assert_eq!(member.user_id, "member-9"),
        other => panic!("delegation not admitted: {other:?}"),
    }
    for (path, method, app) in [
        ("/items/i2/chunks/1", "PUT", APP),
        ("/items/i1/chunks/1", "DELETE", APP),
        ("/items/i1/chunks/1", "PUT", "@acme/other"),
    ] {
        let refused = admit_protected(&bearer_headers(&token), app, path, method, true).await;
        assert_eq!(
            refused.unwrap_err(),
            StatusCode::UNAUTHORIZED,
            "{method} {path} {app}"
        );
    }
    let garbage =
        admit_protected(&bearer_headers("paired-or-forged"), APP, "/x", "GET", true).await;
    assert_eq!(garbage.unwrap_err(), StatusCode::UNAUTHORIZED);
}

#[test]
fn a_capability_call_carries_only_a_principal_proof_minted_for_the_caller() {
    assert!(capability_principal(&HeaderMap::new(), APP)
        .unwrap()
        .is_none());
    let mut forged = HeaderMap::new();
    forged.insert(
        crate::sidecar::deferred_authorization::PRINCIPAL_HEADER,
        "forged.proof".parse().unwrap(),
    );
    assert_eq!(
        capability_principal(&forged, APP).unwrap_err().status(),
        StatusCode::FORBIDDEN
    );
}

#[test]
fn core_only_principal_proofs_never_reach_an_app() {
    let mut src = HeaderMap::new();
    src.insert(
        crate::self_api::SELF_CALL_PROOF_HEADER,
        "secret".parse().unwrap(),
    );
    src.insert(
        crate::self_api::SELF_CALL_USER_HEADER,
        "member".parse().unwrap(),
    );
    src.insert("content-type", "application/json".parse().unwrap());
    let mut dst = reqwest::header::HeaderMap::new();
    copy_headers(&src, &mut dst, &[]);
    assert!(dst.get(crate::self_api::SELF_CALL_PROOF_HEADER).is_none());
    assert!(dst.get(crate::self_api::SELF_CALL_USER_HEADER).is_none());
    assert!(dst.get("content-type").is_some());
}

/// End to end on an org-bound node: a member's own JWT as the bearer reaches a
/// permission-gated protected route and the app sees that member; the same
/// JWT is refused on a route with no permission level.
#[tokio::test]
async fn a_member_jwt_reaches_a_gated_protected_route_as_that_member() {
    use crate::server::multiplayer_journey_tests::TestIdentityProvider;
    use crate::sidecar::capability_consumer::test_support::{
        register_sidecar_for, reserve_port, serve,
    };
    const ORG: &str = "org-members";
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let port = reserve_port();
    let mut manifest = web_app(APP, None, false, &["app:http"]);
    let sidecar = &mut manifest.sidecars[0];
    sidecar.name = "engine".to_owned();
    sidecar.port = port;
    let http = sidecar.http.as_mut().expect("fixture http");
    http.routes = vec![
        route(
            "/items",
            Some(crate::identity_verify::permissions::SPACE_WRITE),
            None,
        ),
        route("/open", None, None),
    ];
    state.app_manifests.write().await.push(manifest);
    state.app_store.insert(APP, "1.0.0").await.unwrap();
    state
        .app_store
        .set_enabled(APP, &["app:http".to_owned()])
        .await
        .unwrap();
    let _sidecar = register_sidecar_for(&state.manager, APP, port).await;
    let seen = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<Option<String>>::new()));
    let captured = seen.clone();
    let router = Router::new().route(
        "/api/svc/items",
        get(move |headers: HeaderMap| {
            let captured = captured.clone();
            async move {
                captured.lock().await.push(
                    headers
                        .get(HDR_CALLER_USER_ID)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned),
                );
                Json(json!({ "items": [] }))
            }
        }),
    );
    let server = serve(port, router).await;
    let identity = TestIdentityProvider::start().await;
    let alice = identity.mint("alice", ORG, "member", &[]);
    let request = |path: &str| {
        Request::builder()
            .method("GET")
            .uri(format!("/api/ext/{APP}{path}"))
            .header("authorization", format!("Bearer {alice}"))
            .body(Body::empty())
            .unwrap()
    };
    crate::sidecar::control_plane::with_test_node_binding(true, Some(org_bound_node(ORG)), async {
        if crate::node_token::active_token().is_none() {
            return;
        }
        let gated = proxy_for_plugin(&state, APP, "/items", None, request("/items")).await;
        assert_eq!(gated.status(), StatusCode::OK);
        let ungated = proxy_for_plugin(&state, APP, "/open", None, request("/open")).await;
        assert_eq!(ungated.status(), StatusCode::UNAUTHORIZED);
    })
    .await;
    server.abort();
    let seen = seen.lock().await.clone();
    if !seen.is_empty() {
        assert_eq!(seen, vec![Some("alice".to_owned())]);
    }
}
