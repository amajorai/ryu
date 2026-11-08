//! OAuth-backed broker services.
//!
//! A service whose auth is [`OAuthBinding`] injects `Authorization: Bearer`
//! with the access token of a connected MCP OAuth binding (plugin, server,
//! profile) instead of a `secret:` reference. The token comes from the vault's
//! MCP OAuth manager, which refreshes it shortly before it expires and marks
//! the binding for reconnect when the refresh grant is rejected. The token is
//! resolved per request for the session minter's own connection and is never
//! stored, logged, or returned.
//!
//! The service's host must be the host of the binding's resource URL, so a
//! service cannot carry a token to a host its consent was not granted for.
//! A service may list the scopes it needs; a connection that lacks any of them
//! reports `needs_scopes` and the broker refuses the request rather than
//! sending a token the upstream will reject.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{bail, Result};
use hyper::{Method, StatusCode};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::identity::{ConnectionAction, McpOAuthConnectionRecord, McpOAuthConnectionStatus};

/// Most scopes a service may require.
pub const MAX_SCOPES: usize = 32;
const MAX_ID_LEN: usize = 128;
const MAX_RESOURCE_LEN: usize = 2048;
const MAX_SCOPE_LEN: usize = 128;

/// The MCP OAuth binding a service draws its access token from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthBinding {
    /// Plugin that owns the MCP server (for example `@ryu/linear`).
    pub plugin: String,
    /// The MCP server's manifest key.
    pub server: String,
    /// Identity profile the connection belongs to.
    #[serde(default = "default_profile")]
    pub profile: String,
    /// The exact MCP server URL the consent was created for.
    pub resource: String,
    /// The publisher-declared public client id, when the manifest has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    /// Scopes the service needs; a connection missing any reports
    /// `needs_scopes`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scopes: Vec<String>,
}

fn default_profile() -> String {
    crate::mcp_oauth::default_profile_id().to_owned()
}

fn is_safe_id(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && !value.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// RFC 6749 `scope-token`: `%x21 / %x23-5B / %x5D-7E`.
fn is_scope_token(scope: &str) -> bool {
    !scope.is_empty()
        && scope.len() <= MAX_SCOPE_LEN
        && scope
            .bytes()
            .all(|b| b == 0x21 || (0x23..=0x5B).contains(&b) || (0x5D..=0x7E).contains(&b))
}

fn is_loopback_http(url: &Url) -> bool {
    url.scheme() == "http"
        && url.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .trim_start_matches('[')
                    .trim_end_matches(']')
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        })
}

impl OAuthBinding {
    /// The parsed resource URL: HTTPS, or HTTP on loopback only, with no
    /// userinfo or fragment.
    pub fn resource_url(&self) -> Result<Url> {
        if self.resource.len() > MAX_RESOURCE_LEN {
            bail!("oauth resource URL is too long");
        }
        let url = Url::parse(&self.resource)
            .map_err(|_| anyhow::anyhow!("oauth resource must be an absolute URL"))?;
        if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            bail!("oauth resource must not contain userinfo or a fragment");
        }
        if url.scheme() != "https" && !is_loopback_http(&url) {
            bail!("oauth resource must use https (http only on loopback)");
        }
        if url.host_str().is_none() {
            bail!("oauth resource must name a host");
        }
        Ok(url)
    }

    pub(crate) fn validate(&self) -> Result<()> {
        if !is_safe_id(&self.plugin, MAX_ID_LEN) {
            bail!("oauth plugin must be 1-{MAX_ID_LEN} characters without spaces");
        }
        if !is_safe_id(&self.server, MAX_ID_LEN) {
            bail!("oauth server must be 1-{MAX_ID_LEN} characters without spaces");
        }
        if !is_safe_id(&self.profile, MAX_ID_LEN) {
            bail!("oauth profile must be 1-{MAX_ID_LEN} characters without spaces");
        }
        if let Some(client_id) = &self.client_id {
            if !is_safe_id(client_id, 256) {
                bail!("oauth clientId is invalid");
            }
        }
        if self.scopes.len() > MAX_SCOPES {
            bail!("an oauth service may require at most {MAX_SCOPES} scopes");
        }
        if let Some(scope) = self.scopes.iter().find(|scope| !is_scope_token(scope)) {
            bail!(
                "oauth scope `{}` is not a valid scope token",
                scope.escape_debug()
            );
        }
        self.resource_url().map(drop)
    }

    /// Check the service's host, port, and scheme against the resource: the
    /// token only ever goes to the host its consent was granted for.
    pub(crate) fn validate_target(
        &self,
        host: &str,
        port: Option<u16>,
        allow_insecure_http: bool,
    ) -> Result<()> {
        let url = self.resource_url()?;
        let resource_host = url
            .host_str()
            .unwrap_or_default()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_ascii_lowercase();
        if host.starts_with("*.") || host != resource_host {
            bail!("an oauth service's host must be its resource host `{resource_host}`");
        }
        if let Some(port) = port {
            if url.port_or_known_default() != Some(port) {
                bail!("an oauth service's port must match its resource URL");
            }
        }
        if allow_insecure_http && !is_loopback_http(&url) {
            bail!("an oauth service never brokers plain http to a non-loopback host");
        }
        Ok(())
    }

    /// Required scopes the granted set lacks, sorted and deduplicated.
    pub fn missing_scopes(&self, granted: &[String]) -> Vec<String> {
        let granted: BTreeSet<&str> = granted.iter().map(String::as_str).collect();
        self.scopes
            .iter()
            .filter(|scope| !granted.contains(scope.as_str()))
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }
}

/// Where an OAuth service's connection stands for one owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OAuthState {
    /// Connected with every required scope.
    Connected,
    /// No connection exists for this owner, profile, plugin, and server.
    NeedsConnect,
    /// The refresh grant was rejected or the binding changed; reconnect.
    ReauthRequired,
    /// Connected, but without every scope the service requires.
    NeedsScopes,
    /// This node cannot read OAuth tokens locally (Passport remote mode, no
    /// identity store, or no resolvable owner).
    Unavailable,
}

/// An OAuth service's status. Metadata only, never a token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStatus {
    pub state: OAuthState,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub missing_scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

impl OAuthStatus {
    pub fn of(state: OAuthState) -> Self {
        Self {
            state,
            missing_scopes: Vec::new(),
            expires_at: None,
        }
    }
}

/// The status a connection record (or its absence) gives a binding.
pub fn status_from_record(
    binding: &OAuthBinding,
    record: Option<&McpOAuthConnectionRecord>,
) -> OAuthStatus {
    let Some(record) = record else {
        return OAuthStatus::of(OAuthState::NeedsConnect);
    };
    if record.status != McpOAuthConnectionStatus::Connected {
        return OAuthStatus::of(OAuthState::ReauthRequired);
    }
    let missing_scopes = binding.missing_scopes(&record.scopes);
    OAuthStatus {
        state: if missing_scopes.is_empty() {
            OAuthState::Connected
        } else {
            OAuthState::NeedsScopes
        },
        missing_scopes,
        expires_at: record.expires_at,
    }
}

/// The connection action an HTTP method maps to under the connection's
/// access level: safe methods read, `DELETE` deletes, writes write, and
/// anything else is unknown (denied by every level).
pub fn action_for_method(method: &Method) -> ConnectionAction {
    match *method {
        Method::GET | Method::HEAD | Method::OPTIONS => ConnectionAction::Read,
        Method::POST | Method::PUT | Method::PATCH => ConnectionAction::Write,
        Method::DELETE => ConnectionAction::Delete,
        _ => ConnectionAction::Unknown,
    }
}

/// Whose OAuth connection a broker session uses: the user who minted it, or
/// on a personal node the local owner. A shared node never falls back to a
/// default owner.
pub fn owner_for_session(user_id: Option<&str>) -> Result<String> {
    match user_id {
        Some(user) => Ok(user.to_owned()),
        None => crate::mcp_oauth::owner_for_caller(None),
    }
}

/// A token fetch that failed, classified for the agent. Messages never carry
/// the token or the upstream error body.
pub fn token_failure(error: &anyhow::Error) -> (StatusCode, &'static str, &'static str) {
    let text = format!("{error:#}");
    if text.contains("reconnect required") || text.contains("authentication required") {
        (
            StatusCode::PRECONDITION_REQUIRED,
            "oauth_reconnect_required",
            "the OAuth connection for this service needs to be reconnected in Ryu",
        )
    } else if text.contains("access level denied") || text.contains("identity read denied") {
        (
            StatusCode::FORBIDDEN,
            "oauth_access_denied",
            "the OAuth connection's access level does not allow this request",
        )
    } else if text.contains("Passport remote mode") || text.contains("not initialized") {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "oauth_unavailable",
            "this node cannot use OAuth connections locally",
        )
    } else {
        (
            StatusCode::BAD_GATEWAY,
            "oauth_token_failed",
            "the OAuth access token could not be obtained",
        )
    }
}

/// The status of every OAuth service in `services`, keyed by name, for
/// `owner` (`None`: no resolvable owner, so each is `unavailable`).
pub async fn statuses(
    source: &dyn OAuthTokens,
    owner: Option<&str>,
    services: &[super::services::BrokerService],
) -> BTreeMap<String, OAuthStatus> {
    let mut statuses = BTreeMap::new();
    for service in services {
        let Some(binding) = service.input.auth.oauth() else {
            continue;
        };
        let status = match owner {
            Some(owner) => source.status(owner, binding).await,
            None => OAuthStatus::of(OAuthState::Unavailable),
        };
        statuses.insert(service.name().to_owned(), status);
    }
    statuses
}

/// Source of OAuth status and access tokens. Core's implementation reads the
/// vault's MCP OAuth manager; tests substitute a fake.
#[async_trait::async_trait]
pub trait OAuthTokens: Send + Sync {
    /// The connection's status for `owner`. Never fails: a lookup error is
    /// `unavailable`.
    async fn status(&self, owner: &str, binding: &OAuthBinding) -> OAuthStatus;

    /// A fresh access token for immediate header injection;
    /// `force_refresh` refreshes it even before it expires (after the
    /// upstream rejected it).
    async fn access_token(
        &self,
        owner: &str,
        binding: &OAuthBinding,
        action: ConnectionAction,
        session_id: &str,
        force_refresh: bool,
    ) -> Result<String>;
}

/// Core's token source: the vault's MCP OAuth manager, with Core's identity
/// grant check and credential-read audit.
pub struct CoreOAuthTokens;

#[async_trait::async_trait]
impl OAuthTokens for CoreOAuthTokens {
    async fn status(&self, owner: &str, binding: &OAuthBinding) -> OAuthStatus {
        if crate::mcp_oauth::remote_configured() {
            return OAuthStatus::of(OAuthState::Unavailable);
        }
        let Some(store) = crate::identity::global() else {
            return OAuthStatus::of(OAuthState::Unavailable);
        };
        match store
            .find_mcp_oauth_connection(owner, &binding.profile, &binding.plugin, &binding.server)
            .await
        {
            Ok(record) => status_from_record(binding, record.as_ref()),
            Err(error) => {
                tracing::warn!("broker oauth status lookup failed: {error:#}");
                OAuthStatus::of(OAuthState::Unavailable)
            }
        }
    }

    async fn access_token(
        &self,
        owner: &str,
        binding: &OAuthBinding,
        action: ConnectionAction,
        session_id: &str,
        force_refresh: bool,
    ) -> Result<String> {
        crate::mcp_oauth::global()
            .access_token(
                owner,
                &binding.profile,
                &binding.plugin,
                &binding.server,
                &binding.resource,
                binding.client_id.as_deref(),
                action,
                false,
                force_refresh,
                Some(format!("broker:{session_id}")),
            )
            .await
    }
}

#[cfg(test)]
#[path = "oauth_tests.rs"]
mod tests;
