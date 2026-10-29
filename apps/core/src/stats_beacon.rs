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

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

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

const MARKETPLACE_STATS_KINDS: &[&str] = &[
    "app",
    "plugin",
    "skill",
    "model",
    "mcp",
    "agent",
    "stack_template",
    "workflow",
    "theme",
    "language_pack",
    "space",
    "profile",
    "output_style",
    "bundle",
];
const MARKETPLACE_STATS_MAX_ID_BYTES: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarketplaceStatsSnapshot {
    id: String,
    kind: String,
    downloads: u64,
    runs: u64,
}

static MARKETPLACE_STATS: OnceLock<Mutex<BTreeMap<String, MarketplaceStatsSnapshot>>> =
    OnceLock::new();

#[derive(Default, Deserialize, Serialize)]
struct PublicItemWitnesses {
    version: u32,
    authority: String,
    listing_ids: std::collections::BTreeSet<String>,
    runtime_ids: BTreeMap<String, (String, String)>,
    #[serde(default)]
    definitions: BTreeMap<String, String>,
}

fn public_items_path() -> std::path::PathBuf {
    crate::paths::state_path("marketplace-public-statistics.json")
}

fn public_items_store() -> &'static Mutex<PublicItemWitnesses> {
    static ITEMS: OnceLock<Mutex<PublicItemWitnesses>> = OnceLock::new();
    ITEMS.get_or_init(|| {
        Mutex::new(
            std::fs::read(public_items_path())
                .ok()
                .and_then(|bytes| serde_json::from_slice::<PublicItemWitnesses>(&bytes).ok())
                .filter(|store| store.version == 1 && store.authority == "https://api.ryuhq.com")
                .unwrap_or_else(|| PublicItemWitnesses {
                    version: 1,
                    authority: "https://api.ryuhq.com".into(),
                    ..Default::default()
                }),
        )
    })
}

pub(crate) fn public_listing_witnessed(kind: &str, id: &str) -> bool {
    public_items_store()
        .lock()
        .ok()
        .is_some_and(|items| items.listing_ids.contains(&format!("{kind}:{id}")))
}

fn save_public_items(items: &PublicItemWitnesses) -> anyhow::Result<()> {
    use std::io::Write;
    let path = public_items_path();
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("missing public witness directory"))?;
    std::fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(&serde_json::to_vec(items)?)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path)?;
    Ok(())
}

/// Only a successful install from the canonical Marketplace may call this;
/// arbitrary usage events never trigger a network lookup of a private identifier.
pub async fn witness_public_marketplace_install(kind: &str, id: &str) {
    let Some((kind, id)) = marketplace_id(kind, id) else {
        return;
    };
    let public = crate::catalog_source::sources::public_marketplace_listing(&kind, &id).await;
    let Ok(mut items) = public_items_store().lock() else {
        return;
    };
    if public {
        items.listing_ids.insert(format!("{kind}:{id}"));
    } else {
        items.listing_ids.remove(&format!("{kind}:{id}"));
        items
            .runtime_ids
            .retain(|_, (listed_kind, listed_id)| listed_kind != &kind || listed_id != &id);
    }
    if let Err(error) = save_public_items(&items) {
        tracing::warn!(%error, "public Marketplace witness could not be saved");
    }
}

/// Explicit install preparation fetches only a public category, never a private
/// candidate ID. Arbitrary usage messages use the local witness store only.
pub async fn refresh_public_marketplace_catalog(kind: &str) {
    let Some((kind, _)) = marketplace_id(kind, "catalog") else {
        return;
    };
    let ids = crate::catalog_source::sources::public_marketplace_catalog(&kind).await;
    let Ok(mut items) = public_items_store().lock() else {
        return;
    };
    for id in ids {
        if let Some((kind, id)) = marketplace_id(&kind, &id) {
            items.listing_ids.insert(format!("{kind}:{id}"));
        }
    }
    if let Err(error) = save_public_items(&items) {
        tracing::warn!(%error, "public catalog witness could not be saved");
    }
}

fn marketplace_stats_store() -> &'static Mutex<BTreeMap<String, MarketplaceStatsSnapshot>> {
    MARKETPLACE_STATS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn marketplace_id(kind: &str, id: &str) -> Option<(String, String)> {
    let kind = kind.trim().to_ascii_lowercase();
    let id = id.trim();
    if !MARKETPLACE_STATS_KINDS.contains(&kind.as_str())
        || id.is_empty()
        || id.len() > MARKETPLACE_STATS_MAX_ID_BYTES
        || !id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || "@._/-".contains(value))
        || id.split('/').any(|part| part == "." || part == "..")
    {
        return None;
    }
    Some((kind, id.to_owned()))
}

fn marketplace_runtime_identity(kind: &str, id: &str) -> Option<(String, String)> {
    if kind.trim().eq_ignore_ascii_case("skill") {
        let listing = crate::skills_catalog::public_stats::download_identity(id)?;
        return marketplace_id("skill", &listing);
    }
    let (kind, id) = marketplace_id(kind, id)?;
    let items = public_items_store().lock().ok()?;
    resolve_public_identity(&items, kind, id)
}

fn resolve_public_identity(
    items: &PublicItemWitnesses,
    kind: String,
    id: String,
) -> Option<(String, String)> {
    if let Some((listed_kind, listing_id)) = items.runtime_ids.get(&format!("{kind}:{id}")) {
        return items
            .listing_ids
            .contains(&format!("{listed_kind}:{listing_id}"))
            .then(|| (listed_kind.clone(), listing_id.clone()));
    }
    items
        .listing_ids
        .contains(&format!("{kind}:{id}"))
        .then_some((kind, id))
}

/// Associate a host-created runtime id with its Marketplace listing id. This is
/// needed for published Agent Templates, whose safe local agent id is generated
/// during import and therefore differs from the public listing id.
pub fn associate_marketplace_runtime(kind: &str, marketplace: &str, runtime: &str) {
    let Some((kind, marketplace)) = marketplace_id(kind, marketplace) else {
        return;
    };
    let runtime = runtime.trim();
    if runtime.is_empty() || runtime.len() > MARKETPLACE_STATS_MAX_ID_BYTES {
        return;
    }
    if let Ok(mut items) = public_items_store().lock() {
        if items.listing_ids.contains(&format!("{kind}:{marketplace}")) {
            items
                .runtime_ids
                .insert(format!("{kind}:{runtime}"), (kind, marketplace));
            if let Err(error) = save_public_items(&items) {
                tracing::warn!(%error, "public runtime witness could not be saved");
            }
        }
    }
}

fn definition_fingerprint(definition: &impl Serialize) -> Option<String> {
    use sha2::{Digest, Sha256};
    Some(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(definition).ok()?)
    ))
}

pub fn witness_runtime_definition(
    kind: &str,
    listing: &str,
    runtime: &str,
    definition: &impl Serialize,
) {
    let Some(fingerprint) = definition_fingerprint(definition) else {
        return;
    };
    associate_marketplace_runtime(kind, listing, runtime);
    if let Ok(mut items) = public_items_store().lock() {
        if items.listing_ids.contains(&format!("{kind}:{listing}")) {
            items
                .definitions
                .insert(format!("{kind}:{runtime}"), fingerprint);
            if let Err(error) = save_public_items(&items) {
                tracing::warn!(%error, "public definition witness could not be saved");
            }
        }
    }
}

pub fn record_definition_run(kind: &str, runtime: &str, definition: &impl Serialize) {
    let Some(fingerprint) = definition_fingerprint(definition) else {
        return;
    };
    let verified = public_items_store().lock().ok().is_some_and(|items| {
        items.definitions.get(&format!("{kind}:{runtime}")) == Some(&fingerprint)
    });
    if !verified {
        return;
    }
    let Some((kind, id)) = marketplace_runtime_identity(kind, runtime) else {
        return;
    };
    record_identity(kind, id, false);
}

/// Record one local, content-free Marketplace event. Counters stay in Core until
/// the consent-gated beacon sends a snapshot; no account or organization is read.
pub fn record_marketplace_event(kind: &str, id: &str, download: bool) {
    if !download
        && (kind.trim().eq_ignore_ascii_case("agent")
            || kind.trim().eq_ignore_ascii_case("workflow"))
    {
        return;
    }
    let Some((kind, id)) = marketplace_runtime_identity(kind, id) else {
        return;
    };
    record_identity(kind, id, download);
}

/// Only the exact loaded artifact from a witnessed public installation may
/// contribute a skill ID. Private discovery still leaves aggregate usage intact.
pub fn record_skill_load(record: &ryu_skills::SkillRecord) {
    let Some(listing) = crate::skills_catalog::public_stats::loaded_identity(record) else {
        return;
    };
    let Some((kind, id)) = marketplace_id("skill", &listing) else {
        return;
    };
    record_identity(kind, id, false);
}

fn record_identity(kind: String, id: String, download: bool) {
    let key = format!("{kind}:{id}");
    let Ok(mut store) = marketplace_stats_store().lock() else {
        return;
    };
    let entry = store
        .entry(key)
        .or_insert_with(|| MarketplaceStatsSnapshot {
            id,
            kind,
            downloads: 0,
            runs: 0,
        });
    if download {
        entry.downloads = entry.downloads.saturating_add(1);
    } else {
        entry.runs = entry.runs.saturating_add(1);
    }
}

fn marketplace_stats_snapshot() -> Vec<MarketplaceStatsSnapshot> {
    marketplace_stats_store()
        .lock()
        .map(|store| store.values().cloned().collect())
        .unwrap_or_default()
}

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
    api_calls_protected: u64,
    malicious_calls_blocked: u64,
    input_tokens: u64,
    output_tokens: u64,
    tokens_saved: u64,
    cache_hit_rate: f64,
    os: String,
    arch: String,
    version: String,
    engine: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    marketplace_stats: Vec<MarketplaceStatsSnapshot>,
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
            let requests = read_u64("requests");
            let payload = IngestPayload {
                instance_id,
                session_id: session_id.clone(),
                requests,
                // Fall back to the existing request counter so an older
                // Gateway remains compatible with the richer beacon schema.
                api_calls_protected: read_u64("api_calls_protected").max(requests),
                malicious_calls_blocked: read_u64("malicious_calls_blocked"),
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
                marketplace_stats: marketplace_stats_snapshot(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marketplace_identity_is_normalized_and_path_safe() {
        assert_eq!(
            marketplace_id("AGENT", "ryu/design-director"),
            Some(("agent".to_owned(), "ryu/design-director".to_owned()))
        );
        assert!(marketplace_id("agent", "../secret").is_none());
        assert!(marketplace_id("unknown", "demo").is_none());
    }

    #[test]
    fn private_discovered_skills_never_enter_the_per_listing_snapshot() {
        let private_id = "private-local-skill-0320a115a6c8819188e4edb47a4756ea";
        for kind in ["skill", "SKILL", " skill "] {
            assert!(marketplace_runtime_identity(kind, private_id).is_none());
            record_marketplace_event(kind, private_id, false);
            record_marketplace_event(kind, private_id, true);
        }
        let record = ryu_skills::parse_skill_md(
            private_id,
            "---\nname: Private review\n---\nPrivate instructions",
        )
        .expect("private record");
        record_skill_load(&record);
        let payload = serde_json::to_value(marketplace_stats_snapshot()).expect("snapshot");
        assert!(!payload.to_string().contains(private_id));
        assert!(!payload.to_string().contains("Private instructions"));
    }

    #[test]
    fn private_agent_workflow_plugin_and_usage_ids_need_public_source_witnesses() {
        let mut items = PublicItemWitnesses {
            version: 1,
            authority: "https://api.ryuhq.com".into(),
            ..Default::default()
        };
        items
            .listing_ids
            .insert("agent:publisher/public-agent".into());
        items.runtime_ids.insert(
            "agent:installed-runtime".into(),
            ("agent".into(), "publisher/public-agent".into()),
        );
        assert_eq!(
            resolve_public_identity(&items, "agent".into(), "installed-runtime".into()),
            Some(("agent".into(), "publisher/public-agent".into()))
        );
        items.runtime_ids.insert(
            "agent:private-runtime".into(),
            ("agent".into(), "private/company-secret".into()),
        );
        assert!(
            resolve_public_identity(&items, "agent".into(), "private-runtime".into()).is_none()
        );
        for kind in ["agent", "workflow", "plugin", "app", "model", "bundle"] {
            assert!(
                resolve_public_identity(&items, kind.into(), "private-company-name".into())
                    .is_none()
            );
            assert!(marketplace_runtime_identity(kind, "private-company-0320-unknown").is_none());
        }
    }

    #[test]
    fn marketplace_snapshot_uses_content_free_camel_case_fields() {
        let payload = IngestPayload {
            instance_id: "instance".to_owned(),
            session_id: "session".to_owned(),
            requests: 0,
            api_calls_protected: 0,
            malicious_calls_blocked: 0,
            input_tokens: 0,
            output_tokens: 0,
            tokens_saved: 0,
            cache_hit_rate: 0.0,
            os: "test".to_owned(),
            arch: "test".to_owned(),
            version: "test".to_owned(),
            engine: "test".to_owned(),
            marketplace_stats: vec![MarketplaceStatsSnapshot {
                id: "ryu/design-director".to_owned(),
                kind: "agent".to_owned(),
                downloads: 1,
                runs: 2,
            }],
        };
        let value = serde_json::to_value(payload).expect("payload should serialize");
        assert_eq!(value["marketplaceStats"][0]["downloads"], 1);
        assert_eq!(value["marketplaceStats"][0]["runs"], 2);
        assert_eq!(value["apiCallsProtected"], 0);
        assert_eq!(value["maliciousCallsBlocked"], 0);
        assert!(value.get("userId").is_none());
        assert!(value.get("hostname").is_none());
    }
}
