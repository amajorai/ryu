//! Anonymous community-savings beacon (the Core half of the community-savings slice).
//!
//! **Posture: opt-out, anonymous, fail-open.**
//! - *Opt-out*: ON by default. Anonymous aggregates phone home until the user
//!   turns off `community-stats-enabled` (or `RYU_COMMUNITY_STATS_ENABLED`). The
//!   pref is re-read every tick, so a desktop toggle takes effect without a restart.
//! - *Anonymous*: the row is keyed by a locally-minted install id
//!   (`community-stats-install-id`, a random uuid v4) plus a per-process session
//!   id. **No hostname, gateway key, org id, or any identity value is ever sent.**
//! - *Fail-open*: every step is best-effort. Any error (gateway down, network
//!   blip, malformed response) is logged at `warn`/`debug` and the tick is
//!   skipped. The beacon NEVER panics, blocks startup, or affects chat.
//!
//! **Placement (CLAUDE.md §1, Core vs Gateway):** consent and the phone-home are
//! a Core concern (Core owns user preferences and *what runs* on this machine),
//! so they live here. The *measurement* itself — the aggregate compression /
//! cache counters — is owned by the Gateway and merely *read* from its public
//! `/v1/savings` endpoint. Core never computes policy or measurement inline; it
//! snapshots what the Gateway already measured and forwards it to the control
//! plane, which aggregates across the community.

use std::time::Duration;

use serde::Serialize;

/// How often to snapshot + report (5 min). Matches the sync loop cadence.
const BEACON_INTERVAL: Duration = Duration::from_secs(300);
/// Per-request timeout for both the gateway read and the control-plane POST.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// Anonymous, locally-minted install id. NEVER an identity value.
const INSTALL_ID_PREF_KEY: &str = "community-stats-install-id";

/// Env var with the control-plane base URL (the `apps/server` Hono API). Mirrors
/// `sidecar::control_plane`'s resolution so the beacon points at the same host.
const ENV_CONTROL_PLANE_URL: &str = "RYU_CONTROL_PLANE_URL";
/// Default control-plane base (local dev), with NO `/api` suffix — the ingest
/// path is built as `{base}/api/community/ingest`.
const DEFAULT_CONTROL_PLANE_URL: &str = "http://127.0.0.1:3000";

/// Resolve the control-plane base URL: env override → local-dev default.
fn control_plane_base() -> String {
    std::env::var(ENV_CONTROL_PLANE_URL)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_CONTROL_PLANE_URL.to_owned())
}

/// The camelCase ingest payload POSTed to the control plane. A SNAPSHOT (the
/// gateway counters are cumulative-since-boot), upserted server-side by
/// `{instanceId}:{sessionId}`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IngestPayload {
    instance_id: String,
    session_id: String,
    requests: u64,
    input_tokens: u64,
    output_tokens: u64,
    tokens_saved: u64,
    cache_hit_rate: f64,
    os: String,
    arch: String,
    version: String,
    engine: String,
}

/// Get-or-mint the anonymous install id, persisting it in the preferences store.
///
/// A random uuid v4 — deliberately NOT derived from hostname, gateway key, or any
/// identity value, so the community aggregate can count distinct installs without
/// ever learning who they are.
async fn get_or_mint_install_id(
    prefs: &crate::server::preferences::PreferencesStore,
) -> Option<String> {
    match prefs.get(INSTALL_ID_PREF_KEY).await {
        Ok(Some(id)) if !id.trim().is_empty() => Some(id),
        Ok(_) => {
            let id = uuid::Uuid::new_v4().to_string();
            if let Err(e) = prefs.set(INSTALL_ID_PREF_KEY, &id).await {
                tracing::warn!("community-stats: failed to persist install id: {e}");
                return None;
            }
            Some(id)
        }
        Err(e) => {
            tracing::warn!("community-stats: failed to read install id: {e}");
            None
        }
    }
}

/// Read the gateway's public `/v1/savings` counters. Best-effort: returns `None`
/// on any error so the caller simply skips the tick.
async fn fetch_savings(client: &reqwest::Client) -> Option<serde_json::Value> {
    let base = crate::sidecar::gateway::gateway_url();
    let endpoint = format!("{}/v1/savings", base.trim_end_matches('/'));

    let mut req = client.get(&endpoint).timeout(REQUEST_TIMEOUT);
    // The endpoint is public/ungated, but attach the local bearer when present so
    // an auth-required gateway still answers (mirrors `check_exec_budget`).
    if let Some(token) = crate::sidecar::gateway::gateway_token() {
        req = req.bearer_auth(token);
    }

    match req.send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
            Ok(body) => Some(body),
            Err(e) => {
                tracing::debug!("community-stats: parsing /v1/savings failed: {e}");
                None
            }
        },
        Ok(resp) => {
            tracing::debug!("community-stats: /v1/savings returned {}", resp.status());
            None
        }
        Err(e) => {
            tracing::debug!("community-stats: reading /v1/savings failed: {e}");
            None
        }
    }
}

/// Spawn the opt-out anonymous community-savings beacon. Returns immediately. The
/// loop no-ops any tick the user has opted out (`community-stats-enabled=false`),
/// re-reading the live pref each tick so an in-session opt-out stops egress at once.
///
/// Each enabled tick, best-effort: skip if the gateway is unhealthy, get-or-mint
/// the anonymous install id, GET the gateway's `/v1/savings` snapshot, and POST it
/// to the control plane's `/api/community/ingest`. Any error is logged and the
/// tick is skipped — the beacon never panics or blocks.
pub fn spawn_stats_beacon(prefs: crate::server::preferences::PreferencesStore) {
    tokio::spawn(async move {
        // Fresh per-process session id, minted once in-memory. Combined with the
        // persisted install id it keys the upserted snapshot row server-side.
        let session_id = uuid::Uuid::new_v4().to_string();
        let client = reqwest::Client::new();
        let mut interval = tokio::time::interval(BEACON_INTERVAL);

        loop {
            interval.tick().await;

            if !crate::privacy::community_stats_enabled(&prefs).await {
                continue;
            }

            // Skip while the gateway is down — there is nothing to measure and
            // fetching would just fail.
            if !crate::sidecar::gateway::is_healthy().await {
                tracing::debug!("community-stats: gateway not healthy, skipping tick");
                continue;
            }

            let Some(instance_id) = get_or_mint_install_id(&prefs).await else {
                continue;
            };

            let Some(savings) = fetch_savings(&client).await else {
                continue;
            };

            let read_u64 = |key: &str| savings.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
            let payload = IngestPayload {
                instance_id,
                session_id: session_id.clone(),
                requests: read_u64("requests"),
                input_tokens: read_u64("input_tokens"),
                output_tokens: read_u64("output_tokens"),
                tokens_saved: read_u64("tokens_saved"),
                cache_hit_rate: savings
                    .get("cache_hit_rate")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0),
                os: std::env::consts::OS.to_owned(),
                arch: std::env::consts::ARCH.to_owned(),
                version: env!("CARGO_PKG_VERSION").to_owned(),
                // Best-effort engine label; the gateway snapshot is engine-agnostic.
                engine: "unknown".to_owned(),
            };

            let endpoint = format!("{}/api/community/ingest", control_plane_base());
            match client
                .post(&endpoint)
                .timeout(REQUEST_TIMEOUT)
                .json(&payload)
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    tracing::debug!("community-stats: reported snapshot to control plane");
                }
                Ok(resp) => {
                    tracing::debug!(
                        "community-stats: ingest returned {} (ignored)",
                        resp.status()
                    );
                }
                Err(e) => {
                    tracing::warn!("community-stats: ingest POST failed (ignored): {e}");
                }
            }
        }
    });
}
