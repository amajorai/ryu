//! The plan's per-provider account limit on the vault ([`crate::server::plan_limits`]).
//!
//! The check runs inside [`AccountVault::upsert`]'s transaction, so every path
//! that adds an account meets it: API keys, OAuth and plan sign-ins, native
//! accounts, ACP sign-in capture and imports. Only a NEW `(scope, account_id)`
//! is refused. Writing to an account that already exists (a new key, a sign-in
//! again, a token refresh) is an update and always passes, so a node that
//! already holds more accounts than the limit keeps every one of them.

use super::*;
use crate::server::plan_limits::{self, AccountLimitReached};

/// Whether the rows of `scope` are accounts a person added: a Pi provider slot,
/// an ACP agent's sign-ins, or the native accounts. The table also holds
/// conversation bindings (`pi:conversation-account-affinity:v1`,
/// `pi:kiro-http-affinity:v1`, `native:kiro:conversation-affinity`). Those are
/// not accounts, so they are neither counted nor limited.
fn is_account_scope(scope: &str) -> bool {
    is_provider_scope(scope)
        || is_acp_scope(scope)
        || scope == crate::pi_config::native_accounts::SCOPE
}

/// `Err` when the Pi provider slot `auth_key` has no room for a new account.
/// Sign-in flows ask before they open the provider's page; the vault checks
/// again when the credential is stored. A node without the vault keeps one
/// credential per provider and is never full.
pub fn ensure_provider_has_room(auth_key: &str) -> Result<()> {
    let Some(vault) = global() else {
        return Ok(());
    };
    let count = vault.count(&provider_scope(auth_key))?;
    AccountLimitReached::check(auth_key, count)?;
    Ok(())
}

/// Refuse a new account when `scope` already holds the most the plan allows.
pub(super) fn ensure_room(
    transaction: &rusqlite::Transaction<'_>,
    scope: &str,
    account_id: &str,
) -> Result<()> {
    if !is_account_scope(scope) {
        return Ok(());
    }
    let (exists, count): (bool, i64) = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pi_accounts WHERE scope = ?1 AND account_id = ?2),
                    (SELECT COUNT(*) FROM pi_accounts WHERE scope = ?1)",
            params![scope, account_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .context("counting pi_accounts before capture")?;
    if exists {
        return Ok(());
    }
    let count = usize::try_from(count).unwrap_or(usize::MAX);
    match AccountLimitReached::check(scope_key(scope), count) {
        Ok(()) => Ok(()),
        Err(refusal) => {
            // `pi_config` wraps vault errors in its own message, so a route
            // that needs the reason reads it back with `take_refusal`.
            plan_limits::note_refusal(&refusal);
            Err(refusal.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const AFFINITY_SCOPES: [&str; 3] = [
        "pi:conversation-account-affinity:v1",
        "pi:kiro-http-affinity:v1",
        "native:kiro:conversation-affinity",
    ];

    fn key(index: usize) -> Option<Value> {
        Some(json!({ "type": "api_key", "key": format!("sk-{index}") }))
    }

    /// Fill `scope` with `count` accounts named `acct-0`, `acct-1` and so on.
    fn fill(vault: &AccountVault, scope: &str, count: usize) {
        for index in 0..count {
            let id = format!("acct-{index}");
            vault
                .upsert(scope, &id, "Key", KIND_API_KEY, key(index))
                .expect("room for another account");
        }
    }

    fn is_refusal(error: &anyhow::Error) -> bool {
        AccountLimitReached::from_error(error).is_some()
    }

    #[test]
    fn the_account_at_the_limit_is_stored_and_the_next_one_is_refused() {
        let vault = AccountVault::in_memory().unwrap();
        let scope = provider_scope("anthropic");
        let limit = plan_limits::account_limit();

        // One below the limit (9 of 10): one place left.
        fill(&vault, &scope, limit - 1);
        assert_eq!(vault.count(&scope).unwrap(), limit - 1);
        // The account at the limit (the 10th) takes the last place.
        vault
            .upsert(&scope, "acct-last", "Key", KIND_API_KEY, key(limit))
            .expect("the account at the limit is stored");
        assert_eq!(vault.count(&scope).unwrap(), limit);

        // The next one (the 11th) is refused and changes nothing.
        let error = vault
            .upsert(&scope, "acct-over", "Key", KIND_API_KEY, key(limit + 1))
            .expect_err("the account past the limit is refused");
        assert_eq!(
            AccountLimitReached::from_error(&error),
            Some(&AccountLimitReached {
                provider: "anthropic".into(),
                limit,
                count: limit,
            })
        );
        assert_eq!(error.to_string(), plan_limits::ACCOUNT_LIMIT_MESSAGE);
        assert_eq!(vault.count(&scope).unwrap(), limit);
        assert!(!vault.contains(&scope, "acct-over").unwrap());
        assert_eq!(
            vault.active_info(&scope).unwrap().unwrap().account_id,
            "acct-last"
        );
        // The route that asked can read the reason back, once.
        assert_eq!(
            plan_limits::take_refusal().map(|refusal| refusal.count),
            Some(limit)
        );
        assert_eq!(plan_limits::take_refusal(), None);
    }

    #[test]
    fn every_kind_of_account_write_meets_the_limit() {
        let vault = AccountVault::in_memory().unwrap();
        let limit = plan_limits::account_limit();
        // A Pi provider slot, an ACP agent's sign-ins and the native accounts.
        for scope in [
            provider_scope("openai-codex"),
            acp_scope("npx some-agent-acp"),
            crate::pi_config::native_accounts::SCOPE.to_owned(),
        ] {
            fill(&vault, &scope, limit);
            // The activating write: keys, OAuth and plan sign-ins, ACP capture.
            let active = vault.upsert(&scope, "over-active", "Login", KIND_OAUTH, key(99));
            assert!(is_refusal(&active.unwrap_err()), "{scope}");
            // The pending write: a native account before its sign-in.
            let pending =
                vault.upsert_inactive(&scope, "over-pending", "Login", KIND_OAUTH, json!({}));
            assert!(is_refusal(&pending.unwrap_err()), "{scope}");
            // An opaque sign-in with no credential: another ACP agent.
            let opaque = vault.upsert(&scope, "over-opaque", "Signed in", KIND_OPAQUE, None);
            assert!(is_refusal(&opaque.unwrap_err()), "{scope}");
            assert_eq!(vault.count(&scope).unwrap(), limit, "{scope}");
        }
    }

    #[test]
    fn an_existing_account_is_always_writable_at_or_above_the_limit() {
        let vault = AccountVault::in_memory().unwrap();
        let scope = provider_scope("anthropic");
        let limit = plan_limits::account_limit();
        fill(&vault, &scope, limit);
        // A node from before the limit: two accounts more than it allows.
        {
            let conn = vault.conn.lock().unwrap();
            for id in ["old-1", "old-2"] {
                conn.execute(
                    "INSERT INTO pi_accounts
                        (scope, account_id, label, kind, is_active, gateway_active,
                         created_at, updated_at)
                     VALUES (?1, ?2, 'Old', 'opaque', 0, 0, 0, 0)",
                    params![scope, id],
                )
                .unwrap();
            }
        }
        assert_eq!(vault.count(&scope).unwrap(), limit + 2);
        // Every account is still listed and can be selected.
        assert_eq!(vault.list(&scope).unwrap().len(), limit + 2);
        assert!(vault.set_active(&scope, "old-1").unwrap());

        // Replacing a key or signing in again is an update, never an add.
        let replaced = json!({ "type": "api_key", "key": "sk-replaced" });
        vault
            .upsert(
                &scope,
                "acct-0",
                "Key",
                KIND_API_KEY,
                Some(replaced.clone()),
            )
            .expect("an existing account is replaced at the limit");
        assert_eq!(vault.credential(&scope, "acct-0").unwrap(), Some(replaced));
        vault
            .upsert(&scope, "old-2", "Old", KIND_OPAQUE, None)
            .expect("an existing account above the limit signs in again");
        let refreshed = json!({ "type": "api_key", "key": "sk-refreshed" });
        assert!(vault
            .replace_credential(&scope, "acct-1", &key(1).unwrap(), refreshed)
            .unwrap());
        assert_eq!(vault.count(&scope).unwrap(), limit + 2);

        // New accounts stay refused until the provider is below the limit.
        let new_key = || key(50);
        let over = vault.upsert(&scope, "new", "Key", KIND_API_KEY, new_key());
        assert!(is_refusal(&over.unwrap_err()));
        for id in ["old-1", "old-2"] {
            assert!(vault.remove(&scope, id).unwrap());
        }
        let at_limit = vault.upsert(&scope, "new", "Key", KIND_API_KEY, new_key());
        assert!(is_refusal(&at_limit.unwrap_err()));
        assert!(vault.remove(&scope, "acct-0").unwrap());
        vault
            .upsert(&scope, "new", "Key", KIND_API_KEY, new_key())
            .expect("room again below the limit");
        assert_eq!(vault.count(&scope).unwrap(), limit);
    }

    #[test]
    fn providers_are_counted_apart_and_conversation_bindings_are_never_limited() {
        let vault = AccountVault::in_memory().unwrap();
        let limit = plan_limits::account_limit();
        fill(&vault, &provider_scope("anthropic"), limit);
        // A full provider leaves every other provider its own places.
        fill(&vault, &provider_scope("openrouter"), limit);
        // Conversation bindings share the table and outnumber the limit.
        for scope in AFFINITY_SCOPES {
            assert!(!is_account_scope(scope));
            for index in 0..limit * 3 {
                let id = format!("conversation-{index}");
                vault
                    .upsert(scope, &id, "Binding", KIND_OPAQUE, key(index))
                    .expect("a conversation binding is not an account");
            }
            assert_eq!(vault.count(scope).unwrap(), limit * 3);
        }
        // Nor do they use up a provider's places.
        assert_eq!(vault.count(&provider_scope("anthropic")).unwrap(), limit);
        assert!(is_account_scope(&provider_scope("anthropic")));
        assert!(is_account_scope(&acp_scope("npx pi")));
        assert!(is_account_scope("native:kiro"));
    }

    #[test]
    fn a_new_sign_in_is_refused_before_it_starts_when_the_provider_is_full() {
        with_test_vault(|vault| {
            let limit = plan_limits::account_limit();
            fill(vault, &provider_scope("kiro"), limit - 1);
            ensure_provider_has_room("kiro").expect("one place left");
            fill(vault, &provider_scope("anthropic"), limit);
            let error = ensure_provider_has_room("anthropic").unwrap_err();
            let refusal = AccountLimitReached::from_error(&error).unwrap();
            assert_eq!(
                (refusal.provider.as_str(), refusal.count),
                ("anthropic", limit)
            );
            // Another provider is not affected.
            ensure_provider_has_room("openai-codex").expect("an empty provider has room");
        });
    }

    #[test]
    fn an_import_into_an_empty_provider_is_never_refused() {
        // The boot import of older plaintext credentials adds one account, and
        // only to a provider the vault holds nothing for.
        let vault = AccountVault::in_memory().unwrap();
        let limit = plan_limits::account_limit();
        fill(&vault, &provider_scope("anthropic"), limit);
        let scope = provider_scope("openai");
        assert_eq!(vault.count(&scope).unwrap(), 0);
        vault
            .upsert(&scope, "imported", "API key", KIND_API_KEY, key(0))
            .expect("the first account of a provider always fits");
    }
}
