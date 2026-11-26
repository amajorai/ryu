//! Unit tests of the sealed account vault.

use super::*;
use serde_json::json;

#[test]
fn account_capture_rolls_back_when_deactivating_the_previous_account_fails() {
    for kind in [KIND_API_KEY, KIND_OAUTH] {
        let vault = AccountVault::in_memory().unwrap();
        let scope = provider_scope("transaction-test");
        let original = json!({"type": kind, "key": "original"});
        vault
            .upsert(&scope, "original", "Original", kind, Some(original.clone()))
            .unwrap();
        vault
            .conn
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER reject_deactivation BEFORE UPDATE OF is_active ON pi_accounts
             WHEN OLD.account_id = 'original' AND NEW.is_active = 0
             BEGIN SELECT RAISE(ABORT, 'test deactivation failure'); END;",
            )
            .unwrap();

        assert!(vault
            .upsert(
                &scope,
                "replacement",
                "Replacement",
                kind,
                Some(json!({"key":"replacement"}))
            )
            .is_err());
        assert_eq!(vault.list(&scope).unwrap().len(), 1);
        assert_eq!(
            vault.active_info(&scope).unwrap().unwrap().account_id,
            "original"
        );
        assert_eq!(
            vault.credential(&scope, "original").unwrap(),
            Some(original)
        );
    }
}

#[test]
fn account_selection_rolls_back_when_clearing_the_previous_selection_fails() {
    for (column, gateway) in [("is_active", false), ("gateway_active", true)] {
        let vault = AccountVault::in_memory().unwrap();
        let scope = provider_scope("transaction-test");
        vault
            .upsert(
                &scope,
                "first",
                "First",
                KIND_API_KEY,
                Some(json!("first-key")),
            )
            .unwrap();
        vault
            .upsert(
                &scope,
                "second",
                "Second",
                KIND_API_KEY,
                Some(json!("second-key")),
            )
            .unwrap();
        if gateway {
            vault.set_gateway_active(&scope, "second").unwrap();
        }
        vault
            .conn
            .lock()
            .unwrap()
            .execute_batch(&format!(
                "CREATE TRIGGER reject_deactivation BEFORE UPDATE OF {column} ON pi_accounts
             WHEN OLD.account_id = 'second' AND NEW.{column} = 0
             BEGIN SELECT RAISE(ABORT, 'test selection failure'); END;"
            ))
            .unwrap();

        let result = if gateway {
            vault.set_gateway_active(&scope, "first")
        } else {
            vault.set_active(&scope, "first")
        };
        assert!(result.is_err());
        let selected: Vec<_> = vault
            .list(&scope)
            .unwrap()
            .into_iter()
            .filter(|account| {
                if gateway {
                    account.gateway_active
                } else {
                    account.active
                }
            })
            .map(|account| account.account_id)
            .collect();
        assert_eq!(selected, ["second"]);
    }
}

#[test]
fn two_oauth_accounts_and_selection_survive_vault_reopen() {
    let directory = tempfile::tempdir().expect("temporary vault directory");
    let path = directory.path().join("accounts.db");
    let scope = provider_scope("anthropic");
    let first = json!({"type":"oauth","access":"first-token","refresh":"first-refresh"});
    let second = json!({"type":"oauth","access":"second-token","refresh":"second-refresh"});
    {
        let vault = AccountVault::open_with_cipher(path.clone(), FieldCipher::new(&[0x37; 32]))
            .expect("open vault");
        vault
            .upsert(&scope, "first", "First", KIND_OAUTH, Some(first.clone()))
            .expect("first login");
        vault
            .upsert(&scope, "second", "Second", KIND_OAUTH, Some(second.clone()))
            .expect("second login");
        vault.set_active(&scope, "first").expect("select first");
    }

    let reopened =
        AccountVault::open_with_cipher(path, FieldCipher::new(&[0x37; 32])).expect("reopen vault");
    assert_eq!(reopened.count(&scope).expect("account count"), 2);
    assert_eq!(
        reopened.credential(&scope, "first").expect("first row"),
        Some(first)
    );
    assert_eq!(
        reopened.credential(&scope, "second").expect("second row"),
        Some(second)
    );
    assert_eq!(
        reopened
            .active_info(&scope)
            .expect("active row")
            .expect("selected account")
            .account_id,
        "first"
    );
}

#[test]
fn upsert_list_active_and_switch_round_trip() {
    let v = AccountVault::in_memory().unwrap();
    let scope = provider_scope("anthropic");
    assert!(v.list(&scope).unwrap().is_empty());
    assert!(!v.contains(&scope, "acct-1").unwrap());

    v.upsert(
        &scope,
        "acct-1",
        "ada@x.io",
        KIND_OAUTH,
        Some(json!({ "type": "oauth", "access": "t1" })),
    )
    .unwrap();
    v.upsert(
        &scope,
        "acct-2",
        "bob@x.io",
        KIND_OAUTH,
        Some(json!({ "type": "oauth", "access": "t2" })),
    )
    .unwrap();

    let accounts = v.list(&scope).unwrap();
    assert!(v.contains(&scope, "acct-1").unwrap());
    assert!(!v.contains(&provider_scope("openai"), "acct-1").unwrap());
    assert!(!v.contains(&scope, "missing-account").unwrap());
    assert_eq!(accounts.len(), 2);
    // The newest upsert is active; its label carries no credential.
    let active = accounts
        .iter()
        .find(|a| a.active)
        .expect("an active account");
    assert_eq!(active.account_id, "acct-2");
    assert!(
        accounts.iter().all(|a| !a.label.contains("t2")),
        "labels must never leak a credential"
    );

    // Switching flips the active row and preserves both credentials.
    assert!(v.set_active(&scope, "acct-1").unwrap());
    let (id, cred) = v.active_credential(&scope).unwrap().unwrap();
    assert_eq!(id, "acct-1");
    assert_eq!(cred["access"], "t1");
    assert!(!v.set_active(&scope, "nope").unwrap());
}

#[test]
fn replacing_an_inactive_credential_preserves_both_selectors_and_does_not_resurrect() {
    let v = AccountVault::in_memory().unwrap();
    let scope = provider_scope("anthropic");
    v.upsert(
        &scope,
        "first",
        "First",
        KIND_OAUTH,
        Some(json!({"type":"oauth","access":"old"})),
    )
    .unwrap();
    v.upsert(
        &scope,
        "second",
        "Second",
        KIND_OAUTH,
        Some(json!({"type":"oauth","access":"selected"})),
    )
    .unwrap();
    assert!(v
        .replace_credential(
            &scope,
            "first",
            &json!({"type":"oauth","access":"old"}),
            json!({"type":"oauth","access":"rotated"}),
        )
        .unwrap());
    let accounts = v.list(&scope).unwrap();
    assert!(accounts
        .iter()
        .any(|account| account.account_id == "first" && !account.active));
    assert!(accounts
        .iter()
        .any(|account| account.account_id == "second" && account.active));
    assert_eq!(
        v.active_credential(&scope).unwrap().unwrap().1["access"],
        "selected"
    );
    assert_eq!(
        v.credential(&scope, "first").unwrap().unwrap()["access"],
        "rotated"
    );
    assert!(!v
        .replace_credential(
            &scope,
            "missing",
            &json!({"access":"missing"}),
            json!({"access":"never-stored"}),
        )
        .unwrap());
    assert!(!v
        .replace_credential(
            &scope,
            "first",
            &json!({"type":"oauth","access":"old"}),
            json!({"type":"oauth","access":"stale-write"}),
        )
        .unwrap());
    assert_eq!(v.count(&scope).unwrap(), 2);
}

#[test]
fn gateway_selection_is_independent_and_api_key_only() {
    let v = AccountVault::in_memory().unwrap();
    let scope = provider_scope("openrouter");

    v.upsert(
        &scope,
        "oauth",
        "subscription",
        KIND_OAUTH,
        Some(json!({ "type": "oauth", "access": "oauth-token" })),
    )
    .unwrap();
    assert!(v.gateway_credential(&scope).unwrap().is_none());

    v.upsert(
        &scope,
        "key-a",
        "Team key",
        KIND_API_KEY,
        Some(json!({ "type": "api_key", "key": "sk-team" })),
    )
    .unwrap();
    v.upsert(
        &scope,
        "key-b",
        "Lab key",
        KIND_API_KEY,
        Some(json!({ "type": "api_key", "key": "sk-lab" })),
    )
    .unwrap();

    let accounts = v.list(&scope).unwrap();
    assert!(accounts.iter().any(|a| a.active && a.account_id == "key-b"));
    assert!(accounts
        .iter()
        .any(|a| a.gateway_active && a.account_id == "key-a"));
    assert!(v.set_gateway_active(&scope, "key-b").unwrap());
    let (id, credential) = v.gateway_credential(&scope).unwrap().unwrap();
    assert_eq!(id, "key-b");
    assert_eq!(credential["key"], "sk-lab");
    assert!(v
        .list(&scope)
        .unwrap()
        .iter()
        .any(|a| a.active && a.account_id == "key-b"));
}

#[test]
fn scopes_are_isolated() {
    let v = AccountVault::in_memory().unwrap();
    v.upsert(
        &provider_scope("anthropic"),
        "a",
        "claude",
        KIND_OAUTH,
        Some(json!({ "access": "claude-tok" })),
    )
    .unwrap();
    v.upsert(
        &acp_scope("npx claude-code-acp"),
        "a",
        "opaque",
        KIND_OPAQUE,
        None,
    )
    .unwrap();

    assert_eq!(v.count(&provider_scope("anthropic")).unwrap(), 1);
    assert_eq!(
        v.count(&provider_scope("openai-codex")).unwrap(),
        0,
        "a sibling provider's scope is untouched"
    );
    assert_eq!(v.count(&acp_scope("npx claude-code-acp")).unwrap(), 1);
    // The ACP scope holds an opaque account with no readable credential.
    assert!(v
        .active_credential(&acp_scope("npx claude-code-acp"))
        .unwrap()
        .is_none());
}

#[test]
fn the_credential_is_encrypted_at_rest() {
    let v = AccountVault::in_memory().unwrap();
    let scope = provider_scope("anthropic");
    let secret = "sk-oauth-secret";
    v.upsert(
        &scope,
        "a",
        "ada@x.io",
        KIND_OAUTH,
        Some(json!({ "access": secret })),
    )
    .unwrap();

    let raw: Vec<u8> = {
        let conn = v.conn.lock().unwrap();
        conn.query_row(
            "SELECT ciphertext FROM pi_accounts WHERE scope = ?1",
            params![scope],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert!(
        !String::from_utf8_lossy(&raw).contains(secret),
        "the plaintext must not be recoverable from the stored column"
    );
}

#[test]
fn credential_revision_changes_on_login_but_not_label_or_selection() {
    let vault = AccountVault::in_memory().unwrap();
    let scope = provider_scope("anthropic");
    vault
        .upsert(
            &scope,
            "first",
            "First",
            KIND_OAUTH,
            Some(json!({ "access": "old" })),
        )
        .unwrap();
    let original = vault.credential_revision(&scope, "first").unwrap().unwrap();
    vault.set_label(&scope, "first", "Renamed").unwrap();
    vault.set_active(&scope, "first").unwrap();
    assert_eq!(
        vault.credential_revision(&scope, "first").unwrap().unwrap(),
        original
    );
    vault
        .upsert(
            &scope,
            "first",
            "Renamed",
            KIND_OAUTH,
            Some(json!({ "access": "new" })),
        )
        .unwrap();
    assert_ne!(
        vault.credential_revision(&scope, "first").unwrap().unwrap(),
        original
    );
}

#[test]
fn remove_drops_only_that_account() {
    let v = AccountVault::in_memory().unwrap();
    let scope = provider_scope("openai-codex");
    v.upsert(&scope, "a", "A", KIND_OAUTH, Some(json!({ "access": "x" })))
        .unwrap();
    v.upsert(&scope, "b", "B", KIND_OAUTH, Some(json!({ "access": "y" })))
        .unwrap();
    assert!(v.remove(&scope, "a").unwrap());
    assert!(!v.remove(&scope, "a").unwrap(), "removing twice is a no-op");

    let accounts = v.list(&scope).unwrap();
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].account_id, "b");
    assert_eq!(v.count(&scope).unwrap(), 1);
}

#[test]
fn custom_label_changes_metadata_without_touching_credentials_or_selection() {
    let v = AccountVault::in_memory().unwrap();
    let scope = provider_scope("anthropic");
    v.upsert(
        &scope,
        "acct-work",
        "work@example.com",
        KIND_OAUTH,
        Some(json!({ "access": "work-token" })),
    )
    .unwrap();
    v.upsert(
        &scope,
        "acct-personal",
        "personal@example.com",
        KIND_OAUTH,
        Some(json!({ "access": "personal-token" })),
    )
    .unwrap();

    assert!(v.set_label(&scope, "acct-work", "  Work Claude  ").unwrap());
    assert!(!v.set_label(&scope, "missing", "Unused").unwrap());

    let accounts = v.list(&scope).unwrap();
    let work = accounts
        .iter()
        .find(|account| account.account_id == "acct-work")
        .unwrap();
    assert_eq!(work.label, "Work Claude");
    assert!(!work.active);
    assert!(accounts
        .iter()
        .any(|account| account.account_id == "acct-personal" && account.active));
    assert_eq!(
        v.credential(&scope, "acct-work").unwrap().unwrap()["access"],
        "work-token"
    );

    assert!(v.set_label(&scope, "acct-work", " \t ").is_err());
    assert!(v.set_label(&scope, "acct-work", &"x".repeat(81)).is_err());
    assert!(v.set_label(&scope, "acct-work", "bad\nlabel").is_err());
}

#[test]
fn scope_helpers_shape_the_keys() {
    assert_eq!(provider_scope("anthropic"), "provider:anthropic");
    assert_eq!(
        acp_scope("PI_CODING_AGENT_DIR=x pi-acp"),
        "acp:PI_CODING_AGENT_DIR=x pi-acp"
    );
    assert!(is_provider_scope("provider:anthropic"));
    assert!(is_acp_scope("acp:npx pi"));
    assert!(!is_provider_scope("acp:npx pi"));
    assert!(!is_acp_scope("provider:anthropic"));
    assert_eq!(scope_key("provider:anthropic"), "anthropic");
    assert_eq!(scope_key("acp:npx pi"), "npx pi");
}
