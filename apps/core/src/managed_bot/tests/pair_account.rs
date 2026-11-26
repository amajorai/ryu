//! A pair request never leaves this node without the account bearer.
//!
//! Written against the public client only, so it also builds against the code
//! from before pairing required an account. There it fails: that code called
//! the manager with no credential at all.

use super::*;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[tokio::test]
async fn a_pair_request_never_leaves_without_the_account_bearer() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    // One entry per request: whether it carried an Authorization header. The
    // value is never kept, because on a signed-in machine it is a real bearer.
    let seen = Arc::new(Mutex::new(Vec::<bool>::new()));
    let log = Arc::clone(&seen);
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 1024];
            while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                match stream.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => bytes.extend_from_slice(&chunk[..read]),
                }
            }
            let head = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
            log.lock()
                .unwrap()
                .push(head.contains("\r\nauthorization: bearer "));
            let _ = stream
                .write_all(
                    b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                )
                .await;
            let _ = stream.shutdown().await;
        }
    });

    // Whether or not this machine is signed in: either no request is made, or
    // the one that is made carries the bearer. The stand-in never pairs.
    let outcome = ManagerClient::with_base(base.as_str())
        .pair(&PairRequest::default())
        .await;

    assert!(outcome.is_err(), "the stand-in manager answers 401");
    let seen = seen.lock().unwrap();
    assert!(
        seen.iter().all(|carried| *carried),
        "a pair request left this node without an Authorization header"
    );
}
