//! Conversation account capture: bind a conversation to one sealed account.
use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::super::sdk_account_routing::AccountChooser;
use super::{is_sdk_oauth_auth_key, SessionAccount, AFFINITY_SCOPE, CAPTURE_LOCK};
use crate::server::oauth_pool_policy::{Policy, Strategy};

pub(super) fn capture_with_vault(
    vault: &super::super::accounts::AccountVault,
    provider_id: &str,
    auth_key: &str,
    conversation_id: Option<&str>,
    agent_id: &str,
    explicit_identity: Option<&str>,
) -> Result<Option<SessionAccount>> {
    capture_with_vault_and_policy(
        vault,
        provider_id,
        auth_key,
        conversation_id,
        agent_id,
        explicit_identity,
        &Policy::default(),
        &mut AccountChooser::default(),
    )
}

pub(super) fn capture_with_vault_and_policy(
    vault: &super::super::accounts::AccountVault,
    provider_id: &str,
    auth_key: &str,
    conversation_id: Option<&str>,
    agent_id: &str,
    explicit_identity: Option<&str>,
    policy: &Policy,
    chooser: &mut AccountChooser,
) -> Result<Option<SessionAccount>> {
    let _guard = CAPTURE_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("Pi account capture lock unavailable"))?;
    let scope = super::super::accounts::provider_scope(auth_key);
    let conversation = conversation_id.filter(|id| !id.is_empty());
    let affinity_key = conversation
        .map(|id| hash_key(&(provider_id, id, agent_id)))
        .transpose()?;
    let existing = affinity_key
        .as_deref()
        .map(|key| vault.credential(AFFINITY_SCOPE, key))
        .transpose()?
        .flatten();
    if let Some(value) = existing {
        let captured: SessionAccount = serde_json::from_value(value)?;
        if captured.provider_id != provider_id
            || affinity_key.as_deref() != Some(&captured.session_key)
        {
            bail!("Pi conversation account binding is invalid");
        }
        if explicit_identity.is_some_and(|identity| identity != captured.process_identity()) {
            bail!("Pi conversation account changed; start a new conversation");
        }
        if !policy.allowed(&captured.account_id) {
            bail!("This conversation's Pi account is disabled; enable it again or start a new conversation");
        }
        if verify_account(vault, &scope, &captured.account_id)? != captured.credential_kind {
            bail!("Captured Pi credential kind changed; start a new conversation");
        }
        return Ok(Some(captured));
    }
    let explicit_account = explicit_identity
        .map(|identity| {
            identity
                .strip_prefix(&format!("{provider_id}:"))
                .filter(|account| !account.is_empty())
                .context("Pi account identity does not match the selected provider")
        })
        .transpose()?;
    let account_id = match explicit_account {
        Some(account) => account.to_owned(),
        None => {
            if policy.strategy != Strategy::Manual {
                let accounts = vault.list(&scope)?;
                let kinds = super::super::sdk_account_routing::credential_kinds(provider_id);
                let mut candidates = Vec::new();
                for account in &accounts {
                    if account.needs_reauth
                        || !kinds.contains(&account.kind.as_str())
                        || !policy.allowed(&account.account_id)
                    {
                        continue;
                    }
                    if vault
                        .credential(&scope, &account.account_id)?
                        .is_some_and(|credential| {
                            sdk_credential_usable(auth_key, &account.kind, &credential)
                        })
                    {
                        if let Some(revision) =
                            vault.credential_revision(&scope, &account.account_id)?
                        {
                            candidates.push((account.account_id.as_str(), revision));
                        }
                    }
                }
                let captured: Vec<_> = candidates
                    .iter()
                    .map(
                        |(account_id, revision)| crate::server::oauth_pool_usage::Candidate {
                            account_id,
                            revision,
                        },
                    )
                    .collect();
                chooser
                    .select_captured(provider_id, &captured, None, policy)?
                    .context("No enabled SDK accounts have usable credentials")?
            } else {
                let Some(active) = vault.active_info(&scope)? else {
                    return Ok(None);
                };
                active.account_id
            }
        }
    };
    if !policy.allowed(&account_id) {
        bail!("This Pi account is disabled for new conversations");
    }
    let credential_kind = verify_account(vault, &scope, &account_id)?;
    if credential_kind == super::super::accounts::KIND_API_KEY
        && super::super::provider_meta(provider_id)
            .is_some_and(|meta| meta.auth_kind == "subscription")
    {
        bail!("This Pi provider requires an OAuth account");
    }
    if credential_kind == super::super::accounts::KIND_OAUTH && !is_sdk_oauth_auth_key(auth_key) {
        if auth_key == super::super::CLAUDE_AUTH_KEY {
            return Ok(None);
        }
        bail!("This Pi OAuth provider has no account-qualified refresh flow; use a supported provider or an API-key account");
    }
    let session_key = affinity_key.unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    let captured = SessionAccount {
        provider_id: provider_id.to_owned(),
        account_id,
        session_key,
        credential_kind,
    };
    if conversation.is_some() {
        vault.upsert(
            AFFINITY_SCOPE,
            &captured.session_key,
            "Pi conversation account",
            super::super::accounts::KIND_OPAQUE,
            Some(serde_json::to_value(&captured)?),
        )?;
    }
    Ok(Some(captured))
}

fn sdk_credential_usable(auth_key: &str, kind: &str, credential: &Value) -> bool {
    if kind == super::super::accounts::KIND_API_KEY {
        return credential
            .as_str()
            .or_else(|| credential.get("key").and_then(Value::as_str))
            .is_some_and(|key| !key.trim().is_empty());
    }
    if kind != super::super::accounts::KIND_OAUTH
        || !is_sdk_oauth_auth_key(auth_key)
        || credential.get("type").and_then(Value::as_str) != Some("oauth")
    {
        return false;
    }
    let refresh = credential
        .get("refresh")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    let access = credential
        .get("access")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    refresh
        || (access
            && !super::super::subscription_needs_refresh(
                auth_key,
                credential,
                super::super::now_unix(),
            ))
}

pub(super) fn verify_account(
    vault: &super::super::accounts::AccountVault,
    scope: &str,
    account_id: &str,
) -> Result<String> {
    let account = vault.list(scope)?.into_iter().find(|account| account.account_id == account_id)
        .context("This conversation's Pi account is unavailable; connect it again or start a new conversation")?;
    if ![
        super::super::accounts::KIND_OAUTH,
        super::super::accounts::KIND_API_KEY,
    ]
    .contains(&account.kind.as_str())
    {
        bail!("Captured Pi account has no supported SDK credential");
    }
    if vault.credential(scope, account_id)?.is_none() {
        bail!("Captured Pi credential is unavailable");
    }
    Ok(account.kind)
}

pub(super) fn hash_key(value: &impl Serialize) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(value)?)))
}
