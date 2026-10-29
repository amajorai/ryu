//! `POST /v1/doctor/fix`: dry runs write nothing, real runs persist and hot-swap
//! only the allowlisted protective firewall repairs, and only a local admin may
//! call it.

use super::{fix_doctor, DoctorFixRequest, DoctorFixResult};
use crate::audit::AuditLogger;
use crate::config::test_config_path::ConfigPathGuard;
use crate::config::{AuditConfig, EvalsConfig, ExecBudgetAction, GatewayConfig};
use crate::error::GatewayError;
use crate::evals::EvalsRunner;
use crate::state::{AppState, SharedState};
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::Json;
use std::net::SocketAddr;
use std::sync::Arc;

/// A local node with two auto-fixable firewall findings (both scan directions
/// and both redaction kinds off, so a repair that sets only half of a pair is
/// caught), one finding that is deliberately not auto-fixable
/// (an exec stop budget with no limits), and one non-default firewall field
/// that no fix may touch.
fn weakened_config() -> GatewayConfig {
    let mut config = GatewayConfig::default();
    config.auth.require_auth = false;
    config.firewall.scan_inbound = false;
    config.firewall.scan_outbound = false;
    config.firewall.redact_pii = false;
    config.firewall.redact_secrets = false;
    config.firewall.log_detections = false;
    config.exec_budget.action = ExecBudgetAction::Stop;
    config.exec_budget.max_count = 0;
    config.exec_budget.max_wall_clock_secs = 0;
    config
}

fn state_for(config: GatewayConfig) -> SharedState {
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("audit logger");
    Arc::new(AppState::new_for_test(
        config,
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ))
}

fn loopback() -> ConnectInfo<SocketAddr> {
    ConnectInfo("127.0.0.1:4244".parse().unwrap())
}

fn fix_ids(result: &DoctorFixResult, applied: bool) -> Vec<String> {
    let fixes = if applied {
        &result.applied_fixes
    } else {
        &result.planned_fixes
    };
    let mut ids: Vec<String> = fixes.iter().map(|fix| fix.check_id.clone()).collect();
    ids.sort();
    ids
}

fn finding_ids(result: &DoctorFixResult) -> Vec<String> {
    result
        .report
        .findings
        .iter()
        .map(|finding| finding.check_id.clone())
        .collect()
}

fn live_firewall(state: &SharedState) -> crate::config::FirewallConfig {
    state.with_firewall(|firewall| firewall.config().clone())
}

const EXPECTED_FIXES: [&str; 2] = [
    "security.partial-firewall-scan",
    "security.redaction-disabled",
];

#[tokio::test]
async fn dry_run_plans_fixes_without_writing_or_hot_swapping() {
    let file = ConfigPathGuard::isolated("doctor-fix-dry-run");
    let config = weakened_config();
    config.save().expect("seed gateway.toml");
    let before_bytes = std::fs::read(file.path()).expect("read seeded config");
    let state = state_for(config);
    let before_firewall = live_firewall(&state);

    let Json(result) = fix_doctor(
        State(Arc::clone(&state)),
        loopback(),
        HeaderMap::new(),
        Json(DoctorFixRequest { dry_run: true }),
    )
    .await
    .expect("local admin may dry-run fixes");

    assert!(result.dry_run);
    assert_eq!(fix_ids(&result, false), EXPECTED_FIXES);
    assert!(result.applied_fixes.is_empty(), "a dry run applies nothing");
    assert_eq!(
        std::fs::read(file.path()).expect("read config"),
        before_bytes,
        "a dry run must not write gateway.toml"
    );
    assert_eq!(
        live_firewall(&state),
        before_firewall,
        "a dry run must not hot-swap"
    );
    for id in EXPECTED_FIXES {
        assert!(
            finding_ids(&result).iter().any(|found| found == id),
            "{id} still reported"
        );
    }
}

#[tokio::test]
async fn real_run_persists_and_applies_only_allowlisted_firewall_fixes() {
    let _file = ConfigPathGuard::isolated("doctor-fix-apply");
    let config = weakened_config();
    config.save().expect("seed gateway.toml");
    let state = state_for(config);

    let Json(result) = fix_doctor(
        State(Arc::clone(&state)),
        loopback(),
        HeaderMap::new(),
        Json(DoctorFixRequest { dry_run: false }),
    )
    .await
    .expect("local admin may apply fixes");

    assert!(!result.dry_run);
    assert_eq!(fix_ids(&result, true), EXPECTED_FIXES);

    // Takes effect live…
    let live = live_firewall(&state);
    assert!(live.scan_inbound && live.scan_outbound);
    assert!(live.redact_pii && live.redact_secrets);
    assert!(
        !live.log_detections,
        "non-repair firewall fields are preserved"
    );

    // …and persists.
    let saved = GatewayConfig::load().expect("reload gateway.toml");
    assert!(saved.firewall.scan_inbound && saved.firewall.scan_outbound);
    assert!(saved.firewall.redact_pii && saved.firewall.redact_secrets);
    assert!(!saved.firewall.log_detections);

    // The non-allowlisted finding is left for the operator.
    assert_eq!(saved.exec_budget.action, ExecBudgetAction::Stop);
    assert_eq!(saved.exec_budget.max_count, 0);
    let after = finding_ids(&result);
    assert!(after
        .iter()
        .any(|id| id == "security.exec-budget-stop-ineffective"));
    for id in EXPECTED_FIXES {
        assert!(!after.iter().any(|found| found == id), "{id} was repaired");
    }
}

#[tokio::test]
async fn non_admin_callers_cannot_apply_fixes() {
    let file = ConfigPathGuard::isolated("doctor-fix-denied");
    let config = weakened_config();
    config.save().expect("seed gateway.toml");
    let before_bytes = std::fs::read(file.path()).expect("read seeded config");
    let state = state_for(config);
    let before_firewall = live_firewall(&state);

    let remote = fix_doctor(
        State(Arc::clone(&state)),
        ConnectInfo("203.0.113.7:443".parse().unwrap()),
        HeaderMap::new(),
        Json(DoctorFixRequest { dry_run: false }),
    )
    .await;
    assert!(matches!(remote, Err(GatewayError::Unauthorized(_))));

    // The dry-run plan is itself admin-only (it never reaches the config write
    // path, so the doctor's own gate is the only one in front of it).
    let remote_plan = fix_doctor(
        State(Arc::clone(&state)),
        ConnectInfo("203.0.113.7:443".parse().unwrap()),
        HeaderMap::new(),
        Json(DoctorFixRequest { dry_run: true }),
    )
    .await;
    assert!(
        matches!(remote_plan, Err(GatewayError::Unauthorized(_))),
        "a network peer must not read the doctor plan"
    );

    // A provisioned master key closes the anonymous loopback path too.
    let mut locked = weakened_config();
    locked.auth.master_key = Some("sk-doctor-master".to_owned());
    let locked_state = state_for(locked);
    let locked_before = live_firewall(&locked_state);
    let anon_loopback = fix_doctor(
        State(Arc::clone(&locked_state)),
        loopback(),
        HeaderMap::new(),
        Json(DoctorFixRequest { dry_run: false }),
    )
    .await;
    assert!(matches!(anon_loopback, Err(GatewayError::Unauthorized(_))));

    assert_eq!(
        std::fs::read(file.path()).expect("read config"),
        before_bytes
    );
    assert_eq!(live_firewall(&state), before_firewall);
    assert_eq!(live_firewall(&locked_state), locked_before);
}
