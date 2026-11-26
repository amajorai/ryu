//! A provider's credentials as one ordered list, and the setting that lets an
//! API key take over when the provider's subscription accounts run out.
//!
//! The order is the per-account priority of the account pool policy (lower
//! first), so every chooser that already reads the policy follows it. This
//! module adds what the policy does not hold: a short hint for each API key
//! (its last characters, read from the sealed vault and never stored) and the
//! fallback setting, which is off unless the user turns it on.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{failover_rules::Rest, Policy};
use crate::pi_config::accounts::{AccountInfo, AccountVault, KIND_API_KEY};
use crate::server::{preferences::PreferencesStore, ServerState};

const SETTINGS_PREFIX: &str = "provider-credential-settings:";
/// How many characters of an API key a hint shows.
const HINT_LENGTH: usize = 4;
/// A shorter key gets no hint: four characters would be a real share of it.
const MIN_KEY_LENGTH_FOR_HINT: usize = 16;

/// Subscription providers whose requests Core carries itself, with the
/// provider whose API keys can serve the same request.
const FALLBACK_KEY_PROVIDERS: &[(&str, &str)] = &[("claude-pro-max", "anthropic")];

/// The provider whose API keys can stand in for `provider_id`'s subscription
/// accounts, or `None` when Core cannot switch that provider to a key.
pub(crate) fn fallback_key_provider(provider_id: &str) -> Option<&'static str> {
    FALLBACK_KEY_PROVIDERS
        .iter()
        .find(|(subscription, _)| *subscription == provider_id)
        .map(|(_, keys)| *keys)
}

/// Per-provider credential settings. A missing or unreadable record reads as
/// the default, so a paid key is never used by accident.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Use API keys when every subscription account is at its limit or failing.
    pub api_key_fallback: bool,
}

fn settings_key(provider_id: &str) -> String {
    format!("{SETTINGS_PREFIX}{provider_id}")
}

pub(crate) async fn load_settings(preferences: &PreferencesStore, provider_id: &str) -> Settings {
    if fallback_key_provider(provider_id).is_none() {
        return Settings::default();
    }
    match preferences.get(&settings_key(provider_id)).await {
        Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_default(),
        _ => Settings::default(),
    }
}

/// Accounts in priority order. Accounts with the same priority keep the order
/// they were given in (the vault lists the active account first).
pub(crate) fn in_order(mut accounts: Vec<AccountInfo>, policy: &Policy) -> Vec<AccountInfo> {
    accounts.sort_by_key(|account| policy.priority(&account.account_id));
    accounts
}

/// The last characters of an API key, for telling keys apart. `None` for a
/// short key or one that does not end in printable characters.
pub(crate) fn key_hint(credential: &Value) -> Option<String> {
    let key = credential
        .as_str()
        .or_else(|| credential.get("key").and_then(Value::as_str))?
        .trim();
    let characters: Vec<char> = key.chars().collect();
    if characters.len() < MIN_KEY_LENGTH_FOR_HINT {
        return None;
    }
    let tail: String = characters[characters.len() - HINT_LENGTH..]
        .iter()
        .collect();
    tail.chars()
        .all(|character| character.is_ascii_graphic())
        .then_some(tail)
}

/// One row of a provider's credential list. Carries no credential.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialView {
    pub account_id: String,
    pub label: String,
    /// `api_key`, `oauth` or `opaque`.
    pub kind: String,
    /// Whether the account pool policy lets new work use it.
    pub enabled: bool,
    pub needs_reauth: bool,
    /// Last characters of an API key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// Why a fallback key is resting right now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resting: Option<Rest>,
}

/// `accounts` of `scope` as ordered rows.
pub(crate) fn views(
    vault: &AccountVault,
    scope: &str,
    accounts: Vec<AccountInfo>,
    policy: &Policy,
    resting: impl Fn(&str) -> Option<Rest>,
) -> Vec<CredentialView> {
    in_order(accounts, policy)
        .into_iter()
        .map(|account| {
            let hint = if account.kind == KIND_API_KEY {
                vault
                    .credential(scope, &account.account_id)
                    .ok()
                    .flatten()
                    .as_ref()
                    .and_then(key_hint)
            } else {
                None
            };
            CredentialView {
                enabled: policy.allowed(&account.account_id),
                resting: resting(&account.account_id),
                hint,
                needs_reauth: account.needs_reauth,
                account_id: account.account_id,
                label: account.label,
                kind: account.kind,
            }
        })
        .collect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FallbackView {
    /// Whether Core can switch this provider to an API key at all.
    supported: bool,
    enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    key_provider_id: Option<&'static str>,
    /// The API keys that would take over, in the order they are tried.
    keys: Vec<CredentialView>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialsView {
    provider_id: String,
    credentials: Vec<CredentialView>,
    api_key_fallback: FallbackView,
}

fn build_view(
    provider_id: &str,
    policy: &Policy,
    settings: Settings,
    key_policy: Option<&Policy>,
) -> CredentialsView {
    let vault = crate::pi_config::accounts::global();
    let credentials = match (vault, crate::pi_config::provider_account_scope(provider_id)) {
        (Some(vault), Some(scope)) => views(
            vault,
            &scope,
            crate::pi_config::list_provider_accounts(provider_id),
            policy,
            |_| None,
        ),
        _ => Vec::new(),
    };
    let key_provider_id = fallback_key_provider(provider_id);
    let keys = match (vault, key_provider_id, key_policy) {
        (Some(vault), Some(key_provider), Some(key_policy)) => {
            match crate::pi_config::provider_account_scope(key_provider) {
                Some(scope) => views(
                    vault,
                    &scope,
                    crate::pi_config::list_provider_accounts(key_provider)
                        .into_iter()
                        .filter(|account| account.kind == KIND_API_KEY)
                        .collect(),
                    key_policy,
                    super::claude_fallback::resting,
                ),
                None => Vec::new(),
            }
        }
        _ => Vec::new(),
    };
    CredentialsView {
        provider_id: provider_id.to_owned(),
        credentials,
        api_key_fallback: FallbackView {
            supported: key_provider_id.is_some(),
            enabled: key_provider_id.is_some() && settings.api_key_fallback,
            key_provider_id,
            keys,
        },
    }
}

async fn respond_with_view(state: &ServerState, provider_id: String) -> Response {
    let policy = super::load(&state.preferences, &provider_id).await;
    let settings = load_settings(&state.preferences, &provider_id).await;
    let key_policy = match fallback_key_provider(&provider_id) {
        Some(key_provider) => Some(super::load(&state.preferences, key_provider).await),
        None => None,
    };
    // Vault reads are synchronous; keep them off the async workers.
    let view = tokio::task::spawn_blocking(move || {
        build_view(&provider_id, &policy, settings, key_policy.as_ref())
    })
    .await;
    match view {
        Ok(view) => Json(view).into_response(),
        Err(error) => {
            tracing::error!(%error, "could not read provider credentials");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// `GET /api/pi-config/providers/{id}/credentials`: the provider's credentials
/// in priority order (labels, kinds and key hints, never a credential) and its
/// API key fallback setting.
pub async fn get_credentials(
    State(state): State<ServerState>,
    Path(provider_id): Path<String>,
) -> Response {
    if !super::supported(&provider_id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    respond_with_view(&state, provider_id).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsBody {
    api_key_fallback: bool,
}

/// `PUT /api/pi-config/providers/{id}/credentials`: turn the API key fallback
/// on or off. Refused for a provider Core cannot switch to a key.
pub async fn put_credentials(
    State(state): State<ServerState>,
    Path(provider_id): Path<String>,
    Json(body): Json<SettingsBody>,
) -> Response {
    if !super::supported(&provider_id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    if fallback_key_provider(&provider_id).is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "This provider cannot use API keys as a fallback" })),
        )
            .into_response();
    }
    let settings = Settings {
        api_key_fallback: body.api_key_fallback,
    };
    let serialized = match serde_json::to_string(&settings) {
        Ok(value) => value,
        Err(error) => {
            tracing::error!(%error, "could not encode provider credential settings");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    if let Err(error) = state
        .preferences
        .set(&settings_key(&provider_id), &serialized)
        .await
    {
        tracing::error!(%error, "could not save provider credential settings");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    respond_with_view(&state, provider_id).await
}

#[cfg(test)]
#[path = "credentials_test.rs"]
mod tests;
