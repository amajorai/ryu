//! HTTP calls for the API-backed providers (Kubernetes, GCP, Azure).
//!
//! A trusted (manager-written) role uses the host's network and may pin a
//! private CA; a screened (delegate-written) role goes through
//! [`ryu_egress`]: https only, public addresses only, pinned, no proxy, and
//! no custom CA. Neither follows redirects (a redirect would carry the admin
//! bearer token elsewhere), and both read at most 1 MiB.

use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;

use super::target_guard::TargetEgress;

const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);

/// One request.
pub(crate) struct HttpCall<'a> {
    pub method: &'a str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    /// Extra trust anchor (trusted roles only).
    pub ca_pem: Option<&'a str>,
}

impl<'a> HttpCall<'a> {
    pub(crate) fn new(method: &'a str, url: impl Into<String>) -> Self {
        Self {
            method,
            url: url.into(),
            headers: Vec::new(),
            body: None,
            ca_pem: None,
        }
    }

    pub(crate) fn bearer(mut self, token: &str) -> Self {
        self.headers
            .push(("authorization".into(), format!("Bearer {}", token.trim())));
        self
    }

    pub(crate) fn json(mut self, body: &Value) -> Self {
        self.headers
            .push(("content-type".into(), "application/json".into()));
        self.body = Some(body.to_string().into_bytes());
        self
    }

    pub(crate) fn form(mut self, pairs: &[(&str, &str)]) -> Self {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(pairs)
            .finish();
        self.headers.push((
            "content-type".into(),
            "application/x-www-form-urlencoded".into(),
        ));
        self.body = Some(body.into_bytes());
        self
    }

    pub(crate) fn ca(mut self, ca_pem: Option<&'a str>) -> Self {
        self.ca_pem = ca_pem;
        self
    }
}

/// Send `call` and return the status and body.
pub(crate) async fn send(call: HttpCall<'_>, egress: TargetEgress) -> Result<(u16, Vec<u8>)> {
    if egress == TargetEgress::Screened {
        if call.ca_pem.is_some() {
            bail!("a custom CA is not allowed for roles written by a delegated admin");
        }
        let policy = ryu_egress::GuardedFetchPolicy {
            allow_http: false,
            max_body_bytes: MAX_RESPONSE_BYTES,
            max_redirect_hops: 0,
            timeout: TIMEOUT,
        };
        let request = ryu_egress::GuardedRequest {
            method: call.method.to_owned(),
            url: call.url,
            headers: call.headers,
            body: call.body,
        };
        let response = ryu_egress::guarded_request_direct(request, policy)
            .await
            .map_err(|error| {
                anyhow!("{error} (roles written by a delegated admin may only target public hosts)")
            })?;
        return Ok((response.status, response.body));
    }
    let mut client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none());
    if let Some(pem) = call.ca_pem {
        client = client.add_root_certificate(
            reqwest::Certificate::from_pem(pem.as_bytes()).context("caPem is not a certificate")?,
        );
    }
    let method = reqwest::Method::from_bytes(call.method.as_bytes())?;
    let mut request = client.build()?.request(method, &call.url);
    for (name, value) in call.headers {
        request = request.header(name, value);
    }
    if let Some(body) = call.body {
        request = request.body(body);
    }
    // reqwest's error text ends with the URL (path and query can hold a
    // token); these errors reach audit rows and logs.
    let mut response = request.send().await.map_err(reqwest::Error::without_url)?;
    let status = response.status().as_u16();
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(reqwest::Error::without_url)?
    {
        if body.len() as u64 + chunk.len() as u64 > MAX_RESPONSE_BYTES {
            bail!("the response is larger than 1 MiB");
        }
        body.extend_from_slice(&chunk);
    }
    Ok((status, body))
}

/// The upstream's own error text, if it sent one in a common JSON shape.
fn upstream_message(body: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let text = value
        .pointer("/error/message")
        .or_else(|| value.get("error_description"))
        .or_else(|| value.get("message"))
        .or_else(|| value.get("error"))
        .and_then(Value::as_str)?;
    Some(text.chars().take(300).collect())
}

/// Send `call` and parse a 2xx JSON answer; any other status is an error
/// naming `what` and the upstream's message. `allow` lists extra statuses
/// that count as success (for example 404 on a delete).
pub(crate) async fn json(
    call: HttpCall<'_>,
    egress: TargetEgress,
    what: &str,
    allow: &[u16],
) -> Result<(u16, Value)> {
    let (status, body) = send(call, egress)
        .await
        .with_context(|| format!("calling {what}"))?;
    if !(200..300).contains(&status) && !allow.contains(&status) {
        let message = upstream_message(&body).unwrap_or_else(|| "request failed".to_owned());
        bail!("{what} returned {status}: {message}");
    }
    if body.is_empty() || !(200..300).contains(&status) {
        return Ok((status, Value::Null));
    }
    let value =
        serde_json::from_slice(&body).with_context(|| format!("{what} returned invalid JSON"))?;
    Ok((status, value))
}

/// A required string field of a JSON answer.
pub(crate) fn field(value: &Value, pointer: &str, what: &str) -> Result<String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            anyhow!(
                "{what} response is missing {}",
                pointer.trim_start_matches('/')
            )
        })
}

/// `https://` URL, or `http://` to loopback (tests and local clusters).
pub(crate) fn check_https(raw: &str, field: &str) -> Result<url::Url> {
    let url = url::Url::parse(raw.trim()).with_context(|| format!("{field} is not a URL"))?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        bail!("{field} must be https (http is allowed only for loopback)");
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        bail!("{field} must not carry credentials or a fragment");
    }
    Ok(url)
}

#[cfg(test)]
#[path = "http_test.rs"]
pub(crate) mod tests;
