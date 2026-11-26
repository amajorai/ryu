//! `pair` carries the signed-in account, and a signed-out node sends nothing.
//!
//! The manager is a listener on this machine; no test here reaches another
//! address.

use super::*;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const NONCE: &str = "0123456789abcdef0123456789abcdef";
const PAIRED: &str = r#"{"nonce":"0123456789abcdef0123456789abcdef","claim_secret":"s3cr3t-claim-secret-0123456789ab","deep_link":"https://t.me/ryu_bot?start=mb_0123456789abcdef0123456789abcdef","expires_at":"2026-08-06T12:00:00Z"}"#;
const ACCOUNT: &str = "acct-session-token";

/// A stand-in manager: keeps the head of every request (lower-cased) and
/// answers each with `status` and `body`.
async fn manager(status: &'static str, body: &'static str) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let log = Arc::clone(&log);
            tokio::spawn(async move {
                let head = read_head(&mut stream).await;
                log.lock().unwrap().push(head);
                let reply = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(reply.as_bytes()).await;
                let _ = stream.shutdown().await;
            });
        }
    });
    (format!("http://{address}"), seen)
}

async fn read_head(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 1024];
    while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => bytes.extend_from_slice(&chunk[..read]),
        }
    }
    String::from_utf8_lossy(&bytes).to_ascii_lowercase()
}

#[tokio::test]
async fn pair_sends_the_account_bearer_the_node_holds() {
    let (base, seen) = manager("200 OK", PAIRED).await;

    let session = ManagerClient::with_base(base.as_str())
        .pair_as(&PairRequest::default(), Some(ACCOUNT.to_owned()))
        .await
        .expect("the stand-in manager pairs");

    assert_eq!(session.nonce, NONCE);
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1, "exactly one request");
    assert!(
        seen[0].starts_with("post /managed-bot/pair "),
        "{}",
        seen[0]
    );
    assert!(
        seen[0].contains("\r\nauthorization: bearer acct-session-token\r\n"),
        "the pair request must carry the account bearer"
    );
}

#[tokio::test]
async fn a_signed_out_node_gets_a_clear_error_and_sends_nothing() {
    let (base, seen) = manager("200 OK", PAIRED).await;
    let client = ManagerClient::with_base(base.as_str());

    for token in [None, Some(String::new()), Some("  ".to_owned())] {
        let err = client
            .pair_as(&PairRequest::default(), token)
            .await
            .expect_err("a signed-out node cannot pair");
        assert_eq!(err.to_string(), ACCOUNT_REQUIRED);
        assert!(!is_manager_unavailable(&err));
    }

    assert!(
        seen.lock().unwrap().is_empty(),
        "a signed-out node must not call the manager at all"
    );
}

#[tokio::test]
async fn a_refused_sign_in_is_named_as_such() {
    let (base, seen) = manager("401 Unauthorized", r#"{"error":"not accepted"}"#).await;

    let err = ManagerClient::with_base(base.as_str())
        .pair_as(&PairRequest::default(), Some("stale-session".to_owned()))
        .await
        .expect_err("the manager refused the account");

    assert_eq!(err.to_string(), ACCOUNT_REFUSED);
    // Not the "managed bots are switched off" answer: the paste-a-token form
    // would be the wrong advice for someone who only has to sign in again.
    assert!(!is_manager_unavailable(&err));
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn the_bearer_is_not_sent_over_plain_http_to_another_machine() {
    let (recorder, seen) = manager("200 OK", PAIRED).await;
    // Every request this client makes would land on the local recorder.
    let client = ManagerClient {
        base: "http://manager.example.test".to_owned(),
        http: reqwest::Client::builder()
            .proxy(reqwest::Proxy::all(recorder.as_str()).unwrap())
            .build()
            .unwrap(),
    };

    let err = client
        .pair_as(&PairRequest::default(), Some(ACCOUNT.to_owned()))
        .await
        .expect_err("plain http to another machine is refused");

    assert_eq!(err.to_string(), INSECURE_MANAGER);
    assert!(seen.lock().unwrap().is_empty(), "nothing may be sent");
}

#[test]
fn only_https_or_a_local_manager_may_carry_the_account() {
    for base in [
        "https://bot.ryuhq.com",
        "http://localhost:3000",
        "http://127.0.0.1:8787",
        "http://[::1]:8787",
    ] {
        assert!(may_carry_account(base), "{base}");
    }
    for base in [
        "http://bot.ryuhq.com",
        "http://localhost.example.test",
        "ftp://bot.ryuhq.com",
        "bot.ryuhq.com",
        "",
    ] {
        assert!(!may_carry_account(base), "{base}");
    }
}
