//! Typed Ryu Box session client for disposable cloud-task Boxes.
//!
//! [`crate::box_backend::BoxSandbox`] maps the generic [`crate::Sandbox`]
//! contract onto the Box API (one throwaway Box per ephemeral exec). Core's
//! cloud-task Box arm needs more than that contract carries: a named,
//! TTL-bounded Box with a network policy and root setup steps, commands that
//! carry per-command env and a user, and managed CLI prompt runs that Core
//! polls. This module is that typed surface.
//!
//! Session Boxes (design `docs/box-per-session-desktop.md` §7) add the
//! lifecycle verbs Core drives per conversation: park and resume, status,
//! desktop tokens and actions, browser calls, the Box's short-lived inference
//! credential, the tick-liveness keepalive, and the tenant's limits. Those
//! methods return a typed [`BoxApiError`] built by [`parse_box_error`], so Core
//! can tell capacity, quota, credit and not-found refusals apart.
//!
//! The endpoint and bearer come from [`crate::box_credential::current`]
//! ([`BoxSessionClient::resolve`]): the env configuration of `box_backend`
//! (`RYU_SANDBOX_BOX_URL`, `RYU_SANDBOX_BOX_TOKEN`) on self-hosted nodes, or
//! the control-plane tenant credential on managed nodes.
//!
//! Secrets travel only as per-command or per-prompt env, the session
//! credential body, or the bearer header. None of them is ever placed into an
//! error message or a log line, and the bearer header is marked sensitive.

use std::collections::BTreeMap;
use std::fmt;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use reqwest::Url;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::box_backend::{box_base_url, box_token, request_timeout, ENV_BOX_TOKEN};
use crate::box_credential::{self, BillingOwner};
use crate::box_types::{
    parse_box_error, BoxApiError, BoxLimits, BoxSize, BoxView, DesktopTokenRequest,
    DesktopTokenResponse, KeepaliveRequest, ParkReason, SecretString, SessionCredential,
};
use crate::{ExecOutput, WorkspaceId};

/// What [`BoxSessionClient::mint_desktop_token`] returns: the single-use token
/// (`token`, `expires_at`), the WebSocket subprotocols to dial with, and the
/// absolute stream URL when the Box service knows its public ingress.
pub type DesktopToken = DesktopTokenResponse;

/// Root of a Box's workspace filesystem; command and prompt `cwd` values are
/// relative to it.
pub const BOX_WORKSPACE_ROOT: &str = "/workspace";

/// Root setup step sent in POST /boxes `setup`: installs git + ca-certificates via apt-get or apk when missing; exits 127 otherwise.
pub const ENSURE_GIT_SCRIPT: &str = "if ! command -v git >/dev/null 2>&1; then if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends git ca-certificates >/dev/null; elif command -v apk >/dev/null 2>&1; then apk add --no-cache git ca-certificates >/dev/null; else echo 'The Box image must provide git.' >&2; exit 127; fi; fi";

/// Hosts the default ubuntu image needs for ENSURE_GIT_SCRIPT and managed CLI install under an allowlist.
pub const BOX_BASE_HOSTS: &[&str] = &["archive.ubuntu.com", "security.ubuntu.com"];

/// Poll cadence while a freshly created Box provisions.
const READY_POLL_INTERVAL: Duration = Duration::from_millis(500);
/// Overall provisioning deadline; setup steps may run apt-get.
const READY_DEADLINE: Duration = Duration::from_secs(900);
/// Longest command the client lets Box run in one exec.
const MAX_EXEC_TIMEOUT_SECS: u64 = 3600;
/// Largest script sent as command stdin.
const MAX_SCRIPT_BYTES: usize = 256 * 1024;
/// Box prompt text limit (characters).
const MAX_PROMPT_CHARS: usize = 32_000;
/// Managed prompt timeout bounds accepted by Box.
const MIN_PROMPT_TIMEOUT_SECS: u64 = 60;
const MAX_PROMPT_TIMEOUT_SECS: u64 = 14_400;
/// Managed prompt `cwd` length limit.
const MAX_CWD_CHARS: usize = 256;
/// Error detail cap for non-2xx Box responses.
const ERROR_DETAIL_CHARS: usize = 512;
/// `lastError` cap when a Box fails to provision.
const LAST_ERROR_CHARS: usize = 500;
/// Extra HTTP headroom over a command's own timeout.
const EXEC_HTTP_HEADROOM: Duration = Duration::from_secs(30);
/// Box labels: at most this many entries (matches `MAX_BOX_LABELS`).
const MAX_BOX_LABELS: usize = 8;
/// Label key length limit (`BOX_LABEL_KEY_PATTERN` is `^[a-z0-9-]{1,32}$`).
const MAX_BOX_LABEL_KEY_CHARS: usize = 32;
/// Label value limit (matches `MAX_BOX_LABEL_VALUE_CHARS`).
const MAX_BOX_LABEL_VALUE_CHARS: usize = 64;
/// Browser verb names: `^[a-z][a-z0-9_.-]{0,63}$`.
const MAX_BROWSER_VERB_CHARS: usize = 64;
/// Desktop actions and browser calls can wait on a page or a screenshot.
const DESKTOP_CALL_TIMEOUT: Duration = Duration::from_secs(60);

/// Network policy for a disposable Box.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BoxNetwork {
    None,
    Egress,
    Allowlist(Vec<String>),
}

impl BoxNetwork {
    fn wire_mode(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Egress => "egress",
            Self::Allowlist(_) => "allowlist",
        }
    }
}

/// Everything needed to create one disposable Box.
#[derive(Clone, Debug)]
pub struct DisposableBoxSpec {
    pub name: String,
    pub image: Option<String>,
    pub network: BoxNetwork,
    pub ttl_seconds: u64,
    pub setup: Vec<String>,
    /// The size to create. Sent on the wire; `RYU_SANDBOX_BOX_SIZE` is never
    /// read for a disposable Box, and the heartbeat meters this size.
    pub size: BoxSize,
    /// Start the Box's own screen (Xvfb, VNC and a browser).
    pub desktop: bool,
    /// At most 8 labels, keys `^[a-z0-9-]{1,32}$`, values at most 64 chars.
    pub labels: BTreeMap<String, String>,
}

/// The Box account a command runs as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoxUser {
    Box,
    Root,
}

impl BoxUser {
    fn wire_name(self) -> &'static str {
        match self {
            Self::Box => "box",
            Self::Root => "root",
        }
    }
}

/// A managed CLI agent Box can run as a prompt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ManagedProvider {
    ClaudeCode,
    Codex,
    Opencode,
    Cursor,
}

impl ManagedProvider {
    /// Every managed provider, in a stable order.
    pub const ALL: [Self; 4] = [Self::ClaudeCode, Self::Codex, Self::Opencode, Self::Cursor];

    /// The provider name on the Box prompt wire and the cloud environment
    /// `executor` value.
    pub fn wire_name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
            Self::Cursor => "cursor",
        }
    }

    /// Parse a cloud environment executor. `"ryu"` (the in-process agent) and
    /// unknown values are not managed providers.
    pub fn from_executor(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|provider| provider.wire_name() == value)
    }

    /// Hosts the provider's CLI needs to install and reach its model API.
    pub fn required_hosts(self) -> &'static [&'static str] {
        match self {
            Self::ClaudeCode => &["api.anthropic.com", "registry.npmjs.org"],
            Self::Codex => &["api.openai.com", "registry.npmjs.org"],
            Self::Opencode => &["registry.npmjs.org"],
            Self::Cursor => &["cursor.com", "downloads.cursor.com", "api2.cursor.sh"],
        }
    }
}

/// One managed prompt run request.
#[derive(Clone)]
pub struct ManagedPromptSpec {
    pub provider: ManagedProvider,
    pub text: String,
    pub cwd: String,
    pub env: Vec<(String, String)>,
    pub timeout_secs: u64,
}

impl fmt::Debug for ManagedPromptSpec {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let env_names: Vec<&str> = self.env.iter().map(|(name, _)| name.as_str()).collect();
        formatter
            .debug_struct("ManagedPromptSpec")
            .field("provider", &self.provider)
            .field("text_chars", &self.text.chars().count())
            .field("cwd", &self.cwd)
            .field("env_names", &env_names)
            .field("timeout_secs", &self.timeout_secs)
            .finish()
    }
}

/// The subset of a Box `PromptRun` Core consumes. Optional fields default so
/// older Box builds that omit them still parse.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRunView {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub process_id: Option<String>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
}

impl PromptRunView {
    /// Whether the run reached a final state.
    pub fn is_terminal(&self) -> bool {
        self.status == "completed" || self.status == "failed"
    }
}

/// One captured process output chunk.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputChunk {
    pub seq: u64,
    pub stream: String,
    pub data: String,
}

/// A page of process output after a sequence number.
#[derive(Clone, Debug, Default)]
pub struct ProcessOutputPage {
    pub chunks: Vec<OutputChunk>,
    pub exited: bool,
}

/// Typed client for the Box `/v1` calls Core's cloud-task and session Boxes
/// make.
pub struct BoxSessionClient {
    base: String,
    token: SecretString,
    timeout: Duration,
    http: reqwest::Client,
    billing_owner: BillingOwner,
    public_base: Option<Url>,
}

impl fmt::Debug for BoxSessionClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BoxSessionClient")
            .field("base", &self.base)
            .field("timeout", &self.timeout)
            .field("billing_owner", &self.billing_owner)
            .field("public_base", &self.public_base.as_ref().map(Url::as_str))
            .finish_non_exhaustive()
    }
}

impl BoxSessionClient {
    /// Build a client from the same environment `box_backend` reads.
    pub fn from_env() -> Result<Self> {
        let token = box_token()
            .ok_or_else(|| anyhow!("Box backend requires an API token ({ENV_BOX_TOKEN})"))?;
        Ok(Self::with_endpoint(box_base_url(), token))
    }

    /// Build a client from the process-wide Box credential
    /// ([`box_credential::current`]): `RYU_SANDBOX_BOX_*` when the env token is
    /// set, otherwise the installed source (the control-plane tenant credential
    /// on managed nodes).
    pub async fn resolve() -> Result<Self> {
        let credential = box_credential::current().await?;
        Ok(Self::from_credential(&credential))
    }

    /// Build a client for one resolved credential.
    pub fn from_credential(credential: &box_credential::BoxCredential) -> Self {
        let mut client =
            Self::with_endpoint(credential.base.as_str(), credential.token.expose_secret());
        client.billing_owner = credential.billing_owner;
        client.public_base = credential.public_base.clone();
        client
    }

    /// Build a client for an explicit endpoint. `base` includes `/v1`.
    pub fn with_endpoint(base: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            base: base.into().trim().trim_end_matches('/').to_owned(),
            token: SecretString::new(token.into()),
            timeout: request_timeout(),
            http: reqwest::Client::new(),
            billing_owner: BillingOwner::None,
            public_base: None,
        }
    }

    /// Who meters this client's Box time.
    pub fn billing_owner(&self) -> BillingOwner {
        self.billing_owner
    }

    /// The public ingress for direct desktop streams, when the Box service
    /// has one. `None` means desktop streams are relayed through Core.
    pub fn public_base(&self) -> Option<&Url> {
        self.public_base.as_ref()
    }

    fn authorization(&self) -> Result<reqwest::header::HeaderValue, BoxApiError> {
        let mut value = reqwest::header::HeaderValue::from_str(&format!(
            "Bearer {}",
            self.token.expose_secret()
        ))
        .map_err(|_| invalid_request("the Box API token is not a valid header value"))?;
        value.set_sensitive(true);
        Ok(value)
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        idempotency_key: Option<&str>,
        timeout: Option<Duration>,
    ) -> Result<Value, BoxApiError> {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.base))
            .header(reqwest::header::AUTHORIZATION, self.authorization()?)
            .timeout(timeout.unwrap_or(self.timeout));
        if let Some(idempotency_key) = idempotency_key {
            request = request.header("Idempotency-Key", idempotency_key);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|error| {
            BoxApiError::transport(format!("Box API request failed: {}", error.without_url()))
        })?;
        let status = response.status();
        let headers = response.headers().clone();
        let text = crate::capture::response_text(response)
            .await
            .map_err(|error| BoxApiError::transport(format!("Box API response failed: {error}")))?;
        if !status.is_success() {
            return Err(parse_box_error(status.as_u16(), &headers, &text));
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text)
            .map_err(|error| invalid_response(format!("Box API returned invalid JSON: {error}")))
    }
}

mod commands;
mod desktop;
mod lifecycle;
mod wire;

use self::wire::*;

#[cfg(test)]
mod tests;
