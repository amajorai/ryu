//! Bound provider response allocation before parsing or media normalization.
use crate::ProviderError;
use serde::de::DeserializeOwned;

pub(crate) const BODY_LIMIT: usize = 64 * 1024 * 1024;

pub(crate) trait BoundedResponse {
    fn bounded_bytes(
        self,
    ) -> impl std::future::Future<Output = Result<bytes::Bytes, ProviderError>> + Send;
    fn bounded_text(
        self,
    ) -> impl std::future::Future<Output = Result<String, ProviderError>> + Send;
    fn bounded_json<T: DeserializeOwned + Send>(
        self,
    ) -> impl std::future::Future<Output = Result<T, ProviderError>> + Send;
}

impl BoundedResponse for reqwest::Response {
    async fn bounded_bytes(mut self) -> Result<bytes::Bytes, ProviderError> {
        let oversized =
            || ProviderError::Provider("provider response exceeded 64 MiB limit".to_owned());
        if self
            .content_length()
            .is_some_and(|length| length > BODY_LIMIT as u64)
        {
            return Err(oversized());
        }
        let mut body = bytes::BytesMut::new();
        while let Some(chunk) = self
            .chunk()
            .await
            .map_err(|_| ProviderError::Transport("provider body read failed".to_owned()))?
        {
            if body.len() + chunk.len() > BODY_LIMIT {
                return Err(oversized());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body.freeze())
    }
    async fn bounded_text(self) -> Result<String, ProviderError> {
        Ok(String::from_utf8_lossy(&self.bounded_bytes().await?).into_owned())
    }
    async fn bounded_json<T: DeserializeOwned + Send>(self) -> Result<T, ProviderError> {
        serde_json::from_slice(&self.bounded_bytes().await?)
            .map_err(|_| ProviderError::Provider("provider response JSON was invalid".to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{MockResponse, MockServer};
    #[tokio::test]
    async fn preserves_json_and_rejects_declared_oversize() {
        let server = MockServer::always(MockResponse::ok_json(r#"{"ok":true}"#)).await;
        let response = reqwest::Client::new()
            .get(server.base_url())
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.bounded_json::<serde_json::Value>().await.unwrap()["ok"],
            true
        );
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                    BODY_LIMIT + 1
                )
                .as_bytes(),
            );
        });
        let response = reqwest::Client::new()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap();
        server.join().unwrap();
        assert!(response
            .bounded_bytes()
            .await
            .unwrap_err()
            .to_string()
            .contains("64 MiB"));
    }
    #[tokio::test]
    async fn rejects_unknown_length_overflow_and_preserves_binary() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n");
            let chunk = [0; 8192];
            for _ in 0..=(BODY_LIMIT / chunk.len()) {
                if stream.write_all(&chunk).is_err() {
                    break;
                }
            }
        });
        let response = reqwest::Client::new()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap();
        assert!(response
            .bounded_bytes()
            .await
            .unwrap_err()
            .to_string()
            .contains("64 MiB"));
        server.join().unwrap();
        let server = MockServer::always(MockResponse::ok_json("binary-control")).await;
        let response = reqwest::Client::new()
            .get(server.base_url())
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.bounded_bytes().await.unwrap(),
            &b"binary-control"[..]
        );
    }
}
