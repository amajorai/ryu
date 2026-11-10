//! Runtime templates: per-channel grants and fail-closed resolution.

use super::*;

#[tokio::test]
async fn runtime_templates_resolve_after_approval() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    add_cli_account(&store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    let context = SecretResolutionContext::node_only("node-1", vec!["github".into()]);
    let template = format!("Bearer secret:bws://{SECRET_ID}");
    assert_eq!(
        store
            .resolve_vault_template(&template, &context)
            .await
            .unwrap(),
        None
    );
    assert_eq!(invocations(dir.path()), 0);
    let approvals = store
        .pm_approvals(Some(ProposalStatus::Pending))
        .await
        .unwrap();
    assert_eq!(approvals.len(), 1);
    assert_eq!(
        approvals[0].credential_use.as_ref().unwrap().subject,
        "runtime:github:node:node-1"
    );
    assert!(
        approvals[0]
            .message
            .starts_with("MCP server or plugin `github` running for node:node-1"),
        "{}",
        approvals[0].message
    );
    store
        .pm_approve(&approvals[0].id, GrantMode::Hour, "", "operator", &actor())
        .await
        .unwrap();
    assert_eq!(
        store
            .resolve_vault_template(&template, &context)
            .await
            .unwrap()
            .as_deref(),
        Some("Bearer bw-secret-value")
    );
}

fn runtime_context(user: &str, mcp: &str) -> SecretResolutionContext {
    SecretResolutionContext {
        user_id: Some(user.to_owned()),
        ..SecretResolutionContext::node_only("node-1", vec![mcp.to_owned(), "plugin-x".into()])
    }
}

async fn pending_subjects(store: &PluginSecretStore) -> Vec<String> {
    let mut subjects: Vec<String> = store
        .pm_approvals(Some(ProposalStatus::Pending))
        .await
        .unwrap()
        .into_iter()
        .filter_map(|proposal| proposal.credential_use.map(|c| c.subject))
        .collect();
    subjects.sort();
    subjects
}

#[tokio::test]
async fn a_grant_covers_one_channel_only() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    add_cli_account(&store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    let reference = format!("bws://{SECRET_ID}");
    // A broker session minted by u1 is approved for 30 days.
    let broker = consumer(&broker_subject("user:u1"));
    let request = pending(
        store
            .pm_resolve(&reference, &broker, &actor())
            .await
            .unwrap(),
    );
    assert!(request
        .message
        .starts_with("A broker session minted by user:u1"));
    store
        .pm_approve(&request.id, GrantMode::Month, "", "operator", &actor())
        .await
        .unwrap();
    assert_eq!(
        value(
            store
                .pm_resolve(&reference, &broker, &actor())
                .await
                .unwrap()
        ),
        "bw-secret-value"
    );
    assert_eq!(invocations(dir.path()), 1);
    // The same user's runtime template and explicit read still need their own
    // approvals; the provider is not contacted.
    let template = format!("secret:{reference}");
    assert_eq!(
        store
            .resolve_vault_template(&template, &runtime_context("u1", "github"))
            .await
            .unwrap(),
        None
    );
    pending(
        store
            .pm_resolve(&reference, &consumer(&read_subject("user:u1")), &actor())
            .await
            .unwrap(),
    );
    assert_eq!(invocations(dir.path()), 1);
    assert_eq!(
        pending_subjects(&store).await,
        vec![
            "read:user:u1".to_owned(),
            "runtime:github:user:u1".to_owned()
        ]
    );
    // A grant for one MCP server does not cover another.
    let github = store
        .pm_approvals(Some(ProposalStatus::Pending))
        .await
        .unwrap()
        .into_iter()
        .find(|p| p.credential_use.as_ref().unwrap().subject == "runtime:github:user:u1")
        .unwrap();
    store
        .pm_approve(&github.id, GrantMode::Hour, "", "operator", &actor())
        .await
        .unwrap();
    assert_eq!(
        store
            .resolve_vault_template(&template, &runtime_context("u1", "github"))
            .await
            .unwrap()
            .as_deref(),
        Some("bw-secret-value")
    );
    assert_eq!(
        store
            .resolve_vault_template(&template, &runtime_context("u1", "slack"))
            .await
            .unwrap(),
        None
    );
    assert!(pending_subjects(&store)
        .await
        .contains(&"runtime:slack:user:u1".to_owned()));
    assert_eq!(invocations(dir.path()), 2);
}

#[tokio::test]
async fn runtime_templates_need_a_named_server_and_no_deny() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    add_cli_account(&store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    let template = format!("secret:bws://{SECRET_ID}");
    // No MCP id: nothing is filed.
    let anonymous = SecretResolutionContext::node_only("node-1", Vec::new());
    assert_eq!(
        store
            .resolve_vault_template(&template, &anonymous)
            .await
            .unwrap(),
        None
    );
    // An MCP id with `:` would make the subject ambiguous.
    assert_eq!(runtime_subject("a:b", "user:u1"), None);
    assert_eq!(
        store
            .resolve_vault_template(&template, &runtime_context("u1", "a:b"))
            .await
            .unwrap(),
        None
    );
    assert!(pending_subjects(&store).await.is_empty());
    // A policy denying the user `use` on the account refuses before any
    // approval is filed, and keeps refusing after one is granted.
    {
        let conn = store.conn.lock().await;
        crate::vault::policy::put_policy(
            &conn,
            &Policy {
                name: "no-pm".into(),
                description: String::new(),
                rules: vec![crate::vault::policy::PolicyRule {
                    path: "sys/password-managers/team".into(),
                    capabilities: vec![Capability::Use],
                    deny: true,
                    ..Default::default()
                }],
            },
        )
        .unwrap();
        crate::vault::policy::bind(&conn, "no-pm", "user:u9", None, None).unwrap();
    }
    assert_eq!(
        store
            .resolve_vault_template(&template, &runtime_context("u9", "github"))
            .await
            .unwrap(),
        None
    );
    assert!(pending_subjects(&store).await.is_empty());
    assert!(audit_rows(&store)
        .await
        .iter()
        .any(|row| row.action == "pm.resolve" && row.outcome == "denied"));
    // Another user is not affected.
    assert_eq!(
        store
            .resolve_vault_template(&template, &runtime_context("u1", "github"))
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        pending_subjects(&store).await,
        vec!["runtime:github:user:u1".to_owned()]
    );
    assert_eq!(invocations(dir.path()), 0);
}

#[tokio::test]
async fn runtime_templates_fail_closed_and_audit_without_a_verified_principal() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    add_cli_account(&store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    let template = format!("secret:bws://{SECRET_ID}");
    // The owner's role and team subjects are unknown: nothing resolves, no
    // approval is filed, the provider is not contacted, and the refusal is
    // on the audit log like any other `pm.resolve` denial.
    let unverified = SecretResolutionContext {
        principal_unverified: true,
        ..runtime_context("u1", "github")
    };
    assert_eq!(
        store
            .resolve_vault_template(&template, &unverified)
            .await
            .unwrap(),
        None
    );
    assert!(pending_subjects(&store).await.is_empty());
    assert_eq!(invocations(dir.path()), 0);
    assert!(audit_rows(&store)
        .await
        .iter()
        .any(|row| row.action == "pm.resolve" && row.outcome == "denied"));
    // The verified owner still reaches the approval flow.
    assert_eq!(
        store
            .resolve_vault_template(&template, &runtime_context("u1", "github"))
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        pending_subjects(&store).await,
        vec!["runtime:github:user:u1".to_owned()]
    );
}
