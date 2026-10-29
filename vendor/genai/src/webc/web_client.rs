use crate::Headers;
use crate::webc::{Error, Result};
use reqwest::header::HeaderMap;
use reqwest::{Method, RequestBuilder, StatusCode};
use serde_json::Value;

/// A simple reqwest client wrapper for this library.
#[derive(Debug)]
pub struct WebClient {
    reqwest_client: reqwest::Client,
}

// Implements Default with performance optimizations
impl Default for WebClient {
    fn default() -> Self {
        use std::time::Duration;
        let reqwest_client = reqwest::Client::builder()
            .tcp_nodelay(true)
            .gzip(true)
            .pool_max_idle_per_host(4)
            .http2_keep_alive_interval(Some(Duration::from_secs(20)))
            .http2_keep_alive_timeout(Duration::from_secs(10))
            .http2_keep_alive_while_idle(true)
            .http2_adaptive_window(true)
            .build()
            .expect("Failed to build default reqwest client");
        WebClient { reqwest_client }
    }
}

// region:    --- Constructors

impl WebClient {
    pub fn from_reqwest_client(reqwest_client: reqwest::Client) -> Self {
        WebClient { reqwest_client }
    }
}

// endregion: --- Constructors

// region:    --- Web Method Implementation

impl WebClient {
    pub async fn do_get(&self, url: &str, headers: &Headers) -> Result<WebResponse> {
        let mut reqwest_builder = self.reqwest_client.request(Method::GET, url);

        for (k, v) in headers.iter() {
            reqwest_builder = reqwest_builder.header(k, v);
        }
        let reqwest_res = reqwest_builder.send().await?;

        let response = WebResponse::from_reqwest_response(reqwest_res).await?;

        Ok(response)
    }

    pub async fn do_post(
        &self,
        url: &str,
        headers: &Headers,
        content: &Value,
    ) -> Result<WebResponse> {
        let reqwest_builder = self.new_req_builder(url, headers, content)?;

        let reqwest_res = reqwest_builder.send().await?;

        let response = WebResponse::from_reqwest_response(reqwest_res).await?;

        Ok(response)
    }

    pub fn new_req_builder(
        &self,
        url: &str,
        headers: &Headers,
        content: &Value,
    ) -> Result<RequestBuilder> {
        let method = Method::POST;

        let mut reqwest_builder = self.reqwest_client.request(method, url);
        for (k, v) in headers.iter() {
            reqwest_builder = reqwest_builder.header(k, v);
        }
        reqwest_builder = reqwest_builder.json(content);

        Ok(reqwest_builder)
    }
}
// endregion: --- Web Method Implementation

// region:    --- WebResponse

// NOTE: This is not a non-streaming web response (assumed to be JSON for this library).
//       Streaming is handled with event-source or custom streams (for example, for Cohere).

#[derive(Debug)]
pub struct WebResponse {
    #[allow(unused)]
    pub status: StatusCode,
    pub body: Value,
}

impl WebResponse {
    /// Note 1: For now, assume only a JSON response.
    /// Note 2: Currently, the WebResponse holds a Value (parsed from the entire body), and then the caller
    ///         can cherry-pick/deserialize further. In the future, we might consider returning `body: String`
    ///         to enable more optimized parsing, allowing for selective parsing constrained by the structure.
    pub(crate) async fn from_reqwest_response(mut res: reqwest::Response) -> Result<WebResponse> {
        let status = res.status();

        if !status.is_success() {
            let headers = res.headers().clone();
            let body = bounded_response_text(res).await?;
            tracing::trace!(status = %status, "AI response failed");
            return Err(Error::ResponseFailedStatus {
                status,
                body,
                headers: Box::new(headers),
            });
        }

        // Move the headers into a new HeaderMap
        let headers = res
            .headers_mut()
            .drain()
            .filter_map(|(n, v)| n.map(|n| (n, v)));
        let header_map = HeaderMap::from_iter(headers);

        // Capture the body
        let ct = header_map
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        let body = bounded_response_text(res).await?;

        let body = if ct.starts_with("application/json") {
            tracing::trace!("AI response received");
            let value: Value =
                serde_json::from_str(&body).map_err(|err| Error::ResponseFailedInvalidJson {
                    body,
                    cause: err.to_string(),
                })?;
            value
        } else {
            return Err(Error::ResponseFailedNotJson {
                content_type: ct.to_string(),
                body,
            });
        };

        Ok(WebResponse { status, body })
    }
}

// endregion: --- WebResponse

/// Allocation ceiling shared by SDK success and failure bodies.
pub(crate) const RESPONSE_BODY_LIMIT: usize = 64 * 1024 * 1024;
pub(crate) async fn bounded_response_text(mut response: reqwest::Response) -> Result<String> {
    if response
        .content_length()
        .is_some_and(|length| length > RESPONSE_BODY_LIMIT as u64)
    {
        return Err(Error::ResponseBodyTooLarge);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if chunk.len() > RESPONSE_BODY_LIMIT.saturating_sub(body.len()) {
            return Err(Error::ResponseBodyTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

#[cfg(test)]
pub(crate) mod security_tests {
    use super::*;
    pub(crate) fn server(status: u16, declared: bool) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            let length = if declared {
                format!("Content-Length: {}\r\n", RESPONSE_BODY_LIMIT + 1)
            } else {
                String::new()
            };
            let _ = stream.write_all(format!("HTTP/1.1 {status} TEST\r\n{length}Content-Type: application/json\r\nConnection: close\r\n\r\n").as_bytes());
            if !declared {
                let chunk = [b'x'; 8192];
                for _ in 0..=(RESPONSE_BODY_LIMIT / chunk.len()) {
                    if stream.write_all(&chunk).is_err() {
                        break;
                    }
                }
            }
        });
        (format!("http://{address}"), server)
    }
    #[tokio::test]
    async fn sdk_success_and_failure_body_limits() {
        for status in [200, 400] {
            for declared in [true, false] {
                let (url, server) = server(status, declared);
                let response = reqwest::Client::new().get(url).send().await.unwrap();
                assert!(matches!(
                    WebResponse::from_reqwest_response(response).await,
                    Err(Error::ResponseBodyTooLarge)
                ));
                tokio::task::spawn_blocking(move || server.join())
                    .await
                    .unwrap()
                    .unwrap();
            }
        }
    }
    #[tokio::test]
    async fn sdk_stream_error_and_partial_message_limits() {
        use futures::StreamExt;
        for status in [200, 400] {
            let (url, server) = server(status, false);
            let mut stream =
                crate::webc::WebStream::new_with_delimiter(reqwest::Client::new().get(url), "\n");
            assert!(
                stream
                    .next()
                    .await
                    .unwrap()
                    .unwrap_err()
                    .to_string()
                    .contains("body limit")
            );
            tokio::task::spawn_blocking(move || server.join())
                .await
                .unwrap()
                .unwrap();
        }
    }
}
