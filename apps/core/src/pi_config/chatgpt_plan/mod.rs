//! Official public-client Sign in with ChatGPT for local/open-core hosts.
//! Each account registration owns its issued client ID and rotating token set.
//!
//! [`protocol`] talks to OpenAI; [`login`] runs the loopback browser callback.

use anyhow::{anyhow, bail, Context, Result};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    routing::get,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::StreamExt;
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    future::IntoFuture,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{net::TcpListener, sync::oneshot};

mod callback;
mod errors;
mod login;
mod protocol;
#[cfg(test)]
mod tests;

#[cfg(test)]
use callback::{accept, callback_page, Callback, CallbackOutcome};
use callback::{callback, CallbackState};
pub use errors::SignInFailure;
pub use login::LoginAttempt;
use protocol::{credential, endpoints, http_client, response_json, signing_keys, verify_identity};
pub use protocol::{refresh, revoke, RevocationStatus};

const ISSUER: &str = "https://auth.openai.com";
const RESOURCE: &str = "https://api.openai.com/v1";
const DISCOVERY: &str = "https://auth.openai.com/.well-known/openid-configuration";
const DYNAMIC_CLIENT: &str = "dynamic_agent_client";
const MAX_AUTH_BYTES: usize = 1024 * 1024;

#[derive(Debug)]
struct OAuthFailure {
    status: u16,
    code: Option<&'static str>,
}
impl std::fmt::Display for OAuthFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.code {
            Some("invalid_client") => formatter
                .write_str("OpenAI rejected this client registration; check its configuration"),
            Some(code) => write!(
                formatter,
                "OpenAI authorization failed ({code}); reconnect the saved registration"
            ),
            None => write!(
                formatter,
                "OpenAI authorization is unavailable (HTTP {})",
                self.status
            ),
        }
    }
}
impl std::error::Error for OAuthFailure {}

#[derive(Debug)]
struct ExpiredRegistrationCode {
    client_id: String,
}
impl std::fmt::Display for ExpiredRegistrationCode {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(
            "The authorization code expired; retry authorization with the issued registration",
        )
    }
}
impl std::error::Error for ExpiredRegistrationCode {}
pub fn retry_registration(error: &anyhow::Error) -> Option<String> {
    error
        .downcast_ref::<ExpiredRegistrationCode>()
        .map(|error| error.client_id.clone())
}

pub fn terminal_refresh_error(error: &anyhow::Error) -> bool {
    error.downcast_ref::<OAuthFailure>().is_some_and(|error| {
        matches!(
            error.code,
            Some(
                "invalid_grant"
                    | "invalid_refresh_token"
                    | "token_expired"
                    | "refresh_token_expired"
                    | "refresh_token_invalidated"
                    | "refresh_token_reused"
            )
        )
    })
}
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

#[derive(Clone, Deserialize)]
struct Endpoints {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    revocation_endpoint: String,
}

/// This record is sealed in the Core account vault, never passed to Pi or UI.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    #[serde(rename = "type")]
    kind: String,
    flow: String,
    pub access: String,
    refresh: Option<String>,
    pub expires: u64,
    pub client_id: String,
    host_id: String,
    issuer: String,
    subject: String,
    id_token: String,
    pub email: Option<String>,
    pub scopes: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    #[serde(rename = "type")]
    kind: String,
    flow: String,
    client_id: String,
    host_id: String,
    issuer: String,
    subject: String,
    pub email: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityConnection {
    #[serde(flatten)]
    registration: Registration,
    id_token: String,
    refresh: Option<String>,
    pub scopes: Vec<String>,
}

/// Disconnected accounts retain their verified registration, without tokens.
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum StoredAccount {
    Connected(Credential),
    IdentityOnly(IdentityConnection),
    Disconnected(Registration),
}

impl StoredAccount {
    pub fn from_value(value: &serde_json::Value) -> Result<Self> {
        let account: Self = serde_json::from_value(value.clone())
            .context("ChatGPT account registration is incomplete")?;
        let registration = account.registration();
        if registration.kind != "oauth"
            || registration.flow != "chatgpt-plan"
            || registration.issuer != ISSUER
            || !valid_client_id(&registration.client_id)
            || registration.subject.is_empty()
            || !valid_host_id(&registration.host_id)
        {
            bail!("ChatGPT account registration is invalid");
        }
        if let Self::Connected(credential) = &account {
            Credential::from_value(&serde_json::to_value(credential)?)?;
            if !credential.plan_authorized() {
                bail!("ChatGPT plan permission is missing");
            }
        }
        if let Self::IdentityOnly(identity) = &account {
            if identity.id_token.is_empty() || identity.id_token.len() > 64 * 1024 {
                bail!("ChatGPT identity token is unavailable");
            }
        }
        Ok(account)
    }

    pub fn credential(&self) -> Result<&Credential> {
        match self {
            Self::Connected(credential) => Ok(credential),
            Self::IdentityOnly(_) => bail!("Enable ChatGPT plan use for this saved registration"),
            Self::Disconnected(_) => bail!("Reconnect this saved ChatGPT registration"),
        }
    }

    pub fn plan_authorized(&self) -> bool {
        self.credential().is_ok_and(Credential::plan_authorized)
    }

    pub fn registration(&self) -> Registration {
        match self {
            Self::Connected(credential) => Registration {
                kind: credential.kind.clone(),
                flow: credential.flow.clone(),
                client_id: credential.client_id.clone(),
                host_id: credential.host_id.clone(),
                issuer: credential.issuer.clone(),
                subject: credential.subject.clone(),
                email: credential.email.clone(),
            },
            Self::Disconnected(registration) => registration.clone(),
            Self::IdentityOnly(identity) => identity.registration.clone(),
        }
    }

    pub fn matches_registration(&self, other: &Self) -> bool {
        self.client_id() == other.client_id()
            && self.subject() == other.subject()
            && self.registration().issuer == other.registration().issuer
    }

    fn client_id(&self) -> &str {
        match self {
            Self::Connected(credential) => &credential.client_id,
            Self::IdentityOnly(identity) => &identity.registration.client_id,
            Self::Disconnected(registration) => &registration.client_id,
        }
    }

    fn subject(&self) -> &str {
        match self {
            Self::Connected(credential) => &credential.subject,
            Self::IdentityOnly(identity) => &identity.registration.subject,
            Self::Disconnected(registration) => &registration.subject,
        }
    }

    fn email(&self) -> Option<&str> {
        match self {
            Self::Connected(credential) => credential.email.as_deref(),
            Self::IdentityOnly(identity) => identity.registration.email.as_deref(),
            Self::Disconnected(registration) => registration.email.as_deref(),
        }
    }

    fn id_token_hint(&self) -> Option<&str> {
        match self {
            Self::Connected(credential) => Some(&credential.id_token),
            Self::IdentityOnly(identity) => Some(&identity.id_token),
            Self::Disconnected(_) => None,
        }
    }
}

pub fn connection_state(value: &serde_json::Value) -> &'static str {
    match StoredAccount::from_value(value) {
        Ok(StoredAccount::Connected(credential))
            if credential.refresh.is_none()
                && credential.expires <= now_seconds().unwrap_or(u64::MAX).saturating_mul(1000) =>
        {
            "reconnect-required"
        }
        Ok(StoredAccount::Connected(_)) => "authorized",
        Ok(StoredAccount::IdentityOnly(_)) => "identity-only",
        Ok(StoredAccount::Disconnected(_)) => "reconnect-required",
        Err(_) => "unavailable",
    }
}

impl Credential {
    pub fn from_value(value: &serde_json::Value) -> Result<Self> {
        let credential: Self = serde_json::from_value(value.clone())
            .context("ChatGPT plan credential is incomplete")?;
        if credential.kind != "oauth"
            || credential.flow != "chatgpt-plan"
            || credential.issuer != ISSUER
            || !valid_client_id(&credential.client_id)
            || credential.subject.is_empty()
            || credential.access.is_empty()
            || credential
                .refresh
                .as_deref()
                .is_some_and(|value| value.is_empty() || value.len() > 64 * 1024)
            || !valid_host_id(&credential.host_id)
        {
            bail!("ChatGPT plan credential is invalid; reconnect this account");
        }
        Ok(credential)
    }

    pub fn plan_authorized(&self) -> bool {
        ["resource.invoke", "chatgpt.tokens.use.direct"]
            .iter()
            .all(|required| self.scopes.iter().any(|scope| scope == required))
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    id_token: Option<String>,
    token_type: Option<String>,
    expires_in: Option<u64>,
    scope: Option<String>,
}

#[derive(Deserialize)]
struct IdentityClaims {
    sub: String,
    exp: u64,
    iat: u64,
    nonce: Option<String>,
    email: Option<String>,
    email_verified: Option<bool>,
}

fn random_value(bytes: usize) -> String {
    let mut value = vec![0_u8; bytes];
    rand::thread_rng().fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

fn now_seconds() -> Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
}

fn valid_client_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value != DYNAMIC_CLIENT
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn valid_host_id(value: &str) -> bool {
    value
        .strip_prefix("urn:uuid:")
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.get_version_num() == 4))
}

fn host_id() -> Result<String> {
    let _guard = super::ACCOUNT_SELECTION_LOCK
        .lock()
        .expect("account selection lock");
    super::ensure_dir()?;
    let path = super::config_dir().join("chatgpt-plan-host-id");
    match std::fs::read_to_string(&path) {
        Ok(value) if valid_host_id(value.trim()) => return Ok(value.trim().to_owned()),
        Ok(_) => bail!("ChatGPT host ID is invalid; restore the existing host registration"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("read ChatGPT host ID"),
    }
    let value = format!("urn:uuid:{}", uuid::Uuid::new_v4());
    super::write_secret_file(&path, &value)?;
    Ok(value)
}
