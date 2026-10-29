//! Official public-client Sign in with ChatGPT for local/open-core hosts.
//! Each account registration owns its issued client ID and rotating token set.

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

fn http_client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()?)
}

async fn response_json<T: serde::de::DeserializeOwned>(response: reqwest::Response) -> Result<T> {
    let status = response.status();
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("read OpenAI authorization response")?;
        if bytes.len().saturating_add(chunk.len()) > MAX_AUTH_BYTES {
            bail!("OpenAI authorization response is too large");
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
        let raw = value["error"]
            .as_str()
            .or_else(|| value["error"]["code"].as_str());
        let code = match raw {
            Some("invalid_grant") => Some("invalid_grant"),
            Some("invalid_client") => Some("invalid_client"),
            Some("invalid_refresh_token") => Some("invalid_refresh_token"),
            Some("token_expired") => Some("token_expired"),
            Some("refresh_token_expired") => Some("refresh_token_expired"),
            Some("refresh_token_invalidated") => Some("refresh_token_invalidated"),
            Some("refresh_token_reused") => Some("refresh_token_reused"),
            _ => None,
        };
        return Err(anyhow!(OAuthFailure {
            status: status.as_u16(),
            code
        }));
    }
    serde_json::from_slice(&bytes).context("OpenAI authorization response is invalid")
}

async fn endpoints(client: &reqwest::Client) -> Result<Endpoints> {
    let endpoints: Endpoints = response_json(client.get(DISCOVERY).send().await?).await?;
    if endpoints.issuer != ISSUER {
        bail!("OpenAI discovery returned an unexpected issuer");
    }
    for endpoint in [
        &endpoints.authorization_endpoint,
        &endpoints.token_endpoint,
        &endpoints.jwks_uri,
        &endpoints.revocation_endpoint,
    ] {
        let url = reqwest::Url::parse(endpoint)?;
        if url.scheme() != "https"
            || url.host_str() != Some("auth.openai.com")
            || url.port_or_known_default() != Some(443)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            bail!("OpenAI discovery returned an untrusted endpoint");
        }
    }
    Ok(endpoints)
}

fn verify_identity(
    token: &str,
    keys: &JwkSet,
    client_id: &str,
    nonce: Option<&str>,
    subject: Option<&str>,
) -> Result<IdentityClaims> {
    if token.len() > 64 * 1024 {
        bail!("OpenAI ID token is too large");
    }
    let header = decode_header(token).context("OpenAI ID token header is invalid")?;
    if header.alg != Algorithm::RS256 {
        bail!("OpenAI ID token uses an unsupported algorithm");
    }
    let kid = header
        .kid
        .as_deref()
        .filter(|kid| !kid.is_empty() && kid.len() <= 256)
        .context("OpenAI ID token has no signing key ID")?;
    let jwk = keys
        .find(kid)
        .context("OpenAI ID token signing key is unavailable")?;
    let key = DecodingKey::from_jwk(jwk).context("OpenAI signing key is invalid")?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.required_spec_claims = ["exp", "iss", "aud", "sub"]
        .into_iter()
        .map(str::to_owned)
        .collect();
    validation.set_issuer(&[ISSUER]);
    validation.set_audience(&[client_id]);
    validation.leeway = 5;
    validation.validate_nbf = true;
    let claims: IdentityClaims = decode(token, &key, &validation)
        .context("OpenAI ID token verification failed")?
        .claims;
    if claims.sub.is_empty()
        || claims.sub.len() > 1024
        || claims.iat > now_seconds()?.saturating_add(5)
        || claims.exp <= claims.iat
        || nonce.is_some_and(|expected| claims.nonce.as_deref() != Some(expected))
        || subject.is_some_and(|expected| claims.sub != expected)
    {
        bail!("OpenAI account identity could not be verified");
    }
    Ok(claims)
}

async fn signing_keys(client: &reqwest::Client, endpoints: &Endpoints) -> Result<JwkSet> {
    let keys: JwkSet = response_json(client.get(&endpoints.jwks_uri).send().await?).await?;
    if keys.keys.is_empty() || keys.keys.len() > 64 {
        bail!("OpenAI signing key set is invalid");
    }
    Ok(keys)
}

fn credential(
    tokens: TokenResponse,
    identity: IdentityClaims,
    client_id: String,
    host_id: String,
    retained_id_token: Option<String>,
    retained_scopes: Option<Vec<String>>,
) -> Result<StoredAccount> {
    let scopes = match tokens.scope {
        Some(scope) if scope.len() <= 4096 => scope.split_whitespace().map(str::to_owned).collect(),
        Some(_) => bail!("OpenAI returned an invalid scope list"),
        None => retained_scopes.unwrap_or_default(),
    };
    let id_token = tokens
        .id_token
        .or(retained_id_token)
        .context("OpenAI did not return an ID token")?;
    let email = identity.email.filter(|email| {
        identity.email_verified == Some(true)
            && email.len() <= 320
            && !email.chars().any(char::is_control)
    });
    if tokens
        .refresh_token
        .as_deref()
        .is_some_and(|value| value.is_empty() || value.len() > 64 * 1024)
    {
        bail!("OpenAI returned an invalid refresh token");
    }
    let plan_authorized = ["resource.invoke", "chatgpt.tokens.use.direct"]
        .iter()
        .all(|required| scopes.iter().any(|scope| scope == required));
    if !plan_authorized {
        return Ok(StoredAccount::IdentityOnly(IdentityConnection {
            registration: Registration {
                kind: "oauth".to_owned(),
                flow: "chatgpt-plan".to_owned(),
                client_id,
                host_id,
                issuer: ISSUER.to_owned(),
                subject: identity.sub,
                email,
            },
            id_token,
            refresh: tokens.refresh_token,
            scopes,
        }));
    }
    let access = tokens
        .access_token
        .filter(|value| !value.is_empty() && value.len() <= 64 * 1024)
        .context("OpenAI returned no usable access token")?;
    if !tokens
        .token_type
        .as_deref()
        .is_some_and(|kind| kind.eq_ignore_ascii_case("bearer"))
        || scopes.iter().any(|scope| scope == "offline_access") && tokens.refresh_token.is_none()
    {
        bail!("OpenAI returned an invalid renewable token set");
    }
    let expires_in = tokens
        .expires_in
        .filter(|seconds| *seconds > 0 && *seconds <= 86_400)
        .context("OpenAI token expiry is invalid")?;
    let expires = now_seconds()?
        .checked_add(expires_in)
        .and_then(|value| value.checked_mul(1000))
        .context("OpenAI token expiry is invalid")?;
    Ok(StoredAccount::Connected(Credential {
        kind: "oauth".to_owned(),
        flow: "chatgpt-plan".to_owned(),
        access,
        refresh: tokens.refresh_token,
        expires,
        client_id,
        host_id,
        issuer: ISSUER.to_owned(),
        subject: identity.sub,
        id_token,
        email,
        scopes,
    }))
}

#[derive(Deserialize)]
struct Callback {
    state: Option<String>,
    code: Option<String>,
    client_id: Option<String>,
    error: Option<String>,
}

struct CallbackState {
    expected: String,
    sender: Mutex<Option<oneshot::Sender<Callback>>>,
}

async fn callback(
    State(state): State<Arc<CallbackState>>,
    Query(query): Query<Callback>,
) -> (StatusCode, &'static str) {
    if query.state.as_deref() != Some(state.expected.as_str()) {
        return (
            StatusCode::BAD_REQUEST,
            "This sign-in attempt could not be verified.",
        );
    }
    let Ok(mut sender) = state.sender.lock() else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Sign-in is unavailable.");
    };
    let Some(sender) = sender.take() else {
        return (
            StatusCode::GONE,
            "This sign-in attempt has already been used.",
        );
    };
    let _ = sender.send(query);
    (
        StatusCode::OK,
        "Authorization received. Return to Ryu to check the connection.",
    )
}

pub struct LoginAttempt {
    listener: TcpListener,
    client: reqwest::Client,
    endpoints: Endpoints,
    state: String,
    nonce: String,
    verifier: String,
    redirect: String,
    host_id: String,
    existing: Option<StoredAccount>,
    pending_client: Option<String>,
    enable_plan_use: bool,
}

impl LoginAttempt {
    pub async fn begin(existing: Option<StoredAccount>, enable_plan_use: bool) -> Result<Self> {
        if enable_plan_use && existing.is_none() {
            bail!("Choose a saved registration before enabling plan use");
        }
        let host_id = host_id()?;
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let redirect = format!(
            "http://127.0.0.1:{}/auth/callback",
            listener.local_addr()?.port()
        );
        let client = http_client()?;
        let endpoints = endpoints(&client).await?;
        Ok(Self {
            listener,
            client,
            endpoints,
            state: random_value(32),
            nonce: random_value(32),
            verifier: random_value(64),
            redirect,
            host_id,
            existing,
            pending_client: None,
            enable_plan_use,
        })
    }

    pub async fn retry(client_id: String) -> Result<Self> {
        if !valid_client_id(&client_id) {
            bail!("Issued ChatGPT client ID is invalid");
        }
        let mut attempt = Self::begin(None, false).await?;
        attempt.pending_client = Some(client_id);
        Ok(attempt)
    }

    pub fn authorization_url(&self) -> Result<String> {
        let mut url = reqwest::Url::parse(&self.endpoints.authorization_endpoint)?;
        let mut query = url.query_pairs_mut();
        query.append_pair(
            "client_id",
            self.existing
                .as_ref()
                .map(StoredAccount::client_id)
                .or(self.pending_client.as_deref())
                .unwrap_or(DYNAMIC_CLIENT),
        );
        query.append_pair("ext_agent_host_id", &self.host_id);
        query
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &self.redirect)
            .append_pair("scope", SCOPES)
            .append_pair("resource", RESOURCE)
            .append_pair("state", &self.state)
            .append_pair("nonce", &self.nonce)
            .append_pair("code_challenge_method", "S256")
            .append_pair(
                "code_challenge",
                &URL_SAFE_NO_PAD.encode(Sha256::digest(self.verifier.as_bytes())),
            );
        if let Some(existing) = &self.existing {
            if let Some(hint) = existing.id_token_hint() {
                query.append_pair("id_token_hint", hint);
            }
            if let Some(email) = existing.email() {
                query.append_pair("login_hint", email);
            }
        } else if self.pending_client.is_none() {
            query.append_pair("agent_name_hint", "Ryu");
        }
        if self.enable_plan_use {
            query.append_pair("prompt", "consent");
        }
        drop(query);
        Ok(url.to_string())
    }

    pub async fn complete(self) -> Result<StoredAccount> {
        let (tx, mut rx) = oneshot::channel();
        let app = Router::new()
            .route("/auth/callback", get(callback))
            .with_state(Arc::new(CallbackState {
                expected: self.state.clone(),
                sender: Mutex::new(Some(tx)),
            }));
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let server = axum::serve(self.listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .into_future();
        tokio::pin!(server);
        let returned = tokio::select! {
            returned = &mut rx => returned.context("ChatGPT callback was interrupted")?,
            result = &mut server => { result?; bail!("ChatGPT callback listener stopped"); }
            _ = tokio::time::sleep(Duration::from_secs(15 * 60)) => bail!("ChatGPT sign-in timed out; start again"),
        };
        let _ = shutdown_tx.send(());
        let _ = tokio::time::timeout(Duration::from_secs(2), &mut server).await;
        if returned.error.is_some() {
            bail!("ChatGPT authorization was declined or could not be completed");
        }
        let client_id = match &self.existing {
            Some(existing) => {
                if returned
                    .client_id
                    .as_deref()
                    .is_some_and(|id| id != existing.client_id())
                {
                    bail!("ChatGPT returned another account registration; the saved account was not changed");
                }
                existing.client_id().to_owned()
            }
            None if self.pending_client.is_some() => {
                let pending = self
                    .pending_client
                    .as_deref()
                    .expect("pending registration");
                if returned
                    .client_id
                    .as_deref()
                    .is_some_and(|id| id != pending)
                {
                    bail!("ChatGPT returned another client registration; start a new connection");
                }
                pending.to_owned()
            }
            None => returned
                .client_id
                .filter(|id| valid_client_id(id))
                .context("ChatGPT registration did not return an issued client ID")?,
        };
        let code = returned
            .code
            .filter(|code| !code.is_empty() && code.len() <= 4096)
            .context("ChatGPT did not return an authorization code")?;
        let tokens: TokenResponse = response_json(
            self.client
                .post(&self.endpoints.token_endpoint)
                .form(&[
                    ("grant_type", "authorization_code"),
                    ("client_id", client_id.as_str()),
                    ("code", code.as_str()),
                    ("code_verifier", self.verifier.as_str()),
                    ("redirect_uri", self.redirect.as_str()),
                    ("resource", RESOURCE),
                ])
                .send()
                .await?,
        )
        .await
        .map_err(|error| {
            if error
                .downcast_ref::<OAuthFailure>()
                .is_some_and(|failure| failure.code == Some("invalid_grant"))
            {
                error.context(ExpiredRegistrationCode {
                    client_id: client_id.clone(),
                })
            } else {
                error
            }
        })?;
        let keys = signing_keys(&self.client, &self.endpoints).await?;
        let identity = verify_identity(
            tokens
                .id_token
                .as_deref()
                .context("ChatGPT did not return an ID token")?,
            &keys,
            &client_id,
            Some(&self.nonce),
            self.existing.as_ref().map(StoredAccount::subject),
        )?;
        credential(tokens, identity, client_id, self.host_id, None, None)
    }
}

pub async fn refresh(existing: Credential) -> Result<StoredAccount> {
    let client = http_client()?;
    let endpoints = endpoints(&client).await?;
    let tokens: TokenResponse = response_json(
        client
            .post(&endpoints.token_endpoint)
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", existing.client_id.as_str()),
                (
                    "refresh_token",
                    existing
                        .refresh
                        .as_deref()
                        .context("Reconnect this non-renewable ChatGPT session")?,
                ),
                ("resource", RESOURCE),
            ])
            .send()
            .await?,
    )
    .await?;
    let identity = if let Some(token) = &tokens.id_token {
        let keys = signing_keys(&client, &endpoints).await?;
        verify_identity(
            token,
            &keys,
            &existing.client_id,
            None,
            Some(&existing.subject),
        )?
    } else {
        IdentityClaims {
            sub: existing.subject.clone(),
            exp: u64::MAX,
            iat: 0,
            nonce: None,
            email: existing.email.clone(),
            email_verified: Some(true),
        }
    };
    credential(
        tokens,
        identity,
        existing.client_id,
        existing.host_id,
        Some(existing.id_token),
        Some(existing.scopes),
    )
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RevocationStatus {
    Confirmed,
    NotRequired,
    Unconfirmed,
}

/// Revocation ends a renewable session; it does not delete the registered app.
pub async fn revoke(existing: &StoredAccount) -> Result<RevocationStatus> {
    let refresh = match existing {
        StoredAccount::Connected(credential) => credential.refresh.as_deref(),
        StoredAccount::IdentityOnly(identity) => identity.refresh.as_deref(),
        StoredAccount::Disconnected(_) => None,
    };
    let Some(refresh) = refresh else {
        return Ok(RevocationStatus::NotRequired);
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let endpoints = endpoints(&client).await?;
    for attempt in 0..3 {
        let response = client
            .post(&endpoints.revocation_endpoint)
            .form(&[
                ("token", refresh),
                ("token_type_hint", "refresh_token"),
                ("client_id", existing.client_id()),
            ])
            .send()
            .await;
        match response {
            Ok(response) if response.status() == StatusCode::OK => {
                return Ok(RevocationStatus::Confirmed)
            }
            Ok(response) if !response.status().is_server_error() => {
                return Ok(RevocationStatus::Unconfirmed)
            }
            _ => {}
        }
        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(500 << attempt)).await;
        }
    }
    Ok(RevocationStatus::Unconfirmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed_identity(claims: &serde_json::Value) -> String {
        let mut header = jsonwebtoken::Header::new(Algorithm::RS256);
        header.kid = Some("chatgpt-plan-test".to_owned());
        jsonwebtoken::encode(
            &header,
            claims,
            &jsonwebtoken::EncodingKey::from_rsa_pem(include_bytes!(
                "fixtures/chatgpt-plan-test-private.pem"
            ))
            .unwrap(),
        )
        .unwrap()
    }

    fn identity_claims() -> serde_json::Value {
        let now = now_seconds().unwrap();
        serde_json::json!({ "iss": ISSUER, "aud": "oaiapp_test", "sub": "verified-subject",
            "iat": now, "exp": now + 3600, "nonce": "test-nonce",
            "email": "test@example.com", "email_verified": true })
    }

    #[test]
    fn signed_identity_requires_signature_issuer_audience_expiry_nonce_and_subject() {
        let keys: JwkSet =
            serde_json::from_str(include_str!("fixtures/chatgpt-plan-test-jwks.json")).unwrap();
        let claims = identity_claims();
        let token = signed_identity(&claims);
        assert!(verify_identity(
            &token,
            &keys,
            "oaiapp_test",
            Some("test-nonce"),
            Some("verified-subject")
        )
        .is_ok());
        for missing in ["iss", "aud", "sub", "exp", "iat", "nonce"] {
            let mut missing_claims = claims.clone();
            missing_claims.as_object_mut().unwrap().remove(missing);
            assert!(
                verify_identity(
                    &signed_identity(&missing_claims),
                    &keys,
                    "oaiapp_test",
                    Some("test-nonce"),
                    Some("verified-subject")
                )
                .is_err(),
                "{missing}"
            );
        }
        for (field, invalid) in [
            ("iss", serde_json::json!("https://attacker.example")),
            ("aud", serde_json::json!("oaiapp_other")),
            ("exp", serde_json::json!(now_seconds().unwrap() - 100)),
            ("iat", serde_json::json!(now_seconds().unwrap() + 60)),
            ("nonce", serde_json::json!("other-nonce")),
            ("sub", serde_json::json!("other-subject")),
        ] {
            let mut invalid_claims = claims.clone();
            invalid_claims[field] = invalid;
            assert!(
                verify_identity(
                    &signed_identity(&invalid_claims),
                    &keys,
                    "oaiapp_test",
                    Some("test-nonce"),
                    Some("verified-subject")
                )
                .is_err(),
                "{field}"
            );
        }
        let wrong_algorithm = jsonwebtoken::encode(
            &jsonwebtoken::Header::new(Algorithm::HS256),
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(b"synthetic-test-secret"),
        )
        .unwrap();
        assert!(verify_identity(
            &wrong_algorithm,
            &keys,
            "oaiapp_test",
            Some("test-nonce"),
            None
        )
        .is_err());
        let mut tampered = token.into_bytes();
        let last = tampered.last_mut().unwrap();
        *last = if *last == b'A' { b'B' } else { b'A' };
        assert!(verify_identity(
            std::str::from_utf8(&tampered).unwrap(),
            &keys,
            "oaiapp_test",
            Some("test-nonce"),
            None
        )
        .is_err());
    }

    #[test]
    fn identity_permission_does_not_imply_plan_use() {
        let make = |scope: &str| {
            credential(
                TokenResponse {
                    access_token: Some("synthetic-access".to_owned()),
                    refresh_token: Some("synthetic-refresh".to_owned()),
                    id_token: Some("synthetic-id-token".to_owned()),
                    token_type: Some("Bearer".to_owned()),
                    expires_in: Some(3600),
                    scope: Some(scope.to_owned()),
                },
                IdentityClaims {
                    sub: "subject".to_owned(),
                    exp: 3600,
                    iat: 0,
                    nonce: None,
                    email: Some("unverified@example.com".to_owned()),
                    email_verified: Some(false),
                },
                "oaiapp_test".to_owned(),
                format!("urn:uuid:{}", uuid::Uuid::new_v4()),
                None,
                None,
            )
            .unwrap()
        };
        let identity_only = make("openid profile email offline_access");
        assert!(!identity_only.plan_authorized());
        assert!(identity_only.registration().email.is_none());
        let plan = make(SCOPES);
        assert!(plan.plan_authorized());
        assert!(Credential::from_value(&serde_json::to_value(plan).unwrap()).is_ok());
    }

    #[test]
    fn identity_only_signin_requires_no_access_or_refresh_token() {
        let identity = credential(
            TokenResponse {
                access_token: None,
                refresh_token: None,
                id_token: Some("synthetic-identity".to_owned()),
                token_type: None,
                expires_in: None,
                scope: Some("openid profile email".to_owned()),
            },
            IdentityClaims {
                sub: "subject".to_owned(),
                exp: 3600,
                iat: 0,
                nonce: None,
                email: Some("test@example.com".to_owned()),
                email_verified: Some(true),
            },
            "oaiapp_identity".to_owned(),
            format!("urn:uuid:{}", uuid::Uuid::new_v4()),
            None,
            None,
        )
        .unwrap();
        assert!(!identity.plan_authorized());
        assert!(identity.credential().is_err());
        let saved = serde_json::to_value(identity).unwrap();
        assert_eq!(saved["state"], "identity-only");
        assert!(saved.get("access").is_none());
        assert!(StoredAccount::from_value(&saved).is_ok());
    }

    #[test]
    fn disconnected_account_keeps_registration_and_drops_all_tokens() {
        let credential = Credential {
            kind: "oauth".to_owned(),
            flow: "chatgpt-plan".to_owned(),
            access: "synthetic-access".to_owned(),
            refresh: Some("synthetic-refresh".to_owned()),
            expires: 1,
            client_id: "oaiapp_test".to_owned(),
            host_id: format!("urn:uuid:{}", uuid::Uuid::new_v4()),
            issuer: ISSUER.to_owned(),
            subject: "subject".to_owned(),
            id_token: "synthetic-id".to_owned(),
            email: Some("test@example.com".to_owned()),
            scopes: SCOPES.split_whitespace().map(str::to_owned).collect(),
        };
        let connected = StoredAccount::Connected(credential.clone());
        let stored = serde_json::to_value(&connected).unwrap();
        assert_eq!(stored["access"], "synthetic-access");
        assert!(StoredAccount::from_value(&stored)
            .unwrap()
            .credential()
            .is_ok());
        let disconnected = StoredAccount::Disconnected(connected.registration());
        let stored = serde_json::to_value(&disconnected).unwrap();
        for field in ["access", "refresh", "idToken", "scopes", "expires"] {
            assert!(stored.get(field).is_none(), "{field}");
        }
        let saved = StoredAccount::from_value(&stored).unwrap();
        assert!(saved.matches_registration(&connected));
        assert!(saved.credential().is_err());
        assert!(saved.id_token_hint().is_none());
    }

    #[test]
    fn dynamic_entrypoint_is_never_a_saved_registration() {
        assert!(!valid_client_id(DYNAMIC_CLIENT));
        assert!(!valid_client_id(""));
        assert!(!valid_client_id("client with spaces"));
        assert!(valid_client_id("oaiapp_test-client"));
        assert!(valid_host_id(&format!("urn:uuid:{}", uuid::Uuid::new_v4())));
        assert!(!valid_host_id("user@example.com"));
    }

    #[test]
    fn host_registration_survives_restart_and_invalid_data_does_not_rotate_it() {
        super::super::tests::with_temp_dir(|| {
            let first = host_id().unwrap();
            assert_eq!(host_id().unwrap(), first);
            super::super::write_secret_file(
                &super::super::config_dir().join("chatgpt-plan-host-id"),
                "invalid-existing-host",
            )
            .unwrap();
            assert!(host_id().is_err());
        });
    }

    #[tokio::test]
    async fn new_registration_binds_the_exact_loopback_callback_and_pkce() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let redirect = format!(
            "http://127.0.0.1:{}/auth/callback",
            listener.local_addr().unwrap().port()
        );
        let mut attempt = LoginAttempt {
            listener,
            client: http_client().unwrap(),
            endpoints: Endpoints {
                issuer: ISSUER.to_owned(),
                authorization_endpoint: format!("{ISSUER}/api/accounts/authorize"),
                token_endpoint: format!("{ISSUER}/api/accounts/oauth/token"),
                jwks_uri: format!("{ISSUER}/.well-known/jwks.json"),
                revocation_endpoint: format!("{ISSUER}/api/accounts/oauth/revoke"),
            },
            state: random_value(32),
            nonce: random_value(32),
            verifier: random_value(64),
            redirect: redirect.clone(),
            host_id: format!("urn:uuid:{}", uuid::Uuid::new_v4()),
            existing: None,
            pending_client: None,
            enable_plan_use: false,
        };
        let url = reqwest::Url::parse(&attempt.authorization_url().unwrap()).unwrap();
        let query: std::collections::HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(query["client_id"], DYNAMIC_CLIENT);
        assert_eq!(query["redirect_uri"], redirect);
        assert_eq!(query["resource"], RESOURCE);
        assert_eq!(query["agent_name_hint"], "Ryu");
        assert_eq!(query["state"], attempt.state);
        assert_eq!(query["nonce"], attempt.nonce);
        assert_eq!(query["code_challenge_method"], "S256");
        assert_eq!(
            query["code_challenge"],
            URL_SAFE_NO_PAD.encode(Sha256::digest(attempt.verifier.as_bytes()))
        );
        assert!(!query.contains_key("client_secret"));
        drop(query);
        attempt.pending_client = Some("oaiapp_retained".to_owned());
        attempt.state = random_value(32);
        attempt.nonce = random_value(32);
        attempt.verifier = random_value(64);
        let retried = reqwest::Url::parse(&attempt.authorization_url().unwrap()).unwrap();
        let query: std::collections::HashMap<_, _> = retried.query_pairs().collect();
        assert_eq!(query["client_id"], "oaiapp_retained");
        assert!(!query.contains_key("agent_name_hint"));
        assert!(!query.contains_key("id_token_hint"));
    }

    #[tokio::test]
    async fn callback_exchanges_with_issued_client_and_verifies_identity_before_returning_tokens() {
        use axum::{extract::Form, routing::post, Json};
        for (valid_nonce, expired_code) in [(true, false), (false, false), (true, true)] {
            let callback_listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                .await
                .unwrap();
            let redirect = format!(
                "http://127.0.0.1:{}/auth/callback",
                callback_listener.local_addr().unwrap().port()
            );
            let state = random_value(32);
            let nonce = random_value(32);
            let verifier = random_value(64);
            let mut claims = identity_claims();
            claims["nonce"] = serde_json::json!(if valid_nonce {
                nonce.as_str()
            } else {
                "wrong-nonce"
            });
            let tokens = serde_json::json!({ "access_token":"synthetic-issued-access", "refresh_token":"synthetic-issued-refresh",
                "id_token": signed_identity(&claims), "token_type":"Bearer", "expires_in":3600, "scope":SCOPES });
            let captured = Arc::new(Mutex::new(None));
            let capture = captured.clone();
            let token_route = post(
                move |Form(form): Form<std::collections::HashMap<String, String>>| {
                    let capture = capture.clone();
                    let tokens = tokens.clone();
                    async move {
                        *capture.lock().unwrap() = Some(form);
                        if expired_code {
                            (
                                StatusCode::BAD_REQUEST,
                                Json(
                                    serde_json::json!({"error":"invalid_grant", "error_description":"synthetic-secret-must-not-escape"}),
                                ),
                            )
                        } else {
                            (StatusCode::OK, Json(tokens))
                        }
                    }
                },
            );
            let mock = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                .await
                .unwrap();
            let base = format!("http://{}", mock.local_addr().unwrap());
            let app = Router::new().route("/token", token_route).route(
                "/jwks",
                get(|| async {
                    Json(
                        serde_json::from_str::<serde_json::Value>(include_str!(
                            "fixtures/chatgpt-plan-test-jwks.json"
                        ))
                        .unwrap(),
                    )
                }),
            );
            let upstream = tokio::spawn(axum::serve(mock, app).into_future());
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap();
            let attempt = LoginAttempt {
                listener: callback_listener,
                client: client.clone(),
                endpoints: Endpoints {
                    issuer: ISSUER.to_owned(),
                    authorization_endpoint: format!("{base}/authorize"),
                    token_endpoint: format!("{base}/token"),
                    jwks_uri: format!("{base}/jwks"),
                    revocation_endpoint: format!("{base}/revoke"),
                },
                state: state.clone(),
                nonce,
                verifier: verifier.clone(),
                redirect: redirect.clone(),
                host_id: format!("urn:uuid:{}", uuid::Uuid::new_v4()),
                existing: None,
                pending_client: None,
                enable_plan_use: false,
            };
            let completion = tokio::spawn(attempt.complete());
            let callback = client
                .get(&redirect)
                .query(&[
                    ("state", state.as_str()),
                    ("code", "test-code"),
                    ("client_id", "oaiapp_test"),
                ])
                .send()
                .await
                .unwrap();
            assert_eq!(callback.status(), StatusCode::OK);
            let result = completion.await.unwrap();
            assert_eq!(result.is_ok(), valid_nonce && !expired_code);
            if expired_code {
                let error = result.as_ref().err().unwrap();
                assert_eq!(retry_registration(error).as_deref(), Some("oaiapp_test"));
                assert!(!error
                    .to_string()
                    .contains("synthetic-secret-must-not-escape"));
            }
            if let Ok(saved) = result {
                assert!(saved.plan_authorized());
            }
            let form = captured.lock().unwrap().take().unwrap();
            assert_eq!(form["client_id"], "oaiapp_test");
            assert_eq!(form["code_verifier"], verifier);
            assert_eq!(form["redirect_uri"], redirect);
            assert_eq!(form["resource"], RESOURCE);
            assert_eq!(form["grant_type"], "authorization_code");
            assert!(!form.contains_key("client_secret"));
            upstream.abort();
        }
    }

    #[tokio::test]
    async fn callback_rejects_wrong_state_and_consumes_valid_state_once() {
        let (tx, rx) = oneshot::channel();
        let state = Arc::new(CallbackState {
            expected: "expected-state".to_owned(),
            sender: Mutex::new(Some(tx)),
        });
        let query = |state: &str| Callback {
            state: Some(state.to_owned()),
            code: Some("code".to_owned()),
            client_id: Some("oaiapp_test".to_owned()),
            error: None,
        };
        assert_eq!(
            callback(State(state.clone()), Query(query("wrong-state")))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            callback(State(state.clone()), Query(query("expected-state")))
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(
            callback(State(state), Query(query("expected-state")))
                .await
                .0,
            StatusCode::GONE
        );
        assert_eq!(rx.await.unwrap().code.as_deref(), Some("code"));
    }
}
