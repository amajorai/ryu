use super::*;
use crate::server::app_route_delegation::{verify_request, DelegationRefusal};

const APP: &str = "@example/uploads";

fn manifest() -> crate::plugin_manifest::PluginManifest {
    serde_json::from_value(json!({
        "id": APP, "name": "Uploads", "version": "1.0.0", "runnables": [],
        "permission_levels": [{ "id": "uploads.write", "label": "Write", "description": "Upload items." }],
        "sidecars": [{
            "name": "uploads",
            "process": { "kind": "binary", "url": "https://example.com/u", "version": "1.0.0" },
            "port": 19999,
            "health_path": "/health",
            "http": { "routes": [
                { "path": "/items/:id/chunks/:seq", "method": "PUT", "permission": "uploads.write" },
                { "path": "/open/:id", "method": "GET" }
            ] }
        }]
    }))
    .expect("manifest parses")
}

async fn state_with_app(directory: &std::path::Path, enabled: bool) -> ServerState {
    let state = crate::server::isolated_plugin_hook_test_state(directory);
    state.app_store.insert(APP, "1.0.0").await.unwrap();
    if enabled {
        state.app_store.set_enabled(APP, &[]).await.unwrap();
    }
    state.app_manifests.write().await.push(manifest());
    state
}

fn request(prefix: &str, methods: &[&str]) -> Json<MintRequest> {
    Json(MintRequest {
        plugin_id: APP.to_owned(),
        path_prefix: prefix.to_owned(),
        methods: methods.iter().map(|m| (*m).to_owned()).collect(),
        ttl_seconds: Some(600),
    })
}

#[test]
fn only_a_permission_gated_route_makes_a_prefix_delegable() {
    let manifest = manifest();
    assert!(prefix_has_gated_route(
        &manifest,
        "/items/i1",
        &["PUT".to_owned()]
    ));
    assert!(!prefix_has_gated_route(
        &manifest,
        "/items/i1",
        &["GET".to_owned()]
    ));
    assert!(!prefix_has_gated_route(
        &manifest,
        "/open/o1",
        &["GET".to_owned()]
    ));
    assert!(!prefix_has_gated_route(
        &manifest,
        "/elsewhere",
        &["PUT".to_owned()]
    ));
}

#[test]
fn a_shared_node_delegation_always_names_the_member_who_asked() {
    let member = VerifiedCaller {
        user_id: "member-1".to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org-1".to_owned()),
        role: crate::identity_verify::OrgRole::Member,
        teams: Vec::new(),
    };
    assert!(delegation_subject(true, Some("org-1".to_owned()), None).is_err());
    assert_eq!(
        delegation_subject(true, Some("org-1".to_owned()), Some(&member)),
        Ok((Some("member-1".to_owned()), Some("org-1".to_owned())))
    );
    assert!(delegation_subject(true, Some("org-2".to_owned()), Some(&member)).is_err());
    assert_eq!(delegation_subject(false, None, None), Ok((None, None)));
    assert_eq!(
        delegation_subject(false, None, Some(&member)),
        Ok((Some("member-1".to_owned()), None))
    );
}

#[tokio::test]
async fn a_minted_delegation_admits_only_its_slice() {
    if crate::sidecar::control_plane::registered_org().is_some()
        || crate::node_token::active_token().is_none()
    {
        return; // Needs the isolated unbound test node.
    }
    let directory = tempfile::tempdir().unwrap();
    let state = state_with_app(directory.path(), true).await;
    let (status, Json(body)) = mint(
        State(state),
        Extension(None),
        request("/items/i1", &["put"]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["methods"], json!(["PUT"]));
    let token = body["token"].as_str().expect("token");
    let user = |path: &str, method: &str| {
        verify_request(token, APP, path, method).map(|caller| caller.map(|c| c.user_id))
    };
    assert_eq!(user("/items/i1/chunks/1", "PUT"), Ok(None));
    assert_eq!(
        user("/items/i2/chunks/1", "PUT"),
        Err(DelegationRefusal::OutsidePrefix)
    );
    assert_eq!(
        user("/items/i1/chunks/1", "DELETE"),
        Err(DelegationRefusal::MethodNotAllowed)
    );
}

#[tokio::test]
async fn minting_refuses_bad_requests_and_disabled_apps() {
    let directory = tempfile::tempdir().unwrap();
    let state = state_with_app(directory.path(), true).await;
    let (status, _) = mint(
        State(state.clone()),
        Extension(None),
        request("/open/o1", &["GET"]),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = mint(
        State(state.clone()),
        Extension(None),
        request("/items/i1", &["TRACE"]),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = mint(
        State(state.clone()),
        Extension(None),
        request("/items/../x", &["PUT"]),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let mut long = request("/items/i1", &["PUT"]);
    long.0.ttl_seconds = Some(MAX_TTL_SECONDS + 1);
    let (status, _) = mint(State(state), Extension(None), long).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let disabled = tempfile::tempdir().unwrap();
    let state = state_with_app(disabled.path(), false).await;
    let (status, _) = mint(
        State(state),
        Extension(None),
        request("/items/i1", &["PUT"]),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
