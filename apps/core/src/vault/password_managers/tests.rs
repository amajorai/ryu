//! Password-manager tests against fake `op` / `bws` binaries (tiny shell or
//! batch scripts that log their invocations) and a local fake 1Password Connect
//! server. No real provider is contacted.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

use super::*;
use crate::vault::audit::AuditFilter;
use fake_cli::{fake_cli, fake_cli_file_name};

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

mod approvals;
mod fake_cli;
mod providers;
mod runtime;
