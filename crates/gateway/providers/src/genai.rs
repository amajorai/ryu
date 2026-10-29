use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;

use axum::body::Body;
use base64::Engine as _;
use bytes::Bytes;
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};
use tracing::debug;

// External `genai` crate (disambiguated with a leading `::` so it is never
// confused with this `crate::providers::genai` module).
use ::genai::chat::{
    ChatMessage, ChatOptions, ChatRequest, ChatResponse, ChatRole, ChatStreamEvent, ContentPart,
    MessageContent, StopReason, StreamChunk, Tool, ToolCall, ToolChoice, ToolResponse,
};
use ::genai::resolver::{AuthData, AuthResolver};
use ::genai::{Client, ModelIden};

use crate::account_pool::AccountPool;
use crate::error::ProviderError;
use crate::quota::ProviderQuotas;
use ryu_gw_credentials::{
    sdk_provider_by_kind, SdkAuthKind, SdkEndpointConfig, SdkProviderDescriptor,
};

use super::{
    check_service_response, egress::send_with_egress, is_account_auth_failure, parse_rate_limit,
    upstream_status_error, EgressClientPool, Provider, STREAM_READ_TIMEOUT, STREAM_TOTAL_TIMEOUT,
};

const GEMINI_IMAGE_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1";

/// Total for one non-streaming SDK chat call. The SDK client itself carries the
/// stream total ([`STREAM_TOTAL_TIMEOUT`]), because the SDK cannot lift a
/// client's total timeout per request and it would otherwise cut every stream
/// that is still producing tokens.
const SDK_COMPLETION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// One account's failed attempt. `auth_rejected` marks an upstream refusal of
/// the key itself (a 401, or a 403 whose body names a key problem; see
/// [`is_account_auth_failure`]), so the next account may still serve.
struct AccountAttemptError {
    error: ProviderError,
    auth_rejected: bool,
}

impl AccountAttemptError {
    fn from_sdk(error: ::genai::Error, provider: &str) -> Self {
        let auth_rejected = genai_error_status(&error).is_some_and(|(status, _)| {
            is_account_auth_failure(status, genai_error_body(&error).unwrap_or_default())
        });
        Self {
            error: map_genai_error(error, provider),
            auth_rejected,
        }
    }
}

impl From<ProviderError> for AccountAttemptError {
    fn from(error: ProviderError) -> Self {
        Self {
            error,
            auth_rejected: false,
        }
    }
}

/// One explicit SDK adapter, with a private account and cooldown pool.
pub struct GenAiProvider {
    descriptor: &'static SdkProviderDescriptor,
    clients: Vec<Client>,
    keys: Vec<String>,
    context: SdkEndpointConfig,
    quota: Arc<ProviderQuotas>,
    egress: Option<Arc<EgressClientPool>>,
    #[cfg(test)]
    sdk_test_endpoint: Option<String>,
    accounts: AccountPool,
    image_client: reqwest::Client,
    image_base_url: String,
}

impl GenAiProvider {
    #[cfg(test)]
    fn image_fixture(
        mut keys: HashMap<String, String>,
        additional: Vec<String>,
        http: reqwest::Client,
        endpoint: String,
    ) -> Self {
        let mut credentials: Vec<String> = keys.remove("gemini").into_iter().collect();
        credentials.extend(additional);
        if credentials.is_empty() {
            credentials.push("fixture-key".to_owned());
        }
        let mut result = Self::new_for_kind(
            sdk_provider_by_kind("gemini").unwrap(),
            credentials,
            SdkEndpointConfig::Default,
            http,
            None,
            Arc::new(ProviderQuotas::new()),
        )
        .unwrap();
        result.image_base_url = endpoint;
        result
    }
    #[cfg(test)]
    fn fixture(keys: HashMap<String, String>) -> Self {
        Self::image_fixture(
            keys,
            Vec::new(),
            reqwest::Client::new(),
            GEMINI_IMAGE_BASE_URL.to_owned(),
        )
    }
    #[cfg(test)]
    fn egress_fixture(
        keys: HashMap<String, String>,
        additional: Vec<String>,
        http: reqwest::Client,
        egress: Option<Arc<EgressClientPool>>,
    ) -> Self {
        let mut result =
            Self::image_fixture(keys, additional, http, GEMINI_IMAGE_BASE_URL.to_owned());
        result.egress = egress;
        result
    }

    pub fn new_for_kind(
        descriptor: &'static SdkProviderDescriptor,
        keys: Vec<String>,
        context: SdkEndpointConfig,
        image_client: reqwest::Client,
        egress: Option<Arc<EgressClientPool>>,
        quota: Arc<ProviderQuotas>,
    ) -> Result<Self, ProviderError> {
        if context.kind() != descriptor.context_kind {
            return Err(ProviderError::Provider(format!(
                "{} endpoint context mismatch",
                descriptor.provider_id
            )));
        }
        let mut unique = Vec::new();
        for key in keys {
            if key.trim().is_empty() || key.contains(['\r', '\n']) {
                return Err(ProviderError::Provider("invalid SDK credential".to_owned()));
            }
            if !unique.contains(&key) {
                unique.push(key);
            }
        }
        let endpoint = context_endpoint(&context)?;
        let anonymous = descriptor.auth_kind == SdkAuthKind::NoAuth;
        if anonymous == !unique.is_empty() {
            return Err(ProviderError::Provider(
                "SDK authentication configuration mismatch".to_owned(),
            ));
        }
        let http = reqwest_sdk::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .read_timeout(STREAM_READ_TIMEOUT)
            .timeout(STREAM_TOTAL_TIMEOUT)
            .redirect(reqwest_sdk::redirect::Policy::none())
            .build()
            .map_err(|_| {
                ProviderError::Transport("SDK HTTP client initialization failed".to_owned())
            })?;
        let auths: Vec<AuthData> = if anonymous {
            vec![AuthData::None]
        } else {
            unique.iter().cloned().map(AuthData::from_single).collect()
        };
        let clients = auths
            .into_iter()
            .map(|auth| build_genai_client(descriptor, auth, endpoint.clone(), http.clone()))
            .collect();
        Ok(Self {
            descriptor,
            accounts: AccountPool::new(unique.len()),
            clients,
            keys: unique,
            context,
            quota,
            egress,
            #[cfg(test)]
            sdk_test_endpoint: None,
            image_client,
            image_base_url: GEMINI_IMAGE_BASE_URL.to_owned(),
        })
    }

    fn account_candidates(&self, _model: &str, session: Option<&str>) -> Vec<usize> {
        if self.descriptor.auth_kind == SdkAuthKind::NoAuth {
            vec![0]
        } else {
            self.accounts.candidates(session)
        }
    }

    fn sdk_transports(
        &self,
        account: usize,
        session: Option<&str>,
    ) -> Result<Vec<(Option<usize>, Client)>, ProviderError> {
        let Some(pool) = &self.egress else {
            return Ok(vec![(None, self.clients[account].clone())]);
        };
        let mut clients = Vec::new();
        for (index, _) in pool.candidates(session) {
            let http = pool.sdk_client(index).ok_or_else(|| {
                ProviderError::Transport(
                    "GenAI SDK transport is missing for the configured endpoint".to_owned(),
                )
            })?;
            let auth = if self.descriptor.auth_kind == SdkAuthKind::NoAuth {
                AuthData::None
            } else {
                AuthData::from_single(self.keys[account].clone())
            };
            let endpoint = context_endpoint(&self.context)?;
            #[cfg(test)]
            let endpoint = self.sdk_test_endpoint.clone().or(endpoint);
            let client = build_genai_client(self.descriptor, auth, endpoint, http.clone());
            clients.push((Some(index), client));
        }
        if clients.is_empty() {
            return Err(ProviderError::Transport(
                "all GenAI egress endpoints are cooling down".to_owned(),
            ));
        }
        Ok(clients)
    }

    fn transport_failed(&self, index: Option<usize>, error: &ProviderError) -> bool {
        if let (Some(pool), Some(index)) = (&self.egress, index) {
            match error {
                ProviderError::Transport(_) => {
                    pool.record_failure(index, None);
                    return true;
                }
                ProviderError::DeliveryUncertain(_) => pool.record_failure(index, None),
                _ => {}
            }
        }
        false
    }

    fn transport_succeeded(&self, index: Option<usize>, session: Option<&str>) {
        if let (Some(pool), Some(index)) = (&self.egress, index) {
            pool.record_success(session, index);
        }
    }

    async fn chat_on_account(
        &self,
        index: usize,
        session: Option<&str>,
        model: &str,
        body: &Value,
        options: &ChatOptions,
    ) -> Result<ChatResponse, AccountAttemptError> {
        let mut last = None;
        for (transport, client) in self.sdk_transports(index, session)? {
            let request = client.exec_chat(model, build_request(body)?, Some(options));
            let attempt = match tokio::time::timeout(SDK_COMPLETION_TIMEOUT, request).await {
                Ok(Ok(response)) => {
                    self.transport_succeeded(transport, session);
                    return Ok(response);
                }
                Ok(Err(error)) => AccountAttemptError::from_sdk(error, self.descriptor.provider_id),
                // The same classification as a client-level timeout: the
                // request may have reached a generation still running upstream.
                Err(_) => ProviderError::DeliveryUncertain(
                    "GenAI request delivery is uncertain".to_owned(),
                )
                .into(),
            };
            if self.transport_failed(transport, &attempt.error) {
                last = Some(attempt.error);
            } else {
                return Err(attempt);
            }
        }
        Err(last
            .unwrap_or_else(|| {
                ProviderError::Transport(
                    "GenAI egress endpoints rejected their connections".to_owned(),
                )
            })
            .into())
    }

    async fn stream_on_account(
        &self,
        index: usize,
        session: Option<&str>,
        model: &str,
        body: &Value,
        options: &ChatOptions,
    ) -> Result<Body, AccountAttemptError> {
        let mut last = None;
        'transports: for (transport, client) in self.sdk_transports(index, session)? {
            let response = match client
                .exec_chat_stream(model, build_request(body)?, Some(options))
                .await
            {
                Ok(response) => response,
                Err(error) => {
                    let attempt = AccountAttemptError::from_sdk(error, self.descriptor.provider_id);
                    if self.transport_failed(transport, &attempt.error) {
                        last = Some(attempt.error);
                        continue;
                    }
                    return Err(attempt);
                }
            };
            let mut upstream = Box::pin(response.stream);
            let mut initial = Vec::new();
            loop {
                match upstream.next().await {
                    Some(Ok(event)) => {
                        let ready = !matches!(event, ChatStreamEvent::Start);
                        initial.push(Ok(event));
                        if ready {
                            break;
                        }
                    }
                    Some(Err(error)) => {
                        let attempt =
                            AccountAttemptError::from_sdk(error, self.descriptor.provider_id);
                        if self.transport_failed(transport, &attempt.error) {
                            last = Some(attempt.error);
                            continue 'transports;
                        }
                        return Err(attempt);
                    }
                    None => {
                        return Err(ProviderError::DeliveryUncertain(
                            "GenAI stream ended before a response".to_owned(),
                        )
                        .into())
                    }
                }
            }
            self.transport_succeeded(transport, session);
            return Ok(Body::from_stream(translate_genai_stream(
                stream::iter(initial).chain(upstream),
                body["model"].as_str().unwrap_or(model).to_owned(),
            )));
        }
        Err(last
            .unwrap_or_else(|| {
                ProviderError::Transport(
                    "GenAI egress endpoints rejected their connections".to_owned(),
                )
            })
            .into())
    }
}

/// Resolve explicit namespaces before model families; never infer local Ollama.
pub fn sdk_descriptor_for_model(model: &str) -> Option<&'static SdkProviderDescriptor> {
    use ::genai::adapter::AdapterKind;
    if let Some((namespace, name)) = model.split_once("::") {
        if name.is_empty() || name.contains("::") {
            return None;
        }
        let kind = match namespace {
            "zai_coding" => "zai",
            "baidu-coding-openai" | "baidu-coding-anthropic" => "baidu",
            other => other,
        };
        return sdk_provider_by_kind(kind);
    }
    let kind = AdapterKind::from_model(model).ok()?;
    if kind == AdapterKind::Ollama || model.is_empty() {
        return None;
    }
    sdk_provider_by_kind(kind.as_lower_str())
}

struct BoundModel<'a>(&'a str);
impl<'a> BoundModel<'a> {
    fn new(descriptor: &SdkProviderDescriptor, model: &'a str) -> Result<Self, ProviderError> {
        if sdk_descriptor_for_model(model).is_some_and(|resolved| resolved.kind == descriptor.kind)
        {
            Ok(Self(model))
        } else {
            Err(ProviderError::Provider(format!(
                "{} model namespace mismatch",
                descriptor.provider_id
            )))
        }
    }
}

fn context_endpoint(context: &SdkEndpointConfig) -> Result<Option<String>, ProviderError> {
    fn segment(value: &str) -> bool {
        !value.is_empty()
            && value
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    }
    let invalid = || ProviderError::Provider("invalid SDK endpoint context".to_owned());
    Ok(match context {
        SdkEndpointConfig::Default => None,
        SdkEndpointConfig::Vertex { project, location } => {
            if !segment(project) || !segment(location) {
                return Err(invalid());
            }
            let host = if location == "global" {
                "aiplatform.googleapis.com".to_owned()
            } else {
                format!("{location}-aiplatform.googleapis.com")
            };
            Some(format!(
                "https://{host}/v1/projects/{project}/locations/{location}/"
            ))
        }
        SdkEndpointConfig::BedrockApi { region } => {
            if !segment(region) {
                return Err(invalid());
            }
            Some(format!("https://bedrock-runtime.{region}.amazonaws.com/"))
        }
        SdkEndpointConfig::Ollama { base_url } => {
            let url = reqwest::Url::parse(base_url).map_err(|_| invalid())?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(invalid());
            }
            Some(format!("{}/", base_url.trim_end_matches('/')))
        }
    })
}

fn build_genai_client(
    descriptor: &'static SdkProviderDescriptor,
    auth: AuthData,
    endpoint: Option<String>,
    http: reqwest_sdk::Client,
) -> Client {
    let explicit_auth = auth.clone();
    let resolver = AuthResolver::from_resolver_fn(move |model: ModelIden| {
        if model.adapter_kind.as_lower_str() != descriptor.kind {
            return Err(::genai::resolver::Error::Custom(
                "SDK auth kind mismatch".to_owned(),
            ));
        }
        Ok(Some(explicit_auth.clone()))
    });
    Client::builder()
        .with_reqwest(http)
        .with_auth_resolver(resolver)
        .with_service_target_resolver(::genai::resolver::ServiceTargetResolver::from_resolver_fn(
            move |mut target: ::genai::ServiceTarget| {
                if target.model.adapter_kind.as_lower_str() != descriptor.kind {
                    return Err(::genai::resolver::Error::Custom(
                        "SDK target kind mismatch".to_owned(),
                    ));
                }
                target.auth = auth.clone();
                if let Some(endpoint) = &endpoint {
                    target.endpoint = ::genai::resolver::Endpoint::from_owned(endpoint.clone());
                }
                Ok(target)
            },
        ))
        .build()
}

/// The upstream HTTP status (and headers, when the SDK kept them) of a failed
/// SDK call, or `None` for a failure that never received a status.
fn genai_error_status(
    error: &::genai::Error,
) -> Option<(reqwest::StatusCode, Option<&reqwest::header::HeaderMap>)> {
    match error {
        ::genai::Error::WebModelCall {
            webc_error:
                ::genai::webc::Error::ResponseFailedStatus {
                    status, headers, ..
                },
            ..
        }
        | ::genai::Error::WebAdapterCall {
            webc_error:
                ::genai::webc::Error::ResponseFailedStatus {
                    status, headers, ..
                },
            ..
        } => Some((*status, Some(headers.as_ref()))),
        ::genai::Error::HttpError { status, .. } => Some((*status, None)),
        ::genai::Error::WebStream { error: cause, .. } => cause
            .downcast_ref::<::genai::Error>()
            .and_then(|nested| match nested {
                ::genai::Error::HttpError { status, .. } => Some((*status, None)),
                _ => None,
            }),
        _ => None,
    }
}

/// The upstream error body of an SDK error that carries one, read alongside
/// [`genai_error_status`].
fn genai_error_body(error: &::genai::Error) -> Option<&str> {
    match error {
        ::genai::Error::WebModelCall {
            webc_error: ::genai::webc::Error::ResponseFailedStatus { body, .. },
            ..
        }
        | ::genai::Error::WebAdapterCall {
            webc_error: ::genai::webc::Error::ResponseFailedStatus { body, .. },
            ..
        }
        | ::genai::Error::HttpError { body, .. } => Some(body.as_str()),
        ::genai::Error::WebStream { error: cause, .. } => cause
            .downcast_ref::<::genai::Error>()
            .and_then(|nested| match nested {
                ::genai::Error::HttpError { body, .. } => Some(body.as_str()),
                _ => None,
            }),
        _ => None,
    }
}

fn map_genai_error(error: ::genai::Error, provider: &str) -> ProviderError {
    if let Some((status, headers)) = genai_error_status(&error) {
        if status == reqwest::StatusCode::PROXY_AUTHENTICATION_REQUIRED {
            return ProviderError::Transport("GenAI proxy authentication was rejected".to_owned());
        }
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let rate_limit = headers.and_then(parse_rate_limit);
            return ProviderError::RateLimited {
                provider: provider.to_owned(),
                retry_after: rate_limit.as_ref().and_then(|info| info.retry_after),
                reset_at: rate_limit.as_ref().and_then(|info| info.reset_at),
            };
        }
        if status == reqwest::StatusCode::PAYMENT_REQUIRED {
            return ProviderError::PaymentRequired {
                provider: provider.to_owned(),
                message: "upstream account payment required".to_owned(),
            };
        }
        // A 4xx other than 408 rejects this request, not the upstream: typed so
        // the gateway does not count it toward the circuit every tenant shares.
        return upstream_status_error(status, format!("{provider} upstream returned {status}"));
    }
    match &error {
        ::genai::Error::WebModelCall {
            webc_error: ::genai::webc::Error::Reqwest(cause),
            ..
        }
        | ::genai::Error::WebAdapterCall {
            webc_error: ::genai::webc::Error::Reqwest(cause),
            ..
        } => {
            if cause.is_connect() {
                ProviderError::Transport("GenAI connection establishment failed".to_owned())
            } else if cause.is_timeout() || cause.is_request() {
                ProviderError::DeliveryUncertain("GenAI request delivery is uncertain".to_owned())
            } else {
                ProviderError::Provider("GenAI HTTP request failed".to_owned())
            }
        }
        ::genai::Error::WebStream { error: cause, .. }
            if cause.downcast_ref::<reqwest_sdk::Error>().is_some() =>
        {
            let cause = cause
                .downcast_ref::<reqwest_sdk::Error>()
                .expect("checked SDK HTTP error");
            if cause.is_connect() {
                ProviderError::Transport("GenAI stream connection establishment failed".to_owned())
            } else {
                ProviderError::DeliveryUncertain("GenAI stream delivery is uncertain".to_owned())
            }
        }
        ::genai::Error::WebStream { .. } => ProviderError::DeliveryUncertain(
            "GenAI stream failed before a usable response".to_owned(),
        ),
        _ => ProviderError::Provider(format!("{provider} request failed")),
    }
}

impl Provider for GenAiProvider {
    fn configure_account_strategy(&self, strategy: crate::AccountSelectionStrategy) {
        self.accounts.configure_strategy(strategy);
    }

    fn configure_fill_first_drain_percent(&self, percent: u8) {
        self.accounts.configure_fill_first_drain_percent(percent);
    }

    fn configure_account_policies(&self, policies: &[crate::ProviderAccountPolicy]) {
        self.accounts.configure(policies);
    }

    fn name(&self) -> &'static str {
        self.descriptor.provider_id
    }

    fn has_rotating_accounts(&self) -> bool {
        self.accounts.has_restrictions()
            || self.keys.len() > 1
            || self.egress.as_ref().is_some_and(|pool| pool.len() > 1)
    }

    fn complete<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        self.complete_for_session(model, body, None)
    }

    fn complete_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        session: Option<&'a str>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let model = BoundModel::new(self.descriptor, model)?.0;
            let opts = build_options(body, false);
            build_request(body)?;
            debug!(provider = "genai", model, "sending non-streaming request");
            let mut last_limit = None;
            let mut last_payment = None;
            let mut last_auth = None;
            for index in self.account_candidates(model, session) {
                match self
                    .chat_on_account(index, session, model, body, &opts)
                    .await
                {
                    Ok(response) => {
                        {
                            self.accounts.record_success(session, index);
                        }
                        let requested_model = body["model"].as_str().unwrap_or(model);
                        return Ok(to_openai_response(response, requested_model));
                    }
                    Err(AccountAttemptError {
                        error,
                        auth_rejected,
                    }) => match error {
                        ProviderError::RateLimited {
                            retry_after,
                            reset_at,
                            ..
                        } => {
                            {
                                self.accounts.record_rate_limit(index, retry_after);
                            }
                            last_limit = Some(ProviderError::RateLimited {
                                provider: self.descriptor.provider_id.to_owned(),
                                retry_after,
                                reset_at,
                            });
                        }
                        ProviderError::PaymentRequired { provider, message } => {
                            self.accounts.record_rate_limit(index, Some(300));
                            last_payment =
                                Some(ProviderError::PaymentRequired { provider, message });
                        }
                        other if auth_rejected => {
                            self.accounts.record_auth_failure(index);
                            last_auth = Some(other);
                        }
                        other => return Err(other),
                    },
                }
            }
            Err(last_payment
                .or(last_limit)
                .or(last_auth)
                .unwrap_or_else(|| ProviderError::RateLimited {
                    provider: self.descriptor.provider_id.to_owned(),
                    retry_after: None,
                    reset_at: None,
                }))
        })
    }

    fn complete_stream<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>> {
        self.complete_stream_for_session(model, body, None)
    }

    fn complete_stream_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        session: Option<&'a str>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let model = BoundModel::new(self.descriptor, model)?.0;
            build_request(body)?;
            let options = build_options(body, true);
            let mut last = None;
            for index in self.account_candidates(model, session) {
                match self
                    .stream_on_account(index, session, model, body, &options)
                    .await
                {
                    Ok(response) => {
                        {
                            self.accounts.record_success(session, index);
                        }
                        return Ok(response);
                    }
                    Err(AccountAttemptError {
                        error: error @ ProviderError::RateLimited { .. },
                        ..
                    }) => {
                        if let ProviderError::RateLimited { retry_after, .. } = &error {
                            {
                                self.accounts.record_rate_limit(index, *retry_after);
                            }
                        }
                        last = Some(error);
                    }
                    Err(AccountAttemptError {
                        error: error @ ProviderError::PaymentRequired { .. },
                        ..
                    }) => {
                        self.accounts.record_rate_limit(index, Some(300));
                        last = Some(error);
                    }
                    Err(AccountAttemptError {
                        error,
                        auth_rejected: true,
                    }) => {
                        self.accounts.record_auth_failure(index);
                        last = Some(error);
                    }
                    Err(AccountAttemptError { error, .. }) => return Err(error),
                }
            }
            Err(last.unwrap_or_else(|| ProviderError::RateLimited {
                provider: self.descriptor.provider_id.to_owned(),
                retry_after: None,
                reset_at: None,
            }))
        })
    }

    fn generate_image<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            BoundModel::new(self.descriptor, model)?;
            if self.descriptor.kind != "gemini" || self.keys.is_empty() {
                return Err(ProviderError::Provider(
                    "Gemini image generation needs a Gemini API key".to_owned(),
                ));
            }
            let native_model = model.strip_prefix("gemini::").unwrap_or(model);
            if !native_model.starts_with("gemini-")
                || !native_model
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_'))
            {
                return Err(ProviderError::Provider(
                    "Gemini image generation needs a Gemini image model".to_owned(),
                ));
            }
            let prompt = body["prompt"]
                .as_str()
                .map(str::trim)
                .filter(|prompt| !prompt.is_empty())
                .ok_or_else(|| ProviderError::Provider("image prompt is required".to_owned()))?;
            let generation_config = image_generation_config(native_model, body)?;
            let payload = json!({
                "contents": [{ "parts": [{ "text": prompt }] }],
                "generationConfig": generation_config,
            });
            let url = format!(
                "{}/models/{native_model}:generateContent",
                self.image_base_url.trim_end_matches('/')
            );
            let mut last_limit = None;
            let mut last_payment = None;
            for index in self.accounts.candidates(None) {
                let key = &self.keys[index];
                let response = send_with_egress(
                    &self.image_client,
                    self.egress.as_deref(),
                    None,
                    self.descriptor.provider_id,
                    0,
                    |client| {
                        client
                            .post(&url)
                            .header("x-goog-api-key", key)
                            .json(&payload)
                    },
                )
                .await?;
                match check_service_response(
                    response,
                    self.descriptor.provider_id,
                    Some(&self.quota),
                )
                .await
                {
                    Ok(result) => {
                        return normalize_gemini_images(&result).map_err(|_| {
                            ProviderError::DeliveryUncertain(
                                "Gemini accepted image response has no usable image".to_owned(),
                            )
                        })
                    }
                    Err(ProviderError::RateLimited {
                        retry_after,
                        reset_at,
                        ..
                    }) => {
                        self.accounts.record_rate_limit(index, retry_after);
                        last_limit = Some(ProviderError::RateLimited {
                            provider: self.descriptor.provider_id.to_owned(),
                            retry_after,
                            reset_at,
                        });
                    }
                    Err(ProviderError::PaymentRequired { provider, message }) => {
                        self.accounts.record_rate_limit(index, Some(300));
                        last_payment = Some(ProviderError::PaymentRequired { provider, message });
                    }
                    Err(other) => return Err(other),
                }
            }
            Err(last_payment
                .or(last_limit)
                .unwrap_or_else(|| ProviderError::RateLimited {
                    provider: self.descriptor.provider_id.to_owned(),
                    retry_after: None,
                    reset_at: None,
                }))
        })
    }
}

fn image_generation_config(model: &str, body: &Value) -> Result<Value, ProviderError> {
    if body.get("n").is_some_and(|count| count.as_u64() != Some(1)) {
        return Err(ProviderError::Provider(
            "Gemini image generation supports one image per request".to_owned(),
        ));
    }
    if body
        .get("response_format")
        .is_some_and(|format| !format.is_null() && format.as_str() != Some("b64_json"))
    {
        return Err(ProviderError::Provider(
            "Gemini image generation returns b64_json rather than hosted URLs".to_owned(),
        ));
    }
    let size = match body.get("size") {
        None | Some(Value::Null) => None,
        Some(Value::String(size)) => Some(size.as_str()),
        Some(_) => {
            return Err(ProviderError::Provider(
                "Gemini image size must be text".to_owned(),
            ))
        }
    };
    let size_aspect = match size {
        None | Some("auto") => None,
        Some("1024x1024") => Some("1:1"),
        Some("1536x1024") => Some("3:2"),
        Some("1024x1536") => Some("2:3"),
        Some(_) => {
            return Err(ProviderError::Provider(
                "Gemini image size must be auto, 1024x1024, 1536x1024, or 1024x1536".to_owned(),
            ))
        }
    };
    let explicit_aspect = match body.get("aspect_ratio") {
        None | Some(Value::Null) => None,
        Some(Value::String(aspect)) => Some(aspect.as_str()),
        Some(_) => {
            return Err(ProviderError::Provider(
                "Gemini image aspect_ratio must be text".to_owned(),
            ))
        }
    };
    let aspect = explicit_aspect.or(size_aspect);
    let mut config = json!({ "responseModalities": ["IMAGE"] });
    if let Some(aspect) = aspect {
        if !matches!(
            aspect,
            "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "16:9"
        ) {
            return Err(ProviderError::Provider(
                "Gemini image aspect_ratio is not supported".to_owned(),
            ));
        }
        if model.starts_with("gemini-3") {
            config["responseFormat"] = json!({ "image": { "aspectRatio": aspect } });
        } else {
            config["imageConfig"] = json!({ "aspectRatio": aspect });
        }
    }
    Ok(config)
}

fn normalize_gemini_images(response: &Value) -> Result<Value, ProviderError> {
    let mut images = Vec::new();
    if let Some(candidates) = response["candidates"].as_array() {
        for candidate in candidates {
            if let Some(parts) = candidate["content"]["parts"].as_array() {
                for part in parts {
                    if part["thought"] == true {
                        continue;
                    }
                    let inline = part.get("inlineData").or_else(|| part.get("inline_data"));
                    let Some(inline) = inline else { continue };
                    let Some(encoded) = inline["data"].as_str() else {
                        continue;
                    };
                    let mime = inline["mimeType"]
                        .as_str()
                        .or_else(|| inline["mime_type"].as_str())
                        .filter(|mime| mime.starts_with("image/"))
                        .ok_or_else(|| {
                            ProviderError::Provider(
                                "Gemini returned image data without an image MIME type".to_owned(),
                            )
                        })?;
                    if encoded.is_empty()
                        || encoded.len() > 44_000_000
                        || base64::engine::general_purpose::STANDARD
                            .decode(encoded)
                            .is_err()
                    {
                        return Err(ProviderError::Provider(
                            "Gemini returned invalid or oversized image data".to_owned(),
                        ));
                    }
                    images.push(json!({ "b64_json": encoded, "content_type": mime }));
                }
            }
        }
    }
    if images.is_empty() {
        return Err(ProviderError::Provider(
            "Gemini returned no image data".to_owned(),
        ));
    }
    Ok(json!({
        "created": chrono::Utc::now().timestamp(),
        "data": images,
        "usageMetadata": response.get("usageMetadata"),
    }))
}

/// Convert an OpenAI-format `messages` array into `genai` chat messages.
///
/// `genai` accepts `system` as an ordinary message in the sequence, so system
/// prompts are mapped 1:1 rather than hoisted into a separate field (unlike the
/// Anthropic translator). When the request declares tools, assistant
/// `tool_calls` become `genai` tool calls and `tool` results become tool
/// responses, so a tool loop replays as one. Without tools (a client that
/// sends none, or a budget restriction that stripped them) providers such as
/// Anthropic refuse tool blocks, so the same history is replayed as readable
/// conversation text instead.
fn parse_messages(body: &Value) -> Result<Vec<ChatMessage>, ProviderError> {
    let mut out: Vec<ChatMessage> = Vec::new();
    let Some(arr) = body["messages"].as_array() else {
        return Ok(out);
    };
    let structured_tools = declares_tools(body);
    let mut image_bytes = 0;
    // Gemini answers a call by function name, which OpenAI tool results omit.
    let mut call_names: HashMap<String, String> = HashMap::new();
    // Whether the last turn pushed is a text rendering of tool results, so a
    // turn's parallel results share one user turn as they share one tool turn.
    let mut last_is_tool_text = false;

    for m in arr {
        let role = m["role"].as_str().unwrap_or("user");
        if let ("tool", Some(call_id), false) = (role, m["tool_call_id"].as_str(), structured_tools)
        {
            let name = call_names.get(call_id).map_or(call_id, String::as_str);
            let line = format!("[tool {name} result: {}]", tool_result_text(&m["content"])?);
            match out.last_mut() {
                Some(last) if last_is_tool_text => {
                    let text = format!(
                        "{}\n{line}",
                        last.content.joined_texts().unwrap_or_default()
                    );
                    last.content = MessageContent::from_text(text);
                }
                _ => out.push(ChatMessage::user(MessageContent::from_text(line))),
            }
            last_is_tool_text = true;
            continue;
        }
        last_is_tool_text = false;
        if let ("tool", Some(call_id)) = (role, m["tool_call_id"].as_str()) {
            let mut response = ToolResponse::new(call_id, tool_result_text(&m["content"])?);
            if let Some(name) = call_names.get(call_id) {
                response = response.with_fn_name(name.clone());
            }
            // Results for one turn's parallel calls belong in a single tool turn.
            match out.last_mut() {
                Some(last) if last.role == ChatRole::Tool => last.content.push(response),
                _ => out.push(ChatMessage::tool(MessageContent::from_tool_responses(
                    vec![response],
                ))),
            }
            continue;
        }
        let mut content = parse_content(&m["content"], role, &mut image_bytes)?;
        let msg = match role {
            "system" => ChatMessage::system(content),
            "assistant" => {
                let calls = parse_tool_calls(&m["tool_calls"])?;
                if !calls.is_empty() {
                    // Some clients send `content: ""` on a tool-only turn;
                    // Anthropic rejects the empty text block that would make.
                    content = MessageContent::from_parts(
                        content
                            .into_parts()
                            .into_iter()
                            .filter(|part| {
                                !matches!(part, ContentPart::Text(text) if text.trim().is_empty())
                            })
                            .collect::<Vec<_>>(),
                    );
                }
                for call in &calls {
                    call_names.insert(call.call_id.clone(), call.fn_name.clone());
                }
                if structured_tools {
                    for call in calls {
                        content.push(call);
                    }
                } else if !calls.is_empty() {
                    // Never empty: a tool-only turn still reads as what it did.
                    let mut lines: Vec<String> =
                        content.texts().into_iter().map(str::to_owned).collect();
                    lines.extend(calls.iter().map(|call| {
                        format!("[called tool {} with {}]", call.fn_name, call.fn_arguments)
                    }));
                    content = MessageContent::from_text(lines.join("\n"));
                }
                ChatMessage::assistant(content)
            }
            // A `tool` turn without `tool_call_id` and anything unexpected
            // fall back to a user turn.
            _ => ChatMessage::user(content),
        };
        out.push(msg);
    }

    Ok(out)
}

/// Whether the request declares any tools, which decides whether tool history
/// is replayed as structured tool calls or as plain text (see
/// [`parse_messages`]). Matches the non-empty array [`parse_tools`] attaches.
fn declares_tools(body: &Value) -> bool {
    body.get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| !tools.is_empty())
}

/// The full `genai` request: messages plus any OpenAI function tools.
fn build_request(body: &Value) -> Result<ChatRequest, ProviderError> {
    let request = ChatRequest::new(parse_messages(body)?);
    Ok(match parse_tools(body)? {
        Some(tools) => request.with_tools(tools),
        None => request,
    })
}

/// Map OpenAI `tools[].function` declarations onto `genai` tools. Non-function
/// tool types are refused rather than silently dropped.
fn parse_tools(body: &Value) -> Result<Option<Vec<Tool>>, ProviderError> {
    let invalid = |message: &str| ProviderError::Provider(format!("genai: {message}"));
    let tools = match body.get("tools") {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Array(tools)) if tools.is_empty() => return Ok(None),
        Some(Value::Array(tools)) => tools,
        Some(_) => return Err(invalid("tools must be an array")),
    };
    let mut out = Vec::with_capacity(tools.len());
    for tool in tools {
        if tool["type"].as_str().unwrap_or("function") != "function" {
            return Err(invalid("only function tools are supported"));
        }
        let function = &tool["function"];
        let name = function["name"]
            .as_str()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| invalid("function tool is missing its name"))?;
        let mut mapped = Tool::new(name);
        if let Some(description) = function["description"].as_str() {
            mapped = mapped.with_description(description);
        }
        if let Some(parameters) = function.get("parameters").filter(|p| !p.is_null()) {
            mapped = mapped.with_schema(parameters.clone());
        }
        if let Some(strict) = function["strict"].as_bool() {
            mapped = mapped.with_strict(strict);
        }
        out.push(mapped);
    }
    Ok(Some(out))
}

/// OpenAI assistant `tool_calls` as `genai` tool calls. Arguments arrive as a
/// JSON string and are carried as the parsed value every adapter expects.
fn parse_tool_calls(calls: &Value) -> Result<Vec<ToolCall>, ProviderError> {
    let invalid = |message: &str| ProviderError::Provider(format!("genai: {message}"));
    let calls = match calls {
        Value::Null => return Ok(Vec::new()),
        Value::Array(calls) => calls,
        _ => return Err(invalid("assistant tool_calls must be an array")),
    };
    calls
        .iter()
        .map(|call| {
            let call_id = call["id"]
                .as_str()
                .ok_or_else(|| invalid("assistant tool call is missing its id"))?;
            let fn_name = call["function"]["name"]
                .as_str()
                .ok_or_else(|| invalid("assistant tool call is missing its function name"))?;
            let fn_arguments = match &call["function"]["arguments"] {
                Value::Null => json!({}),
                Value::String(raw) if raw.trim().is_empty() => json!({}),
                Value::String(raw) => serde_json::from_str(raw)
                    .map_err(|_| invalid("assistant tool call arguments must be JSON"))?,
                other => other.clone(),
            };
            Ok(ToolCall {
                call_id: call_id.to_owned(),
                fn_name: fn_name.to_owned(),
                fn_arguments,
                thought_signatures: None,
            })
        })
        .collect()
}

/// A `tool` message's result text: a string, or the text parts of an array.
fn tool_result_text(content: &Value) -> Result<String, ProviderError> {
    match content {
        Value::Null => Ok(String::new()),
        Value::String(text) => Ok(text.clone()),
        Value::Array(parts) => Ok(parts
            .iter()
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("")),
        _ => Err(ProviderError::Provider(
            "genai: tool message content must be text or an array of parts".to_owned(),
        )),
    }
}

/// Preserve image input without making local requests to caller-supplied URLs.
/// GenAI's Gemini adapter only carries binary input on user turns.
fn parse_content(
    content: &Value,
    role: &str,
    image_bytes: &mut usize,
) -> Result<MessageContent, ProviderError> {
    let invalid = |message: &str| ProviderError::Provider(format!("genai: {message}"));
    let parts = match content {
        Value::String(text) => return Ok(MessageContent::from_text(text)),
        Value::Null => return Ok(MessageContent::default()),
        Value::Array(parts) => parts,
        _ => return Err(invalid("message content must be text or an array of parts")),
    };
    let mut parsed = Vec::with_capacity(parts.len());
    for part in parts {
        match part["type"].as_str() {
            Some("text") => {
                let text = part["text"]
                    .as_str()
                    .ok_or_else(|| invalid("text part is missing text"))?;
                parsed.push(ContentPart::from_text(text));
            }
            Some("image_url") => {
                if role != "user" {
                    return Err(invalid("image input requires a user message"));
                }
                let url = part["image_url"]["url"]
                    .as_str()
                    .ok_or_else(|| invalid("image_url part is missing its URL"))?;
                let (header, encoded) = url
                    .strip_prefix("data:")
                    .and_then(|data| data.split_once(","))
                    .ok_or_else(|| invalid("image input requires a base64 data URI"))?;
                let mime = header
                    .strip_suffix(";base64")
                    .filter(|mime| {
                        matches!(
                            *mime,
                            "image/png" | "image/jpeg" | "image/webp" | "image/heic" | "image/heif"
                        )
                    })
                    .ok_or_else(|| invalid("unsupported image MIME type or encoding"))?;
                // Bound allocations before decoding and cap the aggregate across turns.
                const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
                if encoded.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
                    return Err(invalid("image input exceeds the 10 MiB request limit"));
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| invalid("image input contains invalid base64"))?;
                if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES.saturating_sub(*image_bytes) {
                    return Err(invalid(
                        "image input is empty or exceeds the 10 MiB request limit",
                    ));
                }
                *image_bytes += bytes.len();
                parsed.push(ContentPart::from_binary_base64(mime, encoded, None));
            }
            _ => return Err(invalid("unsupported message content part")),
        }
    }
    Ok(MessageContent::from_parts(parsed))
}

/// Map OpenAI sampling parameters onto `genai` `ChatOptions`. When `capture_usage`
/// is set (streaming), token usage is captured so it can be surfaced at stream end,
/// and tool calls are captured so each `ToolCallChunk` carries its accumulated
/// arguments (the OpenAI adapter otherwise yields bare per-chunk fragments).
fn build_options(body: &Value, capture_usage: bool) -> ChatOptions {
    let mut opts = ChatOptions::default();

    if let Some(t) = body.get("temperature").and_then(Value::as_f64) {
        opts = opts.with_temperature(t);
    }
    if let Some(m) = body
        .get("max_completion_tokens")
        .or_else(|| body.get("max_tokens"))
        .and_then(Value::as_u64)
    {
        opts = opts.with_max_tokens(m as u32);
    }
    if let Some(p) = body.get("top_p").and_then(Value::as_f64) {
        opts = opts.with_top_p(p);
    }
    // Sent by the adapters whose API takes it (Gemini, Cohere, Anthropic,
    // Vertex); the others ignore the option.
    if let Some(k) = body
        .get("top_k")
        .and_then(Value::as_u64)
        .and_then(|k| u32::try_from(k).ok())
    {
        opts = opts.with_top_k(k);
    }
    match body.get("stop") {
        Some(Value::String(s)) => {
            opts = opts.with_stop_sequence(s.clone());
        }
        Some(Value::Array(arr)) => {
            let seqs: Vec<String> = arr
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect();
            if !seqs.is_empty() {
                opts = opts.with_stop_sequences(seqs);
            }
        }
        _ => {}
    }
    // Only alongside tools: a tool_choice without tools is an upstream error.
    let has_tools = body["tools"]
        .as_array()
        .is_some_and(|tools| !tools.is_empty());
    if let Some(choice) = body
        .get("tool_choice")
        .filter(|_| has_tools)
        .and_then(openai_tool_choice)
    {
        opts = opts.with_tool_choice(choice);
    }
    if capture_usage {
        opts = opts.with_capture_usage(true).with_capture_tool_calls(true);
    }
    // W3C trace context from the gateway's model-call span (empty, and so not
    // set, outside a consented trace scope).
    let trace_headers = crate::trace_context::current_headers();
    if !trace_headers.is_empty() {
        opts = opts.with_extra_headers(trace_headers);
    }

    opts
}

/// OpenAI `tool_choice` (`auto`/`none`/`required` or a named function).
fn openai_tool_choice(choice: &Value) -> Option<ToolChoice> {
    match choice {
        Value::String(mode) => match mode.as_str() {
            "auto" => Some(ToolChoice::Auto),
            "none" => Some(ToolChoice::None),
            "required" => Some(ToolChoice::Required),
            _ => None,
        },
        Value::Object(_) => choice["function"]["name"].as_str().map(ToolChoice::tool),
        _ => None,
    }
}

/// OpenAI carries tool arguments as a JSON string; streamed partial
/// arguments are already one.
fn tool_call_arguments(arguments: &Value) -> String {
    match arguments {
        Value::String(raw) => raw.clone(),
        other => other.to_string(),
    }
}

/// OpenAI `finish_reason`. Gemini reports `STOP` for a function-calling turn,
/// so any emitted tool call decides `tool_calls` on its own. Truncation still
/// wins, as on OpenAI: a call cut off by `max_tokens` has partial arguments.
fn openai_finish_reason(stop: Option<&StopReason>, called_tools: bool) -> &'static str {
    match stop {
        Some(StopReason::MaxTokens(_)) => "length",
        Some(StopReason::ContentFilter(_)) => "content_filter",
        _ if called_tools => "tool_calls",
        _ => "stop",
    }
}

/// Convert a `genai` `ChatResponse` into an OpenAI chat-completion response.
fn to_openai_response(res: ChatResponse, requested_model: &str) -> Value {
    let tool_calls: Vec<Value> = res
        .tool_calls()
        .into_iter()
        .map(|call| {
            json!({
                "id": call.call_id,
                "type": "function",
                "function": {
                    "name": call.fn_name,
                    "arguments": tool_call_arguments(&call.fn_arguments),
                },
            })
        })
        .collect();
    let finish_reason = openai_finish_reason(res.stop_reason.as_ref(), !tool_calls.is_empty());
    let mut message = json!({
        "role": "assistant",
        "content": res.first_text(),
    });
    if tool_calls.is_empty() {
        // A text-only answer keeps a string `content`, even when empty; a
        // tool-calling one has `null` content when the model wrote no text.
        if message["content"].is_null() {
            message["content"] = json!("");
        }
    } else {
        message["tool_calls"] = Value::Array(tool_calls);
    }

    json!({
        "id": format!("chatcmpl-{}", uuid::Uuid::new_v4().simple()),
        "object": "chat.completion",
        "created": chrono::Utc::now().timestamp(),
        "model": requested_model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": finish_reason,
            "logprobs": null,
        }],
        "usage": openai_usage(&res.usage),
    })
}

/// OpenAI-shaped `usage` from `genai`'s normalized counts, keeping the cache
/// and reasoning details Core's stats part reads
/// (`prompt_tokens_details.{cached_tokens,cache_write_tokens}`,
/// `completion_tokens_details.reasoning_tokens`). `genai` reports
/// `prompt_tokens` as total input, cache reads and writes included.
fn openai_usage(usage: &::genai::chat::Usage) -> Value {
    let prompt = usage.prompt_tokens.unwrap_or(0);
    let completion = usage.completion_tokens.unwrap_or(0);
    let mut out = json!({
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": usage.total_tokens.unwrap_or(prompt + completion),
    });
    if let Some(details) = usage.prompt_tokens_details.as_ref() {
        let mut prompt_details = serde_json::Map::new();
        if let Some(read) = details.cached_tokens {
            prompt_details.insert("cached_tokens".into(), json!(read));
        }
        if let Some(write) = details.cache_creation_tokens {
            prompt_details.insert("cache_write_tokens".into(), json!(write));
        }
        if !prompt_details.is_empty() {
            out["prompt_tokens_details"] = Value::Object(prompt_details);
        }
    }
    if let Some(reasoning) = usage
        .completion_tokens_details
        .as_ref()
        .and_then(|details| details.reasoning_tokens)
    {
        out["completion_tokens_details"] = json!({ "reasoning_tokens": reasoning });
    }
    out
}

/// Per-stream tool-call bookkeeping for [`translate_genai_stream`].
///
/// With tool-call capture on, each `ToolCallChunk` carries a call's arguments
/// accumulated so far (Anthropic, OpenAI, Bedrock) or the whole call at once
/// (Gemini, Ollama). OpenAI clients concatenate per-index deltas, so only the
/// newly arrived suffix is sent after a call's first frame.
#[derive(Default)]
struct StreamToolCalls {
    /// Call id -> (OpenAI `index`, arguments already sent).
    calls: HashMap<String, (usize, String)>,
}

impl StreamToolCalls {
    fn delta(&mut self, call: &ToolCall) -> Option<Value> {
        let arguments = tool_call_arguments(&call.fn_arguments);
        if let Some((index, sent)) = self.calls.get_mut(&call.call_id) {
            // A snapshot that does not extend what was sent cannot be retracted.
            let rest = arguments.strip_prefix(sent.as_str())?;
            if rest.is_empty() {
                return None;
            }
            let delta = json!({ "index": *index, "function": { "arguments": rest } });
            *sent = arguments;
            return Some(delta);
        }
        let index = self.calls.len();
        let delta = json!({
            "index": index,
            "id": call.call_id,
            "type": "function",
            "function": { "name": call.fn_name, "arguments": arguments },
        });
        self.calls.insert(call.call_id.clone(), (index, arguments));
        Some(delta)
    }
}

/// One `delta.tool_calls` SSE frame.
fn tool_call_frame(
    id: &str,
    created: i64,
    model: &str,
    delta: Value,
) -> Option<Result<Bytes, std::io::Error>> {
    let chunk = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{
            "index": 0,
            "delta": { "tool_calls": [delta] },
            "finish_reason": null,
        }]
    });
    serde_json::to_string(&chunk)
        .ok()
        .map(|s| Ok(Bytes::from(format!("data: {s}\n\n"))))
}

/// Translate a `genai` event stream into OpenAI-compatible SSE chunks.
///
/// `genai` yields typed `ChatStreamEvent`s; we emit `chat.completion.chunk`
/// frames terminated by `data: [DONE]`, matching what the OpenAI streaming API
/// (and therefore every client of this gateway) expects.
fn translate_genai_stream<S>(
    stream: S,
    model: String,
) -> impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static
where
    S: futures_util::Stream<Item = ::genai::Result<ChatStreamEvent>> + Send + 'static,
{
    let id = format!("chatcmpl-{}", uuid::Uuid::new_v4().simple());
    let created = chrono::Utc::now().timestamp();
    let mut tool_calls = StreamToolCalls::default();

    stream.flat_map(move |event| {
        let id = id.clone();
        let model = model.clone();
        let mut output: Vec<Result<Bytes, std::io::Error>> = Vec::new();

        match event {
            Ok(ChatStreamEvent::Chunk(StreamChunk { content })) => {
                let chunk = json!({
                    "id": id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{
                        "index": 0,
                        "delta": {"content": content},
                        "finish_reason": null,
                    }]
                });
                if let Ok(s) = serde_json::to_string(&chunk) {
                    output.push(Ok(Bytes::from(format!("data: {s}\n\n"))));
                }
            }
            Ok(ChatStreamEvent::End(end)) => {
                // Adapters that return several calls in one frame (Ollama, an
                // OpenAI-compatible final chunk) only emit the first as a chunk;
                // the rest exist only in the captured content.
                for call in end.captured_tool_calls().unwrap_or_default() {
                    if !tool_calls.calls.contains_key(&call.call_id) {
                        if let Some(delta) = tool_calls.delta(call) {
                            output.extend(tool_call_frame(&id, created, &model, delta));
                        }
                    }
                }
                // OpenAI's `include_usage` shape: a `choices: []` chunk carrying
                // the turn's usage just before the stop frame. Without it every
                // GenAI-routed provider (Gemini, Bedrock, Ollama, …) reported no
                // token counts, cache hits, or reasoning to the chat stats.
                if let Some(usage) = end.captured_usage.as_ref() {
                    let usage_chunk = json!({
                        "id": id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model,
                        "choices": [],
                        "usage": openai_usage(usage),
                    });
                    if let Ok(s) = serde_json::to_string(&usage_chunk) {
                        output.push(Ok(Bytes::from(format!("data: {s}\n\n"))));
                    }
                }
                let stop = json!({
                    "id": id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{
                        "index": 0,
                        "delta": {},
                        "finish_reason": openai_finish_reason(
                            end.captured_stop_reason.as_ref(),
                            !tool_calls.calls.is_empty(),
                        ),
                    }]
                });
                if let Ok(s) = serde_json::to_string(&stop) {
                    output.push(Ok(Bytes::from(format!("data: {s}\n\ndata: [DONE]\n\n"))));
                }
            }
            // Reasoning rides the `reasoning_content` delta the other adapters
            // (Kiro, Qoder) already use. Dropping it made a thinking model's whole
            // reasoning phase look like time-to-first-token, and its reasoning
            // tokens look like they were generated in the answer-only window.
            Ok(ChatStreamEvent::ReasoningChunk(StreamChunk { content })) => {
                let chunk = json!({
                    "id": id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{
                        "index": 0,
                        "delta": {"reasoning_content": content},
                        "finish_reason": null,
                    }]
                });
                if let Ok(s) = serde_json::to_string(&chunk) {
                    output.push(Ok(Bytes::from(format!("data: {s}\n\n"))));
                }
            }
            Ok(ChatStreamEvent::ToolCallChunk(chunk)) => {
                if let Some(delta) = tool_calls.delta(&chunk.tool_call) {
                    output.extend(tool_call_frame(&id, created, &model, delta));
                }
            }
            // Start / ThoughtSignatureChunk: not represented in the OpenAI
            // chat-completion stream, so skipped.
            Ok(_) => {}
            Err(e) => {
                output.push(Err(std::io::Error::new(std::io::ErrorKind::Other, e)));
            }
        }

        stream::iter(output)
    })
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn reasoning_chunks_stream_as_reasoning_content() {
        use ::genai::chat::StreamChunk;
        use futures_util::StreamExt;

        let events = futures_util::stream::iter(vec![
            Ok(super::ChatStreamEvent::ReasoningChunk(StreamChunk {
                content: "thinking".into(),
            })),
            Ok(super::ChatStreamEvent::Chunk(StreamChunk {
                content: "answer".into(),
            })),
        ]);
        let frames: Vec<serde_json::Value> =
            super::translate_genai_stream(events, "gemini-2.5-pro".into())
                .map(|frame| {
                    let text = String::from_utf8(frame.unwrap().to_vec()).unwrap();
                    serde_json::from_str(text.trim().trim_start_matches("data: ")).unwrap()
                })
                .collect()
                .await;
        assert_eq!(
            frames[0]["choices"][0]["delta"]["reasoning_content"],
            "thinking"
        );
        assert!(frames[0]["choices"][0]["delta"].get("content").is_none());
        assert_eq!(frames[1]["choices"][0]["delta"]["content"], "answer");
    }

    #[tokio::test]
    async fn stream_end_emits_usage_with_cache_and_reasoning_details() {
        use ::genai::chat::{CompletionTokensDetails, PromptTokensDetails, StreamEnd, Usage};
        use futures_util::StreamExt;

        let usage = Usage {
            prompt_tokens: Some(1200),
            prompt_tokens_details: Some(PromptTokensDetails {
                cached_tokens: Some(900),
                cache_creation_tokens: Some(100),
                ..Default::default()
            }),
            completion_tokens: Some(80),
            completion_tokens_details: Some(CompletionTokensDetails {
                reasoning_tokens: Some(30),
                ..Default::default()
            }),
            total_tokens: None,
        };
        let events = futures_util::stream::iter(vec![Ok(super::ChatStreamEvent::End(StreamEnd {
            captured_usage: Some(usage),
            ..Default::default()
        }))]);
        let frames: Vec<String> = super::translate_genai_stream(events, "gemini-2.5-pro".into())
            .map(|frame| String::from_utf8(frame.unwrap().to_vec()).unwrap())
            .collect()
            .await;
        let body = frames.concat();
        let usage_line = body
            .lines()
            .find(|line| line.contains("\"usage\""))
            .expect("usage chunk before the stop frame");
        let chunk: serde_json::Value =
            serde_json::from_str(usage_line.trim_start_matches("data: ")).unwrap();
        assert_eq!(chunk["choices"], serde_json::json!([]));
        assert_eq!(chunk["usage"]["prompt_tokens"], 1200);
        assert_eq!(chunk["usage"]["total_tokens"], 1280);
        assert_eq!(
            chunk["usage"]["prompt_tokens_details"]["cached_tokens"],
            900
        );
        assert_eq!(
            chunk["usage"]["prompt_tokens_details"]["cache_write_tokens"],
            100
        );
        assert_eq!(
            chunk["usage"]["completion_tokens_details"]["reasoning_tokens"],
            30
        );
        assert!(body.ends_with("data: [DONE]\n\n"));
    }

    #[test]
    fn sdk_namespaces_use_actual_coding_aliases_and_reject_unknown_owners() {
        for model in [
            "baidu-coding-openai::model",
            "baidu-coding-anthropic::model",
        ] {
            assert_eq!(
                super::sdk_descriptor_for_model(model).unwrap().kind,
                "baidu"
            );
        }
        assert_eq!(
            super::sdk_descriptor_for_model("zai_coding::model")
                .unwrap()
                .kind,
            "zai"
        );
        for model in [
            "baidu_coding::model",
            "unknown::model",
            "groq::",
            "groq::other::model",
        ] {
            assert!(super::sdk_descriptor_for_model(model).is_none());
        }
        assert!(super::BoundModel::new(
            ryu_gw_credentials::sdk_provider_by_kind("groq").unwrap(),
            "xai::grok-3"
        )
        .is_err());
    }
    #[test]
    fn shared_sdk_inventory_matches_the_enabled_dependency() {
        use ::genai::adapter::AdapterKind;
        use ryu_gw_credentials::{sdk_provider_by_kind, SDK_PROVIDERS};

        fn descriptor(kind: AdapterKind) -> &'static ryu_gw_credentials::SdkProviderDescriptor {
            // Exhaustiveness makes a newly enabled upstream adapter an explicit
            // contract decision rather than an ungoverned account surface.
            match kind {
                AdapterKind::OpenAI
                | AdapterKind::OpenAIResp
                | AdapterKind::Gemini
                | AdapterKind::Anthropic
                | AdapterKind::Fireworks
                | AdapterKind::Together
                | AdapterKind::Groq
                | AdapterKind::Aihubmix
                | AdapterKind::Mimo
                | AdapterKind::Moonshot
                | AdapterKind::Nebius
                | AdapterKind::Xai
                | AdapterKind::DeepSeek
                | AdapterKind::Zai
                | AdapterKind::BigModel
                | AdapterKind::Aliyun
                | AdapterKind::Baidu
                | AdapterKind::Cohere
                | AdapterKind::Ollama
                | AdapterKind::OllamaCloud
                | AdapterKind::Vertex
                | AdapterKind::GithubCopilot
                | AdapterKind::OpenCodeGo
                | AdapterKind::BedrockApi
                | AdapterKind::OpenRouter
                | AdapterKind::MiniMax => sdk_provider_by_kind(kind.as_lower_str()).unwrap(),
            }
        }
        for expected in SDK_PROVIDERS {
            let kind = AdapterKind::from_lower_str(expected.kind).unwrap();
            assert_eq!(descriptor(kind), expected);
            assert_eq!(kind.default_key_env_name(), expected.default_env);
        }
    }

    #[tokio::test]
    async fn streaming_proxy_rejection_fails_over_before_returning_a_body() {
        use super::*;
        use crate::test_support::{MockResponse, MockServer};
        let rejected = MockServer::always(MockResponse::json(407, "{}")).await;
        let sse=b"data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"recovered\"}]},\"finishReason\":\"STOP\"}]}\n\n";
        let healthy =
            MockServer::always(MockResponse::ok_bytes("text/event-stream", sse.to_vec())).await;
        let native = [rejected.base_url(), healthy.base_url()]
            .into_iter()
            .map(|url| {
                reqwest::Client::builder()
                    .no_proxy()
                    .proxy(reqwest::Proxy::all(url).unwrap())
                    .build()
                    .unwrap()
            })
            .collect();
        let sdk = [rejected.base_url(), healthy.base_url()]
            .into_iter()
            .map(|url| {
                reqwest_sdk::Client::builder()
                    .no_proxy()
                    .proxy(reqwest_sdk::Proxy::all(url).unwrap())
                    .build()
                    .unwrap()
            })
            .collect();
        let pool = Arc::new(
            EgressClientPool::new(native)
                .unwrap()
                .with_sdk_clients(sdk)
                .unwrap(),
        );
        let mut provider = GenAiProvider::egress_fixture(
            HashMap::from([("gemini".to_owned(), "account".to_owned())]),
            Vec::new(),
            reqwest::Client::new(),
            Some(pool),
        );
        provider.sdk_test_endpoint = Some("http://unreachable.invalid/".to_owned());
        let body = provider
            .complete_stream_for_session(
                "gemini-2.5-flash",
                &json!({"messages":[{"role":"user","content":"hi"}]}),
                Some("stream-session"),
            )
            .await
            .unwrap();
        let output = axum::body::to_bytes(body, 65536).await.unwrap();
        assert!(String::from_utf8_lossy(&output).contains("recovered"));
        assert_eq!(rejected.requests().len(), 1);
        assert_eq!(healthy.requests().len(), 1);
    }
    #[tokio::test]
    async fn proxy_pool_carries_native_sdk_chat_stream_and_image_requests() {
        use super::*;
        use crate::test_support::{MockResponse, MockServer};
        let text = r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"proxied"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}"#;
        let rejected = MockServer::always(MockResponse::json(407, "{}")).await;
        let healthy=MockServer::start(vec![MockResponse::ok_json(text),MockResponse::ok_bytes("text/event-stream",format!("data: {text}\n\n").into_bytes()),MockResponse::ok_json(r#"{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"AQID"}}]}}]}"#)]).await;
        let native = [rejected.base_url(), healthy.base_url()]
            .into_iter()
            .map(|url| {
                reqwest::Client::builder()
                    .no_proxy()
                    .proxy(reqwest::Proxy::all(url).unwrap())
                    .build()
                    .unwrap()
            })
            .collect();
        let sdk = [rejected.base_url(), healthy.base_url()]
            .into_iter()
            .map(|url| {
                reqwest_sdk::Client::builder()
                    .no_proxy()
                    .proxy(reqwest_sdk::Proxy::all(url).unwrap())
                    .build()
                    .unwrap()
            })
            .collect();
        let pool = Arc::new(
            EgressClientPool::new(native)
                .unwrap()
                .with_sdk_clients(sdk)
                .unwrap(),
        );
        let mut provider = GenAiProvider::egress_fixture(
            HashMap::from([("gemini".to_owned(), "same-account".to_owned())]),
            Vec::new(),
            reqwest::Client::new(),
            Some(pool),
        );
        provider.sdk_test_endpoint = Some("http://unreachable.invalid/".to_owned());
        provider.image_base_url = "http://unreachable.invalid/v1".to_owned();
        let body = json!({"messages":[{"role":"user","content":"hi"}]});
        assert_eq!(
            provider
                .complete_for_session("gemini-2.5-flash", &body, Some("session"))
                .await
                .unwrap()["choices"][0]["message"]["content"],
            "proxied"
        );
        let stream = provider
            .complete_stream_for_session("gemini-2.5-flash", &body, Some("session"))
            .await
            .unwrap();
        assert!(
            String::from_utf8_lossy(&axum::body::to_bytes(stream, 65536).await.unwrap())
                .contains("proxied")
        );
        assert_eq!(
            provider
                .generate_image("gemini-2.5-flash-image", &json!({"prompt":"cat"}))
                .await
                .unwrap()["data"][0]["b64_json"],
            "AQID"
        );
        assert_eq!(rejected.requests().len(), 1);
        assert_eq!(healthy.requests().len(), 3);
        for request in healthy.requests() {
            assert_eq!(
                request.header("x-goog-api-key").as_deref(),
                Some("same-account")
            );
        }
        assert!(provider.has_rotating_accounts());
    }
    use super::*;
    use crate::test_support::{MockResponse, MockServer};

    fn mock_chat_client(base_url: &str, key: &str) -> Client {
        let key = key.to_owned();
        let endpoint = format!("{}/", base_url.trim_end_matches('/'));
        let auth = AuthResolver::from_resolver_fn(
            move |_model: ModelIden| -> Result<Option<AuthData>, ::genai::resolver::Error> {
                Ok(Some(AuthData::from_single(key.clone())))
            },
        );
        let target = ::genai::resolver::ServiceTargetResolver::from_resolver_fn(
            move |mut target: ::genai::ServiceTarget| {
                target.endpoint = ::genai::resolver::Endpoint::from_owned(endpoint.clone());
                Ok(target)
            },
        );
        Client::builder()
            .with_auth_resolver(auth)
            .with_service_target_resolver(target)
            .build()
    }

    #[tokio::test]
    async fn gemini_chat_keeps_one_session_on_the_same_key() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}"#,
        ))
        .await;
        let mut provider = GenAiProvider::image_fixture(
            HashMap::from([("gemini".to_owned(), "first-key".to_owned())]),
            vec!["second-key".to_owned()],
            reqwest::Client::new(),
            GEMINI_IMAGE_BASE_URL.to_owned(),
        );
        provider.clients = vec![
            mock_chat_client(server.base_url(), "first-key"),
            mock_chat_client(server.base_url(), "second-key"),
        ];
        let body = json!({"messages":[{"role":"user","content":"hi"}]});
        for session in ["first-session", "second-session", "first-session"] {
            let answer = provider
                .complete_for_session("gemini-2.5-flash", &body, Some(session))
                .await
                .unwrap();
            assert_eq!(answer["choices"][0]["message"]["content"], "hello");
        }
        let requests = server.requests();
        assert_eq!(requests.len(), 3);
        assert_eq!(
            requests[0].header("x-goog-api-key").as_deref(),
            Some("first-key")
        );
        assert_eq!(
            requests[1].header("x-goog-api-key").as_deref(),
            Some("second-key")
        );
        assert_eq!(
            requests[2].header("x-goog-api-key").as_deref(),
            Some("first-key")
        );
    }

    #[tokio::test]
    async fn configured_fill_first_and_drain_control_chat_and_image_accounts() {
        let chat = r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}"#;
        let server = MockServer::start(vec![
            MockResponse::ok_json(chat),
            MockResponse::ok_json(chat),
            MockResponse::ok_json(chat),
            MockResponse::ok_json(chat),
            MockResponse::ok_json(r#"{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"AQID"}}]}}]}"#),
        ])
        .await;
        let mut provider = GenAiProvider::image_fixture(
            HashMap::from([("gemini".to_owned(), "first-key".to_owned())]),
            vec!["second-key".to_owned()],
            reqwest::Client::new(),
            server.base_url().to_owned(),
        );
        provider.clients = vec![
            mock_chat_client(server.base_url(), "first-key"),
            mock_chat_client(server.base_url(), "second-key"),
        ];
        provider.configure_account_strategy(crate::AccountSelectionStrategy::FillFirst);
        provider.configure_fill_first_drain_percent(60);
        let body = json!({"messages":[{"role":"user","content":"hi"}]});
        for session in ["warm-session", "second-session"] {
            provider
                .complete_for_session("gemini-2.5-flash", &body, Some(session))
                .await
                .unwrap();
        }
        // Simulate fresh upstream observations. Seventy percent used must drain
        // at the configured sixty percent, while the default eighty would stay.
        for (account, remaining) in [30, 90].into_iter().enumerate() {
            provider
                .accounts
                .record_quota_domain(account, &format!("org-{account}"));
            provider.accounts.record_quota(
                account,
                &crate::RateLimitInfo {
                    remaining: Some(remaining),
                    limit: Some(100),
                    ..Default::default()
                },
            );
        }
        for session in ["fresh-session", "warm-session"] {
            provider
                .complete_for_session("gemini-2.5-flash", &body, Some(session))
                .await
                .unwrap();
        }
        assert_eq!(
            provider
                .generate_image("gemini-2.5-flash-image", &json!({"prompt":"cat"}))
                .await
                .unwrap()["data"][0]["b64_json"],
            "AQID"
        );
        let requests = server.requests();
        assert_eq!(requests.len(), 5);
        for (request, key) in requests.iter().zip([
            "first-key",
            "first-key",
            "second-key",
            "first-key",
            "second-key",
        ]) {
            assert_eq!(request.header("x-goog-api-key").as_deref(), Some(key));
        }
    }

    #[tokio::test]
    async fn gemini_chat_rotates_after_a_structured_429() {
        let server = MockServer::start(vec![
            MockResponse::json(429, r#"{"error":{"message":"quota"}}"#),
            MockResponse::ok_json(
                r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"recovered"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}"#,
            ),
        ])
        .await;
        let mut provider = GenAiProvider::image_fixture(
            HashMap::from([("gemini".to_owned(), "first-key".to_owned())]),
            vec!["second-key".to_owned()],
            reqwest::Client::new(),
            GEMINI_IMAGE_BASE_URL.to_owned(),
        );
        provider.clients = vec![
            mock_chat_client(server.base_url(), "first-key"),
            mock_chat_client(server.base_url(), "second-key"),
        ];
        let answer = provider
            .complete_for_session(
                "gemini-2.5-flash",
                &json!({"messages":[{"role":"user","content":"hi"}]}),
                Some("same-session"),
            )
            .await
            .unwrap();
        assert_eq!(answer["choices"][0]["message"]["content"], "recovered");
        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].header("x-goog-api-key").as_deref(),
            Some("first-key")
        );
        assert_eq!(
            requests[1].header("x-goog-api-key").as_deref(),
            Some("second-key")
        );
        assert_eq!(
            provider.account_candidates("gemini-2.5-flash", Some("same-session"))[0],
            1
        );
    }

    #[tokio::test]
    async fn gemini_chat_rotates_after_account_payment_rejection() {
        let server = MockServer::start(vec![
            MockResponse::json(402, r#"{"error":{"message":"no credits"}}"#),
            MockResponse::ok_json(
                r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"second account"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}"#,
            ),
        ])
        .await;
        let mut provider = GenAiProvider::image_fixture(
            HashMap::from([("gemini".to_owned(), "first-key".to_owned())]),
            vec!["second-key".to_owned()],
            reqwest::Client::new(),
            GEMINI_IMAGE_BASE_URL.to_owned(),
        );
        provider.clients = vec![
            mock_chat_client(server.base_url(), "first-key"),
            mock_chat_client(server.base_url(), "second-key"),
        ];
        let answer = provider
            .complete_for_session(
                "gemini-2.5-flash",
                &json!({"messages":[{"role":"user","content":"hi"}]}),
                Some("payment-session"),
            )
            .await
            .unwrap();
        assert_eq!(answer["choices"][0]["message"]["content"], "second account");
        assert_eq!(server.requests().len(), 2);
        assert_eq!(
            provider.account_candidates("gemini-2.5-flash", Some("payment-session"))[0],
            1
        );
    }

    #[tokio::test]
    async fn gemini_chat_and_stream_rotate_past_a_refused_key() {
        let chat = r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"second account"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}"#;
        let sse = b"data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"streamed\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":1,\"candidatesTokenCount\":1,\"totalTokenCount\":2}}\n\n";
        for stream in [false, true] {
            let ok = if stream {
                MockResponse::ok_bytes("text/event-stream", sse.to_vec())
            } else {
                MockResponse::ok_json(chat)
            };
            let server = MockServer::start(vec![
                MockResponse::json(
                    403,
                    r#"{"error":{"code":403,"message":"API key not valid","status":"PERMISSION_DENIED","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID"}]}}"#,
                ),
                ok,
            ])
            .await;
            let mut provider = GenAiProvider::image_fixture(
                HashMap::from([("gemini".to_owned(), "first-key".to_owned())]),
                vec!["second-key".to_owned()],
                reqwest::Client::new(),
                GEMINI_IMAGE_BASE_URL.to_owned(),
            );
            provider.clients = vec![
                mock_chat_client(server.base_url(), "first-key"),
                mock_chat_client(server.base_url(), "second-key"),
            ];
            let body = json!({"messages":[{"role":"user","content":"hi"}]});
            if stream {
                provider
                    .complete_stream_for_session("gemini-2.5-flash", &body, Some("auth-session"))
                    .await
                    .unwrap();
            } else {
                provider
                    .complete_for_session("gemini-2.5-flash", &body, Some("auth-session"))
                    .await
                    .unwrap();
            }
            assert_eq!(server.requests().len(), 2, "stream={stream}");
            assert_eq!(
                provider.account_candidates("gemini-2.5-flash", Some("auth-session")),
                vec![1],
                "stream={stream}"
            );
        }
    }

    #[tokio::test]
    async fn gemini_request_refusal_403_neither_rotates_nor_cools_the_key() {
        // A PERMISSION_DENIED that names no key problem refuses the request; the
        // next key would be refused the same way.
        let refusal = r#"{"error":{"code":403,"message":"The caller does not have permission","status":"PERMISSION_DENIED"}}"#;
        for stream in [false, true] {
            let server = MockServer::start(vec![MockResponse::json(403, refusal)]).await;
            let mut provider = GenAiProvider::image_fixture(
                HashMap::from([("gemini".to_owned(), "first-key".to_owned())]),
                vec!["second-key".to_owned()],
                reqwest::Client::new(),
                GEMINI_IMAGE_BASE_URL.to_owned(),
            );
            provider.clients = vec![
                mock_chat_client(server.base_url(), "first-key"),
                mock_chat_client(server.base_url(), "second-key"),
            ];
            let body = json!({"messages":[{"role":"user","content":"hi"}]});
            let refused = if stream {
                provider
                    .complete_stream_for_session("gemini-2.5-flash", &body, Some("refusal"))
                    .await
                    .is_err()
            } else {
                provider
                    .complete_for_session("gemini-2.5-flash", &body, Some("refusal"))
                    .await
                    .is_err()
            };
            assert!(refused, "stream={stream}");
            assert_eq!(server.requests().len(), 1, "stream={stream}");
            assert_eq!(
                provider.account_candidates("gemini-2.5-flash", Some("refusal"))[0],
                0,
                "stream={stream}"
            );
            assert_eq!(
                provider
                    .account_candidates("gemini-2.5-flash", Some("refusal"))
                    .len(),
                2,
                "stream={stream}"
            );
        }
    }

    #[tokio::test]
    async fn gemini_stream_retries_a_pre_body_429_on_the_next_account() {
        let sse = b"data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"streamed\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":1,\"candidatesTokenCount\":1,\"totalTokenCount\":2}}\n\n";
        let server = MockServer::start(vec![
            MockResponse::json(429, r#"{"error":{"message":"quota"}}"#),
            MockResponse::ok_bytes("text/event-stream", sse.to_vec()),
        ])
        .await;
        let mut provider = GenAiProvider::image_fixture(
            HashMap::from([("gemini".to_owned(), "first-key".to_owned())]),
            vec!["second-key".to_owned()],
            reqwest::Client::new(),
            GEMINI_IMAGE_BASE_URL.to_owned(),
        );
        provider.clients = vec![
            mock_chat_client(server.base_url(), "first-key"),
            mock_chat_client(server.base_url(), "second-key"),
        ];
        let body = provider
            .complete_stream_for_session(
                "gemini-2.5-flash",
                &json!({"messages":[{"role":"user","content":"hi"}]}),
                Some("stream-session"),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(body, 1024 * 1024).await.unwrap();
        let output = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(output.contains("streamed"));
        assert!(output.contains("[DONE]"));
        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].header("x-goog-api-key").as_deref(),
            Some("first-key")
        );
        assert_eq!(
            requests[1].header("x-goog-api-key").as_deref(),
            Some("second-key")
        );
    }

    #[tokio::test]
    async fn gemini_image_round_trip_uses_native_generate_content_and_openai_output() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"candidates":[{"content":{"parts":[{"text":"A red fox"},{"inlineData":{"mimeType":"image/png","data":"AQID"}}]}}]}"#,
        ))
        .await;
        let provider = GenAiProvider::image_fixture(
            HashMap::from([("gemini".to_owned(), "test-gemini-key".to_owned())]),
            Vec::new(),
            reqwest::Client::new(),
            format!("{}/v1", server.base_url()),
        );
        let result = provider
            .generate_image(
                "gemini-3.1-flash-image",
                &json!({ "prompt": "A red fox", "size": "1024x1024" }),
            )
            .await
            .unwrap();
        assert_eq!(result["data"][0]["b64_json"], "AQID");
        assert_eq!(result["data"][0]["content_type"], "image/png");
        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0].path,
            "/v1/models/gemini-3.1-flash-image:generateContent"
        );
        assert_eq!(
            requests[0].header("x-goog-api-key").as_deref(),
            Some("test-gemini-key")
        );
        assert_eq!(
            requests[0].json()["contents"][0]["parts"][0]["text"],
            "A red fox"
        );
        assert_eq!(
            requests[0].json()["generationConfig"]["responseModalities"],
            json!(["IMAGE"])
        );
        assert_eq!(
            requests[0].json()["generationConfig"]["responseFormat"]["image"]["aspectRatio"],
            "1:1"
        );
    }

    #[tokio::test]
    async fn accepted_or_ambiguous_gemini_image_failure_never_replays() {
        for reply in [
            MockResponse::ok_json("not-json"),
            MockResponse::ok_json(
                r#"{"candidates":[{"content":{"parts":[{"text":"no image"}]}}]}"#,
            ),
            MockResponse::ok_json(
                r#"{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"bad-base64"}}]}}]}"#,
            ),
            MockResponse::json(503, "{}"),
        ] {
            let server = MockServer::always(reply).await;
            let provider = GenAiProvider::image_fixture(
                HashMap::from([("gemini".to_owned(), "first".to_owned())]),
                vec!["second".to_owned()],
                reqwest::Client::new(),
                format!("{}/v1", server.base_url()),
            );
            let result = provider
                .generate_image("gemini-3.1-flash-image", &json!({"prompt":"fox"}))
                .await;
            assert!(matches!(result, Err(ProviderError::DeliveryUncertain(_))));
            assert_eq!(server.requests().len(), 1);
        }
    }

    #[tokio::test]
    async fn gemini_image_rotates_to_the_next_account_after_a_429() {
        let server = MockServer::start(vec![
            MockResponse::json(429, r#"{"error":"quota"}"#),
            MockResponse::ok_json(
                r#"{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"AQID"}}]}}]}"#,
            ),
        ])
        .await;
        let provider = GenAiProvider::image_fixture(
            HashMap::from([("gemini".to_owned(), "first-key".to_owned())]),
            vec!["second-key".to_owned()],
            reqwest::Client::new(),
            format!("{}/v1", server.base_url()),
        );
        assert!(provider.has_rotating_accounts());
        let result = provider
            .generate_image("gemini-3.1-flash-image", &json!({"prompt":"a cat"}))
            .await
            .unwrap();
        assert_eq!(result["data"][0]["b64_json"], "AQID");
        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].header("x-goog-api-key").as_deref(),
            Some("first-key")
        );
        assert_eq!(
            requests[1].header("x-goog-api-key").as_deref(),
            Some("second-key")
        );
    }

    #[test]
    fn gemini_sessions_stay_on_an_account_until_it_cools_down() {
        let provider = GenAiProvider::image_fixture(
            HashMap::from([("gemini".to_owned(), "first-key".to_owned())]),
            vec!["second-key".to_owned()],
            reqwest::Client::new(),
            GEMINI_IMAGE_BASE_URL.to_owned(),
        );
        assert_eq!(
            provider.account_candidates("gemini-2.5-flash", Some("one"))[0],
            0
        );
        assert_eq!(
            provider.account_candidates("gemini-2.5-flash", Some("two"))[0],
            1
        );
        assert_eq!(
            provider.account_candidates("gemini-2.5-flash", Some("one"))[0],
            0
        );
        provider.accounts.record_rate_limit(0, Some(30));
        assert_eq!(
            provider.account_candidates("gemini-2.5-flash", Some("one"))[0],
            1
        );
    }

    #[test]
    fn sdk_reflected_error_bodies_do_not_reach_display_or_debug_logging() {
        const SECRET: &str = "sdk-reflected-private-prompt-and-key";
        for status in [400, 402, 429, 500] {
            let error = ::genai::Error::HttpError {
                status: reqwest::StatusCode::from_u16(status).unwrap(),
                canonical_reason: SECRET.into(),
                body: SECRET.into(),
            };
            let mapped = map_genai_error(error, "genai");
            assert!(!mapped.to_string().contains(SECRET));
            assert!(!format!("{mapped:?}").contains(SECRET));
        }
        let nested = ::genai::Error::WebStream {
            cause: SECRET.into(),
            error: Box::new(::genai::Error::HttpError {
                status: reqwest::StatusCode::BAD_REQUEST,
                canonical_reason: SECRET.into(),
                body: SECRET.into(),
            }),
            model_iden: ::genai::ModelIden::new(
                ::genai::adapter::AdapterKind::OpenAI,
                "known-model",
            ),
        };
        let mapped = map_genai_error(nested, "genai");
        assert!(!format!("{mapped:?}").contains(SECRET));
    }

    #[test]
    fn structured_genai_request_rejections_do_not_read_as_provider_faults() {
        for status in [400, 404, 413, 422] {
            let error = ::genai::Error::HttpError {
                status: reqwest::StatusCode::from_u16(status).unwrap(),
                canonical_reason: "Bad Request".to_owned(),
                body: "invalid argument".to_owned(),
            };
            assert!(
                matches!(
                    map_genai_error(error, "gemini"),
                    ProviderError::Rejected { .. }
                ),
                "{status}"
            );
        }
        for status in [401, 403] {
            let error = ::genai::Error::HttpError {
                status: reqwest::StatusCode::from_u16(status).unwrap(),
                canonical_reason: "Refused".to_owned(),
                body: "refused".to_owned(),
            };
            assert!(
                matches!(
                    map_genai_error(error, "gemini"),
                    ProviderError::Rejected { status: carried, .. } if carried == status
                ),
                "{status}"
            );
        }
        for status in [408, 500, 503] {
            let error = ::genai::Error::HttpError {
                status: reqwest::StatusCode::from_u16(status).unwrap(),
                canonical_reason: "Upstream".to_owned(),
                body: "upstream".to_owned(),
            };
            assert!(
                matches!(map_genai_error(error, "gemini"), ProviderError::Provider(_)),
                "{status}"
            );
        }
    }

    #[test]
    fn structured_genai_429_stays_a_rate_limit() {
        let error = ::genai::Error::HttpError {
            status: reqwest::StatusCode::TOO_MANY_REQUESTS,
            canonical_reason: "Too Many Requests".to_owned(),
            body: "quota".to_owned(),
        };
        assert!(
            matches!(map_genai_error(error, "genai"), ProviderError::RateLimited { provider, .. } if provider == "genai")
        );
    }

    #[tokio::test]
    async fn gemini_image_rejects_missing_key_before_a_network_request() {
        let server = MockServer::always(MockResponse::ok_json("{}")).await;
        let mut provider = GenAiProvider::image_fixture(
            HashMap::new(),
            Vec::new(),
            reqwest::Client::new(),
            format!("{}/v1", server.base_url()),
        );
        provider.keys.clear();
        let result = provider
            .generate_image("gemini-3.1-flash-image", &json!({ "prompt": "A red fox" }))
            .await;
        assert!(
            matches!(result, Err(ProviderError::Provider(message)) if message.contains("API key"))
        );
        assert_eq!(server.request_count(), 0);
    }

    #[tokio::test]
    async fn gemini_image_rate_limit_keeps_the_capacity_error_typed() {
        let server = MockServer::always(MockResponse::json(
            429,
            r#"{"error":{"message":"quota exceeded"}}"#,
        ))
        .await;
        let provider = GenAiProvider::image_fixture(
            HashMap::from([("gemini".to_owned(), "test-gemini-key".to_owned())]),
            Vec::new(),
            reqwest::Client::new(),
            format!("{}/v1", server.base_url()),
        );
        let result = provider
            .generate_image("gemini-3.1-flash-image", &json!({ "prompt": "A fox" }))
            .await;
        assert!(matches!(result, Err(ProviderError::RateLimited { .. })));
        assert_eq!(server.request_count(), 1);
    }

    #[test]
    fn gemini_image_rejects_invalid_image_bytes() {
        let result = normalize_gemini_images(&json!({
            "candidates": [{ "content": { "parts": [
                { "inlineData": { "mimeType": "image/png", "data": "not-base64" } }
            ] } }]
        }));
        assert!(
            matches!(result, Err(ProviderError::Provider(message)) if message.contains("invalid"))
        );
    }

    #[test]
    fn image_options_reject_unsupported_count_and_map_older_aspect_ratio() {
        assert!(image_generation_config("gemini-3.1-flash-image", &json!({"n":2})).is_err());
        assert!(image_generation_config("gemini-3.1-flash-image", &json!({"size":42})).is_err());
        assert!(image_generation_config(
            "gemini-3.1-flash-image",
            &json!({"response_format":"url"})
        )
        .is_err());
        let config =
            image_generation_config("gemini-2.5-flash-image", &json!({"size":"1536x1024"}))
                .unwrap();
        assert_eq!(config["imageConfig"]["aspectRatio"], "3:2");
    }

    #[test]
    fn a_text_only_response_does_not_claim_that_an_image_was_generated() {
        let result = normalize_gemini_images(
            &json!({"candidates":[{"content":{"parts":[{"text":"blocked"}]}}]}),
        );
        assert!(
            matches!(result, Err(ProviderError::Provider(message)) if message.contains("no image data"))
        );
    }

    #[test]
    fn vision_rejects_invalid_images_instead_of_dropping_them() {
        for url in [
            "https://example.com/image.png",
            "file:///secret.png",
            "data:image/png;base64,",
            "data:image/svg+xml;base64,AQID",
            "data:image/png;base64,not-base64",
        ] {
            let body = json!({"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":url}}]}]});
            assert!(parse_messages(&body).is_err(), "accepted {url}");
        }
        let body = json!({"messages":[{"role":"system","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,AQID"}}]}]});
        assert!(parse_messages(&body).is_err());
        let body = json!({"messages":[{"role":"user","content":[{"type":"input_audio"}]}]});
        assert!(parse_messages(&body).is_err());
    }

    #[test]
    fn vision_image_limit_is_shared_across_messages() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(vec![1; 6 * 1024 * 1024]);
        let message = json!({"role":"user","content":[{"type":"image_url","image_url":{"url":format!("data:image/png;base64,{encoded}")}}]});
        assert!(parse_messages(&json!({"messages":[message.clone()]})).is_ok());
        assert!(parse_messages(&json!({"messages":[message.clone(),message]})).is_err());
    }

    #[tokio::test]
    async fn gemini_vision_preserves_images_for_buffered_and_streaming_chat() {
        let response = r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"a fox"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}"#;
        let server = MockServer::start(vec![
            MockResponse::ok_json(response),
            MockResponse::ok_bytes(
                "text/event-stream",
                format!("data: {response}\n\n").into_bytes(),
            ),
        ])
        .await;
        let mut provider = GenAiProvider::fixture(HashMap::from([(
            "gemini".to_owned(),
            "vision-key".to_owned(),
        )]));
        provider.clients = vec![mock_chat_client(server.base_url(), "vision-key")];
        let body = json!({"messages":[{"role":"user","content":[
            {"type":"text","text":"What is this?"},
            {"type":"image_url","image_url":{"url":"data:image/png;base64,AQID"}},
            {"type":"text","text":"Be brief."}
        ]}]});
        let answer = provider.complete("gemini-2.5-flash", &body).await.unwrap();
        assert_eq!(answer["choices"][0]["message"]["content"], "a fox");
        let stream = provider
            .complete_stream("gemini-2.5-flash", &body)
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(stream, 65536).await.unwrap();
        assert!(String::from_utf8_lossy(&bytes).contains("a fox"));
        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        for request in requests {
            assert_eq!(
                request.json()["contents"][0]["parts"],
                json!([
                    {"text":"What is this?"},
                    {"inline_data":{"mime_type":"image/png","data":"AQID"}},
                    {"text":"Be brief."}
                ])
            );
        }
    }

    #[tokio::test]
    async fn sdk_vision_preserves_inline_images_for_groq_and_xai() {
        for (kind, model) in [("groq", "groq::vision-model"), ("xai", "xai::vision-model")] {
            let reply = json!({"id":"vision","object":"chat.completion","created":1,
                "model":"vision-model","choices":[{"index":0,"message":{"role":"assistant","content":"a fox"},"finish_reason":"stop"}]});
            let chunk = json!({"id":"vision","object":"chat.completion.chunk","created":1,
                "model":"vision-model","choices":[{"index":0,"delta":{"role":"assistant","content":"a fox"},"finish_reason":null}]});
            let server = MockServer::start(vec![
                MockResponse::ok_json(reply.to_string()),
                MockResponse::ok_bytes(
                    "text/event-stream",
                    format!("data: {chunk}\n\ndata: [DONE]\n\n").into_bytes(),
                ),
            ])
            .await;
            let mut provider = GenAiProvider::new_for_kind(
                ryu_gw_credentials::sdk_provider_by_kind(kind).unwrap(),
                vec!["vision-key".to_owned()],
                SdkEndpointConfig::Default,
                reqwest::Client::new(),
                None,
                Arc::new(ProviderQuotas::new()),
            )
            .unwrap();
            provider.clients = vec![mock_chat_client(server.base_url(), "vision-key")];
            let body = json!({"messages":[{"role":"user","content":[
                {"type":"text","text":"What is this?"},
                {"type":"image_url","image_url":{"url":"data:image/png;base64,AQID"}}
            ]}]});
            assert_eq!(
                provider.complete(model, &body).await.unwrap()["choices"][0]["message"]["content"],
                "a fox"
            );
            let stream = provider.complete_stream(model, &body).await.unwrap();
            let bytes = axum::body::to_bytes(stream, 65536).await.unwrap();
            assert!(String::from_utf8_lossy(&bytes).contains("a fox"));
            let requests = server.requests();
            assert_eq!(requests.len(), 2);
            for request in requests {
                assert_eq!(
                    request.json()["messages"][0]["content"][1]["image_url"]["url"],
                    "data:image/png;base64,AQID"
                );
                assert_eq!(
                    request.header("authorization").as_deref(),
                    Some("Bearer vision-key")
                );
            }
        }
    }

    #[test]
    fn parse_messages_maps_roles_and_count() {
        let body = json!({
            "messages": [
                { "role": "system", "content": "sys" },
                { "role": "user", "content": "hi" },
                { "role": "assistant", "content": "hey" },
                { "role": "tool", "content": "result" }
            ]
        });
        let msgs = parse_messages(&body).unwrap();
        // All four are mapped (tool folds into a user turn, never dropped).
        assert_eq!(msgs.len(), 4);
    }

    #[test]
    fn parse_messages_empty_when_no_messages_field() {
        assert!(parse_messages(&json!({})).unwrap().is_empty());
        assert!(parse_messages(&json!({ "messages": "nope" }))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn build_options_maps_sampling_params() {
        let body = json!({
            "temperature": 0.3,
            "max_tokens": 256,
            "top_p": 0.8,
            "stop": ["END", "STOP"]
        });
        let opts = build_options(&body, false);
        assert_eq!(opts.temperature, Some(0.3));
        assert_eq!(opts.max_tokens, Some(256));
        assert_eq!(opts.top_p, Some(0.8));
        assert_eq!(
            opts.stop_sequences,
            vec!["END".to_string(), "STOP".to_string()]
        );
        // capture_usage only set on the streaming path.
        assert_eq!(opts.capture_usage, None);
    }

    #[test]
    fn build_options_maps_integer_top_k_only() {
        assert_eq!(
            build_options(&json!({ "top_k": 40 }), false).top_k,
            Some(40)
        );
        assert_eq!(build_options(&json!({ "top_k": 0.5 }), false).top_k, None);
        assert_eq!(build_options(&json!({ "top_k": -1 }), false).top_k, None);
    }

    #[test]
    fn build_options_string_stop_becomes_single_sequence() {
        let opts = build_options(&json!({ "stop": "HALT" }), false);
        assert_eq!(opts.stop_sequences, vec!["HALT".to_string()]);
    }

    #[test]
    fn build_options_accepts_current_chat_token_limit() {
        let opts = build_options(&json!({ "max_completion_tokens": 123 }), false);
        assert_eq!(opts.max_tokens, Some(123));
    }

    #[test]
    fn build_options_capture_usage_on_stream() {
        let opts = build_options(&json!({}), true);
        assert_eq!(opts.capture_usage, Some(true));
        // Nothing else set when the body is empty.
        assert_eq!(opts.temperature, None);
        assert!(opts.stop_sequences.is_empty());
    }

    #[test]
    fn build_options_ignores_empty_stop_array() {
        let opts = build_options(&json!({ "stop": [] }), false);
        assert!(opts.stop_sequences.is_empty());
    }

    #[test]
    fn genai_provider_name_is_genai() {
        let p = GenAiProvider::fixture(std::collections::HashMap::new());
        assert_eq!(p.name(), "genai");
    }

    fn weather_tools() -> Value {
        json!([{
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Weather for a city",
                "parameters": {
                    "type": "object",
                    "properties": { "city": { "type": "string" } },
                    "required": ["city"],
                },
            },
        }])
    }

    #[test]
    fn tool_history_replays_as_tool_calls_and_responses() {
        let body = json!({
            "messages": [
                { "role": "user", "content": "weather?" },
                {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        { "id": "call_a", "type": "function",
                          "function": { "name": "get_weather", "arguments": "{\"city\":\"Paris\"}" } },
                        { "id": "call_b", "type": "function",
                          "function": { "name": "get_time", "arguments": "" } },
                    ],
                },
                { "role": "tool", "tool_call_id": "call_a", "content": "sunny" },
                { "role": "tool", "tool_call_id": "call_b",
                  "content": [{ "type": "text", "text": "noon" }] },
            ],
            "tools": weather_tools(),
        });
        let msgs = parse_messages(&body).unwrap();
        // Both results share one tool turn instead of becoming user text.
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[1].role, ChatRole::Assistant);
        let calls = msgs[1].content.tool_calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].call_id, "call_a");
        assert_eq!(calls[0].fn_arguments, json!({ "city": "Paris" }));
        assert_eq!(calls[1].fn_arguments, json!({}));
        assert_eq!(msgs[2].role, ChatRole::Tool);
        let responses = msgs[2].content.tool_responses();
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0].call_id, "call_a");
        assert_eq!(responses[0].fn_name.as_deref(), Some("get_weather"));
        assert_eq!(responses[0].content, "sunny");
        assert_eq!(responses[1].fn_name.as_deref(), Some("get_time"));
        assert_eq!(responses[1].content, "noon");
    }

    #[test]
    fn malformed_tool_call_arguments_are_refused() {
        let body = json!({ "messages": [{
            "role": "assistant",
            "tool_calls": [{ "id": "c", "function": { "name": "f", "arguments": "{not json" } }],
        }]});
        assert!(parse_messages(&body).is_err());
    }

    #[test]
    fn tool_only_assistant_turn_with_empty_content_has_no_text_part() {
        let call = json!([{ "id": "c", "type": "function",
                            "function": { "name": "f", "arguments": "{}" } }]);
        for content in [
            json!(""),
            json!("  "),
            json!([{ "type": "text", "text": "" }]),
        ] {
            let body = json!({ "messages": [
                { "role": "assistant", "content": content, "tool_calls": call },
            ], "tools": weather_tools() });
            let msgs = parse_messages(&body).unwrap();
            assert_eq!(msgs[0].content.parts().len(), 1, "content={content}");
            assert!(msgs[0].content.texts().is_empty(), "content={content}");
            assert_eq!(msgs[0].content.tool_calls().len(), 1);
        }
        // Text written beside the calls is kept.
        let body = json!({ "messages": [
            { "role": "assistant", "content": "checking", "tool_calls": call },
        ], "tools": weather_tools() });
        assert_eq!(
            parse_messages(&body).unwrap()[0].content.texts(),
            vec!["checking"]
        );
    }

    #[test]
    fn tool_history_without_tools_replays_as_plain_text() {
        let calls = json!([
            { "id": "call_a", "type": "function",
              "function": { "name": "get_weather", "arguments": "{\"city\":\"Paris\"}" } },
            { "id": "call_b", "type": "function",
              "function": { "name": "get_time", "arguments": "" } },
        ]);
        // No `tools`, as after a budget restriction strips them; an empty
        // array declares none either.
        for tools in [None, Some(json!([]))] {
            let mut body = json!({ "messages": [
                { "role": "user", "content": "weather?" },
                { "role": "assistant", "content": null, "tool_calls": calls },
                { "role": "tool", "tool_call_id": "call_a", "content": "sunny" },
                { "role": "tool", "tool_call_id": "call_b",
                  "content": [{ "type": "text", "text": "noon" }] },
                { "role": "assistant", "content": "", "tool_calls": [calls[0].clone()] },
            ]});
            if let Some(tools) = tools {
                body["tools"] = tools;
            }
            let request = build_request(&body).unwrap();
            assert!(request.tools.is_none());
            let msgs = request.messages;
            assert_eq!(msgs.len(), 4);
            for msg in &msgs {
                assert!(msg.content.tool_calls().is_empty(), "{msg:?}");
                assert!(msg.content.tool_responses().is_empty(), "{msg:?}");
            }
            // A tool-only turn with null or empty content is still a text turn.
            assert_eq!(msgs[1].role, ChatRole::Assistant);
            assert_eq!(
                msgs[1].content.joined_texts().as_deref(),
                Some(
                    "[called tool get_weather with {\"city\":\"Paris\"}]\n\
                     [called tool get_time with {}]"
                )
            );
            // One turn's results share one user turn.
            assert_eq!(msgs[2].role, ChatRole::User);
            assert_eq!(
                msgs[2].content.joined_texts().as_deref(),
                Some("[tool get_weather result: sunny]\n[tool get_time result: noon]")
            );
            assert_eq!(
                msgs[3].content.joined_texts().as_deref(),
                Some("[called tool get_weather with {\"city\":\"Paris\"}]")
            );
        }

        // Text beside the calls is kept ahead of them.
        let body = json!({ "messages": [
            { "role": "assistant", "content": "checking", "tool_calls": [calls[1].clone()] },
        ]});
        assert_eq!(
            parse_messages(&body).unwrap()[0].content.texts(),
            vec!["checking\n[called tool get_time with {}]"]
        );
    }

    #[test]
    fn request_carries_function_tools_and_refuses_other_types() {
        let request = build_request(&json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": weather_tools(),
        }))
        .unwrap();
        let tools = request.tools.expect("tools attached");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name.as_str(), "get_weather");
        assert_eq!(tools[0].description.as_deref(), Some("Weather for a city"));
        assert_eq!(
            tools[0].schema.as_ref().unwrap()["required"],
            json!(["city"])
        );

        assert!(build_request(&json!({ "messages": [], "tools": [] }))
            .unwrap()
            .tools
            .is_none());
        assert!(build_request(&json!({
            "messages": [],
            "tools": [{ "type": "code_interpreter" }],
        }))
        .is_err());
    }

    #[test]
    fn build_options_maps_tool_choice_only_alongside_tools() {
        let tools = weather_tools();
        for (choice, expected) in [
            (json!("auto"), ToolChoice::Auto),
            (json!("none"), ToolChoice::None),
            (json!("required"), ToolChoice::Required),
            (
                json!({ "type": "function", "function": { "name": "get_weather" } }),
                ToolChoice::tool("get_weather"),
            ),
        ] {
            let opts = build_options(&json!({ "tools": tools, "tool_choice": choice }), false);
            assert_eq!(opts.tool_choice, Some(expected));
        }
        let opts = build_options(&json!({ "tool_choice": "required" }), false);
        assert_eq!(opts.tool_choice, None);
        // Streaming captures tool calls so chunks carry accumulated arguments.
        assert_eq!(
            build_options(&json!({}), true).capture_tool_calls,
            Some(true)
        );
        assert_eq!(build_options(&json!({}), false).capture_tool_calls, None);
    }

    fn chat_response(content: MessageContent, stop: Option<&str>) -> ChatResponse {
        let iden = ModelIden::new(::genai::adapter::AdapterKind::Gemini, "gemini-2.5-flash");
        ChatResponse {
            content,
            reasoning_content: None,
            model_iden: iden.clone(),
            provider_model_iden: iden,
            stop_reason: stop.map(|s| StopReason::from(s.to_owned())),
            usage: Default::default(),
            captured_raw_body: None,
            response_id: None,
        }
    }

    #[test]
    fn response_surfaces_tool_calls_and_real_finish_reason() {
        let call = ToolCall {
            call_id: "call#get_weather#0".into(),
            fn_name: "get_weather".into(),
            fn_arguments: json!({ "city": "Paris" }),
            thought_signatures: None,
        };
        // Gemini reports STOP even when it called a function.
        let res = to_openai_response(
            chat_response(MessageContent::from_tool_calls(vec![call]), Some("STOP")),
            "gemini-2.5-flash",
        );
        let choice = &res["choices"][0];
        assert_eq!(choice["finish_reason"], "tool_calls");
        assert!(choice["message"]["content"].is_null());
        let tool_call = &choice["message"]["tool_calls"][0];
        assert_eq!(tool_call["id"], "call#get_weather#0");
        assert_eq!(tool_call["type"], "function");
        assert_eq!(tool_call["function"]["name"], "get_weather");
        let arguments: Value =
            serde_json::from_str(tool_call["function"]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(arguments, json!({ "city": "Paris" }));

        let res = to_openai_response(
            chat_response(MessageContent::from_text("cut"), Some("MAX_TOKENS")),
            "gemini-2.5-flash",
        );
        assert_eq!(res["choices"][0]["finish_reason"], "length");
        assert_eq!(res["choices"][0]["message"]["content"], "cut");
        assert!(res["choices"][0]["message"].get("tool_calls").is_none());

        let res = to_openai_response(chat_response(MessageContent::default(), None), "m");
        assert_eq!(res["choices"][0]["finish_reason"], "stop");
        assert_eq!(res["choices"][0]["message"]["content"], "");
    }

    async fn stream_frames(events: Vec<ChatStreamEvent>) -> Vec<Value> {
        translate_genai_stream(
            futures_util::stream::iter(events.into_iter().map(Ok)),
            "m".into(),
        )
        .map(|frame| String::from_utf8(frame.unwrap().to_vec()).unwrap())
        .collect::<Vec<_>>()
        .await
        .concat()
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter(|data| *data != "[DONE]")
        .map(|data| serde_json::from_str(data).unwrap())
        .collect()
    }

    fn tool_chunk(id: &str, name: &str, arguments: Value) -> ChatStreamEvent {
        ChatStreamEvent::ToolCallChunk(::genai::chat::ToolChunk {
            tool_call: ToolCall {
                call_id: id.into(),
                fn_name: name.into(),
                fn_arguments: arguments,
                thought_signatures: None,
            },
        })
    }

    #[tokio::test]
    async fn stream_emits_tool_call_deltas_and_tool_calls_finish() {
        use ::genai::chat::StreamEnd;
        let late = ToolCall {
            call_id: "call_late".into(),
            fn_name: "get_time".into(),
            fn_arguments: json!({}),
            thought_signatures: None,
        };
        let frames = stream_frames(vec![
            // Accumulated snapshots, as Anthropic / OpenAI chunks arrive.
            tool_chunk("call_a", "get_weather", json!("")),
            tool_chunk("call_a", "get_weather", json!("{\"city\":")),
            tool_chunk("call_a", "get_weather", json!("{\"city\":\"Paris\"}")),
            // A whole call at once, as Gemini sends it.
            tool_chunk("call_b", "get_weather", json!({ "city": "Rome" })),
            ChatStreamEvent::End(StreamEnd {
                captured_stop_reason: Some(StopReason::from("stop".to_owned())),
                // Only captured: emitted at the end so it is not lost.
                captured_content: Some(MessageContent::from_tool_calls(vec![late])),
                ..Default::default()
            }),
        ])
        .await;
        let deltas: Vec<&Value> = frames
            .iter()
            .filter_map(|frame| frame["choices"][0]["delta"]["tool_calls"].get(0))
            .collect();
        assert_eq!(deltas.len(), 5);
        assert_eq!(deltas[0]["index"], 0);
        assert_eq!(deltas[0]["id"], "call_a");
        assert_eq!(deltas[0]["function"]["name"], "get_weather");
        assert_eq!(deltas[1]["index"], 0);
        assert!(deltas[1].get("id").is_none());
        let joined: String = deltas[..3]
            .iter()
            .map(|delta| delta["function"]["arguments"].as_str().unwrap())
            .collect();
        assert_eq!(joined, "{\"city\":\"Paris\"}");
        assert_eq!(deltas[3]["index"], 1);
        assert_eq!(deltas[3]["function"]["arguments"], "{\"city\":\"Rome\"}");
        assert_eq!(deltas[4]["index"], 2);
        assert_eq!(deltas[4]["id"], "call_late");
        let last = frames.last().unwrap();
        assert_eq!(last["choices"][0]["finish_reason"], "tool_calls");
    }

    #[tokio::test]
    async fn stream_reports_length_when_truncated() {
        use ::genai::chat::StreamEnd;
        let frames = stream_frames(vec![
            ChatStreamEvent::Chunk(StreamChunk {
                content: "cut".into(),
            }),
            ChatStreamEvent::End(StreamEnd {
                captured_stop_reason: Some(StopReason::from("MAX_TOKENS".to_owned())),
                ..Default::default()
            }),
        ])
        .await;
        assert_eq!(
            frames.last().unwrap()["choices"][0]["finish_reason"],
            "length"
        );
    }

    #[tokio::test]
    async fn anthropic_stream_cut_off_inside_a_tool_call_finishes_with_length() {
        // A large tool argument hits max_tokens: Anthropic still closes the
        // block, with partial JSON, before reporting the stop reason.
        let sse = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-5\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":5,\"output_tokens\":1}}}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"write_file\",\"input\":{}}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\\\"a.txt\\\",\\\"body\\\":\\\"hel\"}}\n\n",
            "event: content_block_stop\n",
            "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":10}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );
        let server = MockServer::always(MockResponse::ok_bytes(
            "text/event-stream",
            sse.as_bytes().to_vec(),
        ))
        .await;
        let mut provider = GenAiProvider::new_for_kind(
            sdk_provider_by_kind("anthropic").unwrap(),
            vec!["anthropic-key".to_owned()],
            SdkEndpointConfig::Default,
            reqwest::Client::new(),
            None,
            Arc::new(ProviderQuotas::new()),
        )
        .unwrap();
        provider.clients = vec![mock_chat_client(server.base_url(), "anthropic-key")];
        let body = json!({
            "messages": [
                { "role": "user", "content": "write it" },
                // A tool-only turn as the Vercel AI SDK sends it.
                { "role": "assistant", "content": "", "tool_calls": [{
                    "id": "toolu_0", "type": "function",
                    "function": { "name": "write_file", "arguments": "{\"path\":\"b.txt\"}" },
                }]},
                { "role": "tool", "tool_call_id": "toolu_0", "content": "ok" },
            ],
            "tools": [{ "type": "function", "function": { "name": "write_file" } }],
            "max_tokens": 10,
        });
        let body = provider
            .complete_stream_for_session("anthropic::claude-sonnet-4-5", &body, None)
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(body, 1024 * 1024).await.unwrap();
        let output = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(output.ends_with("data: [DONE]\n\n"), "{output}");
        let frames: Vec<Value> = output
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .filter(|data| *data != "[DONE]")
            .map(|data| serde_json::from_str(data).unwrap())
            .collect();
        let arguments: String = frames
            .iter()
            .filter_map(|frame| {
                frame["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"].as_str()
            })
            .collect();
        assert_eq!(arguments, "{\"path\":\"a.txt\",\"body\":\"hel");
        let finish = frames
            .iter()
            .find_map(|frame| frame["choices"][0]["finish_reason"].as_str());
        assert_eq!(finish, Some("length"));

        // The replayed tool-only turn carries no empty text block.
        let sent = server.requests()[0].json();
        let assistant = &sent["messages"][1];
        assert_eq!(assistant["role"], "assistant");
        let blocks = assistant["content"].as_array().unwrap();
        assert!(
            blocks.iter().all(|block| block["type"] != "text"),
            "{blocks:?}"
        );
        assert_eq!(blocks[0]["type"], "tool_use");
    }

    #[tokio::test]
    async fn gemini_chat_sends_tools_and_returns_tool_calls() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","args":{"city":"Paris"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}"#,
        ))
        .await;
        let mut provider = GenAiProvider::image_fixture(
            HashMap::from([("gemini".to_owned(), "first-key".to_owned())]),
            Vec::new(),
            reqwest::Client::new(),
            GEMINI_IMAGE_BASE_URL.to_owned(),
        );
        provider.clients = vec![mock_chat_client(server.base_url(), "first-key")];
        let body = json!({
            "messages": [
                { "role": "user", "content": "weather?" },
                { "role": "assistant", "content": null, "tool_calls": [{
                    "id": "call_a", "type": "function",
                    "function": { "name": "get_weather", "arguments": "{\"city\":\"Oslo\"}" },
                }]},
                { "role": "tool", "tool_call_id": "call_a", "content": "cold" },
            ],
            "tools": weather_tools(),
            "tool_choice": "required",
        });
        let answer = provider
            .complete_for_session("gemini-2.5-flash", &body, None)
            .await
            .unwrap();
        assert_eq!(answer["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(
            answer["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "get_weather"
        );
        let sent = server.requests()[0].json();
        assert_eq!(
            sent["tools"][0]["functionDeclarations"][0]["name"],
            "get_weather"
        );
        assert_eq!(sent["toolConfig"]["functionCallingConfig"]["mode"], "ANY");
        let contents = sent["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 3);
        assert_eq!(
            contents[1]["parts"][0]["functionCall"]["args"],
            json!({ "city": "Oslo" })
        );
        assert_eq!(
            contents[2]["parts"][0]["functionResponse"]["name"],
            "get_weather"
        );
    }
}
