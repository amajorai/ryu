//! The billing-receipt client is one shared instance that never follows
//! redirects, so a receipt fetch cannot be bounced to another host.

use super::receipt_client;

#[test]
fn receipt_client_is_one_shared_instance() {
    let first = receipt_client().expect("receipt client builds");
    let second = receipt_client().expect("receipt client builds again");
    assert!(std::ptr::eq(first, second));
}

#[tokio::test]
async fn receipt_client_does_not_follow_redirects() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut buffer = [0_u8; 4096];
            let _ = stream.read(&mut buffer).await;
            let response = format!(
                "HTTP/1.1 302 Found\r\nLocation: http://{address}/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            let _ = stream.write_all(response.as_bytes()).await;
        }
    });
    let response = receipt_client()
        .expect("receipt client builds")
        .get(format!("http://{address}/logs/tool_execution/log_1"))
        .send()
        .await
        .expect("redirect response arrives");
    assert_eq!(response.status(), reqwest::StatusCode::FOUND);
    assert_eq!(response.url().path(), "/logs/tool_execution/log_1");
}
