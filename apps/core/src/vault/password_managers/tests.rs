//! Password-manager tests against fake `op` / `bws` binaries (tiny shell
//! scripts that log their invocations) and a local fake 1Password Connect
//! server. No real provider is contacted.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

use super::*;
use crate::vault::audit::AuditFilter;

pub(crate) const BWS_TOKEN: &str = "bws-token-123";
const OP_TOKEN: &str = "ops-token-456";
const CONNECT_TOKEN: &str = "connect-token-789";
pub(crate) const SECRET_ID: &str = "2b7f2c5e-1a3d-4c4e-9b8a-0123456789ab";

fn actor() -> AuditActor {
    AuditActor::new("operator", None)
}

fn consumer(subject: &str) -> Consumer {
    Consumer {
        subject: subject.to_owned(),
        requested_by: subject.to_owned(),
        environment: "default".to_owned(),
        machine_policies: None,
        policy_subjects: Vec::new(),
    }
}

/// A fake CLI in `dir` that logs each call (never the token itself) to
/// `calls.log`: its argv, whether the token appeared in argv, and whether the
/// expected token arrived in the environment.
fn fake_cli(dir: &Path, name: &str) -> PathBuf {
    let log = dir.join("calls.log");
    let body = match name {
        "bws" => format!(
            r#"#!/bin/sh
log="{log}"
printf 'argv:%s\n' "$*" >> "$log"
case "$*" in *{BWS_TOKEN}*) echo "token-in-argv:yes" >> "$log";; *) echo "token-in-argv:no" >> "$log";; esac
if [ "$BWS_ACCESS_TOKEN" = "{BWS_TOKEN}" ]; then echo "env-token:yes" >> "$log"; else echo "env-token:no" >> "$log"; fi
if [ "$BWS_ACCESS_TOKEN" != "{BWS_TOKEN}" ]; then echo "Error: 401 Unauthorized" >&2; exit 1; fi
if [ "$1 $2" = "secret get" ]; then
  if [ "$3" = "{SECRET_ID}" ]; then
    printf '{{"id":"%s","key":"API_KEY","value":"bw-secret-value","note":""}}' "$3"
    exit 0
  fi
  echo "Error: Resource not found" >&2; exit 1
fi
if [ "$1 $2" = "project list" ]; then printf '[]'; exit 0; fi
echo "unexpected" >&2; exit 2
"#,
            log = log.display()
        ),
        _ => format!(
            r#"#!/bin/sh
log="{log}"
printf 'argv:%s\n' "$*" >> "$log"
case "$*" in *{OP_TOKEN}*) echo "token-in-argv:yes" >> "$log";; *) echo "token-in-argv:no" >> "$log";; esac
if [ "$OP_SERVICE_ACCOUNT_TOKEN" = "{OP_TOKEN}" ]; then echo "env-token:yes" >> "$log"; else echo "env-token:no" >> "$log"; fi
if [ "$OP_SERVICE_ACCOUNT_TOKEN" != "{OP_TOKEN}" ]; then echo "[ERROR] authentication failed: invalid token" >&2; exit 1; fi
if [ "$1" = "read" ] && [ "$3" = "op://dev/GitHub/token" ]; then printf 'op-secret-value'; exit 0; fi
if [ "$1" = "read" ]; then echo "[ERROR] \"x\" isn't an item in the \"dev\" vault" >&2; exit 1; fi
if [ "$1 $2" = "vault list" ]; then printf '[]'; exit 0; fi
echo "unexpected" >&2; exit 2
"#,
            log = log.display()
        ),
    };
    let path = dir.join(name);
    std::fs::write(&path, body).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}

fn calls(dir: &Path) -> Vec<String> {
    std::fs::read_to_string(dir.join("calls.log"))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

pub(crate) fn invocations(dir: &Path) -> usize {
    calls(dir)
        .iter()
        .filter(|line| line.starts_with("argv:"))
        .count()
}

pub(crate) async fn add_cli_account(
    store: &PluginSecretStore,
    dir: &Path,
    name: &str,
    provider: &str,
    token: &str,
) -> AccountRecord {
    let binary = fake_cli(
        dir,
        if provider == "bitwarden-sm" {
            "bws"
        } else {
            "op"
        },
    );
    set_binary_for_test(Some(binary));
    let input: AccountInput = serde_json::from_value(json!({
        "name": name, "provider": provider, "token": token,
    }))
    .unwrap();
    let created = store.pm_account_create(input, &actor()).await;
    set_binary_for_test(None);
    created.unwrap()
}

fn value(outcome: PmOutcome) -> String {
    match outcome {
        PmOutcome::Value(value) => value.into_string().unwrap(),
        PmOutcome::Pending(proposal) => panic!("pending {}", proposal.id),
    }
}

fn pending(outcome: PmOutcome) -> Proposal {
    match outcome {
        PmOutcome::Pending(proposal) => proposal,
        PmOutcome::Value(_) => panic!("resolved without approval"),
    }
}

async fn audit_rows(store: &PluginSecretStore) -> Vec<crate::vault::audit::AuditRow> {
    let conn = store.conn.lock().await;
    crate::vault::audit::list(
        &conn,
        &AuditFilter {
            limit: 500,
            ..AuditFilter::default()
        },
    )
    .unwrap()
}

// ── References ────────────────────────────────────────────────────────────

#[test]
fn references_follow_the_grammar() {
    let plain = PmRef::parse("op://dev/GitHub/token").unwrap();
    assert_eq!(plain.account, None);
    assert_eq!(plain.provider_ref(), "op://dev/GitHub/token");
    assert_eq!(plain.qualified("work"), "op://work@dev/GitHub/token");
    assert_eq!(plain.op_parts(), Some(("dev", "GitHub", None, "token")));
    let sectioned = PmRef::parse("op://work@Shared Vault/API keys/prod/key").unwrap();
    assert_eq!(sectioned.account.as_deref(), Some("work"));
    assert_eq!(
        sectioned.op_parts(),
        Some(("Shared Vault", "API keys", Some("prod"), "key"))
    );
    assert_eq!(
        sectioned.provider_ref(),
        "op://Shared Vault/API keys/prod/key"
    );
    let bws = PmRef::parse(&format!("bws://team@{SECRET_ID}")).unwrap();
    assert_eq!(bws.scheme, PmScheme::Bws);
    assert_eq!(bws.provider_ref(), SECRET_ID);
    for bad in [
        "op://dev/GitHub",
        "op://a/b/c/d/e",
        "op://dev/../token",
        "op://dev//token",
        "op://dev/Git\"Hub/token",
        "op://dev/GitHub/token?attribute=otp",
        "op://Bad Name@dev/GitHub/token",
        "op:// dev/GitHub/token",
        "bws://not-a-uuid",
        "bws://2b7f2c5e1a3d4c4e9b8a0123456789ab",
        "secret:op://dev/GitHub/token",
    ] {
        assert!(PmRef::parse(bad).is_none(), "{bad}");
    }
}

#[test]
fn secrets_are_redacted_and_zeroed() {
    let secret = Secret::new("hunter2".to_owned());
    assert_eq!(format!("{secret:?}"), "Secret(<redacted>)");
    let mut text = "hunter2".to_owned();
    wipe_string(&mut text);
    assert!(text.is_empty());
    let mut bytes = b"hunter2".to_vec();
    wipe(&mut bytes);
    assert_eq!(bytes, vec![0; 7]);
}

// ── Accounts ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn tokens_are_sealed_and_never_returned() {
    assert!(crate::vault::ENCRYPTED_TABLES.contains(&"vault_pm_accounts"));
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    let account = add_cli_account(&store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    assert_eq!(account.state, AccountState::Connected);
    assert!(account.binary_path.as_deref().unwrap().ends_with("bws"));
    let listed = serde_json::to_string(&store.pm_account_list().await.unwrap()).unwrap();
    assert!(!listed.contains(BWS_TOKEN));
    let conn = store.conn.lock().await;
    let ciphertext: Vec<u8> = conn
        .query_row(
            "SELECT ciphertext FROM vault_pm_accounts WHERE id = ?1",
            params![account.id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!ciphertext
        .windows(BWS_TOKEN.len())
        .any(|window| window == BWS_TOKEN.as_bytes()));
    drop(conn);
    let audit = serde_json::to_string(&audit_rows(&store).await).unwrap();
    assert!(!audit.contains(BWS_TOKEN));
}

#[tokio::test]
async fn accounts_validate_their_shape() {
    let store = PluginSecretStore::in_memory().unwrap();
    let create = |body: Value| {
        let store = &store;
        async move {
            let input: AccountInput = serde_json::from_value(body).unwrap();
            store.pm_account_create(input, &actor()).await
        }
    };
    // Connect needs an address; a service account takes none.
    assert!(
        create(json!({ "name": "a", "provider": "1password-connect", "token": "t" }))
            .await
            .is_err()
    );
    // Link-local and metadata addresses are refused by the SSRF guard.
    assert!(create(json!({
        "name": "a", "provider": "1password-connect",
        "address": "https://169.254.169.254", "token": "t",
    }))
    .await
    .is_err());
    set_binary_for_test(Some(PathBuf::from("/definitely/not/op")));
    let missing = create(json!({
        "name": "a", "provider": "1password-service-account", "token": "t",
    }))
    .await;
    set_binary_for_test(None);
    assert!(missing.is_err());
    assert!(create(json!({
        "name": "a", "provider": "1password-service-account",
        "address": "https://x.example", "token": "t",
    }))
    .await
    .is_err());
    // Empty or multi-line tokens, bad names.
    for body in [
        json!({ "name": "a", "provider": "1password-connect", "address": "http://127.0.0.1:9", "token": " " }),
        json!({ "name": "a", "provider": "1password-connect", "address": "http://127.0.0.1:9", "token": "a\nb" }),
        json!({ "name": "Bad", "provider": "1password-connect", "address": "http://127.0.0.1:9", "token": "t" }),
    ] {
        assert!(create(body).await.is_err());
    }
    create(json!({
        "name": "a", "provider": "1password-connect", "address": "http://127.0.0.1:9", "token": "t",
    }))
    .await
    .unwrap();
    let duplicate = create(json!({
        "name": "a", "provider": "1password-connect", "address": "http://127.0.0.1:9", "token": "t",
    }))
    .await
    .unwrap_err();
    assert!(matches!(
        duplicate.downcast_ref::<VaultError>(),
        Some(VaultError::Conflict(_))
    ));
}

// ── Approval gating (Bitwarden) ───────────────────────────────────────────

#[tokio::test]
async fn first_use_waits_for_approval_without_calling_the_provider() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    add_cli_account(&store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    let reference = format!("bws://{SECRET_ID}");

    let request = pending(
        store
            .pm_resolve(&reference, &consumer("machine:m1"), &actor())
            .await
            .unwrap(),
    );
    let credential_use = request.credential_use.clone().unwrap();
    assert_eq!(credential_use.subject, "machine:m1");
    assert_eq!(credential_use.reference, format!("bws://team@{SECRET_ID}"));
    assert_eq!(credential_use.provider, "bitwarden-sm");
    assert_eq!(
        invocations(dir.path()),
        0,
        "the provider was contacted before approval"
    );
    // Retrying returns the same request.
    let again = pending(
        store
            .pm_resolve(&reference, &consumer("machine:m1"), &actor())
            .await
            .unwrap(),
    );
    assert_eq!(again.id, request.id);
    assert_eq!(invocations(dir.path()), 0);

    store
        .pm_approve(&request.id, GrantMode::Once, "ok", "user:alice", &actor())
        .await
        .unwrap();
    // Another consumer still needs its own approval.
    pending(
        store
            .pm_resolve(&reference, &consumer("machine:m2"), &actor())
            .await
            .unwrap(),
    );
    assert_eq!(invocations(dir.path()), 0);

    let resolved = value(
        store
            .pm_resolve(&reference, &consumer("machine:m1"), &actor())
            .await
            .unwrap(),
    );
    assert_eq!(resolved, "bw-secret-value");
    let log = calls(dir.path());
    assert_eq!(
        log.iter()
            .filter(|l| l.starts_with("argv:"))
            .collect::<Vec<_>>(),
        vec![&format!("argv:secret get {SECRET_ID} --output json")]
    );
    assert!(log.contains(&"token-in-argv:no".to_owned()));
    assert!(log.contains(&"env-token:yes".to_owned()));
    assert!(!log.iter().any(|l| l == "token-in-argv:yes"));

    // Approve-once is spent: the next use asks again, without a provider call.
    let next = pending(
        store
            .pm_resolve(&reference, &consumer("machine:m1"), &actor())
            .await
            .unwrap(),
    );
    assert_ne!(next.id, request.id);
    assert_eq!(invocations(dir.path()), 1);

    // Every resolution is audited with provider, account, and reference, but
    // never the value.
    let rows = audit_rows(&store).await;
    let resolves: Vec<_> = rows.iter().filter(|r| r.action == "pm.resolve").collect();
    assert!(resolves.iter().any(|r| r.outcome == "ok"));
    assert!(resolves.iter().any(|r| r.outcome == "pending"));
    let text = serde_json::to_string(&rows).unwrap();
    assert!(text.contains("bitwarden-sm") && text.contains(&format!("bws://team@{SECRET_ID}")));
    assert!(!text.contains("bw-secret-value"));
}

#[tokio::test]
async fn ttl_grants_last_until_revoked_or_expired() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    add_cli_account(&store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    let reference = format!("bws://{SECRET_ID}");
    let request = pending(
        store
            .pm_resolve(&reference, &consumer("user:bob"), &actor())
            .await
            .unwrap(),
    );
    // The default approval is 30 days.
    let grant = store
        .pm_approve(&request.id, GrantMode::default(), "", "operator", &actor())
        .await
        .unwrap();
    assert_eq!(grant.mode, GrantMode::Month);
    assert_eq!(grant.uses_remaining, None);
    let days = (grant.expires_at - grant.created_at) / (24 * 3600 * 1000);
    assert_eq!(days, 30);
    // An approved request cannot be approved again.
    assert!(store
        .pm_approve(&request.id, GrantMode::Hour, "", "operator", &actor())
        .await
        .is_err());
    for _ in 0..3 {
        assert_eq!(
            value(
                store
                    .pm_resolve(&reference, &consumer("user:bob"), &actor())
                    .await
                    .unwrap()
            ),
            "bw-secret-value"
        );
    }
    assert_eq!(store.pm_grant_list(false).await.unwrap().len(), 1);

    store.pm_grant_revoke(&grant.id, &actor()).await.unwrap();
    assert!(store.pm_grant_list(false).await.unwrap().is_empty());
    assert_eq!(store.pm_grant_list(true).await.unwrap().len(), 1);
    let before = invocations(dir.path());
    pending(
        store
            .pm_resolve(&reference, &consumer("user:bob"), &actor())
            .await
            .unwrap(),
    );
    assert_eq!(invocations(dir.path()), before);

    // An expired grant no longer resolves.
    let request = pending(
        store
            .pm_resolve(&reference, &consumer("user:carol"), &actor())
            .await
            .unwrap(),
    );
    let grant = store
        .pm_approve(&request.id, GrantMode::Hour, "", "operator", &actor())
        .await
        .unwrap();
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE vault_pm_grants SET expires_at = ?1 WHERE id = ?2",
            params![now_millis() - 1, grant.id],
        )
        .unwrap();
    }
    pending(
        store
            .pm_resolve(&reference, &consumer("user:carol"), &actor())
            .await
            .unwrap(),
    );
    assert_eq!(invocations(dir.path()), before);
}

#[tokio::test]
async fn rejected_requests_grant_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    add_cli_account(&store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    let reference = format!("bws://{SECRET_ID}");
    let request = pending(
        store
            .pm_resolve(&reference, &consumer("user:bob"), &actor())
            .await
            .unwrap(),
    );
    store
        .pm_reject(&request.id, "no", "operator", &actor())
        .await
        .unwrap();
    assert_eq!(
        store.pm_approval(&request.id).await.unwrap().status,
        ProposalStatus::Rejected
    );
    assert!(store
        .pm_approve(&request.id, GrantMode::Once, "", "operator", &actor())
        .await
        .is_err());
    pending(
        store
            .pm_resolve(&reference, &consumer("user:bob"), &actor())
            .await
            .unwrap(),
    );
    assert_eq!(invocations(dir.path()), 0);
}

#[tokio::test]
async fn fail_closed_audit_withholds_the_value_and_keeps_the_approval() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    add_cli_account(&store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    let reference = format!("bws://{SECRET_ID}");
    let request = pending(
        store
            .pm_resolve(&reference, &consumer("user:bob"), &actor())
            .await
            .unwrap(),
    );
    let grant = store
        .pm_approve(&request.id, GrantMode::Once, "", "operator", &actor())
        .await
        .unwrap();
    crate::vault::audit_devices::set_fail_closed_for_test(Some(true));
    let refused = store
        .pm_resolve(&reference, &consumer("user:bob"), &actor())
        .await;
    crate::vault::audit_devices::set_fail_closed_for_test(None);
    assert!(matches!(
        refused.unwrap_err().downcast_ref::<VaultError>(),
        Some(VaultError::AuditUnavailable)
    ));
    // The approve-once use was given back.
    assert_eq!(
        store.pm_grant(&grant.id).await.unwrap().uses_remaining,
        Some(1)
    );
    assert_eq!(
        value(
            store
                .pm_resolve(&reference, &consumer("user:bob"), &actor())
                .await
                .unwrap()
        ),
        "bw-secret-value"
    );
    assert_eq!(
        store.pm_grant(&grant.id).await.unwrap().uses_remaining,
        Some(0)
    );
}

#[tokio::test]
async fn a_rejected_token_marks_the_account_for_reconnect() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    let account = add_cli_account(&store, dir.path(), "team", "bitwarden-sm", "wrong-token").await;
    let failure = store
        .pm_account_test(&account.id, &actor())
        .await
        .unwrap_err();
    let failure = failure.downcast_ref::<ProviderFailure>().unwrap();
    assert_eq!(failure.kind, FailureKind::Auth);
    // The sanitized error never echoes provider output.
    assert!(!failure.message.contains("Unauthorized"));
    let account = store.pm_account(&account.id).await.unwrap();
    assert_eq!(account.state, AccountState::ReconnectRequired);
    assert!(account.last_error.is_some());
    let account = store
        .pm_account_set_token(&account.id, BWS_TOKEN.to_owned(), &actor())
        .await
        .unwrap();
    assert_eq!(account.state, AccountState::Connected);
    store.pm_account_test(&account.id, &actor()).await.unwrap();
    assert!(calls(dir.path()).contains(&"argv:project list --output json".to_owned()));
}

#[tokio::test]
async fn machine_sessions_need_use_on_the_account() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    add_cli_account(&store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    let reference = format!("bws://{SECRET_ID}");
    let mut machine = consumer("machine:m1");
    machine.machine_policies = Some(Vec::new());
    let denied = store
        .pm_resolve(&reference, &machine, &actor())
        .await
        .unwrap_err();
    assert!(matches!(
        denied.downcast_ref::<VaultError>(),
        Some(VaultError::Denied(_))
    ));
    assert!(store
        .pm_approvals(Some(ProposalStatus::Pending))
        .await
        .unwrap()
        .is_empty());
    machine.machine_policies = Some(vec![Policy {
        name: "pm".into(),
        description: String::new(),
        rules: vec![crate::vault::policy::PolicyRule {
            path: "sys/password-managers/team".into(),
            capabilities: vec![Capability::Use],
            ..Default::default()
        }],
    }]);
    pending(
        store
            .pm_resolve(&reference, &machine, &actor())
            .await
            .unwrap(),
    );
    assert_eq!(invocations(dir.path()), 0);
}

#[tokio::test]
async fn removing_an_account_drops_its_grants_and_requests() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    let account = add_cli_account(&store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    let reference = format!("bws://{SECRET_ID}");
    let first = pending(
        store
            .pm_resolve(&reference, &consumer("user:a"), &actor())
            .await
            .unwrap(),
    );
    store
        .pm_approve(&first.id, GrantMode::Day, "", "operator", &actor())
        .await
        .unwrap();
    let open = pending(
        store
            .pm_resolve(&reference, &consumer("user:b"), &actor())
            .await
            .unwrap(),
    );
    store
        .pm_account_delete(&account.id, &actor())
        .await
        .unwrap();
    assert!(store.pm_grant_list(true).await.unwrap().is_empty());
    assert_eq!(
        store.pm_approval(&open.id).await.unwrap().status,
        ProposalStatus::Rejected
    );
    let missing = store
        .pm_resolve(&reference, &consumer("user:a"), &actor())
        .await
        .unwrap_err();
    assert!(matches!(
        missing.downcast_ref::<VaultError>(),
        Some(VaultError::NotFound(_))
    ));
}

#[tokio::test]
async fn several_accounts_of_a_family_need_a_qualified_reference() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    add_cli_account(&store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    add_cli_account(&store, dir.path(), "ops", "bitwarden-sm", BWS_TOKEN).await;
    let ambiguous = store
        .pm_resolve(&format!("bws://{SECRET_ID}"), &consumer("user:a"), &actor())
        .await
        .unwrap_err();
    assert!(matches!(
        ambiguous.downcast_ref::<VaultError>(),
        Some(VaultError::Invalid(_))
    ));
    let request = pending(
        store
            .pm_resolve(
                &format!("bws://ops@{SECRET_ID}"),
                &consumer("user:a"),
                &actor(),
            )
            .await
            .unwrap(),
    );
    assert_eq!(request.credential_use.unwrap().account, "ops");
    // A 1Password reference does not match a Bitwarden account.
    let none = store
        .pm_resolve("op://dev/GitHub/token", &consumer("user:a"), &actor())
        .await
        .unwrap_err();
    assert!(matches!(
        none.downcast_ref::<VaultError>(),
        Some(VaultError::NotFound(_))
    ));
}

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

// ── 1Password service account (`op`) ──────────────────────────────────────

#[tokio::test]
async fn service_accounts_shell_out_to_op_with_the_token_in_env_only() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    add_cli_account(
        &store,
        dir.path(),
        "svc",
        "1password-service-account",
        OP_TOKEN,
    )
    .await;
    let request = pending(
        store
            .pm_resolve("op://svc@dev/GitHub/token", &consumer("user:a"), &actor())
            .await
            .unwrap(),
    );
    store
        .pm_approve(&request.id, GrantMode::Once, "", "operator", &actor())
        .await
        .unwrap();
    // The account qualifier is optional with one account; the grant key is the
    // qualified reference either way.
    assert_eq!(
        value(
            store
                .pm_resolve("op://dev/GitHub/token", &consumer("user:a"), &actor())
                .await
                .unwrap()
        ),
        "op-secret-value"
    );
    let log = calls(dir.path());
    assert!(log.contains(&"argv:read --no-newline op://dev/GitHub/token".to_owned()));
    assert!(log.contains(&"token-in-argv:no".to_owned()));
    assert!(log.contains(&"env-token:yes".to_owned()));

    // A missing item is a sanitized not-found, and the once grant survives.
    let request = pending(
        store
            .pm_resolve("op://dev/Missing/token", &consumer("user:a"), &actor())
            .await
            .unwrap(),
    );
    let grant = store
        .pm_approve(&request.id, GrantMode::Once, "", "operator", &actor())
        .await
        .unwrap();
    let missing = store
        .pm_resolve("op://dev/Missing/token", &consumer("user:a"), &actor())
        .await
        .unwrap_err();
    let failure = missing.downcast_ref::<ProviderFailure>().unwrap();
    assert_eq!(failure.kind, FailureKind::NotFound);
    assert!(!failure.message.contains("isn't an item"));
    assert_eq!(
        store.pm_grant(&grant.id).await.unwrap().uses_remaining,
        Some(1)
    );
}

// ── 1Password Connect ─────────────────────────────────────────────────────

#[derive(Default)]
struct ConnectFake {
    hits: usize,
    queries: Vec<String>,
}

const VAULT_ID: &str = "vvvvvvvvvvvvvvvvvvvvvvvvv1";
const ITEM_ID: &str = "iiiiiiiiiiiiiiiiiiiiiiiii1";

async fn connect_handler(
    State(fake): State<Arc<Mutex<ConnectFake>>>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let mut fake = fake.lock().unwrap();
    fake.hits += 1;
    fake.queries
        .push(uri.query().unwrap_or_default().to_owned());
    let authorized = headers.get("authorization").and_then(|v| v.to_str().ok())
        == Some(&format!("Bearer {CONNECT_TOKEN}"));
    if !authorized {
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(json!({ "message": "bad token" })),
        )
            .into_response();
    }
    let query = url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
        .find(|(key, _)| key == "filter")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    let body = match uri.path() {
        "/v1/vaults" if query.contains("name eq \"dev\"") => {
            json!([{ "id": VAULT_ID, "name": "dev" }])
        }
        "/v1/vaults" if query.is_empty() => json!([{ "id": VAULT_ID, "name": "dev" }]),
        "/v1/vaults" => json!([]),
        p if p == format!("/v1/vaults/{VAULT_ID}/items")
            && query.contains("title eq \"GitHub\"") =>
        {
            json!([{ "id": ITEM_ID, "title": "GitHub" }])
        }
        p if p == format!("/v1/vaults/{VAULT_ID}/items") => json!([]),
        p if p == format!("/v1/vaults/{VAULT_ID}/items/{ITEM_ID}") => json!({
            "id": ITEM_ID,
            "sections": [{ "id": "s1", "label": "api" }],
            "fields": [
                { "id": "username", "label": "username", "value": "octocat" },
                { "id": "f1", "label": "token", "value": "connect-secret-value", "section": { "id": "s1" } },
            ],
        }),
        _ => return (StatusCode::NOT_FOUND, axum::Json(json!({}))).into_response(),
    };
    (StatusCode::OK, axum::Json(body)).into_response()
}

async fn serve_connect() -> (String, Arc<Mutex<ConnectFake>>) {
    let fake = Arc::new(Mutex::new(ConnectFake::default()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = axum::Router::new()
        .fallback(connect_handler)
        .with_state(fake.clone());
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });
    (format!("http://{addr}"), fake)
}

async fn add_connect(store: &PluginSecretStore, address: &str, token: &str) -> AccountRecord {
    let input: AccountInput = serde_json::from_value(json!({
        "name": "work", "provider": "1password-connect", "address": address, "token": token,
    }))
    .unwrap();
    store.pm_account_create(input, &actor()).await.unwrap()
}

#[tokio::test]
async fn connect_resolves_by_vault_and_item_title_after_approval() {
    let (address, fake) = serve_connect().await;
    let store = PluginSecretStore::in_memory().unwrap();
    let account = add_connect(&store, &address, CONNECT_TOKEN).await;
    store.pm_account_test(&account.id, &actor()).await.unwrap();
    let after_test = fake.lock().unwrap().hits;

    let reference = "op://dev/GitHub/api/token";
    let request = pending(
        store
            .pm_resolve(reference, &consumer("user:a"), &actor())
            .await
            .unwrap(),
    );
    assert_eq!(
        fake.lock().unwrap().hits,
        after_test,
        "Connect was contacted before approval"
    );
    store
        .pm_approve(&request.id, GrantMode::Hour, "", "operator", &actor())
        .await
        .unwrap();
    assert_eq!(
        value(
            store
                .pm_resolve(reference, &consumer("user:a"), &actor())
                .await
                .unwrap()
        ),
        "connect-secret-value"
    );
    let request = pending(
        store
            .pm_resolve("op://dev/GitHub/username", &consumer("user:a"), &actor())
            .await
            .unwrap(),
    );
    store
        .pm_approve(&request.id, GrantMode::Hour, "", "operator", &actor())
        .await
        .unwrap();
    assert_eq!(
        value(
            store
                .pm_resolve("op://dev/GitHub/username", &consumer("user:a"), &actor())
                .await
                .unwrap()
        ),
        "octocat"
    );
    let queries = fake.lock().unwrap().queries.clone();
    assert!(queries.iter().any(|q| q.contains("filter=")));
}

#[tokio::test]
async fn connect_rejecting_the_token_requires_reconnect() {
    let (address, _fake) = serve_connect().await;
    let store = PluginSecretStore::in_memory().unwrap();
    let account = add_connect(&store, &address, "stale-token").await;
    let request = pending(
        store
            .pm_resolve("op://dev/GitHub/username", &consumer("user:a"), &actor())
            .await
            .unwrap(),
    );
    store
        .pm_approve(&request.id, GrantMode::Day, "", "operator", &actor())
        .await
        .unwrap();
    let refused = store
        .pm_resolve("op://dev/GitHub/username", &consumer("user:a"), &actor())
        .await
        .unwrap_err();
    assert_eq!(
        refused.downcast_ref::<ProviderFailure>().unwrap().kind,
        FailureKind::Auth
    );
    assert_eq!(
        store.pm_account(&account.id).await.unwrap().state,
        AccountState::ReconnectRequired
    );
    let rows = audit_rows(&store).await;
    assert!(rows
        .iter()
        .any(|r| r.action == "pm.resolve" && r.outcome == "reconnect_required"));
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
