//! `SafetyClient`: the only HTTP path a screener backend uses (spec 02.6.3,
//! screener addendum section 3.4).
//!
//! One `reqwest::Client` per backend, pinned to one endpoint. It never goes
//! through `ModelRouter`, `InferenceClient`, `ProviderRegistry` or any bound
//! route, so hazard content is never sent to the account being protected. It
//! follows no redirects, caps every response at 64 KiB while streaming, and
//! sends only the body it is given plus an optional correlation id header on
//! non-remote endpoints. No tenant identifier and no `x-ryu-*` header is ever
//! added here.

use std::net::IpAddr;
use std::time::Duration;

use reqwest::{StatusCode, Url};
use serde_json::Value;

use crate::backend::{BackendError, Locality};

/// Response cap (section 3.4 and SB-10).
pub const MAX_RESPONSE_BYTES: usize = 64 * 1024;
/// Connect timeout on loopback and private networks.
pub const LOCAL_CONNECT_TIMEOUT: Duration = Duration::from_millis(200);
/// Connect timeout for remote processors.
pub const REMOTE_CONNECT_TIMEOUT: Duration = Duration::from_secs(1);

/// Why an endpoint (or the backend built on it) was refused at construction.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EndpointError {
    #[error("endpoint is not a valid URL")]
    Invalid,
    #[error("endpoint scheme must be http or https")]
    Scheme,
    #[error("a remote processor endpoint must use https")]
    RemoteNotHttps,
    #[error("endpoint must not carry userinfo, a query or a fragment")]
    ExtraParts,
    #[error("a loopback endpoint must resolve to a loopback address")]
    NotLoopback,
    #[error("credentials are never sent over plaintext to this endpoint")]
    PlaintextCredential,
    #[error("the HTTP client could not be built")]
    Client,
    #[error("a local decision model must pin its weights sha256")]
    UnpinnedWeights,
}

/// A validated endpoint and its locality.
#[derive(Debug, Clone)]
pub struct Endpoint {
    url: Url,
    locality: Locality,
}

impl Endpoint {
    /// A loopback or private-network endpoint (`http` or `https`).
    pub fn local(raw: &str, locality: Locality) -> Result<Self, EndpointError> {
        let url = parse_clean(raw)?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(EndpointError::Scheme);
        }
        match &locality {
            Locality::Loopback if !is_loopback_host(&url) => Err(EndpointError::NotLoopback),
            // A remote processor is built only through `Endpoint::remote`.
            Locality::RemoteProcessor { .. } => Err(EndpointError::RemoteNotHttps),
            _ => Ok(Self { url, locality }),
        }
    }

    /// A remote processor endpoint: https only, the same rule as Shadow's
    /// `validate_endpoint`.
    pub fn remote(raw: &str, processor_id: impl Into<String>) -> Result<Self, EndpointError> {
        let url = parse_clean(raw)?;
        if url.scheme() != "https" {
            return Err(EndpointError::RemoteNotHttps);
        }
        Ok(Self {
            url,
            locality: Locality::RemoteProcessor {
                processor_id: processor_id.into(),
            },
        })
    }

    /// A remote-processor endpoint over plaintext, for mock servers only.
    #[cfg(any(test, feature = "test-backends"))]
    pub fn remote_plaintext_for_test(
        raw: &str,
        processor_id: impl Into<String>,
    ) -> Result<Self, EndpointError> {
        Ok(Self {
            url: parse_clean(raw)?,
            locality: Locality::RemoteProcessor {
                processor_id: processor_id.into(),
            },
        })
    }

    pub fn url(&self) -> &Url {
        &self.url
    }

    pub fn locality(&self) -> &Locality {
        &self.locality
    }

    /// The endpoint URL with `suffix` appended to its path (`/chat/completions`).
    fn join(&self, suffix: &str) -> Url {
        if suffix.is_empty() {
            return self.url.clone();
        }
        let mut url = self.url.clone();
        let path = format!(
            "{}/{}",
            url.path().trim_end_matches('/'),
            suffix.trim_start_matches('/')
        );
        url.set_path(&path);
        url
    }
}

fn parse_clean(raw: &str) -> Result<Url, EndpointError> {
    let url = Url::parse(raw.trim()).map_err(|_| EndpointError::Invalid)?;
    if url.host_str().is_none() {
        return Err(EndpointError::Invalid);
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(EndpointError::ExtraParts);
    }
    Ok(url)
}

fn is_loopback_host(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => IpAddr::V4(ip).is_loopback(),
        Some(url::Host::Ipv6(ip)) => IpAddr::V6(ip).is_loopback(),
        None => false,
    }
}

/// The pinned client for one backend.
#[derive(Debug, Clone)]
pub struct SafetyClient {
    http: reqwest::Client,
    endpoint: Endpoint,
    bearer: Option<String>,
}

impl SafetyClient {
    /// Build a client. A bearer token is refused over plaintext except on a
    /// private network (a static bearer between containers, section 4.1).
    pub fn new(endpoint: Endpoint, bearer: Option<String>) -> Result<Self, EndpointError> {
        let bearer = bearer.filter(|b| !b.trim().is_empty());
        if bearer.is_some()
            && endpoint.url.scheme() != "https"
            && endpoint.locality != Locality::PrivateNetwork
        {
            return Err(EndpointError::PlaintextCredential);
        }
        Self::build(endpoint, bearer)
    }

    /// A client that may send a bearer over plaintext, for mock servers only.
    #[cfg(any(test, feature = "test-backends"))]
    pub fn new_for_test(endpoint: Endpoint, bearer: Option<String>) -> Result<Self, EndpointError> {
        Self::build(endpoint, bearer.filter(|b| !b.trim().is_empty()))
    }

    fn build(endpoint: Endpoint, bearer: Option<String>) -> Result<Self, EndpointError> {
        let connect_timeout = if endpoint.locality.is_remote() {
            REMOTE_CONNECT_TIMEOUT
        } else {
            LOCAL_CONNECT_TIMEOUT
        };
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(connect_timeout)
            .no_proxy()
            .build()
            .map_err(|_| EndpointError::Client)?;
        Ok(Self {
            http,
            endpoint,
            bearer,
        })
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    /// POST `body` as JSON to the endpoint plus `suffix`.
    pub async fn post_json(
        &self,
        suffix: &str,
        body: &Value,
        correlation_id: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, BackendError> {
        let mut request = self.http.post(self.endpoint.join(suffix)).json(body);
        request = self.decorate(request, correlation_id);
        self.execute(request, timeout).await
    }

    /// GET the endpoint plus `suffix` (probes only).
    pub async fn get_json(&self, suffix: &str, timeout: Duration) -> Result<Value, BackendError> {
        let request = self.decorate(self.http.get(self.endpoint.join(suffix)), None);
        self.execute(request, timeout).await
    }

    fn decorate(
        &self,
        mut request: reqwest::RequestBuilder,
        correlation_id: Option<&str>,
    ) -> reqwest::RequestBuilder {
        if let Some(token) = &self.bearer {
            request = request.bearer_auth(token.trim());
        }
        // A remote processor gets nothing beyond the body.
        if let Some(id) = correlation_id.filter(|_| !self.endpoint.locality.is_remote()) {
            request = request.header("x-correlation-id", id);
        }
        request
    }

    async fn execute(
        &self,
        request: reqwest::RequestBuilder,
        timeout: Duration,
    ) -> Result<Value, BackendError> {
        if timeout.is_zero() {
            return Err(BackendError::Timeout);
        }
        match tokio::time::timeout(timeout, async move {
            let response = request.send().await.map_err(map_send_error)?;
            let status = response.status();
            check_status(status)?;
            let bytes = read_capped(response).await?;
            serde_json::from_slice::<Value>(&bytes).map_err(|_| BackendError::Malformed)
        })
        .await
        {
            Ok(result) => result,
            Err(_) => Err(BackendError::Timeout),
        }
    }
}

fn map_send_error(error: reqwest::Error) -> BackendError {
    // A refused or unreachable endpoint is "down", even when the OS reports it
    // as a connect timeout (a refused loopback connect can stall on Windows).
    if error.is_connect() {
        BackendError::Unavailable("connect")
    } else if error.is_timeout() {
        BackendError::Timeout
    } else {
        BackendError::Unavailable("transport")
    }
}

fn check_status(status: StatusCode) -> Result<(), BackendError> {
    if status.is_success() {
        Ok(())
    } else if status.is_redirection() {
        Err(BackendError::Unavailable("redirect"))
    } else if status == StatusCode::TOO_MANY_REQUESTS {
        Err(BackendError::Unavailable("busy"))
    } else {
        Err(BackendError::Unavailable("http_status"))
    }
}

async fn read_capped(mut response: reqwest::Response) -> Result<Vec<u8>, BackendError> {
    if response
        .content_length()
        .is_some_and(|len| len > MAX_RESPONSE_BYTES as u64)
    {
        return Err(BackendError::Malformed);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| BackendError::Unavailable("transport"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(BackendError::Malformed);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_endpoint_requires_clean_https() {
        assert!(Endpoint::remote("https://api.example.test/v1/systemone", "p").is_ok());
        assert_eq!(
            Endpoint::remote("http://api.example.test/v1/systemone", "p").unwrap_err(),
            EndpointError::RemoteNotHttps
        );
        for bad in [
            "https://user:pw@api.example.test/v1/systemone",
            "https://user@api.example.test/v1/systemone",
            "https://api.example.test/v1/systemone?x=1",
            "https://api.example.test/v1/systemone#frag",
        ] {
            assert_eq!(
                Endpoint::remote(bad, "p").unwrap_err(),
                EndpointError::ExtraParts,
                "{bad}"
            );
        }
        assert_eq!(
            Endpoint::remote("not a url", "p").unwrap_err(),
            EndpointError::Invalid
        );
    }

    #[test]
    fn loopback_endpoint_must_be_loopback() {
        assert!(Endpoint::local("http://127.0.0.1:11435/v1/systemone", Locality::Loopback).is_ok());
        assert!(Endpoint::local("http://[::1]:8009/v1/systemone", Locality::Loopback).is_ok());
        assert_eq!(
            Endpoint::local("http://10.0.0.5:8092/v1", Locality::Loopback).unwrap_err(),
            EndpointError::NotLoopback
        );
        assert!(Endpoint::local("http://screener:8092/v1", Locality::PrivateNetwork).is_ok());
        assert_eq!(
            Endpoint::local("ftp://127.0.0.1/x", Locality::Loopback).unwrap_err(),
            EndpointError::Scheme
        );
        assert!(Endpoint::local(
            "https://api.example.test/v1",
            Locality::RemoteProcessor {
                processor_id: "p".into()
            }
        )
        .is_err());
    }

    #[test]
    fn bearer_never_travels_over_plaintext_loopback() {
        let loopback =
            Endpoint::local("http://127.0.0.1:8009/v1/systemone", Locality::Loopback).unwrap();
        assert_eq!(
            SafetyClient::new(loopback.clone(), Some("token".into())).unwrap_err(),
            EndpointError::PlaintextCredential
        );
        assert!(SafetyClient::new(loopback, None).is_ok());
        let private = Endpoint::local("http://screener:8092/v1", Locality::PrivateNetwork).unwrap();
        assert!(SafetyClient::new(private, Some("token".into())).is_ok());
    }

    #[test]
    fn join_appends_to_the_path() {
        let e = Endpoint::local("http://127.0.0.1:8092/v1/", Locality::Loopback).unwrap();
        assert_eq!(
            e.join("/chat/completions").as_str(),
            "http://127.0.0.1:8092/v1/chat/completions"
        );
        assert_eq!(e.join("").as_str(), "http://127.0.0.1:8092/v1/");
    }

    #[tokio::test]
    async fn closed_port_is_a_failure_not_an_allow() {
        // Bind and drop to find a port nothing listens on.
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let e =
            Endpoint::local(&format!("http://127.0.0.1:{port}/v1"), Locality::Loopback).unwrap();
        let client = SafetyClient::new(e, None).unwrap();
        let err = client
            .post_json(
                "/chat/completions",
                &serde_json::json!({}),
                Some("c1"),
                Duration::from_secs(3),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, BackendError::Unavailable(_) | BackendError::Timeout),
            "{err:?}"
        );
    }

    #[tokio::test]
    async fn zero_timeout_never_sends() {
        let e = Endpoint::local("http://127.0.0.1:9/v1", Locality::Loopback).unwrap();
        let client = SafetyClient::new(e, None).unwrap();
        let err = client
            .post_json("", &serde_json::json!({}), None, Duration::ZERO)
            .await
            .unwrap_err();
        assert_eq!(err, BackendError::Timeout);
    }
}
