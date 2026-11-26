//! Limits one account choice to the pool of the agent it is made for.
//!
//! The restriction is a set of account ids on the provider's
//! [`Policy`]; [`Policy::allowed`] refuses every account outside it. Each
//! selection, bound-session check, rotation, cooldown retry and failover step
//! of the native proxies and of the SDK capture already asks that one
//! predicate, so none of them can pick an account outside the pool.

use std::collections::BTreeSet;
use std::sync::Arc;

use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, HeaderValue, Request},
    middleware::Next,
    response::Response,
};
use sha2::{Digest, Sha256};

use super::model::Catalog;
use super::modes::Mode;
use super::{engine_token, store};
use crate::server::oauth_pool_policy::{Policy, Strategy};
use crate::server::preferences::PreferencesStore;
use crate::server::ServerState;

const SESSION_HEADER: &str = "x-ryu-session-id";

tokio::task_local! {
    /// The agent whose managed Pi sent the provider request this task serves.
    static REQUEST_AGENT: String;
    /// The one account an attempt of [`super::auto`] runs on.
    static REQUEST_ACCOUNT: String;
}

/// Whether two provider ids list the same saved accounts. Several ids can
/// share one vault scope (a subscription and its API key twin), so a pool
/// member counts for every provider that reads its account list.
pub(crate) fn same_account_list(left: &str, right: &str) -> bool {
    left == right
        || crate::pi_config::provider_account_scope(left).is_some_and(|scope| {
            crate::pi_config::provider_account_scope(right).as_ref() == Some(&scope)
        })
}

/// The provider's saved accounts as `(account id, is the active one)`, or
/// `None` when the vault cannot be read.
fn listed_accounts(provider_id: &str) -> Option<Vec<(String, bool)>> {
    let scope = crate::pi_config::provider_account_scope(provider_id)?;
    let accounts = crate::pi_config::accounts::global()?.list(&scope).ok()?;
    Some(
        accounts
            .into_iter()
            .map(|account| (account.account_id, account.active))
            .collect(),
    )
}

/// Limit `policy` to the accounts `agent_id`'s pool holds for the provider.
/// Leaves it untouched when the agent has no pool, or when its pool holds no
/// account of this provider that is still saved (`listed`, `None` when the
/// vault could not be read; the stored members then stand as they are).
pub(crate) fn restrict_with(
    catalog: &Catalog,
    policy: &mut Policy,
    agent_id: &str,
    same_provider: impl Fn(&str) -> bool,
    listed: Option<&[(String, bool)]>,
    manual_needs_active: bool,
) {
    let Some(mut members) = catalog.accounts_of(agent_id, same_provider) else {
        return;
    };
    if let Some(listed) = listed {
        members.retain(|id| listed.iter().any(|(saved, _)| saved == id));
        if members.is_empty() {
            return;
        }
    }
    // "Manual" names the provider's active account. A proxy that can only
    // use that one account in manual mode rotates inside the pool instead
    // when the pool does not hold it.
    if manual_needs_active && policy.strategy == Strategy::Manual {
        let active_in_pool = listed.is_some_and(|listed| {
            listed
                .iter()
                .any(|(id, active)| *active && members.contains(id))
        });
        if !active_in_pool {
            policy.strategy = Strategy::RoundRobin;
        }
    }
    policy.pool = Some(Arc::new(members));
}

/// [`restrict_with`] against the stored catalog and the account vault. When
/// the catalog cannot be read the policy allows no account at all: the pool
/// is unknown, and choosing anyway could leave it.
pub(crate) async fn restrict(
    preferences: &PreferencesStore,
    policy: &mut Policy,
    provider_id: &str,
    agent_id: &str,
) {
    let catalog = match store::load(preferences).await {
        Ok(catalog) => catalog,
        Err(error) => {
            tracing::error!(%error, "account pools could not be read; refusing to choose an account");
            policy.pool = Some(Arc::new(BTreeSet::new()));
            return;
        }
    };
    if catalog.pool_of(agent_id).is_none() {
        return;
    }
    let listed = listed_accounts(provider_id);
    restrict_with(
        &catalog,
        policy,
        agent_id,
        |member| same_account_list(member, provider_id),
        listed.as_deref(),
        provider_id == crate::pi_config::CHATGPT_PLAN_PROVIDER_ID,
    );
}

/// Apply the pool of the agent this request task serves, if it has one. A
/// task outside [`provider_route_scope`] has no agent and changes nothing.
pub(crate) async fn restrict_for_request(
    preferences: &PreferencesStore,
    policy: &mut Policy,
    provider_id: &str,
) {
    let Ok(agent_id) = REQUEST_AGENT.try_with(Clone::clone) else {
        return;
    };
    restrict(preferences, policy, provider_id, &agent_id).await;
    if let Ok(account) = REQUEST_ACCOUNT.try_with(Clone::clone) {
        narrow_to(policy, account);
    }
}

/// Leave only `account` (when the policy allows it at all), chosen whatever
/// the strategy: "manual" names the active account and the quota strategies
/// may pass over an account above its drain threshold, but an attempt of
/// [`super::auto`] names its own account.
pub(crate) fn narrow_to(policy: &mut Policy, account: String) {
    let only = if policy.allowed(&account) {
        BTreeSet::from([account])
    } else {
        BTreeSet::new()
    };
    policy.pool = Some(Arc::new(only));
    policy.strategy = Strategy::RoundRobin;
}

/// Run `future` as one attempt of [`super::auto`] on `account_id`.
pub(crate) async fn as_account<T>(
    account_id: String,
    future: impl std::future::Future<Output = T>,
) -> T {
    REQUEST_ACCOUNT.scope(account_id, future).await
}

fn presented_bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("x-ryu-node-token")
        .and_then(|value| value.to_str().ok())
        .or_else(|| {
            headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("Bearer "))
        })
}

/// A session id every provider proxy accepts as one (their strictest rules).
fn usable_session(headers: &HeaderMap) -> bool {
    headers
        .get(SESSION_HEADER)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|id| {
            !id.is_empty()
                && id.len() <= 128
                && !id.starts_with('$')
                && !id.chars().any(char::is_control)
        })
}

pub(crate) fn fallback_session(agent_id: &str) -> String {
    let digest = hex::encode(Sha256::digest(agent_id.as_bytes()));
    format!("agent-pool-{}", &digest[..32])
}

/// Middleware for the provider proxy routes: run the request as the agent its
/// bearer was minted for, so [`restrict_for_request`] can scope the policy the
/// handler loads. A request with any other credential passes through as is.
///
/// A proxy that gets no session id skips account selection and forwards with
/// the provider's active account. For an agent that has a pool, a missing or
/// unusable session id is therefore replaced by a stable one of its own.
pub(crate) async fn provider_route_scope(
    State(state): State<ServerState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    scope_request(&state.preferences, request, next).await
}

pub(crate) async fn scope_request(
    preferences: &PreferencesStore,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    if !crate::pi_config::secret_env::is_provider_route(request.uri().path()) {
        return next.run(request).await;
    }
    let Some(agent_id) =
        presented_bearer(request.headers()).and_then(engine_token::agent_for_token)
    else {
        return next.run(request).await;
    };
    // Unknown counts as pooled, so a failed read cannot open the gap: the
    // pool restriction then allows no account at all.
    let catalog = store::load(preferences).await.ok();
    let mode = catalog
        .as_ref()
        .map_or(Mode::Pool, |catalog| catalog.mode_of(&agent_id));
    if mode != Mode::None && !usable_session(request.headers()) {
        if let Ok(value) = HeaderValue::from_str(&fallback_session(&agent_id)) {
            request.headers_mut().insert(SESSION_HEADER, value);
        }
    }
    let backups = catalog
        .as_ref()
        .map(|catalog| catalog.backups_of(&agent_id).to_vec())
        .unwrap_or_default();
    REQUEST_AGENT
        .scope(agent_id, async move {
            if mode == Mode::None {
                next.run(request).await
            } else {
                super::auto::serve(preferences, mode, &backups, request, next).await
            }
        })
        .await
}

/// Run `future` as a provider request of `agent_id`.
#[cfg(test)]
pub(crate) async fn as_agent<T>(agent_id: &str, future: impl std::future::Future<Output = T>) -> T {
    REQUEST_AGENT.scope(agent_id.to_owned(), future).await
}
