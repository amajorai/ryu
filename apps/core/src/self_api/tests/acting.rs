//! The org-bound role gate, the self-call proof, and the loopback dispatch.

use super::*;

#[test]
fn gateway_routes_need_view_to_read_and_configure_to_change() {
    assert_eq!(
        required_permission("/api/gateway/config", "GET"),
        Some("gateway.view")
    );
    assert_eq!(
        required_permission("/api/gateway/config", "PUT"),
        Some("gateway.configure")
    );
    assert_eq!(
        required_permission("/api/routing/policy", "PUT"),
        Some("gateway.configure")
    );
    assert_eq!(
        required_permission("/api/gateway/audit", "GET"),
        Some("audit.view")
    );
    // Anything without a declared permission is closed on shared nodes.
    assert_eq!(
        required_permission("/api/gateway/audit/usage", "POST"),
        None
    );
    assert_eq!(required_permission("/api/preferences/{key}", "PUT"), None);
    assert_eq!(
        required_permission("/api/models/{id}/launch-config", "PUT"),
        None
    );
}

#[test]
fn an_org_member_acts_only_within_their_own_role_and_from_a_private_chat() {
    let put = route("PUT", "/api/gateway/config");
    let get = route("GET", "/api/gateway/config");
    let member = |private_conversation| ActingUser {
        user_id: "u-member",
        org_id: Some("org-1"),
        private_conversation,
    };
    let viewer_set: HashSet<String> = ["gateway.view".to_owned()].into();
    let admin_set: HashSet<String> =
        ["gateway.view".to_owned(), "gateway.configure".to_owned()].into();

    // A member who can view but not configure may read, not change.
    assert!(acting_user_refusal(&get, &member(true), "org-1", None, &viewer_set).is_none());
    let refusal = acting_user_refusal(&put, &member(true), "org-1", None, &viewer_set)
        .expect("no gateway.configure, no change");
    assert!(refusal.contains("gateway.configure"));

    // An admin may change it, but only from a private chat.
    assert!(acting_user_refusal(&put, &member(true), "org-1", None, &admin_set).is_none());
    assert!(acting_user_refusal(&put, &member(false), "org-1", None, &admin_set).is_some());

    // A person from another organization holds nothing here.
    let outsider = ActingUser {
        user_id: "u-other",
        org_id: Some("org-2"),
        private_conversation: true,
    };
    assert!(acting_user_refusal(&get, &outsider, "org-1", None, &admin_set).is_some());

    // A failed permission lookup is an empty set, which refuses.
    assert!(acting_user_refusal(&get, &member(true), "org-1", None, &HashSet::new()).is_some());

    // The owner of a Personal-scope node keeps full trust on their own node.
    assert!(acting_user_refusal(
        &put,
        &member(true),
        "org-1",
        Some("u-member"),
        &HashSet::new()
    )
    .is_none());

    // Routes with no declared permission stay closed, whatever the role.
    let preference = route("PUT", "/api/preferences/{key}");
    assert!(acting_user_refusal(&preference, &member(true), "org-1", None, &admin_set).is_some());
}

#[test]
fn only_the_in_process_proof_names_who_a_self_call_acts_for() {
    use axum::http::{HeaderMap, HeaderValue};
    let mut headers = HeaderMap::new();
    assert!(matches!(
        self_call_identity(&headers),
        SelfCallIdentity::Absent
    ));

    headers.insert(SELF_CALL_PROOF_HEADER, HeaderValue::from_static("guess"));
    headers.insert(SELF_CALL_USER_HEADER, HeaderValue::from_static("u-1"));
    assert!(matches!(
        self_call_identity(&headers),
        SelfCallIdentity::Invalid
    ));

    headers.insert(
        SELF_CALL_PROOF_HEADER,
        HeaderValue::from_str(self_call_proof()).unwrap(),
    );
    assert!(matches!(
        self_call_identity(&headers),
        SelfCallIdentity::Acting(user) if user == "u-1"
    ));

    headers.insert(SELF_CALL_USER_HEADER, HeaderValue::from_static("  "));
    assert!(matches!(
        self_call_identity(&headers),
        SelfCallIdentity::Invalid
    ));
    assert_eq!(self_call_proof().len(), 64);
}

#[test]
fn credential_audit_and_hook_override_routes_are_denied() {
    for path in [
        "/api/gateway/providers",
        "/api/gateway/web-accounts",
        "/api/gateway/cloud-speech-accounts",
        "/api/gateway/audit/prune",
        "/api/gateway/traffic",
        "/api/gateway/governance/hooks",
        "/api/hooks/overrides",
    ] {
        for method in ["get", "put", "post"] {
            assert!(is_denied(path, method), "{method} {path}");
        }
    }
    // Git and worktree governance stay reachable.
    assert!(!is_denied("/api/gateway/governance/git", "put"));
    assert!(!is_denied("/api/gateway/governance/worktrees", "put"));
    assert!(!is_denied("/api/gateway/providers/apply", "post"));
}

#[tokio::test]
async fn an_acting_loopback_carries_the_proof_and_the_person() {
    use axum::{http::HeaderMap, routing::get, Json, Router};
    let app = Router::new().route(
        "/api/gateway/status",
        get(|headers: HeaderMap| async move {
            let read = |name: &str| {
                headers
                    .get(name)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned)
            };
            Json(json!({
                "proof": read(SELF_CALL_PROOF_HEADER),
                "user": read(SELF_CALL_USER_HEADER),
            }))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let status = route("GET", "/api/gateway/status");
    let base = format!("http://{addr}");
    let client = reqwest::Client::new();

    let acting = send_request_as(&client, &base, None, &status, &json!({}), Some("u-1"))
        .await
        .unwrap();
    assert_eq!(acting["body"]["proof"], json!(self_call_proof()));
    assert_eq!(acting["body"]["user"], json!("u-1"));

    let owner = send_request(&client, &base, None, &status, &json!({}))
        .await
        .unwrap();
    assert_eq!(owner["body"]["proof"], Value::Null);
    assert_eq!(owner["body"]["user"], Value::Null);
}

#[test]
fn method_of_is_none_for_non_core_api() {
    assert_eq!(method_of("exa.search"), None);
    assert!(!is_core_api("exa.search"));
    assert!(!is_mutating("exa.search"));
}

#[test]
fn legacy_core_api_ids_are_accepted_at_the_boundary() {
    let canonical = routes()
        .first()
        .map(|route| route.id.as_str())
        .expect("the generated Core API has at least one exposed route");
    let (server, method) = canonical
        .split_once('.')
        .expect("Core API ids use the canonical dotted separator");
    let legacy = format!("{server}__{method}");
    assert!(is_core_api(canonical));
    assert!(is_core_api(&legacy));
    assert_eq!(
        method_of(canonical),
        Some(method.split('_').next().unwrap())
    );
    assert_eq!(method_of(&legacy), Some(method.split('_').next().unwrap()));
    assert!(describe(&legacy).is_some());
}

#[tokio::test]
async fn loopback_get_happy_path() {
    use axum::{routing::get, Json, Router};
    // Spin a tiny axum server standing in for Core on an ephemeral port.
    let app = Router::new().route(
        "/api/quests",
        get(|| async { Json(json!({ "quests": [], "ok": true })) }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let route = CoreApiRoute {
        id: "ryu_api.get_api_quests".to_string(),
        method: "GET".to_string(),
        path_template: "/api/quests".to_string(),
        summary: "List quests".to_string(),
        path_params: vec![],
        query_params: vec![],
        has_body: false,
        input_schema: json!({ "type": "object", "properties": {}, "required": [] }),
    };
    let base = format!("http://{addr}");
    let client = reqwest::Client::new();
    let out = send_request(&client, &base, None, &route, &json!({}))
        .await
        .expect("loopback GET succeeds");
    assert_eq!(out["ok"], json!(true));
    assert_eq!(out["status"], json!(200));
    assert_eq!(out["body"]["quests"], json!([]));
}

#[tokio::test]
async fn loopback_substitutes_path_param() {
    use axum::{routing::get, Router};
    // axum 0.7 route-param syntax is `:id`; the CoreApi path template stays
    // OpenAPI-style `{id}` (what `send_request` substitutes into).
    let app = Router::new().route(
        "/api/quests/:id",
        get(|axum::extract::Path(id): axum::extract::Path<String>| async move { id }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let route = CoreApiRoute {
        id: "ryu_api.get_api_quests_id".to_string(),
        method: "GET".to_string(),
        path_template: "/api/quests/{id}".to_string(),
        summary: String::new(),
        path_params: vec!["id".to_string()],
        query_params: vec![],
        has_body: false,
        input_schema: json!({ "type": "object", "properties": {}, "required": ["id"] }),
    };
    let base = format!("http://{addr}");
    let client = reqwest::Client::new();
    let out = send_request(&client, &base, None, &route, &json!({ "id": "q_42" }))
        .await
        .expect("loopback with path param succeeds");
    assert_eq!(out["status"], json!(200));
    assert_eq!(out["body"], json!("q_42"));

    // A missing required path param is a clean error, not a bad request.
    let err = send_request(&client, &base, None, &route, &json!({}))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("missing required path parameter"));
}
