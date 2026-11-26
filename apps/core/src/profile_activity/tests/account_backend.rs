//! The activity post carries the account bearer, so it goes only to the account
//! backend. Without one no request is made (finding CA-8).

use super::*;
use crate::profile_activity::posting::{
    activity_body, note_no_backend, post_activity, PostOutcome,
};
use crate::server::sync::backend::{resolve_account_api_base, BackendError};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

const TOKEN: &str = "account-token";
const STORED_HTTPS: &str = "https://api.example.test";

/// A local listener that records the head (request line and headers) of every
/// request and answers 502. Every client here uses it as its proxy, so no
/// request in these tests can reach another address or port.
async fn recorder() -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let log = Arc::clone(&log);
            tokio::spawn(async move {
                let mut stream = BufReader::new(stream);
                let mut head = String::new();
                loop {
                    let mut line = String::new();
                    match stream.read_line(&mut line).await {
                        Ok(read) if read > 0 && !line.trim().is_empty() => head.push_str(&line),
                        _ => break,
                    }
                }
                log.lock().unwrap().push(head.to_ascii_lowercase());
                let _ = stream
                    .get_mut()
                    .write_all(b"HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                    .await;
            });
        }
    });
    (format!("http://{address}"), seen)
}

/// Post one activity body as the signed-in account, with every request routed
/// through the recorder.
async fn post(proxy: &str, base: Result<String, BackendError>) -> PostOutcome {
    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(proxy).unwrap())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    post_activity(&client, base, TOKEN, &activity_body(None, None)).await
}

fn requests(seen: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
    seen.lock().unwrap().clone()
}

#[tokio::test]
async fn without_a_backend_no_request_is_made() {
    let (proxy, seen) = recorder().await;
    let outcome = post(&proxy, resolve_account_api_base(None, None, None)).await;
    let seen = requests(&seen);
    assert!(seen.is_empty(), "a request was made: {seen:?}");
    assert!(matches!(
        outcome,
        PostOutcome::NoBackend(BackendError::NoBackend)
    ));
}

#[tokio::test]
async fn a_stored_https_backend_is_where_the_post_goes() {
    let (proxy, seen) = recorder().await;
    let base = resolve_account_api_base(None, None, Some(STORED_HTTPS.to_owned()));
    let outcome = post(&proxy, base).await;
    let seen = requests(&seen);
    assert_eq!(seen.len(), 1, "{seen:?}");
    assert!(
        seen[0].starts_with("connect api.example.test:443 "),
        "{seen:?}"
    );
    // The recorder refuses the tunnel, which the poster treats as a network error.
    assert!(matches!(outcome, PostOutcome::Retry));
}

#[tokio::test]
async fn a_stored_http_backend_is_refused_before_any_request() {
    let (proxy, seen) = recorder().await;
    // The listener's own address as the stored backend: if it were used, the
    // listener would see the request even without the proxy.
    let base = resolve_account_api_base(None, None, Some(proxy.clone()));
    let outcome = post(&proxy, base).await;
    let seen = requests(&seen);
    assert!(seen.is_empty(), "a request was made: {seen:?}");
    assert!(matches!(
        outcome,
        PostOutcome::NoBackend(BackendError::InsecureStoredBackend(_))
    ));
}

#[tokio::test]
async fn an_explicit_control_plane_gets_the_post_with_the_bearer() {
    let (proxy, seen) = recorder().await;
    let base = resolve_account_api_base(Some(proxy.clone()), None, None);
    let _ = post(&proxy, base).await;
    let seen = requests(&seen);
    assert_eq!(seen.len(), 1, "{seen:?}");
    assert!(seen[0].contains("/api/profile/me/activity "), "{seen:?}");
    assert!(
        seen[0].contains("authorization: bearer account-token"),
        "{seen:?}"
    );
}

#[tokio::test]
async fn the_server_env_is_used_when_the_control_plane_env_is_blank() {
    let (proxy, seen) = recorder().await;
    let base = resolve_account_api_base(
        Some("  ".to_owned()),
        Some(proxy.clone()),
        Some(STORED_HTTPS.to_owned()),
    );
    let _ = post(&proxy, base).await;
    let seen = requests(&seen);
    assert_eq!(seen.len(), 1, "{seen:?}");
    assert!(!seen[0].starts_with("connect "), "{seen:?}");
    assert!(seen[0].contains("/api/profile/me/activity "), "{seen:?}");
}

#[test]
fn a_missing_backend_is_logged_once_and_says_how_to_fix_it() {
    let mut warned = false;
    note_no_backend(&mut warned, &BackendError::NoBackend);
    assert!(warned);
    note_no_backend(&mut warned, &BackendError::NoBackend);
    assert!(warned);
    let text = BackendError::NoBackend.to_string();
    assert!(text.contains("sign in on this node again"), "{text}");
}
