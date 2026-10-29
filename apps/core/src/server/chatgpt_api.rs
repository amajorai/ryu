//! Native ChatGPT-account provider transport for the managed Pi.
//!
//! This is the server-side half of the first-class ChatGPT provider. Pi sends
//! the native Codex/Responses wire format to this loopback route; Core resolves
//! the selected ChatGPT session from its sealed provider vault, refreshes the
//! private copy when necessary, and forwards the request to ChatGPT's account
//! backed Responses service. Raw credentials never cross the desktop API.

use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const DEFAULT_UPSTREAM: &str = "https://chatgpt.com/backend-api/codex";
const DEFAULT_CLIENT_VERSION: &str = "0.144.1";
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_SESSION_BINDINGS: usize = 10_000;
const SESSION_IDLE_TTL: Duration = Duration::from_secs(60 * 60);
const DEFAULT_COOLDOWN: Duration = Duration::from_secs(60);
const MAX_COOLDOWN: Duration = Duration::from_secs(32 * 24 * 60 * 60);
const MAX_POOL_ATTEMPTS: usize = 4;

struct SessionBinding {
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
    Account(String),
    NotConnected,
    Disabled,
    Cooling(Duration),
    NeedsReauth,
}

#[derive(Default)]
struct SessionBindings {
    by_session: HashMap<String, SessionBinding>,
    health: HashMap<String, AccountHealth>,
    pool_cursor: super::oauth_pool_usage::PoolCursor,
}

impl SessionBindings {
    #[cfg(test)]
    fn selected_account(
        &mut self,
        session: &str,
        eligible: &[EligibleAccount],
        active: &str,
    ) -> Selection {
        self.selected_account_with_policy(
            session,
            eligible,
            active,
            &super::oauth_pool_policy::Policy::default(),
        )
    }

    fn selected_account_with_policy(
        &mut self,
        session: &str,
        eligible: &[EligibleAccount],
        active: &str,
        policy: &super::oauth_pool_policy::Policy,
    ) -> Selection {
        let now = Instant::now();
        self.by_session
            .retain(|_, binding| now.duration_since(binding.last_used) < SESSION_IDLE_TTL);
        self.health.retain(|id, health| {
            let Some(account) = eligible.iter().find(|account| &account.account_id == id) else {
                return false;
            };
            match health {
                AccountHealth::Cooling(until) => *until > now,
                AccountHealth::NeedsReauth { revision } => account.revision == *revision,
            }
        });
        if let Some(binding) = self.by_session.get_mut(session) {
            if eligible
                .iter()
                .any(|account| account.account_id == binding.account_id)
                && policy.allowed(&binding.account_id)
                && !self.health.contains_key(&binding.account_id)
            {
                binding.last_used = now;
                return Selection::Account(binding.account_id.clone());
            }
        }
        self.by_session.remove(session);
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
            .select("chatgpt", &ready, active, policy)
            .map(|index| ready[index].account_id);
        let Some(selected) = selected else {
            if eligible.is_empty() {
                return Selection::NotConnected;
            }
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
        if self.by_session.len() >= MAX_SESSION_BINDINGS {
            if let Some(oldest) = self
                .by_session
                .iter()
                .min_by_key(|(_, binding)| binding.last_used)
                .map(|(id, _)| id.clone())
            {
                self.by_session.remove(&oldest);
            }
        }
        self.by_session.insert(
            session.to_owned(),
            SessionBinding {
                account_id: selected.to_owned(),
                last_used: now,
            },
        );
        Selection::Account(selected.to_owned())
    }

    fn release_if_matches(&mut self, session: &str, account_id: &str) {
        if self
            .by_session
            .get(session)
            .is_some_and(|binding| binding.account_id == account_id)
        {
            self.by_session.remove(session);
        }
    }

    fn record_rejection(
        &mut self,
        session: &str,
        account_id: &str,
        revision: &[u8],
        status: StatusCode,
        retry_after: Option<&HeaderValue>,
    ) {
        let health = match status {
            StatusCode::TOO_MANY_REQUESTS => {
                let wait = retry_after
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok())
                    .map(Duration::from_secs)
                    .unwrap_or(DEFAULT_COOLDOWN)
                    .min(MAX_COOLDOWN);
                AccountHealth::Cooling(Instant::now() + wait)
            }
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => AccountHealth::NeedsReauth {
                revision: revision.to_vec(),
            },
            _ => return,
        };
        self.release_if_matches(session, account_id);
        self.health.insert(account_id.to_owned(), health);
    }

    fn record_local_failure(&mut self, session: &str, account_id: &str) {
        // No upstream request was sent. Decrypt and refresh failures can be
        // transient, so retry another login without requiring a new login here.
        self.record_rejection(
            session,
            account_id,
            &[],
            StatusCode::TOO_MANY_REQUESTS,
            None,
        );
    }
}

fn session_bindings() -> &'static Mutex<SessionBindings> {
    static BINDINGS: OnceLock<Mutex<SessionBindings>> = OnceLock::new();
    BINDINGS.get_or_init(|| Mutex::new(SessionBindings::default()))
}

fn session_id(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("session-id")
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .and_then(|value| value.to_str().ok())
}

fn selected_vault_account(
    vault: &crate::pi_config::accounts::AccountVault,
    bindings: &Mutex<SessionBindings>,
    session: &str,
) -> anyhow::Result<Selection> {
    selected_vault_account_with_policy(
        vault,
        bindings,
        session,
        &super::oauth_pool_policy::Policy::default(),
    )
}

fn selected_vault_account_with_policy(
    vault: &crate::pi_config::accounts::AccountVault,
    bindings: &Mutex<SessionBindings>,
    session: &str,
    policy: &super::oauth_pool_policy::Policy,
) -> anyhow::Result<Selection> {
    let scope = crate::pi_config::accounts::provider_scope(crate::pi_config::CHATGPT_AUTH_KEY);
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
        .expect("ChatGPT session binding mutex")
        .selected_account_with_policy(session, &eligible, &active.account_id, policy))
}

fn selected_vault_account_for_request(
    vault: &crate::pi_config::accounts::AccountVault,
    bindings: &Mutex<SessionBindings>,
    session: Option<&str>,
    policy: &super::oauth_pool_policy::Policy,
) -> anyhow::Result<Selection> {
    let transient = uuid::Uuid::new_v4().to_string();
    let key = session.unwrap_or(&transient);
    let selection = selected_vault_account_with_policy(vault, bindings, key, policy)?;
    if session.is_none() {
        bindings
            .lock()
            .expect("ChatGPT session binding mutex")
            .by_session
            .remove(key);
    }
    Ok(selection)
}

fn upstream() -> String {
    std::env::var("RYU_CHATGPT_UPSTREAM")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_UPSTREAM.to_owned())
}

fn client_version() -> String {
    std::env::var("RYU_CHATGPT_CLIENT_VERSION")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_CLIENT_VERSION.to_owned())
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default()
    })
}

async fn auth_headers(
    headers: &HeaderMap,
    attempts_remaining: &mut usize,
    policy: &super::oauth_pool_policy::Policy,
) -> Result<(String, String, Option<(String, Vec<u8>)>), Response> {
    let session = session_id(headers);
    while *attempts_remaining > 0 {
        // Capture one sealed login before refresh. A concurrent active-account
        // switch must not put another login's bearer on this request.
        let selected_account = if let Some(vault) = crate::pi_config::accounts::global() {
            let selection =
                selected_vault_account_for_request(vault, session_bindings(), session, policy)
                    .map_err(internal_error)?;
            match selection {
                Selection::Account(account_id) => Some(account_id),
                Selection::NotConnected => return Err(auth_error("ChatGPT is not connected")),
                Selection::Disabled => {
                    return Err((
                        StatusCode::CONFLICT,
                        Json(json!({ "error": { "code": "chatgpt_accounts_disabled", "message": "All connected ChatGPT accounts are disabled in account routing" } })),
                    ).into_response())
                }
                Selection::NeedsReauth => {
                    return Err(auth_error("Connected ChatGPT accounts need a new login"))
                }
                Selection::Cooling(wait) => {
                    let mut response = (
                        StatusCode::TOO_MANY_REQUESTS,
                        Json(json!({ "error": { "code": "chatgpt_accounts_cooling", "message": "All connected ChatGPT accounts are cooling down" } })),
                    )
                        .into_response();
                    if let Ok(value) = HeaderValue::from_str(&wait.as_secs().max(1).to_string()) {
                        response.headers_mut().insert("retry-after", value);
                    }
                    return Err(response);
                }
            }
        } else {
            None
        };
        if selected_account.is_some() {
            *attempts_remaining -= 1;
        }
        let (access, account_id) = match prepare_headers(selected_account.as_deref()).await {
            Ok(prepared) => prepared,
            Err(response) => {
                if let (Some(session), Some(account_id)) = (session, selected_account.as_deref()) {
                    session_bindings()
                        .lock()
                        .expect("ChatGPT session binding mutex")
                        .record_local_failure(session, account_id);
                    if *attempts_remaining > 0 {
                        continue;
                    }
                }
                return Err(response);
            }
        };
        let selected_account = if let (Some(selected_id), Some(vault)) =
            (selected_account, crate::pi_config::accounts::global())
        {
            let scope =
                crate::pi_config::accounts::provider_scope(crate::pi_config::CHATGPT_AUTH_KEY);
            match vault.credential_revision(&scope, &selected_id) {
                Ok(Some(revision)) => Some((selected_id, revision)),
                Ok(None) => {
                    if let Some(session) = session {
                        session_bindings()
                            .lock()
                            .expect("ChatGPT session binding mutex")
                            .release_if_matches(session, &selected_id);
                    }
                    if *attempts_remaining > 0 {
                        continue;
                    }
                    return Err(auth_error(
                        "ChatGPT account was removed before this request",
                    ));
                }
                Err(error) => return Err(internal_error(error)),
            }
        } else {
            None
        };
        return Ok((access, account_id, selected_account));
    }
    Err(StatusCode::BAD_GATEWAY.into_response())
}

async fn prepare_headers(selected_account: Option<&str>) -> Result<(String, String), Response> {
    let credential = if let Some(account_id) = selected_account {
        crate::pi_config::subscription_request_credential_for_account(
            crate::pi_config::CHATGPT_PROVIDER_ID,
            account_id,
        )
        .await
        .map(Some)
    } else {
        crate::pi_config::subscription_request_credential(crate::pi_config::CHATGPT_PROVIDER_ID)
            .await
    }
    .map_err(internal_error)?
    .ok_or_else(|| auth_error("ChatGPT is not connected"))?;
    let access = credential
        .get("access")
        .or_else(|| credential.get("access_token"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| auth_error("ChatGPT session has no access token"))?;
    let account_id = credential
        .get("accountId")
        .or_else(|| credential.get("account_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| auth_error("ChatGPT session has no account id"))?;
    Ok((access.to_owned(), account_id.to_owned()))
}

fn auth_error(message: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": { "code": "chatgpt_not_connected", "message": message } })),
    )
        .into_response()
}

fn internal_error(error: anyhow::Error) -> Response {
    tracing::warn!(error = %error, "native ChatGPT provider credential lookup failed");
    (
        StatusCode::BAD_GATEWAY,
        Json(json!({
            "error": {
                "code": "chatgpt_credential_error",
                "message": "ChatGPT provider credentials could not be resolved"
            }
        })),
    )
        .into_response()
}

fn upstream_error(status: reqwest::StatusCode, _body: String) -> Response {
    let message = format!("ChatGPT upstream returned {status}");
    (
        StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
        Json(json!({ "error": { "code": "chatgpt_upstream_error", "message": message } })),
    )
        .into_response()
}

fn request_builder(
    method: reqwest::Method,
    url: &str,
    access: &str,
    account_id: &str,
) -> reqwest::RequestBuilder {
    client()
        .request(method, url)
        .header("Authorization", format!("Bearer {access}"))
        .header("ChatGPT-Account-ID", account_id)
        .header("originator", "codex_cli_rs")
        .header("User-Agent", "Ryu")
}

fn with_session_headers(
    mut request: reqwest::RequestBuilder,
    incoming: &HeaderMap,
) -> reqwest::RequestBuilder {
    // Pi sends its stable conversation key on both headers. Forward it intact
    // so ChatGPT can associate subsequent turns with the same client session.
    for name in ["session-id", "x-client-request-id"] {
        if let Some(value) = incoming
            .get(name)
            .filter(|value| !value.is_empty() && value.len() <= 128)
        {
            request = request.header(name, value.clone());
        }
    }
    request
}

/// Forward a native Responses request while keeping ChatGPT auth inside Core.
pub async fn responses(
    State(state): State<super::ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if body.len() > MAX_REQUEST_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({ "error": { "code": "request_too_large", "message": "request body is too large" } })),
        )
            .into_response();
    }
    let mut attempts_remaining = MAX_POOL_ATTEMPTS;
    let policy = super::oauth_pool_policy::load(&state.preferences, "chatgpt").await;
    super::oauth_pool_usage::warm_in_background("chatgpt", &policy);
    let mut selected = match auth_headers(&headers, &mut attempts_remaining, &policy).await {
        Ok(headers) => headers,
        Err(response) => return response,
    };
    let url = format!("{}/responses", upstream());
    for _attempt in 0..MAX_POOL_ATTEMPTS {
        let (access, account_id, selected_account) = &selected;
        let response = match with_session_headers(
            request_builder(reqwest::Method::POST, &url, access, account_id),
            &headers,
        )
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream")
        .body(body.clone())
        .send()
        .await
        {
            Ok(response) => response,
            Err(error) => {
                tracing::warn!(error = %error, "native ChatGPT provider upstream request failed");
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "error": { "code": "chatgpt_upstream_unreachable", "message": "ChatGPT upstream could not be reached" } })),
                )
                    .into_response();
            }
        };
        let status = response.status();
        if !status.is_success() {
            let retry_after = response.headers().get("retry-after").cloned();
            let retryable = matches!(status.as_u16(), 401 | 403 | 429);
            if retryable {
                if let (Some(session), Some((account_id, revision))) =
                    (session_id(&headers), selected_account.as_ref())
                {
                    session_bindings()
                        .lock()
                        .expect("ChatGPT session binding mutex")
                        .record_rejection(
                            session,
                            account_id,
                            revision,
                            status,
                            retry_after.as_ref(),
                        );
                }
            }
            let error_body = response.text().await.unwrap_or_default();
            if retryable && attempts_remaining > 0 && selected_account.is_some() {
                if let Ok(next) = auth_headers(&headers, &mut attempts_remaining, &policy).await {
                    if next.2.as_ref().map(|(id, _)| id)
                        != selected_account.as_ref().map(|(id, _)| id)
                    {
                        selected = next;
                        continue;
                    }
                }
            }
            let mut error = upstream_error(status, error_body);
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                if let Some(delay) = retry_after {
                    error.headers_mut().insert("retry-after", delay);
                }
            }
            return error;
        }

        let content_type = response
            .headers()
            .get("content-type")
            .cloned()
            .unwrap_or_else(|| HeaderValue::from_static("text/event-stream"));
        let stream = response.bytes_stream().map(|chunk| {
            chunk.map_err(|error| std::io::Error::other(format!("ChatGPT stream: {error}")))
        });
        return Response::builder()
            .status(status)
            .header("content-type", content_type)
            .body(Body::from_stream(stream))
            .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response());
    }
    StatusCode::BAD_GATEWAY.into_response()
}

/// The smallest Responses request ChatGPT's Codex backend accepts: it requires
/// streaming, unstored turns and an `instructions` field.
fn ping_body(model: &str, prompt: &str) -> Value {
    json!({
        "model": model,
        "instructions": "Reply with one word.",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{ "type": "input_text", "text": prompt }],
        }],
        "store": false,
        "stream": true,
    })
}

/// Send one minimal turn on exactly `account_id`, bypassing pool selection.
///
/// Scheduled warmups use this to open a specific account's rolling usage
/// window; [`responses`] would let the pool policy choose another login.
pub async fn ping_account(account_id: &str, model: &str, prompt: &str) -> anyhow::Result<()> {
    let (access, chatgpt_account) =
        prepare_headers(Some(account_id))
            .await
            .map_err(|response| {
                anyhow::anyhow!("ChatGPT account unavailable ({})", response.status())
            })?;
    let url = format!("{}/responses", upstream());
    let response = request_builder(reqwest::Method::POST, &url, &access, &chatgpt_account)
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream")
        .json(&ping_body(model, prompt))
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("ChatGPT upstream could not be reached"))?;
    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("ChatGPT returned {status} for this account");
    }
    // Drain the stream so the turn completes rather than being cancelled
    // mid-flight; the reply itself is irrelevant.
    let _ = response.bytes().await;
    Ok(())
}

fn model_items(value: &Value) -> Vec<Value> {
    let mut items = value
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| value.get("models").and_then(Value::as_array))
        .or_else(|| value.get("items").and_then(Value::as_array))
        .cloned()
        .unwrap_or_default();
    if let Some(models) = value.get("models").and_then(Value::as_object) {
        items.extend(
            models
                .iter()
                .map(|(id, entry)| json!({ "id": id, "name": entry.get("name") })),
        );
    }
    let mut seen = std::collections::HashSet::new();
    items
        .into_iter()
        .filter_map(|entry| {
            let id = entry.as_str().map(str::to_owned).or_else(|| {
                entry
                    .get("slug")
                    .or_else(|| entry.get("id"))
                    .or_else(|| entry.get("model"))
                    .or_else(|| entry.get("name"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })?;
            if !seen.insert(id.clone()) {
                return None;
            }
            let mut item = Map::new();
            item.insert("id".to_owned(), Value::String(id));
            item.insert("object".to_owned(), Value::String("model".to_owned()));
            item.insert(
                "created".to_owned(),
                Value::Number(serde_json::Number::from(0)),
            );
            item.insert("owned_by".to_owned(), Value::String("chatgpt".to_owned()));
            Some(Value::Object(item))
        })
        .collect()
}

/// Account-aware ChatGPT model discovery. The upstream list is normalized to
/// OpenAI's {object:"list",data:[...]} shape for Pi's picker.
pub async fn models() -> Response {
    let mut attempts_remaining = MAX_POOL_ATTEMPTS;
    let (access, account_id, _) = match auth_headers(
        &HeaderMap::new(),
        &mut attempts_remaining,
        &super::oauth_pool_policy::Policy::default(),
    )
    .await
    {
        Ok(headers) => headers,
        Err(response) => return response,
    };
    let response = match request_builder(
        reqwest::Method::GET,
        &format!("{}/models", upstream()),
        &access,
        &account_id,
    )
    .query(&[("client_version", client_version())])
    .header("Accept", "application/json")
    .send()
    .await
    {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(error = %error, "native ChatGPT model discovery failed");
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": { "code": "chatgpt_models_unreachable", "message": "ChatGPT models could not be loaded" } })),
            )
                .into_response();
        }
    };
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return upstream_error(status, body);
    }
    let body = match response.json::<Value>().await {
        Ok(body) => body,
        Err(error) => {
            tracing::warn!(error = %error, "native ChatGPT model discovery returned invalid JSON");
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": { "code": "chatgpt_models_invalid", "message": "ChatGPT models response was invalid" } })),
            )
                .into_response();
        }
    };
    Json(json!({ "object": "list", "data": model_items(&body) })).into_response()
}

#[cfg(test)]
mod tests {
    use super::{
        model_items, request_builder, selected_vault_account, selected_vault_account_for_request,
        with_session_headers, EligibleAccount, Selection, SessionBindings,
    };
    use axum::http::{HeaderMap, HeaderValue, StatusCode};
    use reqwest::Method;
    use serde_json::{json, Value};
    use std::sync::Mutex;

    fn selected_id(selection: Selection) -> Option<String> {
        match selection {
            Selection::Account(id) => Some(id),
            _ => None,
        }
    }

    fn eligible(ids: &[&str]) -> Vec<EligibleAccount> {
        ids.iter()
            .map(|id| EligibleAccount {
                account_id: (*id).to_owned(),
                revision: vec![1],
            })
            .collect()
    }

    #[test]
    fn sessionless_requests_obey_account_disable_without_allocating_affinity() {
        let vault = crate::pi_config::accounts::AccountVault::in_memory().unwrap();
        let scope = crate::pi_config::accounts::provider_scope(crate::pi_config::CHATGPT_AUTH_KEY);
        vault
            .upsert(
                &scope,
                "first",
                "first",
                crate::pi_config::accounts::KIND_OAUTH,
                Some(json!({"type":"oauth","access":"fixture"})),
            )
            .unwrap();
        vault.set_active(&scope, "first").unwrap();
        let bindings = Mutex::new(SessionBindings::default());
        let mut policy = super::super::oauth_pool_policy::Policy::default();
        assert_eq!(
            selected_id(
                selected_vault_account_for_request(&vault, &bindings, None, &policy).unwrap()
            ),
            Some("first".into())
        );
        assert!(bindings.lock().unwrap().by_session.is_empty());
        policy.accounts.insert(
            "first".into(),
            super::super::oauth_pool_policy::AccountRule {
                enabled: false,
                priority: 0,
                drain_threshold_percent: None,
            },
        );
        assert!(matches!(
            selected_vault_account_for_request(&vault, &bindings, None, &policy).unwrap(),
            Selection::Disabled
        ));
        assert!(bindings.lock().unwrap().by_session.is_empty());
    }

    #[test]
    fn account_selection_reads_the_bound_sealed_login_after_the_active_account_changes() {
        let vault = crate::pi_config::accounts::AccountVault::in_memory().expect("vault");
        let scope = crate::pi_config::accounts::provider_scope(crate::pi_config::CHATGPT_AUTH_KEY);
        for (id, token) in [("first", "token-one"), ("second", "token-two")] {
            vault
                .upsert(
                    &scope,
                    id,
                    id,
                    crate::pi_config::accounts::KIND_OAUTH,
                    Some(json!({"type":"oauth","access":token})),
                )
                .expect("saved login");
        }
        vault.set_active(&scope, "first").expect("first active");
        let bindings = Mutex::new(SessionBindings::default());
        let first = selected_id(
            selected_vault_account(&vault, &bindings, "conversation").expect("selection"),
        )
        .expect("login");
        assert_eq!(
            vault.credential(&scope, &first).unwrap().unwrap()["access"],
            "token-one"
        );

        vault.set_active(&scope, "second").expect("second active");
        let existing = selected_id(
            selected_vault_account(&vault, &bindings, "conversation").expect("existing selection"),
        )
        .expect("login");
        let new = selected_id(
            selected_vault_account(&vault, &bindings, "another-conversation")
                .expect("new selection"),
        )
        .expect("login");
        assert_eq!(
            vault.credential(&scope, &existing).unwrap().unwrap()["access"],
            "token-one"
        );
        assert_eq!(
            vault.credential(&scope, &new).unwrap().unwrap()["access"],
            "token-two"
        );

        vault.remove(&scope, "first").expect("remove first login");
        assert_eq!(
            selected_id(
                selected_vault_account(&vault, &bindings, "conversation")
                    .expect("replacement selection")
            ),
            Some("second".to_owned())
        );
    }

    #[test]
    fn a_chatgpt_session_keeps_its_oauth_account_until_that_login_is_removed() {
        let mut bindings = SessionBindings::default();
        let both = eligible(&["first", "second"]);
        assert_eq!(
            selected_id(bindings.selected_account("existing", &both, "first")),
            Some("first".to_owned())
        );
        assert_eq!(
            selected_id(bindings.selected_account("existing", &both, "second")),
            Some("first".to_owned())
        );
        assert_eq!(
            selected_id(bindings.selected_account("new", &both, "second")),
            Some("second".to_owned())
        );

        bindings.release_if_matches("existing", "second");
        assert_eq!(
            selected_id(bindings.selected_account("existing", &both, "second")),
            Some("first".to_owned())
        );
        bindings.release_if_matches("existing", "first");
        assert_eq!(
            selected_id(bindings.selected_account("existing", &both, "second")),
            Some("second".to_owned())
        );

        assert_eq!(
            selected_id(bindings.selected_account("new", &eligible(&["first"]), "first")),
            Some("first".to_owned())
        );
    }

    #[test]
    fn round_robin_changes_new_sessions_without_moving_a_healthy_chatgpt_session() {
        let mut bindings = SessionBindings::default();
        let accounts = eligible(&["first", "second"]);
        let mut policy = crate::server::oauth_pool_policy::Policy {
            strategy: crate::server::oauth_pool_policy::Strategy::RoundRobin,
            ..Default::default()
        };
        assert_eq!(
            selected_id(bindings.selected_account_with_policy("warm", &accounts, "first", &policy)),
            Some("first".to_owned())
        );
        assert_eq!(
            selected_id(bindings.selected_account_with_policy("new", &accounts, "first", &policy)),
            Some("second".to_owned())
        );
        assert_eq!(
            selected_id(
                bindings.selected_account_with_policy("warm", &accounts, "second", &policy)
            ),
            Some("first".to_owned())
        );
        policy.accounts.insert(
            "first".to_owned(),
            crate::server::oauth_pool_policy::AccountRule {
                drain_threshold_percent: None,
                enabled: false,
                priority: 0,
            },
        );
        assert_eq!(
            selected_id(
                bindings.selected_account_with_policy("warm", &accounts, "second", &policy)
            ),
            Some("second".to_owned())
        );
    }

    #[test]
    fn rejected_login_fails_over_without_moving_other_healthy_sessions() {
        for status in [StatusCode::UNAUTHORIZED, StatusCode::FORBIDDEN] {
            let mut bindings = SessionBindings::default();
            let mut accounts = eligible(&["first", "second"]);
            assert_eq!(
                selected_id(bindings.selected_account("rejected", &accounts, "first")),
                Some("first".to_owned())
            );
            assert_eq!(
                selected_id(bindings.selected_account("healthy", &accounts, "second")),
                Some("second".to_owned())
            );
            bindings.record_rejection("rejected", "first", &[1], status, None);
            assert_eq!(
                selected_id(bindings.selected_account("rejected", &accounts, "first")),
                Some("second".to_owned())
            );
            assert_eq!(
                selected_id(bindings.selected_account("new", &accounts, "first")),
                Some("second".to_owned())
            );
            assert_eq!(
                selected_id(bindings.selected_account("healthy", &accounts, "first")),
                Some("second".to_owned())
            );
            accounts[0].revision = vec![2];
            assert_eq!(
                selected_id(bindings.selected_account("later", &accounts, "first")),
                Some("first".to_owned())
            );
            assert_eq!(
                selected_id(bindings.selected_account("rejected", &accounts, "first")),
                Some("second".to_owned())
            );
        }
    }

    #[test]
    fn local_credential_failure_tries_another_login_and_temporarily_cools_the_bad_one() {
        let accounts = eligible(&["first", "second"]);
        let mut bindings = SessionBindings::default();
        assert_eq!(
            selected_id(bindings.selected_account("conversation", &accounts, "first")),
            Some("first".to_owned())
        );
        bindings.record_local_failure("conversation", "first");
        assert_eq!(
            selected_id(bindings.selected_account("conversation", &accounts, "first")),
            Some("second".to_owned())
        );
        assert_eq!(
            selected_id(bindings.selected_account("new", &accounts, "first")),
            Some("second".to_owned())
        );
        bindings.record_local_failure("conversation", "second");
        assert!(matches!(
            bindings.selected_account("later", &accounts, "first"),
            Selection::Cooling(_)
        ));
    }

    #[test]
    fn rate_limited_accounts_cool_and_report_wait_without_replaying_bad_requests() {
        let accounts = eligible(&["first", "second"]);
        let mut bindings = SessionBindings::default();
        assert_eq!(
            selected_id(bindings.selected_account("one", &accounts, "first")),
            Some("first".to_owned())
        );
        bindings.record_rejection(
            "one",
            "first",
            &[1],
            StatusCode::TOO_MANY_REQUESTS,
            Some(&HeaderValue::from_static("30")),
        );
        assert_eq!(
            selected_id(bindings.selected_account("one", &accounts, "first")),
            Some("second".to_owned())
        );
        bindings.record_rejection("one", "second", &[1], StatusCode::TOO_MANY_REQUESTS, None);
        let Selection::Cooling(wait) = bindings.selected_account("later", &accounts, "first")
        else {
            panic!("both accounts should be cooling");
        };
        assert!(wait.as_secs() >= 20);
        assert!(wait.as_secs() <= 30);

        let mut bindings = SessionBindings::default();
        assert_eq!(
            selected_id(bindings.selected_account("stable", &accounts, "first")),
            Some("first".to_owned())
        );
        bindings.record_rejection("stable", "first", &[1], StatusCode::BAD_REQUEST, None);
        assert_eq!(
            selected_id(bindings.selected_account("stable", &accounts, "second")),
            Some("first".to_owned())
        );
    }

    #[test]
    fn normalizes_account_model_shapes_and_deduplicates() {
        let items = model_items(&json!({
            "models": [
                { "slug": "gpt-5.5" },
                { "id": "gpt-5.5" },
                "gpt-5.4"
            ]
        }));
        assert_eq!(
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            vec!["gpt-5.5", "gpt-5.4"]
        );
    }

    #[test]
    fn upstream_requests_carry_account_headers_without_persisting_the_bearer() {
        let request = request_builder(
            Method::GET,
            "https://chatgpt.example/codex/models",
            "access-token",
            "account-id",
        )
        .build()
        .expect("build request");

        assert_eq!(request.headers()["Authorization"], "Bearer access-token");
        assert_eq!(request.headers()["ChatGPT-Account-ID"], "account-id");
        assert_eq!(request.headers()["originator"], "codex_cli_rs");
        assert_eq!(request.headers()["User-Agent"], "Ryu");
    }

    #[test]
    fn forwards_bounded_pi_session_identity_to_responses_upstream() {
        let mut incoming = HeaderMap::new();
        incoming.insert("session-id", HeaderValue::from_static("conversation-one"));
        incoming.insert(
            "x-client-request-id",
            HeaderValue::from_static("conversation-one"),
        );
        let request = with_session_headers(
            request_builder(
                Method::POST,
                "https://chatgpt.example/codex/responses",
                "access-token",
                "account-id",
            ),
            &incoming,
        )
        .build()
        .expect("build request");
        assert_eq!(request.headers()["session-id"], "conversation-one");
        assert_eq!(request.headers()["x-client-request-id"], "conversation-one");

        incoming.insert(
            "session-id",
            HeaderValue::from_str(&"x".repeat(129)).expect("long header"),
        );
        let oversized = with_session_headers(
            request_builder(
                Method::POST,
                "https://chatgpt.example/codex/responses",
                "access-token",
                "account-id",
            ),
            &incoming,
        )
        .build()
        .expect("build request");
        assert!(oversized.headers().get("session-id").is_none());
    }
}
