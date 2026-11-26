//! The Challenges client sends the account bearer, so it is built only for the
//! account backend. Without one no client exists and no request can be made
//! (finding CA-8).

use super::*;
use crate::server::sync::backend::resolve_account_api_base;
use crate::sidecar::mcp::challenges_tool::client::ChallengesApi;

const STORED_HTTPS: &str = "https://api.example.test";

fn token() -> Option<String> {
    Some("session-token".to_owned())
}

#[test]
fn without_a_backend_no_client_is_built() {
    let error = ChallengesApi::from_sources(resolve_account_api_base(None, None, None), token())
        .err()
        .expect("no client without an account backend");
    let text = error.to_string();
    assert!(text.contains("Ryu Challenges is not available"), "{text}");
    assert!(text.contains("sign in on this node again"), "{text}");
}

#[test]
fn a_stored_https_backend_is_where_the_client_points() {
    let base = resolve_account_api_base(None, None, Some(format!("{STORED_HTTPS}/")));
    let api = ChallengesApi::from_sources(base, token()).unwrap();
    assert_eq!(api.root, "https://api.example.test/api/challenges");
    assert_eq!(api.token.as_deref(), Some("session-token"));
}

#[test]
fn a_stored_http_backend_is_refused() {
    let base = resolve_account_api_base(None, None, Some("http://127.0.0.1:45678".to_owned()));
    let error = ChallengesApi::from_sources(base, token())
        .err()
        .expect("a stored http backend is refused");
    assert!(
        error.to_string().contains("does not use https"),
        "{error:#}"
    );
}

#[test]
fn an_explicit_control_plane_wins_over_the_server_env() {
    let base = resolve_account_api_base(
        Some("http://cp.example.test:3000/".to_owned()),
        Some("https://server.example.test".to_owned()),
        Some(STORED_HTTPS.to_owned()),
    );
    let api = ChallengesApi::from_sources(base, token()).unwrap();
    assert_eq!(api.root, "http://cp.example.test:3000/api/challenges");
}
