//! Native Anthropic Messages transport for the managed Pi's Claude OAuth login.
//! The Pi process holds only a local placeholder; Core selects and refreshes the
//! sealed account before forwarding each request with that account's real bearer.

use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::StreamExt;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const UPSTREAM: &str = "https://api.anthropic.com/v1/messages";
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_BINDINGS: usize = 10_000;
const IDLE_TTL: Duration = Duration::from_secs(60 * 60);
const DEFAULT_COOLDOWN: Duration = Duration::from_secs(60);
const MAX_COOLDOWN: Duration = Duration::from_secs(32 * 24 * 60 * 60);
const MAX_POOL_ATTEMPTS: usize = 4;
const RATE_LIMIT_RESET_HEADERS: [&str; 4] = [
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-reset",
    "anthropic-ratelimit-input-tokens-reset",
    "anthropic-ratelimit-output-tokens-reset",
];

struct Binding {
    account_id: String,
    last_used: Instant,
}

struct EligibleAccount {
    account_id: String,
    revision: Vec<u8>,
}

enum AccountHealth {
    Cooling(Instant),
    NeedsReauth { revision: Vec<u8> },
}

enum Selection {
    Account(String, Vec<u8>),
    NotConnected,
    Disabled,
    Cooling(Duration),
    NeedsReauth,
}

#[derive(Default)]
struct Bindings {
    sessions: HashMap<String, Binding>,
    health: HashMap<String, AccountHealth>,
    pool_cursor: super::oauth_pool_usage::PoolCursor,
}

impl Bindings {
    #[cfg(test)]
    fn select(&mut self, session: &str, eligible: &[EligibleAccount], active: &str) -> Selection {
        self.select_with_policy(
            session,
            eligible,
            active,
            &crate::server::oauth_pool_policy::Policy::default(),
        )
    }

    fn select_with_policy(
        &mut self,
        session: &str,
        eligible: &[EligibleAccount],
        active: &str,
        policy: &super::oauth_pool_policy::Policy,
    ) -> Selection {
        let now = Instant::now();
        self.sessions
            .retain(|_, binding| now.duration_since(binding.last_used) < IDLE_TTL);
        self.health.retain(|id, health| {
            let Some(account) = eligible.iter().find(|account| &account.account_id == id) else {
                return false;
            };
            match health {
                AccountHealth::Cooling(until) => *until > now,
                AccountHealth::NeedsReauth { revision } => account.revision == *revision,
            }
        });
        if let Some(binding) = self.sessions.get_mut(session) {
            if let Some(account) = eligible
                .iter()
                .find(|account| account.account_id == binding.account_id)
                .filter(|_| {
                    policy.allowed(&binding.account_id)
                        && !self.health.contains_key(&binding.account_id)
                })
            {
                binding.last_used = now;
                return Selection::Account(binding.account_id.clone(), account.revision.clone());
            }
        }
        self.release(session);
        let ready: Vec<_> = eligible
            .iter()
            .filter(|account| !self.health.contains_key(&account.account_id))
            .map(|account| super::oauth_pool_usage::Candidate {
                account_id: &account.account_id,
                revision: &account.revision,
            })
            .collect();
        let selected = self
            .pool_cursor
            .select("claude-pro-max", &ready, active, policy)
            .and_then(|index| {
                eligible
                    .iter()
                    .find(|account| account.account_id == ready[index].account_id)
            });
        let Some(selected) = selected else {
            if eligible
                .iter()
                .all(|account| !policy.allowed(&account.account_id))
            {
                return Selection::Disabled;
            }
            let retry_after = self
                .health
                .values()
                .filter_map(|health| match health {
                    AccountHealth::Cooling(until) => Some(until.duration_since(now)),
                    AccountHealth::NeedsReauth { .. } => None,
                })
                .min();
            return retry_after.map_or(Selection::NeedsReauth, Selection::Cooling);
        };
        if self.sessions.len() >= MAX_BINDINGS {
            if let Some(oldest) = self
                .sessions
                .iter()
                .min_by_key(|(_, binding)| binding.last_used)
                .map(|(id, _)| id.clone())
            {
                self.release(&oldest);
            }
        }
        self.sessions.insert(
            session.to_owned(),
            Binding {
                account_id: selected.account_id.clone(),
                last_used: now,
            },
        );
        Selection::Account(selected.account_id.clone(), selected.revision.clone())
    }

    fn release(&mut self, session: &str) {
        self.sessions.remove(session);
    }

    fn peek(&self, session: &str) -> Option<String> {
        self.sessions
            .get(session)
            .filter(|binding| binding.last_used.elapsed() < IDLE_TTL)
            .map(|binding| binding.account_id.clone())
    }

    fn release_if_matches(&mut self, session: &str, account_id: &str) {
        if self
            .sessions
            .get(session)
            .is_some_and(|binding| binding.account_id == account_id)
        {
            self.release(session);
        }
    }

    fn record_failure(
        &mut self,
        session: &str,
        account_id: &str,
        revision: &[u8],
        status: StatusCode,
        retry_after: Option<&HeaderValue>,
        reset_deadlines: &[Option<&HeaderValue>],
    ) {
        self.release_if_matches(session, account_id);
        let health = match status {
            StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE => {
                let wait = retry_after
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok())
                    .map(Duration::from_secs)
                    .or_else(|| {
                        reset_deadlines
                            .iter()
                            .flatten()
                            .filter_map(|value| value.to_str().ok())
                            .filter_map(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                            .filter_map(|deadline| {
                                (deadline.with_timezone(&chrono::Utc) - chrono::Utc::now())
                                    .to_std()
                                    .ok()
                            })
                            .max()
                    })
                    .unwrap_or(DEFAULT_COOLDOWN)
                    .min(MAX_COOLDOWN);
                AccountHealth::Cooling(Instant::now() + wait)
            }
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => AccountHealth::NeedsReauth {
                revision: revision.to_vec(),
            },
            _ => return,
        };
        self.health.insert(account_id.to_owned(), health);
    }
}

fn bindings() -> &'static Mutex<Bindings> {
    static BINDINGS: OnceLock<Mutex<Bindings>> = OnceLock::new();
    BINDINGS.get_or_init(|| Mutex::new(Bindings::default()))
}

/// The account a live Claude proxy session is bound to, without touching the
/// binding: no idle-TTL refresh, no selection and no eviction. A binding past
/// its idle TTL reads as unbound because the next request would reselect.
pub(crate) fn peek_binding(session_key: &str) -> Option<String> {
    bindings()
        .lock()
        .expect("Claude session binding mutex")
        .peek(session_key)
}

fn session_id(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("x-ryu-session-id")
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .and_then(|value| value.to_str().ok())
}

fn selected_account(
    vault: &crate::pi_config::accounts::AccountVault,
    bindings: &Mutex<Bindings>,
    session: &str,
) -> anyhow::Result<Selection> {
    selected_account_with_policy(
        vault,
        bindings,
        session,
        &crate::server::oauth_pool_policy::Policy::default(),
    )
}

fn selected_account_with_policy(
    vault: &crate::pi_config::accounts::AccountVault,
    bindings: &Mutex<Bindings>,
    session: &str,
    policy: &super::oauth_pool_policy::Policy,
) -> anyhow::Result<Selection> {
    let scope = crate::pi_config::accounts::provider_scope(crate::pi_config::CLAUDE_AUTH_KEY);
    let Some(active) = vault.active_info(&scope)? else {
        return Ok(Selection::NotConnected);
    };
    if active.kind != crate::pi_config::accounts::KIND_OAUTH {
        return Ok(Selection::NotConnected);
    }
    let mut eligible = Vec::new();
    for account in vault.list(&scope)? {
        if account.kind != crate::pi_config::accounts::KIND_OAUTH {
            continue;
        }
        if let Some(revision) = vault.credential_revision(&scope, &account.account_id)? {
            eligible.push(EligibleAccount {
                account_id: account.account_id,
                revision,
            });
        }
    }
    Ok(bindings
        .lock()
        .expect("Claude session binding mutex")
        .select_with_policy(session, &eligible, &active.account_id, policy))
}

/// Why Claude could not be reached. A route through the owner's desktop fails
/// closed while that computer is away, so say so instead of blaming Anthropic.
fn unreachable_message() -> &'static str {
    use crate::local_egress::providers::{route_required, ProviderRoute};
    if route_required(ProviderRoute::Claude) {
        "Claude traffic is routed through your computer, which could not carry it. Open Ryu on that computer, or turn off \"Route through your computer\" for Claude"
    } else {
        "Claude upstream could not be reached"
    }
}

/// The client for Claude upstream calls. `Err` when Claude must leave through
/// the owner's desktop but the route cannot carry it: the call is refused, not
/// sent from the cloud.
fn client() -> Result<&'static reqwest::Client, &'static str> {
    use crate::local_egress::providers::{self, ProviderRoute};
    static DIRECT: OnceLock<reqwest::Client> = OnceLock::new();
    static ROUTED: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    let builder = || reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
    // On a cloud node whose owner routes Claude through their desktop. The
    // proxy endpoint is fixed for the process, so the routed client is cached.
    // A routed client that fails to build refuses too: a default client would
    // have no proxy and send the call from the cloud.
    if let Some(proxy) = providers::reqwest_proxy(ProviderRoute::Claude)? {
        return ROUTED
            .get_or_init(|| builder().proxy(proxy).build().ok())
            .as_ref()
            .ok_or(providers::ROUTE_UNAVAILABLE);
    }
    Ok(DIRECT.get_or_init(|| builder().build().unwrap_or_default()))
}

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "error": { "type": code, "message": message } })),
    )
        .into_response()
}

fn with_anthropic_headers(
    mut request: reqwest::RequestBuilder,
    headers: &HeaderMap,
) -> reqwest::RequestBuilder {
    for name in [
        "anthropic-version",
        "anthropic-beta",
        "accept",
        "user-agent",
        "x-app",
    ] {
        if let Some(value) = headers.get(name) {
            request = request.header(name, value.clone());
        }
    }
    request
}

/// Forward Pi's native Messages request with one sealed account credential.
pub async fn messages(
    State(state): State<super::ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if body.len() > MAX_REQUEST_BYTES {
        return error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "request_too_large",
            "request body is too large",
        );
    }
    let session = session_id(&headers);
    let policy = super::oauth_pool_policy::load(&state.preferences, "claude-pro-max").await;
    super::oauth_pool_usage::warm_in_background("claude-pro-max", &policy);
    let mut selected = match (session, crate::pi_config::accounts::global()) {
        (Some(session), Some(vault)) => {
            match selected_account_with_policy(vault, bindings(), session, &policy) {
                Ok(Selection::Account(account, revision)) => Some((account, revision)),
                Ok(Selection::NotConnected) => {
                    return error(
                        StatusCode::UNAUTHORIZED,
                        "authentication_error",
                        "Claude is not connected",
                    );
                }
                Ok(Selection::Cooling(wait)) => {
                    let mut response = error(
                        StatusCode::TOO_MANY_REQUESTS,
                        "rate_limit_error",
                        "All connected Claude accounts are cooling down",
                    );
                    if let Ok(value) = HeaderValue::from_str(&wait.as_secs().max(1).to_string()) {
                        response.headers_mut().insert("retry-after", value);
                    }
                    return response;
                }
                Ok(Selection::Disabled) => {
                    return error(
                        StatusCode::CONFLICT,
                        "account_pool_disabled",
                        "All connected Claude accounts are disabled in account routing",
                    );
                }
                Ok(Selection::NeedsReauth) => {
                    return error(
                        StatusCode::UNAUTHORIZED,
                        "authentication_error",
                        "Connected Claude accounts need a new login",
                    );
                }
                Err(_) => {
                    return error(
                        StatusCode::BAD_GATEWAY,
                        "credential_error",
                        "Claude account could not be resolved",
                    );
                }
            }
        }
        _ => None,
    };
    for attempt in 0..MAX_POOL_ATTEMPTS {
        let response = match forward_selected(&headers, body.clone(), session, &mut selected).await
        {
            Ok(response) => response,
            Err(response) => {
                if let (Some(session), Some(vault), Some(current)) = (
                    session,
                    crate::pi_config::accounts::global(),
                    selected.as_ref(),
                ) {
                    if let Some(next) = next_after_local_failure(
                        vault,
                        bindings(),
                        session,
                        current,
                        response.status(),
                        attempt + 1 < MAX_POOL_ATTEMPTS,
                        &policy,
                    ) {
                        selected = Some(next);
                        continue;
                    }
                }
                return response;
            }
        };
        let next = match (
            session,
            crate::pi_config::accounts::global(),
            selected.as_ref(),
        ) {
            (Some(session), Some(vault), Some(current)) => next_after_response(
                vault,
                bindings(),
                session,
                current,
                &response,
                attempt + 1 < MAX_POOL_ATTEMPTS,
                &policy,
            ),
            _ => None,
        };
        if !matches!(response.status().as_u16(), 401 | 403 | 429)
            || attempt + 1 == MAX_POOL_ATTEMPTS
        {
            return response;
        }
        match next {
            Some(next) => selected = Some(next),
            None => return response,
        }
    }
    StatusCode::BAD_GATEWAY.into_response()
}

fn next_after_local_failure(
    vault: &crate::pi_config::accounts::AccountVault,
    state: &Mutex<Bindings>,
    session: &str,
    current: &(String, Vec<u8>),
    status: StatusCode,
    allow_retry: bool,
    policy: &super::oauth_pool_policy::Policy,
) -> Option<(String, Vec<u8>)> {
    // An explicit refresh rejection can cool down; revoked/uncertain refresh
    // needs reauthentication. Unknown local errors do not imply rate limiting.
    if !matches!(status.as_u16(), 401 | 503) {
        return None;
    }
    state
        .lock()
        .expect("Claude session binding mutex")
        .record_failure(session, &current.0, &current.1, status, None, &[]);
    if !allow_retry {
        return None;
    }
    match selected_account_with_policy(vault, state, session, policy) {
        Ok(Selection::Account(next, revision)) if next != current.0 => Some((next, revision)),
        _ => None,
    }
}

fn next_after_response(
    vault: &crate::pi_config::accounts::AccountVault,
    state: &Mutex<Bindings>,
    session: &str,
    current: &(String, Vec<u8>),
    response: &Response,
    allow_retry: bool,
    policy: &super::oauth_pool_policy::Policy,
) -> Option<(String, Vec<u8>)> {
    if matches!(response.status().as_u16(), 401 | 403 | 429) {
        state
            .lock()
            .expect("Claude session binding mutex")
            .record_failure(
                session,
                &current.0,
                &current.1,
                response.status(),
                response.headers().get("retry-after"),
                &RATE_LIMIT_RESET_HEADERS.map(|name| response.headers().get(name)),
            );
    }
    if !matches!(response.status().as_u16(), 401 | 403 | 429) || !allow_retry {
        return None;
    }
    match selected_account_with_policy(vault, state, session, policy) {
        Ok(Selection::Account(next, revision)) if next != current.0 => Some((next, revision)),
        _ => None,
    }
}

async fn forward_selected(
    headers: &HeaderMap,
    body: Bytes,
    session: Option<&str>,
    selected: &mut Option<(String, Vec<u8>)>,
) -> Result<Response, Response> {
    let credential = if let Some((account_id, _)) = selected.as_ref() {
        crate::pi_config::subscription_request_credential_for_account("claude-pro-max", account_id)
            .await
            .map(Some)
    } else {
        crate::pi_config::subscription_request_credential("claude-pro-max").await
    };
    let credential = match credential {
        Ok(Some(value)) => value,
        result => {
            if let (Some(session), Some((account, _))) = (session, selected.as_ref()) {
                bindings()
                    .lock()
                    .expect("Claude session binding mutex")
                    .release_if_matches(session, account);
            }
            let (status, code, message) = match result {
                Err(error) => local_refresh_failure(&error),
                _ => (
                    StatusCode::UNAUTHORIZED,
                    "authentication_error",
                    "Claude account needs a new login",
                ),
            };
            return Err(error(status, code, message));
        }
    };
    if let (Some((account_id, revision)), Some(vault)) =
        (selected.as_mut(), crate::pi_config::accounts::global())
    {
        let current = vault.credential_revision(
            &crate::pi_config::accounts::provider_scope(crate::pi_config::CLAUDE_AUTH_KEY),
            account_id,
        );
        match current {
            Ok(Some(current)) => *revision = current,
            _ => {
                return Err(error(
                    StatusCode::UNAUTHORIZED,
                    "authentication_error",
                    "Claude account was removed before this request",
                ));
            }
        }
    }
    let Some(access) = credential
        .get("access")
        .or_else(|| credential.get("access_token"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|access| !access.is_empty())
    else {
        return Err(error(
            StatusCode::UNAUTHORIZED,
            "authentication_error",
            "Claude account has no access token",
        ));
    };
    Ok(forward_messages(headers, body, access, UPSTREAM).await)
}

fn local_refresh_failure(error: &anyhow::Error) -> (StatusCode, &'static str, &'static str) {
    use crate::pi_config::accounts::RefreshFailure;
    match error.downcast_ref::<RefreshFailure>() {
        Some(RefreshFailure::Transient) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "refresh_temporarily_unavailable",
            "Claude refresh is temporarily unavailable; try again later",
        ),
        Some(RefreshFailure::Revoked | RefreshFailure::Uncertain) => (
            StatusCode::UNAUTHORIZED,
            "authentication_error",
            "Claude account needs a new login",
        ),
        None => (
            StatusCode::BAD_GATEWAY,
            "credential_error",
            "Could not read Claude account credentials",
        ),
    }
}

async fn forward_messages(headers: &HeaderMap, body: Bytes, access: &str, url: &str) -> Response {
    let client = match client() {
        Ok(client) => client,
        Err(reason) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "provider_route_unavailable",
                reason,
            )
        }
    };
    let request = client
        .post(url)
        .bearer_auth(access)
        .header("content-type", "application/json")
        .body(body);
    let upstream = match with_anthropic_headers(request, &headers).send().await {
        Ok(response) => response,
        Err(_) => {
            return error(
                StatusCode::BAD_GATEWAY,
                "upstream_unreachable",
                unreachable_message(),
            );
        }
    };
    let status = upstream.status();
    let content_type = upstream
        .headers()
        .get("content-type")
        .cloned()
        .unwrap_or_else(|| HeaderValue::from_static("application/json"));
    let retry_after = upstream.headers().get("retry-after").cloned();
    let reset_headers: Vec<_> = RATE_LIMIT_RESET_HEADERS
        .iter()
        .filter_map(|name| {
            upstream
                .headers()
                .get(*name)
                .cloned()
                .map(|value| (*name, value))
        })
        .collect();
    let stream = upstream.bytes_stream().map(|chunk| {
        chunk.map_err(|error| std::io::Error::other(format!("Claude stream: {error}")))
    });
    let mut response = Response::builder()
        .status(status)
        .header("content-type", content_type)
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response());
    if let Some(value) = retry_after {
        response.headers_mut().insert("retry-after", value);
    }
    for (name, value) in reset_headers {
        response.headers_mut().insert(name, value);
    }
    response
}

/// The smallest Messages request that still counts as a turn. Claude OAuth
/// logins only accept requests that identify as Claude Code, so the system
/// block and beta header match what Pi sends through [`messages`].
fn ping_body(model: &str, prompt: &str) -> serde_json::Value {
    json!({
        "model": model,
        "max_tokens": 16,
        "stream": false,
        "system": [{
            "type": "text",
            "text": "You are Claude Code, Anthropic's official CLI for Claude.",
        }],
        "messages": [{ "role": "user", "content": prompt }],
    })
}

/// Send one minimal turn on exactly `account_id`, bypassing pool selection.
///
/// Scheduled warmups use this to open a specific account's rolling usage
/// window: routing through [`messages`] would let the pool policy pick a
/// different login, which is exactly the account the user did not ask for.
pub async fn ping_account(account_id: &str, model: &str, prompt: &str) -> anyhow::Result<()> {
    let credential =
        crate::pi_config::subscription_request_credential_for_account("claude-pro-max", account_id)
            .await?;
    let access = credential
        .get("access")
        .or_else(|| credential.get("access_token"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|access| !access.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Claude account has no access token"))?;
    let response = client()
        .map_err(|reason| anyhow::anyhow!(reason))?
        .post(UPSTREAM)
        .bearer_auth(access)
        .header("content-type", "application/json")
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "claude-code-20250219,oauth-2025-04-20")
        .header("x-app", "cli")
        .json(&ping_body(model, prompt))
        .send()
        .await
        .map_err(|_| anyhow::anyhow!(unreachable_message()))?;
    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("Claude returned {status} for this account");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        forward_messages, next_after_local_failure, next_after_response, selected_account,
        with_anthropic_headers, Bindings, EligibleAccount, Selection,
    };
    use axum::{
        body::{to_bytes, Bytes},
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::post,
        Router,
    };
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn selected_id(selection: Selection) -> Option<String> {
        match selection {
            Selection::Account(id, _) => Some(id),
            _ => None,
        }
    }

    #[test]
    fn peek_reports_a_binding_without_creating_or_refreshing_one() {
        let mut bindings = Bindings::default();
        assert_eq!(bindings.peek("thread"), None);
        assert!(bindings.sessions.is_empty());
        let eligible = [EligibleAccount {
            account_id: "first".to_owned(),
            revision: b"r".to_vec(),
        }];
        assert_eq!(
            selected_id(bindings.select("thread", &eligible, "first")).as_deref(),
            Some("first")
        );
        let last_used = bindings.sessions["thread"].last_used;
        assert_eq!(bindings.peek("thread").as_deref(), Some("first"));
        assert_eq!(bindings.sessions["thread"].last_used, last_used);
        assert_eq!(bindings.peek("other-thread"), None);
        assert_eq!(bindings.sessions.len(), 1);
    }

    #[test]
    fn account_switch_keeps_an_existing_claude_session_on_its_sealed_login() {
        let vault = crate::pi_config::accounts::AccountVault::in_memory().expect("vault");
        let scope = crate::pi_config::accounts::provider_scope(crate::pi_config::CLAUDE_AUTH_KEY);
        for (id, access) in [("first", "token-one"), ("second", "token-two")] {
            vault
                .upsert(
                    &scope,
                    id,
                    id,
                    crate::pi_config::accounts::KIND_OAUTH,
                    Some(json!({ "type": "oauth", "access": access })),
                )
                .expect("saved login");
        }
        vault.set_active(&scope, "first").expect("first active");
        let bindings = Mutex::new(Bindings::default());
        assert_eq!(
            selected_account(&vault, &bindings, "thread")
                .map(selected_id)
                .unwrap()
                .as_deref(),
            Some("first")
        );
        vault.set_active(&scope, "second").expect("second active");
        assert_eq!(
            selected_account(&vault, &bindings, "thread")
                .map(selected_id)
                .unwrap()
                .as_deref(),
            Some("first")
        );
        assert_eq!(
            selected_account(&vault, &bindings, "new-thread")
                .map(selected_id)
                .unwrap()
                .as_deref(),
            Some("second")
        );
        vault.remove(&scope, "first").expect("remove login");
        assert_eq!(
            selected_account(&vault, &bindings, "thread")
                .map(selected_id)
                .unwrap()
                .as_deref(),
            Some("second")
        );
    }

    #[test]
    fn round_robin_preserves_an_existing_claude_session_binding() {
        let accounts = ["first", "second"].map(|id| EligibleAccount {
            account_id: id.to_owned(),
            revision: vec![1],
        });
        let mut bindings = Bindings::default();
        let policy = crate::server::oauth_pool_policy::Policy {
            strategy: crate::server::oauth_pool_policy::Strategy::RoundRobin,
            ..Default::default()
        };
        assert_eq!(
            selected_id(bindings.select_with_policy("warm", &accounts, "first", &policy))
                .as_deref(),
            Some("first")
        );
        assert_eq!(
            selected_id(bindings.select_with_policy("new", &accounts, "first", &policy)).as_deref(),
            Some("second")
        );
        assert_eq!(
            selected_id(bindings.select_with_policy("warm", &accounts, "second", &policy))
                .as_deref(),
            Some("first")
        );
    }

    #[test]
    fn rate_limited_account_cools_and_another_account_takes_new_work() {
        let accounts = ["first", "second"].map(|id| EligibleAccount {
            account_id: id.to_owned(),
            revision: vec![1],
        });
        let mut pool = Bindings::default();
        assert_eq!(
            selected_id(pool.select("bound", &accounts, "first")).as_deref(),
            Some("first")
        );
        assert_eq!(
            selected_id(pool.select("healthy", &accounts, "first")).as_deref(),
            Some("first")
        );
        pool.record_failure(
            "bound",
            "first",
            &[1],
            StatusCode::TOO_MANY_REQUESTS,
            Some(&"30".parse().unwrap()),
            &[],
        );
        assert_eq!(
            selected_id(pool.select("bound", &accounts, "first")).as_deref(),
            Some("second")
        );
        assert_eq!(
            selected_id(pool.select("new", &accounts, "first")).as_deref(),
            Some("second")
        );
        assert_eq!(
            selected_id(pool.select("healthy", &accounts, "first")).as_deref(),
            Some("second")
        );
        pool.record_failure(
            "new",
            "second",
            &[1],
            StatusCode::TOO_MANY_REQUESTS,
            None,
            &[],
        );
        assert!(matches!(
            pool.select("later", &accounts, "first"),
            Selection::Cooling(_)
        ));
    }

    #[test]
    fn credential_failure_quarantine_clears_only_after_that_account_changes() {
        let mut accounts = ["first", "second"].map(|id| EligibleAccount {
            account_id: id.to_owned(),
            revision: vec![1],
        });
        let mut pool = Bindings::default();
        assert_eq!(
            selected_id(pool.select("thread", &accounts, "first")).as_deref(),
            Some("first")
        );
        pool.record_failure("thread", "first", &[1], StatusCode::UNAUTHORIZED, None, &[]);
        assert_eq!(
            selected_id(pool.select("thread", &accounts, "first")).as_deref(),
            Some("second")
        );
        accounts[0].revision = vec![2];
        assert_eq!(
            selected_id(pool.select("new", &accounts, "first")).as_deref(),
            Some("first")
        );
        assert_eq!(
            selected_id(pool.select("thread", &accounts, "first")).as_deref(),
            Some("second")
        );
    }

    #[test]
    fn reported_reset_deadline_controls_cooldown_when_retry_after_is_absent() {
        let accounts = [EligibleAccount {
            account_id: "first".to_owned(),
            revision: vec![1],
        }];
        let mut pool = Bindings::default();
        assert_eq!(
            selected_id(pool.select("thread", &accounts, "first")).as_deref(),
            Some("first")
        );
        let deadline = (chrono::Utc::now() + chrono::Duration::minutes(2)).to_rfc3339();
        let reset = deadline.parse().unwrap();
        pool.record_failure(
            "thread",
            "first",
            &[1],
            StatusCode::TOO_MANY_REQUESTS,
            None,
            &[Some(&reset)],
        );
        let Selection::Cooling(wait) = pool.select("thread", &accounts, "first") else {
            panic!("only account remains cooling");
        };
        assert!(wait.as_secs() >= 100);
        assert!(wait.as_secs() <= 120);
    }

    #[test]
    fn token_limit_reset_outlasts_request_reset_without_retry_after() {
        let accounts = [EligibleAccount {
            account_id: "first".to_owned(),
            revision: vec![1],
        }];
        let mut pool = Bindings::default();
        let request_reset = (chrono::Utc::now() + chrono::Duration::seconds(30))
            .to_rfc3339()
            .parse()
            .unwrap();
        let token_reset = (chrono::Utc::now() + chrono::Duration::minutes(3))
            .to_rfc3339()
            .parse()
            .unwrap();
        pool.record_failure(
            "thread",
            "first",
            &[1],
            StatusCode::TOO_MANY_REQUESTS,
            None,
            &[Some(&request_reset), Some(&token_reset)],
        );
        let Selection::Cooling(wait) = pool.select("thread", &accounts, "first") else {
            panic!("only account remains cooling");
        };
        assert!(wait.as_secs() >= 160);
        assert!(wait.as_secs() <= 180);
    }

    #[test]
    fn rejected_request_selects_one_other_sealed_account_in_the_same_call() {
        let vault = crate::pi_config::accounts::AccountVault::in_memory().unwrap();
        let scope = crate::pi_config::accounts::provider_scope(crate::pi_config::CLAUDE_AUTH_KEY);
        for id in ["first", "second"] {
            vault
                .upsert(
                    &scope,
                    id,
                    id,
                    crate::pi_config::accounts::KIND_OAUTH,
                    Some(json!({ "type": "oauth", "access": format!("token-{id}") })),
                )
                .unwrap();
        }
        vault.set_active(&scope, "first").unwrap();
        let state = Mutex::new(Bindings::default());
        let Selection::Account(first, revision) =
            selected_account(&vault, &state, "thread").unwrap()
        else {
            panic!("first account selected");
        };
        let mut rejected = StatusCode::TOO_MANY_REQUESTS.into_response();
        rejected
            .headers_mut()
            .insert("retry-after", "30".parse().unwrap());
        let (second, second_revision) = next_after_response(
            &vault,
            &state,
            "thread",
            &(first, revision),
            &rejected,
            true,
            &crate::server::oauth_pool_policy::Policy::default(),
        )
        .expect("second account is available");
        assert_eq!(second, "second");
        assert!(next_after_response(
            &vault,
            &state,
            "thread",
            &(second, second_revision),
            &rejected,
            false,
            &crate::server::oauth_pool_policy::Policy::default(),
        )
        .is_none());
        assert!(state.lock().unwrap().sessions.is_empty());
    }

    #[test]
    fn rejected_oauth_login_retries_another_account_without_replaying_other_errors() {
        let vault = crate::pi_config::accounts::AccountVault::in_memory().unwrap();
        let scope = crate::pi_config::accounts::provider_scope(crate::pi_config::CLAUDE_AUTH_KEY);
        for id in ["first", "second"] {
            vault
                .upsert(
                    &scope,
                    id,
                    id,
                    crate::pi_config::accounts::KIND_OAUTH,
                    Some(json!({ "type": "oauth", "access": format!("token-{id}") })),
                )
                .unwrap();
        }
        vault.set_active(&scope, "first").unwrap();
        for status in [StatusCode::UNAUTHORIZED, StatusCode::FORBIDDEN] {
            let state = Mutex::new(Bindings::default());
            let Selection::Account(first, revision) =
                selected_account(&vault, &state, "thread").unwrap()
            else {
                panic!("active account selected");
            };
            let rejected = status.into_response();
            let (next, _) = next_after_response(
                &vault,
                &state,
                "thread",
                &(first, revision),
                &rejected,
                true,
                &crate::server::oauth_pool_policy::Policy::default(),
            )
            .expect("a different connected login is available");
            assert_eq!(next, "second");
            assert_eq!(
                state
                    .lock()
                    .unwrap()
                    .sessions
                    .get("thread")
                    .unwrap()
                    .account_id,
                "second"
            );
        }
        let state = Mutex::new(Bindings::default());
        let Selection::Account(first, revision) =
            selected_account(&vault, &state, "thread").unwrap()
        else {
            panic!("active account selected");
        };
        assert!(next_after_response(
            &vault,
            &state,
            "thread",
            &(first, revision),
            &StatusCode::BAD_REQUEST.into_response(),
            true,
            &crate::server::oauth_pool_policy::Policy::default(),
        )
        .is_none());
    }

    #[test]
    fn failed_local_refresh_uses_a_backup_without_sticking_to_the_unusable_login() {
        let vault = crate::pi_config::accounts::AccountVault::in_memory().unwrap();
        let scope = crate::pi_config::accounts::provider_scope(crate::pi_config::CLAUDE_AUTH_KEY);
        for id in ["first", "second"] {
            vault
                .upsert(
                    &scope,
                    id,
                    id,
                    crate::pi_config::accounts::KIND_OAUTH,
                    Some(json!({ "type": "oauth", "access": format!("token-{id}") })),
                )
                .unwrap();
        }
        vault.set_active(&scope, "first").unwrap();
        let state = Mutex::new(Bindings::default());
        let Selection::Account(first, revision) =
            selected_account(&vault, &state, "thread").unwrap()
        else {
            panic!("first account selected");
        };
        let (second, _) = next_after_local_failure(
            &vault,
            &state,
            "thread",
            &(first, revision),
            StatusCode::SERVICE_UNAVAILABLE,
            true,
            &crate::server::oauth_pool_policy::Policy::default(),
        )
        .expect("backup account available");
        assert_eq!(second, "second");
        assert_eq!(
            selected_account(&vault, &state, "another-thread")
                .map(selected_id)
                .unwrap()
                .as_deref(),
            Some("second")
        );
    }

    #[test]
    fn local_refresh_errors_preserve_uncertain_revoked_and_unknown_classification() {
        use crate::pi_config::accounts::RefreshFailure;
        for failure in [RefreshFailure::Uncertain, RefreshFailure::Revoked] {
            assert_eq!(
                super::local_refresh_failure(&failure.into()).0,
                StatusCode::UNAUTHORIZED
            );
        }
        assert_eq!(
            super::local_refresh_failure(&RefreshFailure::Transient.into()).0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            super::local_refresh_failure(&anyhow::anyhow!("unknown fixture error")).0,
            StatusCode::BAD_GATEWAY
        );
    }

    #[test]
    fn proxy_forwards_anthropic_protocol_headers_without_the_placeholder_bearer() {
        let mut headers = HeaderMap::new();
        headers.insert("anthropic-version", "2023-06-01".parse().unwrap());
        headers.insert(
            "anthropic-beta",
            "claude-code-20250219,oauth-2025-04-20".parse().unwrap(),
        );
        headers.insert("user-agent", "claude-cli/2.0".parse().unwrap());
        headers.insert("x-app", "cli".parse().unwrap());
        let request = with_anthropic_headers(
            reqwest::Client::new()
                .post("http://localhost/v1/messages")
                .bearer_auth("real-token"),
            &headers,
        )
        .build()
        .expect("request");
        assert_eq!(request.headers()["authorization"], "Bearer real-token");
        assert_eq!(request.headers()["anthropic-version"], "2023-06-01");
        assert_eq!(
            request.headers()["anthropic-beta"],
            "claude-code-20250219,oauth-2025-04-20"
        );
        assert_eq!(request.headers()["user-agent"], "claude-cli/2.0");
        assert_eq!(request.headers()["x-app"], "cli");
    }

    #[tokio::test]
    async fn native_messages_stream_reaches_a_mock_upstream_with_the_sealed_bearer() {
        let seen = Arc::new(Mutex::new(None));
        let mock_seen = Arc::clone(&seen);
        let router = Router::new().route(
            "/v1/messages",
            post(move |headers: HeaderMap, body: Bytes| {
                let seen = Arc::clone(&mock_seen);
                async move {
                    *seen.lock().expect("seen request") = Some((headers, body));
                    (
                        StatusCode::OK,
                        [("content-type", "text/event-stream")],
                        "event: message_stop\ndata: {}\n\n",
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.expect("mock server");
        });

        let mut headers = HeaderMap::new();
        headers.insert("anthropic-version", "2023-06-01".parse().unwrap());
        headers.insert(
            "anthropic-beta",
            "claude-code-20250219,oauth-2025-04-20".parse().unwrap(),
        );
        headers.insert("user-agent", "claude-cli/2.0".parse().unwrap());
        headers.insert("x-app", "cli".parse().unwrap());
        headers.insert(
            "authorization",
            "Bearer sk-ant-oat-ryu-local-proxy".parse().unwrap(),
        );
        let response = forward_messages(
            &headers,
            Bytes::from_static(br#"{"model":"claude-fable-5","messages":[]}"#),
            "sealed-account-access",
            &format!("http://{address}/v1/messages"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        assert_eq!(
            to_bytes(response.into_body(), 1024).await.unwrap(),
            "event: message_stop\ndata: {}\n\n"
        );
        let (sent_headers, sent_body) = seen.lock().unwrap().take().expect("upstream request");
        assert_eq!(
            sent_headers["authorization"],
            "Bearer sealed-account-access"
        );
        assert_eq!(sent_headers["anthropic-version"], "2023-06-01");
        assert_eq!(
            sent_headers["anthropic-beta"],
            "claude-code-20250219,oauth-2025-04-20"
        );
        assert_eq!(sent_headers["user-agent"], "claude-cli/2.0");
        assert_eq!(sent_headers["x-app"], "cli");
        assert_eq!(
            sent_body,
            Bytes::from_static(br#"{"model":"claude-fable-5","messages":[]}"#)
        );
        server.abort();
    }
}
