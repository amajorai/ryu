//! Which backend the sync client may send the account bearer to (finding CA-4).

use super::*;
use crate::server::sync::backend::{
    note_backend_refused, resolve_account_api_base, resolve_backend_base, BackendError,
};

const STORED_HTTPS: &str = "https://api.example.test";
const LOCAL_HTTP: &str = "http://127.0.0.1:45678";

#[test]
fn a_stored_sign_in_backend_is_used_when_the_env_is_unset() {
    assert_eq!(
        resolve_backend_base(None, Some(format!("{STORED_HTTPS}/"))),
        Ok(STORED_HTTPS.to_owned())
    );
}

#[test]
fn a_blank_env_counts_as_unset() {
    assert_eq!(
        resolve_backend_base(Some("  ".to_owned()), Some(STORED_HTTPS.to_owned())),
        Ok(STORED_HTTPS.to_owned())
    );
}

#[test]
fn with_neither_there_is_no_backend_and_no_default() {
    assert_eq!(
        resolve_backend_base(None, None),
        Err(BackendError::NoBackend)
    );
    assert_eq!(
        resolve_backend_base(Some(String::new()), Some(" ".to_owned())),
        Err(BackendError::NoBackend)
    );
}

#[test]
fn a_stored_plain_http_backend_is_refused_even_on_loopback() {
    for stored in [
        LOCAL_HTTP,
        "http://localhost:3000",
        "http://api.example.test",
    ] {
        assert_eq!(
            resolve_backend_base(None, Some(stored.to_owned())),
            Err(BackendError::InsecureStoredBackend(stored.to_owned())),
            "{stored}"
        );
    }
}

#[test]
fn an_http_backend_from_the_env_is_accepted_and_wins() {
    assert_eq!(
        resolve_backend_base(
            Some(format!("{LOCAL_HTTP}/")),
            Some(STORED_HTTPS.to_owned())
        ),
        Ok(LOCAL_HTTP.to_owned())
    );
}

#[test]
fn from_sources_uses_the_stored_backend() {
    let client = SyncClient::from_sources(
        None,
        Some(STORED_HTTPS.to_owned()),
        Some("account-token".to_owned()),
    )
    .expect("client");
    assert_eq!(client.server_url, STORED_HTTPS);
}

#[test]
fn from_sources_builds_no_client_without_a_usable_backend() {
    let token = || Some("account-token".to_owned());
    assert!(matches!(
        SyncClient::from_sources(None, None, token()),
        Err(SyncError::Backend(BackendError::NoBackend))
    ));
    assert!(matches!(
        SyncClient::from_sources(None, Some(LOCAL_HTTP.to_owned()), token()),
        Err(SyncError::Backend(BackendError::InsecureStoredBackend(_)))
    ));
    let client = SyncClient::from_sources(Some(LOCAL_HTTP.to_owned()), None, token())
        .expect("an explicit env URL is used as given");
    assert_eq!(client.server_url, LOCAL_HTTP);
}

#[test]
fn from_sources_without_a_token_stays_unauthenticated() {
    assert!(matches!(
        SyncClient::from_sources(None, Some(STORED_HTTPS.to_owned()), None),
        Err(SyncError::Unauthenticated)
    ));
}

#[test]
fn a_refused_backend_is_logged_once_and_says_how_to_fix_it() {
    let mut warned = false;
    note_backend_refused(&mut warned, &BackendError::NoBackend);
    assert!(warned);
    note_backend_refused(&mut warned, &BackendError::NoBackend);
    assert!(warned);
    let text = SyncError::Backend(BackendError::NoBackend).to_string();
    assert!(text.contains("sign in on this node again"), "{text}");
    assert!(text.contains("RYU_SERVER_URL"), "{text}");
}

// The control-plane calls made as the signed-in account (finding CA-8).

#[test]
fn account_api_calls_use_an_explicit_control_plane_first() {
    assert_eq!(
        resolve_account_api_base(
            Some("http://cp.example.test:3000/".to_owned()),
            Some(LOCAL_HTTP.to_owned()),
            Some(STORED_HTTPS.to_owned()),
        ),
        Ok("http://cp.example.test:3000".to_owned())
    );
    assert_eq!(
        resolve_account_api_base(Some(" ".to_owned()), Some(LOCAL_HTTP.to_owned()), None),
        Ok(LOCAL_HTTP.to_owned())
    );
}

#[test]
fn account_api_calls_fall_back_to_the_stored_sign_in_backend() {
    assert_eq!(
        resolve_account_api_base(None, Some(" ".to_owned()), Some(format!("{STORED_HTTPS}/"))),
        Ok(STORED_HTTPS.to_owned())
    );
}

#[test]
fn account_api_calls_have_no_default_address() {
    assert_eq!(
        resolve_account_api_base(None, None, None),
        Err(BackendError::NoBackend)
    );
    assert_eq!(
        resolve_account_api_base(Some(String::new()), None, Some(LOCAL_HTTP.to_owned())),
        Err(BackendError::InsecureStoredBackend(LOCAL_HTTP.to_owned()))
    );
}
