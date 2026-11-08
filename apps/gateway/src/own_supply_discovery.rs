//! Fleet-only discovery for the Ryu Router own-supply table: list what each own
//! provider account serves, prove each published row callable with a 1-token
//! canary, and report both to the control plane.
//!
//! DISCOVERY ONLY SUGGESTS. A report never changes routing anywhere: the
//! control plane turns listings into admin suggestions, and only an admin
//! creates or enables a row. The canary is the one local gate — a published row
//! routes on THIS gateway only after its canary passed here
//! ([`crate::own_supply_table::OwnSupplyRuntime::is_routable`]).
//!
//! Runs only in fleet mode (`CONTROL_PLANE_URL` + `RYU_VAULT_INTERNAL_SECRET`):
//! a self-hosted or BYOK gateway never lists, canaries or reports. Boot + 2–5 min
//! jitter, then every `RYU_SUPPLY_DISCOVERY_INTERVAL_SECS` (default 6 h, ±10%),
//! immediately on a provider generation change (a vault rotation) and on an
//! admin "Refresh now". `RYU_SUPPLY_DISCOVERY=0` turns it off (canaries too, so
//! nothing then routes to own supply on this gateway).
//!
//! NO KEY MATERIAL LEAVES: reports carry a 16-hex SHA-256 fingerprint of the
//! credential, never the credential, and errors are reduced to a status line.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::own_supply_table::CanaryResult;
use crate::state::AppState;

mod listing;
pub use listing::{
    anthropic_alias, anthropic_models, bedrock_models_url, bedrock_region, cloudflare_models,
    cloudflare_search_url, list_models, openai_models,
};

const LIST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PAGES: usize = 20;
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const MAX_CANARIES_PER_RUN: usize = 50;
const CANARY_SPACING: Duration = Duration::from_secs(1);
const DEFAULT_INTERVAL_SECS: u64 = 6 * 60 * 60;

/// Credentials and endpoint of one own-supply slot.
#[derive(Clone)]
pub struct SlotAccess {
    pub slot: &'static str,
    pub api_key: String,
    pub base_url: String,
}

/// One listed upstream model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedModel {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub evidence_ids: Vec<String>,
}

/// What a slot's listing produced.
#[derive(Debug, PartialEq, Eq)]
pub enum Listing {
    Ok(Vec<ListedModel>),
    Error(String),
    /// This slot has no usable list endpoint (Vertex phase 1, an overridden
    /// Cloudflare URL without an account id, a non-Mantle Bedrock URL).
    Unsupported,
}

/// The wire report (`POST /api/own-supply/fleet/discovery`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryReport {
    pub instance_id: String,
    pub gateway_version: &'static str,
    pub slot: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    pub key_fingerprint: String,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<ListedModel>>,
    pub canaries: Vec<CanaryReport>,
    pub quarantines: Vec<QuarantineReport>,
}

#[derive(Debug, Serialize)]
pub struct CanaryReport {
    pub upstream: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct QuarantineReport {
    pub upstream: String,
    pub count: u32,
}

/// `hex(sha256(key))[..16]`: identifies a credential without revealing it.
pub fn key_fingerprint(api_key: &str) -> String {
    let digest = Sha256::digest(api_key.as_bytes());
    hex::encode(digest)[..16].to_owned()
}

/// The access details of every configured own-supply slot.
pub fn slot_access(config: &crate::config::ProvidersConfig) -> Vec<SlotAccess> {
    use crate::config::{
        ANTHROPIC_CREDITS_PROVIDER_ID, AZURE_CREDITS_PROVIDER_ID, CLOUDFLARE_PROVIDER_ID,
        OPENAI_CREDITS_PROVIDER_ID, VERTEX_PROVIDER_ID,
    };
    let mut out = Vec::new();
    let mut push = |slot: &'static str, api_key: &str, base_url: &str| {
        if !api_key.trim().is_empty() {
            out.push(SlotAccess {
                slot,
                api_key: api_key.to_owned(),
                base_url: base_url.to_owned(),
            });
        }
    };
    if let Some(c) = &config.cloudflare {
        push(CLOUDFLARE_PROVIDER_ID, &c.api_key, &c.base_url);
    }
    // No `bedrock`: AWS Bedrock is no longer own supply (Ryu's AWS credit pays
    // for its own VMs), so it is never listed or canaried.
    if let Some(c) = &config.vertex {
        push(VERTEX_PROVIDER_ID, &c.api_key, &c.base_url);
    }
    if let Some(c) = &config.openai_credits {
        push(OPENAI_CREDITS_PROVIDER_ID, &c.api_key, &c.base_url);
    }
    if let Some(c) = &config.anthropic_credits {
        push(ANTHROPIC_CREDITS_PROVIDER_ID, &c.api_key, &c.base_url);
    }
    if let Some(c) = &config.azure_credits {
        push(AZURE_CREDITS_PROVIDER_ID, &c.api_key, &c.base_url);
    }
    out
}

/// Reduce an error to a short status line with no URL, account id or key.
fn status_line(message: &str) -> String {
    let mut line: String = message
        .split_whitespace()
        .filter(|word| !word.contains("://") && !word.contains("/accounts/"))
        .collect::<Vec<_>>()
        .join(" ");
    line.truncate(200);
    line
}

/// The 1-token canary body for `upstream`.
fn canary_body(upstream: &str) -> Value {
    json!({
        "model": upstream,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1,
        "stream": false,
    })
}

/// Canary every published row on `slot` that has no fresh local result for
/// this credential. Rate-limited and transport failures record nothing (they
/// say nothing about the model), so the row is simply retried next run.
async fn run_canaries(
    state: &AppState,
    snapshot: &crate::providers::ProviderSnapshot,
    access: &SlotAccess,
    fingerprint: &str,
    budget: &mut usize,
) -> Vec<CanaryReport> {
    let mut reports = Vec::new();
    let Some(provider) = snapshot.providers.get_owned(access.slot) else {
        return reports;
    };
    let table = state.own_supply.table();
    let due: Vec<String> = table
        .rows()
        .iter()
        .filter(|row| row.slot == access.slot)
        .filter(|row| {
            state
                .own_supply
                .canary_due(&row.slot, &row.upstream, fingerprint)
        })
        .map(|row| row.upstream.clone())
        .collect();
    for upstream in due {
        if *budget == 0 {
            break;
        }
        *budget -= 1;
        let body = canary_body(&upstream);
        let outcome = provider.complete(&upstream, &body).await;
        let (ok, error) = match outcome {
            Ok(_) => (true, None),
            Err(ryu_gw_providers::ProviderError::RateLimited { .. })
            | Err(ryu_gw_providers::ProviderError::Transport(_)) => {
                tokio::time::sleep(CANARY_SPACING).await;
                continue;
            }
            Err(error) => (false, Some(status_line(&error.to_string()))),
        };
        state.own_supply.record_canary(
            access.slot,
            &upstream,
            CanaryResult {
                ok,
                at: Instant::now(),
                key_fingerprint: fingerprint.to_owned(),
            },
        );
        if !ok {
            tracing::warn!(
                slot = access.slot,
                "own-supply: a published row failed its canary"
            );
        }
        reports.push(CanaryReport {
            upstream,
            ok,
            error,
        });
        tokio::time::sleep(CANARY_SPACING).await;
    }
    reports
}

/// Build one slot's report from its listing and canary results.
pub fn build_report(
    instance_id: &str,
    access: &SlotAccess,
    listing: Listing,
    canaries: Vec<CanaryReport>,
    quarantines: Vec<(String, u32)>,
) -> DiscoveryReport {
    let (status, models, error) = match listing {
        Listing::Ok(models) => ("ok", Some(models), None),
        Listing::Error(error) => ("error", None, Some(error)),
        Listing::Unsupported => ("unsupported", None, None),
    };
    DiscoveryReport {
        instance_id: instance_id.to_owned(),
        gateway_version: env!("CARGO_PKG_VERSION"),
        slot: access.slot,
        region: (access.slot == crate::config::BEDROCK_PROVIDER_ID)
            .then(|| bedrock_region(&access.base_url))
            .flatten(),
        key_fingerprint: key_fingerprint(&access.api_key),
        status,
        error,
        models,
        canaries,
        quarantines: quarantines
            .into_iter()
            .map(|(upstream, count)| QuarantineReport { upstream, count })
            .collect(),
    }
}

/// One discovery + canary pass over every configured own-supply slot.
async fn run_once(
    state: &Arc<AppState>,
    http: &reqwest::Client,
    endpoint: &reqwest::Url,
    secret: &str,
    instance_id: &str,
) {
    let snapshot = state.provider_runtime.snapshot();
    let mut budget = MAX_CANARIES_PER_RUN;
    for access in slot_access(&snapshot.config) {
        let fingerprint = key_fingerprint(&access.api_key);
        let listing = list_models(http, &access).await;
        let canaries = run_canaries(state, &snapshot, &access, &fingerprint, &mut budget).await;
        let quarantines = state.own_supply.take_quarantine_counts(access.slot);
        let report = build_report(instance_id, &access, listing, canaries, quarantines);
        let sent = http
            .post(endpoint.clone())
            .header("x-ryu-internal-secret", secret)
            .timeout(LIST_TIMEOUT)
            .json(&report)
            .send()
            .await;
        match sent {
            Ok(response) if response.status().is_success() => {}
            Ok(response) => tracing::warn!(
                slot = access.slot,
                status = response.status().as_u16(),
                "own-supply: discovery report refused"
            ),
            Err(error) => tracing::warn!(
                slot = access.slot,
                "own-supply: discovery report failed: {}",
                status_line(&error.to_string())
            ),
        }
    }
}

fn env_interval() -> Option<Duration> {
    if std::env::var("RYU_SUPPLY_DISCOVERY")
        .ok()
        .is_some_and(|value| matches!(value.trim(), "0" | "false" | "off" | "no"))
    {
        return None;
    }
    let secs = std::env::var("RYU_SUPPLY_DISCOVERY_INTERVAL_SECS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|secs| *secs >= 60)
        .unwrap_or(DEFAULT_INTERVAL_SECS);
    Some(Duration::from_secs(secs))
}

/// ±10% so a fleet's replicas do not list in lockstep.
fn jittered(interval: Duration) -> Duration {
    let tenth = interval.as_secs() / 10;
    let offset = fastrand_u64(tenth.saturating_mul(2) + 1);
    Duration::from_secs(interval.as_secs() - tenth + offset)
}

fn fastrand_u64(bound: u64) -> u64 {
    use rand::Rng;
    if bound == 0 {
        return 0;
    }
    rand::thread_rng().gen_range(0..bound)
}

/// Start discovery (fleet mode only).
pub fn spawn(state: Arc<AppState>) {
    if !state.own_supply.is_fleet() {
        return;
    }
    let Some(interval) = env_interval() else {
        tracing::info!("own-supply: discovery disabled (RYU_SUPPLY_DISCOVERY=0)");
        return;
    };
    let (Ok(base), Ok(secret)) = (
        std::env::var("CONTROL_PLANE_URL"),
        std::env::var("RYU_VAULT_INTERNAL_SECRET"),
    ) else {
        return;
    };
    let endpoint = match crate::provider_vault::control_plane_endpoint(
        base.trim(),
        "own-supply/fleet/discovery",
    ) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            tracing::warn!("own-supply: discovery disabled: {error}");
            return;
        }
    };
    let http = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(http) => http,
        Err(error) => {
            tracing::warn!("own-supply: discovery disabled: {error}");
            return;
        }
    };
    let secret = secret.trim().to_owned();
    let instance_id = uuid::Uuid::new_v4().to_string();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(120 + fastrand_u64(181))).await;
        let mut last_epoch = state.provider_runtime.snapshot().epoch;
        let mut last_request = state.own_supply.discovery_requested_at();
        let mut next_due = Instant::now();
        loop {
            let epoch = state.provider_runtime.snapshot().epoch;
            let requested = state.own_supply.discovery_requested_at();
            let rotated = epoch != last_epoch;
            let asked = requested.is_some() && requested != last_request;
            if Instant::now() >= next_due || rotated || asked {
                if rotated {
                    tracing::info!("own-supply: provider credentials changed; rediscovering");
                }
                run_once(&state, &http, &endpoint, &secret, &instance_id).await;
                last_epoch = epoch;
                last_request = requested;
                next_due = Instant::now() + jittered(interval);
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

#[cfg(test)]
mod tests;
