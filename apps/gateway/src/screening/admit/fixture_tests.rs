//! Shared fixtures for the fail-rule suites (`health_tests`, the output
//! `fail_tests`): a gateway state over deterministic `TestBackend`s, built
//! without a router. Content is the spec 00.9 sentinels and neutral filler.

use std::sync::Arc;

use ryu_gw_screening::backends::test::TestBackend;
use ryu_gw_screening::ScreenerBackend;
use serde_json::{json, Value};

use crate::audit::{AuditConfig, AuditLogger};
use crate::config::{GatewayConfig, ScreeningBackendKind, ScreeningConfig};
use crate::custody::GatewayCustody;
use crate::evals::EvalsRunner;
use crate::pipeline::RequestContext;
use crate::platform_floor::{FloorStore, PlatformFloor};
use crate::screening::ScreeningRuntime;
use crate::state::AppState;

pub(crate) const ZEROS: &str = "0000000000000000";

/// A `[screening]` section from TOML, so a test names `node_fail_mode` the
/// way an operator writes it.
pub(crate) fn screening_config(toml_text: &str) -> ScreeningConfig {
    toml::from_str(toml_text).expect("screening config parses")
}

pub(crate) fn runtime(config: &ScreeningConfig, backends: &[Arc<TestBackend>]) -> ScreeningRuntime {
    ScreeningRuntime::with_backends(
        config,
        backends
            .iter()
            .map(|backend| {
                (
                    Arc::clone(backend) as Arc<dyn ScreenerBackend>,
                    ScreeningBackendKind::DecisionLocal,
                    None,
                )
            })
            .collect(),
    )
}

/// A qualification of a `TestBackend` with `id` for `codes`.
pub(crate) fn qualification(id: &str, codes: &[&str]) -> Value {
    json!({
        "backendId": id,
        "model": "test-model",
        "weightsSha256": ZEROS,
        "templateVersion": 1,
        "codes": codes,
        "evalRef": "eval_test_sentinels",
    })
}

/// The floor's `screener`: `decision_local` fills every role and is
/// qualified for S4 and S9; `extra` replaces top-level keys.
pub(crate) fn screener(extra: Value) -> Value {
    let mut screener = json!({
        "templateVersion": 1,
        "roles": {
            "textHazard": ["decision_local"],
            "promptAttack": ["decision_local"],
            "output": ["decision_local"],
        },
        "qualifications": [qualification("decision_local", &["hazard.S4", "hazard.S9"])],
    });
    if let (Some(target), Some(extra)) = (screener.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            target.insert(key.clone(), value.clone());
        }
    }
    screener
}

pub(crate) fn floor(screener: Value) -> Arc<PlatformFloor> {
    let floor = json!({
        "version": 3,
        "contentHash": "test",
        "overlay": { "enabled": true, "scan_inbound": true, "policy": "block" },
        "screener": screener,
    });
    PlatformFloor::from_wire(Some(&floor), false).expect("test floor parses")
}

/// A state on `custody` screening with `runtime`. `screening` is the
/// gateway's own `[screening]` section (the node's `node_fail_mode`).
pub(crate) fn state(
    custody: GatewayCustody,
    runtime: ScreeningRuntime,
    floor: Option<Arc<PlatformFloor>>,
    screening: ScreeningConfig,
) -> Arc<AppState> {
    let mut config = GatewayConfig::default();
    config.screening = screening;
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let mut state = AppState::new_for_test(config, audit, EvalsRunner::new(Default::default()));
    state.custody = custody;
    state.screening = Arc::new(runtime);
    if let Some(floor) = floor {
        state.platform_floor = FloorStore::with(floor);
    }
    Arc::new(state)
}

/// A context with its own request id, so each request is its own sample.
pub(crate) fn ctx(request_id: &str) -> RequestContext {
    let mut ctx = crate::pipeline::test_support::plain_request_context();
    ctx.request_id = request_id.to_owned();
    ctx.org_id = Some("org-fail-rules".to_owned());
    ctx
}

/// Mark every backend's last readiness probe ready, as the boot probe does.
pub(crate) async fn probe(state: &AppState) {
    state.screening.probe_all().await;
}

/// `count` text parts of neutral filler, each led by `marker` and each its
/// own screened item.
pub(crate) fn marked_parts(marker: &str, count: usize) -> Value {
    let filler = "lorem ipsum dolor sit amet ".repeat(280);
    let parts: Vec<Value> = (0..count)
        .map(|i| json!({ "type": "text", "text": format!("{marker} part {i} {filler}") }))
        .collect();
    json!({ "messages": [{ "role": "user", "content": parts }] })
}
