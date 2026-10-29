//! The hosted fleet's committed screener wiring (screener addendum section 10,
//! build step G7): the `apps/gateway/fleet/screening.toml` table an operator
//! pastes into the fleet's `gateway.toml`, and the compose file that sets the
//! variables it names. No model runs here; the backend is built and never
//! called.

use super::*;
use crate::config::GatewayConfig;
use ryu_gw_screening::Locality;

const FLEET_TABLE: &str = include_str!("../../fleet/screening.toml");
const FLEET_COMPOSE: &str = include_str!("../../docker-compose.fleet.yml");

const FLEET_URL: &str = "http://screener:11435/v1/systemone";
const FLEET_MODEL: &str = "fleet-decision-model";
const FLEET_SHA: &str = "ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

fn fleet_env(key: &str) -> Option<String> {
    match key {
        "RYU_SCREENER_DECISION_URL" => Some(FLEET_URL.to_owned()),
        "RYU_SCREENER_DECISION_MODEL" => Some(FLEET_MODEL.to_owned()),
        "RYU_SCREENER_DECISION_SHA256" => Some(FLEET_SHA.to_owned()),
        _ => None,
    }
}

fn fleet_screening() -> ScreeningConfig {
    let config: GatewayConfig =
        toml::from_str(FLEET_TABLE).expect("the fleet table is a valid gateway.toml");
    config.screening
}

#[test]
fn the_fleet_table_builds_a_pinned_private_network_decision_model() {
    let screening = fleet_screening();
    assert_eq!(
        screening.backends.keys().collect::<Vec<_>>(),
        ["decision_local"],
        "the fleet baseline names one local decision model and no remote processor"
    );
    assert!(screening
        .backends
        .values()
        .all(|backend| backend.kind != ScreeningBackendKind::DecisionRemote));

    let runtime = ScreeningRuntime::from_config(&screening, &fleet_env);
    assert!(
        runtime.build_errors().is_empty(),
        "{:?}",
        runtime.build_errors()
    );
    let slot = runtime
        .slot("decision_local")
        .expect("decision_local built");
    assert_eq!(slot.kind, ScreeningBackendKind::DecisionLocal);
    let descriptor = slot.backend.descriptor();
    assert_eq!(descriptor.locality, Locality::PrivateNetwork);
    assert_eq!(descriptor.reference.model, FLEET_MODEL);
    assert_eq!(
        descriptor.reference.weights_sha256.as_deref(),
        Some(FLEET_SHA.to_ascii_lowercase().as_str()),
        "the gateway pins the digest the screener image was pulled by"
    );
    assert_eq!(descriptor.reference.template_version, 1);
}

#[test]
fn the_fleet_table_needs_its_private_network_flag_and_a_pinned_digest() {
    let mut screening = fleet_screening();
    screening
        .backends
        .get_mut("decision_local")
        .expect("decision_local")
        .private_network = false;
    let runtime = ScreeningRuntime::from_config(&screening, &fleet_env);
    assert!(
        runtime.slot("decision_local").is_none(),
        "a service-name host is not loopback, so it needs the private-network flag"
    );
    assert!(runtime.build_errors().contains_key("decision_local"));

    let unpinned = ScreeningRuntime::from_config(&fleet_screening(), &|key| match key {
        "RYU_SCREENER_DECISION_SHA256" => None,
        other => fleet_env(other),
    });
    assert!(unpinned.slot("decision_local").is_none());
    assert!(unpinned.build_errors().contains_key("decision_local"));
}

#[test]
fn the_fleet_compose_sets_every_variable_the_table_names() {
    let screening = fleet_screening();
    let backend = &screening.backends["decision_local"];
    for name in [
        backend.base_url_env.as_deref(),
        backend.model_env.as_deref(),
        backend.weights_sha256_env.as_deref(),
    ] {
        let name = name.expect("the fleet table reads each value from the environment");
        assert!(
            FLEET_COMPOSE.contains(&format!("{name}:")),
            "the fleet compose does not set {name}"
        );
    }
    assert!(FLEET_COMPOSE.contains(&format!("RYU_SCREENER_DECISION_URL: {FLEET_URL}")));
    assert!(FLEET_COMPOSE.contains("GATEWAY_CONFIG: /data/gateway.toml"));
}

#[test]
fn the_fleet_compose_never_makes_the_gateway_wait_for_the_screener() {
    // A screener outage must degrade the replica, never keep it from starting.
    let active: Vec<&str> = FLEET_COMPOSE
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .collect();
    assert!(
        !active.iter().any(|line| line.contains("depends_on")),
        "the gateway must not depend on the screener"
    );
    assert!(
        active
            .windows(2)
            .any(|pair| pair[0].trim() == "screening:" && pair[1].trim() == "internal: true"),
        "the screening network is internal"
    );
    let screener = FLEET_COMPOSE
        .split("\n  screener:\n")
        .nth(1)
        .and_then(|rest| rest.split("\nnetworks:\n").next())
        .expect("a screener service");
    assert!(
        !screener.contains("ports:"),
        "the screener publishes no port"
    );
    assert!(
        !screener.contains("- edge"),
        "the screener has no egress network"
    );
}
