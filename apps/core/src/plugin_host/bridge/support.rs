//! Free helpers of the bridge: preset grants, usage and subscription argument
//! parsing, the live-read limiter and the result constructors.
// test-exempt: moved verbatim out of plugin_host/bridge.rs; tests in bridge/tests.rs and bridge/runtime_tests.rs.

use super::*;

/// Map a permission-preset string to the closed [`PermissionPreset`] set. An
/// unknown/absent value falls back to the safest non-trivial preset (read but
/// never mutate) — the right default for an independent verifier.
/// Plain `hook:run-agent` admits only read-only presets; a mutating preset also
/// needs [`GRANT_RUN_AGENT_WRITE`]. Returns the denial message (classified as a
/// 403 `denied` by the bridge API because it contains "not granted").
pub(super) fn check_preset_grant(
    grants: &HashSet<String>,
    plugin_id: &str,
    preset: PermissionPreset,
) -> Result<(), String> {
    if preset.allows_mutation() && !grants.contains(GRANT_RUN_AGENT_WRITE) {
        return Err(format!(
            "capability '{GRANT_RUN_AGENT_WRITE}' not granted to plugin '{plugin_id}': \
             '{GRANT_RUN_AGENT}' only allows read-only presets (code_read, research, summarise)"
        ));
    }
    Ok(())
}

pub(super) fn parse_preset(s: Option<&str>) -> PermissionPreset {
    match s.map(str::trim).unwrap_or_default() {
        "research" => PermissionPreset::Research,
        "code_write" => PermissionPreset::CodeWrite,
        "summarise" | "summarize" => PermissionPreset::Summarise,
        _ => PermissionPreset::CodeRead,
    }
}

pub(super) fn bounded_notification_text(value: Option<&str>, max_chars: usize) -> String {
    value
        .unwrap_or_default()
        .chars()
        .filter(|character| !character.is_control())
        .take(max_chars)
        .collect::<String>()
        .trim()
        .to_string()
}

/// A successful host result.
pub(super) fn ok(value: Value) -> InvokeOutcome {
    InvokeOutcome::Result(ToolInvokeResult {
        value,
        is_error: false,
        error: None,
    })
}

/// The two mutually exclusive argument forms of `host.usageSnapshot`.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum UsageArgs<'a> {
    Agent(&'a str),
    Provider {
        provider_id: &'a str,
        account_id: Option<&'a str>,
    },
}

/// An optional trimmed string argument; `null` counts as absent.
pub(super) fn usage_text_arg<'a>(args: &'a Value, key: &str) -> Result<Option<&'a str>, String> {
    match args.get(key).filter(|value| !value.is_null()) {
        None => Ok(None),
        Some(value) => value
            .as_str()
            .map(|value| Some(value.trim()))
            .ok_or_else(|| format!("host.usageSnapshot '{key}' must be a string")),
    }
}

pub(super) fn parse_usage_args(args: &Value) -> Result<UsageArgs<'_>, String> {
    let agent_id = usage_text_arg(args, "agent_id")?;
    let provider_id = usage_text_arg(args, "provider_id")?;
    let account_id = usage_text_arg(args, "account_id")?;
    match (agent_id, provider_id) {
        (Some(_), Some(_)) => Err(
            "host.usageSnapshot accepts either 'agent_id' or 'provider_id', not both".to_owned(),
        ),
        (_, None) if account_id.is_some() => {
            Err("host.usageSnapshot 'account_id' requires 'provider_id'".to_owned())
        }
        (Some(agent_id), None) if !agent_id.is_empty() => Ok(UsageArgs::Agent(agent_id)),
        (None, Some(provider_id)) => {
            validate_subscription_id("provider_id", provider_id)?;
            if let Some(account_id) = account_id {
                validate_subscription_id("account_id", account_id)?;
            }
            Ok(UsageArgs::Provider {
                provider_id,
                account_id,
            })
        }
        _ => Err("host.usageSnapshot requires a non-empty 'agent_id' or 'provider_id'".to_owned()),
    }
}

/// Validate a caller-supplied provider or account id (1..=256 characters).
pub(super) fn validate_subscription_id(field: &str, value: &str) -> Result<(), String> {
    let chars = value.chars().count();
    if value.trim().is_empty() || chars > crate::subscriptions::MAX_ID_CHARS {
        return Err(format!(
            "'{field}' must be 1..={} characters",
            crate::subscriptions::MAX_ID_CHARS
        ));
    }
    Ok(())
}

/// Fail-closed gate for the owner-tier subscription calls: the grant first,
/// then a verified node owner/admin caller. The admin check only runs once the
/// grant is held.
pub(super) fn subscriptions_gate(
    plugin_id: &str,
    granted: bool,
    admin_allowed: impl FnOnce() -> bool,
) -> Result<(), String> {
    if !granted {
        return Err(format!(
            "capability '{GRANT_SUBSCRIPTIONS_READ}' not granted to plugin '{plugin_id}'"
        ));
    }
    if !admin_allowed() {
        return Err("subscriptions are visible to the node owner only".to_owned());
    }
    Ok(())
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SubscriptionsListArgs {
    #[serde(default)]
    pub(super) provider_id: Option<String>,
    #[serde(default)]
    pub(super) usage: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SubscriptionsUsageArgs {
    pub(super) provider_id: String,
    #[serde(default)]
    pub(super) account_id: Option<String>,
}

/// The bridge never forces a vendor read; `force` is owner-HTTP only.
pub(super) fn parse_list_usage(
    usage: Option<&str>,
) -> Result<crate::subscriptions::UsageMode, String> {
    use crate::subscriptions::UsageMode;
    match usage {
        None | Some("cached") => Ok(UsageMode::Cached),
        Some("none") => Ok(UsageMode::None),
        Some("refresh") => Ok(UsageMode::Refresh),
        Some(_) => Err("subscriptions.list 'usage' must be none, cached or refresh".to_owned()),
    }
}

pub(super) type LiveReadKey = (String, String, String);

/// Per-(plugin, provider, account) live-read limiter for the T1 bridge calls.
#[derive(Default)]
pub(super) struct LiveReadLimiter {
    pub(super) last: std::sync::Mutex<std::collections::HashMap<LiveReadKey, std::time::Instant>>,
}

impl LiveReadLimiter {
    /// `true` (and the slot is taken) when `key` had no live read in the last
    /// `interval`; `false` means the caller must stay cache-only.
    pub(super) fn try_acquire(
        &self,
        key: LiveReadKey,
        now: std::time::Instant,
        interval: std::time::Duration,
    ) -> bool {
        let mut last = self
            .last
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        last.retain(|_, at| now.saturating_duration_since(*at) < interval);
        if last.contains_key(&key) {
            return false;
        }
        last.insert(key, now);
        true
    }
}

pub(super) fn subscription_live_reads() -> &'static LiveReadLimiter {
    static LIMITER: std::sync::OnceLock<LiveReadLimiter> = std::sync::OnceLock::new();
    LIMITER.get_or_init(LiveReadLimiter::default)
}

/// The cached raw snapshot (and when it was observed) for one saved account
/// under its current credential revision. Never reads the vendor.
pub(super) fn cached_account_snapshot(
    provider_id: &str,
    account_id: &str,
) -> Option<(ryu_usage::UsageSnapshot, String)> {
    let scope = crate::pi_config::provider_account_scope(provider_id)?;
    let revision = crate::pi_config::accounts::global()?
        .credential_revision(&scope, account_id)
        .ok()
        .flatten()?;
    let hit = crate::subscriptions::cache::global().lookup(
        provider_id,
        account_id,
        &revision,
        crate::subscriptions::cache::Freshness::MaxAge(crate::subscriptions::DEFAULT_MAX_AGE),
    )?;
    Some((hit.snapshot, hit.observed_at.to_rfc3339()))
}

/// Project one provider for the label-free hook form. Account rows carry ids,
/// eligibility and the cached raw snapshot only — never the saved label.
pub(super) fn provider_usage_projection(
    provider: Option<&crate::subscriptions::SubscriptionProvider>,
    provider_id: &str,
    account_id: Option<&str>,
    cached: impl Fn(&str, &str) -> Option<(ryu_usage::UsageSnapshot, String)>,
) -> Value {
    use crate::subscriptions::AccountState;
    let usage_supported = provider.is_some_and(|provider| provider.capabilities.account_usage);
    let pool_strategy = provider
        .and_then(|provider| provider.policy.as_ref())
        .and_then(|policy| serde_json::to_value(policy.strategy).ok())
        .unwrap_or(Value::Null);
    let rows = provider.map_or(&[][..], |provider| provider.accounts.as_slice());
    let mut accounts = Vec::new();
    for row in rows
        .iter()
        .filter(|row| account_id.is_none_or(|wanted| row.account_id == wanted))
    {
        let mut state = row.state;
        let mut usage = Value::Null;
        let mut observed_at = None;
        if matches!(state, AccountState::Ok | AccountState::Unavailable) {
            match cached(provider_id, &row.account_id) {
                Some((snapshot, observed)) => {
                    usage = serde_json::to_value(snapshot).unwrap_or(Value::Null);
                    observed_at = Some(observed);
                }
                // The reading expired between the listing and this lookup.
                None if state == AccountState::Ok => state = AccountState::Pending,
                None => {}
            }
        }
        let mut entry = json!({
            "account_id": row.account_id,
            "active": row.active,
            "eligible": row.pool_enabled && !row.needs_reauth,
            "needs_reauth": row.needs_reauth,
            "state": serde_json::to_value(state).unwrap_or(Value::Null),
            "usage": usage,
        });
        if let (Some(observed_at), Some(object)) = (observed_at, entry.as_object_mut()) {
            object.insert("observed_at".to_owned(), Value::String(observed_at));
        }
        accounts.push(entry);
    }
    let account_not_found = account_id.is_some() && accounts.is_empty();
    let mut out = json!({
        "provider_id": provider_id,
        "usage_supported": usage_supported,
        "pool_strategy": pool_strategy,
        "accounts": accounts,
    });
    if account_not_found {
        out["error"] = Value::String("account_not_found".to_owned());
    }
    out
}

/// A host error the hook can catch (rejects the awaited call).
pub(super) fn err(message: String) -> InvokeOutcome {
    InvokeOutcome::Result(ToolInvokeResult {
        value: Value::Null,
        is_error: true,
        error: Some(message),
    })
}
