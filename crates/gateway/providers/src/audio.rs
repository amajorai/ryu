//! Opaque captured transport for delivery of already accepted speech work.
use crate::ProviderError;
use base64::Engine as _;
use serde_json::Value;
use std::time::Duration;

pub const MAX_AUDIO_BYTES: usize = 8 * 1024 * 1024;
pub struct BoundSpeech {
    response: Value,
    origin: Option<HostedSpeechOrigin>,
}
impl BoundSpeech {
    pub fn inline(response: Value) -> Self {
        Self {
            response,
            origin: None,
        }
    }
    pub(crate) fn hosted(response: Value, client: reqwest::Client, provider: &'static str) -> Self {
        Self {
            response,
            origin: Some(HostedSpeechOrigin { client, provider }),
        }
    }
    pub fn into_parts(self) -> (Value, Option<HostedSpeechOrigin>) {
        (self.response, self.origin)
    }
}
pub struct HostedSpeechOrigin {
    client: reqwest::Client,
    provider: &'static str,
}
impl std::fmt::Debug for HostedSpeechOrigin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostedSpeechOrigin")
            .field("provider", &self.provider)
            .finish_non_exhaustive()
    }
}
fn uncertain() -> ProviderError {
    ProviderError::DeliveryUncertain("Accepted speech audio delivery failed".to_owned())
}
fn validate_url(raw: &str, provider: &str) -> Result<reqwest::Url, ProviderError> {
    let checked = crate::web::ValidatedPublicWebUrl::parse(raw).map_err(|_| uncertain())?;
    let url = reqwest::Url::parse(checked.as_str()).map_err(|_| uncertain())?;
    let suffix = match provider {
        "fal" => "fal.media",
        "replicate" => "replicate.delivery",
        _ => return Err(uncertain()),
    };
    let host = url.host_str().ok_or_else(uncertain)?;
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !(host == suffix || host.ends_with(&format!(".{suffix}")))
    {
        return Err(uncertain());
    }
    Ok(url)
}
impl HostedSpeechOrigin {
    pub async fn complete(self, response: &Value) -> Result<Value, ProviderError> {
        let raw = response["data"]
            .as_array()
            .filter(|rows| rows.len() == 1)
            .and_then(|rows| rows[0]["url"].as_str())
            .ok_or_else(uncertain)?;
        let url = validate_url(raw, self.provider)?;
        let addresses = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::net::lookup_host((url.host_str().ok_or_else(uncertain)?, 443)),
        )
        .await
        .map_err(|_| uncertain())?
        .map_err(|_| uncertain())?;
        let mut seen = false;
        for address in addresses {
            seen = true;
            let public = format!("https://{}/", address.ip());
            let public = if address.is_ipv6() {
                format!("https://[{}]/", address.ip())
            } else {
                public
            };
            crate::web::ValidatedPublicWebUrl::parse(&public).map_err(|_| uncertain())?;
        }
        if !seen {
            return Err(uncertain());
        }
        let downloaded = tokio::time::timeout(
            Duration::from_secs(30),
            download(&self.client, url.as_str()),
        )
        .await
        .map_err(|_| uncertain())??;
        let mut result = response.clone();
        result["data"] = serde_json::json!([{"b64_json":base64::engine::general_purpose::STANDARD.encode(downloaded.0),"content_type":downloaded.1}]);
        Ok(result)
    }
}
async fn download(client: &reqwest::Client, url: &str) -> Result<(Vec<u8>, String), ProviderError> {
    // Captured clients have redirect-none; CDN requests add no provider credentials.
    let mut response = client.get(url).send().await.map_err(|_| uncertain())?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > MAX_AUDIO_BYTES as u64)
    {
        return Err(uncertain());
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    if !content_type.starts_with("audio/") || content_type.len() > 200 {
        return Err(uncertain());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| uncertain())? {
        if chunk.len() > MAX_AUDIO_BYTES.saturating_sub(bytes.len()) {
            return Err(uncertain());
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err(uncertain());
    }
    Ok((bytes, content_type))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hosted_audio_accepts_only_exact_provider_cdn_names() {
        assert!(validate_url("https://v3.fal.media/audio.mp3", "fal").is_ok());
        assert!(validate_url("https://replicate.delivery/a.wav", "replicate").is_ok());
        for url in [
            "https://fal.media.evil.com/a",
            "https://evilfal.media/a",
            "http://fal.media/a",
            "https://fal.media:444/a",
            "https://user:secret@fal.media/a",
            "https://fal.media/a#fragment",
            "http://127.0.0.1/a",
        ] {
            assert!(validate_url(url, "fal").is_err());
        }
    }
    #[tokio::test]
    async fn captured_proxy_download_survives_pool_drop_without_auth_or_redirect_replay() {
        use crate::test_support::{MockResponse, MockServer};
        let proxy = MockServer::always(MockResponse::ok_bytes("audio/mpeg", vec![1, 2, 3])).await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .proxy(reqwest::Proxy::all(proxy.base_url()).unwrap())
            .build()
            .unwrap();
        let pool = crate::EgressClientPool::new(vec![client]).unwrap();
        let captured = pool.candidates(None)[0].1.clone();
        drop(pool);
        let result = download(&captured, "http://fixture-cdn.invalid/audio.mp3")
            .await
            .unwrap();
        assert_eq!(result.0, vec![1, 2, 3]);
        let requests = proxy.requests();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].header("authorization").is_none());
        assert!(requests[0].header("x-api-key").is_none());
    }
}
