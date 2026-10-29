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
        ANTHROPIC_CREDITS_PROVIDER_ID, BEDROCK_PROVIDER_ID, CLOUDFLARE_PROVIDER_ID,
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
    if let Some(c) = &config.bedrock {
        push(BEDROCK_PROVIDER_ID, &c.api_key, &c.base_url);
    }
    if let Some(c) = &config.vertex {
        push(VERTEX_PROVIDER_ID, &c.api_key, &c.base_url);
    }
    if let Some(c) = &config.openai_credits {
        push(OPENAI_CREDITS_PROVIDER_ID, &c.api_key, &c.base_url);
    }
    if let Some(c) = &config.anthropic_credits {
        push(ANTHROPIC_CREDITS_PROVIDER_ID, &c.api_key, &c.base_url);
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

async fn get_json(request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request
        .timeout(LIST_TIMEOUT)
        .send()
        .await
        .map_err(|error| status_line(&format!("request failed: {error}")))?;
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|len| len as usize > MAX_BODY_BYTES)
    {
        return Err("listing too large".to_owned());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| status_line(&format!("read failed: {error}")))?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err("listing too large".to_owned());
    }
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    serde_json::from_slice(&bytes).map_err(|_| "invalid JSON".to_owned())
}

/// OpenAI chat models only: `gpt-*`, `o<digit>*`, `chatgpt-*`, minus audio,
/// realtime, speech, search, embedding, image and moderation models.
pub fn is_openai_chat_model(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    let family = id.starts_with("gpt-")
        || id.starts_with("chatgpt-")
        || (id.starts_with('o') && id.chars().nth(1).is_some_and(|c| c.is_ascii_digit()));
    family
        && ![
            "audio",
            "realtime",
            "tts",
            "transcribe",
            "search",
            "embedding",
            "image",
            "moderation",
        ]
        .iter()
        .any(|word| id.contains(word))
}

pub fn openai_models(body: &Value) -> Vec<ListedModel> {
    body["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|model| model["id"].as_str())
        .filter(|id| is_openai_chat_model(id))
        .map(|id| ListedModel {
            id: id.to_owned(),
            display_name: None,
            evidence_ids: Vec::new(),
        })
        .collect()
}

/// `claude-sonnet-4-5-20250929` → `claude-sonnet-4-5`.
pub fn anthropic_alias(id: &str) -> &str {
    match id.rsplit_once('-') {
        Some((head, date)) if date.len() == 8 && date.chars().all(|c| c.is_ascii_digit()) => head,
        _ => id,
    }
}

/// Group Anthropic's dated listing under the undated aliases a request names;
/// the dated ids are kept as evidence.
pub fn anthropic_models(pages: &[Value]) -> Vec<ListedModel> {
    let mut grouped: Vec<ListedModel> = Vec::new();
    for page in pages {
        for model in page["data"].as_array().into_iter().flatten() {
            let Some(id) = model["id"].as_str() else {
                continue;
            };
            let alias = anthropic_alias(id);
            let display = model["display_name"].as_str().map(str::to_owned);
            match grouped.iter_mut().find(|entry| entry.id == alias) {
                Some(entry) => {
                    if id != alias {
                        entry.evidence_ids.push(id.to_owned());
                    }
                }
                None => grouped.push(ListedModel {
                    id: alias.to_owned(),
                    display_name: display,
                    evidence_ids: if id == alias {
                        Vec::new()
                    } else {
                        vec![id.to_owned()]
                    },
                }),
            }
        }
    }
    grouped
}

/// Cloudflare's model-search URL for the account in a Workers AI base URL
/// (`…/accounts/{id}/ai/v1` → `…/accounts/{id}/ai/models/search`).
pub fn cloudflare_search_url(base_url: &str) -> Option<String> {
    let trimmed = base_url.trim_end_matches('/');
    if !trimmed.contains("/accounts/") {
        return None;
    }
    let ai = trimmed.rfind("/ai")?;
    Some(format!("{}/ai/models/search", &trimmed[..ai]))
}

pub fn cloudflare_models(page: &Value) -> Vec<ListedModel> {
    page["result"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|model| model["name"].as_str())
        .map(|name| ListedModel {
            id: name.to_owned(),
            display_name: None,
            evidence_ids: Vec::new(),
        })
        .collect()
}

/// Bedrock Mantle's model list for the `/anthropic` base URL Ryu dispatches on.
pub fn bedrock_models_url(base_url: &str) -> Option<String> {
    let trimmed = base_url.trim_end_matches('/');
    trimmed
        .strip_suffix("/anthropic")
        .map(|origin| format!("{origin}/v1/models"))
}

/// `https://bedrock-mantle.us-east-1.api.aws/…` → `us-east-1`.
pub fn bedrock_region(base_url: &str) -> Option<String> {
    let host = reqwest::Url::parse(base_url).ok()?.host_str()?.to_owned();
    let rest = host.strip_prefix("bedrock-mantle.")?;
    rest.split('.').next().map(str::to_owned)
}

/// List one slot's models.
pub async fn list_models(http: &reqwest::Client, access: &SlotAccess) -> Listing {
    use crate::config::{
        ANTHROPIC_CREDITS_PROVIDER_ID, BEDROCK_PROVIDER_ID, CLOUDFLARE_PROVIDER_ID,
        OPENAI_CREDITS_PROVIDER_ID,
    };
    let base = access.base_url.trim_end_matches('/');
    match access.slot {
        OPENAI_CREDITS_PROVIDER_ID => {
            match get_json(
                http.get(format!("{base}/models"))
                    .bearer_auth(&access.api_key),
            )
            .await
            {
                Ok(body) => Listing::Ok(openai_models(&body)),
                Err(error) => Listing::Error(error),
            }
        }
        ANTHROPIC_CREDITS_PROVIDER_ID => {
            let mut pages = Vec::new();
            let mut after: Option<String> = None;
            for _ in 0..MAX_PAGES {
                let mut url = format!("{base}/v1/models?limit=1000");
                if let Some(after) = &after {
                    url.push_str(&format!("&after_id={after}"));
                }
                let page = match get_json(
                    http.get(url)
                        .header("x-api-key", &access.api_key)
                        .header("anthropic-version", "2023-06-01"),
                )
                .await
                {
                    Ok(page) => page,
                    Err(error) => return Listing::Error(error),
                };
                let more = page["has_more"].as_bool().unwrap_or(false);
                after = page["last_id"].as_str().map(str::to_owned);
                pages.push(page);
                if !more || after.is_none() {
                    break;
                }
            }
            Listing::Ok(anthropic_models(&pages))
        }
        CLOUDFLARE_PROVIDER_ID => {
            let Some(search) = cloudflare_search_url(base) else {
                return Listing::Unsupported;
            };
            let mut models = Vec::new();
            for page in 1..=MAX_PAGES {
                let url = format!(
                    "{search}?task=Text%20Generation&hide_experimental=true&per_page=100&page={page}"
                );
                let body = match get_json(http.get(url).bearer_auth(&access.api_key)).await {
                    Ok(body) => body,
                    Err(error) => return Listing::Error(error),
                };
                if body["success"].as_bool() == Some(false) {
                    return Listing::Error("listing refused".to_owned());
                }
                let found = cloudflare_models(&body);
                let total = body["result_info"]["total_count"].as_u64();
                let done =
                    found.len() < 100 || total.is_some_and(|total| (page as u64) * 100 >= total);
                models.extend(found);
                if done {
                    break;
                }
            }
            Listing::Ok(models)
        }
        BEDROCK_PROVIDER_ID => {
            let Some(url) = bedrock_models_url(base) else {
                return Listing::Unsupported;
            };
            match get_json(http.get(url).bearer_auth(&access.api_key)).await {
                Ok(body) => Listing::Ok(
                    body["data"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|model| model["id"].as_str())
                        .map(|id| ListedModel {
                            id: id.to_owned(),
                            display_name: None,
                            evidence_ids: Vec::new(),
                        })
                        .collect(),
                ),
                Err(error) => Listing::Error(error),
            }
        }
        // Vertex: the OpenAI-compatible surface has no `/models`; phase 2 lists
        // publisher models with a service-account credential. Until then the
        // control plane proposes identity matches and the canary verifies them.
        _ => Listing::Unsupported,
    }
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
mod tests {
    use super::*;

    #[test]
    fn openai_listing_keeps_chat_models_only() {
        let body = json!({"data": [
            {"id": "gpt-5"}, {"id": "gpt-5-2025-08-07"}, {"id": "o3"}, {"id": "o4-mini"},
            {"id": "chatgpt-4o-latest"}, {"id": "gpt-4o-audio-preview"},
            {"id": "gpt-4o-realtime-preview"}, {"id": "text-embedding-3-large"},
            {"id": "gpt-image-1"}, {"id": "omni-moderation-latest"}, {"id": "dall-e-3"},
            {"id": "gpt-4o-mini-tts"}, {"id": "gpt-4o-search-preview"}
        ]});
        let ids: Vec<String> = openai_models(&body).into_iter().map(|m| m.id).collect();
        assert_eq!(
            ids,
            [
                "gpt-5",
                "gpt-5-2025-08-07",
                "o3",
                "o4-mini",
                "chatgpt-4o-latest"
            ]
        );
    }

    #[test]
    fn anthropic_listing_groups_dated_ids_under_the_alias() {
        let pages = vec![
            json!({"data": [
                {"id": "claude-sonnet-4-5-20250929", "display_name": "Claude Sonnet 4.5"},
                {"id": "claude-opus-4-5-20251101"}
            ], "has_more": true, "last_id": "claude-opus-4-5-20251101"}),
            json!({"data": [{"id": "claude-haiku-4-5-20251001"}], "has_more": false}),
        ];
        let models = anthropic_models(&pages);
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].id, "claude-sonnet-4-5");
        assert_eq!(models[0].evidence_ids, ["claude-sonnet-4-5-20250929"]);
        assert_eq!(models[0].display_name.as_deref(), Some("Claude Sonnet 4.5"));
        assert_eq!(
            anthropic_alias("claude-3-7-sonnet-latest"),
            "claude-3-7-sonnet-latest"
        );
    }

    #[test]
    fn cloudflare_and_bedrock_urls_derive_from_the_dispatch_base() {
        assert_eq!(
            cloudflare_search_url("https://api.cloudflare.com/client/v4/accounts/abc/ai/v1"),
            Some("https://api.cloudflare.com/client/v4/accounts/abc/ai/models/search".to_owned())
        );
        assert_eq!(cloudflare_search_url("https://proxy.example/v1"), None);
        assert_eq!(
            cloudflare_models(
                &json!({"success": true, "result": [{"name": "@cf/meta/llama-3.1-8b-instruct"}]})
            )[0]
            .id,
            "@cf/meta/llama-3.1-8b-instruct"
        );
        assert_eq!(
            bedrock_models_url("https://bedrock-mantle.us-east-1.api.aws/anthropic"),
            Some("https://bedrock-mantle.us-east-1.api.aws/v1/models".to_owned())
        );
        assert_eq!(bedrock_models_url("https://bedrock.example/v1"), None);
        assert_eq!(
            bedrock_region("https://bedrock-mantle.eu-west-1.api.aws/anthropic").as_deref(),
            Some("eu-west-1")
        );
    }

    #[test]
    fn the_report_carries_no_key_material() {
        let access = SlotAccess {
            slot: "cloudflare",
            api_key: "cf-SECRET-TOKEN-1234567890".to_owned(),
            base_url: "https://api.cloudflare.com/client/v4/accounts/acct-777/ai/v1".to_owned(),
        };
        let report = build_report(
            "instance",
            &access,
            Listing::Error(status_line(
                "request failed: error sending request for url (https://api.cloudflare.com/client/v4/accounts/acct-777/ai/models/search)",
            )),
            vec![CanaryReport {
                upstream: "@cf/meta/llama-3.1-8b-instruct".to_owned(),
                ok: false,
                error: Some(status_line("HTTP 404 at https://api.cloudflare.com/client/v4/accounts/acct-777/ai/v1")),
            }],
            vec![("@cf/meta/llama-3.1-8b-instruct".to_owned(), 2)],
        );
        let wire = serde_json::to_string(&report).unwrap();
        assert!(!wire.contains("SECRET"), "{wire}");
        assert!(!wire.contains("acct-777"), "{wire}");
        assert!(wire.contains(&key_fingerprint(&access.api_key)));
        assert_eq!(key_fingerprint(&access.api_key).len(), 16);
        assert!(wire.contains("\"status\":\"error\""));
        assert!(wire.contains(
            "\"quarantines\":[{\"upstream\":\"@cf/meta/llama-3.1-8b-instruct\",\"count\":2}]"
        ));
    }

    #[test]
    fn jitter_stays_within_ten_percent() {
        for _ in 0..50 {
            let value = jittered(Duration::from_secs(1000)).as_secs();
            assert!((900..=1100).contains(&value), "{value}");
        }
    }
}
