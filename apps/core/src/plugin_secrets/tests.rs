//! Store, scope and resolution tests for [`super`].

use super::scope::{is_valid_secret_key, VerifiedTeamSecretScope};
use super::*;

#[tokio::test]
async fn set_get_delete_round_trips() {
    let s = PluginSecretStore::in_memory().unwrap();
    assert_eq!(s.get("exa", "RYU_EXA_API_KEY").await.unwrap(), None);

    s.set("exa", "RYU_EXA_API_KEY", "sk-exa-1").await.unwrap();
    assert_eq!(
        s.get("exa", "RYU_EXA_API_KEY").await.unwrap().as_deref(),
        Some("sk-exa-1")
    );

    // Upsert replaces.
    s.set("exa", "RYU_EXA_API_KEY", "sk-exa-2").await.unwrap();
    assert_eq!(
        s.get("exa", "RYU_EXA_API_KEY").await.unwrap().as_deref(),
        Some("sk-exa-2")
    );

    s.delete("exa", "RYU_EXA_API_KEY").await.unwrap();
    assert_eq!(s.get("exa", "RYU_EXA_API_KEY").await.unwrap(), None);
    // Deleting an absent key is a no-op, not an error.
    s.delete("exa", "RYU_EXA_API_KEY").await.unwrap();
}

#[tokio::test]
async fn delete_plugin_removes_only_the_requested_plugin() {
    let s = PluginSecretStore::in_memory().unwrap();
    s.set("exa", "RYU_EXA_API_KEY", "sk-exa").await.unwrap();
    s.set("tavily", "RYU_TAVILY_API_KEY", "sk-tavily")
        .await
        .unwrap();

    assert_eq!(s.delete_plugin("exa").await.unwrap(), 1);
    assert!(s.list_keys("exa").await.unwrap().is_empty());
    assert_eq!(s.list_keys("tavily").await.unwrap().len(), 1);
}

/// The point of the store: the plaintext must not survive the write. Asserted
/// against the raw BLOB column, not the API, so a future "store it plainly for
/// speed" refactor fails here.
#[tokio::test]
async fn the_value_is_encrypted_at_rest() {
    let s = PluginSecretStore::in_memory().unwrap();
    let secret = "sk-tavily-super-secret";
    s.set("tavily", "RYU_TAVILY_API_KEY", secret).await.unwrap();

    let raw: Vec<u8> = {
        let conn = s.conn.lock().await;
        conn.query_row(
            "SELECT ciphertext FROM plugin_secrets WHERE plugin_id = 'tavily'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_ne!(raw.as_slice(), secret.as_bytes());
    assert!(
        !String::from_utf8_lossy(&raw).contains("tavily-super"),
        "the plaintext must not be recoverable from the stored column"
    );
}

/// Rows are keyed by plugin: one plugin's key name never resolves to another's
/// value. (The read-side namespace gate in `tool_exec` is the second layer.)
#[tokio::test]
async fn secrets_are_isolated_per_plugin() {
    let s = PluginSecretStore::in_memory().unwrap();
    s.set("exa", "RYU_SHARED_NAME", "exa-value").await.unwrap();
    s.set("tavily", "RYU_SHARED_NAME", "tavily-value")
        .await
        .unwrap();

    assert_eq!(
        s.get("exa", "RYU_SHARED_NAME").await.unwrap().as_deref(),
        Some("exa-value")
    );
    assert_eq!(
        s.get("tavily", "RYU_SHARED_NAME").await.unwrap().as_deref(),
        Some("tavily-value")
    );
    assert_eq!(s.get("other", "RYU_SHARED_NAME").await.unwrap(), None);
}

/// An empty (or whitespace-only) value CLEARS the secret rather than storing a
/// blank one — an empty secret would read as "set" in the UI while the `env:`
/// resolver treats it as absent.
#[tokio::test]
async fn an_empty_value_deletes_rather_than_storing_a_blank_secret() {
    let s = PluginSecretStore::in_memory().unwrap();
    s.set("exa", "RYU_EXA_API_KEY", "sk-exa").await.unwrap();

    s.set("exa", "RYU_EXA_API_KEY", "   ").await.unwrap();
    assert_eq!(s.get("exa", "RYU_EXA_API_KEY").await.unwrap(), None);
    assert!(
        s.list_keys("exa").await.unwrap().is_empty(),
        "a cleared secret must not linger in the listing as 'set'"
    );
}

#[tokio::test]
async fn list_keys_reports_names_and_timestamps_only() {
    let s = PluginSecretStore::in_memory().unwrap();
    s.set("exa", "RYU_EXA_API_KEY", "sk-exa").await.unwrap();
    s.set("exa", "RYU_EXA_BASE", "https://x").await.unwrap();

    let keys = s.list_keys("exa").await.unwrap();
    assert_eq!(keys.len(), 2);
    let names: Vec<&str> = keys.iter().map(|k| k.key.as_str()).collect();
    assert!(names.contains(&"RYU_EXA_API_KEY"));
    assert!(names.contains(&"RYU_EXA_BASE"));
    assert!(
        keys.iter().all(|k| k.updated_at > 0),
        "each entry carries a write timestamp"
    );
    // Another plugin's listing is unaffected.
    assert!(s.list_keys("tavily").await.unwrap().is_empty());
}

#[test]
fn secret_key_names_are_env_var_shaped() {
    for ok in ["RYU_EXA_API_KEY", "_private", "A1", "a_b_c"] {
        assert!(is_valid_secret_key(ok), "'{ok}' should be accepted");
    }
    for bad in [
        "",
        "1LEADING_DIGIT",
        "has-dash",
        "has space",
        "has/slash",
        "..",
        "unicodé",
    ] {
        assert!(!is_valid_secret_key(bad), "'{bad}' should be rejected");
    }
    assert!(!is_valid_secret_key(
        &"A".repeat(ryu_kernel_contracts::MAX_SECRET_KEY_LEN + 1)
    ));
}

#[tokio::test]
async fn scoped_vault_values_are_encrypted_and_listed_without_values() {
    let store = PluginSecretStore::in_memory().unwrap();
    let binding = SecretBinding {
        kind: SecretBindingKind::Mcp,
        id: "github".to_owned(),
    };
    let info = store
        .set_vault_secret(
            SecretScope::Org,
            "org-1",
            Some(&binding),
            "GITHUB_TOKEN",
            "ghp-do-not-leak",
        )
        .await
        .unwrap()
        .expect("non-empty writes return metadata");
    assert_eq!(info.scope, SecretScope::Org);
    assert_eq!(info.binding, Some(binding.clone()));

    let raw: Vec<u8> = {
        let conn = store.conn.lock().await;
        conn.query_row(
            "SELECT ciphertext FROM vault_secrets WHERE name = 'GITHUB_TOKEN'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert!(!String::from_utf8_lossy(&raw).contains("ghp-do-not-leak"));

    let listed = store.list_vault_secrets().await.unwrap();
    assert_eq!(listed, vec![info]);
}

#[tokio::test]
async fn scoped_vault_resolution_uses_specific_scope_then_binding() {
    let store = PluginSecretStore::in_memory().unwrap();
    let github = SecretBinding {
        kind: SecretBindingKind::Mcp,
        id: "github".to_owned(),
    };
    store
        .set_vault_secret(SecretScope::Org, "org-1", None, "API_TOKEN", "org-default")
        .await
        .unwrap();
    store
        .set_vault_secret(
            SecretScope::Team,
            "team-1",
            None,
            "API_TOKEN",
            "team-default",
        )
        .await
        .unwrap();
    store
        .set_vault_secret(
            SecretScope::Node,
            "node-1",
            None,
            "API_TOKEN",
            "node-default",
        )
        .await
        .unwrap();
    store
        .set_vault_secret(
            SecretScope::User,
            "user-1",
            None,
            "API_TOKEN",
            "user-default",
        )
        .await
        .unwrap();
    store
        .set_vault_secret(
            SecretScope::Node,
            "node-1",
            Some(&github),
            "API_TOKEN",
            "github-node",
        )
        .await
        .unwrap();

    let context = SecretResolutionContext {
        user_id: Some("user-1".to_owned()),
        org_id: Some("org-1".to_owned()),
        team_id: Some("team-1".to_owned()),
        team_authority: None,
        node_id: "node-1".to_owned(),
        mcp_ids: vec!["github".to_owned()],
        ..Default::default()
    };
    // User scope outranks node scope, even when the node has an exact MCP
    // binding. This makes a user's explicit override predictable.
    assert_eq!(
        store
            .resolve_vault_secret("API_TOKEN", &context)
            .await
            .unwrap()
            .as_deref(),
        Some("user-default")
    );

    store
        .delete_vault_secret(SecretScope::User, "user-1", None, "API_TOKEN")
        .await
        .unwrap();
    assert_eq!(
        store
            .resolve_vault_secret("API_TOKEN", &context)
            .await
            .unwrap()
            .as_deref(),
        Some("github-node")
    );
}

#[tokio::test]
async fn shared_scopes_are_not_read_without_a_verified_user_context() {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .set_vault_secret(SecretScope::Org, "org-1", None, "API_TOKEN", "org-secret")
        .await
        .unwrap();
    let context = SecretResolutionContext::node_only("node-1", Vec::new());
    assert_eq!(
        store
            .resolve_vault_secret("API_TOKEN", &context)
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn team_secrets_require_current_membership_bound_to_user_and_org() {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .set_vault_secret(
            SecretScope::Team,
            "target-team",
            None,
            "TEAM_TOKEN",
            "team-secret",
        )
        .await
        .unwrap();
    let mut context = SecretResolutionContext {
        user_id: Some("owner".into()),
        org_id: Some("org-1".into()),
        team_id: Some("target-team".into()),
        node_id: "node-1".into(),
        ..SecretResolutionContext::default()
    };
    // Previously forged sharing metadata is not an authorization witness.
    assert_eq!(
        store
            .resolve_vault_secret("TEAM_TOKEN", &context)
            .await
            .unwrap(),
        None
    );
    let mut caller = crate::identity_verify::VerifiedCaller {
        user_id: "owner".into(),
        email: None,
        email_verified: false,
        org_id: Some("org-1".into()),
        role: crate::identity_verify::OrgRole::Member,
        teams: Vec::new(),
    };
    context.team_authority = VerifiedTeamSecretScope::from_verified_caller(&caller);
    assert_eq!(
        store
            .resolve_vault_secret("TEAM_TOKEN", &context)
            .await
            .unwrap(),
        None
    );
    caller.teams.push(crate::identity_verify::TeamMembership {
        id: "target-team".into(),
        org_id: "other-org".into(),
        role: "member".into(),
    });
    context.team_authority = VerifiedTeamSecretScope::from_verified_caller(&caller);
    assert_eq!(
        store
            .resolve_vault_secret("TEAM_TOKEN", &context)
            .await
            .unwrap(),
        None
    );
    caller.teams[0].org_id = "org-1".into();
    context.team_authority = VerifiedTeamSecretScope::from_verified_caller(&caller);
    assert_eq!(
        store
            .resolve_vault_secret("TEAM_TOKEN", &context)
            .await
            .unwrap()
            .as_deref(),
        Some("team-secret")
    );
    context.user_id = Some("different-user".into());
    assert_eq!(
        store
            .resolve_vault_secret("TEAM_TOKEN", &context)
            .await
            .unwrap(),
        None
    );
    context.user_id = Some("owner".into());
    context.org_id = Some("other-org".into());
    assert_eq!(
        store
            .resolve_vault_secret("TEAM_TOKEN", &context)
            .await
            .unwrap(),
        None
    );
    context.org_id = Some("org-1".into());
    // An unavailable/revoked authority still permits existing node secrets.
    context.team_authority = None;
    store
        .set_vault_secret(
            SecretScope::Node,
            "node-1",
            None,
            "TEAM_TOKEN",
            "node-secret",
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .resolve_vault_secret("TEAM_TOKEN", &context)
            .await
            .unwrap()
            .as_deref(),
        Some("node-secret")
    );
}

#[tokio::test]
async fn vault_templates_preserve_literals_and_drop_unresolved_references() {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .set_vault_secret(
            SecretScope::Node,
            "node-1",
            None,
            "GITHUB_TOKEN",
            "ghs-value",
        )
        .await
        .unwrap();
    let context = SecretResolutionContext::node_only("node-1", vec!["github".to_owned()]);
    assert_eq!(
        store
            .resolve_vault_template("Bearer secret:GITHUB_TOKEN", &context)
            .await
            .unwrap()
            .as_deref(),
        Some("Bearer ghs-value")
    );
    assert_eq!(
        store
            .resolve_vault_template("Bearer secret:MISSING_TOKEN", &context)
            .await
            .unwrap(),
        None
    );
}
