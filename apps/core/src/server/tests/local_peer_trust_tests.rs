use crate::server::is_trusted_local_peer;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

#[test]
fn tunnel_forwarded_loopback_is_not_a_trusted_local_peer() {
    let loopback = IpAddr::V4(Ipv4Addr::LOCALHOST);
    assert!(is_trusted_local_peer(loopback, false));
    assert!(!is_trusted_local_peer(loopback, true));
    assert!(!is_trusted_local_peer(
        IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1)),
        false
    ));
    assert!(!is_trusted_local_peer(
        IpAddr::V6(Ipv6Addr::LOCALHOST),
        true
    ));
}

// The call sites below all read `crate::sidecar::forwarding_tunnel_active()`,
// which now includes a Cloudflare Quick Tunnel started by either the VPN
// layer or webhook ingress. `FORCE_FORWARDING_FOR_TEST` stands in for any
// active tunnel without touching process-global state other tests read.

fn loopback_peer() -> std::net::SocketAddr {
    std::net::SocketAddr::from((Ipv4Addr::LOCALHOST, 50_000))
}

async fn while_forwarding<F: std::future::Future>(future: F) -> F::Output {
    crate::sidecar::FORCE_FORWARDING_FOR_TEST
        .scope(true, future)
        .await
}

#[tokio::test]
async fn auth_middleware_stops_treating_tunneled_loopback_as_local() {
    let request = || {
        let mut request = axum::http::Request::builder()
            .uri("/api/health")
            .body(axum::body::Body::empty())
            .unwrap();
        request
            .extensions_mut()
            .insert(axum::extract::ConnectInfo(loopback_peer()));
        request
    };
    assert!(crate::server::request_peer_is_local(&request()));
    assert!(!while_forwarding(async { crate::server::request_peer_is_local(&request()) }).await);
}

/// Userspace `tailscaled` has no TUN device, so every tailnet peer reaches Core
/// as `127.0.0.1`. A running mesh daemon must therefore stop loopback from
/// proving a local caller, exactly like the other forwarding tunnels.
#[tokio::test]
async fn auth_middleware_stops_trusting_loopback_while_the_mesh_daemon_runs() {
    let request = || {
        let mut request = axum::http::Request::builder()
            .uri("/api/health")
            .body(axum::body::Body::empty())
            .unwrap();
        request
            .extensions_mut()
            .insert(axum::extract::ConnectInfo(loopback_peer()));
        request
    };
    let with_daemon = crate::sidecar::tailscale::FORCE_DAEMON_ACTIVE_FOR_TEST
        .scope(true, async {
            (
                crate::sidecar::forwarding_tunnel_active(),
                crate::server::request_peer_is_local(&request()),
            )
        })
        .await;
    assert_eq!(
        with_daemon,
        (true, false),
        "a tailnet peer arrives as loopback, so it must not read as local"
    );
}

#[tokio::test]
async fn auth_status_withholds_the_bearer_from_tunneled_loopback() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    state.auth.lock().await.token = Some("cloud-session".to_owned());
    let read = || {
        crate::server::auth_status(
            axum::extract::State(state.clone()),
            axum::extract::ConnectInfo(loopback_peer()),
        )
    };
    assert_eq!(read().await.0["token"], "cloud-session");
    assert!(while_forwarding(read()).await.0["token"].is_null());
}

#[tokio::test]
async fn auth_status_reports_a_failed_add_account_flow_despite_the_active_account() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    {
        let mut auth = state.auth.lock().await;
        auth.status = crate::auth::AuthStatus::Authenticated;
        auth.token = Some("bearer-a".to_owned());
        auth.last_flow = Some(crate::auth::DeviceFlowOutcome {
            user_code: "ABCD".to_owned(),
            result: crate::auth::DeviceFlowResult::Failed("access_denied".to_owned()),
        });
    }
    let status = crate::server::auth_status(
        axum::extract::State(state.clone()),
        axum::extract::ConnectInfo(loopback_peer()),
    )
    .await
    .0;
    assert_eq!(status["authenticated"], true);
    assert_eq!(
        status["lastFlow"],
        serde_json::json!({
            "userCode": "ABCD",
            "result": "failed",
            "error": "access_denied",
        })
    );
}

#[tokio::test]
async fn user_jwt_is_never_minted_for_tunneled_loopback() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let mint = || {
        crate::server::auth_user_jwt(
            axum::extract::State(state.clone()),
            axum::extract::ConnectInfo(loopback_peer()),
            axum::extract::Query(crate::server::AuthUserJwtQuery::default()),
        )
    };
    // A genuine local peer passes the locality gate (and then fails only
    // because nobody is signed in).
    assert_eq!(mint().await.status(), axum::http::StatusCode::UNAUTHORIZED);
    assert_eq!(
        while_forwarding(mint()).await.status(),
        axum::http::StatusCode::FORBIDDEN
    );
}
