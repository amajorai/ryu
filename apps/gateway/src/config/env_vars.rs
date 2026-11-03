//! Environment parsing helpers shared by the config loader.

use super::*;

/// Apply the env overrides that decide whether this node meters credits:
/// `GATEWAY_CREDITS_URL`, `RYU_CREDITS_INTERNAL_SECRET`, then
/// `GATEWAY_CREDITS_ENABLED` or the managed-node auto-enable.
///
/// The secret is read BEFORE the auto-enable is evaluated. A managed node
/// whose secret is injected only through the environment (the normal fleet
/// shape) must bill exactly like one whose secret is in `gateway.toml`.
pub(super) fn apply_credits_activation_env(
    credits: &mut CreditsConfig,
    var: impl Fn(&str) -> Option<String>,
) {
    if let Some(url) = var("GATEWAY_CREDITS_URL") {
        if !url.trim().is_empty() {
            credits.base_url = url;
        }
    }
    if let Some(secret) = var("RYU_CREDITS_INTERNAL_SECRET") {
        if !secret.trim().is_empty() {
            credits.internal_secret = Some(secret);
        }
    }
    if let Some(raw) = var("GATEWAY_CREDITS_ENABLED") {
        if let Some(enabled) = parse_bool_env(&raw) {
            credits.enabled = enabled;
        }
    } else if credits.internal_secret.is_some() {
        // MANAGED NODES BILL BY DEFAULT; self-hosted ones never do.
        //
        // `enabled` defaults to false, which is right for a self-hoster and
        // catastrophic for us: a managed node that simply forgot
        // GATEWAY_CREDITS_ENABLED serves every request — tokens, tools,
        // media, sandbox — and debits NOTHING. That is a bigger hole than any
        // unset per-call rate, and it fails silently in the same way.
        //
        // The internal secret is the discriminator, and it is the right one
        // because it is not a preference: it is the service-to-service
        // credential the control plane issues so this gateway may debit an
        // ARBITRARY org's wallet. Only a Ryu-provisioned node is given one. A
        // self-hoster has no secret, so this branch never fires for them and
        // their gateway stays free exactly as before.
        //
        // An explicit GATEWAY_CREDITS_ENABLED still wins in both directions,
        // so a managed node can be deliberately un-metered when needed.
        credits.enabled = true;
    }
}

/// OpenRouter `provider.data_collection` value used on Ryu-managed nodes.
pub(super) const MANAGED_OPENROUTER_DATA_COLLECTION: &str = "deny";

/// Record the managed OpenRouter privacy posture (`data_collection = "deny"`) in
/// the configuration of Ryu-managed gateways.
///
/// Per-request chat and embedding traffic already forces `deny` and ZDR in the
/// OpenRouter provider. The configured value still matters for paths that
/// cannot carry that per-request policy: the batch API refuses OpenRouter
/// batches when it is set, instead of submitting work without the guarantee.
/// Core sets the same default on the gateway sidecars it launches; this covers
/// standalone hosted gateways, which previously left it empty.
///
/// A managed node is identified the same way as for metering: it holds the
/// control-plane credits secret, which only Ryu-provisioned nodes receive. A
/// self-hosted gateway keeps its own setting, and an explicit
/// `OPENROUTER_DATA_COLLECTION` (even empty) or a non-empty `gateway.toml`
/// value always wins.
pub(super) fn apply_managed_openrouter_privacy_default(
    config: &mut GatewayConfig,
    explicit_env: bool,
) {
    if explicit_env || config.credits.internal_secret.is_none() {
        return;
    }
    if let Some(openrouter) = config.providers.openrouter.as_mut() {
        if openrouter.data_collection.trim().is_empty() {
            openrouter.data_collection = MANAGED_OPENROUTER_DATA_COLLECTION.to_owned();
        }
    }
}

/// Parse a boolean-ish environment-variable value. Returns `None` for an
/// unrecognised value so the caller can keep the existing config.
pub(super) fn parse_bool_env(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// Read a boolean flag from the environment, falling back to `default` when the
/// variable is unset or holds an unrecognised value.
pub(super) fn env_bool(name: &str, default: bool) -> bool {
    std::env::var(name)
        .ok()
        .and_then(|v| parse_bool_env(&v))
        .unwrap_or(default)
}

/// Parse a comma-separated env var into a list of API keys for multi-account
/// rotation (#4), e.g. `OPENAI_API_KEYS=sk-a,sk-b,sk-c`. Blank entries dropped;
/// unset → empty (single-account, uses the scalar `*_API_KEY`).
pub(super) fn env_keys(name: &str) -> Vec<String> {
    std::env::var(name)
        .ok()
        .map(|v| {
            v.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn first_non_empty_env(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    })
}

pub(super) fn non_empty_provider_key<'a>(
    keys: &'a HashMap<String, String>,
    provider: &str,
) -> Option<&'a str> {
    keys.get(provider)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}
