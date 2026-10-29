//! Built-in provider-usage tools for agents.
//!
//! The subscription readers in [`ryu_usage`] already own the vendor-specific
//! credential and response handling. This module is the agent-facing projection
//! over that primitive: it reports the active provider/model or an explicitly
//! requested provider/model through the normal Core MCP registry, so the Gateway
//! can apply its usual allowlist, budget, and audit controls.
//!
//! Readings go through [`crate::subscriptions`], the same revision-keyed,
//! cache-first primitive the owner UI and the plugin bridge use, so every
//! surface derives identical window and meter `targetId`s. Credentials stay
//! inside Core: subscription credentials come from the sealed account store
//! (the active account, or exactly the requested `account_id`), and BYOK keys
//! are handed to the credit reader for one request only. Neither credential is
//! placed in tool arguments, logs, or the returned usage projection.
//!
//! This surface is agent-visible, so it never returns account labels (often
//! email addresses): accounts are identified by their opaque ids only.

use anyhow::{Context, Result};
use serde_json::{json, Map, Value};

use super::RegistryTool;
use crate::subscriptions::{
    self,
    reading::{self, ReadOptions},
    AccountSel, ProviderKind, ProviderUsageReading, SnapshotQuery, UsageMode,
};

/// Reserved registry server for read-only provider usage.
pub const SERVER_NAME: &str = "usage";

/// Read usage for the provider/model currently selected in Ryu's managed Pi.
pub const CURRENT_TOOL_ID: &str = "usage.current";

/// Read usage for an explicitly selected provider and optional model.
pub const QUERY_TOOL_ID: &str = "usage.query";

/// List providers for which Core has a normalized usage reader.
pub const PROVIDERS_TOOL_ID: &str = "usage.providers";

const MAX_IDENTIFIER_CHARS: usize = 256;

fn current_schema() -> Value {
    json!({
        "type": "object",
        "properties": {},
        "additionalProperties": false,
        "description": "No arguments. Reads the provider and model currently selected in Ryu."
    })
}

fn query_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "provider": {
                "type": "string",
                "description": "Ryu provider id (for example claude-pro-max, openai-codex, chatgpt, github-copilot, openrouter, deepseek, or moonshot). ACP ids such as acp:claude are also accepted.",
                "minLength": 1,
                "maxLength": MAX_IDENTIFIER_CHARS
            },
            "model": {
                "type": "string",
                "description": "Optional model id. Account-wide windows are always returned; model-scoped windows are included when they match this model.",
                "minLength": 1,
                "maxLength": MAX_IDENTIFIER_CHARS
            },
            "account_id": {
                "type": "string",
                "description": "Optional saved account id from usage.providers. Reads exactly that account and never falls back to the active one; omit it to read the provider's active account.",
                "minLength": 1,
                "maxLength": MAX_IDENTIFIER_CHARS
            }
        },
        "required": ["provider"],
        "additionalProperties": false
    })
}

fn providers_schema() -> Value {
    json!({
        "type": "object",
        "properties": {},
        "additionalProperties": false,
        "description": "No arguments. Lists providers with a supported subscription-usage or API-credit reader, and each provider's saved accounts by id."
    })
}

fn read_only_annotations() -> Value {
    json!({
        "readOnlyHint": true,
        "destructiveHint": false
    })
}

/// The read-only usage tools exposed through the unified catalog.
pub fn tools() -> Vec<RegistryTool> {
    let annotations = read_only_annotations();
    vec![
        RegistryTool {
            id: CURRENT_TOOL_ID.to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "current".to_owned(),
            description: Some(
                "Read the currently active Ryu provider and model's live usage. Returns remaining percent, used percent, window length, and the exact reset time for 5-hour, weekly, or other provider-reported limits; unavailable providers return a structured reason instead of fabricated zeros.".to_owned(),
            ),
            input_schema: Some(current_schema()),
            annotations: Some(annotations.clone()),
            ..Default::default()
        },
        RegistryTool {
            id: QUERY_TOOL_ID.to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "query".to_owned(),
            description: Some(
                "Read live usage for a specified provider, optional model, and optional saved account. Returns account-wide and matching model-scoped windows with remaining percent, used percent, window length, and reset timestamps, plus provider credit meters when that provider exposes a balance endpoint. Without account_id the provider's active account is read.".to_owned(),
            ),
            input_schema: Some(query_schema()),
            annotations: Some(annotations),
            ..Default::default()
        },
        RegistryTool {
            id: PROVIDERS_TOOL_ID.to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "providers".to_owned(),
            description: Some(
                "List provider IDs supported by Core's normalized usage readers, including subscription windows and readable API-credit balances, with each provider's saved account ids. Use these IDs with usage.query; account names and credentials remain inside Core.".to_owned(),
            ),
            input_schema: Some(providers_schema()),
            annotations: Some(read_only_annotations()),
            ..Default::default()
        },
    ]
}

/// Dispatch a `usage` tool call. Vendor failures remain structured usage
/// results; malformed tool arguments and unknown tool ids are real errors.
pub async fn dispatch(tool: &str, arguments: Value) -> Result<Value> {
    match tool {
        "current" => dispatch_current(arguments).await,
        "query" => dispatch_query(arguments).await,
        "providers" => {
            let object = object_arguments(&arguments)?;
            reject_unknown_keys(object, &[])?;
            Ok(provider_catalog().await)
        }
        other => Err(anyhow::anyhow!("unknown usage tool '{other}'")),
    }
}

/// The label-free provider → accounts catalog.
///
/// Rows come from the shared subscription snapshot with labels off and no
/// vendor I/O, so the agent sees which saved accounts exist (by opaque id) but
/// never their display names, which are often email addresses. Readers that
/// have no saved accounts yet (an API-credit key from the environment, or an
/// OAuth-capable BYOK login) are appended so they stay discoverable.
async fn provider_catalog() -> Value {
    let snapshot = subscriptions::snapshot(SnapshotQuery {
        usage: UsageMode::None,
        include_labels: false,
        ..SnapshotQuery::default()
    })
    .await;
    let mut seen = std::collections::HashSet::new();
    let mut providers = Vec::new();
    for provider in &snapshot.providers {
        seen.insert(provider.provider_id.clone());
        providers.push(json!({
            "providerId": provider.provider_id,
            "label": provider.label,
            "kind": catalog_kind(provider.kind),
            "capabilities": { "accountUsage": provider.capabilities.account_usage },
            "accounts": provider
                .accounts
                .iter()
                .map(|account| {
                    catalog_account(
                        &account.account_id,
                        account.active,
                        &account.kind,
                        account.needs_reauth,
                    )
                })
                .collect::<Vec<_>>(),
        }));
    }

    let supplementary = crate::pi_config::PROVIDERS
        .iter()
        .filter(|provider| {
            crate::pi_config::oauth_login::oauth_provider_id(provider.id).is_some()
                || ryu_usage::supports_provider_credits(provider.id)
        })
        .map(|provider| (provider.id, provider.label))
        .chain(
            ryu_usage::PROVIDERS_WITH_CREDITS
                .iter()
                .map(|provider| (*provider, *provider)),
        );
    for (provider_id, label) in supplementary {
        if !seen.insert(provider_id.to_owned()) {
            continue;
        }
        let kind = if ryu_usage::supports_provider_credits(provider_id) {
            "api_credits"
        } else {
            "subscription"
        };
        let account_usage = subscriptions::provider_capabilities(provider_id)
            .is_some_and(|capabilities| capabilities.account_usage);
        let accounts = crate::pi_config::list_provider_accounts(provider_id)
            .iter()
            .map(|info| {
                catalog_account(&info.account_id, info.active, &info.kind, info.needs_reauth)
            })
            .collect::<Vec<_>>();
        providers.push(json!({
            "providerId": provider_id,
            "label": label,
            "kind": kind,
            "capabilities": { "accountUsage": account_usage },
            "accounts": accounts,
        }));
    }

    json!({ "providers": providers })
}

/// The tool's published provider kinds. ACP CLI logins have always been listed
/// as `subscription` here, and existing clients validate this closed set.
fn catalog_kind(kind: ProviderKind) -> &'static str {
    match kind {
        ProviderKind::ApiCredits => "api_credits",
        ProviderKind::Subscription | ProviderKind::AgentLogin => "subscription",
    }
}

/// One label-free account row. Deliberately has no `label` field.
fn catalog_account(account_id: &str, active: bool, kind: &str, needs_reauth: bool) -> Value {
    json!({
        "accountId": account_id,
        "active": active,
        "kind": kind,
        "needsReauth": needs_reauth,
    })
}

async fn dispatch_current(arguments: Value) -> Result<Value> {
    let object = object_arguments(&arguments)?;
    reject_unknown_keys(object, &[])?;

    let active = crate::pi_config::current();
    let provider = bounded_identifier(&active.provider, "active provider")?;
    let model = active
        .model
        .as_deref()
        .map(|value| bounded_identifier(value, "active model"))
        .transpose()?;
    query_usage(&provider, model.as_deref(), None, &active, true).await
}

async fn dispatch_query(arguments: Value) -> Result<Value> {
    let object = object_arguments(&arguments)?;
    reject_unknown_keys(object, &["provider", "model", "account_id"])?;
    let provider = required_identifier(object, "provider")?;
    let model = optional_identifier(object, "model")?;
    let account_id = optional_identifier(object, "account_id")?;
    let active = crate::pi_config::current();
    query_usage(
        &provider,
        model.as_deref(),
        account_id.as_deref(),
        &active,
        false,
    )
    .await
}

fn object_arguments(arguments: &Value) -> Result<&Map<String, Value>> {
    arguments
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("usage tool arguments must be a JSON object"))
}

fn reject_unknown_keys(object: &Map<String, Value>, allowed: &[&str]) -> Result<()> {
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(anyhow::anyhow!("unknown usage tool argument '{key}'"));
    }
    Ok(())
}

fn required_identifier(object: &Map<String, Value>, key: &str) -> Result<String> {
    let value = object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("usage.query requires a string '{key}'"))?;
    bounded_identifier(value, key)
}

fn optional_identifier(object: &Map<String, Value>, key: &str) -> Result<Option<String>> {
    match object.get(key) {
        None => Ok(None),
        Some(value) => value
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("usage.query '{key}' must be a string"))
            .and_then(|value| bounded_identifier(value, key))
            .map(Some),
    }
}

fn bounded_identifier(value: &str, label: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(anyhow::anyhow!("usage tool requires a non-empty {label}"));
    }
    if value.chars().count() > MAX_IDENTIFIER_CHARS {
        return Err(anyhow::anyhow!(
            "usage tool {label} exceeds {MAX_IDENTIFIER_CHARS} characters"
        ));
    }
    Ok(value.to_owned())
}

async fn query_usage(
    provider: &str,
    model: Option<&str>,
    account_id: Option<&str>,
    active: &crate::pi_config::PiConfigView,
    is_current: bool,
) -> Result<Value> {
    let (reading, source) = read_provider_usage(provider, model, account_id).await;
    let usage = serde_json::to_value(reading.without_label())
        .context("could not serialize provider usage reading")?;
    Ok(json!({
        "ok": true,
        "current": is_current,
        "active": {
            "provider": active.provider.clone(),
            "model": active.model.clone(),
            "routing": active.routing.clone(),
        },
        "requested": {
            "provider": provider,
            "model": model,
            "account_id": account_id,
        },
        "source": source,
        "usage": usage,
    }))
}

/// How a query reaches its reader.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReadRoute<'a> {
    /// The shared subscription reading for one account selection.
    Shared(AccountSel<'a>),
    /// A provider the subscription module does not model (for example an
    /// OAuth-capable BYOK login): the provider-wide reader, as before.
    ProviderWide,
}

/// Select the reader without letting a model choose a secret. An explicit
/// `account_id` always takes the shared `Exact` path, which reads that saved
/// account's own credential or reports `account_not_found`/`unsupported`; it
/// never touches the active credential.
fn read_route(kind: Option<ProviderKind>, account_id: Option<&str>) -> ReadRoute<'_> {
    match (account_id, kind) {
        (Some(account_id), _) => ReadRoute::Shared(AccountSel::Exact(account_id)),
        (None, Some(_)) => ReadRoute::Shared(AccountSel::Active),
        (None, None) => ReadRoute::ProviderWide,
    }
}

async fn read_provider_usage(
    provider: &str,
    model: Option<&str>,
    account_id: Option<&str>,
) -> (ProviderUsageReading, &'static str) {
    let kind = subscriptions::provider_kind(provider);
    match read_route(kind, account_id) {
        ReadRoute::Shared(selection) => {
            let reading = reading::read_with(
                provider,
                selection,
                ReadOptions {
                    mode: UsageMode::Refresh,
                    max_age: subscriptions::DEFAULT_MAX_AGE,
                    model,
                    include_label: false,
                },
            )
            .await;
            let source = match kind {
                Some(ProviderKind::ApiCredits) => "api_credits",
                Some(ProviderKind::Subscription) => "subscription",
                _ if reading.engine.is_empty() => "unavailable",
                _ => "subscription",
            };
            (reading, source)
        }
        ReadRoute::ProviderWide => {
            let (snapshot, source) = provider_wide_snapshot(provider).await;
            (
                reading::reading_from_snapshot(provider, None, &snapshot, model),
                source,
            )
        }
    }
}

/// Providers outside the subscription module keep their provider-wide reader.
/// A vault read failure is the same structured `not_logged_in` snapshot as the
/// HTTP usage route; it never returns the credential or an internal error.
async fn provider_wide_snapshot(provider: &str) -> (ryu_usage::UsageSnapshot, &'static str) {
    if crate::pi_config::oauth_login::oauth_provider_id(provider).is_some() {
        let credential = crate::pi_config::subscription_active_credential(provider).unwrap_or(None);
        let snapshot =
            ryu_usage::fetch_ryu_provider_usage_for_credential(provider, credential).await;
        return (snapshot, "subscription");
    }
    let snapshot = ryu_usage::fetch_ryu_provider_usage(provider).await;
    let source = if snapshot.engine.is_empty() {
        "unavailable"
    } else {
        "subscription"
    };
    (snapshot, source)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_usage_tools_with_read_only_annotations() {
        let tools = tools();
        assert_eq!(tools.len(), 3);
        assert_eq!(tools[0].id, CURRENT_TOOL_ID);
        assert_eq!(tools[1].id, QUERY_TOOL_ID);
        assert_eq!(tools[0].annotations, Some(read_only_annotations()));
        assert_eq!(tools[2].id, PROVIDERS_TOOL_ID);
        assert_eq!(tools[2].annotations, Some(read_only_annotations()));
        let query = tools[1].input_schema.as_ref().expect("query schema");
        assert_eq!(query["required"], json!(["provider"]));
        assert_eq!(query["additionalProperties"], false);
        assert_eq!(query["properties"]["account_id"]["minLength"], 1);
        assert_eq!(
            query["properties"]["account_id"]["maxLength"],
            MAX_IDENTIFIER_CHARS
        );
    }

    #[test]
    fn projection_is_shared_with_the_subscription_module() {
        // The projection moved to `subscriptions::projection`; persisted monitor
        // baselines depend on these ids staying byte-identical through the tool.
        let raw = json!({
            "available": true,
            "windows": [{ "label": "Session", "used_percent": 42.5, "window_seconds": 18_000 }],
            "meters": [{
                "label": "API credit",
                "values": [{ "number": 12.34, "kind": "dollars", "unit": null }],
                "expires_at": []
            }]
        });
        let projected = subscriptions::projection::project_snapshot("claude-pro-max", &raw, None);
        assert_eq!(projected["windows"][0]["targetId"], "window:Session::18000");
        assert_eq!(
            projected["meters"][0]["values"][0]["targetId"],
            "meter:API credit:dollars:"
        );
    }

    #[test]
    fn account_scoped_reads_never_use_the_active_credential_route() {
        // An explicit account always takes the shared `Exact` path, which reads
        // only that account's own credential; only an unscoped query on a
        // provider the subscription module does not model reaches the
        // provider-wide reader (the one that resolves the active credential).
        for kind in [
            None,
            Some(ProviderKind::Subscription),
            Some(ProviderKind::ApiCredits),
            Some(ProviderKind::AgentLogin),
        ] {
            assert_eq!(
                read_route(kind, Some("acct_x")),
                ReadRoute::Shared(AccountSel::Exact("acct_x"))
            );
        }
        assert_eq!(
            read_route(Some(ProviderKind::Subscription), None),
            ReadRoute::Shared(AccountSel::Active)
        );
        assert_eq!(read_route(None, None), ReadRoute::ProviderWide);
    }

    #[tokio::test]
    async fn unknown_account_reads_account_not_found_without_falling_back() {
        let result = dispatch(
            "query",
            json!({ "provider": "claude-pro-max", "account_id": "acct_does-not-exist" }),
        )
        .await
        .expect("an unknown account is a structured usage result");
        assert_eq!(result["requested"]["account_id"], "acct_does-not-exist");
        assert_eq!(result["usage"]["available"], false);
        assert_eq!(result["usage"]["reason"], "account_not_found");
        assert_eq!(result["usage"]["accountId"], Value::Null);
        assert_eq!(result["usage"]["accountLabel"], Value::Null);
        assert_eq!(result["usage"]["windows"], json!([]));
    }

    #[tokio::test]
    async fn agent_login_with_an_account_is_unsupported() {
        let result = dispatch(
            "query",
            json!({ "provider": "acp:claude", "account_id": "acct_any" }),
        )
        .await
        .expect("structured usage result");
        assert_eq!(result["usage"]["available"], false);
        assert_eq!(result["usage"]["reason"], "unsupported");
        assert_eq!(result["usage"]["accountId"], Value::Null);
    }

    #[tokio::test]
    async fn providers_catalog_lists_accounts_without_labels() {
        let catalog = dispatch("providers", json!({}))
            .await
            .expect("provider catalog");
        let providers = catalog["providers"].as_array().expect("provider list");
        let ids = providers
            .iter()
            .filter_map(|provider| provider.get("providerId").and_then(Value::as_str))
            .collect::<Vec<_>>();
        for expected in [
            "acp:claude",
            "acp:codex",
            "acp:copilot",
            "acp:grok",
            "acp:glm",
            "openai-codex",
            "chatgpt",
            "claude-pro-max",
            "github-copilot",
            "openrouter",
            "deepseek",
            "moonshot",
        ] {
            assert!(ids.contains(&expected), "missing {expected}");
        }
        assert!(!ids.contains(&"anthropic"));
        assert!(!ids.contains(&"openai"));
        for provider in providers {
            let kind = provider["kind"].as_str().expect("kind");
            assert!(matches!(kind, "subscription" | "api_credits"), "{kind}");
            assert!(provider["capabilities"]["accountUsage"].is_boolean());
            for account in provider["accounts"].as_array().expect("accounts") {
                let keys = account.as_object().expect("account row");
                assert!(!keys.contains_key("label"), "account label leaked");
                assert!(!keys.contains_key("accountLabel"), "account label leaked");
            }
        }
        let claude = providers
            .iter()
            .find(|provider| provider["providerId"] == "claude-pro-max")
            .expect("claude-pro-max");
        assert_eq!(claude["capabilities"]["accountUsage"], true);
    }

    #[test]
    fn catalog_account_rows_have_no_label_field() {
        let row = catalog_account("acct_1", true, "oauth", false);
        assert_eq!(
            row,
            json!({
                "accountId": "acct_1",
                "active": true,
                "kind": "oauth",
                "needsReauth": false,
            })
        );
    }

    #[tokio::test]
    async fn query_rejects_bad_arguments_before_reading_provider_state() {
        assert!(dispatch("query", json!({})).await.is_err());
        assert!(dispatch("query", json!({ "provider": " " })).await.is_err());
        assert!(dispatch("query", json!({ "provider": "x", "extra": true }))
            .await
            .is_err());
        assert!(dispatch(
            "query",
            json!({ "provider": "x", "account_id": "a", "accountId": "a" })
        )
        .await
        .is_err());
        assert!(
            dispatch("query", json!({ "provider": "x", "account_id": "" }))
                .await
                .is_err()
        );
        assert!(
            dispatch("query", json!({ "provider": "x", "account_id": 7 }))
                .await
                .is_err()
        );
        assert!(dispatch(
            "query",
            json!({ "provider": "x", "account_id": "a".repeat(MAX_IDENTIFIER_CHARS + 1) })
        )
        .await
        .is_err());
        assert!(dispatch("current", json!({ "provider": "x" }))
            .await
            .is_err());
        assert!(dispatch("current", json!({ "account_id": "a" }))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn unknown_provider_returns_structured_unavailable_usage() {
        let result = dispatch(
            "query",
            json!({ "provider": "definitely-not-a-provider", "model": "anything" }),
        )
        .await
        .expect("unknown providers are a structured usage result");
        assert_eq!(result["ok"], true);
        assert_eq!(result["usage"]["available"], false);
        assert_eq!(result["usage"]["reason"], "unsupported");
        assert_eq!(result["usage"]["windows"], json!([]));
        assert_eq!(result["usage"]["accountLabel"], Value::Null);
        assert_eq!(result["requested"]["model"], "anything");
        assert_eq!(result["requested"]["account_id"], Value::Null);
    }
}
