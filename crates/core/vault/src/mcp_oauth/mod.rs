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

mod callback;
mod callback_page;
mod confirm;
#[cfg(test)]
mod confirm_tests;
mod connect;
#[cfg(test)]
mod custody_fixtures;
#[cfg(test)]
mod custody_legacy_tests;
#[cfg(test)]
mod custody_tests;
mod disconnect;
mod discovery;
mod requests;
#[cfg(test)]
mod tests;
mod tokens;

use callback_page::*;
pub use callback_page::{
    render_callback_page, render_confirmation_page, set_callback_page_copy, CallbackPageCopy,
    CallbackPageCopyFn,
};
use discovery::*;
use requests::*;
pub use requests::{connection_key, request};

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
    /// A hosted callback exchanged the code; the initiating owner must enter
    /// the confirmation code the browser showed before anything is stored.
    AwaitingConfirmation,
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
    /// Tokens a hosted callback obtained, held until the owner confirms.
    held: Option<confirm::HeldConnection>,
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
