//! Egress posture report: which flagged upstream features are active here.
//!
//! Some Gateway features can look like ban evasion to an upstream when they
//! spend Ryu's provider accounts: several keys rotated past a rate limit,
//! account pools that move work to whichever account has quota left, proxy
//! pools, and reverse-engineered subscription transports. This module only
//! detects them. Nothing here changes routing, dispatch or any refusal.
//!
//! `GET /v1/egress/posture` (admin) lists all eight items, F1 to F8, on every
//! custody. At boot each active item on a fleet slot is logged as one
//! `egress.posture_flag` event. Decisions are delivered later in the platform
//! floor document, so every active item reads `unreviewed` for now.

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, State},
    http::HeaderMap,
    Json,
};
use ryu_gw_providers::AccountSelectionStrategy;
use serde::Serialize;

use crate::{
    config::{EgressConfig, ProvidersConfig},
    custody::GatewayCustody,
    error::GatewayError,
    pipeline::{authenticate, AuthInputs},
    providers::ProviderRegistry,
    state::{AppState, SharedState},
};

/// The event name every posture flag carries, in logs and in the report.
pub const POSTURE_FLAG_EVENT: &str = "egress.posture_flag";
/// Posture flags are platform-abuse signals, never strikes.
const FLAG_CATEGORY: &str = "abuse.platform";
const FLAG_SEVERITY: &str = "low";
/// Only fleet slots flag, and the fleet spends Ryu's own accounts.
const FLAG_SPEND: &str = "ryu";

const KIRO: &str = "kiro";
const QODER: &str = "qoder";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PostureStatus {
    /// The feature is in use on this Gateway.
    Active,
    /// The feature could run on this Gateway but nothing configures it.
    Inactive,
    /// The behaviour exists elsewhere but this custody already prevents it.
    Resolved,
    /// Detection waits for a later change; this report does not claim either way.
    Deferred,
    /// The feature lives in another service, so this Gateway cannot see it.
    OutsideGateway,
}

/// The recorded decision for an active item. Approvals and refusals arrive
/// with the platform floor document, so only the default exists today.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PostureDecision {
    Unreviewed,
}

/// One provider slot where an item is active. Counts and names only: no key,
/// account id, proxy URL or credential variable ever appears here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PostureSlot {
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accounts: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strategy: Option<AccountSelectionStrategy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_endpoints: Option<usize>,
}

impl PostureSlot {
    fn provider(provider: &str) -> Self {
        Self {
            provider: provider.to_owned(),
            accounts: None,
            strategy: None,
            pool: None,
            proxy_endpoints: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PostureItem {
    pub id: &'static str,
    pub feature: &'static str,
    pub status: PostureStatus,
    /// `Some` exactly when the item is active.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<PostureDecision>,
    pub slots: Vec<PostureSlot>,
    pub note: &'static str,
}

/// One `egress.posture_flag` event: an active item on one fleet slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PostureFlag {
    pub event: &'static str,
    pub id: &'static str,
    pub feature: &'static str,
    pub provider: String,
    pub decision: PostureDecision,
    pub category: &'static str,
    pub severity: &'static str,
    pub spend: &'static str,
    /// Posture flags never count toward an abuse ladder.
    pub strike: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PostureReport {
    pub custody: GatewayCustody,
    /// Whether active items on this Gateway emit `egress.posture_flag`.
    pub flags_enabled: bool,
    pub items: Vec<PostureItem>,
    pub flags: Vec<PostureFlag>,
}

impl PostureReport {
    /// The ids of every active item, in F1 to F8 order.
    pub fn active_ids(&self) -> Vec<&'static str> {
        self.items
            .iter()
            .filter(|item| item.status == PostureStatus::Active)
            .map(|item| item.id)
            .collect()
    }
}

/// Build the report from one provider snapshot. Pure, so tests need no
/// process environment and no running Gateway.
pub fn assess(
    custody: GatewayCustody,
    registry: &ProviderRegistry,
    providers: &ProvidersConfig,
    egress: &EgressConfig,
) -> PostureReport {
    let accounts = registry.account_counts();
    let rotating: Vec<PostureSlot> = accounts
        .iter()
        .filter(|(_, count)| **count > 1)
        .map(|(scope, count)| PostureSlot {
            accounts: Some(*count),
            ..PostureSlot::provider(scope)
        })
        .collect();
    let quota_aware: Vec<PostureSlot> = rotating
        .iter()
        .filter_map(|slot| {
            let strategy = *providers.account_strategies.get(&slot.provider)?;
            (strategy != AccountSelectionStrategy::RoundRobin).then(|| PostureSlot {
                strategy: Some(strategy),
                ..slot.clone()
            })
        })
        .collect();
    let transports: Vec<PostureSlot> = [KIRO, QODER]
        .into_iter()
        .filter(|id| registry.get(id).is_some())
        .map(PostureSlot::provider)
        .collect();

    let items = vec![
        detected(
            "F1",
            "multi_key_rotation",
            rotating,
            "Several API keys on one provider rotate when an upstream returns 429.",
        ),
        detected(
            "F2",
            "quota_account_pool",
            quota_aware,
            "A multi-account provider ranks new sessions by remaining quota.",
        ),
        detected(
            "F3",
            "egress_proxy_rotation",
            proxy_slots(egress),
            "A provider is assigned an egress pool with at least one enabled proxy endpoint.",
        ),
        detected(
            "F4",
            "subscription_transport",
            transports,
            "A Kiro or Qoder subscription transport is registered.",
        ),
        unseen(
            "F5",
            "client_identity",
            PostureStatus::OutsideGateway,
            "OpenCode Zen calls are made by the web API, not by this Gateway.",
        ),
        if custody.ends_chain_on_refusal() {
            unseen(
                "F6",
                "fallback_after_refusal",
                PostureStatus::Resolved,
                "An upstream refusal ends the attempt chain on this custody.",
            )
        } else {
            unseen(
                "F6",
                "fallback_after_refusal",
                PostureStatus::Inactive,
                "This Gateway falls back on its owner's keys, not on Ryu's accounts.",
            )
        },
        unseen(
            "F7",
            "tenant_upstream_identifier",
            PostureStatus::Deferred,
            "Replacing tenant upstream identifiers is not detected by this report.",
        ),
        unseen(
            "F8",
            "local_egress",
            PostureStatus::OutsideGateway,
            "Route-through-this-computer egress runs in Core, not in this Gateway.",
        ),
    ];

    let flags = if custody.flags_egress_posture() {
        items
            .iter()
            .filter(|item| item.status == PostureStatus::Active)
            .flat_map(|item| {
                item.slots.iter().map(|slot| PostureFlag {
                    event: POSTURE_FLAG_EVENT,
                    id: item.id,
                    feature: item.feature,
                    provider: slot.provider.clone(),
                    decision: PostureDecision::Unreviewed,
                    category: FLAG_CATEGORY,
                    severity: FLAG_SEVERITY,
                    spend: FLAG_SPEND,
                    strike: false,
                })
            })
            .collect()
    } else {
        Vec::new()
    };

    PostureReport {
        custody,
        flags_enabled: custody.flags_egress_posture(),
        items,
        flags,
    }
}

/// An item this Gateway detects from its own configuration: active exactly
/// when at least one slot carries it.
fn detected(
    id: &'static str,
    feature: &'static str,
    slots: Vec<PostureSlot>,
    note: &'static str,
) -> PostureItem {
    let active = !slots.is_empty();
    PostureItem {
        id,
        feature,
        status: if active {
            PostureStatus::Active
        } else {
            PostureStatus::Inactive
        },
        decision: active.then_some(PostureDecision::Unreviewed),
        slots,
        note,
    }
}

/// An item this report lists for completeness but never marks active.
fn unseen(
    id: &'static str,
    feature: &'static str,
    status: PostureStatus,
    note: &'static str,
) -> PostureItem {
    PostureItem {
        id,
        feature,
        status,
        decision: None,
        slots: Vec::new(),
        note,
    }
}

/// Providers assigned a pool that routes through at least one enabled proxy.
/// A pool that only holds the direct client is not a proxy. The assignment
/// counts even before its provider has a key, so a proxy that would carry the
/// first request is already on the report.
fn proxy_slots(egress: &EgressConfig) -> Vec<PostureSlot> {
    let mut slots: Vec<PostureSlot> = egress
        .assignments
        .iter()
        .filter_map(|(provider, pool_name)| {
            let pool = egress.pools.get(pool_name)?;
            let proxies = pool
                .endpoints
                .iter()
                .filter(|endpoint| endpoint.enabled)
                .count();
            (proxies > 0).then(|| PostureSlot {
                pool: Some(pool_name.clone()),
                proxy_endpoints: Some(proxies),
                ..PostureSlot::provider(provider)
            })
        })
        .collect();
    slots.sort_by(|left, right| left.provider.cmp(&right.provider));
    slots
}

/// The report for the provider snapshot this Gateway serves right now, so a
/// hot-swapped configuration is reflected without a restart.
pub fn report_for(state: &AppState) -> PostureReport {
    let snapshot = state.provider_runtime.snapshot();
    assess(
        state.custody,
        &snapshot.providers,
        &snapshot.config,
        snapshot.egress_config(),
    )
}

/// Log the boot posture: one summary line naming every active item, then one
/// `egress.posture_flag` warning per flagged slot. Returns the flags it logged.
pub fn log_boot_posture(state: &AppState) -> Vec<PostureFlag> {
    let report = report_for(state);
    tracing::info!(
        custody = report.custody.as_str(),
        active = %report.active_ids().join(","),
        flags = report.flags.len(),
        "egress posture assessed"
    );
    for flag in &report.flags {
        tracing::warn!(
            event = flag.event,
            id = flag.id,
            feature = flag.feature,
            provider = %flag.provider,
            decision = "unreviewed",
            category = flag.category,
            severity = flag.severity,
            spend = flag.spend,
            strike = flag.strike,
            "egress posture flag: an unreviewed feature is active on a fleet slot"
        );
    }
    report.flags
}

/// `GET /v1/egress/posture`: the posture report, for the master key or the
/// zero-config loopback admin only.
pub async fn get_egress_posture(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<PostureReport>, GatewayError> {
    let raw_key = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;
    super::config::require_local_admin(
        &state,
        &peer,
        ctx.is_master_key,
        &headers,
        "Egress posture access",
    )?;
    Ok(Json(report_for(&state)))
}

#[cfg(test)]
#[path = "egress_posture_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "egress_posture_probe_tests.rs"]
mod probe_tests;
