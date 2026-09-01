//! Core-owned OAuth 2.1 broker for authenticated remote MCP servers.
//!
//! Publishers declare only `auth: { type: "oauth", client_id? }`. This module
//! owns discovery, PKCE, token exchange, refresh/revocation and the browser
//! callback. Token bundles are serialized only long enough to enter the encrypted
//! Identity Vault and are never returned through the API.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};
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

use crate::identity::{McpOAuthConnectionRecord, McpOAuthConnectionStatus, SecretState};
use crate::plugin_manifest::McpServerAuthDecl;
use crate::sidecar::mcp::client::{self, McpHttpEndpoint, McpHttpFailure, McpTarget};

const LOCAL_OWNER: &str = "local";
const DEFAULT_PROFILE: &str = "personal";
const FLOW_TTL_SECS: i64 = 10 * 60;
const MAX_OAUTH_BODY_BYTES: usize = 1024 * 1024;
const REFRESH_SKEW_SECS: i64 = 60;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum CallbackMode {
    Auto,
    Loopback,
    Hosted,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct ConnectStarted {
    pub access_level: String,
    pub flow_id: String,
    pub authorization_url: String,
    pub callback_mode: CallbackMode,
    pub scopes: Vec<String>,
    pub status: FlowState,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FlowState {
    Pending,
    Connected,
    Failed,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
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

#[derive(Debug, Clone)]
pub struct ConnectSpec {
    pub access_level: crate::identity::ConnectionAccessLevel,
    pub owner_user_id: String,
    pub profile_id: String,
    pub plugin_id: String,
    pub server_name: String,
    pub resource_url: String,
    pub auth: McpServerAuthDecl,
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

#[derive(Debug, Deserialize)]
struct TokenResponse {
    #[serde(default)]
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    token_type: Option<String>,
    expires_in: Option<i64>,
    scope: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Clone)]
struct PendingFlow {
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

#[derive(Default)]
pub struct McpOAuthManager {
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

static MANAGER: OnceLock<McpOAuthManager> = OnceLock::new();

pub fn global() -> &'static McpOAuthManager {
    MANAGER.get_or_init(McpOAuthManager::default)
}

/// Principal used by OAuth REST handlers. A personal node has one stable local
/// owner. A shared node never accepts an unresolved user identity.
pub fn owner_for_caller(caller: Option<&crate::identity_verify::VerifiedCaller>) -> Result<String> {
    if let Some(caller) = caller {
        return Ok(caller.user_id.clone());
    }
    if crate::sidecar::control_plane::registered_org().is_some() {
        bail!("a verified user identity is required for MCP OAuth on a shared node");
    }
    Ok(LOCAL_OWNER.to_owned())
}

pub fn default_profile_id() -> &'static str {
    DEFAULT_PROFILE
}

impl McpOAuthManager {
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

    pub async fn start_connect(&'static self, spec: ConnectSpec) -> Result<ConnectStarted> {
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

        let hosted_redirect = hosted_callback_url();
        let callback_mode = match spec.callback_mode {
            CallbackMode::Auto if hosted_redirect.is_some() => CallbackMode::Hosted,
            CallbackMode::Auto => CallbackMode::Loopback,
            mode => mode,
        };
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
            .then(hosted_client_metadata_url)
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
        let requested_scopes = if challenge_scopes.is_empty() {
            resource_metadata
                .scopes_supported
                .clone()
                .into_iter()
                .chain(metadata.scopes_supported.clone())
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect()
        } else {
            challenge_scopes
        };
        let mut scopes: std::collections::BTreeSet<String> = requested_scopes.into_iter().collect();
        if let Some(store) = crate::identity::global() {
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
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(FLOW_TTL_SECS as u64)).await;
            global().expire_flow(&expiry_flow_id).await;
        });
        if let Some(listener) = listener {
            tokio::spawn(accept_loopback_callback(listener, flow_id.clone()));
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
        if let Some(returned_issuer) = returned_issuer.as_deref() {
            if trim_trailing_slash(returned_issuer) != trim_trailing_slash(&pending.issuer) {
                bail!("OAuth issuer did not match");
            }
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
        let store = crate::identity::global().context("identity store not initialized")?;
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
                crate::connection_policy::MCP_PROVIDER,
                &crate::connection_policy::mcp_connection_key(
                    &pending.view.profile_id,
                    &pending.view.plugin_id,
                    &pending.view.server_name,
                ),
                crate::identity::ConnectionAccessLevel::from_str(&pending.view.access_level),
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
        action: crate::identity::ConnectionAction,
        risk_approved: bool,
        force_refresh: bool,
        session_id: Option<String>,
    ) -> Result<String> {
        let binding = BindingKey::new(owner_user_id, profile_id, plugin_id, server_name);
        let plugin_lock = self.plugin_lock(plugin_id).await;
        let _plugin_guard = plugin_lock.read().await;
        let lifecycle_lock = self.lifecycle_lock(&binding).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        let store = crate::identity::global().context("identity store not initialized")?;
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
                crate::connection_policy::MCP_PROVIDER,
                &crate::connection_policy::mcp_connection_key(profile_id, plugin_id, server_name),
            )
            .await?;
        if !access_level.allows_with_approval(action, risk_approved) {
            bail!(
                "{}",
                crate::connection_policy::denied_message("MCP", server_name, access_level, action,)
            );
        }
        let stored_bundle = open_bundle_governed(store, &connection, session_id).await?;
        let binding_changed = stored_bundle.mcp_server_url.is_empty()
            || validate_oauth_url(&stored_bundle.mcp_server_url, true)?
                != validate_oauth_url(expected_resource, true)?
            || stored_bundle.declared_client_id.as_deref() != expected_client_id;
        if binding_changed {
            store.mark_mcp_oauth_reauth_required(&connection.id).await?;
            bail!("the MCP OAuth binding changed; reconnect required");
        }
        let refresh_needed = force_refresh
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
            bail!("OAuth refresh failed: {error}");
        }
        if response.access_token.is_empty() {
            bail!("OAuth refresh returned no access token");
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
        Ok(updated.access_token)
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
        self.flows.write().await.retain(|_, flow| {
            !(flow.owner_user_id == binding.owner_user_id
                && flow.view.profile_id == binding.profile_id
                && flow.view.plugin_id == binding.plugin_id
                && flow.view.server_name == binding.server_name)
        });
        let store = crate::identity::global().context("identity store not initialized")?;
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
        let store = crate::identity::global().context("identity store not initialized")?;
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
    store: &crate::identity::IdentityStore,
    connection: &McpOAuthConnectionRecord,
) -> Result<TokenBundle> {
    let secret = store
        .open_mcp_oauth_state(&connection.id)
        .await?
        .context("MCP OAuth connection has no token state")?;
    serde_json::from_str(secret.expose()).context("opening MCP OAuth token bundle")
}

async fn open_bundle_governed(
    store: &crate::identity::IdentityStore,
    connection: &McpOAuthConnectionRecord,
    session_id: Option<String>,
) -> Result<TokenBundle> {
    use crate::sidecar::gateway::{
        check_identity_grant, report_credential_read_audit, IdentityGrantOutcome,
    };

    match check_identity_grant("identity.read", &connection.plugin_id).await {
        IdentityGrantOutcome::Allow => {}
        IdentityGrantOutcome::Deny(reason) => {
            bail!("identity read denied for MCP OAuth: {reason}");
        }
    }
    let bundle = open_bundle(store, connection).await?;
    report_credential_read_audit("mcp-oauth", &connection.resource_uri, session_id, None).await;
    Ok(bundle)
}

async fn oauth_challenge(
    resource: &Url,
    headers: &std::collections::BTreeMap<String, String>,
) -> Result<Option<String>> {
    let target = McpTarget::Http(McpHttpEndpoint {
        url: resource.as_str().to_owned(),
        headers: headers.clone(),
    });
    match client::list_tools(&target).await {
        Ok(_) => bail!("MCP server did not request OAuth authentication"),
        Err(error) => {
            for cause in error.chain() {
                if let Some(failure) = cause.downcast_ref::<McpHttpFailure>() {
                    if failure.status == reqwest::StatusCode::UNAUTHORIZED {
                        return Ok(failure.www_authenticate.clone());
                    }
                }
            }
            Err(error).context("probing the MCP server for an OAuth challenge")
        }
    }
}

async fn accept_loopback_callback(listener: TcpListener, flow_id: String) {
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
        let completion = global()
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
        let _ = global().fail_flow(&flow_id, &error.to_string()).await;
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
    let parsed = validate_oauth_url(url, false)?;
    let bytes = if is_loopback_http(&parsed) {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let response = client.get(parsed).send().await?;
        if !response.status().is_success() {
            bail!(
                "OAuth metadata endpoint returned HTTP {}",
                response.status()
            );
        }
        response.bytes().await?.to_vec()
    } else {
        crate::server::guarded_get_bytes(parsed.as_str()).await?
    };
    if bytes.len() > MAX_OAUTH_BODY_BYTES {
        bail!("OAuth metadata response exceeded the 1 MiB limit");
    }
    serde_json::from_slice(&bytes).context("parsing OAuth metadata")
}

async fn post_json<T: for<'de> Deserialize<'de>>(url: &str, body: &serde_json::Value) -> Result<T> {
    let (client, parsed) = oauth_client(url).await?;
    let response = client.post(parsed).json(body).send().await?;
    parse_json_response(response).await
}

async fn post_token_form(url: &str, form: &[(&str, String)]) -> Result<TokenResponse> {
    let (client, parsed) = oauth_client(url).await?;
    let response = client.post(parsed).form(form).send().await?;
    let status = response.status();
    let bytes = response.bytes().await?;
    if bytes.len() > MAX_OAUTH_BODY_BYTES {
        bail!("OAuth token response exceeded the 1 MiB limit");
    }
    parse_token_response(status, &bytes)
}

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
    let (client, parsed) = oauth_client(url).await?;
    let response = client.post(parsed).form(form).send().await?;
    if !response.status().is_success() {
        bail!(
            "OAuth revocation endpoint returned HTTP {}",
            response.status()
        );
    }
    Ok(())
}

async fn oauth_client(url: &str) -> Result<(reqwest::Client, Url)> {
    let parsed = validate_oauth_url(url, false)?;
    if is_loopback_http(&parsed) {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        return Ok((client, parsed));
    }
    crate::server::guarded_client(parsed.as_str())
        .await
        .map_err(anyhow::Error::msg)
}

async fn parse_json_response<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
) -> Result<T> {
    let status = response.status();
    let bytes = response.bytes().await?;
    if bytes.len() > MAX_OAUTH_BODY_BYTES {
        bail!("OAuth endpoint response exceeded the 1 MiB limit");
    }
    if !status.is_success() {
        let error: TokenResponse = serde_json::from_slice(&bytes).unwrap_or(TokenResponse {
            access_token: String::new(),
            refresh_token: None,
            id_token: None,
            token_type: None,
            expires_in: None,
            scope: None,
            error: Some(format!("HTTP {status}")),
            error_description: None,
        });
        bail!(
            "OAuth endpoint rejected the request: {}",
            error
                .error_description
                .or(error.error)
                .unwrap_or_else(|| "request failed".to_owned())
        );
    }
    serde_json::from_slice(&bytes).context("parsing OAuth endpoint response")
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

fn hosted_callback_url() -> Option<String> {
    let base = crate::sidecar::control_plane::node_public_url()?;
    let mut url = Url::parse(&base).ok()?;
    if url.scheme() != "https" || url.username() != "" || url.password().is_some() {
        return None;
    }
    url.set_path("/api/mcp/oauth/callback");
    url.set_query(None);
    url.set_fragment(None);
    Some(url.into())
}

pub fn hosted_client_metadata_url() -> Option<String> {
    let callback = hosted_callback_url()?;
    let mut url = Url::parse(&callback).ok()?;
    url.set_path("/api/mcp/oauth/client-metadata.json");
    Some(url.into())
}

pub fn hosted_redirect_uri() -> Option<String> {
    hosted_callback_url()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending_flow(flow_id: &str) -> PendingFlow {
        PendingFlow {
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
    fn token_bundle_debug_is_always_redacted() {
        let bundle = TokenBundle {
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
        let manager = McpOAuthManager::default();
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

    #[tokio::test]
    async fn every_error_after_callback_claim_fails_and_scrubs_the_flow() {
        let manager = McpOAuthManager::default();
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
                None,
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
        let manager = McpOAuthManager::default();
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
