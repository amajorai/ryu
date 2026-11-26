//! Landing a token needs a usable account backend; without one nothing is sent
//! (finding CA-4).

use super::*;
use crate::managed_bot::landing::land_token_with;
use crate::server::sync::backend::{resolve_backend_base, BackendError};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

const STORED_HTTPS: &str = "https://api.example.test";

/// A local listener that records the first line of every request and answers
/// 502. Every client here uses it as its proxy, so no request in these tests
/// can reach another address or port.
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
                let mut line = String::new();
                let _ = stream.read_line(&mut line).await;
                log.lock().unwrap().push(line.trim().to_owned());
                let _ = stream
                    .get_mut()
                    .write_all(b"HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                    .await;
            });
        }
    });
    (format!("http://{address}"), seen)
}

fn through(proxy: &str) -> reqwest::Client {
    reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(proxy).unwrap())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
}

async fn land(
    http: &reqwest::Client,
    token: Option<&str>,
    base: Result<String, BackendError>,
) -> Result<String> {
    let bot = ManagedBot {
        token: Secret::new("123456:test-bot-token"),
        bot_id: 7,
        bot_username: "helper_bot".to_owned(),
        owner_telegram_user_id: None,
    };
    land_token_with(
        http,
        token.map(str::to_owned),
        base,
        &bot,
        NONCE,
        &Secret::new("s3cr3t-claim-secret-0123456789ab"),
        &ChannelIntent::default(),
    )
    .await
}

fn requests(seen: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
    seen.lock().unwrap().clone()
}

#[tokio::test]
async fn land_token_goes_to_the_stored_https_backend() {
    let (proxy, seen) = recorder().await;
    let base = resolve_backend_base(None, Some(STORED_HTTPS.to_owned()));
    assert!(land(&through(&proxy), Some("account-token"), base)
        .await
        .is_err());
    let seen = requests(&seen);
    assert_eq!(seen.len(), 1, "{seen:?}");
    assert!(
        seen[0].starts_with("CONNECT api.example.test:443 "),
        "{seen:?}"
    );
}

#[tokio::test]
async fn without_a_backend_land_token_fails_before_any_request() {
    let (proxy, seen) = recorder().await;
    let base = resolve_backend_base(None, None);
    let error = land(&through(&proxy), Some("account-token"), base)
        .await
        .expect_err("no backend");
    let text = format!("{error:#}");
    assert!(
        text.contains("cannot save the bot to your account"),
        "{text}"
    );
    assert!(text.contains("sign in on this node again"), "{text}");
    assert!(requests(&seen).is_empty(), "{:?}", requests(&seen));
}

#[tokio::test]
async fn a_stored_http_backend_is_refused_before_any_request() {
    let (proxy, seen) = recorder().await;
    // The listener's own address as the stored backend: if it were used, the
    // listener would see the request even without the proxy.
    let base = resolve_backend_base(None, Some(proxy.clone()));
    let error = land(&through(&proxy), Some("account-token"), base)
        .await
        .expect_err("stored http is refused");
    assert!(
        format!("{error:#}").contains("does not use https"),
        "{error:#}"
    );
    assert!(requests(&seen).is_empty(), "{:?}", requests(&seen));
}

#[tokio::test]
async fn an_http_backend_from_the_env_is_used() {
    let (proxy, seen) = recorder().await;
    let base = resolve_backend_base(Some(proxy.clone()), None);
    assert!(land(&through(&proxy), Some("account-token"), base)
        .await
        .is_err());
    let seen = requests(&seen);
    assert_eq!(seen.len(), 1, "{seen:?}");
    assert!(seen[0].contains("/api/channels "), "{seen:?}");
}

#[tokio::test]
async fn without_a_token_land_token_fails_before_any_request() {
    let (proxy, seen) = recorder().await;
    let base = resolve_backend_base(Some(proxy.clone()), None);
    let error = land(&through(&proxy), None, base)
        .await
        .expect_err("no token");
    assert!(
        format!("{error:#}").contains("no signed-in account"),
        "{error:#}"
    );
    assert!(requests(&seen).is_empty(), "{:?}", requests(&seen));
}
