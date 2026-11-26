//! API keys as a fallback for the Claude subscription accounts.
//!
//! The managed Pi sends Claude subscription requests to Core, and
//! [`crate::server::claude_api::messages`] forwards each one with a signed-in
//! account, moving to the next account when one is at its limit or refused.
//! [`messages`] wraps that handler. While the provider's "use API keys when
//! subscription accounts run out" setting is off (the default) it does nothing
//! else, so a subscription account that hits its limit never falls through to
//! an API key. While it is on, and only after every enabled subscription
//! account was limited or refused, the same request is sent with the first
//! enabled Anthropic API key in the saved order.
//!
//! What moves to the next credential is decided by
//! [`super::failover_rules`], on the status line, before any byte of the
//! answer is passed on.

use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::StreamExt;
use serde_json::{json, Value};

use super::credentials::{self, Settings};
use super::failover_rules::{self as rules, Health, Outcome, Rest, Step};
use super::paid_key_notice::{self, PaidKeyNotice};
use super::Policy;
use crate::pi_config::accounts::{AccountInfo, AccountVault, KIND_API_KEY, KIND_OAUTH};
use crate::server::ServerState;

const PROVIDER: &str = "claude-pro-max";
const UPSTREAM: &str = "https://api.anthropic.com/v1/messages";
/// How many accounts the subscription handler tries in one call.
const SUBSCRIPTION_ATTEMPTS_PER_CALL: usize = 4;
/// Upper bound on calls into the subscription handler for one request.
const MAX_SUBSCRIPTION_CALLS: usize = 4;
/// Upper bound on API keys tried for one request.
const MAX_KEY_ATTEMPTS: usize = 4;
/// Marks an answer that an API key produced.
pub(crate) const SOURCE_HEADER: &str = "x-ryu-credential";
pub(crate) const SOURCE_API_KEY: &str = "api-key-fallback";
const RESET_HEADERS: [&str; 4] = [
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-reset",
    "anthropic-ratelimit-input-tokens-reset",
    "anthropic-ratelimit-output-tokens-reset",
];
const FORWARDED_HEADERS: [&str; 4] = ["anthropic-version", "accept", "user-agent", "x-app"];

/// An API key that may take over. Holds the account's id and label, never the key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct KeyCandidate {
    pub(crate) account_id: String,
    pub(crate) label: String,
}

/// What the shared Claude and Anthropic account list offers for one request.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Plan {
    /// Signed-in subscription accounts the account pool policy allows.
    pub(crate) enabled_subscriptions: usize,
    /// Enabled API keys, first to try first.
    pub(crate) keys: Vec<KeyCandidate>,
}

/// Build the plan from every account of the shared scope.
pub(crate) fn plan(
    accounts: Vec<AccountInfo>,
    subscription_policy: &Policy,
    key_policy: &Policy,
) -> Plan {
    let enabled_subscriptions = accounts
        .iter()
        .filter(|account| {
            account.kind == KIND_OAUTH && subscription_policy.allowed(&account.account_id)
        })
        .count();
    let keys = credentials::in_order(
        accounts
            .into_iter()
            .filter(|account| account.kind == KIND_API_KEY)
            .collect(),
        key_policy,
    )
    .into_iter()
    .filter(|account| key_policy.allowed(&account.account_id))
    .map(|account| KeyCandidate {
        account_id: account.account_id,
        label: account.label,
    })
    .collect();
    Plan {
        enabled_subscriptions,
        keys,
    }
}

/// Whether an API key may be tried after the subscription accounts answered
/// `status`. Never while the setting is off, never without a subscription
/// account to run out, and never for an answer that does not move on.
pub(crate) fn may_use_key(settings: Settings, plan: &Plan, status: u16) -> bool {
    settings.api_key_fallback
        && plan.enabled_subscriptions > 0
        && !plan.keys.is_empty()
        && rules::moves_on(status)
}

/// The subscription handler tries a few accounts per call. Call it often
/// enough that every enabled account had its turn before a key is used.
pub(crate) fn subscription_calls(enabled_subscriptions: usize) -> usize {
    (1 + enabled_subscriptions.saturating_sub(1) / SUBSCRIPTION_ATTEMPTS_PER_CALL)
        .min(MAX_SUBSCRIPTION_CALLS)
}

/// An API key ready to send. Never printed.
struct Secret(HeaderValue);

impl std::fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Secret(redacted)")
    }
}

fn read_key(vault: &AccountVault, scope: &str, account_id: &str) -> Option<Secret> {
    let credential = vault.credential(scope, account_id).ok().flatten()?;
    let key = credential
        .as_str()
        .or_else(|| credential.get("key").and_then(Value::as_str))?
        .trim();
    if key.is_empty() {
        return None;
    }
    let mut value = HeaderValue::from_str(key).ok()?;
    value.set_sensitive(true);
    Some(Secret(value))
}

fn lock(health: &Mutex<Health>) -> MutexGuard<'_, Health> {
    health.lock().unwrap_or_else(PoisonError::into_inner)
}

fn key_health() -> &'static Mutex<Health> {
    static HEALTH: OnceLock<Mutex<Health>> = OnceLock::new();
    HEALTH.get_or_init(|| Mutex::new(Health::default()))
}

/// Why a fallback key is resting right now, for the settings screen.
pub(crate) fn resting(account_id: &str) -> Option<Rest> {
    lock(key_health()).resting(account_id, Instant::now())
}

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "error": { "type": code, "message": message } })),
    )
        .into_response()
}

/// The client for API key calls. Anthropic traffic follows the owner's
/// "route through your computer" choice here too, and is refused, not sent
/// from the cloud, when that route cannot carry it.
fn client() -> Result<&'static reqwest::Client, &'static str> {
    use crate::local_egress::providers::{self, ProviderRoute};
    static DIRECT: OnceLock<reqwest::Client> = OnceLock::new();
    static ROUTED: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    let builder = || reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
    if let Some(proxy) = providers::reqwest_proxy(ProviderRoute::Claude)? {
        return ROUTED
            .get_or_init(|| builder().proxy(proxy).build().ok())
            .as_ref()
            .ok_or(providers::ROUTE_UNAVAILABLE);
    }
    Ok(DIRECT.get_or_init(|| builder().build().unwrap_or_default()))
}

/// The `anthropic-beta` list without the entries that only apply to a
/// subscription sign-in.
fn api_key_beta(headers: &HeaderMap) -> Option<HeaderValue> {
    let value = headers.get("anthropic-beta")?.to_str().ok()?;
    let kept: Vec<&str> = value
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty() && !entry.starts_with("oauth-"))
        .collect();
    if kept.is_empty() {
        return None;
    }
    HeaderValue::from_str(&kept.join(",")).ok()
}

enum SendError {
    /// No answer arrived.
    Unreachable,
    /// The request must leave through the owner's computer and cannot.
    RouteUnavailable(&'static str),
}

async fn send(
    headers: &HeaderMap,
    body: Bytes,
    key: &Secret,
    url: &str,
) -> Result<reqwest::Response, SendError> {
    let client = client().map_err(SendError::RouteUnavailable)?;
    let mut request = client
        .post(url)
        .header("x-api-key", key.0.clone())
        .header("content-type", "application/json")
        .body(body);
    for name in FORWARDED_HEADERS {
        if let Some(value) = headers.get(name) {
            request = request.header(name, value.clone());
        }
    }
    if let Some(beta) = api_key_beta(headers) {
        request = request.header("anthropic-beta", beta);
    }
    request.send().await.map_err(|_| SendError::Unreachable)
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn wait_hint(headers: &HeaderMap) -> Option<Duration> {
    let resets: Vec<&str> = RESET_HEADERS
        .iter()
        .filter_map(|name| header_text(headers, name))
        .collect();
    rules::wait_hint(
        header_text(headers, "retry-after"),
        &resets,
        chrono::Utc::now(),
    )
}

/// Pass the provider's answer on as a stream.
fn into_response(upstream: reqwest::Response) -> Response {
    let status = upstream.status();
    let content_type = upstream
        .headers()
        .get("content-type")
        .cloned()
        .unwrap_or_else(|| HeaderValue::from_static("application/json"));
    let retry_after = upstream.headers().get("retry-after").cloned();
    let stream = upstream
        .bytes_stream()
        .map(|chunk| chunk.map_err(|_| std::io::Error::other("API key stream ended early")));
    let mut response = Response::builder()
        .status(status)
        .header("content-type", content_type)
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response());
    if let Some(value) = retry_after {
        response.headers_mut().insert("retry-after", value);
    }
    response
}

/// How the API keys answered.
pub(crate) enum KeyLeg {
    /// A key served the request.
    Served(Response, KeyCandidate),
    /// A key got an answer that is returned as it is, or could not be reached.
    Answered(Response),
    /// No key could be tried: none is saved, or every one is resting.
    Unavailable,
}

/// Send the request with the first usable key, following the rule table.
pub(crate) async fn try_keys(
    vault: &AccountVault,
    scope: &str,
    keys: &[KeyCandidate],
    headers: &HeaderMap,
    body: &Bytes,
    url: &str,
    health: &Mutex<Health>,
) -> KeyLeg {
    let mut tried = 0;
    for key in keys {
        if tried == MAX_KEY_ATTEMPTS {
            break;
        }
        if !lock(health).usable(&key.account_id, Instant::now()) {
            continue;
        }
        let Some(secret) = read_key(vault, scope, &key.account_id) else {
            continue;
        };
        tried += 1;
        let mut attempts = 0;
        loop {
            attempts += 1;
            let sent = send(headers, body.clone(), &secret, url).await;
            let (outcome, hint) = match &sent {
                Ok(upstream) => (
                    rules::outcome(upstream.status().as_u16()),
                    wait_hint(upstream.headers()),
                ),
                Err(SendError::Unreachable) => (Outcome::Unreachable, None),
                Err(SendError::RouteUnavailable(reason)) => {
                    return KeyLeg::Answered(error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "provider_route_unavailable",
                        reason,
                    ));
                }
            };
            match rules::step(outcome, hint, attempts) {
                Step::RetrySame => {}
                Step::NextCredential { rest, retry_in } => {
                    lock(health).rest(&key.account_id, rest, retry_in, Instant::now());
                    break;
                }
                Step::Done => {
                    return match sent {
                        Ok(upstream) if outcome == Outcome::Served => {
                            lock(health).clear(&key.account_id);
                            KeyLeg::Served(into_response(upstream), key.clone())
                        }
                        Ok(upstream) => KeyLeg::Answered(into_response(upstream)),
                        Err(_) => KeyLeg::Answered(error(
                            StatusCode::BAD_GATEWAY,
                            "upstream_unreachable",
                            "The provider could not be reached with the API key",
                        )),
                    };
                }
            }
        }
    }
    KeyLeg::Unavailable
}

/// Everything one request needs to decide between the two kinds of credential.
pub(crate) struct Flow<'a> {
    pub(crate) settings: Settings,
    pub(crate) plan: &'a Plan,
    pub(crate) vault: &'a AccountVault,
    pub(crate) scope: &'a str,
    pub(crate) url: &'a str,
    pub(crate) health: &'a Mutex<Health>,
}

/// Run one request: the subscription accounts first, then, only if allowed,
/// the API keys. Returns the answer and the key that served it, if one did.
pub(crate) async fn run<Call, Answer>(
    flow: &Flow<'_>,
    headers: &HeaderMap,
    body: &Bytes,
    mut subscription: Call,
) -> (Response, Option<KeyCandidate>)
where
    Call: FnMut() -> Answer,
    Answer: std::future::Future<Output = Response>,
{
    let mut response = subscription().await;
    if !flow.settings.api_key_fallback {
        return (response, None);
    }
    for _ in 1..subscription_calls(flow.plan.enabled_subscriptions) {
        if !rules::moves_on(response.status().as_u16()) {
            break;
        }
        response = subscription().await;
    }
    if !may_use_key(flow.settings, flow.plan, response.status().as_u16()) {
        return (response, None);
    }
    let leg = try_keys(
        flow.vault,
        flow.scope,
        &flow.plan.keys,
        headers,
        body,
        flow.url,
        flow.health,
    )
    .await;
    match leg {
        KeyLeg::Served(mut served, key) => {
            served
                .headers_mut()
                .insert(SOURCE_HEADER, HeaderValue::from_static(SOURCE_API_KEY));
            (served, Some(key))
        }
        KeyLeg::Answered(answer) => (answer, None),
        KeyLeg::Unavailable => (response, None),
    }
}

fn session_id(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("x-ryu-session-id")
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .and_then(|value| value.to_str().ok())
}

/// The Claude subscription route. See the module text.
pub async fn messages(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let settings = credentials::load_settings(&state.preferences, PROVIDER).await;
    let (true, Some(vault), Some(key_provider)) = (
        settings.api_key_fallback,
        crate::pi_config::accounts::global(),
        credentials::fallback_key_provider(PROVIDER),
    ) else {
        return crate::server::claude_api::messages(State(state), headers, body).await;
    };
    let subscription_policy = super::load(&state.preferences, PROVIDER).await;
    let key_policy = super::load(&state.preferences, key_provider).await;
    let scope = crate::pi_config::accounts::provider_scope(crate::pi_config::CLAUDE_AUTH_KEY);
    let list_scope = scope.clone();
    // Vault reads are synchronous; keep the listing off the async workers.
    let listed = tokio::task::spawn_blocking(move || vault.list(&list_scope)).await;
    let plan = match listed {
        Ok(Ok(accounts)) => plan(accounts, &subscription_policy, &key_policy),
        _ => Plan::default(),
    };
    {
        let known: Vec<&str> = plan
            .keys
            .iter()
            .map(|key| key.account_id.as_str())
            .collect();
        lock(key_health()).prune(&known, Instant::now());
    }
    let flow = Flow {
        settings,
        plan: &plan,
        vault,
        scope: &scope,
        url: UPSTREAM,
        health: key_health(),
    };
    let (response, served_by) = run(&flow, &headers, &body, || {
        crate::server::claude_api::messages(State(state.clone()), headers.clone(), body.clone())
    })
    .await;
    if let (Some(key), Some(conversation)) = (served_by, session_id(&headers)) {
        let notice = PaidKeyNotice {
            provider_id: PROVIDER.to_owned(),
            key_provider_id: key_provider.to_owned(),
            account_id: key.account_id,
            label: key.label,
        };
        paid_key_notice::record(&state.preferences, conversation, notice).await;
    }
    response
}

#[cfg(test)]
#[path = "claude_fallback_test.rs"]
mod tests;
