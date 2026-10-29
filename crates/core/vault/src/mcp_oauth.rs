//! Shared OAuth 2.1 broker for authenticated remote MCP servers.

//!
//! Publishers declare only `auth: { type: "oauth", client_id? }`. This module
//! owns discovery, PKCE, token exchange, refresh/revocation and the browser
//! callback. Token bundles are serialized only long enough to enter the encrypted
//! Identity Vault and are never returned through the API.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, RwLock};
use url::Url;

use crate::{McpOAuthConnectionRecord, McpOAuthConnectionStatus, SecretState};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OAuthClient {
    pub client_id: Option<String>,
}
impl OAuthClient {
    pub fn client_id(&self) -> Option<&str> {
        self.client_id.as_deref()
    }
}

const FLOW_TTL_SECS: i64 = 10 * 60;
const MAX_OAUTH_BODY_BYTES: usize = 1024 * 1024;
const REFRESH_SKEW_SECS: i64 = 60;
const MAX_MCP_PARAMETER_HEADERS: usize = 50;
const MAX_MCP_PARAMETER_HEADER_BYTES: usize = 16 * 1024;

fn is_http_token_byte(byte: u8) -> bool {
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
}

fn validate_mcp_transport_headers(headers: &[(String, String)]) -> Result<()> {
    let mut parameter_count = 0;
    let mut parameter_bytes = 0;
    for (name, value) in headers {
        let lower_name = name.to_ascii_lowercase();
        let standard = matches!(
            lower_name.as_str(),
            "accept"
                | "content-type"
                | "mcp-method"
                | "mcp-name"
                | "mcp-session-id"
                | "mcp-protocol-version"
        );
        let parameter = lower_name
            .strip_prefix("mcp-param-")
            .is_some_and(|suffix| !suffix.is_empty() && suffix.bytes().all(is_http_token_byte));
        if !(standard || parameter) {
            bail!("unsupported MCP transport header");
        }
        if parameter {
            parameter_count += 1;
            parameter_bytes += name.len() + value.len();
            if parameter_count > MAX_MCP_PARAMETER_HEADERS
                || parameter_bytes > MAX_MCP_PARAMETER_HEADER_BYTES
                || value.len() > 8 * 1024
                || !value
                    .bytes()
                    .all(|byte| byte == b'\t' || (0x20..=0x7e).contains(&byte))
            {
                bail!("MCP parameter header budget exceeded");
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum CallbackMode {
    Auto,
    Loopback,
    Hosted,
}

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct ConnectStarted {
    pub access_level: String,
    pub flow_id: String,
    pub authorization_url: String,
    pub callback_mode: CallbackMode,
    pub scopes: Vec<String>,
    pub status: FlowState,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FlowState {
    Pending,
    Connected,
    Failed,
}

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct FlowView {
    pub access_level: String,
    pub flow_id: String,
    pub plugin_id: String,
    pub server_name: String,
    pub profile_id: String,
    pub callback_mode: CallbackMode,
    pub scopes: Vec<String>,
    pub status: FlowState,
    pub expires_at: i64,
    pub error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectSpec {
    pub access_level: crate::ConnectionAccessLevel,
    pub owner_user_id: String,
    pub profile_id: String,
    pub plugin_id: String,
    pub server_name: String,
    pub resource_url: String,
    pub auth: OAuthClient,
    pub callback_mode: CallbackMode,
    pub static_headers: std::collections::BTreeMap<String, String>,
    /// A runtime `insufficient_scope` challenge. REST-initiated connects leave
    /// this unset and Core probes the protected resource itself.
    pub challenge: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ProtectedResourceMetadata {
    resource: Option<String>,
    #[serde(default)]
    authorization_servers: Vec<String>,
    #[serde(default)]
    scopes_supported: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct AuthorizationServerMetadata {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: Option<String>,
    revocation_endpoint: Option<String>,
    #[serde(default)]
    code_challenge_methods_supported: Vec<String>,
    #[serde(default)]
    scopes_supported: Vec<String>,
    #[serde(default)]
    authorization_response_iss_parameter_supported: bool,
    #[serde(default)]
    client_id_metadata_document_supported: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct DynamicClientResponse {
    client_id: String,
    client_secret: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct TokenBundle {
    #[serde(default = "crate::mcp_transport::default_configuration_hash")]
    static_headers_hash: String,
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    token_type: String,
    client_id: String,
    client_secret: Option<String>,
    token_endpoint: String,
    revocation_endpoint: Option<String>,
    issuer: String,
    resource: String,
    /// Exact manifest endpoint this consent was created for. This is distinct
    /// from the RFC 8707 resource audience, which may be an origin-level URI.
    #[serde(default)]
    mcp_server_url: String,
    /// The publisher-declared public client id, if any. A DCR-issued client id
    /// lives in `client_id`; keeping both detects manifest binding changes.
    #[serde(default)]
    declared_client_id: Option<String>,
}

impl std::fmt::Debug for TokenBundle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("TokenBundle(<redacted>)")
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    #[serde(default)]
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    token_type: Option<String>,
    expires_in: Option<i64>,
    scope: Option<String>,
    error: Option<String>,
    #[allow(dead_code)]
    error_description: Option<String>,
}

#[derive(Clone)]
struct PendingFlow {
    static_headers_hash: String,
    view: FlowView,
    authorization_url: String,
    owner_user_id: String,
    resource: String,
    mcp_server_url: String,
    declared_client_id: Option<String>,
    issuer: String,
    token_endpoint: String,
    revocation_endpoint: Option<String>,
    client_id: String,
    client_secret: Option<String>,
    redirect_uri: String,
    verifier: String,
    state: String,
    callback_claimed: bool,
    require_issuer_parameter: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct BindingKey {
    owner_user_id: String,
    profile_id: String,
    plugin_id: String,
    server_name: String,
}

impl BindingKey {
    fn new(owner_user_id: &str, profile_id: &str, plugin_id: &str, server_name: &str) -> Self {
        Self {
            owner_user_id: owner_user_id.to_owned(),
            profile_id: profile_id.to_owned(),
            plugin_id: plugin_id.to_owned(),
            server_name: server_name.to_owned(),
        }
    }

    fn from_flow(flow: &PendingFlow) -> Self {
        Self::new(
            &flow.owner_user_id,
            &flow.view.profile_id,
            &flow.view.plugin_id,
            &flow.view.server_name,
        )
    }

    fn from_connection(connection: &McpOAuthConnectionRecord) -> Self {
        Self::new(
            &connection.owner_user_id,
            &connection.profile_id,
            &connection.plugin_id,
            &connection.server_name,
        )
    }

    fn label(&self) -> String {
        format!(
            "{}:{}:{}",
            self.owner_user_id, self.profile_id, self.server_name
        )
    }
}

pub struct McpOAuthManager {
    refreshed: Mutex<HashMap<BindingKey, std::time::Instant>>,
    store: crate::IdentityStore,
    hosted_redirect: Option<String>,
    hosted_client: Option<String>,
    flows: RwLock<HashMap<String, PendingFlow>>,
    /// Serializes every vault mutation for one logical binding. Entries are
    /// intentionally retained for the manager lifetime so an old waiter can
    /// never race a newly-created lock for the same binding (the ABA problem).
    lifecycle_locks: Mutex<HashMap<BindingKey, Arc<Mutex<()>>>>,
    /// Normal binding operations take a read guard. Plugin uninstall takes the
    /// write guard so no callback, refresh, disconnect, or new flow can cross
    /// the cleanup boundary.
    plugin_locks: Mutex<HashMap<String, Arc<RwLock<()>>>>,
}

impl McpOAuthManager {
    pub fn new(
        store: crate::IdentityStore,
        hosted_redirect: Option<String>,
        hosted_client: Option<String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            hosted_redirect,
            hosted_client,
            refreshed: Mutex::default(),
            flows: RwLock::default(),
            lifecycle_locks: Mutex::default(),
            plugin_locks: Mutex::default(),
        })
    }
    pub fn store(&self) -> &crate::IdentityStore {
        &self.store
    }

    async fn lifecycle_lock(&self, binding: &BindingKey) -> Arc<Mutex<()>> {
        let mut locks = self.lifecycle_locks.lock().await;
        locks
            .entry(binding.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn plugin_lock(&self, plugin_id: &str) -> Arc<RwLock<()>> {
        let mut locks = self.plugin_locks.lock().await;
        locks
            .entry(plugin_id.to_owned())
            .or_insert_with(|| Arc::new(RwLock::new(())))
            .clone()
    }

    pub async fn start_connect(self: &Arc<Self>, spec: ConnectSpec) -> Result<ConnectStarted> {
        let static_configuration = crate::mcp_transport::McpConfiguration {
            static_headers: spec.static_headers.clone(),
            ..Default::default()
        };
        let static_headers_hash = static_configuration.fingerprint()?;
        let binding = BindingKey::new(
            &spec.owner_user_id,
            &spec.profile_id,
            &spec.plugin_id,
            &spec.server_name,
        );
        let plugin_lock = self.plugin_lock(&binding.plugin_id).await;
        let _plugin_guard = plugin_lock.read().await;
        let lifecycle_lock = self.lifecycle_lock(&binding).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        let now = chrono::Utc::now().timestamp();
        {
            let mut flows = self.flows.write().await;
            flows.retain(|_, flow| flow.view.expires_at.saturating_add(FLOW_TTL_SECS) > now);
            if flows.len() >= 256 {
                bail!("OAuth flow capacity exceeded");
            }
        }
        if let Some(existing) = self.flows.read().await.values().find(|flow| {
            flow.owner_user_id == spec.owner_user_id
                && flow.view.profile_id == spec.profile_id
                && flow.view.plugin_id == spec.plugin_id
                && flow.view.server_name == spec.server_name
                && flow.view.status == FlowState::Pending
                && flow.view.expires_at > now
        }) {
            return Ok(ConnectStarted {
                access_level: existing.view.access_level.clone(),
                flow_id: existing.view.flow_id.clone(),
                authorization_url: existing.authorization_url.clone(),
                callback_mode: existing.view.callback_mode,
                scopes: existing.view.scopes.clone(),
                status: FlowState::Pending,
                expires_at: existing.view.expires_at,
            });
        }
        let resource_url = validate_oauth_url(&spec.resource_url, true)?;
        let challenge = match spec.challenge.clone() {
            Some(challenge) => Some(challenge),
            None => oauth_challenge(&resource_url, &spec.static_headers).await?,
        };
        let challenge_scopes = challenge
            .as_deref()
            .and_then(|value| bearer_parameter(value, "scope"))
            .as_deref()
            .map(|value| split_scopes(value))
            .unwrap_or_default();
        let metadata_url = challenge
            .as_deref()
            .and_then(|value| bearer_parameter(value, "resource_metadata"))
            .map(|value| resource_url.join(&value))
            .transpose()
            .context("invalid resource_metadata URL in WWW-Authenticate")?
            .unwrap_or_else(|| protected_resource_metadata_url(&resource_url));
        let resource_metadata: ProtectedResourceMetadata = get_json(metadata_url.as_str()).await?;
        let resource = resource_metadata
            .resource
            .clone()
            .unwrap_or_else(|| resource_url.as_str().to_owned());
        let resource_parsed = validate_oauth_url(&resource, true)?;
        if resource_parsed.origin() != resource_url.origin() {
            bail!("protected-resource metadata changed the MCP resource origin");
        }
        let issuer = resource_metadata
            .authorization_servers
            .first()
            .context("protected-resource metadata declares no authorization server")?;
        let issuer_url = validate_oauth_url(issuer, false)?;
        let metadata = discover_authorization_server(&issuer_url).await?;
        if trim_trailing_slash(&metadata.issuer) != trim_trailing_slash(issuer_url.as_str()) {
            bail!("authorization-server metadata issuer does not match the discovered issuer");
        }
        validate_server_metadata_endpoints(&issuer_url, &metadata)?;
        if !metadata.code_challenge_methods_supported.is_empty()
            && !metadata
                .code_challenge_methods_supported
                .iter()
                .any(|method| method == "S256")
        {
            bail!("authorization server does not support PKCE S256");
        }

        let hosted_redirect = self.hosted_redirect.clone();
        let callback_mode = match spec.callback_mode {
            CallbackMode::Auto if hosted_redirect.is_some() => CallbackMode::Hosted,
            CallbackMode::Auto => CallbackMode::Loopback,
            mode => mode,
        };
        // The shared hosted callback is only safe when every response carries the
        // RFC 9207 `iss` parameter (see `complete_claimed_callback`). Refuse a
        // server that does not advertise it now, before the consent round trip,
        // instead of failing the callback after the user has already approved.
        // The callback still enforces `iss`, so a server that advertises support
        // and then omits it is rejected there.
        if callback_mode == CallbackMode::Hosted
            && !metadata.authorization_response_iss_parameter_supported
        {
            bail!(
                "this MCP authorization server does not return the RFC 9207 `iss` parameter, \
                 which hosted nodes require; connect it from a local desktop app instead"
            );
        }
        let (redirect_uri, listener) = match callback_mode {
            CallbackMode::Hosted => (
                hosted_redirect
                    .context("hosted OAuth requires an HTTPS RYU_NODE_PUBLIC_URL for this node")?,
                None,
            ),
            CallbackMode::Loopback | CallbackMode::Auto => {
                let listener = TcpListener::bind("127.0.0.1:0")
                    .await
                    .context("binding the loopback OAuth callback")?;
                let callback_addr = listener.local_addr()?;
                (
                    format!("http://127.0.0.1:{}/oauth/callback", callback_addr.port()),
                    Some(listener),
                )
            }
        };

        let client_metadata_id = (callback_mode == CallbackMode::Hosted
            && metadata.client_id_metadata_document_supported)
            .then(|| self.hosted_client.clone())
            .flatten();
        let (client_id, client_secret) = match (client_metadata_id, spec.auth.client_id()) {
            (Some(client_id), _) => (client_id, None),
            (None, Some(client_id)) => (client_id.trim().to_owned(), None),
            (None, None) => {
                let registration_endpoint = metadata.registration_endpoint.as_deref().context(
                    "authorization server provides neither a pre-registered client id nor dynamic client registration",
                )?;
                register_dynamic_client(registration_endpoint, &redirect_uri).await?
            }
        };
        let verifier = random_urlsafe(32);
        let challenge_value = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(verifier.as_bytes()));
        let state = random_urlsafe(32);
        let flow_id = format!("oauth_flow_{}", uuid::Uuid::new_v4().simple());
        let expires_at = now + FLOW_TTL_SECS;
        let requested_scopes = consent_scopes(
            challenge_scopes,
            &resource_metadata.scopes_supported,
            &metadata.scopes_supported,
        );
        let mut scopes: std::collections::BTreeSet<String> = requested_scopes.into_iter().collect();
        {
            let store = &self.store;
            if let Some(existing) = store
                .find_mcp_oauth_connection(
                    &spec.owner_user_id,
                    &spec.profile_id,
                    &spec.plugin_id,
                    &spec.server_name,
                )
                .await?
            {
                scopes.extend(existing.scopes);
            }
        }
        let scopes: Vec<String> = scopes.into_iter().collect();

        let mut authorization_url = validate_oauth_url(&metadata.authorization_endpoint, false)?;
        {
            let mut query = authorization_url.query_pairs_mut();
            query
                .append_pair("response_type", "code")
                .append_pair("client_id", &client_id)
                .append_pair("redirect_uri", &redirect_uri)
                .append_pair("code_challenge", &challenge_value)
                .append_pair("code_challenge_method", "S256")
                .append_pair("state", &state)
                .append_pair("resource", resource_parsed.as_str());
            if !scopes.is_empty() {
                query.append_pair("scope", &scopes.join(" "));
            }
        }
        let pending = PendingFlow {
            static_headers_hash,
            view: FlowView {
                access_level: spec.access_level.as_str().to_owned(),
                flow_id: flow_id.clone(),
                plugin_id: spec.plugin_id,
                server_name: spec.server_name,
                profile_id: spec.profile_id,
                callback_mode,
                scopes: scopes.clone(),
                status: FlowState::Pending,
                expires_at,
                error: None,
            },
            authorization_url: authorization_url.as_str().to_owned(),
            owner_user_id: spec.owner_user_id,
            resource: resource_parsed.as_str().to_owned(),
            mcp_server_url: resource_url.as_str().to_owned(),
            declared_client_id: spec.auth.client_id().map(str::to_owned),
            issuer: metadata.issuer,
            token_endpoint: metadata.token_endpoint,
            revocation_endpoint: metadata.revocation_endpoint,
            client_id,
            client_secret,
            redirect_uri,
            verifier,
            state,
            callback_claimed: false,
            require_issuer_parameter: metadata.authorization_response_iss_parameter_supported,
        };
        self.flows.write().await.insert(flow_id.clone(), pending);
        let expiry_flow_id = flow_id.clone();
        let manager = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(FLOW_TTL_SECS as u64)).await;
            manager.expire_flow(&expiry_flow_id).await;
        });
        if let Some(listener) = listener {
            tokio::spawn(accept_loopback_callback(
                self.clone(),
                listener,
                flow_id.clone(),
            ));
        }

        Ok(ConnectStarted {
            access_level: spec.access_level.as_str().to_owned(),
            flow_id,
            authorization_url: authorization_url.into(),
            callback_mode,
            scopes,
            status: FlowState::Pending,
            expires_at,
        })
    }

    pub async fn flow(&self, owner_user_id: &str, flow_id: &str) -> Result<FlowView> {
        let flows = self.flows.read().await;
        let flow = flows.get(flow_id).context("OAuth flow not found")?;
        if flow.owner_user_id != owner_user_id {
            bail!("OAuth flow not found");
        }
        Ok(flow.view.clone())
    }

    /// Complete the public hosted callback by its one-time OAuth state. The state
    /// is high entropy, expires with the flow, and is cleared after first use.
    pub async fn callback_binding(&self, state: &str) -> Result<McpBinding> {
        let flows = self.flows.read().await;
        let flow = flows
            .values()
            .find(|flow| {
                flow.view.callback_mode == CallbackMode::Hosted
                    && flow.view.status == FlowState::Pending
                    && !flow.callback_claimed
                    && flow.view.expires_at > chrono::Utc::now().timestamp()
                    && flow.state == state
            })
            .context("OAuth callback state is invalid or already used")?;
        Ok(McpBinding {
            owner_user_id: flow.owner_user_id.clone(),
            profile_id: flow.view.profile_id.clone(),
            plugin_id: flow.view.plugin_id.clone(),
            server_name: flow.view.server_name.clone(),
            resource_url: flow.mcp_server_url.clone(),
            client_id: flow.declared_client_id.clone(),
        })
    }

    pub async fn complete_hosted_callback(
        &self,
        code: Option<String>,
        returned_state: Option<String>,
        returned_issuer: Option<String>,
        oauth_error: Option<String>,
    ) -> Result<()> {
        let state = returned_state
            .as_deref()
            .context("OAuth callback omitted state")?;
        let flow_id = self
            .flows
            .read()
            .await
            .iter()
            .find(|(_, flow)| {
                flow.view.callback_mode == CallbackMode::Hosted
                    && flow.view.status == FlowState::Pending
                    && !flow.callback_claimed
                    && flow.state == state
            })
            .map(|(flow_id, _)| flow_id.clone())
            .context("OAuth callback state is invalid or already used")?;
        self.complete_callback(&flow_id, code, returned_state, returned_issuer, oauth_error)
            .await
    }

    async fn complete_callback(
        &self,
        flow_id: &str,
        code: Option<String>,
        returned_state: Option<String>,
        returned_issuer: Option<String>,
        oauth_error: Option<String>,
    ) -> Result<()> {
        let pending = self
            .claim_callback(flow_id, returned_state.as_deref())
            .await?;
        let completion = self
            .complete_claimed_callback(flow_id, pending, code, returned_issuer, oauth_error)
            .await;
        if let Err(error) = completion {
            self.mark_flow_failed(flow_id, &error.to_string()).await;
            return Err(error);
        }
        Ok(())
    }

    async fn complete_claimed_callback(
        &self,
        flow_id: &str,
        pending: PendingFlow,
        code: Option<String>,
        returned_issuer: Option<String>,
        oauth_error: Option<String>,
    ) -> Result<()> {
        if chrono::Utc::now().timestamp() >= pending.view.expires_at {
            bail!("OAuth flow expired");
        }
        if let Some(error) = oauth_error {
            bail!(
                "authorization failed: {}",
                sanitize_oauth_error_code(&error)
            );
        }
        // RFC 9207 mix-up defence. The hosted callback is one URL shared by every
        // authorization server, and the server selected for this flow sees the
        // state, so only the returned `iss` proves the response came from it. Its
        // own metadata cannot waive that (a malicious server would simply not
        // advertise support). The loopback listener is a fresh port per flow, so
        // there the redirect itself binds the response and an issuerless reply
        // stays acceptable unless the server promised to send `iss`.
        if let Some(returned_issuer) = returned_issuer.as_deref() {
            if trim_trailing_slash(returned_issuer) != trim_trailing_slash(&pending.issuer) {
                bail!("OAuth issuer did not match");
            }
        } else if pending.view.callback_mode == CallbackMode::Hosted {
            bail!(
                "OAuth callback omitted the required issuer: hosted callbacks need an \
                 authorization server that returns the RFC 9207 `iss` parameter; \
                 use a local desktop connection instead"
            );
        } else if pending.require_issuer_parameter {
            bail!("OAuth callback omitted the required issuer");
        }
        let code = code.context("OAuth callback did not contain a code")?;
        let mut form = vec![
            ("grant_type", "authorization_code".to_owned()),
            ("code", code),
            ("redirect_uri", pending.redirect_uri.clone()),
            ("client_id", pending.client_id.clone()),
            ("code_verifier", pending.verifier.clone()),
            ("resource", pending.resource.clone()),
        ];
        if let Some(secret) = &pending.client_secret {
            form.push(("client_secret", secret.clone()));
        }
        let response = post_token_form(&pending.token_endpoint, &form).await?;
        if let Some(error) = response.error {
            bail!(
                "token exchange failed: {}",
                sanitize_oauth_error_code(&error)
            );
        }
        if !response
            .token_type
            .as_deref()
            .unwrap_or("Bearer")
            .eq_ignore_ascii_case("bearer")
        {
            bail!("token endpoint returned a non-Bearer token");
        }
        if response.access_token.is_empty() {
            bail!("token endpoint returned no access token");
        }
        let expires_at = response
            .expires_in
            .map(|seconds| chrono::Utc::now().timestamp() + seconds.max(0));
        let scopes = response
            .scope
            .as_deref()
            .map(split_scopes)
            .unwrap_or_else(|| pending.view.scopes.clone());
        let binding = BindingKey::from_flow(&pending);
        let bundle = TokenBundle {
            static_headers_hash: pending.static_headers_hash,
            access_token: response.access_token,
            refresh_token: response.refresh_token,
            id_token: response.id_token,
            token_type: "Bearer".to_owned(),
            client_id: pending.client_id,
            client_secret: pending.client_secret,
            token_endpoint: pending.token_endpoint,
            revocation_endpoint: pending.revocation_endpoint,
            issuer: pending.issuer.clone(),
            resource: pending.resource.clone(),
            mcp_server_url: pending.mcp_server_url,
            declared_client_id: pending.declared_client_id,
        };
        let plaintext = serde_json::to_string(&bundle).context("serializing OAuth token bundle")?;
        let plugin_lock = self.plugin_lock(&binding.plugin_id).await;
        let _plugin_guard = plugin_lock.read().await;
        let lifecycle_lock = self.lifecycle_lock(&binding).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        self.ensure_flow_can_connect(flow_id, &binding).await?;
        let store = &self.store;
        store
            .upsert_mcp_oauth_connection(
                &pending.owner_user_id,
                &pending.view.profile_id,
                &pending.view.plugin_id,
                &pending.view.server_name,
                &pending.resource,
                &pending.issuer,
                None,
                &scopes,
                expires_at,
                &SecretState::new(plaintext),
            )
            .await?;
        store
            .set_connection_access_level(
                &pending.owner_user_id,
                "mcp",
                &connection_key(
                    &pending.view.profile_id,
                    &pending.view.plugin_id,
                    &pending.view.server_name,
                ),
                crate::ConnectionAccessLevel::from_str(&pending.view.access_level),
            )
            .await?;
        let mut flows = self.flows.write().await;
        let flow = flows
            .get_mut(flow_id)
            .context("OAuth flow was cancelled before it could connect")?;
        flow.view.status = FlowState::Connected;
        flow.view.error = None;
        scrub_flow_secrets(flow);
        Ok(())
    }

    async fn ensure_flow_can_connect(&self, flow_id: &str, binding: &BindingKey) -> Result<()> {
        let flows = self.flows.read().await;
        let flow = flows
            .get(flow_id)
            .context("OAuth flow was cancelled before it could connect")?;
        if BindingKey::from_flow(flow) != *binding
            || flow.view.status != FlowState::Pending
            || !flow.callback_claimed
        {
            bail!("OAuth flow is no longer pending");
        }
        if chrono::Utc::now().timestamp() >= flow.view.expires_at {
            bail!("OAuth flow expired");
        }
        Ok(())
    }

    async fn claim_callback(
        &self,
        flow_id: &str,
        returned_state: Option<&str>,
    ) -> Result<PendingFlow> {
        let mut flows = self.flows.write().await;
        let flow = flows.get_mut(flow_id).context("OAuth flow not found")?;
        if flow.callback_claimed {
            bail!("OAuth callback was already used");
        }
        if returned_state != Some(flow.state.as_str()) {
            bail!("OAuth state did not match");
        }
        flow.callback_claimed = true;
        Ok(flow.clone())
    }

    async fn fail_flow(&self, flow_id: &str, message: &str) -> Result<()> {
        self.mark_flow_failed(flow_id, message).await;
        bail!(message.to_owned())
    }

    async fn mark_flow_failed(&self, flow_id: &str, message: &str) {
        if let Some(flow) = self.flows.write().await.get_mut(flow_id) {
            if flow.view.status == FlowState::Pending {
                flow.view.status = FlowState::Failed;
                flow.view.error = Some(message.to_owned());
                scrub_flow_secrets(flow);
            }
        }
    }

    async fn expire_flow(&self, flow_id: &str) {
        let Some(binding) = self
            .flows
            .read()
            .await
            .get(flow_id)
            .map(BindingKey::from_flow)
        else {
            return;
        };
        let plugin_lock = self.plugin_lock(&binding.plugin_id).await;
        let _plugin_guard = plugin_lock.read().await;
        let lifecycle_lock = self.lifecycle_lock(&binding).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        if let Some(flow) = self.flows.write().await.get_mut(flow_id) {
            if flow.view.status == FlowState::Pending {
                flow.view.status = FlowState::Failed;
                flow.view.error = Some("OAuth flow expired".to_owned());
                scrub_flow_secrets(flow);
            }
        }
    }

    /// Resolve and proactively refresh the exact OAuth binding. The returned
    /// access token is for immediate header injection only.
    pub async fn access_token(
        &self,
        owner_user_id: &str,
        profile_id: &str,
        plugin_id: &str,
        server_name: &str,
        expected_resource: &str,
        expected_client_id: Option<&str>,
        action: crate::ConnectionAction,
        risk_approved: bool,
        force_refresh: bool,
        _session_id: Option<String>,
    ) -> Result<String> {
        let binding = BindingKey::new(owner_user_id, profile_id, plugin_id, server_name);
        let plugin_lock = self.plugin_lock(plugin_id).await;
        let _plugin_guard = plugin_lock.read().await;
        let lifecycle_lock = self.lifecycle_lock(&binding).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        self.access_token_locked(
            owner_user_id,
            profile_id,
            plugin_id,
            server_name,
            expected_resource,
            expected_client_id,
            action,
            risk_approved,
            force_refresh,
            None,
        )
        .await
    }

    async fn access_token_locked(
        &self,
        owner_user_id: &str,
        profile_id: &str,
        plugin_id: &str,
        server_name: &str,
        expected_resource: &str,
        expected_client_id: Option<&str>,
        action: crate::ConnectionAction,
        risk_approved: bool,
        force_refresh: bool,
        _session_id: Option<String>,
    ) -> Result<String> {
        let store = &self.store;
        let connection = store
            .find_mcp_oauth_connection(owner_user_id, profile_id, plugin_id, server_name)
            .await?
            .context("MCP authentication required")?;
        if connection.status != McpOAuthConnectionStatus::Connected {
            bail!("MCP authentication required");
        }
        let access_level = store
            .get_connection_access_level(
                owner_user_id,
                "mcp",
                &connection_key(profile_id, plugin_id, server_name),
            )
            .await?;
        if !access_level.allows_with_approval(action, risk_approved) {
            bail!("{}", "MCP connection access level denied this action");
        }
        let stored_bundle = open_bundle(store, &connection).await?;
        let binding_changed = stored_bundle.mcp_server_url.is_empty()
            || stored_bundle.resource != connection.resource_uri
            || stored_bundle.issuer != connection.issuer
            || validate_oauth_url(&stored_bundle.mcp_server_url, true)?
                != validate_oauth_url(expected_resource, true)?
            || stored_bundle.declared_client_id.as_deref() != expected_client_id;
        if binding_changed {
            store.mark_mcp_oauth_reauth_required(&connection.id).await?;
            bail!("the MCP OAuth binding changed; reconnect required");
        }
        let recently_refreshed = self
            .refreshed
            .lock()
            .await
            .get(&BindingKey::new(
                owner_user_id,
                profile_id,
                plugin_id,
                server_name,
            ))
            .is_some_and(|at| at.elapsed() < Duration::from_secs(5));
        let refresh_needed = (force_refresh && !recently_refreshed)
            || connection.expires_at.is_some_and(|expires| {
                expires <= chrono::Utc::now().timestamp() + REFRESH_SKEW_SECS
            });
        if !refresh_needed {
            return Ok(stored_bundle.access_token);
        }
        let current = store
            .find_mcp_oauth_connection(owner_user_id, profile_id, plugin_id, server_name)
            .await?
            .context("MCP authentication required")?;
        if current.status != McpOAuthConnectionStatus::Connected {
            bail!("MCP authentication required");
        }
        let bundle = open_bundle(store, &current).await?;
        let binding_changed = bundle.mcp_server_url.is_empty()
            || validate_oauth_url(&bundle.mcp_server_url, true)?
                != validate_oauth_url(expected_resource, true)?
            || bundle.declared_client_id.as_deref() != expected_client_id;
        if binding_changed {
            store.mark_mcp_oauth_reauth_required(&current.id).await?;
            bail!("the MCP OAuth binding changed; reconnect required");
        }
        let another_caller_refreshed = current.updated_at != connection.updated_at;
        let current_is_fresh = current
            .expires_at
            .is_none_or(|expires| expires > chrono::Utc::now().timestamp() + REFRESH_SKEW_SECS);
        if another_caller_refreshed || (!force_refresh && current_is_fresh) {
            return Ok(bundle.access_token);
        }
        let refresh_token = bundle
            .refresh_token
            .clone()
            .context("MCP connection expired and has no refresh token")?;
        let mut form = vec![
            ("grant_type", "refresh_token".to_owned()),
            ("refresh_token", refresh_token),
            ("client_id", bundle.client_id.clone()),
            ("resource", bundle.resource.clone()),
        ];
        if let Some(secret) = &bundle.client_secret {
            form.push(("client_secret", secret.clone()));
        }
        let response = post_token_form(&bundle.token_endpoint, &form).await?;
        if response.error.as_deref() == Some("invalid_grant") {
            store.mark_mcp_oauth_reauth_required(&current.id).await?;
            bail!("MCP authentication expired; reconnect required");
        }
        if let Some(error) = response.error {
            bail!(
                "OAuth refresh failed: {}",
                sanitize_oauth_error_code(&error)
            );
        }
        if response.access_token.is_empty() {
            bail!("OAuth refresh returned no access token");
        }
        if !response
            .token_type
            .as_deref()
            .unwrap_or("Bearer")
            .eq_ignore_ascii_case("bearer")
        {
            bail!("OAuth refresh returned a non-Bearer token");
        }
        let updated = TokenBundle {
            access_token: response.access_token,
            refresh_token: response.refresh_token.or(bundle.refresh_token),
            id_token: response.id_token.or(bundle.id_token),
            token_type: response.token_type.unwrap_or_else(|| "Bearer".to_owned()),
            ..bundle
        };
        let expires_at = response
            .expires_in
            .map(|seconds| chrono::Utc::now().timestamp() + seconds.max(0));
        let scopes = response
            .scope
            .as_deref()
            .map(split_scopes)
            .unwrap_or(current.scopes);
        store
            .upsert_mcp_oauth_connection(
                owner_user_id,
                profile_id,
                plugin_id,
                server_name,
                &updated.resource,
                &updated.issuer,
                current.account_label.as_deref(),
                &scopes,
                expires_at,
                &SecretState::new(serde_json::to_string(&updated)?),
            )
            .await?;
        self.refreshed.lock().await.insert(
            BindingKey::new(owner_user_id, profile_id, plugin_id, server_name),
            std::time::Instant::now(),
        );
        Ok(updated.access_token)
    }

    /// Consume the exact binding while holding its lifecycle lock through egress.
    /// The request cannot supply an alternate resource, Authorization or callback sink.
    pub async fn consume(
        &self,
        binding: &McpBinding,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
        action: crate::ConnectionAction,
        risk_approved: bool,
        force_refresh: bool,
    ) -> Result<ryu_egress::GuardedResponse> {
        self.consume_configured(
            binding,
            headers,
            body,
            action,
            risk_approved,
            force_refresh,
            &crate::mcp_transport::McpConfiguration::default(),
            &mut None,
        )
        .await
    }

    pub async fn consume_configured(
        &self,
        binding: &McpBinding,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
        action: crate::ConnectionAction,
        risk_approved: bool,
        force_refresh: bool,
        configuration: &crate::mcp_transport::McpConfiguration,
        legacy: &mut Option<crate::mcp_transport::LegacySession>,
    ) -> Result<ryu_egress::GuardedResponse> {
        let key = BindingKey::new(
            &binding.owner_user_id,
            &binding.profile_id,
            &binding.plugin_id,
            &binding.server_name,
        );
        let plugin_lock = self.plugin_lock(&binding.plugin_id).await;
        let _plugin_guard = plugin_lock.read().await;
        let lock = self.lifecycle_lock(&key).await;
        let _guard = lock.lock().await;
        let token = self
            .access_token_locked(
                &binding.owner_user_id,
                &binding.profile_id,
                &binding.plugin_id,
                &binding.server_name,
                &binding.resource_url,
                binding.client_id.as_deref(),
                action,
                risk_approved,
                force_refresh,
                None,
            )
            .await?;
        validate_mcp_transport_headers(&headers)?;
        let mut headers = headers;
        // Providers may echo credentials in errors or content. Never reflect custody material.
        let record = self
            .store
            .find_mcp_oauth_connection(
                &binding.owner_user_id,
                &binding.profile_id,
                &binding.plugin_id,
                &binding.server_name,
            )
            .await?
            .context("MCP authentication required")?;
        let bundle = open_bundle(&self.store, &record).await?;
        let static_headers = configuration.normalized_headers()?;
        let expected_headers_hash = crate::mcp_transport::McpConfiguration {
            static_headers: static_headers.clone(),
            ..Default::default()
        }
        .fingerprint()?;
        if bundle.static_headers_hash != expected_headers_hash {
            bail!("MCP static header binding changed; reconnect required");
        }
        headers.extend(static_headers.iter().map(|(k, v)| (k.clone(), v.clone())));
        headers.push(("authorization".into(), format!("Bearer {token}")));
        let mut response = match configuration.transport {
            crate::mcp_transport::TransportMode::StreamableHttp => {
                request("POST", &binding.resource_url, headers, Some(body)).await?
            }
            crate::mcp_transport::TransportMode::Sse => {
                let mut failure = None;
                if legacy.is_none() {
                    let mut get_headers: Vec<_> = static_headers
                        .iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                    get_headers.push(("authorization".into(), format!("Bearer {token}")));
                    get_headers.push(("accept".into(), "text/event-stream".into()));
                    match crate::mcp_transport::LegacySession::connect(
                        &binding.resource_url,
                        get_headers,
                        vec![token.clone()],
                    )
                    .await
                    {
                        Ok(session) => *legacy = Some(session),
                        Err(error) => {
                            match error.downcast::<crate::mcp_transport::LegacyHttpFailure>() {
                                Ok(error) => failure = Some(error.0),
                                Err(error) => return Err(error),
                            }
                        }
                    }
                }
                match failure {
                    Some(response) => response,
                    None => {
                        legacy
                            .as_mut()
                            .context("MCP SSE session missing")?
                            .exchange(headers, body)
                            .await?
                    }
                }
            }
        };
        let mut secrets: Vec<&str> = [
            Some(token.as_str()),
            Some(bundle.access_token.as_str()),
            bundle.refresh_token.as_deref(),
            bundle.id_token.as_deref(),
            bundle.client_secret.as_deref(),
        ]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect();
        secrets.extend(
            static_headers
                .values()
                .map(String::as_str)
                .filter(|v| !v.is_empty()),
        );
        if let Some(legacy) = legacy {
            secrets.extend(
                legacy
                    .redaction_values
                    .iter()
                    .map(String::as_str)
                    .filter(|v| !v.is_empty()),
            );
        }
        if secrets.iter().any(|secret| {
            let escaped = serde_json::to_string(secret).unwrap_or_default();
            let escaped = escaped.trim_matches('"');
            let found = [*secret, escaped]
                .into_iter()
                .filter(|s| !s.is_empty())
                .any(|pattern| {
                    response
                        .body
                        .windows(pattern.len())
                        .any(|v| v == pattern.as_bytes())
                        || response.headers.iter().any(|(_, v)| v.contains(pattern))
                });
            found
        }) {
            bail!("MCP upstream response contained credential material");
        }
        response.headers.retain(|(name, _)| {
            matches!(
                name.to_ascii_lowercase().as_str(),
                "content-type" | "mcp-session-id" | "mcp-protocol-version" | "www-authenticate"
            )
        });
        Ok(response)
    }
    pub async fn disconnect(
        &self,
        owner_user_id: &str,
        profile_id: &str,
        plugin_id: &str,
        server_name: &str,
    ) -> Result<(bool, bool)> {
        let binding = BindingKey::new(owner_user_id, profile_id, plugin_id, server_name);
        let plugin_lock = self.plugin_lock(plugin_id).await;
        let _plugin_guard = plugin_lock.read().await;
        self.disconnect_binding(&binding).await
    }

    async fn disconnect_binding(&self, binding: &BindingKey) -> Result<(bool, bool)> {
        let lifecycle_lock = self.lifecycle_lock(binding).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        self.refreshed.lock().await.remove(binding);
        self.flows.write().await.retain(|_, flow| {
            !(flow.owner_user_id == binding.owner_user_id
                && flow.view.profile_id == binding.profile_id
                && flow.view.plugin_id == binding.plugin_id
                && flow.view.server_name == binding.server_name)
        });
        let store = &self.store;
        let Some(connection) = store
            .find_mcp_oauth_connection(
                &binding.owner_user_id,
                &binding.profile_id,
                &binding.plugin_id,
                &binding.server_name,
            )
            .await?
        else {
            return Ok((false, false));
        };
        let mut revocation_confirmed = false;
        if let Ok(bundle) = open_bundle(store, &connection).await {
            if let Some(endpoint) = &bundle.revocation_endpoint {
                let token = bundle
                    .refresh_token
                    .as_deref()
                    .unwrap_or(&bundle.access_token)
                    .to_owned();
                let mut form = vec![("token", token), ("client_id", bundle.client_id.clone())];
                if let Some(secret) = &bundle.client_secret {
                    form.push(("client_secret", secret.clone()));
                }
                revocation_confirmed = post_form_empty(endpoint, &form).await.is_ok();
            }
        }
        let deleted = store
            .delete_mcp_oauth_connection(
                &binding.owner_user_id,
                &binding.profile_id,
                &binding.plugin_id,
                &binding.server_name,
            )
            .await?;
        Ok((deleted, revocation_confirmed))
    }

    /// Lifecycle cleanup for uninstall. Every owner/profile row belonging to the
    /// plugin is removed even when an upstream revocation endpoint is unavailable.
    /// The return value names bindings whose remote revocation was not confirmed.
    pub async fn disconnect_plugin(&self, plugin_id: &str) -> Result<Vec<String>> {
        let plugin_lock = self.plugin_lock(plugin_id).await;
        let _plugin_guard = plugin_lock.write().await;
        let store = &self.store;
        let connections = store
            .list_mcp_oauth_connections_for_plugin(plugin_id)
            .await?;
        let connection_bindings: HashSet<BindingKey> = connections
            .iter()
            .map(BindingKey::from_connection)
            .collect();
        let mut bindings = connection_bindings.clone();
        bindings.extend(
            self.flows
                .read()
                .await
                .values()
                .filter(|flow| flow.view.plugin_id == plugin_id)
                .map(BindingKey::from_flow),
        );
        let mut unconfirmed = Vec::new();
        let mut failures = Vec::new();
        for binding in bindings {
            match self.disconnect_binding(&binding).await {
                Ok((_, true)) => {}
                Ok((_, false)) if connection_bindings.contains(&binding) => {
                    unconfirmed.push(binding.label());
                }
                Ok((_, false)) => {}
                Err(error) => failures.push(format!("{}: {error:#}", binding.label())),
            }
        }
        self.flows
            .write()
            .await
            .retain(|_, flow| flow.view.plugin_id != plugin_id);
        unconfirmed.sort();
        failures.sort();
        if !failures.is_empty() {
            bail!(
                "failed to clean up one or more MCP OAuth bindings after attempting all of them: {}",
                failures.join("; ")
            );
        }
        Ok(unconfirmed)
    }
}

fn scrub_flow_secrets(flow: &mut PendingFlow) {
    flow.verifier.clear();
    flow.state.clear();
    flow.client_secret = None;
}

async fn open_bundle(
    store: &crate::IdentityStore,
    connection: &McpOAuthConnectionRecord,
) -> Result<TokenBundle> {
    let secret = store
        .open_mcp_oauth_state(&connection.id)
        .await?
        .context("MCP OAuth connection has no token state")?;
    serde_json::from_str(secret.expose()).context("opening MCP OAuth token bundle")
}

async fn oauth_challenge(
    resource: &Url,
    headers: &std::collections::BTreeMap<String, String>,
) -> Result<Option<String>> {
    let response = request("POST", resource.as_str(), headers.iter().map(|(k,v)|(k.clone(),v.clone())).chain([
        ("content-type".into(),"application/json".into()), ("accept".into(),"application/json, text/event-stream".into())
    ]).collect(), Some(br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"Ryu","version":"1"}}}"#.to_vec())).await?;
    if matches!(response.status, 400 | 404 | 405 | 501) {
        let mut get_headers: Vec<_> = headers
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        get_headers.push(("accept".into(), "text/event-stream".into()));
        let response = crate::mcp_transport::stream(resource.as_str(), &get_headers).await?;
        if response.status() != reqwest::StatusCode::UNAUTHORIZED {
            bail!("MCP server did not request OAuth authentication");
        }
        let challenge = response
            .headers()
            .get("www-authenticate")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        return checked_challenge(challenge, headers);
    }
    if response.status != 401 {
        bail!("MCP server did not request OAuth authentication");
    }
    checked_challenge(
        response
            .headers
            .into_iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("www-authenticate"))
            .map(|(_, v)| v),
        headers,
    )
}

fn checked_challenge(
    challenge: Option<String>,
    headers: &std::collections::BTreeMap<String, String>,
) -> Result<Option<String>> {
    if let Some(value) = &challenge {
        for secret in headers.values().filter(|v| !v.is_empty()) {
            let escaped = serde_json::to_string(secret)?;
            if value.contains(secret) || value.contains(escaped.trim_matches('"')) {
                bail!("MCP challenge reflected a configured header value");
            }
        }
    }
    Ok(challenge)
}

async fn accept_loopback_callback(
    manager: Arc<McpOAuthManager>,
    listener: TcpListener,
    flow_id: String,
) {
    let result = async {
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(FLOW_TTL_SECS as u64), listener.accept())
            .await
            .context("OAuth callback timed out")??;
        let mut buffer = vec![0_u8; 16 * 1024];
        let count = stream.read(&mut buffer).await.context("reading OAuth callback")?;
        let request = String::from_utf8_lossy(&buffer[..count]);
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .context("invalid OAuth callback request")?;
        let callback = Url::parse(&format!("http://127.0.0.1{target}"))?;
        let params: HashMap<String, String> = callback.query_pairs().into_owned().collect();
        let completion = manager
            .complete_callback(
                &flow_id,
                params.get("code").cloned(),
                params.get("state").cloned(),
                params.get("iss").cloned(),
                params.get("error").cloned(),
            )
            .await;
        let (status, heading, detail) = match completion {
            Ok(()) => ("200 OK", "Connected", "You can close this window and return to Ryu."),
            Err(_) => (
                "400 Bad Request",
                "Connection failed",
                "Return to Ryu for details and try connecting again.",
            ),
        };
        let body = format!(
            "<!doctype html><meta name=\"referrer\" content=\"no-referrer\"><title>{heading}</title><h1>{heading}</h1><p>{detail}</p>"
        );
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await?;
        Result::<()>::Ok(())
    }
    .await;
    if let Err(error) = result {
        let _ = manager.fail_flow(&flow_id, &error.to_string()).await;
    }
}

async fn discover_authorization_server(issuer: &Url) -> Result<AuthorizationServerMetadata> {
    let oauth_url = authorization_server_metadata_url(issuer, "oauth-authorization-server");
    if let Ok(metadata) = get_json::<AuthorizationServerMetadata>(oauth_url.as_str()).await {
        return Ok(metadata);
    }
    let oidc_url = authorization_server_metadata_url(issuer, "openid-configuration");
    if let Ok(metadata) = get_json::<AuthorizationServerMetadata>(oidc_url.as_str()).await {
        return Ok(metadata);
    }
    let mut appended = issuer.clone();
    let path = issuer.path().trim_end_matches('/');
    appended.set_path(&format!("{path}/.well-known/openid-configuration"));
    appended.set_query(None);
    appended.set_fragment(None);
    get_json(appended.as_str()).await
}

fn authorization_server_metadata_url(issuer: &Url, suffix: &str) -> Url {
    let mut url = issuer.clone();
    let issuer_path = issuer.path().trim_matches('/');
    url.set_path(&format!(
        "/.well-known/{suffix}{}",
        if issuer_path.is_empty() {
            String::new()
        } else {
            format!("/{issuer_path}")
        }
    ));
    url.set_query(None);
    url.set_fragment(None);
    url
}

fn validate_server_metadata_endpoints(
    issuer: &Url,
    metadata: &AuthorizationServerMetadata,
) -> Result<()> {
    let endpoints = [
        Some(metadata.authorization_endpoint.as_str()),
        Some(metadata.token_endpoint.as_str()),
        metadata.registration_endpoint.as_deref(),
        metadata.revocation_endpoint.as_deref(),
    ];
    for endpoint in endpoints.into_iter().flatten() {
        let endpoint = validate_oauth_url(endpoint, false)?;
        if endpoint.origin() != issuer.origin() {
            bail!("authorization-server endpoint origin does not match its issuer");
        }
    }
    Ok(())
}

fn protected_resource_metadata_url(resource: &Url) -> Url {
    let mut url = resource.clone();
    let path = resource.path().trim_matches('/');
    url.set_path(&format!(
        "/.well-known/oauth-protected-resource{}",
        if path.is_empty() {
            String::new()
        } else {
            format!("/{path}")
        }
    ));
    url.set_query(None);
    url.set_fragment(None);
    url
}

async fn register_dynamic_client(
    endpoint: &str,
    redirect_uri: &str,
) -> Result<(String, Option<String>)> {
    let body = serde_json::json!({
        "application_type": "native",
        "client_name": "Ryu",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none"
    });
    let response: DynamicClientResponse = post_json(endpoint, &body).await?;
    Ok((response.client_id, response.client_secret))
}

async fn get_json<T: for<'de> Deserialize<'de>>(url: &str) -> Result<T> {
    validate_oauth_url(url, false)?;
    let response = request("GET", url, vec![], None).await?;
    if !(200..300).contains(&response.status) {
        bail!("OAuth metadata request failed");
    }
    serde_json::from_slice(&response.body).context("invalid OAuth metadata")
}
async fn post_json<T: for<'de> Deserialize<'de>>(url: &str, body: &serde_json::Value) -> Result<T> {
    let response = request(
        "POST",
        url,
        vec![("content-type".into(), "application/json".into())],
        Some(serde_json::to_vec(body)?),
    )
    .await?;
    if !(200..300).contains(&response.status) {
        bail!("OAuth registration request failed");
    }
    serde_json::from_slice(&response.body).context("invalid OAuth registration")
}
async fn post_token_form(url: &str, form: &[(&str, String)]) -> Result<TokenResponse> {
    let response = post_form(url, form).await?;
    parse_token_response(
        reqwest::StatusCode::from_u16(response.status)?,
        &response.body,
    )
}
async fn post_form(url: &str, form: &[(&str, String)]) -> Result<ryu_egress::GuardedResponse> {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(form.iter().map(|(k, v)| (*k, v)))
        .finish();
    request(
        "POST",
        url,
        vec![(
            "content-type".into(),
            "application/x-www-form-urlencoded".into(),
        )],
        Some(body.into_bytes()),
    )
    .await
}
pub async fn request(
    method: &str,
    url: &str,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
) -> Result<ryu_egress::GuardedResponse> {
    validate_oauth_url(url, true)?;
    // Test/proof-only provider fixture seam. Normal builds always use pinned
    // public egress; the explicit proof feature is never enabled by default.
    #[cfg(any(test, feature = "proof-loopback"))]
    if is_loopback_http(&Url::parse(url)?) {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .build()?;
        let mut builder = client.request(reqwest::Method::from_bytes(method.as_bytes())?, url);
        for (name, value) in headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = body {
            builder = builder.body(body);
        }
        let mut response = builder.send().await?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap().to_owned()))
            .collect();
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if body.len() + chunk.len() > MAX_OAUTH_BODY_BYTES {
                bail!("Fixture response too large");
            }
            body.extend_from_slice(&chunk);
        }
        return Ok(ryu_egress::GuardedResponse {
            status,
            headers,
            body,
        });
    }
    // Direct, like `mcp_transport::stream`: tokens and MCP frames must reach only
    // the screened, pinned address, never an env proxy that resolves the host.
    ryu_egress::guarded_request_direct(
        ryu_egress::GuardedRequest {
            method: method.into(),
            url: url.into(),
            headers,
            body,
        },
        ryu_egress::GuardedFetchPolicy {
            allow_http: false,
            max_body_bytes: MAX_OAUTH_BODY_BYTES as u64,
            max_redirect_hops: 0,
            timeout: Duration::from_secs(30),
        },
    )
    .await
    .map_err(|_| anyhow::anyhow!("OAuth upstream request failed"))
}
/// Scopes to request at consent. The challenge's scopes win; otherwise the
/// protected resource's own `scopes_supported` (as MCP authorization directs).
/// The authorization server's list is server-wide and often names unrelated or
/// administrative scopes, so it is used only when the resource publishes none.
/// `offline_access` grants no resource authority; it only lets providers that
/// gate refresh tokens on it issue one, so it is kept from the server's list
/// whenever the request is not a step-up challenge.
fn consent_scopes(
    challenge: Vec<String>,
    resource_supported: &[String],
    server_supported: &[String],
) -> Vec<String> {
    let from_challenge = !challenge.is_empty();
    let mut chosen: std::collections::BTreeSet<String> = if from_challenge {
        challenge.into_iter().collect()
    } else if !resource_supported.is_empty() {
        resource_supported.iter().cloned().collect()
    } else {
        server_supported.iter().cloned().collect()
    };
    if !from_challenge
        && server_supported
            .iter()
            .any(|scope| scope == OFFLINE_ACCESS_SCOPE)
    {
        chosen.insert(OFFLINE_ACCESS_SCOPE.to_owned());
    }
    chosen.into_iter().collect()
}
const OFFLINE_ACCESS_SCOPE: &str = "offline_access";
fn parse_token_response(status: reqwest::StatusCode, bytes: &[u8]) -> Result<TokenResponse> {
    let mut token: TokenResponse = serde_json::from_slice(bytes).unwrap_or(TokenResponse {
        access_token: String::new(),
        refresh_token: None,
        id_token: None,
        token_type: None,
        expires_in: None,
        scope: None,
        error: Some(format!("http_{status}")),
        error_description: None,
    });
    if !status.is_success() && token.error.is_none() {
        token.error = Some(format!("http_{status}"));
    }
    Ok(token)
}

async fn post_form_empty(url: &str, form: &[(&str, String)]) -> Result<()> {
    let response = post_form(url, form).await?;
    if !(200..300).contains(&response.status) {
        bail!("OAuth revocation request failed");
    }
    Ok(())
}
pub fn connection_key(profile: &str, plugin: &str, server: &str) -> String {
    format!("{profile}:{plugin}:{server}")
}

fn validate_oauth_url(value: &str, allow_resource_query: bool) -> Result<Url> {
    let parsed = Url::parse(value).context("invalid OAuth URL")?;
    if parsed.username() != "" || parsed.password().is_some() || parsed.fragment().is_some() {
        bail!("OAuth URL must not contain userinfo or a fragment");
    }
    if !allow_resource_query && parsed.query().is_some() {
        bail!("OAuth metadata endpoint URL must not contain a query");
    }
    if parsed.scheme() == "https" || is_loopback_http(&parsed) {
        return Ok(parsed);
    }
    bail!("OAuth URL must use HTTPS (HTTP is allowed only on loopback)")
}

fn is_loopback_http(url: &Url) -> bool {
    url.scheme() == "http"
        && url.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        })
}

fn bearer_parameter(challenge: &str, key: &str) -> Option<String> {
    let bearer = challenge
        .split_once(' ')
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))?
        .1;
    for parameter in bearer.split(',') {
        let (name, value) = parameter.trim().split_once('=')?;
        if name.trim().eq_ignore_ascii_case(key) {
            return Some(value.trim().trim_matches('"').to_owned());
        }
    }
    None
}

fn split_scopes(value: &str) -> Vec<String> {
    value
        .split_whitespace()
        .map(str::to_owned)
        .filter(|scope| !scope.is_empty())
        .collect()
}

fn random_urlsafe(bytes: usize) -> String {
    let mut value = vec![0_u8; bytes];
    rand::thread_rng().fill_bytes(&mut value);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value)
}

fn trim_trailing_slash(value: &str) -> &str {
    value.trim_end_matches('/')
}

fn sanitize_oauth_error_code(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
        .take(64)
        .collect();
    if sanitized.is_empty() {
        "request_denied".to_owned()
    } else {
        sanitized
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn pending_flow(flow_id: &str) -> PendingFlow {
        PendingFlow {
            static_headers_hash: crate::mcp_transport::default_configuration_hash(),
            view: FlowView {
                access_level: "risk_based".to_owned(),
                flow_id: flow_id.to_owned(),
                plugin_id: "com.example.mail".to_owned(),
                server_name: "mail".to_owned(),
                profile_id: "personal".to_owned(),
                callback_mode: CallbackMode::Hosted,
                scopes: vec!["email.send".to_owned()],
                status: FlowState::Pending,
                expires_at: i64::MAX,
                error: None,
            },
            authorization_url: "https://auth.example/authorize".to_owned(),
            owner_user_id: "user".to_owned(),
            resource: "https://mcp.example".to_owned(),
            mcp_server_url: "https://mcp.example/mcp".to_owned(),
            declared_client_id: None,
            issuer: "https://auth.example".to_owned(),
            token_endpoint: "https://auth.example/token".to_owned(),
            revocation_endpoint: None,
            client_id: "client".to_owned(),
            client_secret: Some("client-secret".to_owned()),
            redirect_uri: "https://node.example/api/mcp/oauth/callback".to_owned(),
            verifier: "verifier".to_owned(),
            state: "one-time-state".to_owned(),
            callback_claimed: false,
            require_issuer_parameter: false,
        }
    }

    #[test]
    fn challenge_parameters_and_metadata_urls_are_strict() {
        let challenge = r#"Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource", scope="email.send domains.read""#;
        assert_eq!(
            bearer_parameter(challenge, "resource_metadata").as_deref(),
            Some("https://mcp.example/.well-known/oauth-protected-resource")
        );
        assert_eq!(
            split_scopes(&bearer_parameter(challenge, "scope").unwrap()),
            ["email.send", "domains.read"]
        );
        assert!(validate_oauth_url("http://169.254.169.254/token", false).is_err());
        assert!(validate_oauth_url("http://127.0.0.1:8080/token", false).is_ok());
    }

    #[test]
    fn custom_mcp_parameter_headers_are_token_validated_and_bounded() {
        assert!(validate_mcp_transport_headers(&[
            ("Mcp-Method".into(), "tools/call".into()),
            ("Mcp-Param-Region".into(), "us-west1".into()),
        ])
        .is_ok());
        assert!(
            validate_mcp_transport_headers(&[("Mcp-Param-Bad Name".into(), "value".into(),)])
                .is_err()
        );
        assert!(validate_mcp_transport_headers(&[(
            "Mcp-Param-Region".into(),
            "x".repeat(8 * 1024 + 1),
        )])
        .is_err());
    }

    #[test]
    fn token_bundle_debug_is_always_redacted() {
        let bundle = TokenBundle {
            static_headers_hash: crate::mcp_transport::default_configuration_hash(),
            access_token: "secret-access".to_owned(),
            refresh_token: Some("secret-refresh".to_owned()),
            id_token: None,
            token_type: "Bearer".to_owned(),
            client_id: "public".to_owned(),
            client_secret: None,
            token_endpoint: "https://auth.example/token".to_owned(),
            revocation_endpoint: None,
            issuer: "https://auth.example".to_owned(),
            resource: "https://mcp.example".to_owned(),
            mcp_server_url: "https://mcp.example/mcp".to_owned(),
            declared_client_id: Some("public".to_owned()),
        };
        let shown = format!("{bundle:?}");
        assert_eq!(shown, "TokenBundle(<redacted>)");
    }

    #[test]
    fn non_success_token_error_preserves_invalid_grant() {
        let response = parse_token_response(
            reqwest::StatusCode::BAD_REQUEST,
            br#"{"error":"invalid_grant","error_description":"refresh token expired"}"#,
        )
        .expect("OAuth errors are typed responses");
        assert_eq!(response.error.as_deref(), Some("invalid_grant"));
        assert_eq!(
            response.error_description.as_deref(),
            Some("refresh token expired")
        );
        assert!(response.access_token.is_empty());
    }

    #[tokio::test]
    async fn callback_state_is_claimed_exactly_once() {
        let manager =
            McpOAuthManager::new(crate::IdentityStore::open_in_memory().unwrap(), None, None);
        let flow_id = "flow".to_owned();
        manager
            .flows
            .write()
            .await
            .insert(flow_id.clone(), pending_flow(&flow_id));

        manager
            .claim_callback(&flow_id, Some("one-time-state"))
            .await
            .expect("first callback claims the state");
        assert!(manager
            .claim_callback(&flow_id, Some("one-time-state"))
            .await
            .is_err());
    }

    /// A token endpoint that only counts requests and answers each with an OAuth
    /// error, so a test can prove whether Core ever sent the code + PKCE verifier.
    async fn counting_token_endpoint() -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/token", listener.local_addr().unwrap());
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut buffer = vec![0; 16384];
                    let _ = stream.read(&mut buffer).await;
                    let body = r#"{"error":"invalid_grant"}"#;
                    let _ = stream
                        .write_all(
                            format!(
                                "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            )
                            .as_bytes(),
                        )
                        .await;
                });
            }
        });
        (endpoint, hits)
    }

    #[tokio::test]
    async fn hosted_callback_requires_issuer_even_when_provider_metadata_does_not() {
        let (token_endpoint, token_hits) = counting_token_endpoint().await;
        let manager =
            McpOAuthManager::new(crate::IdentityStore::open_in_memory().unwrap(), None, None);
        let flow_id = "issuer-bound-hosted".to_owned();
        let mut pending = pending_flow(&flow_id);
        // The selected (possibly malicious) server does not advertise RFC 9207.
        pending.require_issuer_parameter = false;
        pending.token_endpoint = token_endpoint;
        manager.flows.write().await.insert(flow_id.clone(), pending);

        // A relayed, issuerless code arrives at the shared hosted callback with
        // the state the selected server saw.
        let error = manager
            .complete_hosted_callback(
                Some("foreign-code".to_owned()),
                Some("one-time-state".to_owned()),
                None,
                None,
            )
            .await
            .expect_err("a shared hosted callback must bind every response to its issuer");
        assert!(error.to_string().contains("omitted the required issuer"));
        assert_eq!(
            token_hits.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "neither the code nor the PKCE verifier may reach the selected token endpoint"
        );
        let flows = manager.flows.read().await;
        let failed = flows.get(&flow_id).unwrap();
        assert_eq!(failed.view.status, FlowState::Failed);
        assert!(
            failed.verifier.is_empty(),
            "failed callbacks scrub PKCE state"
        );
    }

    #[tokio::test]
    async fn hosted_callback_with_matching_issuer_and_issuerless_loopback_reach_the_token_endpoint()
    {
        let (token_endpoint, token_hits) = counting_token_endpoint().await;
        let manager =
            McpOAuthManager::new(crate::IdentityStore::open_in_memory().unwrap(), None, None);

        // Hosted + the stored issuer (trailing slash is canonicalised away).
        let hosted = "hosted-with-iss".to_owned();
        let mut pending = pending_flow(&hosted);
        pending.token_endpoint = token_endpoint.clone();
        manager.flows.write().await.insert(hosted.clone(), pending);
        let error = manager
            .complete_hosted_callback(
                Some("code".to_owned()),
                Some("one-time-state".to_owned()),
                Some("https://auth.example/".to_owned()),
                None,
            )
            .await
            .expect_err("the fixture token endpoint answers invalid_grant");
        assert!(
            error.to_string().contains("token exchange failed"),
            "{error:#}"
        );
        assert_eq!(token_hits.load(std::sync::atomic::Ordering::SeqCst), 1);

        // Loopback: the per-flow listener port binds the response, so a server
        // that does not support RFC 9207 still completes without `iss`.
        let loopback = "loopback-without-iss".to_owned();
        let mut pending = pending_flow(&loopback);
        pending.view.callback_mode = CallbackMode::Loopback;
        pending.state = "loopback-state".to_owned();
        pending.redirect_uri = "http://127.0.0.1:1/oauth/callback".to_owned();
        pending.token_endpoint = token_endpoint;
        manager
            .flows
            .write()
            .await
            .insert(loopback.clone(), pending);
        let error = manager
            .complete_callback(
                &loopback,
                Some("code".to_owned()),
                Some("loopback-state".to_owned()),
                None,
                None,
            )
            .await
            .expect_err("the fixture token endpoint answers invalid_grant");
        assert!(
            error.to_string().contains("token exchange failed"),
            "{error:#}"
        );
        assert_eq!(token_hits.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn every_error_after_callback_claim_fails_and_scrubs_the_flow() {
        let manager =
            McpOAuthManager::new(crate::IdentityStore::open_in_memory().unwrap(), None, None);
        let flow_id = "post-claim-error".to_owned();
        manager
            .flows
            .write()
            .await
            .insert(flow_id.clone(), pending_flow(&flow_id));

        let error = manager
            .complete_callback(
                &flow_id,
                None,
                Some("one-time-state".to_owned()),
                Some("https://auth.example".to_owned()),
                None,
            )
            .await
            .expect_err("a callback without a code must fail");
        assert!(error.to_string().contains("did not contain a code"));

        let flows = manager.flows.read().await;
        let flow = flows.get(&flow_id).expect("failed flow is retained for UI");
        assert_eq!(flow.view.status, FlowState::Failed);
        assert!(flow
            .view
            .error
            .as_deref()
            .is_some_and(|message| message.contains("did not contain a code")));
        assert!(flow.verifier.is_empty());
        assert!(flow.state.is_empty());
        assert!(flow.client_secret.is_none());
    }

    #[tokio::test]
    async fn connected_transition_rechecks_current_state_and_expiry() {
        let manager =
            McpOAuthManager::new(crate::IdentityStore::open_in_memory().unwrap(), None, None);
        let flow_id = "stale-callback".to_owned();
        let mut flow = pending_flow(&flow_id);
        flow.callback_claimed = true;
        let binding = BindingKey::from_flow(&flow);
        manager.flows.write().await.insert(flow_id.clone(), flow);

        manager
            .ensure_flow_can_connect(&flow_id, &binding)
            .await
            .expect("a live claimed flow may connect");
        manager
            .flows
            .write()
            .await
            .get_mut(&flow_id)
            .expect("flow exists")
            .view
            .status = FlowState::Failed;
        assert!(manager
            .ensure_flow_can_connect(&flow_id, &binding)
            .await
            .is_err());

        let mut expired = pending_flow("expired-callback");
        expired.callback_claimed = true;
        expired.view.expires_at = chrono::Utc::now().timestamp();
        let expired_binding = BindingKey::from_flow(&expired);
        manager
            .flows
            .write()
            .await
            .insert("expired-callback".to_owned(), expired);
        assert!(manager
            .ensure_flow_can_connect("expired-callback", &expired_binding)
            .await
            .is_err());
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpBinding {
    pub owner_user_id: String,
    pub profile_id: String,
    pub plugin_id: String,
    pub server_name: String,
    pub resource_url: String,
    pub client_id: Option<String>,
}

#[cfg(test)]
mod custody_tests {
    use super::*;

    #[tokio::test]
    async fn legacy_oauth_challenge_uses_the_pinned_get_endpoint() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}/sse", listener.local_addr().unwrap())).unwrap();
        let task = tokio::spawn(async move {
            for method in ["POST", "GET"] {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = [0; 8192];
                let count = stream.read(&mut bytes).await.unwrap();
                let text = String::from_utf8_lossy(&bytes[..count]);
                assert!(text.starts_with(method));
                assert!(text
                    .to_ascii_lowercase()
                    .contains("x-workspace: synthetic-workspace-key"));
                let response = if method == "POST" {
                    "HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                } else {
                    "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer resource_metadata=\"https://fixture.example/metadata\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                };
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let headers = [("x-workspace".into(), "synthetic-workspace-key".into())].into();
        let challenge = oauth_challenge(&url, &headers).await.unwrap().unwrap();
        assert!(challenge.contains("resource_metadata"));
        assert!(checked_challenge(
            Some("Bearer scope=synthetic-workspace-key".into()),
            &headers
        )
        .is_err());
        task.await.unwrap();
    }

    async fn legacy_fixture() -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let writers: Arc<Mutex<HashMap<usize, tokio::net::tcp::OwnedWriteHalf>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let closed = Arc::new(AtomicUsize::new(0));
        let closed_count = closed.clone();
        let task = tokio::spawn(async move {
            let mut next = 0;
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                next += 1;
                let id = next;
                let writers = writers.clone();
                let closed = closed_count.clone();
                tokio::spawn(async move {
                    let mut bytes = Vec::new();
                    let headers_end = loop {
                        let mut buffer = [0; 1024];
                        let n = stream.read(&mut buffer).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&buffer[..n]);
                        if let Some(at) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                            break at + 4;
                        }
                    };
                    let headers = String::from_utf8_lossy(&bytes[..headers_end]).to_string();
                    assert!(headers
                        .to_ascii_lowercase()
                        .contains("authorization: bearer fixture-fresh"));
                    assert!(headers
                        .to_ascii_lowercase()
                        .contains("x-workspace: fixture-workspace-secret"));
                    if headers.starts_with("GET ") {
                        if headers.starts_with("GET /unauthorized") {
                            stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer error=\"invalid_token\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                            return;
                        }
                        let (mut reader, mut writer) = stream.into_split();
                        writer.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
                        let endpoint = if headers.starts_with("GET /cross") {
                            "https://other.example/message".into()
                        } else {
                            format!("/message?session={id}")
                        };
                        let event = format!("event: endpoint\r\ndata: {endpoint}\r\n\r\n");
                        writer
                            .write_all(format!("{:x}\r\n{}\r\n", event.len(), event).as_bytes())
                            .await
                            .unwrap();
                        writers.lock().await.insert(id, writer);
                        let mut buf = [0; 1];
                        let _ = reader.read(&mut buf).await;
                        closed.fetch_add(1, Ordering::SeqCst);
                        writers.lock().await.remove(&id);
                        return;
                    }
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|v| v.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    while bytes.len() < headers_end + length {
                        let mut buf = [0; 1024];
                        let n = stream.read(&mut buf).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&buf[..n]);
                    }
                    let frame: serde_json::Value =
                        serde_json::from_slice(&bytes[headers_end..headers_end + length]).unwrap();
                    let notification =
                        r#"{"jsonrpc":"2.0","method":"notifications/post-accepted"}"#;
                    stream.write_all(format!("HTTP/1.1 202 Accepted\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{notification}",notification.len()).as_bytes()).await.unwrap();
                    if frame.get("id").is_none() || frame["method"] == "stall" {
                        return;
                    }
                    let path = headers
                        .lines()
                        .next()
                        .unwrap()
                        .split_whitespace()
                        .nth(1)
                        .unwrap();
                    let session = Url::parse(&format!("http://fixture{path}"))
                        .unwrap()
                        .query_pairs()
                        .find(|(k, _)| k == "session")
                        .unwrap()
                        .1
                        .parse::<usize>()
                        .unwrap();
                    let value = if frame["method"] == "echo" {
                        serde_json::json!({"header":"fixture-workspace-secret"})
                    } else {
                        serde_json::json!({"ok":true})
                    };
                    let response =
                        serde_json::json!({"jsonrpc":"2.0","id":frame["id"],"result":value});
                    let event = format!(
                        ": heartbeat\n\ndata: {{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}}\n\ndata: {response}\n\n"
                    );
                    if let Some(writer) = writers.lock().await.get_mut(&session) {
                        writer
                            .write_all(format!("{:x}\r\n{}\r\n", event.len(), event).as_bytes())
                            .await
                            .unwrap();
                    }
                });
            }
        });
        (origin, closed, task)
    }
    async fn configured_seed(
        base: &str,
        path: &str,
    ) -> (
        Arc<McpOAuthManager>,
        McpBinding,
        crate::mcp_transport::McpConfiguration,
    ) {
        let (manager, binding) = seeded(base, path, false).await;
        let configuration = crate::mcp_transport::McpConfiguration {
            transport: crate::mcp_transport::TransportMode::Sse,
            static_headers: [("x-workspace".into(), "fixture-workspace-secret".into())].into(),
        };
        let record = manager
            .store
            .find_mcp_oauth_connection("owner", "profile", "plugin", "server")
            .await
            .unwrap()
            .unwrap();
        let mut bundle = open_bundle(&manager.store, &record).await.unwrap();
        bundle.static_headers_hash = crate::mcp_transport::McpConfiguration {
            static_headers: configuration.static_headers.clone(),
            ..Default::default()
        }
        .fingerprint()
        .unwrap();
        manager
            .store
            .upsert_mcp_oauth_connection(
                "owner",
                "profile",
                "plugin",
                "server",
                base,
                base,
                None,
                &[],
                Some(i64::MAX),
                &SecretState::new(serde_json::to_string(&bundle).unwrap()),
            )
            .await
            .unwrap();
        (manager, binding, configuration)
    }
    #[tokio::test]
    async fn legacy_sse_consumes_pinned_headers_and_closes_on_cancellation() {
        let (base, closed, task) = legacy_fixture().await;
        let (manager, binding, config) = configured_seed(&base, "sse").await;
        let mut session = None;
        let response = manager
            .consume_configured(
                &binding,
                vec![],
                br#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#.to_vec(),
                crate::ConnectionAction::Read,
                false,
                false,
                &config,
                &mut session,
            )
            .await
            .unwrap();
        assert_eq!(response.status, 200);
        let text = String::from_utf8(response.body).unwrap();
        assert!(text.contains("notifications/progress"));
        assert!(text.contains("notifications/post-accepted"));
        assert!(text.contains("\"ok\":true"));
        assert!(session.is_some());
        let response = manager
            .consume_configured(
                &binding,
                vec![],
                br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.to_vec(),
                crate::ConnectionAction::Read,
                false,
                false,
                &config,
                &mut session,
            )
            .await
            .unwrap();
        assert_eq!(response.status, 202);
        let mut changed = config.clone();
        changed
            .static_headers
            .insert("x-workspace".into(), "other".into());
        assert!(manager
            .consume_configured(
                &binding,
                vec![],
                vec![],
                crate::ConnectionAction::Read,
                false,
                false,
                &changed,
                &mut session
            )
            .await
            .is_err());
        assert!(manager
            .consume_configured(
                &binding,
                vec![],
                br#"{"jsonrpc":"2.0","id":2,"method":"echo"}"#.to_vec(),
                crate::ConnectionAction::Read,
                false,
                false,
                &config,
                &mut session
            )
            .await
            .is_err());
        let timed = tokio::time::timeout(
            Duration::from_millis(50),
            manager.consume_configured(
                &binding,
                vec![],
                br#"{"jsonrpc":"2.0","id":3,"method":"stall"}"#.to_vec(),
                crate::ConnectionAction::Read,
                false,
                false,
                &config,
                &mut session,
            ),
        )
        .await;
        assert!(timed.is_err());
        drop(session);
        tokio::time::timeout(Duration::from_secs(1), async {
            while closed.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        manager.disconnect_plugin("plugin").await.unwrap();
        task.abort();
    }
    #[tokio::test]
    async fn legacy_sse_rejects_cross_origin_and_preserves_authentication_challenge() {
        let (base, _, task) = legacy_fixture().await;
        let (manager, binding, config) = configured_seed(&base, "cross").await;
        assert!(manager
            .consume_configured(
                &binding,
                vec![],
                vec![],
                crate::ConnectionAction::Read,
                false,
                false,
                &config,
                &mut None
            )
            .await
            .is_err());
        let (manager, binding, config) = configured_seed(&base, "unauthorized").await;
        let response = manager
            .consume_configured(
                &binding,
                vec![],
                vec![],
                crate::ConnectionAction::Read,
                false,
                false,
                &config,
                &mut None,
            )
            .await
            .unwrap();
        assert_eq!(response.status, 401);
        assert!(response
            .headers
            .iter()
            .any(|(k, v)| k == "www-authenticate" && v.contains("invalid_token")));
        task.abort();
    }

    #[test]
    fn consent_requests_challenge_then_resource_scopes_before_server_scopes() {
        let owned = |values: &[&str]| values.iter().map(|v| (*v).to_owned()).collect::<Vec<_>>();
        let resource = owned(&["mail.read"]);
        let server = owned(&["mail.read", "mail.send", "directory.admin"]);
        assert_eq!(
            consent_scopes(owned(&["mail.send"]), &resource, &server),
            ["mail.send"]
        );
        assert_eq!(consent_scopes(vec![], &resource, &server), ["mail.read"]);
        assert_eq!(
            consent_scopes(vec![], &[], &server),
            ["directory.admin", "mail.read", "mail.send"]
        );
        assert!(consent_scopes(vec![], &[], &[]).is_empty());
        // Refresh-token issuance is preserved when the server gates it on
        // offline_access, without widening resource authority.
        let server_with_refresh = owned(&["mail.read", "directory.admin", "offline_access"]);
        assert_eq!(
            consent_scopes(vec![], &resource, &server_with_refresh),
            ["mail.read", "offline_access"]
        );
        // A step-up challenge stays exactly what the resource asked for.
        assert_eq!(
            consent_scopes(owned(&["mail.send"]), &resource, &server_with_refresh),
            ["mail.send"]
        );
    }

    #[tokio::test]
    async fn hosted_flow_start_refuses_a_server_without_rfc9207_issuer_support() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let provider = origin.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let origin = provider.clone();
                tokio::spawn(async move {
                    let mut buffer = vec![0; 16384];
                    let n = stream.read(&mut buffer).await.unwrap();
                    let request = String::from_utf8_lossy(&buffer[..n]);
                    let body = if request.contains("/.well-known/oauth-protected-resource") {
                        serde_json::json!({"resource":origin,"authorization_servers":[origin],"scopes_supported":["read"]})
                    } else {
                        serde_json::json!({"issuer":origin,"authorization_endpoint":format!("{origin}/authorize"),"token_endpoint":format!("{origin}/token"),"code_challenge_methods_supported":["S256"],"scopes_supported":["read"]})
                    }
                    .to_string();
                    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                });
            }
        });
        let manager = McpOAuthManager::new(
            crate::IdentityStore::open_in_memory().unwrap(),
            Some("https://passport.example/callback".into()),
            None,
        );
        let spec = |callback_mode| ConnectSpec {
            access_level: crate::ConnectionAccessLevel::ReadOnly,
            owner_user_id: "owner".into(),
            profile_id: "profile".into(),
            plugin_id: "plugin".into(),
            server_name: "server".into(),
            resource_url: format!("{origin}/mcp"),
            auth: OAuthClient {
                client_id: Some("client".into()),
            },
            callback_mode,
            static_headers: Default::default(),
            challenge: Some(format!(
                "Bearer resource_metadata=\"{origin}/.well-known/oauth-protected-resource\""
            )),
        };
        // Hosted (explicit, and Auto on a node with an HTTPS public URL) is
        // refused up front with an actionable message.
        for mode in [CallbackMode::Hosted, CallbackMode::Auto] {
            let error = manager
                .start_connect(spec(mode))
                .await
                .expect_err("hosted flows need RFC 9207 issuer support");
            assert!(error.to_string().contains("RFC 9207"), "{error}");
        }
        // A loopback flow binds the redirect itself, so the same server starts.
        manager
            .start_connect(spec(CallbackMode::Loopback))
            .await
            .expect("loopback flows do not need `iss`");
        task.abort();
    }

    #[tokio::test]
    async fn discovery_pkce_hosted_callback_and_metadata_roundtrip() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let provider = origin.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let origin = provider.clone();
                tokio::spawn(async move {
                    let mut buffer = vec![0; 16384];
                    let n = stream.read(&mut buffer).await.unwrap();
                    let request = String::from_utf8_lossy(&buffer[..n]);
                    let body=if request.contains("/.well-known/oauth-protected-resource") {
                        serde_json::json!({"resource":origin,"authorization_servers":[origin],"scopes_supported":["read"]})
                    } else if request.contains("/.well-known/oauth-authorization-server") {
                        serde_json::json!({"issuer":origin,"authorization_endpoint":format!("{origin}/authorize"),"token_endpoint":format!("{origin}/token"),"code_challenge_methods_supported":["S256"],"authorization_response_iss_parameter_supported":true,"scopes_supported":["read","directory.admin","offline_access"]})
                    } else {
                        assert!(request.contains("code_verifier=")); assert!(request.contains("grant_type=authorization_code"));
                        serde_json::json!({"access_token":"fixture-authorized","refresh_token":"fixture-rotation","expires_in":3600})
                    }.to_string();
                    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
                });
            }
        });
        let manager = McpOAuthManager::new(
            crate::IdentityStore::open_in_memory().unwrap(),
            Some("https://passport.example/callback".into()),
            None,
        );
        let started = manager
            .start_connect(ConnectSpec {
                access_level: crate::ConnectionAccessLevel::ReadOnly,
                owner_user_id: "owner".into(),
                profile_id: "profile".into(),
                plugin_id: "plugin".into(),
                server_name: "server".into(),
                resource_url: format!("{origin}/mcp"),
                auth: OAuthClient {
                    client_id: Some("client".into()),
                },
                callback_mode: CallbackMode::Hosted,
                static_headers: Default::default(),
                challenge: Some(format!(
                    "Bearer resource_metadata=\"{origin}/.well-known/oauth-protected-resource\""
                )),
            })
            .await
            .unwrap();
        let url = Url::parse(&started.authorization_url).unwrap();
        let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
        assert_eq!(params["code_challenge_method"], "S256");
        assert_eq!(params["redirect_uri"], "https://passport.example/callback");
        // Only the protected resource's scopes (plus offline_access for a
        // refresh token), not the server-wide list.
        assert_eq!(params["scope"], "offline_access read");
        assert!(manager.flow("other", &started.flow_id).await.is_err());
        assert!(manager
            .complete_hosted_callback(
                Some("code".into()),
                Some("wrong-state".into()),
                Some(origin.clone()),
                None
            )
            .await
            .is_err());
        manager
            .complete_hosted_callback(
                Some("code".into()),
                Some(params["state"].clone()),
                Some(origin),
                None,
            )
            .await
            .unwrap();
        let flow = manager.flow("owner", &started.flow_id).await.unwrap();
        assert_eq!(flow.status, FlowState::Connected);
        assert!(!serde_json::to_string(&flow)
            .unwrap()
            .contains("fixture-authorized"));
        let rows = manager
            .store
            .list_mcp_oauth_connections("owner", "plugin")
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].encrypted_state.is_some());
        assert!(!serde_json::to_string(&rows)
            .unwrap()
            .contains("fixture-rotation"));
        assert!(manager
            .complete_hosted_callback(
                Some("code".into()),
                Some(params["state"].clone()),
                None,
                None
            )
            .await
            .is_err());
        task.abort();
    }

    use std::sync::atomic::{AtomicUsize, Ordering};
    async fn fixture() -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let count = Arc::new(AtomicUsize::new(0));
        let calls = count.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let calls = calls.clone();
                tokio::spawn(async move {
                    let mut bytes = vec![0; 65536];
                    let n = stream.read(&mut bytes).await.unwrap();
                    let request = String::from_utf8_lossy(&bytes[..n]);
                    let (status, headers, body) = if request.starts_with("POST /token") {
                        calls.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        (
                            "200 OK",
                            "",
                            "{\"access_token\":\"fixture-fresh\",\"refresh_token\":\"fixture-refresh\",\"expires_in\":3600}",
                        )
                    } else if request.starts_with("POST /redirect") {
                        ("302 Found", "Location: http://127.0.0.1/forbidden\r\n", "")
                    } else if request.starts_with("POST /echo") {
                        ("200 OK", "", "fixture-fresh")
                    } else {
                        assert!(request
                            .to_ascii_lowercase()
                            .contains("authorization: bearer fixture-fresh"));
                        (
                            "200 OK",
                            "Content-Type: text/event-stream\r\n",
                            "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n\n",
                        )
                    };
                    let response = format!(
                        "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    stream.write_all(response.as_bytes()).await.unwrap();
                });
            }
        });
        (url, count, task)
    }
    async fn seeded(base: &str, path: &str, expired: bool) -> (Arc<McpOAuthManager>, McpBinding) {
        let store = crate::IdentityStore::open_in_memory().unwrap();
        let binding = McpBinding {
            owner_user_id: "owner".into(),
            profile_id: "profile".into(),
            plugin_id: "plugin".into(),
            server_name: "server".into(),
            resource_url: format!("{base}/{path}"),
            client_id: Some("client".into()),
        };
        let bundle = TokenBundle {
            access_token: if expired {
                "fixture-old"
            } else {
                "fixture-fresh"
            }
            .into(),
            refresh_token: Some("fixture-refresh".into()),
            id_token: None,
            token_type: "Bearer".into(),
            client_id: "client".into(),
            client_secret: None,
            token_endpoint: format!("{base}/token"),
            revocation_endpoint: None,
            issuer: base.into(),
            resource: base.into(),
            mcp_server_url: binding.resource_url.clone(),
            declared_client_id: binding.client_id.clone(),
            static_headers_hash: crate::mcp_transport::default_configuration_hash(),
        };
        store
            .upsert_mcp_oauth_connection(
                "owner",
                "profile",
                "plugin",
                "server",
                base,
                base,
                None,
                &[],
                Some(if expired { 0 } else { i64::MAX }),
                &SecretState::new(serde_json::to_string(&bundle).unwrap()),
            )
            .await
            .unwrap();
        (McpOAuthManager::new(store, None, None), binding)
    }
    #[tokio::test]
    async fn refresh_is_serialized_consumption_is_sealed_and_uninstall_wins() {
        let (base, count, task) = fixture().await;
        let (manager, binding) = seeded(&base, "mcp", true).await;
        let consume = || {
            manager.consume(
                &binding,
                vec![],
                b"{}".to_vec(),
                crate::ConnectionAction::Read,
                false,
                true,
            )
        };
        let (a, b) = tokio::join!(consume(), consume());
        assert_eq!(a.unwrap().status, 200);
        assert_eq!(b.unwrap().status, 200);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let (consumed, removed) = tokio::join!(consume(), manager.disconnect_plugin("plugin"));
        consumed.unwrap();
        removed.unwrap();
        assert!(consume().await.is_err());
        assert!(manager
            .store
            .list_mcp_oauth_connections("owner", "plugin")
            .await
            .unwrap()
            .is_empty());
        task.abort();
    }
    #[tokio::test]
    async fn exact_binding_and_response_custody_are_enforced() {
        let (base, _, task) = fixture().await;
        let (manager, binding) = seeded(&base, "mcp", false).await;
        for index in 0..6 {
            let mut other = binding.clone();
            match index {
                0 => other.owner_user_id.push('x'),
                1 => other.profile_id.push('x'),
                2 => other.plugin_id.push('x'),
                3 => other.server_name.push('x'),
                4 => other.resource_url.push('x'),
                _ => other.client_id = Some("other".into()),
            }
            assert!(manager
                .consume(
                    &other,
                    vec![],
                    vec![],
                    crate::ConnectionAction::Read,
                    false,
                    false
                )
                .await
                .is_err());
        }
        let (manager, binding) = seeded(&base, "echo", false).await;
        assert!(manager
            .consume(
                &binding,
                vec![],
                vec![],
                crate::ConnectionAction::Read,
                false,
                false
            )
            .await
            .is_err());
        let (manager, binding) = seeded(&base, "redirect", false).await;
        let result = manager
            .consume(
                &binding,
                vec![],
                vec![],
                crate::ConnectionAction::Read,
                false,
                false,
            )
            .await
            .unwrap();
        assert_eq!(result.status, 302);
        assert!(result
            .headers
            .iter()
            .all(|(name, _)| !name.eq_ignore_ascii_case("location")));
        assert!(manager
            .consume(
                &binding,
                vec![("authorization".into(), "Bearer other".into())],
                vec![],
                crate::ConnectionAction::Read,
                false,
                false
            )
            .await
            .is_err());
        task.abort();
    }
    #[tokio::test]
    async fn callback_race_cannot_resurrect_an_uninstalled_connection() {
        let (base, count, task) = fixture().await;
        let (manager, _) = seeded(&base, "mcp", true).await;
        let mut pending = super::tests::pending_flow("racing");
        pending.token_endpoint = format!("{base}/token");
        pending.view.plugin_id = "plugin".into();
        let state = pending.state.clone();
        manager.flows.write().await.insert("racing".into(), pending);
        let callback = manager.complete_callback(
            "racing",
            Some("fixture-code".into()),
            Some(state.clone()),
            Some("https://auth.example".into()),
            None,
        );
        let uninstall = async {
            while count.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
            manager.disconnect_plugin("plugin").await.unwrap();
        };
        let (result, _) = tokio::join!(callback, uninstall);
        assert!(result.is_err());
        assert!(manager
            .store
            .list_mcp_oauth_connections_for_plugin("plugin")
            .await
            .unwrap()
            .is_empty());
        assert!(manager
            .complete_callback(
                "racing",
                Some("fixture-code".into()),
                Some(state),
                Some("https://auth.example".into()),
                None
            )
            .await
            .is_err());
        task.abort();
    }
}
