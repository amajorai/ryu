//! The agent lane end to end: the real HTTP lane (`proxy_for_plugin`) and the
//! real WebSocket router against a stub sidecar on an organization-bound node.

use super::*;

/// The finding: an administrator's deny on the agent decides, for the screen and
/// for input, and a refused request never reaches the sidecar.
#[tokio::test]
async fn a_member_denied_on_an_agent_cannot_view_or_drive_its_desktop() {
    let directory = tempfile::tempdir().unwrap();
    let port = reserve_port();
    let (state, agent_id) = app_state(directory.path(), port).await;
    let _sidecar = register_sidecar_for(&state.manager, APP, port).await;
    let (server, hits) = stub_sidecar(port).await;
    let identity = TestIdentityProvider::start().await;
    let denied_user = unique("denied");
    let allowed_user = unique("allowed");
    let denied = identity.mint(&denied_user, ORG, "member", &[]);
    let allowed = identity.mint(&allowed_user, ORG, "member", &[]);
    let _deny = Rule::deny_agent(&agent_id, &denied_user);
    let screen = format!("/bots/{agent_id}/screen");
    let input = format!("/bots/{agent_id}/input");

    assert_eq!(
        status_of(&state, "GET", &screen, &denied).await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        status_of(&state, "POST", &input, &denied).await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "a refused request must not reach the sidecar"
    );

    // A member without the deny keeps the role base, and the stub is reachable.
    assert_eq!(
        status_of(&state, "GET", &screen, &allowed).await,
        StatusCode::OK
    );
    assert_eq!(
        status_of(&state, "POST", &input, &allowed).await,
        StatusCode::OK
    );
    assert_eq!(hits.load(Ordering::SeqCst), 2);
    server.abort();
}

/// An id that is no agent, or that the sidecar would read as another id, is a 404
/// before any sidecar call, so it cannot add a session entry.
#[tokio::test]
async fn an_unknown_or_non_canonical_agent_id_is_a_404_without_a_sidecar_call() {
    let directory = tempfile::tempdir().unwrap();
    let port = reserve_port();
    let (state, agent_id) = app_state(directory.path(), port).await;
    let _sidecar = register_sidecar_for(&state.manager, APP, port).await;
    let (server, hits) = stub_sidecar(port).await;
    let identity = TestIdentityProvider::start().await;
    let member = identity.mint(&unique("member"), ORG, "member", &[]);

    // `/bots/%2578/screen` reaches Core as `%78` after the router's one decode.
    for sub_path in [
        "/bots/not-an-agent/screen".to_owned(),
        "/bots/%78/screen".to_owned(),
        format!("/bots/{agent_id} /screen"),
        format!("/bots/ {agent_id}/screen"),
    ] {
        assert_eq!(
            status_of(&state, "GET", &sub_path, &member).await,
            StatusCode::NOT_FOUND,
            "{sub_path}"
        );
    }
    assert_eq!(
        status_of(&state, "POST", "/bots/not-an-agent/input", &member).await,
        StatusCode::NOT_FOUND
    );
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    server.abort();
}

/// With the shipped Desktop manifest: `/bots/ryu/...` is served from the node's
/// own desktop, the one `/screen` and `/input` serve, so a member needs their
/// levels too. No organization role holds them, and the agent levels a member has
/// by role do not stand in.
#[tokio::test]
async fn the_node_lane_keeps_the_apps_own_levels() {
    let directory = tempfile::tempdir().unwrap();
    let port = reserve_port();
    let (state, app) = shipped_state(directory.path(), port).await;
    let _sidecar = register_sidecar_for(&state.manager, &app, port).await;
    let (server, hits) = stub_sidecar(port).await;
    let identity = TestIdentityProvider::start().await;
    let member = identity.mint(&unique("member"), ORG, "member", &[]);

    let own_route = status_on(&state, &app, "GET", "/screen", &member).await;
    assert_eq!(own_route, StatusCode::FORBIDDEN);
    assert_eq!(
        status_on(&state, &app, "GET", "/bots/ryu/screen", &member).await,
        own_route
    );
    assert_eq!(
        status_on(&state, &app, "POST", "/bots/ryu/input", &member).await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    server.abort();
}

/// With the shipped Desktop manifest: the default agent needs both, the app's
/// own level and the agent's rule. A member granted "Can view" on the app sees
/// the default desktop, cannot drive it, and is refused once an administrator
/// denies them on the default agent.
#[tokio::test]
async fn the_default_agent_needs_the_apps_own_level_and_the_agents_rule() {
    let directory = tempfile::tempdir().unwrap();
    let port = reserve_port();
    let (state, app) = shipped_state(directory.path(), port).await;
    let _sidecar = register_sidecar_for(&state.manager, &app, port).await;
    let (server, hits) = stub_sidecar(port).await;
    let identity = TestIdentityProvider::start().await;
    let viewer_user = unique("viewer");
    let viewer = identity.mint(&viewer_user, ORG, "member", &[]);
    let _app_level = Rule::allow_on_the_app(&app, &viewer_user, "desktop.view");

    assert_eq!(
        status_on(&state, &app, "GET", "/bots/ryu/screen", &viewer).await,
        StatusCode::OK
    );
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    // The view level on the app does not reach the control routes.
    assert_eq!(
        status_on(&state, &app, "POST", "/bots/ryu/input", &viewer).await,
        StatusCode::FORBIDDEN
    );

    let _deny = Rule::deny_agent("ryu", &viewer_user);
    assert_eq!(
        status_on(&state, &app, "GET", "/bots/ryu/screen", &viewer).await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    server.abort();
}

/// The default agent on an agent route with no usable own route is a 404 before
/// any level is read, and never reaches the sidecar.
#[tokio::test]
async fn the_default_agent_without_an_own_route_is_a_404() {
    let directory = tempfile::tempdir().unwrap();
    let port = reserve_port();
    let (state, agent_id) = app_state(directory.path(), port).await;
    let _sidecar = register_sidecar_for(&state.manager, APP, port).await;
    let (server, hits) = stub_sidecar(port).await;
    let identity = TestIdentityProvider::start().await;
    let viewer = identity.mint(&unique("viewer"), ORG, "member", &[]);

    for sub_path in [
        "/bots/ryu/files",
        "/bots/ryu",
        "/bots/ryu/tabs/7",
        "/bots/ryu/hook",
    ] {
        assert_eq!(
            status_of(&state, "GET", sub_path, &viewer).await,
            StatusCode::NOT_FOUND,
            "{sub_path}"
        );
    }
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    // The same rows for a real agent are checked on that agent and forwarded.
    assert_eq!(
        status_of(&state, "GET", &format!("/bots/{agent_id}/files"), &viewer).await,
        StatusCode::OK
    );
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    server.abort();
}

/// A route that names `agent.edit` is checked on the agent like the view and run
/// rows: a deny stored on the agent refuses, and an allow stored there grants.
#[tokio::test]
async fn an_agent_edit_route_is_checked_on_the_agent() {
    let directory = tempfile::tempdir().unwrap();
    let port = reserve_port();
    let (state, agent_id) = app_state(directory.path(), port).await;
    let _sidecar = register_sidecar_for(&state.manager, APP, port).await;
    let (server, hits) = stub_sidecar(port).await;
    let identity = TestIdentityProvider::start().await;
    let user = unique("editor");
    let member = identity.mint(&user, ORG, "member", &[]);
    let settings = format!("/bots/{agent_id}/settings");
    let edit = [permissions::AGENT_EDIT];

    {
        let _deny = Rule::on_agent(&agent_id, &user, &[], &edit);
        assert_eq!(
            status_of(&state, "POST", &settings, &member).await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }
    let _allow = Rule::on_agent(&agent_id, &user, &edit, &[]);
    assert_eq!(
        status_of(&state, "POST", &settings, &member).await,
        StatusCode::OK
    );
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    server.abort();
}

async fn bind_org_node(request: Request, next: axum::middleware::Next) -> Response {
    with_test_node_binding(true, Some(org_node()), next.run(request)).await
}

/// The WebSocket lane makes the same check before it accepts the upgrade.
#[tokio::test]
async fn a_member_denied_on_an_agent_is_refused_before_the_ws_upgrade() {
    let directory = tempfile::tempdir().unwrap();
    // The sidecar is never registered, so a caller that clears the gate stops at
    // the sidecar gate with a 503 and no socket is ever accepted.
    let (state, agent_id) = app_state(directory.path(), 1).await;
    let denied_user = unique("denied");
    let _deny = Rule::deny_agent(&agent_id, &denied_user);
    let path = format!("/api/ext/ws/{APP}/bots/{agent_id}/ws");

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let router = ext_routes(None)
        .with_state(state)
        .layer(axum::middleware::from_fn(bind_org_node));
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

    let ticket_for = |user_id: &str| {
        crate::server::ws_ticket::mint_for_test(crate::server::ws_ticket::WsTicketClaims {
            app_id: None,
            caller: Some(VerifiedCaller {
                user_id: user_id.to_owned(),
                email: None,
                email_verified: false,
                org_id: Some(ORG.to_owned()),
                role: OrgRole::Member,
                teams: Vec::new(),
            }),
            kind: None,
            path: Some(path.clone()),
            member: false,
            peer_is_loopback: false,
            room_id: None,
            route: crate::server::ws_ticket::WsTicketRoute::Extension,
            jwt_expires_at: Some(chrono::Utc::now().timestamp() + 3_600),
            user_jwt: None,
            node_generation: crate::node_token::active_generation(),
        })
    };
    let handshake_status = |ticket: String| {
        let url = format!("ws://127.0.0.1:{port}{path}?{WS_TICKET_PARAM}={ticket}");
        async move {
            match tokio_tungstenite::connect_async(url).await {
                Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                    response.status().as_u16()
                }
                Ok(_) => panic!("the socket must not upgrade without a registered sidecar"),
                Err(other) => panic!("unexpected handshake failure: {other}"),
            }
        }
    };

    assert_eq!(
        handshake_status(ticket_for(&denied_user)).await,
        StatusCode::FORBIDDEN.as_u16()
    );
    assert_eq!(
        handshake_status(ticket_for(&unique("allowed"))).await,
        StatusCode::SERVICE_UNAVAILABLE.as_u16(),
        "a member without the deny clears the gate and stops at the unregistered sidecar"
    );
    server.abort();
}
