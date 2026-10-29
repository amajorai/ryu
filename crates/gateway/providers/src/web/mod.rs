//! Direct web-service adapters. This module does not register routes or models.
//! Eleven explicit vendor kinds share bounded transport and kind-local accounts.

mod brave;
mod exa;
mod firecrawl;
mod google_pse;
mod jina_reader;
mod linkup;
mod parallel;
mod perplexity;
mod searchapi;
mod serper;
mod tavily;

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
use std::time::Duration;

use ryu_gw_credentials::web::{
    WebAccountConfig, WebContentFormat, WebOperation, WebProviderConfig, WebProviderKind,
};
use serde::Serialize;
use serde_json::Value;

use crate::account_pool::AccountPool;
use crate::egress::send_with_egress;
use crate::{EgressClientPool, ProviderAccountPolicy, ProviderError, ProviderQuotas};

const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
pub(super) const MAX_PAGE_BYTES: usize = 512 * 1024;

#[derive(Clone)]
pub struct WebSearchRequest {
    query: String,
    limit: u16,
}

impl WebSearchRequest {
    pub fn new(query: String, limit: u16) -> Result<Self, ProviderError> {
        let query = query.trim();
        if query.is_empty()
            || query.chars().count() > 400
            || query.split_whitespace().count() > 50
            || query.chars().any(char::is_control)
            || !(1..=10).contains(&limit)
        {
            return Err(invalid("invalid bounded search request"));
        }
        Ok(Self {
            query: query.to_owned(),
            limit,
        })
    }
    pub fn query(&self) -> &str {
        &self.query
    }
    pub fn limit(&self) -> u16 {
        self.limit
    }
}

/// Public-resource policy token. DNS is checked again immediately before vendor I/O.
/// This does not claim to pin a remote extraction vendor's independent DNS resolver.
#[derive(Clone)]
pub struct ValidatedPublicWebUrl(reqwest::Url);

impl ValidatedPublicWebUrl {
    pub fn parse(raw: &str) -> Result<Self, ProviderError> {
        if raw.len() > 2048 || raw.chars().any(char::is_control) {
            return Err(invalid("invalid public web URL"));
        }
        let url = reqwest::Url::parse(raw).map_err(|_| invalid("invalid public web URL"))?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || !matches!(url.port_or_known_default(), Some(80 | 443))
        {
            return Err(invalid("invalid public web URL"));
        }
        let host = url
            .host_str()
            .ok_or_else(|| invalid("web URL must target a public host"))?;
        let host_ip = host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>();
        let public = match host_ip {
            Ok(IpAddr::V4(ip)) => public_ipv4(ip),
            Ok(IpAddr::V6(ip)) => public_ipv6(ip),
            Err(_) => public_domain(host),
        };
        if !public {
            return Err(invalid("web URL must target a public host"));
        }
        Ok(Self(url))
    }
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }

    async fn validate_dns(&self) -> Result<(), ProviderError> {
        let host = self
            .0
            .host_str()
            .ok_or_else(|| invalid("invalid public web host"))?;
        if host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .is_err()
        {
            let addresses = tokio::time::timeout(
                Duration::from_secs(5),
                tokio::net::lookup_host((host, self.0.port_or_known_default().unwrap_or(443))),
            )
            .await
            .map_err(|_| invalid("public web host resolution failed"))?
            .map_err(|_| invalid("public web host resolution failed"))?;
            validate_resolved_ips(addresses.map(|address| address.ip()))?;
        }
        Ok(())
    }
}

fn public_domain(host: &str) -> bool {
    let host = host.trim_end_matches('.');
    host.contains('.')
        && !host.ends_with(".localhost")
        && ![
            "local", "internal", "home", "lan", "test", "invalid", "example",
        ]
        .iter()
        .any(|suffix| host.ends_with(&format!(".{suffix}")))
}

fn public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_multicast()
        || a == 0
        || a >= 240
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
        || (a == 203 && b == 0 && c == 113))
}

fn public_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return public_ipv4(mapped);
    }
    let segments = ip.segments();
    segments[0] & 0xe000 == 0x2000
        && !(segments[0] == 0x2001 && (segments[1] <= 0x1ff || segments[1] == 0xdb8))
        && segments[0] != 0x3fff
}

fn validate_resolved_ips(addresses: impl Iterator<Item = IpAddr>) -> Result<(), ProviderError> {
    let mut seen = false;
    for address in addresses {
        seen = true;
        if !match address {
            IpAddr::V4(ip) => public_ipv4(ip),
            IpAddr::V6(ip) => public_ipv6(ip),
        } {
            return Err(invalid("web host resolved to a nonpublic address"));
        }
    }
    if seen {
        Ok(())
    } else {
        Err(invalid("public web host resolution failed"))
    }
}

#[derive(Clone)]
pub struct WebFetchRequest {
    url: ValidatedPublicWebUrl,
    format: WebContentFormat,
}
impl WebFetchRequest {
    pub fn new(url: ValidatedPublicWebUrl, format: WebContentFormat) -> Self {
        Self { url, format }
    }
    pub fn url(&self) -> &ValidatedPublicWebUrl {
        &self.url
    }
    pub fn format(&self) -> WebContentFormat {
        self.format
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WebSearchResult {
    pub title: Option<String>,
    pub url: String,
    pub snippet: String,
    pub score: Option<f64>,
}
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FetchedPage {
    pub url: String,
    pub title: Option<String>,
    pub content: String,
    pub format: WebContentFormat,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct WebServiceUsage {
    pub requests: u64,
    pub documents: u64,
    pub provider_credits: Option<u64>,
    pub reported_cost_micro_usd: Option<u64>,
    /// Exa documents costDollars as estimated, not final billable usage.
    pub cost_is_estimate: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WebSearchOutput {
    pub results: Vec<WebSearchResult>,
    pub usage: WebServiceUsage,
}
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WebFetchOutput {
    pub results: Vec<FetchedPage>,
    pub usage: WebServiceUsage,
}

/// Kind-scoped runtime, intentionally independent of public Provider wiring.
pub struct WebServiceProvider {
    kind: WebProviderKind,
    rows: Vec<WebAccountConfig>,
    account_ids: Vec<String>,
    accounts: AccountPool,
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    quota: Arc<ProviderQuotas>,
    endpoint: &'static str,
    request_timeout: Duration,
    anonymous: bool,
    #[cfg(test)]
    test_now: Option<u64>,
    #[cfg(test)]
    test_endpoint: Option<String>,
}

impl WebServiceProvider {
    pub fn new(
        kind: WebProviderKind,
        config: &WebProviderConfig,
        policies: &[ProviderAccountPolicy],
        egress: Option<Arc<EgressClientPool>>,
        quota: Arc<ProviderQuotas>,
    ) -> Result<Self, ProviderError> {
        let endpoint = match kind {
            WebProviderKind::Tavily => "https://api.tavily.com",
            WebProviderKind::Exa => "https://api.exa.ai",
            WebProviderKind::Brave => brave::BASE_URL,
            WebProviderKind::Serper => serper::BASE_URL,
            WebProviderKind::Linkup => linkup::BASE_URL,
            WebProviderKind::Parallel => parallel::BASE_URL,
            WebProviderKind::PerplexitySearch => perplexity::BASE_URL,
            WebProviderKind::GooglePse => google_pse::BASE_URL,
            WebProviderKind::SearchApi => searchapi::BASE_URL,
            WebProviderKind::Firecrawl => firecrawl::BASE_URL,
            WebProviderKind::JinaReader => jina_reader::BASE_URL,
        };
        config
            .validate_for(kind)
            .map_err(|_| invalid("invalid web account configuration"))?;
        if policies.len() != config.accounts().len() {
            return Err(invalid("web account policy count mismatch"));
        }
        let rows = config.accounts().to_vec();
        let account_ids = rows
            .iter()
            .map(|row| {
                row.account_id(kind)
                    .map_err(|_| invalid("invalid web account context"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let accounts = AccountPool::new(rows.len());
        let mut effective_policies = policies.to_vec();
        // Acknowledgment is immutable within this provider generation. Exclude
        // inactive rows before the pool chooses its priority/round-robin group.
        // The shared sunset is checked on every call using the current clock.
        if kind == WebProviderKind::GooglePse {
            for (policy, row) in effective_policies.iter_mut().zip(&rows) {
                if row.eligibility_diagnostic(0).is_some() {
                    policy.enabled = false;
                }
            }
        }
        accounts.configure(&effective_policies);
        let client = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| invalid("web HTTP client initialization failed"))?;
        Ok(Self {
            kind,
            rows,
            account_ids,
            accounts,
            client,
            egress,
            quota,
            endpoint,
            request_timeout: Duration::from_secs(60),
            anonymous: config.is_anonymous(),
            #[cfg(test)]
            test_now: None,
            #[cfg(test)]
            test_endpoint: None,
        })
    }

    pub fn account_ids(&self) -> &[String] {
        &self.account_ids
    }
    pub fn kind(&self) -> WebProviderKind {
        self.kind
    }
    pub fn has_rotating_accounts(&self) -> bool {
        self.rows.len() > 1
            || self.accounts.has_restrictions()
            || self.egress.as_ref().is_some_and(|pool| pool.len() > 1)
    }

    pub async fn search(
        &self,
        request: &WebSearchRequest,
        session: Option<&str>,
    ) -> Result<WebSearchOutput, ProviderError> {
        if !self
            .kind
            .descriptor()
            .operations
            .contains(&WebOperation::Search)
        {
            return Err(invalid("web search is unsupported"));
        }
        let value = self
            .call(WebOperation::Search, session, |account, endpoint, now| {
                let account =
                    account.ok_or_else(|| invalid("web search requires an explicit account"))?;
                match self.kind {
                    WebProviderKind::Tavily | WebProviderKind::Exa => {
                        let (path, payload) = match self.kind {
                            WebProviderKind::Tavily => tavily::search_payload(request),
                            _ => exa::search_payload(request),
                        };
                        let builder = self
                            .client
                            .post(format!("{}{path}", endpoint.trim_end_matches('/')))
                            .json(&payload);
                        Ok(match self.kind {
                            WebProviderKind::Tavily => builder.bearer_auth(account.api_key()),
                            _ => builder.header("x-api-key", account.api_key()),
                        })
                    }
                    WebProviderKind::Brave => {
                        brave::request(&self.client, endpoint, account, request, now)
                    }
                    WebProviderKind::Serper => {
                        serper::request(&self.client, endpoint, account, request, now)
                    }
                    WebProviderKind::Linkup => {
                        linkup::request(&self.client, endpoint, account, request, now)
                    }
                    WebProviderKind::Parallel => {
                        parallel::request(&self.client, endpoint, account, request, now)
                    }
                    WebProviderKind::PerplexitySearch => {
                        perplexity::request(&self.client, endpoint, account, request, now)
                    }
                    WebProviderKind::GooglePse => {
                        google_pse::request(&self.client, endpoint, account, request, now)
                    }
                    WebProviderKind::SearchApi => {
                        searchapi::request(&self.client, endpoint, account, request, now)
                    }
                    _ => Err(invalid("web search is unsupported")),
                }
            })
            .await?;
        match self.kind {
            WebProviderKind::Tavily => tavily::parse_search(&value, request.limit),
            WebProviderKind::Exa => exa::parse_search(&value, request.limit),
            WebProviderKind::Brave => brave::parse_search(&value, request.limit),
            WebProviderKind::Serper => serper::parse_search(&value, request.limit),
            WebProviderKind::Linkup => linkup::parse_search(&value, request.limit),
            WebProviderKind::Parallel => parallel::parse_search(&value, request.limit),
            WebProviderKind::PerplexitySearch => perplexity::parse_search(&value, request.limit),
            WebProviderKind::GooglePse => google_pse::parse_search(&value, request.limit),
            WebProviderKind::SearchApi => searchapi::parse_search(&value, request.limit),
            _ => Err(invalid("web search is unsupported")),
        }
    }

    pub async fn fetch(
        &self,
        request: &WebFetchRequest,
        session: Option<&str>,
    ) -> Result<WebFetchOutput, ProviderError> {
        if !self
            .kind
            .descriptor()
            .operations
            .contains(&WebOperation::Fetch)
            || !self.kind.descriptor().formats.contains(&request.format)
        {
            return Err(invalid("web fetch format is unsupported"));
        }
        request.url.validate_dns().await?;
        let value = self
            .call(
                WebOperation::Fetch,
                session,
                |account, endpoint, _now| match self.kind {
                    WebProviderKind::JinaReader => {
                        let auth = match account {
                            Some(account) => jina_reader::JinaAuth::Account(account),
                            None => jina_reader::JinaAuth::Anonymous,
                        };
                        jina_reader::request(&self.client, endpoint, auth, request)
                    }
                    WebProviderKind::Firecrawl => firecrawl::request(
                        &self.client,
                        endpoint,
                        account.ok_or_else(|| invalid("web fetch requires an explicit account"))?,
                        request,
                    ),
                    WebProviderKind::Tavily | WebProviderKind::Exa => {
                        let account = account
                            .ok_or_else(|| invalid("web fetch requires an explicit account"))?;
                        let (path, payload) = match self.kind {
                            WebProviderKind::Tavily => tavily::fetch_payload(request),
                            _ => exa::fetch_payload(request),
                        };
                        let builder = self
                            .client
                            .post(format!("{}{path}", endpoint.trim_end_matches('/')))
                            .json(&payload);
                        Ok(match self.kind {
                            WebProviderKind::Tavily => builder.bearer_auth(account.api_key()),
                            _ => builder.header("x-api-key", account.api_key()),
                        })
                    }
                    _ => Err(invalid("web fetch is unsupported")),
                },
            )
            .await?;
        match self.kind {
            WebProviderKind::Tavily => tavily::parse_fetch(&value, request),
            WebProviderKind::Exa => exa::parse_fetch(&value, request),
            WebProviderKind::Firecrawl => firecrawl::parse_fetch(&value, request),
            WebProviderKind::JinaReader => jina_reader::parse_fetch(&value, request),
            _ => Err(invalid("web fetch is unsupported")),
        }
    }

    fn now_unix_seconds(&self) -> u64 {
        #[cfg(test)]
        if let Some(now) = self.test_now {
            return now;
        }
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }

    async fn call(
        &self,
        operation: WebOperation,
        session: Option<&str>,
        make_request: impl Fn(
            Option<&WebAccountConfig>,
            &str,
            u64,
        ) -> Result<reqwest::RequestBuilder, ProviderError>,
    ) -> Result<Value, ProviderError> {
        let provider = self.kind.descriptor().provider_id;
        let session = session.map(|value| format!("{provider}:{operation:?}:{value}"));
        let endpoint = self.endpoint;
        #[cfg(test)]
        let endpoint = self.test_endpoint.as_deref().unwrap_or(endpoint);
        let now = self.now_unix_seconds();
        if self.kind == WebProviderKind::GooglePse
            && self
                .rows
                .iter()
                .all(|row| row.eligibility_diagnostic(now).is_some())
        {
            return Err(invalid(
                "Google search accounts are inactive under legacy eligibility policy",
            ));
        }
        let candidates: Vec<Option<usize>> = if self.anonymous {
            vec![None]
        } else {
            self.accounts
                .candidates(session.as_deref())
                .into_iter()
                .filter(|index| self.rows[*index].eligibility_diagnostic(now).is_none())
                .map(Some)
                .collect()
        };
        let mut last = None;
        for index in candidates {
            let account = index.map(|index| &self.rows[index]);
            let template = make_request(account, endpoint, now)?
                .timeout(self.request_timeout)
                .build()
                .map_err(|_| invalid("web request construction failed"))?;
            // All requests use buffered JSON/form or no body; prove cloneability
            // before calling transport selection. The same wire is rebound only
            // to the actual chosen bounded/no-redirect egress client.
            if template.try_clone().is_none() {
                return Err(invalid("web request body is not replay-safe to prepare"));
            }
            let response = send_with_egress(
                &self.client,
                self.egress.as_deref(),
                session.as_deref(),
                provider,
                0,
                |client| {
                    reqwest::RequestBuilder::from_parts(
                        client.clone(),
                        template
                            .try_clone()
                            .expect("validated buffered web request"),
                    )
                },
            )
            .await?;
            let limits = crate::parse_rate_limit(response.headers());
            match response.status().as_u16() {
                429 => {
                    let retry_after = limits.as_ref().and_then(|info| info.retry_after);
                    let reset_at = limits.as_ref().and_then(|info| info.reset_at);
                    if let Some(index) = index {
                        self.accounts.record_rate_limit(index, retry_after);
                    }
                    self.quota
                        .record_rate_limited(provider, retry_after, reset_at);
                    last = Some(ProviderError::RateLimited {
                        provider: provider.to_owned(),
                        retry_after,
                        reset_at,
                    });
                    continue;
                }
                402 => {
                    if let Some(index) = index {
                        self.accounts.record_rate_limit(index, Some(300));
                    }
                    last = Some(ProviderError::PaymentRequired {
                        provider: provider.to_owned(),
                        message: "web account payment required".to_owned(),
                    });
                    continue;
                }
                401 | 403 => return Err(invalid("web credential rejected")),
                408 | 500..=599 => {
                    return Err(ProviderError::DeliveryUncertain(
                        "web upstream execution is uncertain".to_owned(),
                    ))
                }
                200..=299 => {}
                _ => return Err(invalid("web upstream request rejected")),
            }
            let value = read_json(response).await?;
            if let Some(index) = index {
                self.accounts.record_success(session.as_deref(), index);
            }
            self.quota
                .record_success(provider, &limits.unwrap_or_default());
            return Ok(value);
        }
        Err(last.unwrap_or_else(|| ProviderError::RateLimited {
            provider: provider.to_owned(),
            retry_after: None,
            reset_at: None,
        }))
    }
}

async fn read_json(mut response: reqwest::Response) -> Result<Value, ProviderError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(uncertain("web response exceeds byte limit"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| uncertain("web response read failed"))?
    {
        if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(bytes.len()) {
            return Err(uncertain("web response exceeds byte limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| uncertain("web response is not valid JSON"))
}

pub(super) fn invalid(message: &'static str) -> ProviderError {
    ProviderError::Provider(message.to_owned())
}
pub(super) fn uncertain(message: &'static str) -> ProviderError {
    ProviderError::DeliveryUncertain(message.to_owned())
}
pub(super) fn optional_text(value: &Value) -> Result<Option<String>, ProviderError> {
    match value {
        Value::Null => Ok(None),
        Value::String(text) if text.len() <= MAX_PAGE_BYTES => Ok(Some(text.clone())),
        _ => Err(uncertain("web response text is invalid")),
    }
}
pub(super) fn required_text(value: &Value) -> Result<String, ProviderError> {
    optional_text(value)?.ok_or_else(|| uncertain("web response text is missing"))
}
pub(super) fn result_url(value: &Value) -> Result<String, ProviderError> {
    let value = value
        .as_str()
        .ok_or_else(|| uncertain("web response URL is missing"))?;
    ValidatedPublicWebUrl::parse(value)
        .map(|url| url.as_str().to_owned())
        .map_err(|_| uncertain("web response URL is invalid"))
}
pub(super) fn score(value: &Value) -> Result<Option<f64>, ProviderError> {
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_f64()
        .filter(|value| value.is_finite())
        .map(Some)
        .ok_or_else(|| uncertain("web response score is invalid"))
}

impl crate::Provider for WebServiceProvider {
    fn name(&self) -> &'static str {
        self.kind.descriptor().provider_id
    }

    fn web_descriptor(&self) -> Option<&'static ryu_gw_credentials::web::WebProviderDescriptor> {
        Some(self.kind.descriptor())
    }

    fn configure_account_policies(&self, policies: &[ProviderAccountPolicy]) {
        self.accounts.configure(policies);
    }

    fn has_rotating_accounts(&self) -> bool {
        WebServiceProvider::has_rotating_accounts(self)
    }

    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>,
    > {
        Box::pin(async { Err(invalid("web service does not support chat completions")) })
    }

    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<axum::body::Body, ProviderError>> + Send + 'a>,
    > {
        Box::pin(async { Err(invalid("web service does not support chat completions")) })
    }

    fn web_search_for_session<'a>(
        &'a self,
        request: &'a WebSearchRequest,
        session: Option<&'a str>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<WebSearchOutput, ProviderError>> + Send + 'a>,
    > {
        Box::pin(self.search(request, session))
    }

    fn web_fetch_for_session<'a>(
        &'a self,
        request: &'a WebFetchRequest,
        session: Option<&'a str>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<WebFetchOutput, ProviderError>> + Send + 'a>,
    > {
        Box::pin(self.fetch(request, session))
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn service_trait_keeps_anonymous_fetch_separate_from_chat_models() {
        let config = ryu_gw_credentials::web::WebProviderConfig::anonymous(
            ryu_gw_credentials::web::WebProviderKind::JinaReader,
        )
        .unwrap();
        let provider = super::WebServiceProvider::new(
            ryu_gw_credentials::web::WebProviderKind::JinaReader,
            &config,
            &[],
            None,
            std::sync::Arc::new(crate::ProviderQuotas::new()),
        )
        .unwrap();
        let backend: &dyn crate::Provider = &provider;
        assert_eq!(backend.name(), "jina-reader");
        assert_eq!(
            backend.web_descriptor().unwrap().operations,
            &[ryu_gw_credentials::web::WebOperation::Fetch]
        );
        assert!(provider.account_ids().is_empty());
        assert!(backend
            .complete("invented-model", &serde_json::json!({}))
            .await
            .is_err());
        assert!(backend
            .complete_stream("invented-model", &serde_json::json!({}))
            .await
            .is_err());
        let search = super::WebSearchRequest::new("query".into(), 1).unwrap();
        assert!(backend.web_search_for_session(&search, None).await.is_err());
    }
    use super::*;
    use crate::test_support::{MockResponse, MockServer};
    use ryu_gw_credentials::web::WebAccountContext;

    #[tokio::test]
    async fn common_dispatcher_executes_all_nine_search_wire_formats() {
        use ryu_gw_credentials::web::{SearchApiEngine, GOOGLE_PSE_SUNSET_UNIX_SECONDS};
        for (kind, body, path, method) in [
            (
                WebProviderKind::Tavily,
                r#"{"results":[{"url":"https://example.com","content":"ok"}]}"#,
                "/search",
                "POST",
            ),
            (
                WebProviderKind::Exa,
                r#"{"results":[{"url":"https://example.com","text":"ok"}]}"#,
                "/search",
                "POST",
            ),
            (
                WebProviderKind::Brave,
                r#"{"web":{"results":[{"url":"https://example.com","description":"ok"}]}}"#,
                "/res/v1/web/search",
                "GET",
            ),
            (
                WebProviderKind::Serper,
                r#"{"organic":[{"link":"https://example.com","snippet":"ok"}]}"#,
                "/search",
                "POST",
            ),
            (
                WebProviderKind::Linkup,
                r#"{"results":[{"url":"https://example.com","content":"ok"}]}"#,
                "/v1/search",
                "POST",
            ),
            (
                WebProviderKind::Parallel,
                r#"{"results":[{"url":"https://example.com","excerpts":["ok"]}]}"#,
                "/v1/search",
                "POST",
            ),
            (
                WebProviderKind::PerplexitySearch,
                r#"{"results":[{"url":"https://example.com","snippet":"ok"}]}"#,
                "/search",
                "POST",
            ),
            (
                WebProviderKind::GooglePse,
                r#"{"items":[{"link":"https://example.com","snippet":"ok"}]}"#,
                "/customsearch/v1",
                "GET",
            ),
            (
                WebProviderKind::SearchApi,
                r#"{"organic_results":[{"link":"https://example.com","snippet":"ok"}]}"#,
                "/api/v1/search",
                "GET",
            ),
        ] {
            let server = MockServer::always(MockResponse::ok_json(body)).await;
            let context = match kind {
                WebProviderKind::GooglePse => WebAccountContext::GooglePse {
                    engine_id: "engine".into(),
                    existing_customer_acknowledged: true,
                },
                WebProviderKind::SearchApi => WebAccountContext::SearchApi {
                    engine: SearchApiEngine::Google,
                },
                _ => WebAccountContext::Default,
            };
            let row = WebAccountConfig::new("synthetic-key".into(), context).unwrap();
            let config = WebProviderConfig::new_accounts(kind, vec![row]).unwrap();
            let mut provider = WebServiceProvider::new(
                kind,
                &config,
                &[ProviderAccountPolicy::default()],
                None,
                Arc::new(ProviderQuotas::new()),
            )
            .unwrap();
            provider.test_endpoint = Some(server.base_url().into());
            provider.test_now = Some(GOOGLE_PSE_SUNSET_UNIX_SECONDS - 1);
            let output = provider
                .search(
                    &WebSearchRequest::new("q".into(), 3).unwrap(),
                    Some("tenant:session"),
                )
                .await
                .unwrap();
            assert_eq!(output.results[0].snippet, "ok");
            assert_eq!(output.usage.requests, 1);
            let requests = server.requests();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].path, path);
            assert_eq!(requests[0].method, method);
        }
    }

    #[tokio::test]
    async fn common_dispatcher_executes_four_fetchers_and_keeps_anonymous_jina_without_accounts() {
        for (kind, body, path, format) in [
            (
                WebProviderKind::Tavily,
                r#"{"results":[{"url":"https://8.8.8.8/page","raw_content":"ok"}]}"#,
                "/extract",
                WebContentFormat::Markdown,
            ),
            (
                WebProviderKind::Exa,
                r#"{"results":[{"url":"https://8.8.8.8/page","text":"ok"}],"statuses":[{"id":"https://8.8.8.8/page","status":"success"}]}"#,
                "/contents",
                WebContentFormat::Text,
            ),
            (
                WebProviderKind::Firecrawl,
                r#"{"success":true,"data":{"markdown":"ok","metadata":{"sourceURL":"https://8.8.8.8/page"}}}"#,
                "/v2/scrape",
                WebContentFormat::Markdown,
            ),
            (
                WebProviderKind::JinaReader,
                r#"{"code":200,"data":{"url":"https://8.8.8.8/page","content":"ok"}}"#,
                "/",
                WebContentFormat::Markdown,
            ),
        ] {
            let server = MockServer::always(MockResponse::ok_json(body)).await;
            let config = if kind == WebProviderKind::JinaReader {
                WebProviderConfig::anonymous(kind).unwrap()
            } else {
                WebProviderConfig::new_accounts(
                    kind,
                    vec![
                        WebAccountConfig::new("synthetic-key".into(), WebAccountContext::Default)
                            .unwrap(),
                    ],
                )
                .unwrap()
            };
            let policies = vec![ProviderAccountPolicy::default(); config.accounts().len()];
            let mut provider = WebServiceProvider::new(
                kind,
                &config,
                &policies,
                None,
                Arc::new(ProviderQuotas::new()),
            )
            .unwrap();
            provider.test_endpoint = Some(server.base_url().into());
            let output = provider
                .fetch(
                    &WebFetchRequest::new(
                        ValidatedPublicWebUrl::parse("https://8.8.8.8/page").unwrap(),
                        format,
                    ),
                    Some("tenant:session"),
                )
                .await
                .unwrap();
            assert_eq!(output.results[0].content, "ok");
            assert_eq!(output.usage.documents, 1);
            let requests = server.requests();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].path, path);
            if kind == WebProviderKind::JinaReader {
                assert!(requests[0].header("authorization").is_none());
                assert!(provider.account_ids().is_empty());
                assert!(provider.rows.is_empty());
            }
        }
    }

    #[tokio::test]
    async fn google_dispatcher_selects_exact_engine_context_and_skips_inactive_priority_group() {
        use axum::{extract::Query, routing::get, Json, Router};
        use ryu_gw_credentials::web::GOOGLE_PSE_SUNSET_UNIX_SECONDS;
        async fn inspect(
            Query(query): Query<std::collections::HashMap<String, String>>,
        ) -> Json<Value> {
            assert_eq!(query.get("key").map(String::as_str), Some("synthetic-key"));
            Json(
                serde_json::json!({"items":[{"title":query.get("cx"),"link":"https://example.com","snippet":"ok"}]}),
            )
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().route("/customsearch/v1", get(inspect));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let rows = [
            ("inactive", false),
            ("engine-one", true),
            ("engine-two", true),
        ]
        .into_iter()
        .map(|(engine, ack)| {
            WebAccountConfig::new(
                "synthetic-key".into(),
                WebAccountContext::GooglePse {
                    engine_id: engine.into(),
                    existing_customer_acknowledged: ack,
                },
            )
            .unwrap()
        })
        .collect();
        let config = WebProviderConfig::new_accounts(WebProviderKind::GooglePse, rows).unwrap();
        let policies = [
            ProviderAccountPolicy::default(),
            ProviderAccountPolicy {
                priority: 1,
                ..Default::default()
            },
            ProviderAccountPolicy {
                priority: 1,
                ..Default::default()
            },
        ];
        let mut provider = WebServiceProvider::new(
            WebProviderKind::GooglePse,
            &config,
            &policies,
            None,
            Arc::new(ProviderQuotas::new()),
        )
        .unwrap();
        provider.test_endpoint = Some(endpoint);
        provider.test_now = Some(GOOGLE_PSE_SUNSET_UNIX_SECONDS - 1);
        assert_ne!(provider.account_ids()[1], provider.account_ids()[2]);
        let query = WebSearchRequest::new("q".into(), 3).unwrap();
        for (session, engine) in [
            ("tenant:one", "engine-one"),
            ("tenant:two", "engine-two"),
            ("tenant:one", "engine-one"),
        ] {
            assert_eq!(
                provider
                    .search(&query, Some(session))
                    .await
                    .unwrap()
                    .results[0]
                    .title
                    .as_deref(),
                Some(engine)
            );
        }
        provider.test_now = Some(GOOGLE_PSE_SUNSET_UNIX_SECONDS);
        let error = provider
            .search(&query, Some("tenant:one"))
            .await
            .unwrap_err();
        assert!(!error.to_string().contains("synthetic-key"));
        server.abort();
    }

    #[tokio::test]
    async fn paid_rejection_rotates_accounts_but_redirects_and_oversized_responses_do_not() {
        let server = MockServer::start(vec![
            MockResponse::json(402, "private-body"),
            MockResponse::ok_json(r#"{"results":[]}"#),
        ])
        .await;
        let provider = fixture(
            WebProviderKind::Exa,
            server.base_url(),
            &["first", "second"],
            vec![ProviderAccountPolicy::default(); 2],
        );
        let request = WebSearchRequest::new("query".into(), 10).unwrap();
        assert!(provider
            .search(&request, None)
            .await
            .unwrap()
            .results
            .is_empty());
        assert_eq!(
            server.requests()[0].header("x-api-key").as_deref(),
            Some("first")
        );
        assert_eq!(
            server.requests()[1].header("x-api-key").as_deref(),
            Some("second")
        );

        let foreign = MockServer::always(MockResponse::ok_json(r#"{"results":[]}"#)).await;
        for response in [
            MockResponse::json(302, "{}").with_header("location", foreign.base_url()),
            MockResponse::ok_json(format!(
                r#"{{"results":[],"padding":"{}"}}"#,
                "x".repeat(MAX_RESPONSE_BYTES)
            )),
        ] {
            let server = MockServer::always(response).await;
            let provider = fixture(
                WebProviderKind::Exa,
                server.base_url(),
                &["first", "second"],
                vec![ProviderAccountPolicy::default(); 2],
            );
            assert!(provider.search(&request, None).await.is_err());
            assert_eq!(server.requests().len(), 1);
            assert!(foreign.requests().is_empty());
        }
    }

    #[tokio::test]
    async fn proxy_407_moves_before_delivery_and_upstream_failure_is_not_replayed() {
        let denied = MockServer::always(MockResponse::json(407, "{}")).await;
        let accepted = MockServer::start(vec![
            MockResponse::ok_json(r#"{"results":[]}"#),
            MockResponse::json(503, "private-body"),
        ])
        .await;
        let untouched = MockServer::always(MockResponse::ok_json(r#"{"results":[]}"#)).await;
        let clients = [denied.base_url(), accepted.base_url(), untouched.base_url()]
            .into_iter()
            .map(|url| {
                reqwest::Client::builder()
                    .no_proxy()
                    .proxy(reqwest::Proxy::all(url).unwrap())
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(Duration::from_secs(5))
                    .build()
                    .unwrap()
            })
            .collect();
        let mut provider = fixture(
            WebProviderKind::Tavily,
            "http://upstream.invalid",
            &["same-key"],
            vec![ProviderAccountPolicy::default()],
        );
        provider.egress = Some(Arc::new(EgressClientPool::new(clients).unwrap()));
        let request = WebSearchRequest::new("query".into(), 10).unwrap();
        assert!(provider
            .search(&request, Some("tenant:session"))
            .await
            .unwrap()
            .results
            .is_empty());
        assert!(matches!(
            provider.search(&request, Some("tenant:session")).await,
            Err(ProviderError::DeliveryUncertain(_))
        ));
        assert_eq!(denied.requests().len(), 1);
        assert_eq!(accepted.requests().len(), 2);
        assert!(untouched.requests().is_empty());
        for request in accepted.requests() {
            assert_eq!(
                request.header("authorization").as_deref(),
                Some("Bearer same-key")
            );
        }
    }

    #[tokio::test]
    async fn accepted_body_timeout_does_not_replay_on_second_account() {
        use axum::{extract::State, routing::post, Json, Router};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let seen = Arc::new(AtomicUsize::new(0));
        async fn stalled(
            State(seen): State<Arc<AtomicUsize>>,
            Json(_): Json<Value>,
        ) -> Json<Value> {
            seen.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_secs(1)).await;
            Json(serde_json::json!({"results":[]}))
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .route("/search", post(stalled))
            .with_state(Arc::clone(&seen));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let mut provider = fixture(
            WebProviderKind::Tavily,
            &endpoint,
            &["first", "second"],
            vec![ProviderAccountPolicy::default(); 2],
        );
        provider.request_timeout = Duration::from_millis(100);
        assert!(matches!(
            provider
                .search(&WebSearchRequest::new("query".into(), 10).unwrap(), None)
                .await,
            Err(ProviderError::DeliveryUncertain(_))
        ));
        assert_eq!(seen.load(Ordering::SeqCst), 1);
        server.abort();
    }

    pub(super) fn fixture(
        kind: WebProviderKind,
        endpoint: &str,
        keys: &[&str],
        policies: Vec<ProviderAccountPolicy>,
    ) -> WebServiceProvider {
        let rows = keys
            .iter()
            .map(|key| WebAccountConfig::new((*key).into(), WebAccountContext::Default).unwrap())
            .collect();
        let config = WebProviderConfig::new_accounts(kind, rows).unwrap();
        let mut provider = WebServiceProvider::new(
            kind,
            &config,
            &policies,
            None,
            Arc::new(ProviderQuotas::new()),
        )
        .unwrap();
        provider.test_endpoint = Some(endpoint.into());
        provider
    }

    #[test]
    fn rejects_private_and_ambiguous_urls_and_mixed_dns_results() {
        for url in [
            "http://127.0.0.1",
            "http://2130706433",
            "http://0x7f000001",
            "http://10.0.0.1",
            "http://169.254.169.254",
            "http://100.64.0.1",
            "http://[::1]",
            "http://[::ffff:127.0.0.1]",
            "http://[fc00::1]",
            "http://localhost",
            "http://foo.local",
            "http://foo.localhost.",
            "https://user:password@example.com",
            "file:///etc/passwd",
            "https://example.com:8443/",
            "https://example.com/#fragment",
        ] {
            assert!(ValidatedPublicWebUrl::parse(url).is_err(), "{url}");
        }
        assert!(ValidatedPublicWebUrl::parse("https://8.8.8.8/page").is_ok());
        assert!(validate_resolved_ips(
            ["8.8.8.8".parse().unwrap(), "10.0.0.1".parse().unwrap()].into_iter()
        )
        .is_err());
        assert!(validate_resolved_ips(std::iter::empty()).is_err());
    }

    #[tokio::test]
    async fn quota_rotation_and_sticky_policy_are_kind_scoped() {
        let server = MockServer::start(vec![
            MockResponse::json(429, "{}").with_header("retry-after", "60"),
            MockResponse::ok_json(r#"{"results":[],"usage":{"credits":0}}"#),
            MockResponse::ok_json(r#"{"results":[]}"#),
        ])
        .await;
        let provider = fixture(
            WebProviderKind::Tavily,
            server.base_url(),
            &["first", "second", "disabled"],
            vec![
                ProviderAccountPolicy::default(),
                ProviderAccountPolicy {
                    priority: 1,
                    ..Default::default()
                },
                ProviderAccountPolicy {
                    enabled: false,
                    ..Default::default()
                },
            ],
        );
        let request = WebSearchRequest::new("query".into(), 10).unwrap();
        assert_eq!(
            provider
                .search(&request, Some("tenant:session"))
                .await
                .unwrap()
                .usage
                .provider_credits,
            Some(0)
        );
        assert!(provider
            .search(&request, Some("tenant:session"))
            .await
            .unwrap()
            .results
            .is_empty());
        let requests = server.requests();
        assert_eq!(requests.len(), 3);
        assert_eq!(
            requests[0].header("authorization").as_deref(),
            Some("Bearer first")
        );
        for request in &requests[1..] {
            assert_eq!(
                request.header("authorization").as_deref(),
                Some("Bearer second")
            );
        }
        assert_eq!(provider.account_ids().len(), 3);
    }

    #[tokio::test]
    async fn rejected_auth_and_malformed_success_do_not_replay_or_echo_material() {
        for response in [
            MockResponse::json(401, r#"{"error":"first raw-secret"}"#),
            MockResponse::ok_json(r#"{"message":"first raw-secret"}"#),
            MockResponse::ok_json("not-json"),
            MockResponse::json(503, "raw-secret"),
        ] {
            let server = MockServer::always(response).await;
            let provider = fixture(
                WebProviderKind::Tavily,
                server.base_url(),
                &["first", "second"],
                vec![ProviderAccountPolicy::default(); 2],
            );
            let error = provider
                .search(&WebSearchRequest::new("query".into(), 10).unwrap(), None)
                .await
                .unwrap_err();
            assert!(!error.to_string().contains("raw-secret"));
            assert_eq!(server.requests().len(), 1);
        }
    }

    #[tokio::test]
    async fn query_limits_and_unsupported_operation_reject_before_io() {
        for (query, limit) in [
            (" ".into(), 1),
            ("x".repeat(401), 1),
            ("x".into(), 0),
            ("x".into(), 11),
            ("x\nheader".into(), 1),
        ] {
            assert!(WebSearchRequest::new(query, limit).is_err());
        }
        let config = WebProviderConfig::anonymous(WebProviderKind::JinaReader).unwrap();
        let provider = WebServiceProvider::new(
            WebProviderKind::JinaReader,
            &config,
            &[],
            None,
            Arc::new(ProviderQuotas::new()),
        )
        .unwrap();
        assert!(provider
            .search(&WebSearchRequest::new("q".into(), 10).unwrap(), None)
            .await
            .is_err());
        assert!(provider.rows.is_empty());
        assert!(provider.account_ids().is_empty());
    }
}
