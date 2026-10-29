//! `GET /v1/screening/status` (admin): each backend's breaker, last probe,
//! model, weights hash and template version, and the active floor's
//! qualification and remote-processor status (screener addendum 10.3).
//!
//! It names backend ids, kinds and processor ids only: never an endpoint
//! URL, a credential or its variable name.

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, State},
    http::HeaderMap,
    Json,
};
use ryu_gw_screening::{BackendHealth, Role, ScreenTier, ScreenerBackend, TaxonomyId};
use serde_json::{json, Value};

use super::short_code;
use crate::error::GatewayError;
use crate::pipeline::{authenticate, AuthInputs};
use crate::state::{AppState, SharedState};

/// The report, without the auth gate.
pub fn report(state: &AppState) -> Value {
    let runtime = &state.screening;
    runtime.publish_transitions(&state.traffic);
    let tier = runtime.tier(state.custody);
    let floor = crate::platform_floor::binding_floor(state.custody, &state.platform_floor);
    let active =
        tier.map(|tier| runtime.active(tier, floor.as_ref().and_then(|f| f.screener.clone())));
    let backends: Vec<Value> = runtime
        .slots()
        .map(|slot| {
            let d = slot.backend.descriptor();
            let qualified: Vec<&str> = active
                .as_ref()
                .map(|active| {
                    active
                        .screener
                        .hard_codes()
                        .iter()
                        .filter(|code| d.covers.contains(*code))
                        .filter(|code| active.policy().qualified(&d.reference, *code))
                        .map(short_code)
                        .collect()
                })
                .unwrap_or_default();
            let probe = slot.backend.breaker.last_probe().map(|probe| {
                let result = match probe.health {
                    BackendHealth::Ready => "ready".to_owned(),
                    BackendHealth::Down(reason) => format!("down:{reason}"),
                    BackendHealth::NotPermitted => "not_permitted".to_owned(),
                };
                json!({
                    "at": chrono::DateTime::<chrono::Utc>::from(probe.at).to_rfc3339(),
                    "result": result,
                })
            });
            json!({
                "id": slot.id,
                "kind": slot.kind.as_str(),
                "locality": match &d.locality {
                    ryu_gw_screening::Locality::Loopback => "loopback",
                    ryu_gw_screening::Locality::PrivateNetwork => "private_network",
                    ryu_gw_screening::Locality::RemoteProcessor { .. } => "remote_processor",
                },
                "processorId": slot.processor_id,
                "model": d.reference.model,
                "weightsSha256": d.reference.weights_sha256.as_deref().map(|s| s.get(..8).unwrap_or(s)),
                "templateVersion": d.reference.template_version,
                "breaker": slot.breaker_state().as_str(),
                "lastProbe": probe,
                "permitted": tier.is_none_or(|tier| slot.backend.permits(tier)),
                "qualifiedHardCodes": qualified,
            })
        })
        .collect();
    let errors: Vec<Value> = runtime
        .build_errors()
        .iter()
        .map(|(id, reason)| json!({ "id": id, "error": reason }))
        .collect();
    let (mode, roles, qualifications, processors, explicit, template) = match &active {
        Some(active) => {
            let hard: Vec<TaxonomyId> = active.screener.hard_codes().iter().collect();
            let qualified = hard.iter().all(|code| {
                active.chain.backends(Role::TextHazard).iter().any(|b| {
                    let d = b.descriptor();
                    d.covers.contains(*code)
                        && (active.tier == ScreenTier::Node
                            || active.policy().qualified(&d.reference, *code))
                        && active
                            .breakers
                            .get(d.id())
                            .is_none_or(|b| b.breaker.allows())
                })
            });
            let roles = json!({
                "textHazard": active.screener.roles.text_hazard,
                "promptAttack": active.screener.roles.prompt_attack,
                "vision": active.screener.roles.vision,
                "output": active.screener.roles.output,
            });
            let processors: Vec<Value> = active
                .screener
                .remote_processors
                .iter()
                .map(|r| json!({ "processorId": r.processor_id, "backendId": r.backend_id, "retentionDays": r.retention_days, "zdr": r.zdr }))
                .collect();
            (
                if qualified { "classified" } else { "degraded" },
                roles,
                active.screener.qualifications.len(),
                processors,
                active.screener.explicit,
                active.screener.template_version,
            )
        }
        None => ("off", json!(null), 0, Vec::new(), false, 0),
    };
    let cache = runtime.cache_stats();
    json!({
        "custody": state.custody.as_str(),
        "tier": tier.map(|tier| match tier {
            ScreenTier::Floor => "floor",
            ScreenTier::Node => "node",
        }),
        "mode": mode,
        "floorVersion": floor.as_ref().map(|f| f.version),
        "floorScreener": explicit,
        "templateVersion": template,
        "roles": roles,
        "qualifications": qualifications,
        "remoteProcessors": processors,
        "degradedRpm": runtime.degraded_rpm(),
        "backends": backends,
        "buildErrors": errors,
        "cache": { "hits": cache.hits, "misses": cache.misses, "entries": cache.entries },
    })
}

/// `GET /v1/screening/status`, for the master key or the zero-config
/// loopback admin only (never loopback trust on an exposure-hardened node).
pub async fn get_screening_status(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<Value>, GatewayError> {
    let raw_key = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;
    crate::api::config::require_local_admin(
        &state,
        &peer,
        ctx.is_master_key,
        &headers,
        "Screening status access",
    )?;
    Ok(Json(report(&state)))
}
