//! Shared JSON-over-HTTP plumbing for the REST backends.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::{Method, RequestBuilder, StatusCode};
use serde_json::Value;

use crate::VectorStoreConfig;

/// Longest upstream error body echoed into an error message. Provider error bodies
/// can be large HTML pages; the first few hundred bytes carry the reason.
const MAX_ERROR_BODY: usize = 512;

/// Upper bound on establishing a connection, so an unreachable host fails fast
/// instead of holding a retrieval turn for the whole request timeout.
const CONNECT_TIMEOUT_SECS: u64 = 5;

/// A configured client: base URL, auth header, timeout.
#[derive(Clone)]
pub(crate) struct JsonClient {
    client: reqwest::Client,
    base_url: String,
    headers: Vec<(String, String)>,
    provider: &'static str,
}

/// Outcome of a request whose 404 is meaningful (existence probes, deletes).
pub(crate) enum Probe {
    Found(Value),
    NotFound,
}

impl JsonClient {
    pub(crate) fn new(
        config: &VectorStoreConfig,
        base_url: String,
        auth: Option<(String, String)>,
        provider: &'static str,
    ) -> Result<Self> {
        Self::new_with_headers(config, base_url, auth.into_iter().collect(), provider)
    }

    /// A client that sends every header in `headers` on every request.
    pub(crate) fn new_with_headers(
        config: &VectorStoreConfig,
        base_url: String,
        headers: Vec<(String, String)>,
        provider: &'static str,
    ) -> Result<Self> {
        let timeout = Duration::from_secs(config.timeout_secs.unwrap_or(30).max(1));
        // No redirects: reqwest strips only `Authorization`/cookie headers on a
        // cross-host redirect, so a redirecting endpoint would otherwise receive
        // Qdrant's `api-key`, Pinecone's `Api-Key` or Chroma's `x-chroma-token`.
        // No vector database API answers with a redirect in normal operation.
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .connect_timeout(timeout.min(Duration::from_secs(CONNECT_TIMEOUT_SECS)))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .context("building vector store HTTP client")?;
        Ok(Self {
            client,
            base_url,
            headers,
            provider,
        })
    }

    /// The same client pointed at another base URL (Pinecone's per-index host).
    pub(crate) fn with_base_url(&self, base_url: String) -> Self {
        Self {
            base_url,
            ..self.clone()
        }
    }

    fn request(&self, method: Method, path: &str) -> RequestBuilder {
        let url = format!("{}{}", self.base_url, path);
        let mut builder = self.client.request(method, url);
        for (name, value) in &self.headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        builder
    }

    /// Send and require a 2xx; return the parsed JSON body (`Null` when empty).
    pub(crate) async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value> {
        match self.send_probe(method, path, body).await? {
            Probe::Found(value) => Ok(value),
            Probe::NotFound => bail!("{} {path}: 404 Not Found", self.provider),
        }
    }

    /// Like [`Self::send`], but a 404 is reported as [`Probe::NotFound`].
    pub(crate) async fn send_probe(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Probe> {
        let mut builder = self.request(method.clone(), path);
        if let Some(body) = body {
            builder = builder.json(body);
        }
        let response = builder
            .send()
            .await
            .with_context(|| format!("{} {method} {path}: request failed", self.provider))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .with_context(|| format!("{} {method} {path}: reading response", self.provider))?;
        if status == StatusCode::NOT_FOUND {
            return Ok(Probe::NotFound);
        }
        if !status.is_success() {
            bail!(
                "{} {method} {path}: HTTP {status}: {}",
                self.provider,
                truncate(&text)
            );
        }
        if text.trim().is_empty() {
            return Ok(Probe::Found(Value::Null));
        }
        let value = serde_json::from_str(&text).with_context(|| {
            format!(
                "{} {method} {path}: response is not JSON: {}",
                self.provider,
                truncate(&text)
            )
        })?;
        Ok(Probe::Found(value))
    }
}

fn truncate(text: &str) -> String {
    if text.len() <= MAX_ERROR_BODY {
        return text.to_owned();
    }
    let mut end = MAX_ERROR_BODY;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

/// Percent-encode one URL path segment.
pub(crate) fn segment(value: &str) -> String {
    urlencoding::encode(value).into_owned()
}

/// Read an `f32` out of a JSON number.
pub(crate) fn as_f32(value: &Value) -> Option<f32> {
    #[allow(clippy::cast_possible_truncation)]
    value.as_f64().map(|v| v as f32)
}
