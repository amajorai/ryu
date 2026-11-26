//! A provider request of an agent on Auto or with a custom pool, run account
//! by account.
//!
//! The native Claude and ChatGPT proxies choose one account per attempt and
//! give up after four. For an agent on Auto or with a pool, this runs the
//! unchanged proxy once per account instead, with the provider policy
//! narrowed to that one account ([`super::scope::as_account`]). So Core knows
//! which account gave which answer:
//!
//! - a limit (429) skips the account for that model until its reset;
//! - "no access to this model" skips it for that model for a while, without
//!   counting it as out of usage;
//! - when no account can serve the model, the agent's backup models on the
//!   same provider are tried in order, with the model in the body replaced;
//! - when every account is at its limit, the agent gets one clear 429 with
//!   Retry-After at the first reset, without another call to the vendor.
//!
//! Backups on another provider speak another wire format; they are stored
//! and shown, but a proxy request cannot switch to them.

pub(crate) mod answer;
pub(crate) mod memory;

#[cfg(test)]
mod answer_tests;
#[cfg(test)]
mod memory_tests;
#[cfg(test)]
mod tests;

use std::future::Future;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::{
    body::{Body, Bytes},
    http::{header, Method, Request},
    middleware::Next,
    response::Response,
};
use serde_json::Value;

use self::answer::{Answer, Vendor};
use self::memory::{Candidate, Memory};
use super::modes::{Backup, Mode};
use crate::server::oauth_pool_policy::{Policy, Strategy};

/// The proxies' own request limit.
const MAX_BODY: usize = 8 * 1024 * 1024;
/// Error answers are short; a longer one is passed back as it is.
const MAX_ERROR_BODY: usize = 256 * 1024;
/// Upper bound of vendor calls for one request, over all accounts and models.
pub(crate) const MAX_TRIES: usize = 12;
/// How long a limit answer that names no reset keeps an account aside, as
/// the proxies' own cooldown.
pub(crate) const DEFAULT_WAIT: Duration = Duration::from_secs(60);
/// A limit answer that names no reset, or one this close, may still be a
/// five hour or weekly limit; the account's usage is read again to learn.
pub(crate) const SHORT_WAIT: Duration = Duration::from_secs(5 * 60);

/// What one request will try.
#[derive(Clone)]
pub(crate) struct Plan {
    pub vendor: Vendor,
    pub provider_id: String,
    pub session: Option<String>,
    pub accounts: Vec<Candidate>,
    pub manual: bool,
    /// The requested model first, then the backups on the same provider.
    pub models: Vec<String>,
}

/// The native proxy routes Auto runs on, with their provider.
pub(crate) fn route(method: &Method, path: &str) -> Option<(&'static str, Vendor)> {
    if method != Method::POST {
        return None;
    }
    match path {
        "/api/pi-config/claude/v1/messages" => Some(("claude-pro-max", Vendor::Anthropic)),
        "/api/pi-config/chatgpt/codex/responses" => {
            Some((crate::pi_config::CHATGPT_PROVIDER_ID, Vendor::OpenAi))
        }
        _ => None,
    }
}

/// The requested model, then each backup whose provider reads the same
/// account list, in order and once each.
pub(crate) fn models_to_try(requested: &str, backups: &[Backup], provider_id: &str) -> Vec<String> {
    let mut models = vec![requested.to_owned()];
    for backup in backups {
        if super::scope::same_account_list(&backup.provider_id, provider_id)
            && !models.contains(&backup.model)
        {
            models.push(backup.model.clone());
        }
    }
    models
}

fn requested_model(body: &[u8]) -> Option<String> {
    let body: Value = serde_json::from_slice(body).ok()?;
    let model = body.get("model")?.as_str()?.trim();
    (!model.is_empty()).then(|| model.to_owned())
}

/// The same body with another model.
pub(crate) fn with_model(body: &Bytes, model: &str) -> Bytes {
    let Ok(mut value) = serde_json::from_slice::<Value>(body) else {
        return body.clone();
    };
    if let Some(object) = value.as_object_mut() {
        object.insert("model".to_owned(), Value::String(model.to_owned()));
    }
    serde_json::to_vec(&value).map_or_else(|_| body.clone(), Bytes::from)
}

/// The agent's usable accounts for the provider: saved OAuth logins that the
/// policy (with the agent's pool, when it has one) allows. `None` when the
/// vault cannot be read.
fn candidates(provider_id: &str, policy: &Policy) -> Option<Vec<Candidate>> {
    let scope = crate::pi_config::provider_account_scope(provider_id)?;
    let accounts = crate::pi_config::accounts::global()?.list(&scope).ok()?;
    Some(
        accounts
            .into_iter()
            .filter(|account| {
                account.kind == crate::pi_config::accounts::KIND_OAUTH
                    && !account.needs_reauth
                    && policy.allowed(&account.account_id)
            })
            .map(|account| Candidate {
                priority: policy.priority(&account.account_id),
                active: account.active,
                id: account.account_id,
            })
            .collect(),
    )
}

/// The reset of a usage window the account has used up, from the usage Core
/// already reads for the account pools.
fn observed_reset(provider_id: &str, account_id: &str) -> Option<Duration> {
    let scope = crate::pi_config::provider_account_scope(provider_id)?;
    let vault = crate::pi_config::accounts::global()?;
    let revision = vault.credential_revision(&scope, account_id).ok()??;
    let observation = crate::server::oauth_pool_usage::get(provider_id, account_id, &revision)?;
    let now = chrono::Utc::now();
    observation
        .windows
        .iter()
        .filter(|window| window.used_percent >= 100.0)
        .filter_map(|window| (window.reset_at? - now).to_std().ok())
        .max()
}

/// Read an error answer so it can be judged, and give it back unchanged.
async fn judged(response: Response, model: &str) -> (Response, Answer) {
    if response.status().is_success() {
        return (response, Answer::Served);
    }
    let (parts, body) = response.into_parts();
    match axum::body::to_bytes(body, MAX_ERROR_BODY).await {
        Ok(bytes) => {
            let answer = answer::classify(parts.status, &parts.headers, &bytes, model);
            (Response::from_parts(parts, Body::from(bytes)), answer)
        }
        Err(_) => (Response::from_parts(parts, Body::empty()), Answer::Final),
    }
}

/// What [`run`] asks besides the vendor.
pub(crate) struct Usage<'a> {
    /// The reset of a used-up usage window Core has already observed.
    pub observed: &'a (dyn Fn(&str) -> Option<Duration> + Sync),
    /// Read an account's usage again, in the background, after a limit
    /// answer that named no reset or a short one: `(account, model)`.
    pub refresh: &'a (dyn Fn(&str, &str) + Sync),
}

/// Try `plan`'s accounts and models in order. `attempt` runs one account,
/// with `Some(model)` when the body's model must be replaced by a backup.
pub(crate) async fn run<F, Fut>(
    plan: &Plan,
    memory: &'static Mutex<Memory>,
    mut attempt: F,
    usage: &Usage<'_>,
) -> Response
where
    F: FnMut(String, Option<String>) -> Fut,
    Fut: Future<Output = Response>,
{
    let provider = plan.provider_id.as_str();
    let session = plan.session.as_deref();
    let mut tries = 0;
    let mut last = None;
    'models: for (index, model) in plan.models.iter().enumerate() {
        let order = memory::lock(memory).order(
            provider,
            session,
            model,
            &plan.accounts,
            plan.manual,
            Instant::now(),
        );
        for account in order {
            if tries == MAX_TRIES {
                break 'models;
            }
            tries += 1;
            let replaced = (index > 0).then(|| model.clone());
            let busy = memory::Busy::start(memory, provider, &account);
            let (response, answer) = judged(attempt(account.clone(), replaced).await, model).await;
            let now = Instant::now();
            match answer {
                Answer::Served => {
                    memory::lock(memory).served(provider, session, &account, model, now);
                    return memory::hold(response, busy);
                }
                Answer::Limited(wait) => {
                    let short = wait.is_none_or(|wait| wait < SHORT_WAIT);
                    let wait = wait
                        .max((usage.observed)(account.as_str()))
                        .unwrap_or(DEFAULT_WAIT)
                        .min(answer::MAX_WAIT);
                    memory::lock(memory).limit(provider, &account, model, now + wait);
                    if short {
                        (usage.refresh)(account.as_str(), model);
                    }
                }
                Answer::NoModel => {
                    memory::lock(memory).refuse_model(provider, &account, model, now);
                }
                Answer::Skip => {}
                Answer::Final => return response,
            }
            last = Some(response);
        }
    }
    let reset =
        memory::lock(memory).first_reset(provider, &plan.accounts, &plan.models, Instant::now());
    match (reset, last) {
        (Some(wait), _) => answer::all_limited(plan.vendor, wait),
        (None, Some(response)) => response,
        (None, None) => answer::no_account_for(plan.vendor, &plan.models[0]),
    }
}

/// Serve one provider request of `agent_id` (on Auto, or with a pool that
/// holds accounts of this provider) account by account. Runs inside the
/// agent's request scope. Anything Auto does not cover goes to the proxy as
/// before.
pub(crate) async fn serve(
    preferences: &crate::server::preferences::PreferencesStore,
    mode: Mode,
    backups: &[Backup],
    request: Request<Body>,
    next: Next,
) -> Response {
    let Some((provider_id, vendor)) = route(request.method(), request.uri().path()) else {
        return next.run(request).await;
    };
    let (parts, body) = request.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, MAX_BODY).await else {
        return answer::too_large(vendor);
    };
    let policy = crate::server::oauth_pool_policy::load(preferences, provider_id).await;
    let model = requested_model(&bytes);
    // A pool that holds no saved account of this provider limits nothing,
    // and the request is handled as before pools existed.
    let limits = mode == Mode::Auto || policy.pool.is_some();
    let accounts =
        candidates(provider_id, &policy).filter(|accounts| limits && !accounts.is_empty());
    let (Some(model), Some(accounts)) = (model, accounts) else {
        return next
            .run(Request::from_parts(parts, Body::from(bytes)))
            .await;
    };
    let plan = Plan {
        vendor,
        provider_id: provider_id.to_owned(),
        session: parts
            .headers
            .get("x-ryu-session-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned),
        accounts,
        manual: policy.strategy == Strategy::Manual,
        models: models_to_try(&model, backups, provider_id),
    };
    // Owned, so the request future stays Send: Next is Send but not Sync.
    let attempt = move |account: String, model: Option<String>| {
        let body = model.map_or_else(|| bytes.clone(), |model| with_model(&bytes, &model));
        let mut request = Request::new(Body::from(body.clone()));
        *request.method_mut() = parts.method.clone();
        *request.uri_mut() = parts.uri.clone();
        *request.version_mut() = parts.version;
        *request.headers_mut() = parts.headers.clone();
        *request.extensions_mut() = parts.extensions.clone();
        request
            .headers_mut()
            .insert(header::CONTENT_LENGTH, body.len().into());
        super::scope::as_account(account, next.clone().run(request))
    };
    let observed = |account: &str| observed_reset(provider_id, account);
    let refresh = |account: &str, model: &str| refresh_usage(provider_id, account, model);
    let usage = Usage {
        observed: &observed,
        refresh: &refresh,
    };
    run(&plan, memory::global(), attempt, &usage).await
}

/// Read the account's usage once more, in the background. When a usage
/// window is used up, the account stays aside until that window resets: the
/// native Claude proxy passes on Retry-After and the RFC 3339 reset headers,
/// but not the subscription's own reset header, so a five hour or weekly limit
/// would otherwise look like one minute.
fn refresh_usage(provider_id: &'static str, account: &str, model: &str) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let (account, model) = (account.to_owned(), model.to_owned());
    runtime.spawn(async move {
        let _ = crate::subscriptions::reading::read_raw(provider_id, &account).await;
        if let Some(wait) = observed_reset(provider_id, &account) {
            let until = Instant::now() + wait.min(answer::MAX_WAIT);
            memory::lock(memory::global()).limit(provider_id, &account, &model, until);
        }
    });
}
