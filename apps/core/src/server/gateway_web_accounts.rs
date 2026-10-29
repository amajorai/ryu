//! Protected authored configuration editor for direct web-service accounts.
//!
//! This module owns only `[providers.web]` and its corresponding rows in the
//! existing `accountPolicies` map. It never reads environment/fleet sources,
//! returns secret material, or performs HTTP/audit/process work while the
//! authored-file transaction is held.

use std::collections::BTreeMap;

use axum::{
    extract::{Json, State},
    http::StatusCode,
    Extension,
};
use ryu_gw_credentials::web::{
    WebAccountConfig, WebAccountContext, WebProviderConfig, WebProviderKind,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::ServerState;

const WEB_ACCOUNTS_FIELD: &str = "web";

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum WebAccountAction {
    Add,
    Anonymous,
    Clear,
    Configure,
    Context,
    Remove,
    Replace,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WebAccountWriteBody {
    action: WebAccountAction,
    api_key: Option<String>,
    account_id: Option<String>,
    account_policy: Option<ryu_gw_credentials::ProviderAccountPolicy>,
    context: Option<WebAccountContext>,
    expected_revision: Option<ryu_gw_credentials::ConfigRevision>,
    provider: WebProviderKind,
}

fn response(status: StatusCode, error: impl Into<String>) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(json!({ "success": false, "error": error.into() })),
    )
}

fn provider_id(provider: WebProviderKind) -> &'static str {
    provider.descriptor().provider_id
}

fn read_web_config(
    providers: &toml::map::Map<String, toml::Value>,
) -> Result<BTreeMap<WebProviderKind, WebProviderConfig>, String> {
    match providers.get(WEB_ACCOUNTS_FIELD) {
        None => Ok(BTreeMap::new()),
        Some(value) => value
            .clone()
            .try_into()
            .map_err(|_| "web provider configuration is invalid".to_owned()),
    }
}

fn write_web_config(
    providers: &mut toml::map::Map<String, toml::Value>,
    web: &BTreeMap<WebProviderKind, WebProviderConfig>,
) -> Result<(), String> {
    if web.is_empty() {
        providers.remove(WEB_ACCOUNTS_FIELD);
        return Ok(());
    }
    let value = toml::Value::try_from(web.clone())
        .map_err(|_| "web provider configuration could not be encoded".to_owned())?;
    providers.insert(WEB_ACCOUNTS_FIELD.to_owned(), value);
    Ok(())
}

fn web_account_index(
    provider: WebProviderKind,
    accounts: &[WebAccountConfig],
    account_id: &str,
) -> Result<usize, String> {
    accounts
        .iter()
        .position(|account| account.account_id(provider).ok().as_deref() == Some(account_id))
        .ok_or_else(|| "account no longer exists; refresh the account list".to_owned())
}

fn normalized_account(
    provider: WebProviderKind,
    api_key: Option<String>,
    context: Option<WebAccountContext>,
) -> Result<WebAccountConfig, String> {
    let api_key = api_key.ok_or_else(|| "apiKey is required".to_owned())?;
    WebAccountConfig::new(api_key, context.unwrap_or_default())
        .and_then(|account| {
            account.validate_for(provider)?;
            Ok(account)
        })
        .map_err(|error| error.to_string())
}

fn policy_for(
    providers: &toml::map::Map<String, toml::Value>,
    provider: &str,
    account_id: &str,
) -> Option<toml::Value> {
    providers
        .get("accountPolicies")
        .and_then(toml::Value::as_table)
        .and_then(|table| table.get(provider))
        .and_then(toml::Value::as_table)
        .and_then(|policies| policies.get(account_id))
        .cloned()
}

fn set_policy(
    providers: &mut toml::map::Map<String, toml::Value>,
    provider: &str,
    account_id: &str,
    policy: ryu_gw_credentials::ProviderAccountPolicy,
) -> Result<(), String> {
    let policy = policy.normalized()?;
    let policies = providers
        .entry("accountPolicies".to_owned())
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()))
        .as_table_mut()
        .ok_or_else(|| "accountPolicies must be a table".to_owned())?
        .entry(provider.to_owned())
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()))
        .as_table_mut()
        .ok_or_else(|| "provider account policies must be a table".to_owned())?;
    policies.insert(
        account_id.to_owned(),
        toml::Value::try_from(policy)
            .map_err(|error| format!("account policy could not be encoded: {error}"))?,
    );
    Ok(())
}

fn remove_policy(
    providers: &mut toml::map::Map<String, toml::Value>,
    provider: &str,
    account_id: &str,
) {
    if let Some(policies) = providers
        .get_mut("accountPolicies")
        .and_then(toml::Value::as_table_mut)
        .and_then(|table| table.get_mut(provider))
        .and_then(toml::Value::as_table_mut)
    {
        policies.remove(account_id);
    }
}

fn carry_policy(
    providers: &mut toml::map::Map<String, toml::Value>,
    provider: &str,
    old_id: &str,
    new_id: &str,
) -> Result<(), String> {
    if old_id == new_id {
        return Ok(());
    }
    let Some(policy) = policy_for(providers, provider, old_id) else {
        return Ok(());
    };
    if policy_for(providers, provider, new_id).is_some() {
        return Err("replacement account identity already has a policy".to_owned());
    }
    remove_policy(providers, provider, old_id);
    let policies = providers
        .get_mut("accountPolicies")
        .and_then(toml::Value::as_table_mut)
        .and_then(|table| table.get_mut(provider))
        .and_then(toml::Value::as_table_mut)
        .expect("existing replacement policy table");
    policies.insert(new_id.to_owned(), policy);
    Ok(())
}

fn mutate_web_accounts(
    providers: &mut toml::map::Map<String, toml::Value>,
    body: &WebAccountWriteBody,
) -> Result<(), String> {
    let provider = body.provider;
    let provider_id = provider_id(provider);
    let mut web = read_web_config(providers)?;

    match body.action {
        WebAccountAction::Anonymous => {
            if body.api_key.is_some() || body.account_id.is_some() || body.context.is_some() {
                return Err(
                    "anonymous configuration does not accept account material or context"
                        .to_owned(),
                );
            }
            if body.account_policy.is_some() {
                return Err("anonymous configuration has no account policy".to_owned());
            }
            web.insert(
                provider,
                WebProviderConfig::anonymous(provider).map_err(|error| error.to_string())?,
            );
            providers
                .get_mut("accountPolicies")
                .and_then(toml::Value::as_table_mut)
                .map(|policies| policies.remove(provider_id));
        }
        WebAccountAction::Clear => {
            if body.api_key.is_some()
                || body.account_id.is_some()
                || body.context.is_some()
                || body.account_policy.is_some()
            {
                return Err("clear does not accept account material, context, or policy".to_owned());
            }
            web.remove(&provider);
            providers
                .get_mut("accountPolicies")
                .and_then(toml::Value::as_table_mut)
                .map(|policies| policies.remove(provider_id));
        }
        WebAccountAction::Add => {
            if body.account_id.is_some() || body.account_policy.is_some() {
                return Err(
                    "adding an account does not accept accountId or accountPolicy".to_owned(),
                );
            }
            let account = normalized_account(provider, body.api_key.clone(), body.context.clone())?;
            let entry = web
                .entry(provider)
                .or_insert_with(|| WebProviderConfig::Accounts {
                    accounts: Vec::new(),
                });
            match entry {
                WebProviderConfig::Accounts { accounts } => accounts.push(account),
                WebProviderConfig::Anonymous {} => {
                    *entry = WebProviderConfig::Accounts {
                        accounts: vec![account],
                    };
                }
            }
            entry
                .validate_for(provider)
                .map_err(|error| error.to_string())?;
        }
        WebAccountAction::Replace => {
            if body.account_policy.is_some() {
                return Err("replacement cannot include accountPolicy".to_owned());
            }
            let account_id = body
                .account_id
                .as_deref()
                .ok_or_else(|| "accountId is required".to_owned())?;
            let account = normalized_account(provider, body.api_key.clone(), body.context.clone())?;
            let entry = web
                .get_mut(&provider)
                .ok_or_else(|| "provider has no stored web accounts".to_owned())?;
            let WebProviderConfig::Accounts { accounts } = entry else {
                return Err(
                    "anonymous provider configuration has no replaceable account".to_owned(),
                );
            };
            let index = web_account_index(provider, accounts, account_id)?;
            let new_id = account
                .account_id(provider)
                .map_err(|error| error.to_string())?;
            if accounts.iter().enumerate().any(|(existing, current)| {
                existing != index
                    && current.account_id(provider).ok().as_deref() == Some(new_id.as_str())
            }) {
                return Err("duplicate web credential and execution context".to_owned());
            }
            accounts[index] = account;
            entry
                .validate_for(provider)
                .map_err(|error| error.to_string())?;
            carry_policy(providers, provider_id, account_id, &new_id)?;
        }
        WebAccountAction::Remove => {
            if body.api_key.is_some() || body.context.is_some() || body.account_policy.is_some() {
                return Err(
                    "removal does not accept account material, context, or policy".to_owned(),
                );
            }
            let account_id = body
                .account_id
                .as_deref()
                .ok_or_else(|| "accountId is required".to_owned())?;
            let remove_provider = {
                let entry = web
                    .get_mut(&provider)
                    .ok_or_else(|| "provider has no stored web accounts".to_owned())?;
                let WebProviderConfig::Accounts { accounts } = entry else {
                    return Err(
                        "anonymous provider configuration has no removable account".to_owned()
                    );
                };
                let index = web_account_index(provider, accounts, account_id)?;
                accounts.remove(index);
                accounts.is_empty()
            };
            if remove_provider {
                web.remove(&provider);
            }
            remove_policy(providers, provider_id, account_id);
        }
        WebAccountAction::Configure => {
            if body.api_key.is_some() || body.context.is_some() {
                return Err(
                    "account configuration accepts accountId and accountPolicy only".to_owned(),
                );
            }
            let account_id = body
                .account_id
                .as_deref()
                .ok_or_else(|| "accountId is required".to_owned())?;
            let policy = body
                .account_policy
                .clone()
                .ok_or_else(|| "accountPolicy is required".to_owned())?;
            let accounts = web
                .get(&provider)
                .ok_or_else(|| "provider has no stored web accounts".to_owned())?
                .accounts();
            web_account_index(provider, accounts, account_id)?;
            set_policy(providers, provider_id, account_id, policy)?;
        }
        WebAccountAction::Context => {
            if body.api_key.is_some() || body.account_policy.is_some() {
                return Err("context update accepts accountId and context only".to_owned());
            }
            let account_id = body
                .account_id
                .as_deref()
                .ok_or_else(|| "accountId is required".to_owned())?;
            let context = body
                .context
                .clone()
                .ok_or_else(|| "context is required".to_owned())?;
            let entry = web
                .get_mut(&provider)
                .ok_or_else(|| "provider has no stored web accounts".to_owned())?;
            let WebProviderConfig::Accounts { accounts } = entry else {
                return Err("anonymous provider configuration has no updatable account".to_owned());
            };
            let index = web_account_index(provider, accounts, account_id)?;
            let replacement = WebAccountConfig::new(accounts[index].api_key().to_owned(), context)
                .and_then(|account| {
                    account.validate_for(provider)?;
                    Ok(account)
                })
                .map_err(|error| error.to_string())?;
            let replacement_id = replacement
                .account_id(provider)
                .map_err(|error| error.to_string())?;
            if accounts.iter().enumerate().any(|(existing, account)| {
                existing != index
                    && account.account_id(provider).ok().as_deref() == Some(replacement_id.as_str())
            }) {
                return Err("duplicate web credential and execution context".to_owned());
            }
            accounts[index] = replacement;
            entry
                .validate_for(provider)
                .map_err(|error| error.to_string())?;
            carry_policy(providers, provider_id, account_id, &replacement_id)?;
        }
    }

    write_web_config(providers, &web)
}

pub(super) async fn gateway_web_accounts_get(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> (StatusCode, Json<Value>) {
    if super::enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::GATEWAY_VIEW,
    )
    .await
    .is_err()
    {
        return response(
            StatusCode::FORBIDDEN,
            "insufficient permissions: gateway.view",
        );
    }
    let Some(path) = super::gateway_config_path() else {
        return response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot determine gateway config path",
        );
    };
    let read = tokio::task::spawn_blocking(move || {
        let transaction = ryu_gw_credentials::ConfigFileTransaction::acquire(&path)?;
        let root = super::gateway_config_document(&transaction)
            .map_err(|_| ryu_gw_credentials::ConfigCommitError::InvalidFile)?;
        Ok::<_, ryu_gw_credentials::ConfigCommitError>((
            transaction.snapshot().revision().clone(),
            root,
        ))
    })
    .await;
    let Ok(Ok((revision, root))) = read else {
        return response(
            StatusCode::BAD_GATEWAY,
            "gateway configuration is unavailable",
        );
    };
    let providers = root
        .get("providers")
        .and_then(toml::Value::as_table)
        .cloned()
        .unwrap_or_default();
    let web = match read_web_config(&providers) {
        Ok(web) => web,
        Err(error) => return response(StatusCode::BAD_REQUEST, error),
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let rows = web
        .iter()
        .map(|(provider, config)| {
            let metadata = config
                .safe_account_metadata(*provider, now)
                .map_err(|error| error.to_string())?;
            let accounts = config
                .accounts()
                .iter()
                .zip(metadata)
                .map(|(account_config, account)| {
                    let context = account_config.context().clone();
                    let policy = policy_for(
                        &providers,
                        provider.descriptor().provider_id,
                        &account.account_id,
                    )
                    .and_then(|value| {
                        let policy: Result<ryu_gw_credentials::ProviderAccountPolicy, _> =
                            value.try_into();
                        policy.ok()
                    })
                    .unwrap_or_default();
                    json!({
                        "accountId": account.account_id,
                        "context": context,
                        "contextKind": account.context_kind,
                        "diagnostic": account.diagnostic,
                        "policy": policy,
                    })
                })
                .collect::<Vec<_>>();
            Ok::<_, String>(json!({
                "provider": provider.descriptor().provider_id,
                "anonymous": config.is_anonymous(),
                "accounts": accounts,
            }))
        })
        .collect::<Result<Vec<_>, _>>();
    match rows {
        Ok(rows) => (
            StatusCode::OK,
            Json(json!({
                "webServiceSchema": 1,
                "configRevision": revision,
                "providers": rows,
            })),
        ),
        Err(error) => response(StatusCode::BAD_REQUEST, error),
    }
}

pub(super) async fn gateway_web_accounts_put(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<WebAccountWriteBody>,
) -> (StatusCode, Json<Value>) {
    if super::enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::GATEWAY_CONFIGURE,
    )
    .await
    .is_err()
    {
        return response(
            StatusCode::FORBIDDEN,
            "insufficient permissions: gateway.configure",
        );
    }
    let Some(path) = super::gateway_config_path() else {
        return response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot determine gateway config path",
        );
    };
    let mut transaction = match tokio::task::spawn_blocking(move || {
        ryu_gw_credentials::ConfigFileTransaction::acquire(&path)
    })
    .await
    {
        Ok(Ok(transaction)) => transaction,
        Ok(Err(error)) => return super::gateway_config_transaction_error(error),
        Err(_) => {
            return response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "gateway configuration transaction could not start",
            );
        }
    };
    let revision = transaction.snapshot().revision().clone();
    if body
        .expected_revision
        .as_ref()
        .is_some_and(|expected| expected != &revision)
    {
        return super::gateway_config_transaction_error(
            ryu_gw_credentials::ConfigCommitError::Conflict {
                current_revision: revision,
            },
        );
    }
    let mut root = match super::gateway_config_document(&transaction) {
        Ok(root) => root,
        Err(error) => return response(StatusCode::INTERNAL_SERVER_ERROR, error),
    };
    let Some(root_table) = root.as_table_mut() else {
        return response(
            StatusCode::BAD_REQUEST,
            "gateway configuration root must be a table",
        );
    };
    let provider_value = root_table
        .entry("providers")
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
    let Some(providers) = provider_value.as_table_mut() else {
        return response(StatusCode::BAD_REQUEST, "providers must be a table");
    };
    if let Err(error) = mutate_web_accounts(providers, &body) {
        let status = if error == "account no longer exists; refresh the account list" {
            StatusCode::CONFLICT
        } else {
            StatusCode::BAD_REQUEST
        };
        return response(status, error);
    }
    let bytes = match toml::to_string_pretty(&root) {
        Ok(text) => text.into_bytes(),
        Err(_) => {
            return response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "gateway configuration could not be encoded",
            );
        }
    };
    let config_revision =
        match tokio::task::spawn_blocking(move || transaction.commit(&revision, &bytes)).await {
            Ok(Ok(revision)) => revision,
            Ok(Err(error)) => return super::gateway_config_transaction_error(error),
            Err(_) => {
                return response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "gateway configuration transaction could not finish",
                );
            }
        };
    // Commit precedes audit and live application. The provider runtime applies
    // exactly this revision and returns its own scoped receipt.
    super::record_gateway_control(
        &state,
        "gateway.web_account.update",
        "gateway_web_account",
        Some(provider_id(body.provider)),
        &caller,
    )
    .await;
    let application = state
        .gateway
        .apply_provider_revision(&config_revision)
        .await;
    (
        StatusCode::OK,
        Json(json!({
            "success": true,
            "persisted": true,
            "configRevision": config_revision,
            "provider": provider_id(body.provider),
            "gateway_application": application,
        })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(provider: WebProviderKind, action: WebAccountAction) -> WebAccountWriteBody {
        WebAccountWriteBody {
            action,
            api_key: None,
            account_id: None,
            account_policy: None,
            context: None,
            expected_revision: None,
            provider,
        }
    }

    #[test]
    fn targeted_replace_preserves_order_and_carries_google_policy() {
        let provider = WebProviderKind::GooglePse;
        let first = WebAccountConfig::new(
            "first-key".to_owned(),
            WebAccountContext::GooglePse {
                engine_id: "first-engine".to_owned(),
                existing_customer_acknowledged: true,
            },
        )
        .unwrap();
        let second = WebAccountConfig::new(
            "second-key".to_owned(),
            WebAccountContext::GooglePse {
                engine_id: "second-engine".to_owned(),
                existing_customer_acknowledged: true,
            },
        )
        .unwrap();
        let first_id = first.account_id(provider).unwrap();
        let second_id = second.account_id(provider).unwrap();
        let mut providers = toml::map::Map::new();
        write_web_config(
            &mut providers,
            &BTreeMap::from([(
                provider,
                WebProviderConfig::new_accounts(provider, vec![first, second]).unwrap(),
            )]),
        )
        .unwrap();
        set_policy(
            &mut providers,
            provider_id(provider),
            &second_id,
            ryu_gw_credentials::ProviderAccountPolicy {
                drain_threshold_percent: None,
                name: "Second".to_owned(),
                enabled: false,
                priority: 4,
            },
        )
        .unwrap();

        let mut replacement = body(provider, WebAccountAction::Replace);
        replacement.account_id = Some(second_id);
        replacement.api_key = Some("replacement-key".to_owned());
        replacement.context = Some(WebAccountContext::GooglePse {
            engine_id: "replacement-engine".to_owned(),
            existing_customer_acknowledged: true,
        });
        mutate_web_accounts(&mut providers, &replacement).unwrap();

        let accounts = read_web_config(&providers).unwrap();
        let keys = accounts[&provider].accounts();
        assert_eq!(keys[0].account_id(provider).unwrap(), first_id);
        let replacement_id = keys[1].account_id(provider).unwrap();
        assert_eq!(
            policy_for(&providers, provider_id(provider), &replacement_id).unwrap()["name"]
                .as_str(),
            Some("Second")
        );
    }

    #[test]
    fn anonymous_jina_is_explicit_and_never_has_an_account_policy() {
        let provider = WebProviderKind::JinaReader;
        let mut providers = toml::map::Map::new();
        mutate_web_accounts(&mut providers, &body(provider, WebAccountAction::Anonymous)).unwrap();
        let web = read_web_config(&providers).unwrap();
        assert!(web[&provider].is_anonymous());
        assert!(web[&provider].accounts().is_empty());
        assert!(policy_for(&providers, provider_id(provider), "anything").is_none());
    }

    #[test]
    fn anonymous_configuration_is_rejected_for_keyed_providers() {
        let mut providers = toml::map::Map::new();
        assert!(mutate_web_accounts(
            &mut providers,
            &body(WebProviderKind::Tavily, WebAccountAction::Anonymous),
        )
        .is_err());
    }

    #[test]
    fn clear_removes_anonymous_jina_without_accepting_credentials() {
        let provider = WebProviderKind::JinaReader;
        let mut providers = toml::map::Map::new();
        mutate_web_accounts(&mut providers, &body(provider, WebAccountAction::Anonymous)).unwrap();
        mutate_web_accounts(&mut providers, &body(provider, WebAccountAction::Clear)).unwrap();
        assert!(read_web_config(&providers)
            .unwrap()
            .get(&provider)
            .is_none());

        let mut invalid = body(provider, WebAccountAction::Clear);
        invalid.api_key = Some("must-not-be-accepted".to_owned());
        assert!(mutate_web_accounts(&mut providers, &invalid).is_err());
    }

    #[test]
    fn add_atomically_transitions_anonymous_jina_to_a_keyed_account() {
        let provider = WebProviderKind::JinaReader;
        let mut providers = toml::map::Map::new();
        mutate_web_accounts(&mut providers, &body(provider, WebAccountAction::Anonymous)).unwrap();
        mutate_web_accounts(
            &mut providers,
            &WebAccountWriteBody {
                api_key: Some("jina-key".to_owned()),
                ..body(provider, WebAccountAction::Add)
            },
        )
        .unwrap();
        let config = &read_web_config(&providers).unwrap()[&provider];
        assert!(!config.is_anonymous());
        assert_eq!(config.accounts().len(), 1);
    }

    #[test]
    fn malformed_authored_web_config_does_not_echo_credential_material() {
        let mut providers = toml::map::Map::new();
        providers.insert(
            WEB_ACCOUNTS_FIELD.to_owned(),
            toml::Value::Table(toml::map::Map::from_iter([(
                "tavily".to_owned(),
                toml::Value::Table(toml::map::Map::from_iter([
                    (
                        "mode".to_owned(),
                        toml::Value::String("accounts".to_owned()),
                    ),
                    (
                        "accounts".to_owned(),
                        toml::Value::Array(vec![toml::Value::Table(toml::map::Map::from_iter([
                            (
                                "api_key".to_owned(),
                                toml::Value::String("web-secret-marker".to_owned()),
                            ),
                            ("unexpected".to_owned(), toml::Value::Boolean(true)),
                        ]))]),
                    ),
                ])),
            )])),
        );

        let error = read_web_config(&providers).unwrap_err();
        assert_eq!(error, "web provider configuration is invalid");
        assert!(!error.contains("web-secret-marker"));
    }

    #[test]
    fn configure_and_anonymous_reject_cross_field_credentials() {
        let provider = WebProviderKind::JinaReader;
        let mut providers = toml::map::Map::new();

        let mut anonymous = body(provider, WebAccountAction::Anonymous);
        anonymous.context = Some(WebAccountContext::Default);
        assert!(mutate_web_accounts(&mut providers, &anonymous).is_err());

        let account =
            WebAccountConfig::new("stored-key".to_owned(), WebAccountContext::Default).unwrap();
        let account_id = account.account_id(provider).unwrap();
        write_web_config(
            &mut providers,
            &BTreeMap::from([(
                provider,
                WebProviderConfig::new_accounts(provider, vec![account]).unwrap(),
            )]),
        )
        .unwrap();
        let mut configure = body(provider, WebAccountAction::Configure);
        configure.account_id = Some(account_id);
        configure.api_key = Some("must-not-be-accepted".to_owned());
        configure.account_policy = Some(Default::default());
        assert!(mutate_web_accounts(&mut providers, &configure).is_err());
    }

    #[test]
    fn remove_requires_a_current_stable_account_id() {
        let provider = WebProviderKind::Tavily;
        let mut providers = toml::map::Map::new();
        mutate_web_accounts(
            &mut providers,
            &WebAccountWriteBody {
                api_key: Some("stored-key".to_owned()),
                ..body(provider, WebAccountAction::Add)
            },
        )
        .unwrap();
        let mut remove = body(provider, WebAccountAction::Remove);
        remove.account_id = Some("stale-account-id".to_owned());
        assert_eq!(
            mutate_web_accounts(&mut providers, &remove).unwrap_err(),
            "account no longer exists; refresh the account list"
        );
    }

    #[test]
    fn context_acknowledgement_updates_google_without_retyping_the_key() {
        let provider = WebProviderKind::GooglePse;
        let account = WebAccountConfig::new(
            "google-key".to_owned(),
            WebAccountContext::GooglePse {
                engine_id: "engine".to_owned(),
                existing_customer_acknowledged: false,
            },
        )
        .unwrap();
        let account_id = account.account_id(provider).unwrap();
        let mut providers = toml::map::Map::new();
        write_web_config(
            &mut providers,
            &BTreeMap::from([(
                provider,
                WebProviderConfig::new_accounts(provider, vec![account]).unwrap(),
            )]),
        )
        .unwrap();
        set_policy(
            &mut providers,
            provider_id(provider),
            &account_id,
            ryu_gw_credentials::ProviderAccountPolicy {
                drain_threshold_percent: None,
                name: "Google".to_owned(),
                enabled: true,
                priority: 3,
            },
        )
        .unwrap();

        let mut update = body(provider, WebAccountAction::Context);
        update.account_id = Some(account_id.clone());
        update.context = Some(WebAccountContext::GooglePse {
            engine_id: "engine".to_owned(),
            existing_customer_acknowledged: true,
        });
        mutate_web_accounts(&mut providers, &update).unwrap();

        let updated_connections = read_web_config(&providers).unwrap();
        let updated = &updated_connections[&provider].accounts()[0];
        assert_eq!(updated.account_id(provider).unwrap(), account_id);
        assert_eq!(updated.api_key(), "google-key");
        assert_eq!(
            policy_for(&providers, provider_id(provider), &account_id).unwrap()["name"].as_str(),
            Some("Google")
        );
    }

    #[test]
    fn context_retarget_carries_policy_and_rejects_duplicate_or_stale_target() {
        let provider = WebProviderKind::GooglePse;
        let first = WebAccountConfig::new(
            "shared-key".to_owned(),
            WebAccountContext::GooglePse {
                engine_id: "first".to_owned(),
                existing_customer_acknowledged: true,
            },
        )
        .unwrap();
        let second = WebAccountConfig::new(
            "shared-key".to_owned(),
            WebAccountContext::GooglePse {
                engine_id: "second".to_owned(),
                existing_customer_acknowledged: true,
            },
        )
        .unwrap();
        let first_id = first.account_id(provider).unwrap();
        let second_id = second.account_id(provider).unwrap();
        let mut providers = toml::map::Map::new();
        write_web_config(
            &mut providers,
            &BTreeMap::from([(
                provider,
                WebProviderConfig::new_accounts(provider, vec![first, second]).unwrap(),
            )]),
        )
        .unwrap();
        set_policy(
            &mut providers,
            provider_id(provider),
            &first_id,
            ryu_gw_credentials::ProviderAccountPolicy {
                drain_threshold_percent: None,
                name: "First".to_owned(),
                enabled: true,
                priority: 1,
            },
        )
        .unwrap();

        let mut duplicate = body(provider, WebAccountAction::Context);
        duplicate.account_id = Some(first_id.clone());
        duplicate.context = Some(WebAccountContext::GooglePse {
            engine_id: "second".to_owned(),
            existing_customer_acknowledged: true,
        });
        assert!(mutate_web_accounts(&mut providers, &duplicate).is_err());

        let mut retarget = body(provider, WebAccountAction::Context);
        retarget.account_id = Some(first_id.clone());
        retarget.context = Some(WebAccountContext::GooglePse {
            engine_id: "third".to_owned(),
            existing_customer_acknowledged: true,
        });
        mutate_web_accounts(&mut providers, &retarget).unwrap();
        let replacement_id = read_web_config(&providers).unwrap()[&provider].accounts()[0]
            .account_id(provider)
            .unwrap();
        assert_ne!(replacement_id, first_id);
        assert_eq!(
            policy_for(&providers, provider_id(provider), &replacement_id).unwrap()["name"]
                .as_str(),
            Some("First")
        );
        assert!(policy_for(&providers, provider_id(provider), &first_id).is_none());

        let mut stale = body(provider, WebAccountAction::Context);
        stale.account_id = Some(second_id);
        stale.context = Some(WebAccountContext::GooglePse {
            engine_id: "fourth".to_owned(),
            existing_customer_acknowledged: true,
        });
        mutate_web_accounts(&mut providers, &stale).unwrap();
        stale.account_id = Some("stale".to_owned());
        assert_eq!(
            mutate_web_accounts(&mut providers, &stale).unwrap_err(),
            "account no longer exists; refresh the account list"
        );
    }

    #[test]
    fn context_action_rejects_credential_and_policy_cross_fields() {
        let mut providers = toml::map::Map::new();
        let mut update = body(WebProviderKind::GooglePse, WebAccountAction::Context);
        update.account_id = Some("missing".to_owned());
        update.context = Some(WebAccountContext::GooglePse {
            engine_id: "engine".to_owned(),
            existing_customer_acknowledged: true,
        });
        update.api_key = Some("must-not-be-accepted".to_owned());
        assert!(mutate_web_accounts(&mut providers, &update).is_err());
        update.api_key = None;
        update.account_policy = Some(Default::default());
        assert!(mutate_web_accounts(&mut providers, &update).is_err());
    }
}
