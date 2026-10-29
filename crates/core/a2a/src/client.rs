use std::{collections::HashMap, fmt, net::SocketAddr, time::Duration};

use ed25519_dalek::VerifyingKey;

use futures_util::StreamExt;
use reqwest::{
    header::{
        HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, HOST,
        LOCATION, TRANSFER_ENCODING,
    },
    Method, Response,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::{net::lookup_host, sync::mpsc};
use url::Url;
use uuid::Uuid;

use crate::{
    card_signing::{
        card_signatures, decode_protected_header, ed25519_keys_from_jwks,
        verify_agent_card_signatures, CardSignatureStatus, KeyResolution, MAX_CARD_SIGNATURES,
    },
    protocol::{
        methods, AgentCard, AuthenticationInfo, CancelTaskRequest,
        DeleteTaskPushNotificationConfigRequest, GetExtendedAgentCardRequest,
        GetTaskPushNotificationConfigRequest, GetTaskRequest, JsonRpcId, JsonRpcRequest,
        JsonRpcResponse, ListTaskPushNotificationConfigsRequest,
        ListTaskPushNotificationConfigsResponse, ListTasksRequest, ListTasksResponse,
        SendMessageRequest, SendMessageResponse, StreamResponse, SubscribeToTaskRequest, Task,
        TaskPushNotificationConfig, TRANSPORT_PROTOCOL_HTTP_JSON, TRANSPORT_PROTOCOL_JSONRPC,
        VERSION,
    },
    validate_endpoint, validate_resolved_addresses, EndpointError, EndpointPolicy, PeerCredential,
};

const A2A_MEDIA_TYPE: &str = "application/a2a+json";
const SSE_MEDIA_TYPE: &str = "text/event-stream";
const NOTIFICATION_TOKEN_HEADER: &str = "x-a2a-notification-token";
const MAX_AGENT_CARD_BYTES: usize = 512 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransportBinding {
    JsonRpc,
    HttpJson,
}

impl TransportBinding {
    #[must_use]
    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::JsonRpc => TRANSPORT_PROTOCOL_JSONRPC,
            Self::HttpJson => TRANSPORT_PROTOCOL_HTTP_JSON,
        }
    }
}

#[derive(Clone, Debug)]
pub struct A2aEndpoint {
    pub url: Url,
    pub binding: TransportBinding,
    pub tenant: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ClientLimits {
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
    pub max_response_bytes: usize,
    pub max_sse_event_bytes: usize,
    pub max_redirects: usize,
}

impl Default for ClientLimits {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(10),
            request_timeout: Duration::from_secs(300),
            max_response_bytes: 4 * 1024 * 1024,
            max_sse_event_bytes: 4 * 1024 * 1024,
            max_redirects: 3,
        }
    }
}

#[derive(Debug, Error)]
pub enum ClientError {
    #[error(transparent)]
    InvalidEndpoint(#[from] EndpointError),
    #[error("agent card is invalid: {0}")]
    InvalidAgentCard(String),
    #[error("agent card has no compatible A2A v1 HTTP interface")]
    NoCompatibleInterface,
    #[error("A2A request failed")]
    Transport,
    #[error("A2A response exceeded the configured size limit")]
    ResponseTooLarge,
    #[error("A2A stream event exceeded the configured size limit")]
    EventTooLarge,
    #[error("A2A peer returned HTTP status {status}: {detail}")]
    HttpStatus { status: u16, detail: String },
    #[error("A2A peer returned an unsupported content type")]
    InvalidContentType,
    #[error("A2A redirect crossed origins")]
    CrossOriginRedirect,
    #[error("A2A peer returned too many redirects")]
    TooManyRedirects,
    #[error("A2A protocol response is invalid: {0}")]
    InvalidProtocol(String),
    #[error("A2A JSON-RPC error {code}: {message}")]
    JsonRpc { code: i32, message: String },
    #[error("A2A authentication configuration is invalid")]
    InvalidCredential,
}

#[derive(Clone)]
pub struct A2aClient {
    endpoint: A2aEndpoint,
    credential: PeerCredential,
    endpoint_policy: EndpointPolicy,
    limits: ClientLimits,
    extensions: Vec<String>,
}

impl fmt::Debug for A2aClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("A2aClient")
            .field("endpoint", &self.endpoint)
            .field("credential", &"[REDACTED]")
            .field("endpoint_policy", &self.endpoint_policy)
            .field("limits", &self.limits)
            .field("extensions", &self.extensions)
            .finish()
    }
}

impl A2aClient {
    #[must_use]
    pub fn new(
        endpoint: A2aEndpoint,
        credential: PeerCredential,
        endpoint_policy: EndpointPolicy,
        limits: ClientLimits,
    ) -> Self {
        Self {
            endpoint,
            credential,
            endpoint_policy,
            limits,
            extensions: Vec::new(),
        }
    }

    #[must_use]
    pub fn with_extensions(mut self, extensions: Vec<String>) -> Self {
        self.extensions = extensions;
        self
    }

    pub async fn send_message(
        &self,
        request: &SendMessageRequest,
    ) -> Result<SendMessageResponse, ClientError> {
        self.call_json(
            methods::SEND_MESSAGE,
            RestCall::post(&["message:send"], Some(request))?,
            request,
        )
        .await
    }

    pub async fn send_streaming_message(
        &self,
        request: &SendMessageRequest,
    ) -> Result<mpsc::Receiver<Result<StreamResponse, ClientError>>, ClientError> {
        self.call_stream(
            methods::SEND_STREAMING_MESSAGE,
            RestCall::post(&["message:stream"], Some(request))?,
            request,
        )
        .await
    }

    pub async fn get_task(&self, request: &GetTaskRequest) -> Result<Task, ClientError> {
        let mut rest = RestCall::get(&["tasks", &request.id]);
        if let Some(history_length) = request.history_length {
            rest.query
                .push(("historyLength".to_owned(), history_length.to_string()));
        }
        self.call_json(methods::GET_TASK, rest, request).await
    }

    pub async fn list_tasks(
        &self,
        request: &ListTasksRequest,
    ) -> Result<ListTasksResponse, ClientError> {
        let mut rest = RestCall::get(&["tasks"]);
        if let Some(context_id) = &request.context_id {
            rest.query
                .push(("contextId".to_owned(), context_id.clone()));
        }
        if let Some(status) = &request.status {
            let value = serde_json::to_value(status).map_err(protocol_error)?;
            let encoded = value
                .as_str()
                .ok_or_else(|| ClientError::InvalidProtocol("invalid task state".to_owned()))?;
            rest.query.push(("status".to_owned(), encoded.to_owned()));
        }
        if let Some(page_size) = request.page_size {
            rest.query
                .push(("pageSize".to_owned(), page_size.to_string()));
        }
        if let Some(page_token) = &request.page_token {
            rest.query
                .push(("pageToken".to_owned(), page_token.clone()));
        }
        if let Some(history_length) = request.history_length {
            rest.query
                .push(("historyLength".to_owned(), history_length.to_string()));
        }
        if let Some(timestamp) = request.status_timestamp_after {
            rest.query
                .push(("statusTimestampAfter".to_owned(), timestamp.to_rfc3339()));
        }
        if let Some(include_artifacts) = request.include_artifacts {
            rest.query
                .push(("includeArtifacts".to_owned(), include_artifacts.to_string()));
        }
        self.call_json(methods::LIST_TASKS, rest, request).await
    }

    pub async fn cancel_task(&self, request: &CancelTaskRequest) -> Result<Task, ClientError> {
        self.call_json(
            methods::CANCEL_TASK,
            RestCall::post::<Value>(&["tasks", &format!("{}:cancel", request.id)], None)?,
            request,
        )
        .await
    }

    pub async fn subscribe_to_task(
        &self,
        request: &SubscribeToTaskRequest,
    ) -> Result<mpsc::Receiver<Result<StreamResponse, ClientError>>, ClientError> {
        self.call_stream(
            methods::SUBSCRIBE_TO_TASK,
            RestCall::post::<Value>(&["tasks", &format!("{}:subscribe", request.id)], None)?,
            request,
        )
        .await
    }

    pub async fn create_push_config(
        &self,
        config: &TaskPushNotificationConfig,
    ) -> Result<TaskPushNotificationConfig, ClientError> {
        self.call_json(
            methods::CREATE_PUSH_CONFIG,
            RestCall::post(
                &["tasks", &config.task_id, "pushNotificationConfigs"],
                Some(config),
            )?,
            config,
        )
        .await
    }

    pub async fn get_push_config(
        &self,
        request: &GetTaskPushNotificationConfigRequest,
    ) -> Result<TaskPushNotificationConfig, ClientError> {
        self.call_json(
            methods::GET_PUSH_CONFIG,
            RestCall::get(&[
                "tasks",
                &request.task_id,
                "pushNotificationConfigs",
                &request.id,
            ]),
            request,
        )
        .await
    }

    pub async fn list_push_configs(
        &self,
        request: &ListTaskPushNotificationConfigsRequest,
    ) -> Result<ListTaskPushNotificationConfigsResponse, ClientError> {
        let mut rest = RestCall::get(&["tasks", &request.task_id, "pushNotificationConfigs"]);
        if let Some(page_size) = request.page_size {
            rest.query
                .push(("pageSize".to_owned(), page_size.to_string()));
        }
        if let Some(page_token) = &request.page_token {
            rest.query
                .push(("pageToken".to_owned(), page_token.clone()));
        }
        self.call_json(methods::LIST_PUSH_CONFIGS, rest, request)
            .await
    }

    pub async fn delete_push_config(
        &self,
        request: &DeleteTaskPushNotificationConfigRequest,
    ) -> Result<(), ClientError> {
        let rest = RestCall::delete(&[
            "tasks",
            &request.task_id,
            "pushNotificationConfigs",
            &request.id,
        ]);
        match self.endpoint.binding {
            TransportBinding::JsonRpc => {
                let _: Value = self
                    .call_json(methods::DELETE_PUSH_CONFIG, rest, request)
                    .await?;
            }
            TransportBinding::HttpJson => {
                let url = rest.url(&self.endpoint.url)?;
                let response = self
                    .send_with_redirects(rest.method, url, None, A2A_MEDIA_TYPE)
                    .await?;
                ensure_success(response, &self.limits).await?;
            }
        }
        Ok(())
    }

    pub async fn get_extended_agent_card(
        &self,
        request: &GetExtendedAgentCardRequest,
    ) -> Result<AgentCard, ClientError> {
        self.call_json(
            methods::GET_EXTENDED_AGENT_CARD,
            RestCall::get(&["extendedAgentCard"]),
            request,
        )
        .await
    }

    async fn call_json<Request, Output>(
        &self,
        rpc_method: &str,
        rest: RestCall,
        request: &Request,
    ) -> Result<Output, ClientError>
    where
        Request: Serialize + ?Sized,
        Output: DeserializeOwned,
    {
        let (method, url, body) = match self.endpoint.binding {
            TransportBinding::JsonRpc => {
                let id = JsonRpcId::String(Uuid::new_v4().to_string());
                let params = serde_json::to_value(request).map_err(protocol_error)?;
                let envelope = JsonRpcRequest::new(id.clone(), rpc_method, Some(params));
                let body = serde_json::to_vec(&envelope).map_err(protocol_error)?;
                let response = self
                    .send_with_redirects(
                        Method::POST,
                        self.endpoint.url.clone(),
                        Some(body),
                        A2A_MEDIA_TYPE,
                    )
                    .await?;
                let bytes = ensure_success(response, &self.limits).await?;
                let envelope: JsonRpcResponse =
                    serde_json::from_slice(&bytes).map_err(protocol_error)?;
                if envelope.jsonrpc != "2.0" || envelope.id != id {
                    return Err(ClientError::InvalidProtocol(
                        "JSON-RPC version or response ID mismatch".to_owned(),
                    ));
                }
                if let Some(error) = envelope.error {
                    return Err(ClientError::JsonRpc {
                        code: error.code,
                        message: truncate_detail(&error.message),
                    });
                }
                let result = envelope.result.ok_or_else(|| {
                    ClientError::InvalidProtocol("JSON-RPC result is missing".to_owned())
                })?;
                return serde_json::from_value(result).map_err(protocol_error);
            }
            TransportBinding::HttpJson => {
                let url = rest.url(&self.endpoint.url)?;
                (rest.method, url, rest.body)
            }
        };
        let response = self
            .send_with_redirects(method, url, body, A2A_MEDIA_TYPE)
            .await?;
        let bytes = ensure_success(response, &self.limits).await?;
        serde_json::from_slice(&bytes).map_err(protocol_error)
    }

    async fn call_stream<Request>(
        &self,
        rpc_method: &str,
        rest: RestCall,
        request: &Request,
    ) -> Result<mpsc::Receiver<Result<StreamResponse, ClientError>>, ClientError>
    where
        Request: Serialize + ?Sized,
    {
        let (method, url, body) = match self.endpoint.binding {
            TransportBinding::JsonRpc => {
                let params = serde_json::to_value(request).map_err(protocol_error)?;
                let envelope = JsonRpcRequest::new(
                    JsonRpcId::String(Uuid::new_v4().to_string()),
                    rpc_method,
                    Some(params),
                );
                (
                    Method::POST,
                    self.endpoint.url.clone(),
                    Some(serde_json::to_vec(&envelope).map_err(protocol_error)?),
                )
            }
            TransportBinding::HttpJson => {
                let url = rest.url(&self.endpoint.url)?;
                (rest.method, url, rest.body)
            }
        };
        let response = self
            .send_with_redirects(method, url, body, SSE_MEDIA_TYPE)
            .await?;
        if !response.status().is_success() {
            return Err(http_error(response, &self.limits).await);
        }
        let is_sse = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.to_ascii_lowercase().starts_with(SSE_MEDIA_TYPE));
        if !is_sse {
            return Err(ClientError::InvalidContentType);
        }
        Ok(spawn_sse_reader(
            response,
            self.endpoint.binding,
            self.limits.max_sse_event_bytes,
        ))
    }

    async fn send_with_redirects(
        &self,
        method: Method,
        url: Url,
        body: Option<Vec<u8>>,
        accept: &'static str,
    ) -> Result<Response, ClientError> {
        validate_endpoint(url.as_str(), self.endpoint_policy)?;
        let origin = Origin::from_url(&url)?;
        let auth = self.resolve_auth().await?;
        let mut current = url;
        for redirect_count in 0..=self.limits.max_redirects {
            let client = pinned_client(&current, self.endpoint_policy, &self.limits).await?;
            let mut builder = client
                .request(method.clone(), current.clone())
                .header("A2A-Version", VERSION)
                .header(ACCEPT, accept);
            if !self.extensions.is_empty() {
                builder = builder.header("A2A-Extensions", self.extensions.join(","));
            }
            if let Some(body) = &body {
                builder = builder
                    .header(CONTENT_TYPE, A2A_MEDIA_TYPE)
                    .body(body.clone());
            }
            builder = apply_auth(builder, &auth)?;
            let response = builder.send().await.map_err(|_| ClientError::Transport)?;
            if !response.status().is_redirection() {
                return Ok(response);
            }
            if redirect_count == self.limits.max_redirects {
                return Err(ClientError::TooManyRedirects);
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| {
                    ClientError::InvalidProtocol("redirect location is missing".to_owned())
                })?;
            let next = current
                .join(location)
                .map_err(|_| ClientError::InvalidProtocol("redirect URL is invalid".to_owned()))?;
            validate_endpoint(next.as_str(), self.endpoint_policy)?;
            if Origin::from_url(&next)? != origin {
                return Err(ClientError::CrossOriginRedirect);
            }
            current = next;
        }
        Err(ClientError::TooManyRedirects)
    }

    async fn resolve_auth(&self) -> Result<ResolvedAuth, ClientError> {
        resolve_credential_auth(&self.credential, self.endpoint_policy, &self.limits).await
    }
}

async fn resolve_credential_auth(
    credential: &PeerCredential,
    endpoint_policy: EndpointPolicy,
    limits: &ClientLimits,
) -> Result<ResolvedAuth, ClientError> {
    match credential {
        PeerCredential::None => Ok(ResolvedAuth::None),
        PeerCredential::Bearer { token } => Ok(ResolvedAuth::Bearer(token.clone())),
        PeerCredential::ApiKey { header, value } => {
            let name = HeaderName::from_bytes(header.as_bytes())
                .map_err(|_| ClientError::InvalidCredential)?;
            if matches!(name, HOST | CONTENT_LENGTH | TRANSFER_ENCODING) {
                return Err(ClientError::InvalidCredential);
            }
            Ok(ResolvedAuth::Header(name, value.clone()))
        }
        PeerCredential::Basic { username, password } => Ok(ResolvedAuth::Basic {
            username: username.clone(),
            password: password.clone(),
        }),
        PeerCredential::OAuth2ClientCredentials {
            token_url,
            client_id,
            client_secret,
            scopes,
        } => {
            let token_url = validate_endpoint(token_url, endpoint_policy)?;
            let client = pinned_client(&token_url, endpoint_policy, limits).await?;
            // `form_urlencoded::Serializer` contains a non-`Sync` callback
            // reference. Finish it in a synchronous scope so no serializer
            // state is retained across the network await (Axum requires
            // handler futures to be `Send`).
            let form = {
                let mut serializer = url::form_urlencoded::Serializer::new(String::new());
                serializer.append_pair("grant_type", "client_credentials");
                if !scopes.is_empty() {
                    serializer.append_pair("scope", &scopes.join(" "));
                }
                serializer.finish()
            };
            let response = client
                .post(token_url)
                .basic_auth(client_id, Some(client_secret))
                .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
                .header(ACCEPT, "application/json")
                .body(form)
                .send()
                .await
                .map_err(|_| ClientError::Transport)?;
            let bytes = ensure_success(response, limits).await?;
            let token: OAuthTokenResponse =
                serde_json::from_slice(&bytes).map_err(protocol_error)?;
            if token.access_token.is_empty()
                || token
                    .token_type
                    .as_deref()
                    .is_some_and(|value| !value.eq_ignore_ascii_case("bearer"))
            {
                return Err(ClientError::InvalidCredential);
            }
            Ok(ResolvedAuth::Bearer(token.access_token))
        }
    }
}

/// Deliver one A2A v1 push-notification payload to a client-owned webhook.
///
/// The callback receives the same [`StreamResponse`] union used by streaming
/// methods. DNS answers are pinned for the request, redirects must remain on the
/// original origin, and both callback and OAuth token endpoints pass the same
/// SSRF policy as ordinary peer calls.
pub async fn deliver_push_notification(
    callback_url: &str,
    authentication: Option<&AuthenticationInfo>,
    notification_token: Option<&str>,
    payload: &StreamResponse,
    endpoint_policy: EndpointPolicy,
    limits: &ClientLimits,
) -> Result<(), ClientError> {
    let mut current = validate_endpoint(callback_url, endpoint_policy)?;
    let origin = Origin::from_url(&current)?;
    let body = serde_json::to_vec(payload).map_err(protocol_error)?;

    for redirect_count in 0..=limits.max_redirects {
        let client = pinned_client(&current, endpoint_policy, limits).await?;
        let mut builder = client
            .post(current.clone())
            .header("A2A-Version", VERSION)
            .header(ACCEPT, A2A_MEDIA_TYPE)
            .header(CONTENT_TYPE, A2A_MEDIA_TYPE)
            .body(body.clone());
        if let Some(token) = notification_token {
            let mut value =
                HeaderValue::from_str(token).map_err(|_| ClientError::InvalidCredential)?;
            value.set_sensitive(true);
            builder = builder.header(NOTIFICATION_TOKEN_HEADER, value);
        }
        builder = apply_push_auth(builder, authentication)?;
        let response = builder.send().await.map_err(|_| ClientError::Transport)?;
        if !response.status().is_redirection() {
            ensure_success(response, limits).await?;
            return Ok(());
        }
        if redirect_count == limits.max_redirects {
            return Err(ClientError::TooManyRedirects);
        }
        let location = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| {
                ClientError::InvalidProtocol("redirect location is missing".to_owned())
            })?;
        let next = current
            .join(location)
            .map_err(|_| ClientError::InvalidProtocol("redirect URL is invalid".to_owned()))?;
        validate_endpoint(next.as_str(), endpoint_policy)?;
        if Origin::from_url(&next)? != origin {
            return Err(ClientError::CrossOriginRedirect);
        }
        current = next;
    }
    Err(ClientError::TooManyRedirects)
}

#[derive(Deserialize)]
struct OAuthTokenResponse {
    access_token: String,
    token_type: Option<String>,
}

enum ResolvedAuth {
    None,
    Bearer(String),
    Header(HeaderName, String),
    Basic { username: String, password: String },
}

fn apply_auth(
    builder: reqwest::RequestBuilder,
    auth: &ResolvedAuth,
) -> Result<reqwest::RequestBuilder, ClientError> {
    match auth {
        ResolvedAuth::None => Ok(builder),
        ResolvedAuth::Bearer(token) => {
            let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| ClientError::InvalidCredential)?;
            value.set_sensitive(true);
            Ok(builder.header(AUTHORIZATION, value))
        }
        ResolvedAuth::Header(name, value) => {
            let mut value =
                HeaderValue::from_str(value).map_err(|_| ClientError::InvalidCredential)?;
            value.set_sensitive(true);
            Ok(builder.header(name, value))
        }
        ResolvedAuth::Basic { username, password } => {
            Ok(builder.basic_auth(username, Some(password)))
        }
    }
}

fn apply_push_auth(
    builder: reqwest::RequestBuilder,
    authentication: Option<&AuthenticationInfo>,
) -> Result<reqwest::RequestBuilder, ClientError> {
    match push_authorization_value(authentication)? {
        Some(value) => Ok(builder.header(AUTHORIZATION, value)),
        None => Ok(builder),
    }
}

/// Validate the static HTTP authorization description used by an A2A push
/// callback without exposing or transmitting its credentials.
pub fn validate_push_authentication(
    authentication: Option<&AuthenticationInfo>,
) -> Result<(), ClientError> {
    push_authorization_value(authentication).map(|_| ())
}

fn push_authorization_value(
    authentication: Option<&AuthenticationInfo>,
) -> Result<Option<HeaderValue>, ClientError> {
    let Some(authentication) = authentication else {
        return Ok(None);
    };
    let scheme = authentication.scheme.trim();
    let credentials = authentication
        .credentials
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or(ClientError::InvalidCredential)?;
    if scheme.is_empty()
        || scheme.len() > 64
        || !scheme.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
    {
        return Err(ClientError::InvalidCredential);
    }
    let mut value = HeaderValue::from_str(&format!("{scheme} {credentials}"))
        .map_err(|_| ClientError::InvalidCredential)?;
    value.set_sensitive(true);
    Ok(Some(value))
}

/// A remote Agent Card plus the outcome of checking its `signatures`.
#[derive(Clone, Debug)]
pub struct DiscoveredAgentCard {
    pub card: AgentCard,
    /// The card JSON exactly as received (signatures are verified over it).
    pub raw: Value,
    pub signature: CardSignatureStatus,
}

pub async fn discover_agent_card(
    card_or_base_url: &str,
    endpoint_policy: EndpointPolicy,
    limits: ClientLimits,
) -> Result<AgentCard, ClientError> {
    discover_verified_agent_card(card_or_base_url, endpoint_policy, limits, false)
        .await
        .map(|discovered| discovered.card)
}

/// Fetch, validate, and signature-check a remote Agent Card.
///
/// A card with a signature that is malformed, names a key its JWKS does not
/// publish, or does not match the card content is rejected. An unsigned card,
/// or one whose key cannot be fetched, is accepted with that status unless
/// `require_verified_signature` is set.
pub async fn discover_verified_agent_card(
    card_or_base_url: &str,
    endpoint_policy: EndpointPolicy,
    limits: ClientLimits,
    require_verified_signature: bool,
) -> Result<DiscoveredAgentCard, ClientError> {
    let mut current = validate_endpoint(card_or_base_url, endpoint_policy)?;
    if !current.path().ends_with(".json") {
        current.set_path("/.well-known/agent-card.json");
        current.set_query(None);
        current.set_fragment(None);
    }
    let origin = Origin::from_url(&current)?;
    let mut final_response = None;
    for redirect_count in 0..=limits.max_redirects {
        let client = pinned_client(&current, endpoint_policy, &limits).await?;
        let response = client
            .get(current.clone())
            .header(ACCEPT, A2A_MEDIA_TYPE)
            .send()
            .await
            .map_err(|_| ClientError::Transport)?;
        if !response.status().is_redirection() {
            final_response = Some(response);
            break;
        }
        if redirect_count == limits.max_redirects {
            return Err(ClientError::TooManyRedirects);
        }
        let location = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| {
                ClientError::InvalidProtocol("redirect location is missing".to_owned())
            })?;
        let next = current
            .join(location)
            .map_err(|_| ClientError::InvalidProtocol("redirect URL is invalid".to_owned()))?;
        validate_endpoint(next.as_str(), endpoint_policy)?;
        if Origin::from_url(&next)? != origin {
            return Err(ClientError::CrossOriginRedirect);
        }
        current = next;
    }
    let response = final_response.ok_or(ClientError::TooManyRedirects)?;
    let mut card_limits = limits.clone();
    card_limits.max_response_bytes = card_limits.max_response_bytes.min(MAX_AGENT_CARD_BYTES);
    let bytes = ensure_success(response, &card_limits).await?;
    let raw: Value = serde_json::from_slice(&bytes).map_err(protocol_error)?;
    let card: AgentCard = serde_json::from_value(raw.clone()).map_err(protocol_error)?;
    validate_agent_card(&card, endpoint_policy)?;
    let signature = check_card_signatures(&raw, &origin, endpoint_policy, &limits).await;
    if let CardSignatureStatus::Invalid { reason } = &signature {
        return Err(ClientError::InvalidAgentCard(format!(
            "signature verification failed: {reason}"
        )));
    }
    if require_verified_signature && !signature.is_verified() {
        return Err(ClientError::InvalidAgentCard(
            "a verified Agent Card signature is required".to_owned(),
        ));
    }
    Ok(DiscoveredAgentCard {
        card,
        raw,
        signature,
    })
}

/// Distinct JWKS URLs fetched per card. Ryu's own cards name one.
const MAX_CARD_JWKS_FETCHES: usize = 2;
const MAX_JWKS_BYTES: usize = 64 * 1024;

/// Resolve each signature's `jku` and verify the card.
///
/// A `jku` is honoured only on the card's own origin: the HTTPS origin that
/// served the card is the authority the key is bound to, so a signature cannot
/// borrow trust from a key set hosted elsewhere.
async fn check_card_signatures(
    raw: &Value,
    card_origin: &Origin,
    endpoint_policy: EndpointPolicy,
    limits: &ClientLimits,
) -> CardSignatureStatus {
    let Ok(signatures) = card_signatures(raw) else {
        return verify_agent_card_signatures(raw, |_| KeyResolution::NotPublished);
    };
    let mut key_sets: HashMap<String, Result<Vec<(String, VerifyingKey)>, String>> = HashMap::new();
    for entry in signatures.iter().take(MAX_CARD_SIGNATURES) {
        let Some(jku) = decode_protected_header(entry).and_then(|header| header.jku) else {
            continue;
        };
        if key_sets.contains_key(&jku) || key_sets.len() >= MAX_CARD_JWKS_FETCHES {
            continue;
        }
        let keys = fetch_card_jwks(&jku, card_origin, endpoint_policy, limits).await;
        key_sets.insert(jku, keys);
    }
    verify_agent_card_signatures(raw, |header| {
        let Some(jku) = header.jku.as_deref() else {
            return KeyResolution::Unavailable(
                "signature names no jku and no trusted key is configured".to_owned(),
            );
        };
        match key_sets.get(jku) {
            None => KeyResolution::Unavailable("signature key set was not fetched".to_owned()),
            Some(Err(reason)) => KeyResolution::Unavailable(reason.clone()),
            Some(Ok(keys)) => header
                .kid
                .as_deref()
                .and_then(|kid| keys.iter().find(|(candidate, _)| candidate == kid))
                .map_or(KeyResolution::NotPublished, |(_, key)| {
                    KeyResolution::Found(*key)
                }),
        }
    })
}

async fn fetch_card_jwks(
    jku: &str,
    card_origin: &Origin,
    endpoint_policy: EndpointPolicy,
    limits: &ClientLimits,
) -> Result<Vec<(String, VerifyingKey)>, String> {
    let url = validate_endpoint(jku, endpoint_policy)
        .map_err(|_| "signature jku is not an allowed URL".to_owned())?;
    if Origin::from_url(&url).ok().as_ref() != Some(card_origin) {
        return Err("signature jku is not on the Agent Card's origin".to_owned());
    }
    let unavailable = || "signature key set could not be fetched".to_owned();
    let client = pinned_client(&url, endpoint_policy, limits)
        .await
        .map_err(|_| unavailable())?;
    let response = client
        .get(url)
        .header(ACCEPT, "application/jwk-set+json, application/json")
        .send()
        .await
        .map_err(|_| unavailable())?;
    if !response.status().is_success() {
        return Err(unavailable());
    }
    let bytes = read_bounded(response, MAX_JWKS_BYTES)
        .await
        .map_err(|_| unavailable())?;
    let jwks: Value =
        serde_json::from_slice(&bytes).map_err(|_| "signature key set is not JSON".to_owned())?;
    Ok(ed25519_keys_from_jwks(&jwks))
}

pub fn validate_agent_card(
    card: &AgentCard,
    endpoint_policy: EndpointPolicy,
) -> Result<(), ClientError> {
    if card.name.trim().is_empty() || card.name.len() > 160 {
        return Err(ClientError::InvalidAgentCard(
            "name must contain 1 to 160 bytes".to_owned(),
        ));
    }
    if card.description.len() > 4_000 {
        return Err(ClientError::InvalidAgentCard(
            "description exceeds 4000 bytes".to_owned(),
        ));
    }
    if card.supported_interfaces.is_empty() || card.supported_interfaces.len() > 16 {
        return Err(ClientError::InvalidAgentCard(
            "supportedInterfaces must contain 1 to 16 entries".to_owned(),
        ));
    }
    if card.skills.len() > 256 {
        return Err(ClientError::InvalidAgentCard(
            "agent card advertises too many skills".to_owned(),
        ));
    }
    for interface in &card.supported_interfaces {
        if matches!(
            interface.protocol_binding.as_str(),
            TRANSPORT_PROTOCOL_JSONRPC | TRANSPORT_PROTOCOL_HTTP_JSON
        ) {
            if interface.protocol_version != VERSION {
                continue;
            }
            validate_endpoint(&interface.url, endpoint_policy)?;
        }
    }
    Ok(())
}

pub fn select_endpoint(
    card: &AgentCard,
    endpoint_policy: EndpointPolicy,
    preference: &[TransportBinding],
) -> Result<A2aEndpoint, ClientError> {
    validate_agent_card(card, endpoint_policy)?;
    let preference = if preference.is_empty() {
        &[TransportBinding::JsonRpc, TransportBinding::HttpJson][..]
    } else {
        preference
    };
    for binding in preference {
        if let Some(interface) = card.supported_interfaces.iter().find(|interface| {
            interface
                .protocol_binding
                .eq_ignore_ascii_case(binding.wire_name())
                && interface.protocol_version == VERSION
        }) {
            return Ok(A2aEndpoint {
                url: validate_endpoint(&interface.url, endpoint_policy)?,
                binding: *binding,
                tenant: interface.tenant.clone(),
            });
        }
    }
    Err(ClientError::NoCompatibleInterface)
}

#[derive(Debug)]
struct RestCall {
    method: Method,
    segments: Vec<String>,
    query: Vec<(String, String)>,
    body: Option<Vec<u8>>,
}

impl RestCall {
    fn get(segments: &[&str]) -> Self {
        Self {
            method: Method::GET,
            segments: segments.iter().map(ToString::to_string).collect(),
            query: Vec::new(),
            body: None,
        }
    }

    fn post<T: Serialize + ?Sized>(
        segments: &[&str],
        body: Option<&T>,
    ) -> Result<Self, ClientError> {
        Ok(Self {
            method: Method::POST,
            segments: segments.iter().map(ToString::to_string).collect(),
            query: Vec::new(),
            body: body
                .map(serde_json::to_vec)
                .transpose()
                .map_err(protocol_error)?,
        })
    }

    fn delete(segments: &[&str]) -> Self {
        Self {
            method: Method::DELETE,
            segments: segments.iter().map(ToString::to_string).collect(),
            query: Vec::new(),
            body: None,
        }
    }

    fn url(&self, base: &Url) -> Result<Url, ClientError> {
        let mut url = base.clone();
        {
            let mut path = url.path_segments_mut().map_err(|_| {
                ClientError::InvalidProtocol("HTTP+JSON base URL cannot be a base".to_owned())
            })?;
            path.pop_if_empty();
            for segment in &self.segments {
                path.push(segment);
            }
        }
        if !self.query.is_empty() {
            let mut query = url.query_pairs_mut();
            query.clear();
            for (key, value) in &self.query {
                query.append_pair(key, value);
            }
        }
        Ok(url)
    }
}

#[derive(Eq, PartialEq)]
struct Origin {
    scheme: String,
    host: String,
    port: u16,
}

impl Origin {
    fn from_url(url: &Url) -> Result<Self, ClientError> {
        Ok(Self {
            scheme: url.scheme().to_owned(),
            host: url
                .host_str()
                .ok_or(EndpointError::MissingHost)?
                .to_ascii_lowercase(),
            port: url
                .port_or_known_default()
                .ok_or(EndpointError::InvalidUrl)?,
        })
    }
}

async fn pinned_client(
    url: &Url,
    endpoint_policy: EndpointPolicy,
    limits: &ClientLimits,
) -> Result<reqwest::Client, ClientError> {
    validate_endpoint(url.as_str(), endpoint_policy)?;
    let host = url.host_str().ok_or(EndpointError::MissingHost)?;
    let port = url
        .port_or_known_default()
        .ok_or(EndpointError::InvalidUrl)?;
    let addresses: Vec<SocketAddr> = lookup_host((host, port))
        .await
        .map_err(|_| ClientError::Transport)?
        .collect();
    let ips = addresses.iter().map(SocketAddr::ip).collect::<Vec<_>>();
    validate_resolved_addresses(&ips, endpoint_policy)?;
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(limits.connect_timeout)
        .timeout(limits.request_timeout);
    if url
        .host()
        .is_some_and(|host| matches!(host, url::Host::Domain(_)))
    {
        builder = builder.resolve_to_addrs(host, &addresses);
    }
    builder.build().map_err(|_| ClientError::Transport)
}

async fn ensure_success(response: Response, limits: &ClientLimits) -> Result<Vec<u8>, ClientError> {
    if !response.status().is_success() {
        return Err(http_error(response, limits).await);
    }
    read_bounded(response, limits.max_response_bytes).await
}

async fn http_error(response: Response, limits: &ClientLimits) -> ClientError {
    let status = response.status().as_u16();
    let detail = read_bounded(response, limits.max_response_bytes.min(4_096))
        .await
        .ok()
        .and_then(|body| String::from_utf8(body).ok())
        .map_or_else(
            || "request failed".to_owned(),
            |value| truncate_detail(&value),
        );
    ClientError::HttpStatus { status, detail }
}

async fn read_bounded(response: Response, max_bytes: usize) -> Result<Vec<u8>, ClientError> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(ClientError::ResponseTooLarge);
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ClientError::Transport)?;
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(ClientError::ResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn spawn_sse_reader(
    response: Response,
    binding: TransportBinding,
    max_event_bytes: usize,
) -> mpsc::Receiver<Result<StreamResponse, ClientError>> {
    let (sender, receiver) = mpsc::channel(32);
    tokio::spawn(async move {
        let mut stream = response.bytes_stream();
        let mut decoder = SseDecoder::new(max_event_bytes);
        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(_) => {
                    let _ = sender.send(Err(ClientError::Transport)).await;
                    return;
                }
            };
            let events = match decoder.push(&chunk) {
                Ok(events) => events,
                Err(error) => {
                    let _ = sender.send(Err(error)).await;
                    return;
                }
            };
            for event in events {
                if sender
                    .send(parse_stream_event(&event, binding))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }
        match decoder.finish() {
            Ok(events) => {
                for event in events {
                    if sender
                        .send(parse_stream_event(&event, binding))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            }
            Err(error) => {
                let _ = sender.send(Err(error)).await;
            }
        }
    });
    receiver
}

fn parse_stream_event(
    data: &str,
    binding: TransportBinding,
) -> Result<StreamResponse, ClientError> {
    if binding == TransportBinding::HttpJson {
        return serde_json::from_str(data).map_err(protocol_error);
    }
    let response: JsonRpcResponse = serde_json::from_str(data).map_err(protocol_error)?;
    if response.jsonrpc != "2.0" {
        return Err(ClientError::InvalidProtocol(
            "invalid JSON-RPC version in stream".to_owned(),
        ));
    }
    if let Some(error) = response.error {
        return Err(ClientError::JsonRpc {
            code: error.code,
            message: truncate_detail(&error.message),
        });
    }
    let result = response.result.ok_or_else(|| {
        ClientError::InvalidProtocol("JSON-RPC stream result is missing".to_owned())
    })?;
    serde_json::from_value(result).map_err(protocol_error)
}

struct SseDecoder {
    pending: Vec<u8>,
    data_lines: Vec<String>,
    event_bytes: usize,
    max_event_bytes: usize,
}

impl SseDecoder {
    fn new(max_event_bytes: usize) -> Self {
        Self {
            pending: Vec::new(),
            data_lines: Vec::new(),
            event_bytes: 0,
            max_event_bytes,
        }
    }

    fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, ClientError> {
        let mut events = Vec::new();
        let mut start = 0;
        for (index, byte) in chunk.iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }
            self.pending.extend_from_slice(&chunk[start..index]);
            if self.pending.len() > self.max_event_bytes.saturating_add(1_024) {
                return Err(ClientError::EventTooLarge);
            }
            let mut line = std::mem::take(&mut self.pending);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.process_line(&line, &mut events)?;
            start = index + 1;
        }
        self.pending.extend_from_slice(&chunk[start..]);
        if self.pending.len() > self.max_event_bytes.saturating_add(1_024) {
            return Err(ClientError::EventTooLarge);
        }
        Ok(events)
    }

    fn finish(&mut self) -> Result<Vec<String>, ClientError> {
        let mut events = Vec::new();
        if !self.pending.is_empty() {
            let line = std::mem::take(&mut self.pending);
            self.process_line(&line, &mut events)?;
        }
        self.dispatch(&mut events);
        Ok(events)
    }

    fn process_line(&mut self, line: &[u8], events: &mut Vec<String>) -> Result<(), ClientError> {
        if line.is_empty() {
            self.dispatch(events);
            return Ok(());
        }
        if line.starts_with(b":") {
            return Ok(());
        }
        if let Some(data) = line.strip_prefix(b"data:") {
            let data = data.strip_prefix(b" ").unwrap_or(data);
            self.event_bytes = self.event_bytes.saturating_add(data.len());
            if self.event_bytes > self.max_event_bytes {
                return Err(ClientError::EventTooLarge);
            }
            self.data_lines.push(
                String::from_utf8(data.to_vec()).map_err(|_| {
                    ClientError::InvalidProtocol("SSE data is not UTF-8".to_owned())
                })?,
            );
        }
        Ok(())
    }

    fn dispatch(&mut self, events: &mut Vec<String>) {
        if !self.data_lines.is_empty() {
            events.push(self.data_lines.join("\n"));
            self.data_lines.clear();
        }
        self.event_bytes = 0;
    }
}

fn protocol_error(error: impl fmt::Display) -> ClientError {
    ClientError::InvalidProtocol(truncate_detail(&error.to_string()))
}

fn truncate_detail(value: &str) -> String {
    let mut detail = value.chars().take(500).collect::<String>();
    if value.chars().count() > 500 {
        detail.push('…');
    }
    detail
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    use crate::protocol::{AgentCapabilities, AgentInterface, Message, Part, Role, TaskState};

    use super::*;

    fn card(interfaces: Vec<AgentInterface>) -> AgentCard {
        AgentCard {
            name: "Reference agent".to_owned(),
            description: "A test peer".to_owned(),
            version: "1.0.0".to_owned(),
            supported_interfaces: interfaces,
            capabilities: AgentCapabilities {
                streaming: Some(true),
                push_notifications: Some(true),
                extensions: None,
                extended_agent_card: Some(true),
            },
            default_input_modes: vec!["text/plain".to_owned()],
            default_output_modes: vec!["text/plain".to_owned()],
            skills: Vec::new(),
            provider: None,
            documentation_url: None,
            icon_url: None,
            security_schemes: None,
            security_requirements: None,
            signatures: None,
        }
    }

    #[tokio::test]
    async fn agent_card_discovery_follows_bounded_same_origin_redirects() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind reference server");
        let address = listener.local_addr().expect("reference address");
        let body = serde_json::to_string(&card(vec![AgentInterface::new(
            "https://peer.example.com/a2a",
            TRANSPORT_PROTOCOL_JSONRPC,
        )]))
        .expect("serialize Agent Card");
        let server = thread::spawn(move || {
            for response in [
                "HTTP/1.1 302 Found\r\nLocation: /card.json\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned(),
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/a2a+json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                ),
            ] {
                let (mut socket, _) = listener.accept().expect("accept reference request");
                let mut request = [0_u8; 2_048];
                let _ = socket.read(&mut request).expect("read reference request");
                socket
                    .write_all(response.as_bytes())
                    .expect("write reference response");
            }
        });
        let discovered = discover_agent_card(
            &format!("http://{address}/start.json"),
            EndpointPolicy {
                allow_loopback_http: true,
            },
            ClientLimits {
                max_redirects: 1,
                ..ClientLimits::default()
            },
        )
        .await
        .expect("discover redirected card");
        assert_eq!(discovered.name, "Reference agent");
        server.join().expect("reference server thread");
    }

    /// Serve `requests` HTTP/1.1 requests on loopback, answering each by path.
    fn serve_paths(
        listener: TcpListener,
        routes: HashMap<String, String>,
        requests: usize,
    ) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            for _ in 0..requests {
                let (mut socket, _) = listener.accept().expect("accept reference request");
                let mut request = [0_u8; 2_048];
                let read = socket.read(&mut request).expect("read reference request");
                let head = String::from_utf8_lossy(&request[..read]);
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_owned();
                let response = routes.get(&path).map_or_else(
                    || "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned(),
                    |body| {
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                    },
                );
                socket
                    .write_all(response.as_bytes())
                    .expect("write reference response");
            }
        })
    }

    fn loopback_policy() -> EndpointPolicy {
        EndpointPolicy {
            allow_loopback_http: true,
        }
    }

    fn signed_card_body(
        address: SocketAddr,
        key: &ed25519_dalek::SigningKey,
        tamper: bool,
    ) -> String {
        let mut card = card(vec![AgentInterface::new(
            "https://peer.example.com/a2a",
            TRANSPORT_PROTOCOL_JSONRPC,
        )]);
        let jku = format!("http://{address}/jwks.json");
        card.signatures = Some(vec![
            crate::sign_agent_card(&card, key, Some(&jku)).expect("sign card")
        ]);
        if tamper {
            card.description = "Tampered after signing".to_owned();
        }
        serde_json::to_string(&card).expect("serialize Agent Card")
    }

    #[tokio::test]
    async fn signed_cards_verify_against_the_same_origin_jwks() {
        let key = ed25519_dalek::SigningKey::from_bytes(&[9; 32]);
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind reference server");
        let address = listener.local_addr().expect("reference address");
        let routes = HashMap::from([
            (
                "/.well-known/agent-card.json".to_owned(),
                signed_card_body(address, &key, false),
            ),
            (
                "/jwks.json".to_owned(),
                crate::card_signing::ed25519_jwks(&[key.verifying_key()]).to_string(),
            ),
        ]);
        let server = serve_paths(listener, routes, 2);
        let discovered = discover_verified_agent_card(
            &format!("http://{address}"),
            loopback_policy(),
            ClientLimits::default(),
            true,
        )
        .await
        .expect("discover signed card");
        assert_eq!(
            discovered.signature,
            CardSignatureStatus::Verified {
                kid: crate::card_signing::ed25519_jwk_thumbprint(&key.verifying_key()),
                jku: Some(format!("http://{address}/jwks.json")),
            }
        );
        server.join().expect("reference server thread");
    }

    #[tokio::test]
    async fn tampered_or_wrong_key_cards_are_rejected_at_discovery() {
        let key = ed25519_dalek::SigningKey::from_bytes(&[9; 32]);
        let other = ed25519_dalek::SigningKey::from_bytes(&[10; 32]);
        for (tamper, published) in [(true, key.verifying_key()), (false, other.verifying_key())] {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind reference server");
            let address = listener.local_addr().expect("reference address");
            let routes = HashMap::from([
                (
                    "/.well-known/agent-card.json".to_owned(),
                    signed_card_body(address, &key, tamper),
                ),
                (
                    "/jwks.json".to_owned(),
                    crate::card_signing::ed25519_jwks(&[published]).to_string(),
                ),
            ]);
            let server = serve_paths(listener, routes, 2);
            let error = discover_verified_agent_card(
                &format!("http://{address}"),
                loopback_policy(),
                ClientLimits::default(),
                false,
            )
            .await
            .expect_err("invalid signature must be rejected");
            assert!(
                matches!(&error, ClientError::InvalidAgentCard(reason) if reason.contains("signature verification failed")),
                "{error}"
            );
            server.join().expect("reference server thread");
        }
    }

    #[tokio::test]
    async fn unsigned_cards_are_accepted_unless_signatures_are_required() {
        let body = serde_json::to_string(&card(vec![AgentInterface::new(
            "https://peer.example.com/a2a",
            TRANSPORT_PROTOCOL_JSONRPC,
        )]))
        .expect("serialize Agent Card");
        for require in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind reference server");
            let address = listener.local_addr().expect("reference address");
            let routes = HashMap::from([("/.well-known/agent-card.json".to_owned(), body.clone())]);
            let server = serve_paths(listener, routes, 1);
            let result = discover_verified_agent_card(
                &format!("http://{address}"),
                loopback_policy(),
                ClientLimits::default(),
                require,
            )
            .await;
            if require {
                assert!(matches!(result, Err(ClientError::InvalidAgentCard(_))));
            } else {
                assert_eq!(
                    result.expect("unsigned card").signature,
                    CardSignatureStatus::Unsigned
                );
            }
            server.join().expect("reference server thread");
        }
    }

    #[test]
    fn selects_an_a2a_v1_interface_by_preference() {
        let card = card(vec![
            AgentInterface::new("https://example.com/rest", TRANSPORT_PROTOCOL_HTTP_JSON),
            AgentInterface::new("https://example.com/rpc", TRANSPORT_PROTOCOL_JSONRPC),
        ]);
        let endpoint = select_endpoint(
            &card,
            EndpointPolicy::default(),
            &[TransportBinding::JsonRpc, TransportBinding::HttpJson],
        )
        .expect("select endpoint");
        assert_eq!(endpoint.binding, TransportBinding::JsonRpc);
        assert_eq!(endpoint.url.as_str(), "https://example.com/rpc");
    }

    #[test]
    fn rejects_cards_without_a_compatible_protocol_version() {
        let mut interface = AgentInterface::new("https://example.com/a2a", "JSONRPC");
        interface.protocol_version = "0.3".to_owned();
        assert!(matches!(
            select_endpoint(&card(vec![interface]), EndpointPolicy::default(), &[]),
            Err(ClientError::NoCompatibleInterface)
        ));
    }

    #[test]
    fn http_json_paths_encode_task_ids_and_preserve_base_paths() {
        let base = Url::parse("https://example.com/a2a/").expect("base URL");
        let call = RestCall::get(&["tasks", "task/with spaces"]);
        assert_eq!(
            call.url(&base).expect("REST URL").as_str(),
            "https://example.com/a2a/tasks/task%2Fwith%20spaces"
        );
    }

    #[test]
    fn fragmented_sse_is_reassembled_and_comments_are_ignored() {
        let mut decoder = SseDecoder::new(1_024);
        assert!(decoder
            .push(b": keepalive\r\ndata: {\"message\":")
            .expect("first chunk")
            .is_empty());
        let events = decoder
            .push(b"{\"messageId\":\"m1\"}}\r\n\r\n")
            .expect("second chunk");
        assert_eq!(
            events,
            vec!["{\"message\":{\"messageId\":\"m1\"}}".to_owned()]
        );
    }

    #[test]
    fn oversized_sse_events_fail_closed() {
        let mut decoder = SseDecoder::new(8);
        assert!(matches!(
            decoder.push(b"data: 123456789\n"),
            Err(ClientError::EventTooLarge)
        ));
    }

    #[test]
    fn one_network_chunk_can_hold_multiple_bounded_events() {
        let mut decoder = SseDecoder::new(8);
        let events = decoder
            .push(b"data: first\n\ndata: second\n\n")
            .expect("two bounded events");
        assert_eq!(events, ["first", "second"]);
    }

    #[test]
    fn parses_direct_and_jsonrpc_stream_frames() {
        let message = Message::new(Role::Agent, vec![Part::text("hello")]);
        let direct = serde_json::to_string(&StreamResponse::Message(message.clone()))
            .expect("serialize event");
        assert!(matches!(
            parse_stream_event(&direct, TransportBinding::HttpJson),
            Ok(StreamResponse::Message(_))
        ));
        let envelope = JsonRpcResponse::success(
            JsonRpcId::Number(1),
            serde_json::to_value(StreamResponse::Message(message)).expect("serialize result"),
        );
        assert!(matches!(
            parse_stream_event(
                &serde_json::to_string(&envelope).expect("serialize envelope"),
                TransportBinding::JsonRpc,
            ),
            Ok(StreamResponse::Message(_))
        ));
    }

    #[test]
    fn oauth_authentication_future_is_send() {
        fn assert_send<T: Send>(_: T) {}

        let credential = PeerCredential::OAuth2ClientCredentials {
            token_url: "https://auth.example.com/token".to_owned(),
            client_id: "client".to_owned(),
            client_secret: "secret".to_owned(),
            scopes: vec!["a2a.send".to_owned()],
        };
        let limits = ClientLimits::default();
        assert_send(resolve_credential_auth(
            &credential,
            EndpointPolicy::default(),
            &limits,
        ));
    }

    #[test]
    fn push_authentication_rejects_header_injection() {
        let valid = AuthenticationInfo {
            scheme: "Bearer".to_owned(),
            credentials: Some("notification-secret".to_owned()),
        };
        assert!(validate_push_authentication(Some(&valid)).is_ok());

        let injected = AuthenticationInfo {
            scheme: "Bearer\r\nX-Evil".to_owned(),
            credentials: Some("secret".to_owned()),
        };
        assert!(matches!(
            validate_push_authentication(Some(&injected)),
            Err(ClientError::InvalidCredential)
        ));
    }

    #[test]
    fn terminal_http_errors_are_bounded_and_do_not_include_credentials() {
        let error = ClientError::HttpStatus {
            status: reqwest::StatusCode::UNAUTHORIZED.as_u16(),
            detail: "unauthorized".to_owned(),
        };
        assert_eq!(
            error.to_string(),
            "A2A peer returned HTTP status 401: unauthorized"
        );
    }

    #[test]
    fn task_state_serializes_to_the_v1_wire_value() {
        let value = serde_json::to_value(TaskState::Working).expect("serialize state");
        assert_eq!(value, Value::String("TASK_STATE_WORKING".to_owned()));
    }
}
