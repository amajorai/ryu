//! Local ryu-gateway lifecycle (data plane, per-machine).
//!
//! Core routes every model call it makes through `apps/gateway` (`ryu-gateway`,
//! an OpenAI-compatible Axum server). This module owns the gateway as part of
//! the local stack: it spawns the binary, waits for it to become healthy, and
//! keeps the child handle so it is killed on shutdown.
//!
//! Provider credentials (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `LOCAL_LLM_URL`,
//! …) live in Core's environment and are inherited by the spawned gateway, so
//! the gateway — not Core — owns provider creds and forwards to the engine.
//!
//! Scope (U18): Core's own OpenAI-compatible calls and any ACP egress that opts
//! into the Gateway route through the same governed surface. ACP subprocesses
//! still own their HTTP client, so agent-scoped ACP routing is expressed through
//! the Gateway's `/v1/agents/:agent_id` ingress rather than by intercepting the
//! subprocess.

use std::{sync::OnceLock, time::Duration};

use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::sidecar::active_engine::{local_engine_url, ActiveEngineStore};
use crate::sidecar::process::ProcessHandle;
// The classify sidecar's registered name, imported (not re-spelled) so the lazy-start
// call below can never target a name the sidecar does not answer to. See
// [`CLASSIFY_SIDECAR_NAME`]'s doc for why the literal is banned.
use crate::sidecar::providers::llamacpp::classify::CLASSIFY_SIDECAR_NAME;

/// Default address the local gateway binds to and Core forwards chat to.
/// Matches the Gateway loopback bind; profiles offset the port consistently.
pub const DEFAULT_GATEWAY_URL: &str = "http://127.0.0.1:7981";

/// Env var pointing Core at the gateway base URL (no trailing `/v1`).
const ENV_GATEWAY_URL: &str = "RYU_GATEWAY_URL";
/// Env var with a bearer token for the gateway, when it runs with auth enabled.
const ENV_GATEWAY_TOKEN: &str = "RYU_GATEWAY_TOKEN";
/// Core-only trusted relay for an externally managed Gateway.
const ENV_GATEWAY_CORE_TOKEN: &str = "RYU_GATEWAY_CORE_TOKEN";
/// Proof-only Core signer; never a bearer or standalone authorization key.
const ENV_GATEWAY_CORE_PROOF_KEY: &str = "RYU_GATEWAY_CORE_PROOF_KEY";
/// Env var to disable Core spawning/managing the gateway (assume external).
const ENV_GATEWAY_MANAGED: &str = "RYU_GATEWAY_MANAGED";
/// Env var pointing the MANAGED provider at the hosted gateway fleet.
const ENV_MANAGED_FLEET_URL: &str = "RYU_MANAGED_GATEWAY_URL";
/// Env var carrying the org's `rgw_` token for the hosted gateway fleet.
const ENV_MANAGED_FLEET_TOKEN: &str = "RYU_MANAGED_GATEWAY_TOKEN";

/// Preference keys mirroring the two env vars above, so the desktop can wire a
/// LOCAL node to managed inference without an env edit + restart.
pub const MANAGED_FLEET_URL_PREF_KEY: &str = "managed-gateway-url";
pub const MANAGED_FLEET_TOKEN_PREF_KEY: &str = "managed-gateway-token";
/// JSON preference carrying the node's per-request managed-routing preferences.
/// The value is encoded once into `x-ryu-node-routing` for gateway-forwarded
/// requests; it is never sent to a direct provider.
pub const NODE_ROUTING_PREF_KEY: &str = "node-routing-prefs";

/// Pref-seeded half of the managed-fleet coordinates.
///
/// `apply()` in `pi_config` is synchronous but the preferences store is async,
/// so — exactly like `ryu_mesh`'s `MESH_PREF_ENABLED` — Core seeds this once at
/// boot and the runtime config route updates it, letting the sync path read
/// `env || pref` without an await.
static MANAGED_FLEET_PREF: std::sync::RwLock<Option<(String, String)>> =
    std::sync::RwLock::new(None);

/// Seed/update the pref half of the managed-fleet coordinates. Passing `None`
/// (or an empty url/token) clears it, which falls the managed provider back to
/// the local gateway.
pub fn set_managed_fleet_pref(url: Option<String>, token: Option<String>) {
    let resolved = match (url, token) {
        (Some(u), Some(t)) if !u.trim().is_empty() && !t.trim().is_empty() => {
            Some((u.trim().to_owned(), t.trim().to_owned()))
        }
        _ => None,
    };
    if let Ok(mut slot) = MANAGED_FLEET_PREF.write() {
        *slot = resolved;
    }
}

/// The hosted gateway fleet's `(base_url, token)` for the MANAGED provider, or
/// `None` when this node has no managed coordinates.
///
/// This is what makes "remote gateway for managed, local gateway for BYOK"
/// possible on ONE node: the managed provider is billed against the org's
/// credits and must reach the multi-tenant fleet (whose env holds the provider
/// keys), while every BYOK provider keeps using the user's own local gateway.
/// Without this, a self-hosted node that selected "Ryu (managed)" pointed at its
/// OWN keyless gateway and could never actually spend the plan it paid for.
///
/// Env wins over the pref so an operator can pin a node; both must be present
/// (a URL with no token would 401 against the fleet).
pub fn managed_fleet() -> Option<(String, String)> {
    let env_url = std::env::var(ENV_MANAGED_FLEET_URL)
        .ok()
        .filter(|s| !s.trim().is_empty());
    let env_token = std::env::var(ENV_MANAGED_FLEET_TOKEN)
        .ok()
        .filter(|s| !s.trim().is_empty());
    let environment = env_url.zip(env_token);
    let enrolled = crate::fleet::enrolled_managed_fleet();
    let preference = MANAGED_FLEET_PREF
        .read()
        .ok()
        .and_then(|value| value.clone());
    select_managed_fleet(environment, enrolled, preference)
}

fn select_managed_fleet(
    environment: Option<(String, String)>,
    enrolled: Option<(String, String)>,
    preference: Option<(String, String)>,
) -> Option<(String, String)> {
    environment
        .map(|(url, token)| (url.trim().to_owned(), token.trim().to_owned()))
        .or(enrolled)
        .or(preference)
}

/// This node's own routing PREFERENCES, as the encoded `x-ryu-node-routing`
/// value (`v1.<base64url-nopad(JSON)>`), or `None` when the node has stated none.
///
/// # Why this exists
///
/// On a remote data plane there is no local gateway, so `gateway.toml` is not the
/// source for anything — the node's opinions have to travel per request or not at
/// all. Most already do: `connect_openai` sends the slot pins, prompt-cache
/// mode/ttl, agent id and priority, and injects `ryu_smart_route` into the body.
/// The preferences that had nowhere to go are the node's preferred FALLBACK
/// ORDER, its EXTRA firewall rules, and its OpenRouter provider options. This is
/// their carrier.
///
/// The value is stored in the node preference store under
/// [`NODE_ROUTING_PREF_KEY`]. Core loads it at boot and refreshes it when the
/// preference changes, so a managed-routing setting takes effect without a
/// restart. An absent or malformed value clears the carrier rather than leaving
/// stale routing active.
///
/// Sync and allocation-light (one `String` clone per turn) because it is called
/// per request from a sync path, following [`MANAGED_FLEET_PREF`]: the
/// preferences store is async and this path is not.
pub fn node_routing_header() -> Option<String> {
    NODE_ROUTING_PREF.read().ok()?.clone()
}

/// Pre-encoded `x-ryu-node-routing` value, seeded at boot and refreshed by the
/// runtime config route — same boot-seeded-`RwLock` shape as
/// [`MANAGED_FLEET_PREF`], and for the same reason. Encoded ONCE on write rather
/// than per turn: the read side is on the hot path, the write side is not.
static NODE_ROUTING_PREF: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

/// Set (or clear) this node's routing preferences.
///
/// `fallback` is an ordered list of gateway provider ids. The fleet treats it as
/// a preference over ITS OWN chain for the routed primary — ids it would not have
/// used anyway are dropped, the primary stays pinned, and each survivor is
/// re-checked against the org's credit pools. So an id here can reorder, never
/// widen. `firewall` is a `FirewallOverlay`-shaped object applied as the narrowest
/// scope and only ever additively (it can tighten a dial or append a pattern; it
/// cannot loosen one). `openrouter` carries request provider defaults used only
/// on OpenRouter attempts; managed Gateway privacy policy remains authoritative.
/// All three empty ⇒ the header is omitted entirely.
pub fn set_node_routing_prefs(fallback: Vec<String>, firewall: Option<serde_json::Value>) {
    set_node_routing_prefs_with_openrouter(fallback, firewall, None);
}

fn set_node_routing_prefs_with_openrouter(
    fallback: Vec<String>,
    firewall: Option<serde_json::Value>,
    openrouter: Option<serde_json::Value>,
) {
    use base64::Engine as _;

    let fallback: Vec<String> = fallback
        .into_iter()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect();
    let openrouter = openrouter.filter(|value| {
        value
            .as_object()
            .is_some_and(|preferences| !preferences.is_empty())
    });
    let encoded = if fallback.is_empty() && firewall.is_none() && openrouter.is_none() {
        None
    } else {
        let mut doc = serde_json::Map::new();
        if !fallback.is_empty() {
            doc.insert("fallback".to_owned(), serde_json::json!(fallback));
        }
        if let Some(fw) = firewall {
            doc.insert("firewall".to_owned(), fw);
        }
        if let Some(openrouter) = openrouter {
            doc.insert("openrouter".to_owned(), openrouter);
        }
        // A document that will not serialize is dropped rather than sent half
        // formed — the whole channel is best-effort by design.
        serde_json::to_vec(&serde_json::Value::Object(doc))
            .ok()
            .map(|bytes| {
                format!(
                    "v1.{}",
                    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
                )
            })
    };
    if let Ok(mut slot) = NODE_ROUTING_PREF.write() {
        *slot = encoded;
    }
}

/// Refresh the encoded request carrier from the raw preference-store value.
///
/// The preference is deliberately a small JSON envelope instead of a second
/// set of KV keys: fallback order, additive firewall overlay, and OpenRouter
/// provider options must update atomically. Unknown fields are ignored for forward compatibility, while a
/// malformed value clears the old carrier so an invalid edit cannot continue to
/// affect requests.
pub fn set_node_routing_prefs_from_json(raw: &str) {
    #[derive(Default, serde::Deserialize)]
    #[serde(default)]
    struct NodeRoutingPreference {
        fallback: Vec<String>,
        firewall: Option<serde_json::Value>,
        openrouter: Option<serde_json::Value>,
    }

    let Ok(value) = serde_json::from_str::<NodeRoutingPreference>(raw) else {
        set_node_routing_prefs(Vec::new(), None);
        return;
    };

    let firewall = value.firewall.filter(|value| !value.is_null());
    set_node_routing_prefs_with_openrouter(value.fallback, firewall, value.openrouter);
}
/// Env var overriding the gateway binary path (otherwise resolved on PATH).
const ENV_GATEWAY_BIN: &str = "RYU_GATEWAY_BIN";
/// Default gateway binary name (resolved via PATH, including `~/.ryu/bin`).
const DEFAULT_GATEWAY_BIN: &str = "ryu-gateway";
/// Env var the gateway reads to configure its `local` provider base URL
/// (see `apps/gateway/src/config.rs`). Core sets this to the active local
/// engine's OpenAI-compatible URL so the engine registers as a routable
/// provider in the gateway router (U19).
const ENV_LOCAL_LLM_URL: &str = "LOCAL_LLM_URL";
/// Env var the gateway reads to configure its `classify` provider base URL — the
/// cheap classify tier served by Core's `llamacpp-classify` sidecar. Separate from
/// [`ENV_LOCAL_LLM_URL`] because `local` points at the single **resident chat
/// engine**: one llama-server serves one model, so the classify tier needs its own
/// provider or a 270M classifier selection silently runs on the full-size chat model.
const ENV_CLASSIFY_LLM_URL: &str = "RYU_CLASSIFY_LLM_URL";
/// Env var carrying the classify tier's resolved model **id** (not just its URL) to
/// the gateway, so the gateway's inspector/judge default and its seeded
/// `routing.model_map` entry name the model actually served on
/// [`ENV_CLASSIFY_LLM_URL`]. Without it the gateway's `DEFAULT_INSPECTOR_MODEL` was
/// an independent literal: a registry id swap left the documented swap seam
/// producing an UNROUTABLE config (no map hit, no builtin prefix hit → the id went
/// to `default_provider`, i.e. a hosted provider, which 400s while the guardrail
/// failed open in silence). Read by `apps/gateway/src/config.rs::classify_model_id`.
const ENV_CLASSIFY_MODEL_ID: &str = "RYU_CLASSIFY_MODEL_ID";
/// Env var carrying the `local` provider's model rewrites as a JSON object
/// (`{"llama3.2": "ryu-llama3.2-<hash>"}`): requested name → name the engine
/// serves. Populated from the Ollama derived-model routes that apply per-model
/// launch settings. Read by `apps/gateway/src/config.rs`.
const ENV_LOCAL_MODEL_ROUTES: &str = "RYU_LOCAL_MODEL_ROUTES";

/// The JSON value for [`ENV_LOCAL_MODEL_ROUTES`], or `None` when no route is set.
fn local_model_routes_env() -> Option<String> {
    let routes = crate::sidecar::providers::ollama::derived::routes_snapshot();
    if routes.is_empty() {
        return None;
    }
    serde_json::to_string(&routes).ok()
}

/// Base URL Core forwards chat completions to. Always non-empty.
///
/// Profile-aware default: release ⇒ `http://127.0.0.1:7981`, dev ⇒ `:8981`, ….
/// (Under a non-release profile `profile::apply_env_defaults` also seeds
/// `RYU_GATEWAY_URL`, so the env branch normally wins; the default is computed via
/// the same `profile::port(7981)` so both agree.)
static REJECTED_LOCAL_GATEWAY: std::sync::atomic::AtomicBool =
    // Managed local endpoints remain quarantined from process initialization,
    // including the time spent starting engines before GatewayManager::start.
    std::sync::atomic::AtomicBool::new(true);

pub fn gateway_url() -> String {
    routed_gateway_url(
        configured_gateway_url(),
        REJECTED_LOCAL_GATEWAY.load(std::sync::atomic::Ordering::Acquire),
        remote_data_plane(),
        is_managed(),
    )
}

fn routed_gateway_url(configured: String, rejected: bool, remote: bool, managed: bool) -> String {
    if rejected && !remote && managed {
        "http://127.0.0.1:0".to_owned()
    } else {
        configured
    }
}

/// Configuration-only endpoint. This never establishes readiness; authenticated
/// I/O must check readiness independently. ACP launch checks readiness
/// separately so durable command/config declarations do not capture port zero.
pub(crate) fn configured_gateway_url() -> String {
    std::env::var(ENV_GATEWAY_URL)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("http://127.0.0.1:{}", crate::profile::port(7981)))
}

pub(crate) fn local_gateway_quarantined() -> bool {
    REJECTED_LOCAL_GATEWAY.load(std::sync::atomic::Ordering::Acquire)
        && !remote_data_plane()
        && is_managed()
}

#[cfg(test)]
pub(crate) struct GatewayQuarantineTestGuard(bool);
#[cfg(test)]
impl Drop for GatewayQuarantineTestGuard {
    fn drop(&mut self) {
        REJECTED_LOCAL_GATEWAY.store(self.0, std::sync::atomic::Ordering::Release);
    }
}
#[cfg(test)]
pub(crate) fn quarantine_for_test(rejected: bool) -> GatewayQuarantineTestGuard {
    GatewayQuarantineTestGuard(
        REJECTED_LOCAL_GATEWAY.swap(rejected, std::sync::atomic::Ordering::AcqRel),
    )
}

/// Inference-only bearer. Local managed nodes provision it automatically; remote
/// nodes must receive their relay credential from enrollment or the operator.
pub fn gateway_relay_token() -> Option<String> {
    gateway_bearer()
        .map_err(|error| {
            tracing::error!(%error, "gateway relay credential unavailable");
        })
        .ok()
}

pub fn gateway_token() -> Option<String> {
    gateway_relay_token()
}

pub fn gateway_bearer() -> anyhow::Result<String> {
    if let Ok(token) = std::env::var(ENV_GATEWAY_TOKEN) {
        ryu_gw_credentials::validate(&token)?;
        return Ok(token);
    }
    if remote_data_plane() || !is_managed() {
        anyhow::bail!("an externally managed Gateway requires RYU_GATEWAY_TOKEN");
    }
    // Only Core reads this file (the Gateway child receives the key through
    // `GATEWAY_RELAY_KEY`), so it is sealed with the master key (`enc:v1:`).
    // A legacy plaintext file is resealed in place on first read; without a
    // key nothing is read or minted (fail closed). Installing the host is
    // idempotent (`main` already did); it covers callers that never ran `main`,
    // such as tests and one-shot CLI subcommands.
    crate::crypto_host::install();
    let cipher = ryu_crypto::global_cipher()?;
    ryu_gw_credentials::load_or_create_sealed(
        &crate::paths::secret_path("gateway-relay.key"),
        "gwrelay_",
        &cipher,
    )
}

/// Trusted inference forwarding is Core-only. Never inject this credential into
/// agent, app, or plugin environments; those receive `gateway_bearer` instead.
pub fn gateway_core_token() -> Option<String> {
    required_gateway_core_token()
        .map_err(|error| {
            tracing::error!(%error, "gateway Core relay credential unavailable");
        })
        .ok()
}

/// Preserve tenant billing identity on externally managed inference routes.
/// Core forwarding keys remain reserved for local inference and control APIs.
pub fn required_gateway_inference_token() -> anyhow::Result<String> {
    if remote_data_plane() || !is_managed() {
        gateway_bearer()
    } else {
        required_gateway_core_token()
    }
}

pub fn gateway_inference_token() -> Option<String> {
    required_gateway_inference_token()
        .map_err(|error| tracing::error!(%error, "gateway inference credential unavailable"))
        .ok()
}

pub(crate) fn gateway_inference_agent_proof(
    bearer: &str,
    agent_id: &str,
) -> anyhow::Result<Option<String>> {
    if !remote_data_plane() && is_managed() {
        return Ok(None);
    }
    ryu_gw_credentials::sign_agent_route_proof(
        &required_gateway_core_proof_key()?,
        bearer,
        agent_id,
    )
    .map(Some)
}

pub fn required_gateway_core_token() -> anyhow::Result<String> {
    if remote_data_plane() || !is_managed() {
        let token = std::env::var(ENV_GATEWAY_CORE_TOKEN).map_err(|_| {
            anyhow::anyhow!("an externally managed Gateway requires RYU_GATEWAY_CORE_TOKEN")
        })?;
        ryu_gw_credentials::validate(&token)?;
        return Ok(token);
    }
    Ok(ephemeral_gateway_key(&LOCAL_GATEWAY_CORE_KEY, "gwcore_"))
}

pub fn required_gateway_core_proof_key() -> anyhow::Result<String> {
    if remote_data_plane() || !is_managed() {
        let key = std::env::var(ENV_GATEWAY_CORE_PROOF_KEY).map_err(|_| {
            anyhow::anyhow!("an externally managed Gateway requires RYU_GATEWAY_CORE_PROOF_KEY")
        })?;
        ryu_gw_credentials::validate(&key)?;
        return Ok(key);
    }
    Ok(ephemeral_gateway_key(
        &LOCAL_GATEWAY_CORE_PROOF_KEY,
        "gwproof_",
    ))
}

pub fn gateway_core_proof_key() -> Option<String> {
    required_gateway_core_proof_key()
        .map_err(|error| tracing::error!(%error, "gateway Core proof key unavailable"))
        .ok()
}

/// Export a signed identity without exporting Core's forwarding authority.
/// Remote enrollment keeps its existing fleet bearer and agent-route proof.
///
/// `provider_access` is the agent's model provider access
/// ([`crate::agent_access::AgentAccountPolicy::user_provider_access`]); it is
/// signed into the scope so the agent's own HTTP client cannot drop it.
pub fn gateway_bearer_for_agent(
    agent_id: Option<&str>,
    user_id: Option<&str>,
    session_id: Option<&str>,
    provider_access: Option<&[String]>,
) -> anyhow::Result<String> {
    if !scoped_inference_proxy_enabled() {
        // Only a Core-managed Gateway verifies Core's scope, so a limited
        // agent's provider list could not travel with this bearer. Refuse
        // rather than hand the agent an unlimited one.
        if agent_id.is_some() && provider_access.is_some() {
            anyhow::bail!(
                "this agent's model provider access is limited, which needs the Gateway Core manages"
            );
        }
        return gateway_bearer();
    }
    let Some(agent_id) = agent_id else {
        return gateway_bearer();
    };
    scoped_inference_bearer(agent_id, user_id, session_id, provider_access)
}

/// Whether Core signs scoped `gws1` bearers itself: a managed, local Gateway.
/// Only then can Core's ACP inference proxy refresh an agent's bearer.
pub(crate) fn scoped_inference_proxy_enabled() -> bool {
    !remote_data_plane() && is_managed()
}

/// The current Core-signed bearer for one (agent, user, session) scope, reused
/// from the cache while it has comfortable lifetime left.
pub(crate) fn scoped_inference_bearer(
    agent_id: &str,
    user_id: Option<&str>,
    session_id: Option<&str>,
    provider_access: Option<&[String]>,
) -> anyhow::Result<String> {
    if !scoped_inference_proxy_enabled() {
        anyhow::bail!("scoped inference bearers are issued only for a managed local Gateway");
    }
    let core_token = required_gateway_core_token()?;
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(u64::MAX);
    let mut cache = INFERENCE_BEARER_CACHE
        .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    cached_inference_bearer(
        &mut cache,
        &core_token,
        agent_id,
        user_id,
        session_id,
        provider_access,
        now_secs,
    )
}

/// Lifetime of a Core-signed scoped inference bearer.
const INFERENCE_BEARER_LIFETIME_SECS: u64 = 60 * 60;
/// A cached bearer is reused only while it has more than this much validity left.
/// Half the lifetime: every proxied request still starts with at least 30
/// minutes of validity, and a bearer is reminted at most every 30 minutes.
const INFERENCE_BEARER_REMINT_MARGIN_SECS: u64 = 30 * 60;

/// Scope a cached bearer was minted for. `signer` is a SHA-256 fingerprint of
/// Core's signing token, never the token itself, so a rotated token cannot be
/// answered with a bearer signed by its predecessor.
#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) struct InferenceBearerCacheKey {
    signer: String,
    agent_id: String,
    user_id: Option<String>,
    session_id: Option<String>,
    /// The agent's signed model provider access: a different list is a
    /// different scope and never reuses another list's bearer.
    provider_access: Option<Vec<String>>,
}

pub(crate) type InferenceBearerCache =
    std::collections::HashMap<InferenceBearerCacheKey, (String, u64)>;

static INFERENCE_BEARER_CACHE: OnceLock<std::sync::Mutex<InferenceBearerCache>> = OnceLock::new();

/// Return the bearer for one (agent, user, session, signing key) scope, reusing
/// the previously minted one while it has comfortable lifetime left.
///
/// A route builds the spawn command with this bearer, and a pooled agent never
/// keeps it: `spawn_acp_task` redeems it for a per-instance credential that
/// Core's ACP inference proxy resolves to the scope, and the proxy asks this
/// cache again on every request. Reusing the bearer keeps route resolution
/// cheap, and the remint margin means every request starts with at least 30
/// minutes of validity left. A remint changes nothing about the running agent.
/// Entries inside the margin are pruned on every call, which keeps the cache
/// bounded.
pub(crate) fn cached_inference_bearer(
    cache: &mut InferenceBearerCache,
    core_token: &str,
    agent_id: &str,
    user_id: Option<&str>,
    session_id: Option<&str>,
    provider_access: Option<&[String]>,
    now_secs: u64,
) -> anyhow::Result<String> {
    let reusable =
        |expires_at: u64| expires_at.saturating_sub(now_secs) > INFERENCE_BEARER_REMINT_MARGIN_SECS;
    cache.retain(|_, (_, expires_at)| reusable(*expires_at));
    let key = InferenceBearerCacheKey {
        signer: hex::encode(<Sha256 as sha2::Digest>::digest(core_token.as_bytes())),
        agent_id: agent_id.to_owned(),
        user_id: user_id.map(str::to_owned),
        session_id: session_id.map(str::to_owned),
        provider_access: provider_access.map(<[String]>::to_vec),
    };
    if let Some((bearer, _)) = cache.get(&key) {
        return Ok(bearer.clone());
    }
    let expires_at = now_secs.saturating_add(INFERENCE_BEARER_LIFETIME_SECS);
    let bearer = ryu_gw_credentials::InferenceScope {
        agent_id: key.agent_id.clone(),
        user_id: key.user_id.clone(),
        session_id: key.session_id.clone(),
        expires_at,
        provider_access: key.provider_access.clone(),
    }
    .sign(core_token)?;
    cache.insert(key, (bearer.clone(), expires_at));
    Ok(bearer)
}

/// Verify a `gws1` bearer this Core signed with its current key and that has
/// not expired, returning its scope and the signing key's SHA-256 fingerprint
/// (never the key). `None` for anything else, including when Core does not
/// sign scoped bearers (remote or unmanaged Gateway).
pub(crate) fn verify_scoped_inference_bearer(
    token: &str,
) -> Option<(ryu_gw_credentials::InferenceScope, String)> {
    if !scoped_inference_proxy_enabled() || !token.starts_with("gws1.") {
        return None;
    }
    let core_token = required_gateway_core_token().ok()?;
    let scope = ryu_gw_credentials::InferenceScope::verify(token, &core_token).ok()?;
    let signer = hex::encode(<Sha256 as sha2::Digest>::digest(core_token.as_bytes()));
    Some((scope, signer))
}

/// OpenAI-compatible base URL of Core's ACP inference proxy.
pub(crate) fn acp_inference_proxy_v1() -> String {
    format!(
        "{}{}/v1",
        core_self_url().trim_end_matches('/'),
        crate::server::acp_inference_proxy::PROXY_PREFIX
    )
}

/// Mint the proof carried by an agent-scoped Gateway URL.
///
/// A managed `rgw_` bearer is intentionally not treated as a trusted-forwarder
/// key by the Gateway: callers holding it can reach the fleet, but they must not
/// be able to rotate `x-ryu-agent-id` and move spend between agents. Core is the
/// holder of the Core relay signer and therefore signs the concrete agent route
/// with it. The fleet verifies this with the trusted Core relay key, never the
/// inference bearer. Binding the bearer fingerprint prevents a proof from moving
/// between organizations when the Core relay key is shared by the hosted fleet.
pub fn gateway_agent_proof(agent_id: &str) -> anyhow::Result<String> {
    let token = gateway_bearer()?;
    ryu_gw_credentials::sign_agent_route_proof(
        &required_gateway_core_proof_key()?,
        &token,
        agent_id,
    )
}

/// A charge's `(user_id, agent_id)`. An agent's own Composio entity
/// (`agent:<owner>:<agent_id>`) is not a user: it is billed to its owner, and
/// names the agent when the caller did not. Callers already pass the owner
/// (`composio::charge_user_id`); this keeps the Gateway contract even if one
/// does not.
fn charge_identity<'a>(
    user_id: Option<&'a str>,
    agent_id: Option<&'a str>,
) -> (Option<&'a str>, Option<&'a str>) {
    match user_id.and_then(crate::agent_access::AgentAccountPolicy::parse_composio_agent_entity) {
        Some((owner, entity_agent)) => (Some(owner), agent_id.or(Some(entity_agent))),
        None => (user_id, agent_id),
    }
}

fn composio_authorization_body(org_id: &str, user_id: Option<&str>) -> serde_json::Value {
    let (user_id, _) = charge_identity(user_id, None);
    serde_json::json!({
        "org_id": org_id,
        "provider": "composio",
        "tool_calls": 1,
        "user_id": user_id,
        "authorizeOnly": true,
    })
}

fn tool_charge_body(
    org_id: Option<&str>,
    agent_id: Option<&str>,
    user_id: Option<&str>,
    session_id: Option<&str>,
    tool_calls: u64,
    receipt: Option<&ryu_composio::receipt::ComposioReceipt>,
    accounting_unavailable: bool,
) -> serde_json::Value {
    let (user_id, agent_id) = charge_identity(user_id, agent_id);
    serde_json::json!({
        "tool_calls": tool_calls,
        "org_id": org_id,
        "agent_id": agent_id,
        "user_id": user_id,
        "session_id": session_id,
        "request_id": format!("acp-tool:{}", uuid::Uuid::new_v4()),
        "composioUsage": receipt.map(|receipt| &receipt.usage),
        "transaction_id": receipt.map(|receipt| &receipt.transaction_id),
        "composioAccountingUnavailable": accounting_unavailable,
    })
}

/// Ask the Gateway whether one Composio action may run for `user_id`, the
/// user it is billed to (never an agent's own entity).
pub async fn authorize_composio_execution(
    client: &reqwest::Client,
    user_id: Option<&str>,
) -> anyhow::Result<()> {
    let Some(org) = crate::sidecar::control_plane::registered_org() else {
        return Ok(());
    };
    let token = if remote_data_plane() {
        gateway_relay_token()
    } else {
        gateway_admin_key()
    }
    .ok_or_else(|| anyhow::anyhow!("Gateway Composio authorization unavailable"))?;
    let response = client
        .post(format!(
            "{}/v1/budget/charge",
            gateway_url().trim_end_matches('/')
        ))
        .bearer_auth(token)
        .json(&composio_authorization_body(&org.id, user_id))
        .send()
        .await?;
    if !response.status().is_success() {
        anyhow::bail!("Composio authorization rejected with {}", response.status());
    }
    Ok(())
}

/// Best-effort notification that a Composio action executed in Core's ACP/MCP
/// bridge. The Gateway owns the budget counters and wallet rail, so Core sends
/// only the count and verified bridge identity. The request uses the Core-only
/// admin credential; remote dynamic credentials additionally carry the
/// bearer-bound agent proof so the fleet can accept the ACP identity safely.
pub async fn record_tool_charge(
    client: &reqwest::Client,
    agent_id: Option<&str>,
    user_id: Option<&str>,
    session_id: Option<&str>,
    tool_calls: u64,
    receipt: Option<&ryu_composio::receipt::ComposioReceipt>,
    accounting_unavailable: bool,
) -> anyhow::Result<()> {
    if tool_calls == 0 {
        return Ok(());
    }
    let remote = remote_data_plane();
    let token = if remote {
        gateway_relay_token()
    } else {
        gateway_admin_key()
    }
    .ok_or_else(|| anyhow::anyhow!("gateway tool-charge credential is unavailable"))?;
    let core_proof_key = if remote {
        Some(
            gateway_core_proof_key()
                .ok_or_else(|| anyhow::anyhow!("gateway Core proof key is unavailable"))?,
        )
    } else {
        None
    };
    let org_id = crate::sidecar::control_plane::registered_org().map(|org| org.id);
    let url = format!("{}/v1/budget/charge", gateway_url().trim_end_matches('/'));
    let body = tool_charge_body(
        org_id.as_deref(),
        agent_id,
        user_id,
        session_id,
        tool_calls,
        receipt,
        accounting_unavailable,
    );
    let request = client.post(url).bearer_auth(token).json(&body);
    let request = match core_proof_key {
        Some(core_proof_key) => request.header("x-ryu-core-key", core_proof_key),
        None => request,
    };
    let response = request.send().await?;
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let detail = response.text().await.unwrap_or_default();
    anyhow::bail!("gateway tool charge returned {status}: {detail}");
}

/// Descriptive provider usage reported by a sidecar. The organization is passed
/// separately by Core after resolving the registered node, never supplied by the
/// sidecar body.
#[derive(Debug, Clone)]
pub struct ExternalToolCharge {
    pub provider: String,
    pub tool_id: String,
    pub cost_micro_usd: Option<u64>,
    pub estimated: bool,
    pub transaction_id: Option<String>,
    pub request_id: String,
    pub tool_calls: u64,
    pub task_label: Option<String>,
    pub composio_usage: Option<ryu_channel_contracts::composio_billing::ComposioUsage>,
}

/// Forward a provider-neutral sidecar charge to Gateway. Gateway owns the local
/// charged-spend counters, markup policy, idempotency, and wallet debit; Core only
/// binds the report to its registered organization.
pub async fn record_external_tool_charge(
    client: &reqwest::Client,
    org_id: &str,
    charge: ExternalToolCharge,
) -> anyhow::Result<()> {
    if charge.tool_calls == 0 {
        return Ok(());
    }
    let remote = remote_data_plane();
    let token = if remote {
        gateway_relay_token()
    } else {
        gateway_admin_key()
    }
    .ok_or_else(|| anyhow::anyhow!("gateway tool-charge credential is unavailable"))?;
    let core_proof_key = if remote {
        Some(
            gateway_core_proof_key()
                .ok_or_else(|| anyhow::anyhow!("gateway Core proof key is unavailable"))?,
        )
    } else {
        None
    };
    let request_id = charge
        .transaction_id
        .as_deref()
        .map(|id| format!("{}:{id}", charge.provider.trim()))
        .unwrap_or(charge.request_id);
    let url = format!("{}/v1/budget/charge", gateway_url().trim_end_matches('/'));
    let body = serde_json::json!({
        "org_id": org_id,
        "tool_calls": charge.tool_calls,
        "provider": charge.provider,
        "tool_id": charge.tool_id,
        "cost_micro_usd": charge.cost_micro_usd,
        "estimated": charge.estimated,
        "transaction_id": charge.transaction_id,
        "task_label": charge.task_label,
        "request_id": request_id,
        "composioUsage": charge.composio_usage,
        // A hosted node's dynamic bearer requires the same Core-bound proof as
        // ACP billing. This reserved scope is accounting, not a runnable agent.
        "agent_id": remote_data_plane().then_some("external-tool-usage"),
        "agent_proof": if remote_data_plane() { Some(gateway_agent_proof("external-tool-usage")?) } else { None },
    });
    let request = client.post(url).bearer_auth(token).json(&body);
    let request = match core_proof_key {
        Some(core_proof_key) => request.header("x-ryu-core-key", core_proof_key),
        None => request,
    };
    let response = request.send().await?;
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let detail = response.text().await.unwrap_or_default();
    anyhow::bail!("gateway external tool charge returned {status}: {detail}");
}

/// Charge a delivered event once, independent of the number of targets fired.
/// The ID comes from verified ingress/Connect, and the org comes from the node.
pub async fn record_composio_trigger_delivery(
    client: &reqwest::Client,
    delivery_id: &str,
) -> anyhow::Result<()> {
    let Some(org) = crate::sidecar::control_plane::registered_org() else {
        return Ok(());
    };
    if delivery_id.is_empty() || delivery_id.len() > 256 {
        anyhow::bail!("Invalid Composio delivery billing identity");
    }
    record_external_tool_charge(
        client,
        &org.id,
        ExternalToolCharge {
            provider: "composio".to_owned(),
            tool_id: "composio.trigger".to_owned(),
            cost_micro_usd: None,
            estimated: false,
            transaction_id: Some(format!("trigger:{delivery_id}")),
            request_id: format!("composio-trigger:{delivery_id}"),
            tool_calls: 1,
            task_label: Some("Delivered Composio trigger event".to_owned()),
            composio_usage: Some(ryu_channel_contracts::composio_billing::ComposioUsage {
                kind: ryu_channel_contracts::composio_billing::ComposioUsageKind::TriggerEvent,
                ..Default::default()
            }),
        },
    )
    .await
}

/// Ask the managed Gateway whether a provider is configured. Provider credentials
/// stay in Gateway's runtime/vault; Core only carries the authenticated app request.
pub async fn managed_provider_status(
    client: &reqwest::Client,
    provider: &str,
) -> Result<bool, ryu_app_events::ProviderRouterError> {
    let remote = remote_data_plane();
    let token = if remote {
        gateway_relay_token()
    } else {
        gateway_admin_key()
    }
    .ok_or(ryu_app_events::ProviderRouterError::NotHosted)?;
    let core_proof_key = if remote {
        Some(gateway_core_proof_key().ok_or(ryu_app_events::ProviderRouterError::NotHosted)?)
    } else {
        None
    };
    let url = format!(
        "{}/v1/providers/status",
        gateway_url().trim_end_matches('/')
    );
    let request = client
        .post(url)
        .bearer_auth(token)
        .json(&serde_json::json!({ "provider": provider }));
    let request = match core_proof_key {
        Some(core_proof_key) => request.header("x-ryu-core-key", core_proof_key),
        None => request,
    };
    let response = request
        .send()
        .await
        .map_err(ryu_app_events::ProviderRouterError::Transport)?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(ryu_app_events::ProviderRouterError::Rejected { status, body });
    }
    let value: serde_json::Value = serde_json::from_str(&body).map_err(|error| {
        ryu_app_events::ProviderRouterError::Invalid(format!(
            "Gateway provider status returned invalid JSON: {error}"
        ))
    })?;
    Ok(value
        .get("configured")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false))
}

/// The header Gateway's provider admission reads as the caller's cost ceiling.
const MAX_COST_HEADER: &str = "x-ryu-max-cost-micro-usd";

/// The facts about a provider call that only Core may set: the node's org,
/// the authenticated caller, and the routing facts Core decides (the user's
/// provider pin for the call's brand, and whether Gateway must refuse a call
/// the provider cannot serve rather than run it).
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct CoreCallFacts<'a> {
    pub org_id: Option<&'a str>,
    pub caller_id: &'a str,
    pub provider_pin: Option<crate::provider_pins::ProviderPin>,
    pub require_servable: bool,
    /// The agent, user and session an agent tool call runs for, so Gateway
    /// attributes the debit to them. `None` for app calls.
    pub agent_id: Option<&'a str>,
    pub user_id: Option<&'a str>,
    pub session_id: Option<&'a str>,
}

/// Body fields that only Core writes. Any copy the call carried is dropped
/// before Core's own values are written.
const CORE_ONLY_FIELDS: [&str; 7] = [
    "orgId",
    "callerId",
    "providerPin",
    "requireServable",
    "agentId",
    "userId",
    "sessionId",
];

/// The `/v1/providers/call` body for an app's call: the app's operation facts,
/// plus the identity and routing facts only Core may set. Values the app sent
/// for those fields never survive: the call type has no such fields, any copy
/// is removed, and Core's values are written last.
fn managed_provider_call_body(
    call: ryu_app_events::ManagedProviderCall,
    facts: &CoreCallFacts<'_>,
) -> Result<serde_json::Value, ryu_app_events::ProviderRouterError> {
    let mut body = serde_json::to_value(call).map_err(|error| {
        ryu_app_events::ProviderRouterError::Invalid(format!(
            "managed provider call could not be serialized: {error}"
        ))
    })?;
    if let Some(object) = body.as_object_mut() {
        // The caller's cost ceiling travels as a header (Gateway's admission
        // reads it there), never in the body.
        object.remove("maxCostMicroUsd");
        for field in CORE_ONLY_FIELDS {
            object.remove(field);
        }
    }
    if let Some(org_id) = facts.org_id.filter(|value| !value.trim().is_empty()) {
        body["orgId"] = serde_json::Value::String(org_id.to_owned());
    }
    if let Some(pin) = facts.provider_pin {
        body["providerPin"] = serde_json::Value::String(pin.as_str().to_owned());
    }
    if facts.require_servable {
        body["requireServable"] = serde_json::Value::Bool(true);
    }
    for (field, value) in [
        ("agentId", facts.agent_id),
        ("userId", facts.user_id),
        ("sessionId", facts.session_id),
    ] {
        if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
            body[field] = serde_json::Value::String(value.to_owned());
        }
    }
    body["callerId"] = serde_json::Value::String(facts.caller_id.to_owned());
    Ok(body)
}

/// Forward one provider-neutral operation to Gateway with Core's identity and
/// routing facts. Gateway injects the provider credential, executes the call,
/// and schedules the org-wallet debit.
///
/// `facts.caller_id` is the authenticated app (sidecar plugin id) or Core's own
/// agent identity. Core sets it, never the app: Gateway scopes provider-side
/// idempotency by it.
pub(crate) async fn call_managed_provider_with(
    client: &reqwest::Client,
    facts: &CoreCallFacts<'_>,
    call: ryu_app_events::ManagedProviderCall,
) -> Result<serde_json::Value, ryu_app_events::ProviderRouterError> {
    let remote = remote_data_plane();
    let token = if remote {
        gateway_relay_token()
    } else {
        gateway_admin_key()
    }
    .ok_or(ryu_app_events::ProviderRouterError::NotHosted)?;
    let core_proof_key = if remote {
        Some(gateway_core_proof_key().ok_or(ryu_app_events::ProviderRouterError::NotHosted)?)
    } else {
        None
    };
    let url = format!("{}/v1/providers/call", gateway_url().trim_end_matches('/'));
    // A call that declares a long-running upstream operation gets a matching
    // per-request bound, so Core's shared client never cuts it off first.
    let timeout = call.timeout_ms.map(|timeout_ms| {
        std::time::Duration::from_millis(
            timeout_ms.saturating_add(ryu_app_events::ManagedProviderCall::TIMEOUT_MARGIN_MS),
        )
    });
    let max_cost = call.max_cost_micro_usd;
    let body = managed_provider_call_body(call, facts)?;
    let mut request = client.post(url).bearer_auth(token).json(&body);
    if let Some(timeout) = timeout {
        request = request.timeout(timeout);
    }
    if let Some(max_cost) = max_cost {
        request = request.header(MAX_COST_HEADER, max_cost.to_string());
    }
    let request = match core_proof_key {
        Some(core_proof_key) => request.header("x-ryu-core-key", core_proof_key),
        None => request,
    };
    let response = request
        .send()
        .await
        .map_err(ryu_app_events::ProviderRouterError::Transport)?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(ryu_app_events::ProviderRouterError::Rejected { status, body: text });
    }
    serde_json::from_str(&text).map_err(|error| {
        ryu_app_events::ProviderRouterError::Invalid(format!(
            "Gateway provider call returned invalid JSON: {error}"
        ))
    })
}

/// Admin authority stays in Core and never enters an app's inference bearer.
const ENV_GATEWAY_ADMIN_KEY: &str = "GATEWAY_ADMIN_KEY";
static LOCAL_GATEWAY_ADMIN_KEY: OnceLock<String> = OnceLock::new();
static LOCAL_GATEWAY_CORE_KEY: OnceLock<String> = OnceLock::new();
static LOCAL_GATEWAY_CORE_PROOF_KEY: OnceLock<String> = OnceLock::new();

fn ephemeral_gateway_key(slot: &'static OnceLock<String>, prefix: &str) -> String {
    slot.get_or_init(|| format!("{prefix}{}", uuid::Uuid::new_v4().simple()))
        .clone()
}

fn required_gateway_admin_key() -> anyhow::Result<String> {
    if remote_data_plane() {
        anyhow::bail!("remote inference credentials do not grant Gateway administration");
    }
    // Match Gateway's master precedence: explicit env, operator TOML, admin env.
    if let Ok(key) = std::env::var("GATEWAY_MASTER_KEY") {
        ryu_gw_credentials::validate(&key)?;
        return Ok(key);
    }
    // Core's profile initialization publishes the same path used by the child.
    if let Some(path) = std::env::var_os("GATEWAY_CONFIG") {
        match std::fs::read_to_string(path) {
            Ok(content) => {
                // `master_key` is sealed on disk; open it with the Gateway subkey.
                let config = ryu_gw_credentials::sealed_config::open_document(&content)?;
                if let Some(key) = config
                    .get("auth")
                    .and_then(|auth| auth.get("master_key"))
                    .and_then(toml::Value::as_str)
                {
                    ryu_gw_credentials::validate(key)?;
                    return Ok(key.to_owned());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    if let Ok(key) = std::env::var(ENV_GATEWAY_ADMIN_KEY) {
        ryu_gw_credentials::validate(&key)?;
        return Ok(key);
    }
    if !is_managed() {
        anyhow::bail!("an externally managed Gateway requires GATEWAY_ADMIN_KEY");
    }
    Ok(ephemeral_gateway_key(&LOCAL_GATEWAY_ADMIN_KEY, "gwadm_"))
}

pub fn gateway_admin_key() -> Option<String> {
    if remote_data_plane() {
        return None;
    }
    required_gateway_admin_key()
        .map_err(|error| {
            tracing::error!(%error, "gateway admin credential unavailable");
        })
        .ok()
}

/// Route outbound message `text` through the Gateway firewall before it leaves
/// the box (egress DLP). The shared governance seam for every outbound channel
/// send — the workflow `ChannelSend` node and the agent-callable `channel.send`
/// tool both call this, so their egress can never drift.
///
/// Returns `Ok(())` when the gateway allows it (or there is nothing to scan), and
/// `Err(reason)` when a guardrail trips OR the gateway is unreachable
/// (fail-closed, matching `run_guardrails` / the support-bundle egress gate,
/// including the `RYU_ALLOW_GATEWAY_FALLBACK=1` escape hatch). Only `pii`/`secret`
/// are requested — the `jailbreak`/`injection` patterns target inbound prompts,
/// not outbound chat. The firewall has no sanitize surface for Core to call, so a
/// tripped guardrail is block-and-refuse.
pub async fn govern_egress(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }

    let allow_fallback = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK")
        .ok()
        .is_some_and(|v| v == "1");

    let payload = serde_json::json!({
        "text": text,
        "checks": ["pii", "secret"],
    });

    let client = gateway_http_client();
    let endpoint = format!("{}/v1/firewall/check", gateway_url().trim_end_matches('/'));
    let mut builder = client
        .post(&endpoint)
        .timeout(std::time::Duration::from_secs(10))
        .json(&payload);
    if let Some(token) = gateway_token() {
        builder = builder.bearer_auth(token);
    }

    let resp = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            if allow_fallback {
                return Ok(());
            }
            return Err(format!(
                "channel egress: gateway firewall unreachable (fail-closed): {e}"
            ));
        }
    };
    if !resp.status().is_success() {
        if allow_fallback {
            return Ok(());
        }
        return Err(format!(
            "channel egress: gateway firewall returned HTTP {}",
            resp.status()
        ));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("channel egress: invalid gateway firewall response: {e}"))?;
    let allowed = body
        .get("allowed")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if allowed {
        Ok(())
    } else {
        Err("channel egress: message blocked by the gateway firewall (egress DLP)".to_string())
    }
}

/// Resolve the OpenAI-compatible base URL of the currently selected local
/// engine, for registering it as the gateway's `local` provider (U19).
///
/// Resolution order:
///   1. An explicit `LOCAL_LLM_URL` in Core's environment always wins, so an
///      operator can point the gateway at an external/custom local server.
///   2. Otherwise the persisted active local engine (U4) is mapped to its
///      serving URL.
///   3. Otherwise, when the default local stack (`llamacpp`) is installed per
///      the version store, its URL — a fresh install has no persisted engine
///      selection (nothing ever swapped), and without this fallback the gateway
///      got NO `local` provider, so the zero-key default chat model
///      (`gemma* → Local`) failed with "all_providers_unavailable" even while
///      llama-server was healthy (QA finding B1's last leg). `start_all` also
///      persists its resolved resident engine before the Gateway startup task
///      runs, so the live-sidecar gate closes the first-boot race too.
///
/// Returns `None` when none apply, in which case the gateway falls back to
/// its own built-in default (Ollama on `11434`).
pub fn local_engine_gateway_url() -> Option<String> {
    let explicit = std::env::var(ENV_LOCAL_LLM_URL).ok();
    let active = ActiveEngineStore::load().active;
    let llamacpp_installed =
        llamacpp_recorded(&crate::sidecar::download_manager::VersionStore::load());
    local_engine_gateway_url_with_state(
        explicit,
        active,
        llamacpp_installed,
        managed_llamacpp_ready(),
    )
}

/// Resolve the local provider URL from the persisted selection and the live
/// lifecycle state. An explicit `LOCAL_LLM_URL` is an operator-owned endpoint
/// and remains authoritative. The profile-derived llama.cpp URL is published
/// only after the registered sidecar has passed its own health and model
/// identity checks; a persisted row alone cannot prove that the listener is the
/// newly selected model.
fn local_engine_gateway_url_with_state(
    explicit: Option<String>,
    active: Option<String>,
    llamacpp_installed: bool,
    llamacpp_ready: bool,
) -> Option<String> {
    if explicit.as_deref().is_some_and(|url| !url.is_empty()) {
        return explicit;
    }
    if let Some(active) = active {
        if active.eq_ignore_ascii_case("llamacpp") && !llamacpp_ready {
            return None;
        }
        return local_engine_url(&active);
    }
    if llamacpp_installed && llamacpp_ready {
        return local_engine_url("llamacpp");
    }
    None
}

/// Whether the automatic local provider path currently has a resident llama.cpp
/// sidecar that completed startup. `SidecarManager::statuses` calls the
/// manager's liveness probe, which is only true after `LlamaCppManager::start`
/// has verified both `/health` and `/v1/models`.
fn managed_llamacpp_ready() -> bool {
    SIDECAR_MANAGER.get().is_some_and(|manager| {
        manager
            .statuses()
            .into_iter()
            .any(|status| status.name == "llamacpp" && status.running)
    })
}

/// Whether a managed Gateway must wait for the local llama.cpp provider before
/// adopting an existing listener. Explicit `LOCAL_LLM_URL` points at an
/// operator-owned endpoint and deliberately bypasses this Core-managed gate.
fn managed_llamacpp_selected() -> bool {
    if std::env::var(ENV_LOCAL_LLM_URL)
        .ok()
        .is_some_and(|url| !url.is_empty())
    {
        return false;
    }
    if let Some(active) = ActiveEngineStore::load().active {
        return active.eq_ignore_ascii_case("llamacpp");
    }
    llamacpp_recorded(&crate::sidecar::download_manager::VersionStore::load())
}

/// Whether the version store records a llama.cpp install. llama.cpp versions
/// are build tags (`b10218`), not semver, so `installed_version` — which parses
/// semver — is always `None` for them; presence of the key is the install fact
/// (the same rule `SetupManager::seed_installed_from_disk` uses).
fn llamacpp_recorded(store: &crate::sidecar::download_manager::VersionStore) -> bool {
    store.versions.contains_key("llamacpp")
}

/// OpenAI-compatible base URL of the local classify tier (`llamacpp-classify`),
/// for registering it as the gateway's `classify` provider.
///
/// Always resolvable — the sidecar binds a fixed, profile-aware loopback port, so
/// unlike [`local_engine_gateway_url`] there is no "which engine did the user pick"
/// question and no `Option`. An explicit `RYU_CLASSIFY_LLM_URL` in Core's
/// environment beats the computed default, so an operator can point the tier at an
/// external small model without touching Core.
///
/// This value is the LAST word downstream, and the consumer was read rather than
/// assumed: it is published into the gateway's spawn env (`gateway_spawn_env`, below)
/// on EVERY spawn, and `GatewayConfig::load` (`apps/gateway/src/config.rs`) assigns it
/// over whatever `gateway.toml` said — the same rule as `local`/`LOCAL_LLM_URL`.
/// Precedence, widest first: `RYU_CLASSIFY_LLM_URL` in Core's environment → this
/// computed loopback default → (only on a gateway Core did not spawn)
/// `[providers.classify]` in the gateway's own file.
///
/// The CONSEQUENCES, both directions, because a bare precedence order hid a 400 MB
/// cost the last time this was written down:
///
///  * `[providers.classify]` in `gateway.toml` has **no effect on a Core-spawned
///    gateway**. It is the standalone-gateway setting. This is a deliberate trade: an
///    earlier round made the file win so that setting would stop being inert, and that
///    moved the deciding value into a file Core cannot see — while
///    [`maybe_start_classify_tier`] still spent ~300-400 MB starting the local
///    `llamacpp-classify` sidecar on every selecting push, for a tier the gateway had
///    been told to reach somewhere else. A documented standalone-only setting is
///    honest; a settable one that silently costs memory in another process is not.
///  * Repointing the tier on such a node means [`ENV_CLASSIFY_LLM_URL`] in *Core's*
///    environment — and it takes **both halves**: `RYU_LOCAL_CLASSIFIER_MODEL_ID` for
///    the id, per [`classify_model_id`]. Setting only the URL leaves the gateway naming
///    the registry's id at the external endpoint. That combination is MORE reachable
///    now, not less: before the lazy-start gate below, the local sidecar happened to be
///    running and could answer the registry id, masking the half-configuration. Because
///    the gate removed that accident, [`maybe_start_classify_tier`] now DETECTS the
///    half-configuration from both halves it already holds and warns + records it
///    instead of skipping quietly — otherwise the gate would have converted a masked
///    misconfiguration into an invisible one.
///  * Because this value IS the URL the gateway dials, Core can decide from its own
///    process whether the local tier is even the target — which is what
///    [`maybe_start_classify_tier`] now gates on, closing that waste. The residual
///    (an operator-run standalone gateway with its own file table) is listed there.
///  * An env-overwritten slot is never written back to `gateway.toml`, and an
///    operator's own table is restored before any save
///    (`GatewayConfig::strip_env_injected_classify_provider`), so a desktop save
///    neither freezes this computed port into their file nor deletes what they wrote.
pub fn classify_gateway_url() -> String {
    if let Ok(url) = std::env::var(ENV_CLASSIFY_LLM_URL) {
        if !url.is_empty() {
            return url;
        }
    }
    format!(
        "http://127.0.0.1:{}/v1",
        crate::sidecar::providers::llamacpp::classify::classify_port()
    )
}

/// The resolved model **id** the classify tier serves, published to the gateway as
/// [`ENV_CLASSIFY_MODEL_ID`] beside [`classify_gateway_url`].
///
/// Reads the SAME registry constructor the sidecar uses to pick its GGUF
/// (`ModelRegistry::from_env().local_classifier_model`, itself overridable via
/// `RYU_LOCAL_CLASSIFIER_MODEL_ID` — env only; this model has no `registry.json`
/// key, by design, so its three consumers cannot disagree mid-session), so
/// "which id" has exactly
/// one answer across Core's start predicate, the sidecar's weights, and the
/// gateway's inspector default + seeded route. Deliberately NOT a second
/// Core-side env override: the registry is the swap seam
/// (`providers/llamacpp/classify.rs` — "swappable registry defaults, never
/// hardcoded"), and a parallel override here would fork it.
///
/// So repointing the tier at an EXTERNAL small model takes both halves —
/// [`ENV_CLASSIFY_LLM_URL`] for the endpoint and `RYU_LOCAL_CLASSIFIER_MODEL_ID`
/// for the id. Setting only the URL leaves the gateway naming (and routing) the
/// registry's id at the external endpoint; setting only the id points a routable id
/// at the local sidecar, whose GGUF then also follows the same override.
pub fn classify_model_id() -> String {
    crate::registry::ModelRegistry::from_env()
        .local_classifier_model
        .id
}

// ── Lazy classify-tier start on config push ─────────────────────────────────────
//
// The gateway cannot start a Core sidecar: it is a separate process with no
// SidecarManager. So Core hooks the one place a classify selection becomes known —
// the `PUT /v1/config` push path below — and lazily starts `llamacpp-classify`
// there, exactly like the Spaces search path lazily starts `llamacpp-rerank`.

/// Process-global handle to the sidecar manager, seeded once at startup by
/// `main.rs`. `push_config` is a free function on a transport path with no
/// `ServerState` in scope (the policy toggles and the `/api/gateway/config` proxy
/// both reach it directly), so the manager arrives here the same way the
/// gateway-policy flags do: a process-global set at boot. `Arc`, not `Weak` — the
/// manager is a process-lifetime singleton, so there is no cycle to break.
static SIDECAR_MANAGER: std::sync::OnceLock<std::sync::Arc<crate::sidecar::SidecarManager>> =
    std::sync::OnceLock::new();

/// Publish the sidecar manager for the lazy classify-tier start. Idempotent: a
/// second call is ignored (there is only ever one manager per process).
pub fn register_sidecar_manager(manager: std::sync::Arc<crate::sidecar::SidecarManager>) {
    let _ = SIDECAR_MANAGER.set(manager);
}

/// Whether a `PUT /v1/config` patch selects the classify tier **and** enables a
/// consumer that will actually call it. Both halves are required.
///
/// The three consumers, each gated exactly as the gateway gates it:
/// 1. the firewall's cheap-LLM inspector — `firewall.inspector.model`, gated on
///    `firewall.inspector.enabled` (`pipeline/mod.rs`'s `PipelineStage::Inspector`
///    tests `inspector_cfg.enabled` and NOTHING else; it is independent of
///    `firewall.enabled`, which only gates the regex `scan_inbound`, so requiring
///    the outer flag here would be a false negative);
/// 2. smart routing's classifier — `routing.smart_routing.classifier_model`, gated
///    on `routing.smart_routing.enabled`;
/// 3. the `EvaluatorImpl::LlmJudge` evaluators — these borrow
///    `firewall.inspector.model` *regardless* of `inspector.enabled`, so they are
///    gated on any enabled `firewall.evaluators` binding instead. See the
///    over-fire note below.
///
/// Every key is rooted at the top level of the patch — the gateway's `ConfigPatch`
/// shape (`firewall` / `routing`) — which is what all three Core writers produce.
/// All three send WHOLE sections, which is what makes the `enabled`-flag gate below
/// safe; where each section's *bytes* come from differs, and the difference is
/// load-bearing (three units have now reasoned from this paragraph, and a fourth
/// checked the one bullet none of them had read — see below):
/// * `build_firewall_patch` (`server/mod.rs`) reads the **live** firewall — `GET
///   /v1/config` serves `firewall` out of the hot-swapped `RwLock`
///   (`apps/gateway/src/api/config.rs`'s `state.with_firewall(…)`), so its
///   `inspector.model` has already been through the gateway's deserializer and is
///   never blank. Checked, not assumed (2026-07-30): the live node base has exactly
///   two writers — `AppState::new(GatewayConfig::load()?)` at boot and
///   `state.update_firewall_config(patch.firewall)` from `put_config` — and BOTH
///   receive a whole `FirewallConfig` produced by serde, i.e. through
///   `de_inspector_model`. Nothing assigns `firewall.inspector` field-wise; the only
///   `cfg.inspector = …` in the crate is `firewall/resolve.rs`'s overlay cascade,
///   which (a) also assigns a deserialized `InspectorConfig` and (b) feeds the
///   per-request *resolved* scanner, not the base this patch is built from;
/// * `build_routing_patch` (`server/mod.rs`) does NOT read the gateway at all. Its
///   input is `read_gateway_section("routing")` — a direct `std::fs::read_to_string`
///   of Core's own `gateway.toml`. (Even via `GET /v1/config`, `routing` and `tools`
///   are served from `persisted_config()` — the file re-read from disk — not from
///   `state.config` and not from the live router, because a `routing` PUT persists
///   without hot-swapping the startup snapshot.)
/// * the `PUT /api/gateway/config` proxy (`server/mod.rs`'s `gateway_put_config`)
///   relays its body as an unresolved `serde_json::Value` — it deserializes into
///   nothing and normalizes nothing. This is the one writer whose bytes never passed
///   through the gateway, and it is why the blank-model rule below exists. Its usual
///   caller is the desktop's `GatewayDialog` (`firewall: draft.firewall`,
///   `{ ...cfg.routing, smart_routing }`), which as of unit w4 pre-resolves a blank
///   `inspector.model` client-side (`withResolvedInspectorModels` in
///   `apps/desktop/src/lib/api/gateway.ts`, the one seam every firewall save goes
///   through). That is the desktop's own half — Core must NOT lean on it: the
///   endpoint is a generic authenticated proxy, so a script, an older desktop build,
///   or any other client can still put a blank on the wire.
///
/// A model selects the tier when it is the configured classifier id, or when it
/// carries the router's builtin `gemma-3-270m` prefix — matched on the LOWERCASED
/// string, mirroring `RoutingTables::route`'s builtin-prefix step so Core's
/// "should I start it" answer can never disagree with the gateway's "where does
/// this route" answer.
///
/// **A blank/absent model SELECTS the tier — for the inspector AND for smart
/// routing.** Both are the fields' declared serde behaviour in
/// `apps/gateway/src/config.rs`:
/// * `InspectorConfig::model` carries `#[serde(default = "default_inspector_model",
///   deserialize_with = "de_inspector_model")]`, and `de_inspector_model` maps
///   `raw.trim().is_empty()` → `classify_model_id()`. An absent `model` inside a
///   present `inspector` hits the field default; an absent `inspector` object hits
///   `FirewallConfig`'s `#[serde(default)] pub inspector` → the *manual* `impl
///   Default for InspectorConfig`, which also fills `model: default_inspector_model()`
///   "so `..InspectorConfig::default()` can never reintroduce the empty-model trap".
///   So blank, absent-field and absent-object all resolve to the classify id.
/// * `SmartRoutingConfig::classifier_model` now carries the SAME pair
///   (`default = "default_classifier_model"`, `deserialize_with =
///   "de_classifier_model"`), so blank and absent resolve to `classify_model_id()`
///   there too.
///
/// **This arm used to be the asymmetric one, and that asymmetry was load-bearing
/// until the field changed under it.** `classifier_model` was a plain
/// `#[serde(default)] String` documented as "Empty ⇒ smart routing is inert
/// (fail-open)", so declining to arm on a blank was right: starting a 300-400 MB
/// server for a feature that would not make a single call is pure waste. Once the
/// gateway began resolving the blank, keeping the non-resolving test here turned a
/// *silently inert* feature into a *silently failing* one — Core declines to start
/// the tier, the gateway resolves the blank to the classify id, dials the `classify`
/// provider, and gets connection refused. That is the identical shape as the
/// inspector's own blank-model bug two units earlier, reintroduced through the other
/// field. The rule to carry forward: **whenever a gateway field gains a resolving
/// deserializer, the arm that reads it off the raw patch must gain the same
/// resolution in the same change, or the two processes disagree about what "blank"
/// means and the disagreement is invisible.**
///
/// **Why blank had to be handled here, in Core.** `de_inspector_model` runs in the
/// **gateway process**. Core inspects the patch strictly UPSTREAM of it:
/// `gateway_put_config` → [`push_config`] → [`maybe_start_classify_tier`], all on
/// the raw `serde_json::Value` the desktop sent, before the PUT is even on the wire.
/// The previous revision of this doc claimed "the predicate's input is now NEVER
/// blank" because of that deserializer; that was false across a process boundary,
/// and the `model.is_empty() ⇒ false` branch it justified was its own disproof. The
/// live bug: the inspector's Model box is documented as optional, so enabling the
/// inspector and leaving it empty pushed `model: ""`; Core declined; the gateway
/// resolved the blank to the classify id → the `classify` provider → connection
/// refused → fail open — nothing warned, and it self-corrected only on a SECOND save
/// (which carried the id the first had persisted). Unit w4 fixed the desktop half in
/// parallel (`withResolvedInspectorModels`, plus help text that no longer promises a
/// gateway-side substitution). Both halves ship, and NEITHER is redundant: w4 keeps
/// the wire honest against an older Core, and this one keeps Core honest against any
/// client that is not that desktop.
///
/// **Why the feature gate survives.** The gate (`enabled` flag required IN THIS
/// PATCH) is what fixed the spawn-on-every-firewall-push regression: because the
/// gateway resolves blanks, *every* firewall section names the classifier, so a
/// model-only test fired on an unrelated "Log detections" checkbox save and on
/// enabling **or disabling** the firewall plugin — each spawning a llama-server that
/// stays resident forever (idle-stop is off unless `RYU_SIDECAR_IDLE` is set, see
/// `sidecar/manager.rs`). Blank-selects does not reopen that: `inspector.enabled ==
/// true` is still required, and a fresh node's firewall section defaults to
/// `inspector.enabled = false` with `evaluators: []` — pinned in the crate that owns
/// the default by `ryu-gateway`'s
/// `default_firewall_section_selects_nothing_for_cores_lazy_start`.
///
/// **Arm 3 over-fires, verified (2026-07-30).** Re-read of the consumer
/// (`apps/gateway/src/pipeline/inline_flags.rs`'s `flag_inline_binding`) settles what the
/// previous round asserted without checking: it matches on `EvaluatorImpl`, and
/// **only `LlmJudge` reaches `InspectorClient::inspect_rubric`**. `Regex` and
/// `Heuristic` go to `scanner.scan_kind` (no LLM at all), `Code` and `Builtin`
/// return `Skip`, and `Wasm` runs in the in-process wasmtime sandbox. So arming on
/// *any* enabled binding does start a 300-400 MB sidecar for evaluators that will
/// never call it — and it lands on the LIKELIEST configuration, since three of the
/// five ids wired to real inline execution (`pii_leakage`, `code_injection`,
/// `prompt_injection` in the gateway catalog's `ENFORCED_IDS`) are `Regex`.
///
/// The blank-selects rule above does NOT widen that over-fire into a new class, and
/// the bound was checked on the desktop side rather than reasoned about: the only
/// firewall pushes that ever carried a blank model were ones where a user cleared
/// the Model box, because `normalizeConfig`'s fallback is `DEFAULT_INSPECTOR` with
/// `model: CLASSIFY_MODEL_ID` and the gateway serves an already-resolved id
/// (`apps/desktop/src/lib/api/gateway.ts`). Every non-blank evaluator-enabled push
/// already reached this arm before either half of the fix landed. So the widening is
/// confined to that cleared-box sub-case, where arm 3's judge rationale applies
/// identically — and it can never reach a patch with no `firewall` key, since both
/// arms that consult `inspector_model_resolves_to_tier` first prove one exists.
///
/// It stays un-narrowed because the kind is **not reachable from the patch** for the
/// bindings that matter: an `EvaluatorBinding` (`apps/gateway/src/evaluators/mod.rs`)
/// carries only `id`/`enabled`/`inline_action`/`offline`/`locked`; the
/// `EvaluatorImpl` lives in the catalog. (`ConfigPatch.custom_evaluators` does carry
/// full `Evaluator`s with their `impl.kind` — but only for USER-authored entries, and
/// the enforced detectors that make this over-fire likely are compiled-in builtins
/// with no representation in the patch at all.) The one honest source would be the
/// gateway's own `GET /v1/evaluators`
/// (unauthenticated, returns each entry's `impl.kind`) — but it builds its registry
/// from `state.config`, the STARTUP snapshot, so it cannot see a custom judge
/// authored in the same push. With the only safe fail direction for an unknown id
/// (arm, because a cold tier means the guardrail silently fails open — the failure
/// this whole unit exists to kill), that probe reduces to "exclude the compiled-in
/// builtin non-judge ids", i.e. a hardcoded catalog copy fetched over HTTP. Not
/// worth an async refactor of a pure predicate. Followup if the cost ever bites:
/// serve the impl kind on the binding, or have the gateway answer "does this
/// evaluator set need the cheap tier" directly.
///
/// Pure (the classifier id is passed in, not read from the registry) so the
/// predicate is testable without touching process env.
pub(crate) fn patch_selects_classify_tier(patch: &serde_json::Value, classifier_id: &str) -> bool {
    // Does an EXPLICITLY NAMED model select the tier? Blank/absent is deliberately
    // NOT handled here — it means different things per field (see the doc above), so
    // each arm decides for itself.
    let names_tier = |model: Option<&serde_json::Value>| -> bool {
        let Some(model) = model.and_then(|v| v.as_str()) else {
            return false;
        };
        let model = model.trim().to_lowercase();
        if model.is_empty() {
            return false;
        }
        model.starts_with("gemma-3-270m") || model == classifier_id.trim().to_lowercase()
    };
    // Will the gateway's RESOLVED `firewall.inspector.model` be the classify tier?
    // Absent (no `model` key, or no `inspector` object) and blank both resolve to
    // `classify_model_id()` in the gateway — the two serde seams quoted in the doc.
    // A non-string value is NOT a selection: `de_inspector_model` starts with
    // `String::deserialize`, so the gateway 400s the whole push and nothing dials
    // the tier.
    //
    // Reached only under an arm that already proved a `firewall` key exists, so
    // "absent ⇒ classify id" is never applied to a patch that leaves the gateway's
    // live firewall section (and therefore its inspector model) untouched.
    let inspector_model_resolves_to_tier = || match patch.pointer("/firewall/inspector/model") {
        None => true,
        Some(v) => match v.as_str() {
            None => false,
            Some(s) => s.trim().is_empty() || names_tier(Some(v)),
        },
    };
    // Will the gateway's RESOLVED `routing.smart_routing.classifier_model` be the
    // classify tier? Same three cases as the inspector above, and for the same
    // reason: `de_classifier_model` maps blank → `classify_model_id()`, and the
    // `default = "default_classifier_model"` half covers an absent key.
    //
    // Reached only under an arm that already proved `smart_routing.enabled == true`
    // in THIS patch, so "absent ⇒ classify id" is never applied to a push that
    // leaves the live routing section alone — the same bound that keeps arm 1 from
    // spawning on every unrelated save.
    let classifier_model_resolves_to_tier =
        || match patch.pointer("/routing/smart_routing/classifier_model") {
            None => true,
            Some(v) => match v.as_str() {
                None => false,
                Some(s) => s.trim().is_empty() || names_tier(Some(v)),
            },
        };
    // Absent flag ⇒ NOT enabled. Every real writer sends the whole section, so a
    // missing flag means "this patch does not turn the consumer on"; treating it as
    // enabled would restore the spawn-on-any-push bug.
    let enabled = |ptr: &str| patch.pointer(ptr).and_then(|v| v.as_bool()) == Some(true);
    let any_evaluator_enabled = || {
        patch
            .pointer("/firewall/evaluators")
            .and_then(|v| v.as_array())
            .is_some_and(|bindings| {
                bindings
                    .iter()
                    .any(|b| b.get("enabled").and_then(|v| v.as_bool()) == Some(true))
            })
    };

    // Arm 1: the inspector, gated on its own flag (a present `inspector.enabled ==
    // true` proves the `firewall` key exists).
    (enabled("/firewall/inspector/enabled") && inspector_model_resolves_to_tier())
        // Arm 2: smart routing, gated on its own flag. The RESOLVING variant, like
        // arm 1 — `classifier_model` gained `de_classifier_model`, so a blank one no
        // longer means "inert", it means "the classify tier". See the doc above.
        || (enabled("/routing/smart_routing/enabled") && classifier_model_resolves_to_tier())
        // Arm 3: LLM-judge bindings borrow the inspector's model regardless of
        // `inspector.enabled` (a non-empty `firewall.evaluators` array proves the
        // `firewall` key exists). Over-fires on non-judge kinds — see the doc.
        || (any_evaluator_enabled() && inspector_model_resolves_to_tier())
}

/// Whether a URL names **this machine** — the shared host-locality test behind both
/// of [`maybe_start_classify_tier`]'s spend gates (the gateway's URL, and the classify
/// tier's URL). It answers only "is this host local"; the reason each caller cares is
/// documented at the call site, because the two reasons are different.
///
/// `0.0.0.0` counts: it is the gateway's default *bind* address, so a URL naming it
/// still means "on this box" (`IpAddr::is_loopback()` alone says false). Anything else
/// — a hostname, a LAN IP, a public IP — does not. Unparseable or hostless is `false`:
/// both gates spend memory on `true`, so "cannot prove local" must not spend it.
///
/// A local predicate rather than a reuse of `identity_verify::is_loopback_host`:
/// that one is private to a module about JWKS transport security and additionally
/// answers "is plain HTTP acceptable here", a different question with different
/// stakes. Sharing it would couple a memory-budget decision to a TLS decision.
fn url_targets_this_machine(candidate: &str) -> bool {
    let Ok(url) = url::Url::parse(candidate) else {
        // Unparseable ⇒ we cannot prove it is local, so do not spend the RAM.
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<std::net::IpAddr>()
        .is_ok_and(|ip| ip.is_loopback() || ip.is_unspecified())
}

/// Whether a **non-local** classify target looks only HALF configured: the endpoint
/// was repointed, but the model id the gateway will name at it is still the registry
/// default.
///
/// Both halves are readable from this process, which is why this is a check and not a
/// guess. Half A — the URL. [`classify_gateway_url`] returns the computed loopback
/// default unless [`ENV_CLASSIFY_LLM_URL`] is set non-empty, and loopback always
/// passes [`url_targets_this_machine`]; so a non-local answer proves the env override
/// is in play. (An UNPARSEABLE override lands here too — `url_targets_this_machine`
/// returns `false` when it cannot prove locality — and that case is a
/// misconfiguration as well, so reporting it is right, if under a slightly wrong
/// name.) Half B — the id. [`classify_model_id`] resolves env → the compiled
/// literal — `local_classifier_model` has NO `registry.json` key, by design (see
/// the note on [`classify_model_id`]: an env-only value cannot desync across the
/// three consumers that read it at three different moments). So there is exactly
/// ONE swap seam for the id, `RYU_LOCAL_CLASSIFIER_MODEL_ID`, and an id equal to
/// [`crate::registry::DEFAULT_LOCAL_CLASSIFIER_MODEL_ID`] means the id the gateway
/// will name is the LOCAL tier's own default — because that seam was not used, or
/// because it was set to that same string, which is the same state from here and
/// has the same consequence.
///
/// **What the caller may claim, and what it may not.** This is a *suspicion*, not a
/// verdict: an operator's external server may genuinely serve a model named
/// `gemma-3-270m-it-qat-Q4_0` (that is a local-GGUF quant name, so it is unlikely,
/// not impossible), in which case the configuration is complete and this still says
/// `true`. It must therefore never suppress anything — it only decides whether the
/// skip is recorded and warned about, or logged quietly.
///
/// The failure it makes visible: the gateway seeds an EXACT `model_map` route for
/// [`classify_model_id`] onto the `classify` provider (`seed_classify_route` in
/// `apps/gateway/src/config.rs`), whose `base_url` is the repointed URL. So a
/// half-configuration asks an external endpoint for an id it very likely does not
/// serve; every consumer of the tier fails OPEN, so the guardrail goes quiet with no
/// error anywhere.
///
/// Pure over `(url, id)` — no env, no registry — so both arms are unit-testable.
fn half_configured_external_classify_tier(classify_url: &str, resolved_id: &str) -> bool {
    !url_targets_this_machine(classify_url)
        && resolved_id.trim() == crate::registry::DEFAULT_LOCAL_CLASSIFIER_MODEL_ID
}

/// Fire-and-forget lazy start of [`CLASSIFY_SIDECAR_NAME`] when `patch` selects the
/// classify tier. Never blocks the caller and never fails the config push: the start
/// runs on its own task, and a failure is logged at `warn` and recorded (see
/// [`crate::sidecar::providers::llamacpp::classify::record_lazy_start_failure`])
/// rather than propagated.
///
/// Safe to call on every push, with one bounded exception.
/// [`crate::sidecar::providers::llamacpp::classify`] adopts an already-running server
/// instead of spawning a competing one — but only once that server's `/health` answers
/// 2xx, which is the predicate its adopt branch tests. The start's own readiness gate is
/// weaker (a TCP connect), so a push landing after the port binds but before `/health`
/// succeeds still takes the spawn branch and orphans the child that is actually serving.
/// That window is OPEN and is tracked at the adopt branch in `classify.rs`; closing it
/// means gating the readiness loop on `/health`. *For the manager* a repeat start is
/// clean: [`crate::sidecar::manager::SidecarManager`]'s `spawn_health_monitor` aborts the
/// health monitor it displaces, so repeat pushes no longer accumulate pollers.
///
/// Every consumer fails OPEN (an unreachable classify provider is treated as "no
/// verdict": allow and warn), so a server that is not warm yet — or one that never
/// starts because the model has not finished downloading — degrades the guardrail
/// to silence, never to a broken request. That is what makes the following gaps
/// tolerable; all SIX are accepted, and all six degrade the same way. Tolerable is
/// not the same as invisible: the one that is indistinguishable from a
/// misconfiguration (the fifth) is recorded, the rest are genuinely benign or
/// unreachable from here:
///
/// * **Restart with a persisted selection.** No push occurs, so the tier stays cold
///   until the next one.
/// * **Model-only patch.** [`patch_selects_classify_tier`] requires the consuming
///   feature's `enabled` flag IN THIS PATCH. A push that changes only the model,
///   while the feature was switched on by an EARLIER push, therefore does not start
///   the tier. Every real writer sends whole sections, so this needs a hand-rolled
///   partial `PUT`; the alternative (treating an absent flag as enabled) is the
///   spawn-on-every-push regression the flag gate exists to fix.
/// * **Judge binding enabled only in an OVERLAY.** The gateway gates the
///   LLM-judge arm on the RESOLVED scanner's evaluator set (the node → org → agent
///   cascade in `firewall/resolve.rs`), while the predicate reads only the patch's
///   node-level `firewall.evaluators`. So a judge armed purely by an org/agent
///   overlay leaves the tier cold. Walking every overlay in the patch to mirror the
///   cascade would put a copy of the resolver in Core; the node level is where the
///   desktop's default scope writes, so this is the narrow residual.
/// * **Remote gateway.** Skipped entirely — see the first spend gate below.
/// * **External classify endpoint.** Skipped by the second spend gate. Benign when
///   the id was moved with the URL; when it was not, the skip is warned about and
///   recorded rather than logged past, because that half-configured state is the one
///   the gate stopped masking. See the gate for what that record does and does not
///   reach.
/// * **Standalone gateway with its own `[providers.classify]`.** A gateway Core did
///   NOT spawn (an operator runs it; Core only pushes config to it) never received
///   `RYU_CLASSIFY_LLM_URL`, so its `gateway.toml` table is what takes effect — and
///   that file is not something Core reads. The second gate below therefore sees only
///   Core's own URL, judges it local, and may start a tier that gateway will not dial.
///   The narrow residual of the standalone case, and the reason the *precedence* is
///   env-wins: on every gateway Core spawns, Core's URL is the one that gets dialed,
///   which is what makes that gate sound at all.
fn maybe_start_classify_tier(patch: &serde_json::Value) {
    // Resolve the classifier id through the registry — the SAME source the sidecar
    // uses to pick the GGUF it serves and the same id published to the gateway as
    // `RYU_CLASSIFY_MODEL_ID`, so the id we match on is always the id we serve and
    // the gateway routes.
    let classifier_id = classify_model_id();
    if !patch_selects_classify_tier(patch, &classifier_id) {
        return;
    }
    // Spend gate 1 — is the GATEWAY on this box? [`push_config`] reconfigures the
    // gateway at [`gateway_url`], which honors `RYU_GATEWAY_URL` and may therefore be
    // a **remote** gateway (a Ryu Cloud node, the hosted fleet). Starting
    // `llamacpp-classify` for one is doubly wrong: ~300-400 MB of local RAM for a
    // server nothing dials, while the remote gateway resolves its own `classify`
    // provider against its OWN loopback — where nothing is listening — so its
    // guardrail stays dead regardless. Neither half is fixable from here; the remote
    // node has to start its own tier.
    let base = gateway_url();
    if !url_targets_this_machine(&base) {
        tracing::debug!(
            gateway = %base,
            "gateway config selects the classify tier but the gateway is not on this machine; \
             the remote node must start its own tier — skipping local lazy start"
        );
        return;
    }
    // Spend gate 2 — is the local TIER even the target? A local gateway is not enough:
    // an operator may point the classify tier at an external small model with
    // `RYU_CLASSIFY_LLM_URL`, and then the local sidecar is 300-400 MB nothing ever
    // dials (idle-stop is off unless `RYU_SIDECAR_IDLE`, so it stays resident for the
    // life of the process).
    //
    // [`classify_gateway_url`] is exactly the value the gateway will use, which is a
    // cross-process claim and so was verified rather than assumed:
    // `gateway_spawn_env` publishes it as `RYU_CLASSIFY_LLM_URL` on every spawn, and
    // `GatewayConfig::load` (`apps/gateway/src/config.rs`) assigns that variable OVER
    // any `[providers.classify]` in `gateway.toml`. That env-wins precedence is what
    // makes this gate sound — under the file-wins ordering it briefly had, the
    // deciding value lived in a file Core does not read and this check would have been
    // a guess. See the fifth accepted gap above for the one case it still cannot see.
    //
    // The skip is unconditional, but it is NOT uniformly benign, so it does not get a
    // uniform log line. Two states reach it:
    //
    //  * **Fully configured external tier** — the URL and the id were both moved
    //    ([`half_configured_external_classify_tier`] `false`). Intended, working,
    //    nothing to say: `debug!`, and no record.
    //  * **Half configuration** — `RYU_CLASSIFY_LLM_URL` set, `classify_model_id()`
    //    still the registry default. The gateway then names the LOCAL tier's id at a
    //    remote endpoint (it seeds an exact route for it, see the predicate), the
    //    inspector and judges get no verdict, and they fail OPEN. This gate is what
    //    made that state SILENT: before it, the local sidecar happened to be running
    //    and would answer the registry id, masking the misconfiguration (see
    //    [`classify_gateway_url`]'s second bullet). Removing the accident without
    //    replacing it with a signal would trade a masked misconfiguration for an
    //    invisible one, and `/api/sidecar/status` reports the sidecar exactly as it
    //    reports a lazy tier nobody has needed yet — `running: false`, byte-identical.
    //
    // So the second state is warned about and RECORDED, on the same seam a failed
    // start uses. Reach, honestly (the read half's own doc in `classify.rs` says the
    // same): `/api/sidecar/status` carries no reason field, and `health_check` runs
    // only from the health monitor (which a skipped start never spawns) and
    // `await_healthy` (which nothing calls for this sidecar). So the record is
    // *retrievable* — a `health_check` on this manager quotes it — and the `warn!` is
    // what a human actually sees today. Wiring a status key is the followup that would
    // make it visible; it is not this change.
    let classify_target = classify_gateway_url();
    if !url_targets_this_machine(&classify_target) {
        if half_configured_external_classify_tier(&classify_target, &classifier_id) {
            // Two things this message must not do. It must not state a VERDICT (an
            // external endpoint can serve the default id, and this cannot see which),
            // and it must not name a CAUSE it did not check: the id resolves env →
            // the compiled literal (`local_classifier_model` has no `registry.json`
            // key, by design), so "still the default" is consistent BOTH with the env
            // seam never being touched AND with it being set to that same string.
            // It reports the observed state and the action, not a cause.
            let reason = format!(
                "{ENV_CLASSIFY_LLM_URL} points the classify tier at {classify_target}, so the \
                 local sidecar was not started — but the model id is still the registry default \
                 '{classifier_id}', which is the id the gateway will ask that endpoint for. If \
                 it does not serve that id, the firewall inspector and any LLM-judge evaluators \
                 get no verdict and fail OPEN. Set RYU_LOCAL_CLASSIFIER_MODEL_ID (or the \
                 registry's classifier id) to the id the endpoint serves, or unset \
                 {ENV_CLASSIFY_LLM_URL} to use the local tier."
            );
            tracing::warn!(
                sidecar = CLASSIFY_SIDECAR_NAME,
                classify_url = %classify_target,
                classifier_id = %classifier_id,
                "{reason}"
            );
            crate::sidecar::providers::llamacpp::classify::record_lazy_start_failure(reason);
            return;
        }
        tracing::debug!(
            classify_url = %classify_target,
            "gateway config selects the classify tier but it is pointed at a non-local \
             endpoint with its own model id; the local sidecar would serve nobody — \
             skipping lazy start"
        );
        return;
    }
    let Some(manager) = SIDECAR_MANAGER.get().cloned() else {
        tracing::debug!(
            "gateway config selects the classify tier but no sidecar manager is registered \
             (non-server context); skipping lazy start"
        );
        return;
    };
    tokio::spawn(async move {
        if let Err(e) = manager.start_sidecar(CLASSIFY_SIDECAR_NAME).await {
            // `warn`, not `debug`, and recorded — Core now defaults to `info`, so
            // debug is hidden unless an operator opts in. Even when enabled, a
            // `debug!` line is indistinguishable from the `ryu_core=debug` firehose,
            // disappears under `RUST_LOG=info`, and leaves NO queryable record.
            // This is the one failure class the desktop's classify-tier badge cannot derive.
            // It crosses `/api/sidecar/status` with a weights probe, which covers exactly one
            // cause (`unweighted`) and reads every other — llama.cpp binary missing,
            // port 8083 taken, `'…' is not installed` because the derived-sidecar list
            // drifted, download center unwired — as the sidecar's NORMAL lazy `idle`.
            //
            // `start_sidecar` does not log this itself: it calls `sidecar.start()`
            // directly (NOT `start_with_retries`, which is the path that carries the
            // manager's own `warn!`), so before this line the whole mechanism could go
            // inert with no signal above debug.
            let reason = format!("{e:#}");
            tracing::warn!(
                sidecar = CLASSIFY_SIDECAR_NAME,
                reason = %reason,
                "classify tier lazy start failed — the gateway's guardrail consumers will \
                 fail OPEN (no verdict) until it starts"
            );
            crate::sidecar::providers::llamacpp::classify::record_lazy_start_failure(reason);
        }
    });
}

/// Build the `PUT {gateway}/v1/config` request for a config patch, carrying the
/// gateway bearer when one is configured. Split out (base/token as params) so the
/// auth-forwarding + URL shape are unit-testable against a local listener without
/// mutating the process environment.
fn gateway_config_request(
    client: &reqwest::Client,
    base: &str,
    token: Option<&str>,
    patch: &serde_json::Value,
) -> reqwest::RequestBuilder {
    gateway_config_request_with_actor(client, base, token, patch, None, None)
}

fn gateway_config_request_with_actor(
    client: &reqwest::Client,
    base: &str,
    token: Option<&str>,
    patch: &serde_json::Value,
    actor_id: Option<&str>,
    actor_name: Option<&str>,
) -> reqwest::RequestBuilder {
    let base = base.trim_end_matches('/');
    let mut req = client
        .put(format!("{base}/v1/config"))
        .timeout(Duration::from_millis(5000))
        .json(patch);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    if let Some(actor_id) = actor_id {
        req = req.header("x-ryu-control-actor-id", actor_id);
    }
    if let Some(actor_name) = actor_name {
        req = req.header("x-ryu-control-actor-name", actor_name);
    }
    req
}

/// Push a `/v1/config` patch to the LIVE gateway (the hot-swap path).
///
/// This is the single config-push transport: the `PUT /api/gateway/config` proxy
/// handler AND Core's policy-plugin toggles both route through it, so a firewall /
/// routing toggle reconfigures the RUNNING gateway — local **or** remote (the PUT
/// targets [`gateway_url`], and the gateway hot-swaps on `PUT /v1/config` with no
/// respawn). Returns the gateway's `(status, body)` verbatim so callers can relay
/// the exact status (the proxy) or inspect success (the policy path). Errs only on
/// a transport failure.
///
/// Being the single transport also makes this the one place a *classify-tier
/// selection* becomes visible to Core, so it carries the lazy
/// [`maybe_start_classify_tier`] hook — the gateway cannot start a Core sidecar
/// itself.
pub(crate) async fn push_config(
    client: &reqwest::Client,
    patch: &serde_json::Value,
) -> anyhow::Result<(reqwest::StatusCode, serde_json::Value)> {
    push_config_with_actor(client, patch, None, None).await
}

/// Push a config patch while carrying a verified Core actor through the local
/// admin hop. The gateway still authenticates the admin token; these bounded
/// headers only let the resulting control row name the user who initiated it.
pub(crate) async fn push_config_with_actor(
    client: &reqwest::Client,
    patch: &serde_json::Value,
    actor_id: Option<&str>,
    actor_name: Option<&str>,
) -> anyhow::Result<(reqwest::StatusCode, serde_json::Value)> {
    // Lazily start the (off-by-default) classify tier BEFORE the PUT, so a
    // transport failure below cannot skip it and the start can never fail the push.
    maybe_start_classify_tier(patch);
    let base = gateway_url();
    let resp = gateway_config_request_with_actor(
        client,
        &base,
        gateway_admin_key().as_deref(),
        patch,
        actor_id,
        actor_name,
    )
    .send()
    .await
    .map_err(|e| anyhow::anyhow!("gateway config push failed: {e}"))?;
    let status = resp.status();
    let body = resp
        .json::<serde_json::Value>()
        .await
        .unwrap_or_else(|_| serde_json::json!({}));
    Ok((status, body))
}

/// Build the `GET {gateway}/v1/config` request, carrying the gateway bearer when
/// one is configured. Split out (base/token as params) so the auth-forwarding +
/// URL shape are unit-testable against a local listener without mutating the
/// process environment. Mirrors [`gateway_config_request`] (the PUT builder).
fn gateway_config_get_request(
    client: &reqwest::Client,
    base: &str,
    token: Option<&str>,
) -> reqwest::RequestBuilder {
    let base = base.trim_end_matches('/');
    let mut req = client
        .get(format!("{base}/v1/config"))
        .timeout(Duration::from_millis(5000));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    req
}

/// Read the LIVE gateway config (`GET /v1/config`) as JSON — the `ConfigView` with
/// the in-memory firewall/budget/routing state, reflecting any prior hot-swap.
///
/// This is the read half of the config plane; it is **not** a second config-*push*
/// path ([`push_config`] remains the single PUT transport). A policy toggle uses it
/// to read-modify-write the RUNNING gateway's firewall section — sourcing the full
/// live object (`policy`, `locked_fields`, `inspector`, operator `custom_patterns`,
/// …) so the PUT that follows preserves every field it does not intend to change,
/// instead of reconstructing a partial section from Core's local disk (which is
/// empty for a REMOTE gateway → a full-replacement PUT would clobber enforcement).
/// Targets [`gateway_url`] and forwards the Core-only admin key, so it
/// remote inference relay credentials cannot administer fleet configuration.
/// Errs on a transport failure or a non-2xx status.
pub(crate) async fn fetch_config(client: &reqwest::Client) -> anyhow::Result<serde_json::Value> {
    let base = gateway_url();
    let resp = gateway_config_get_request(client, &base, gateway_admin_key().as_deref())
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("gateway config read failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("gateway GET /v1/config returned {status}: {body}");
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| anyhow::anyhow!("gateway config read: bad JSON: {e}"))
}

/// Environment overrides Core layers onto the spawned gateway so it routes the
/// `local` provider at the active engine. Empty when nothing is selected.
fn gateway_spawn_env() -> Vec<(String, String)> {
    let mut env = Vec::new();
    // The gateway keeps its own data-dir state (channel pairing, marketplace
    // signing key) under Core's layout only when it knows the data dir.
    env.push((
        "RYU_DIR".to_owned(),
        crate::paths::ryu_dir().to_string_lossy().into_owned(),
    ));
    // Keep a profile-isolated child Gateway's audit store beside Core's active
    // data. A stale absolute `audit.db_path` in gateway.toml must not send a dev
    // or test child back to the release database; the audit crate treats this as
    // a runtime override and never persists it.
    env.push((
        "RYU_AUDIT_DB_PATH".to_owned(),
        crate::paths::db_path("audit.db")
            .to_string_lossy()
            .into_owned(),
    ));
    // The Ryu Axiom diagnostics mirror is a typed relay, not the customer's OTLP
    // exporter. Managed local Gateways receive only the relay URL/key; the
    // diagnostics gate below controls delivery. No Axiom credential is forwarded.
    env.extend(crate::ryu_analytics::gateway_child_env());
    // The Gateway's own sealing subkey for `gateway.toml` secrets (HKDF of the
    // master key, never the master key itself). The Gateway captures it into
    // memory and removes it from its environment before any thread starts.
    match ryu_crypto::component_child_env(ryu_crypto::components::GATEWAY) {
        Ok(entries) => env.extend(entries),
        Err(error) => {
            tracing::warn!("gateway: no seal key for the child ({error}); it will resolve its own")
        }
    }
    // Startup validates all three credentials before computing the child environment.
    if let Some(key) = gateway_admin_key() {
        env.push((ENV_GATEWAY_ADMIN_KEY.to_owned(), key));
    }
    if let Some(key) = gateway_token() {
        env.push(("GATEWAY_RELAY_KEY".to_owned(), key));
    }
    if let Some(key) = gateway_core_token() {
        env.push(("GATEWAY_CORE_RELAY_KEY".to_owned(), key));
    }
    if let Some(key) = gateway_core_proof_key() {
        env.push(("GATEWAY_CORE_PROOF_KEY".to_owned(), key));
    }
    if let Some(url) = local_engine_gateway_url() {
        tracing::info!(local_llm_url = %url, "gateway: registering active local engine as provider");
        env.push((ENV_LOCAL_LLM_URL.to_owned(), url));
    }
    // Ollama launch settings are baked into a derived model; tell the gateway's
    // `local` provider to serve the base name from it. Empty ⇒ not published.
    if let Some(routes) = local_model_routes_env() {
        env.push((ENV_LOCAL_MODEL_ROUTES.to_owned(), routes));
    }
    // Classify tier: always published, NOT gated on the sidecar being installed or
    // running. The spawn env is computed once, so gating it would mean a classifier
    // installed later is invisible to the gateway until a respawn — while both
    // consumers (the firewall inspector and the routing classifier) already fail
    // OPEN against a port that is not up, treating an unreachable provider as "no
    // verdict". A dead URL therefore costs nothing and a missing one costs the tier.
    let classify_url = classify_gateway_url();
    // …and the resolved model ID alongside the URL. The gateway needs BOTH to honor
    // a registry swap: the URL alone left its `DEFAULT_INSPECTOR_MODEL` an
    // independent literal and its `gemma-3-270m` builtin prefix unable to follow the
    // override, so a swapped id resolved to no provider at all. With the id
    // published, the gateway defaults `inspector.model` from it AND seeds an exact
    // `routing.model_map` entry pointing it at the `classify` provider.
    let classify_model = classify_model_id();
    tracing::info!(
        %classify_url,
        %classify_model,
        "gateway: registering classify tier as provider"
    );
    env.push((ENV_CLASSIFY_LLM_URL.to_owned(), classify_url));
    env.push((ENV_CLASSIFY_MODEL_ID.to_owned(), classify_model));
    // Node-tier hazard screener endpoints (decision model, guard model). Off by
    // default: nothing is published until the operator opts the node in, and
    // the Gateway still screens nothing until its own `[screening]` section
    // names these variables. Never Ryu's platform floor, which binds only the
    // hosted fleet.
    env.extend(crate::sidecar::node_screener::screener_spawn_env());
    // Context compression (M2 / #425): when the headroom proxy is enabled, turn
    // on the gateway's egress compression transform and point it at the proxy.
    // This auto-wraps every gateway-routed agent. The gateway fails open if the
    // proxy is unreachable, so this is safe even before headroom is healthy.
    if crate::sidecar::headroom::is_enabled() {
        let policy = crate::sidecar::headroom::compression_policy();
        let url = crate::sidecar::headroom::headroom_url();
        tracing::info!(
            %url,
            service = policy.service.as_deref().unwrap_or("headroom"),
            "gateway: enabling egress compression"
        );
        env.push(("GATEWAY_COMPRESSION_ENABLED".to_owned(), "1".to_owned()));
        env.push(("GATEWAY_COMPRESSION_URL".to_owned(), url));
        // Forward the rest of the plugin-defined service config so the whole
        // compression setup is data-driven (any compression plugin, not just the
        // bundled headroom one).
        if let Some(token) = policy.token {
            env.push(("GATEWAY_COMPRESSION_TOKEN".to_owned(), token));
        }
        if let Some(timeout_ms) = policy.timeout_ms {
            env.push((
                "GATEWAY_COMPRESSION_TIMEOUT_MS".to_owned(),
                timeout_ms.to_string(),
            ));
        }
        if let Some(min_messages) = policy.min_messages {
            env.push((
                "GATEWAY_COMPRESSION_MIN_MESSAGES".to_owned(),
                min_messages.to_string(),
            ));
        }
    }
    // Gateway policy plugins (M2 / #447): the firewall and smart-routing policies
    // are boolean-shaped on/off switches that force their gateway feature on when
    // their Policy plugin is enabled. Core flips a process-global flag (seeded
    // from the plugin's persisted state at startup) and this spawn-env injects the
    // matching `GATEWAY_*` env so the gateway config-load forces the feature on.
    // The rich definitions (firewall pattern set, routing model_map/rules) stay
    // owned by `/v1/config` — the plugin only toggles active state.
    if crate::sidecar::gateway_policy::firewall_enabled() {
        tracing::info!("gateway: firewall policy plugin enabled, forcing firewall on");
        env.push(("GATEWAY_FIREWALL_ENABLED".to_owned(), "1".to_owned()));
    }
    if crate::sidecar::gateway_policy::routing_enabled() {
        tracing::info!("gateway: routing policy plugin enabled, forcing smart routing on");
        env.push(("GATEWAY_SMART_ROUTING_ENABLED".to_owned(), "1".to_owned()));
    }
    // Provider credentials (Composio / OpenRouter / Replicate / Fal). On a remote
    // data plane (WS1) these keys live ONLY in the hosted gateway fleet — Core must
    // hold and inject NONE of them, so skip the whole block without even resolving
    // the local key prefs. (This is belt-and-suspenders: `start()` never spawns a
    // local gateway in remote mode, so this env is not built there anyway.) Every
    // managed node is a remote data plane, so a managed node never passes a
    // provider key to a gateway child (D8).
    if remote_data_plane() {
        tracing::info!(
            "gateway: remote data plane — provider keys live in the hosted fleet, injecting none"
        );
    } else {
        push_provider_key_env(&mut env);
    }
    // Unified tool gateway (#475): point the gateway's `providers.core` at this
    // Core instance so the gateway's search-based tool loop and `/v1/exec/tool`
    // can reach Core's unified catalog (`/api/tools/{search,describe}`,
    // `/api/mcp/tools/call`). Without CORE_URL the gateway leaves `state.tools`
    // = None and the front is inert. NOTE: CORE_URL (providers.core) is distinct
    // from RYU_CORE_URL (the channels listeners' callback URL).
    let core_url = core_self_url();
    tracing::info!(core_url = %core_url, "gateway: wiring unified tool catalog client");
    env.push(("CORE_URL".to_owned(), core_url));
    if let Some(token) = crate::node_token::active_token() {
        if !token.is_empty() {
            env.push(("CORE_TOKEN".to_owned(), token));
        }
    }
    // Mesh (#478, security HIGH / B-9): under userspace networking inbound peers
    // proxy to 127.0.0.1, so the gateway's loopback-admin gates fail OPEN to the
    // tailnet. Push RYU_MESH_ENABLED EXPLICITLY so the value is normalized to "1"
    // regardless of how Core was launched (the gateway child does inherit Core's
    // env, but we do not rely on that — this guarantees the signal is set and
    // canonical) so `tools::mesh_enabled()` neutralizes loopback trust on every
    // admin/exec path. Mirror Core's `ryu_mesh::is_enabled()` truthy semantics so
    // both sides agree on the same signal.
    if ryu_mesh::is_enabled() {
        tracing::info!("gateway: mesh enabled, neutralizing gateway loopback-admin trust");
        env.push(("RYU_MESH_ENABLED".to_owned(), "1".to_owned()));
    }
    // Credits debit hook (#505): activate the gateway's per-request wallet debit
    // (apps/gateway/src/pipeline POSTs `{base}/credits/debit`). This is a NOP
    // unless the install is configured for metered billing, so unconfigured
    // local installs stay graceful-degrade (no debit attempted). Markup is 0 —
    // the platform margin is captured at deposit (B2), so usage debits at cost.
    env.extend(credits_spawn_env());
    // Provider routes through the owner's desktop: hand the Gateway the node's
    // provider proxy so its Anthropic passthrough follows them. Only nodes that
    // run the local-egress entry have one.
    env.extend(
        crate::local_egress::entry::gateway_proxy_env()
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value)),
    );
    // Crash reporting tier (#544, P3): forward the user's `crash-reports-enabled`
    // consent + the Sentry DSN so the gateway's Sentry panic tier follows the SAME
    // single toggle (the gateway has no `PreferencesStore`, so it reads these env
    // vars). Consent is the process-global seeded at Core startup from the pref;
    // the DSN is canonicalized to `RYU_SENTRY_DSN`. With no DSN, nothing is
    // forwarded and the gateway tier stays a no-op.
    env.push((
        "RYU_CRASH_REPORTS_ENABLED".to_owned(),
        if crate::crash::is_consented() {
            "1".to_owned()
        } else {
            "0".to_owned()
        },
    ));
    if let Some(dsn) = crate::crash::dsn() {
        env.push(("RYU_SENTRY_DSN".to_owned(), dsn));
    }
    // Data-plane OTLP export + Gateway LLM analytics (#548, P6): forward the user's
    // ONE `diagnostics-export-enabled` consent + the OTLP destination into the
    // gateway sidecar so its `gen_ai.*` spans (#540) drain to the SAME configured
    // backend (PostHog LLM analytics, Axiom, a Collector, …) ONLY when the user
    // opted in. The gateway reads these env vars in `telemetry::build_otlp_layer`
    // (it has no `PreferencesStore`); Core seeded the process-globals from the pref
    // at startup. With consent OFF or no endpoint, the gateway's gate is a true
    // no-op and NOTHING egresses — the §6 data-plane opt-in posture, end to end.
    let export_consented = crate::telemetry::is_export_consented();
    let endpoint = if export_consented {
        crate::telemetry::otlp_endpoint()
    } else {
        None
    };
    if let Some(endpoint) = endpoint {
        tracing::info!(
            endpoint = %endpoint,
            "gateway: forwarding consented OTLP export (gen_ai LLM analytics)"
        );
        env.push(("RYU_DIAGNOSTICS_EXPORT_ENABLED".to_owned(), "1".to_owned()));
        env.push(("OTEL_EXPORTER_OTLP_ENDPOINT".to_owned(), endpoint));
        // The `gen_ai.*` attributes are EXPERIMENTAL OTel semconv, gated on this
        // opt-in in the gateway. Enable it so PostHog/Axiom receive the LLM
        // attributes (model/provider/tokens/latency) rather than bare spans.
        env.push((
            "OTEL_SEMCONV_STABILITY_OPT_IN".to_owned(),
            "gen_ai_latest_experimental".to_owned(),
        ));
        // OTLP request headers (auth) — forwarded only when configured. The
        // vendor-neutral `OTEL_EXPORTER_OTLP_HEADERS` works for any sink; the
        // PostHog key convenience is folded in by the resolver.
        if let Some(headers) = crate::telemetry::gateway_otlp_headers_env() {
            env.push((crate::telemetry::OTLP_HEADERS_ENV.to_owned(), headers));
        }
        // Exporter presets: the verbatim traces URL + resource attributes Core
        // already resolved (credentials included in the headers above).
        env.extend(crate::telemetry::gateway_export_env());
        // Content mode is a SEPARATE opt-in layered on export consent; forward
        // the user's choice + byte cap only inside this consented branch.
        env.push((
            crate::privacy::DIAGNOSTICS_CONTENT_MODE_ENV.to_owned(),
            crate::telemetry::content_mode().as_str().to_owned(),
        ));
        env.push((
            crate::privacy::DIAGNOSTICS_MAX_CONTENT_BYTES_ENV.to_owned(),
            crate::telemetry::max_content_bytes().to_string(),
        ));
    } else {
        // Consent OFF (or no endpoint): push an EXPLICIT "0" rather than relying on
        // absence. The gateway child inherits Core's process env, so an operator-set
        // `OTEL_EXPORTER_OTLP_ENDPOINT` + `RYU_DIAGNOSTICS_EXPORT_ENABLED=1` would
        // otherwise leak through and the gateway would export while Core does not.
        // Forcing "0" neutralizes any inherited endpoint (the gateway's `should_export`
        // requires enabled=true), so "off → nothing sent" holds end-to-end. Mirrors
        // the crash tier, which pushes an explicit "0" for the same reason.
        env.push(("RYU_DIAGNOSTICS_EXPORT_ENABLED".to_owned(), "0".to_owned()));
        // An inherited operator preset must not resolve a destination either.
        env.push((
            crate::privacy::DIAGNOSTICS_OTLP_PRESET_ENV.to_owned(),
            "otlp".to_owned(),
        ));
        // Likewise neutralize an inherited content-mode opt-in.
        env.push((
            crate::privacy::DIAGNOSTICS_CONTENT_MODE_ENV.to_owned(),
            crate::privacy::ContentMode::MetadataOnly
                .as_str()
                .to_owned(),
        ));
    }
    env
}

/// Inject the user's own provider credentials (Composio / OpenRouter /
/// Replicate / Fal) onto a LOCAL gateway's spawn env.
///
/// Only called on a local data plane (see [`gateway_spawn_env`]), which is never
/// a managed node: [`remote_data_plane`] is true on every managed node, so a
/// managed node calls the hosted fleet gateway with its `rgw_` credential and
/// this function never runs there. The resolvers also ignore env keys on a
/// managed node, so even a misrouted call could only see the tenant's own saved
/// keys, never a Ryu key (D8).
fn push_provider_key_env(env: &mut Vec<(String, String)>) {
    // Composio (#456 deep integration): key presence alone flips the gateway's
    // `ComposioConfig.enabled` (apps/gateway/src/config.rs) and turns on its tool
    // loop. Resolved from the in-process resolver (preferences first, env
    // fallback); this spawn path is sync, so it must not touch the async
    // PreferencesStore. On a key change the preferences handler calls
    // `GatewayManager::refresh()` to respawn with the new value.
    if let Some(key) = crate::composio_auth::key() {
        tracing::info!("gateway: Composio key present, enabling tool loop");
        env.push(("COMPOSIO_API_KEY".to_owned(), key));
    }
    // OpenRouter (A4 / #501): key presence alone activates the gateway's
    // `openrouter` provider. Resolved through the same preferences-first resolver,
    // so a key set in the desktop UI (persisted, never on Core's process env)
    // still reaches the gateway. The user's own routing policy is never
    // overridden here.
    if let Some(key) = crate::openrouter_auth::key() {
        tracing::info!("gateway: OpenRouter key present, enabling openrouter provider");
        env.push(("OPENROUTER_API_KEY".to_owned(), key));
    }
    // Cloud media providers (Replicate / Fal): key presence alone activates the
    // gateway's `replicate` / `fal` providers for cloud image and video
    // generation. Same preferences-first resolver as OpenRouter above.
    if let Some(key) = crate::replicate_auth::key() {
        tracing::info!("gateway: Replicate key present, enabling replicate media provider");
        env.push(("REPLICATE_API_KEY".to_owned(), key));
    }
    if let Some(key) = crate::fal_auth::key() {
        tracing::info!("gateway: Fal key present, enabling fal media provider");
        env.push(("FAL_API_KEY".to_owned(), key));
    }
}

/// Env var enabling the credits debit hook in Core. Default off, so a fresh
/// local install never tries to debit a wallet. The gateway also reads
/// `GATEWAY_CREDITS_ENABLED` directly, but Core gates the whole block on a
/// single is-configured check so unconfigured installs inject nothing at all.
const ENV_CREDITS_ENABLED: &str = "GATEWAY_CREDITS_ENABLED";
/// Env var with the shared internal secret the gateway presents to the control
/// plane (`x-ryu-internal-secret`) so a service-to-service debit for an org is
/// trusted. Without it the debit endpoint rejects the call, so the hook is inert
/// — we therefore treat its presence as a precondition for activation.
const ENV_CREDITS_INTERNAL_SECRET: &str = "RYU_CREDITS_INTERNAL_SECRET";
/// Optional override for the credits control-plane base URL the gateway debits
/// against. When unset, Core derives it from the control-plane base it already
/// knows (`RYU_CONTROL_PLANE_URL` / `RYU_SERVER_URL`) + the `/api` mount.
const ENV_CREDITS_URL: &str = "GATEWAY_CREDITS_URL";
/// Optional wallet-empty action override (`stop` | `downgrade`). Default `stop`.
const ENV_CREDITS_WALLET_EMPTY_ACTION: &str = "GATEWAY_CREDITS_WALLET_EMPTY_ACTION";
/// Per-tool-call cost in micro-USD for billable Composio executions (#496).
/// Composio is not free, so on the managed plan each executed `composio.*` tool
/// call debits the org wallet by this amount (at cost). Operator-provisioned on a
/// managed node; same name on both sides — Core forwards it to the gateway.
/// Default `500` ⇒ $0.50 per 1,000 executions, Composio's managed-app rate.
/// Deployments with a different Composio contract can override it explicitly.
const ENV_CREDITS_COST_PER_TOOL_CALL: &str = "GATEWAY_CREDITS_COST_PER_TOOL_CALL_MICRO_USD";
const DEFAULT_CREDITS_COST_PER_TOOL_CALL_MICRO_USD: u64 = 500;

/// Sandbox per-resource billing rates, in **nano-USD per unit-second** (`u64`),
/// forwarded to the gateway alongside the credits hook. Rates are nano-USD (not
/// micro) because the Daytona storage rate (0.03 micro-USD/GiB/s) truncates to 0
/// in a micro-USD field; the gateway converts nano→micro once, inside
/// `sandbox_tick_cost_raw_micro`. Defaults mirror the Daytona base table in the
/// FROZEN CONTRACT §1. The gateway also carries these defaults, but Core injects
/// them explicitly so an operator can pin rates on Core's env and have them flow
/// to the managed gateway child (belt-and-suspenders, like the tool-call rate).
const SANDBOX_RATE_ENVS: &[(&str, u64)] = &[
    (
        "GATEWAY_CREDITS_COST_PER_SANDBOX_VCPU_SECOND_NANO_USD",
        14_000,
    ),
    (
        "GATEWAY_CREDITS_COST_PER_SANDBOX_MEM_GIB_SECOND_NANO_USD",
        4_500,
    ),
    (
        "GATEWAY_CREDITS_COST_PER_SANDBOX_STORAGE_GIB_SECOND_NANO_USD",
        30,
    ),
    (
        "GATEWAY_CREDITS_COST_PER_SANDBOX_GPU_H200_SECOND_NANO_USD",
        1_261_000,
    ),
    (
        "GATEWAY_CREDITS_COST_PER_SANDBOX_GPU_H100_SECOND_NANO_USD",
        1_097_000,
    ),
    (
        "GATEWAY_CREDITS_COST_PER_SANDBOX_GPU_RTX_PRO_6000_SECOND_NANO_USD",
        842_000,
    ),
    (
        "GATEWAY_CREDITS_COST_PER_SANDBOX_GPU_RTX_5090_SECOND_NANO_USD",
        358_000,
    ),
    (
        "GATEWAY_CREDITS_COST_PER_SANDBOX_GPU_RTX_4090_SECOND_NANO_USD",
        275_000,
    ),
    (
        "GATEWAY_CREDITS_COST_PER_SANDBOX_WINDOWS_VCPU_SECOND_NANO_USD",
        23_800,
    ),
];

/// Free storage allowance (GiB) subtracted before storage billing. Default 5.
const ENV_CREDITS_SANDBOX_FREE_STORAGE_GIB: &str = "GATEWAY_CREDITS_SANDBOX_FREE_STORAGE_GIB";
const DEFAULT_SANDBOX_FREE_STORAGE_GIB: u64 = 5;

/// Sandbox markup in basis points. **Distinct from the global
/// `GATEWAY_CREDITS_MARKUP_BPS` (pinned 0)** — sandbox time is billed with a real
/// margin (default 3000 = +30%), so this must NOT reuse the global markup field.
const ENV_CREDITS_SANDBOX_MARKUP_BPS: &str = "GATEWAY_CREDITS_SANDBOX_MARKUP_BPS";
const DEFAULT_SANDBOX_MARKUP_BPS: u64 = 3000;

/// Env var flagging this Core as a **managed node** (e.g. a Ryu Cloud host).
/// On a managed node Core self-registers to the control plane and its data plane
/// is remote ([`remote_data_plane`]): managed model, media and tool traffic goes
/// to the hosted fleet gateway with the node's `rgw_` credential, and the node
/// holds no Ryu provider key (D8). Composio runs through the Connect service.
/// Default off; a normal local install is never "managed". Read by [`managed_node`] and surfaced on
/// `GET /api/system/info` so a reachable managed node identifies itself.
pub const ENV_MANAGED_NODE: &str = "RYU_MANAGED_NODE";

/// Whether this Core is flagged as a managed node (A4 / #501). Truthy =
/// `1` / `true` / `yes`. Public so the control-plane registration path and the
/// system-info surface share one definition.
pub fn managed_node() -> bool {
    env_truthy(ENV_MANAGED_NODE)
}

/// Env var flagging this Core node's model-call data plane as **remote** (WS1):
/// model traffic routes to a separate hosted gateway fleet rather than a local
/// gateway. Default off. Set truthy (`1` / `true` / `yes`) on a node whose keys
/// live only in the remote fleet.
pub const ENV_GATEWAY_REMOTE: &str = "RYU_GATEWAY_REMOTE";

/// Whether Core's model-call data plane is remote (WS1). True when
/// [`ENV_GATEWAY_REMOTE`] is truthy, OR this is a [`managed_node`]: a managed Ryu
/// Cloud node routes model traffic to the hosted gateway fleet, so a managed node
/// IS a remote-data-plane node. When true it means: do NOT spawn a local gateway,
/// keys live ONLY in the remote fleet (inject none), and `RYU_GATEWAY_URL` +
/// `RYU_GATEWAY_TOKEN` are required so Core has a governed endpoint to reach.
pub fn remote_data_plane() -> bool {
    env_truthy(ENV_GATEWAY_REMOTE) || managed_node()
}

/// Whether truthy: `1` / `true` / `yes` (case-insensitive). Anything else is
/// false, so the hook stays off by default.
fn env_truthy(name: &str) -> bool {
    matches!(
        std::env::var(name)
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    )
}

/// The internal debit secret, if configured (env, trimmed, non-empty).
fn credits_internal_secret() -> Option<String> {
    std::env::var(ENV_CREDITS_INTERNAL_SECRET)
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

/// Resolve the control-plane base URL the credits debit targets.
///
/// Resolution order (nothing hardcoded — every step is a swappable default):
///   1. An explicit `GATEWAY_CREDITS_URL` always wins (operator override).
///   2. Otherwise derive it from the control-plane base Core already knows
///      (`RYU_CONTROL_PLANE_URL` → `RYU_SERVER_URL` → the local dev default)
///      with the `/api` mount the credits router lives under appended.
fn credits_base_url() -> String {
    if let Ok(url) = std::env::var(ENV_CREDITS_URL) {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            return trimmed.trim_end_matches('/').to_owned();
        }
    }
    let base = std::env::var("RYU_CONTROL_PLANE_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            std::env::var("RYU_SERVER_URL")
                .ok()
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or_else(|| "http://127.0.0.1:3000".to_owned());
    let base = base.trim().trim_end_matches('/');
    // The credits router is mounted under `/api` (POST /api/credits/debit), and
    // the gateway appends `/credits/debit` to `GATEWAY_CREDITS_URL`, so the base
    // it receives must end in `/api`. Avoid doubling it if the operator URL
    // already includes the mount.
    if base.ends_with("/api") {
        base.to_owned()
    } else {
        format!("{base}/api")
    }
}

/// Whether the credits debit hook is configured for this install.
///
/// Requires BOTH the explicit enable signal AND the internal secret: without
/// the secret the control plane rejects every debit, so injecting the block
/// would be pointless and could surface confusing failures. When this is false
/// Core injects no `GATEWAY_CREDITS_*` vars at all, leaving the gateway hook a
/// NOP (graceful degrade preserved for local/unconfigured installs).
fn credits_configured() -> bool {
    env_truthy(ENV_CREDITS_ENABLED) && credits_internal_secret().is_some()
}

/// Env Core layers onto the gateway to activate the per-request wallet debit
/// (#505). Empty unless [`credits_configured`] — so unconfigured installs are
/// untouched. `GATEWAY_CREDITS_MARKUP_BPS` is pinned to `0`: usage is debited at
/// cost and the platform margin is captured at deposit (B2).
fn credits_spawn_env() -> Vec<(String, String)> {
    if !credits_configured() {
        return Vec::new();
    }
    let Some(secret) = credits_internal_secret() else {
        return Vec::new();
    };
    let base = credits_base_url();
    let action = std::env::var(ENV_CREDITS_WALLET_EMPTY_ACTION)
        .ok()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| s == "stop" || s == "downgrade")
        .unwrap_or_else(|| "stop".to_owned());
    // Per-tool-call (Composio) cost: forward the operator-provisioned rate,
    // defaulting to $0.50/1,000 (Composio's managed-app rate). Only a
    // valid non-negative integer is honoured; malformed input uses the safe
    // non-zero default so a managed gateway cannot silently under-bill.
    let tool_call_cost = resolve_u64_env_string(
        ENV_CREDITS_COST_PER_TOOL_CALL,
        DEFAULT_CREDITS_COST_PER_TOOL_CALL_MICRO_USD,
    );
    tracing::info!(
        base_url = %base,
        wallet_empty_action = %action,
        tool_call_cost_micro_usd = %tool_call_cost,
        "gateway: activating credits debit hook (usage + tool calls debited at cost, markup_bps=0)"
    );
    let mut env = vec![
        (ENV_CREDITS_ENABLED.to_owned(), "true".to_owned()),
        (ENV_CREDITS_URL.to_owned(), base),
        (ENV_CREDITS_INTERNAL_SECRET.to_owned(), secret),
        ("GATEWAY_CREDITS_MARKUP_BPS".to_owned(), "0".to_owned()),
        (ENV_CREDITS_COST_PER_TOOL_CALL.to_owned(), tool_call_cost),
        (ENV_CREDITS_WALLET_EMPTY_ACTION.to_owned(), action),
    ];
    // Sandbox metering rail (Daytona): forward the per-resource nano-USD rates,
    // the free-storage allowance, and the sandbox markup. Unlike the global
    // markup (pinned 0 — usage bills at cost), sandbox time carries a real margin
    // (default 3000 = +30%), so `GATEWAY_CREDITS_SANDBOX_MARKUP_BPS` is forwarded
    // with its real value, NOT pinned 0.
    env.extend(sandbox_credits_spawn_env());
    env
}

/// Resolve a `u64` env var to its string form, defaulting when unset or invalid.
/// Only a valid non-negative integer is honoured; anything else falls to
/// `default` so a malformed operator value never breaks the spawn.
fn resolve_u64_env_string(name: &str, default: u64) -> String {
    std::env::var(name)
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| s.parse::<u64>().is_ok())
        .unwrap_or_else(|| default.to_string())
}

/// Build the sandbox-billing env pairs forwarded to the gateway (the nine
/// per-resource nano-USD rates + free-storage allowance + sandbox markup).
/// Resolved from Core's env with the FROZEN CONTRACT §1 defaults so a managed
/// gateway child always receives consistent, real sandbox rates.
fn sandbox_credits_spawn_env() -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = SANDBOX_RATE_ENVS
        .iter()
        .map(|(var, default)| ((*var).to_owned(), resolve_u64_env_string(var, *default)))
        .collect();
    env.push((
        ENV_CREDITS_SANDBOX_FREE_STORAGE_GIB.to_owned(),
        resolve_u64_env_string(
            ENV_CREDITS_SANDBOX_FREE_STORAGE_GIB,
            DEFAULT_SANDBOX_FREE_STORAGE_GIB,
        ),
    ));
    let markup = resolve_u64_env_string(ENV_CREDITS_SANDBOX_MARKUP_BPS, DEFAULT_SANDBOX_MARKUP_BPS);
    tracing::info!(
        sandbox_markup_bps = %markup,
        "gateway: forwarding sandbox metering rates (real markup, NOT pinned 0)"
    );
    env.push((ENV_CREDITS_SANDBOX_MARKUP_BPS.to_owned(), markup));
    env
}

/// Derive the URL the gateway should use to reach *this* Core instance.
///
/// Core binds from `--bind=` / `RYU_BIND` / the `127.0.0.1:7980` default. This
/// spawn path is sync (does not see Core's parsed args), so we read `RYU_BIND`
/// directly. A wildcard bind host (`0.0.0.0` / `::`) is not a usable client
/// host, so it is rewritten to loopback.
pub(crate) fn core_self_url() -> String {
    let default_bind = format!("127.0.0.1:{}", crate::profile::port(7980));
    let bind = std::env::var("RYU_BIND").unwrap_or(default_bind);
    let default_port = crate::profile::port(7980).to_string();
    let (host, port) = match bind.rsplit_once(':') {
        Some((h, p)) => (h, p),
        None => (bind.as_str(), default_port.as_str()),
    };
    let host = match host.trim() {
        "" | "0.0.0.0" | "::" | "[::]" => "127.0.0.1",
        other => other,
    };
    format!("http://{host}:{port}")
}

/// Whether Core should spawn and manage the gateway process itself.
/// Defaults to `true`; set `RYU_GATEWAY_MANAGED=0`/`false` to point Core at an
/// already-running (e.g. shared/cloud) gateway instead.
fn is_managed() -> bool {
    match std::env::var(ENV_GATEWAY_MANAGED) {
        Ok(v) => !matches!(v.trim().to_ascii_lowercase().as_str(), "0" | "false" | "no"),
        Err(_) => true,
    }
}

/// Whether Core's Gateway is the local sidecar Core spawns itself (not a remote
/// data plane, a managed node's hosted fleet, or an operator-run Gateway). Its
/// usage is then only in the local audit store unless that Gateway's own config
/// enables control-plane reporting.
pub(crate) fn core_spawned_local_gateway() -> bool {
    !remote_data_plane() && is_managed()
}

/// Non-secret marker recorded by `ryu-core gateway-seal-env`: the operator
/// has taken the Gateway's `gateway.toml` sealing subkey for an externally
/// managed Gateway.
const SEAL_KEY_HANDOFF_MARKER: &str = "gateway-seal-key-handoff";

fn seal_key_handoff_marker() -> std::path::PathBuf {
    crate::paths::state_path(SEAL_KEY_HANDOFF_MARKER)
}

/// What Core tells an operator whose externally managed Gateway may not hold
/// the key for a secret Core is about to seal into `gateway.toml`.
pub(crate) const EXTERNAL_GATEWAY_SEAL_KEY_REQUIRED: &str =
    "The Gateway is externally managed (RYU_GATEWAY_MANAGED=0), and Core cannot confirm it \
     holds the key that seals gateway.toml secrets, so the new secret was not saved. Run \
     `ryu-core gateway-seal-env` and start the Gateway with the RYU_SEAL_KEY and \
     RYU_SEAL_SCOPE it prints (or give Core and the Gateway the same RYU_MASTER_KEY), \
     then save again.";

/// Whether Core may seal a new secret into a `gateway.toml` the Gateway reads.
/// A Core-spawned Gateway always receives the subkey; an external one only has
/// it when the operator supplied the master key to both, or took the subkey
/// with `ryu-core gateway-seal-env`.
fn external_seal_decision(
    managed: bool,
    master_from_env: bool,
    handoff_recorded: bool,
) -> Result<(), String> {
    if managed || master_from_env || handoff_recorded {
        Ok(())
    } else {
        Err(EXTERNAL_GATEWAY_SEAL_KEY_REQUIRED.to_owned())
    }
}

/// [`ryu_gw_credentials::sealed_config::WriteGate`] installed by Core. It runs
/// only before a write seals a new secret into a file that holds no sealed
/// leaf, so a file an external Gateway already seals is unaffected.
pub(crate) fn external_config_write_gate() -> Result<(), String> {
    let master_from_env = ryu_crypto::key_custody()
        .is_ok_and(|custody| custody.source == ryu_crypto::MasterKeySource::Env);
    external_seal_decision(
        is_managed(),
        master_from_env,
        seal_key_handoff_marker().is_file(),
    )
}

/// `ryu-core gateway-seal-env`: print the Gateway's `gateway.toml` sealing
/// subkey (HKDF of the master key, never the master key) as environment
/// assignments for an externally managed Gateway, and record that the operator
/// holds it. Returns the process exit code.
pub(crate) fn run_seal_env_subcommand() -> i32 {
    let entries = match ryu_crypto::component_child_env(ryu_crypto::components::GATEWAY) {
        Ok(entries) => entries,
        Err(error) => {
            eprintln!("ryu-core gateway-seal-env: the master key is unavailable: {error}");
            return 1;
        }
    };
    let marker = seal_key_handoff_marker();
    let stamp = format!(
        "recorded {}\n",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or_default()
    );
    if let Err(error) = std::fs::write(&marker, stamp) {
        eprintln!(
            "ryu-core gateway-seal-env: could not record the key handoff at {}: {error}",
            marker.display()
        );
        return 1;
    }
    for (key, value) in entries {
        println!("{key}={value}");
    }
    eprintln!(
        "Give these to the externally managed Gateway only (they open gateway.toml \
         secrets); keep them in a secret manager, not in a file next to gateway.toml."
    );
    0
}

/// Manages the local gateway child process.
pub struct GatewayManager {
    handle: ProcessHandle,
}

impl GatewayManager {
    pub fn new() -> Self {
        Self {
            handle: ProcessHandle::new(),
        }
    }

    /// Apply committed provider bytes without changing the child lifetime.
    /// Revision only; upstream keys remain in the authored Gateway file/runtime.
    pub async fn apply_provider_revision(
        &self,
        revision: &ryu_gw_credentials::ConfigRevision,
    ) -> ryu_gw_credentials::ProviderApplyOutcome {
        use ryu_gw_credentials::{ProviderApplyErrorCode as Code, ProviderApplyOutcome as Outcome};
        if !is_managed() || remote_data_plane() {
            return Outcome::Unmanaged {
                requested_revision: revision.clone(),
            };
        }
        let owned = self.handle.is_running();
        let base = if owned {
            gateway_url()
        } else {
            configured_gateway_url()
        };
        let adoption_client = if owned {
            None
        } else {
            REJECTED_LOCAL_GATEWAY.store(true, std::sync::atomic::Ordering::Release);
            let Some(url) = local_gateway_control_url(&base) else {
                return Outcome::Failed {
                    requested_revision: revision.clone(),
                    active_revision: None,
                    code: Code::Transport,
                };
            };
            let client = match local_gateway_control_client(&url).build() {
                Ok(client) => client,
                Err(_) => {
                    return Outcome::Failed {
                        requested_revision: revision.clone(),
                        active_revision: None,
                        code: Code::Transport,
                    }
                }
            };
            if !client
                .get(format!("{}/health", base.trim_end_matches('/')))
                .send()
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                return Outcome::Offline {
                    requested_revision: revision.clone(),
                };
            }
            Some(client)
        };
        let Some(admin) = gateway_admin_key() else {
            return Outcome::Failed {
                requested_revision: revision.clone(),
                active_revision: None,
                code: Code::Transport,
            };
        };
        if let Some(client) = adoption_client {
            let credentials = gateway_bearer()
                .and_then(|relay| required_gateway_core_token().map(|core| (relay, core)));
            let verified = match credentials {
                Ok((relay, core)) => {
                    verify_managed_gateway_with_client(&client, &base, &admin, &relay, &core)
                        .await
                        .is_ok()
                }
                Err(_) => false,
            };
            REJECTED_LOCAL_GATEWAY.store(!verified, std::sync::atomic::Ordering::Release);
            if !verified {
                return Outcome::Failed {
                    requested_revision: revision.clone(),
                    active_revision: None,
                    code: Code::UnexpectedResponse,
                };
            }
        }
        send_provider_revision(&base, &admin, revision).await
    }

    /// Spawn the gateway (unless externally managed) and wait for it to report
    /// healthy. Returns `Ok(true)` when a healthy gateway is reachable,
    /// `Ok(false)` when Core is configured to use an external gateway (caller
    /// should not assume it is up), and `Err` when a managed spawn failed.
    pub async fn start(&self) -> anyhow::Result<bool> {
        // Remote data plane (WS1): a managed/remote Ryu Cloud node routes every
        // model call to a separate hosted gateway fleet, so Core must NOT spawn a
        // local (keyed) gateway — the same effect as an externally managed gateway,
        // but the keys live only in the fleet. Require the remote endpoint + token
        // so chat has a governed place to go; without both Core has no data plane,
        // so fail with a clear startup error rather than silently degrading.
        if remote_data_plane() {
            let has_url = std::env::var(ENV_GATEWAY_URL)
                .ok()
                .filter(|s| !s.is_empty())
                .is_some();
            if !has_url || gateway_token().is_none() {
                anyhow::bail!(
                    "remote data plane (RYU_GATEWAY_REMOTE / managed node) requires both RYU_GATEWAY_URL and RYU_GATEWAY_TOKEN to be set; refusing to spawn a local keyed gateway"
                );
            }
            tracing::info!(
                url = %gateway_url(),
                "gateway: remote data plane — routing to the hosted gateway fleet, not spawning a local gateway"
            );
            return Ok(false);
        }
        if !is_managed() {
            tracing::info!(
                url = %gateway_url(),
                "gateway: externally managed (RYU_GATEWAY_MANAGED disabled), not spawning"
            );
            return Ok(false);
        }

        // Quarantine immediately: credential failures must not leave a previously
        // running anonymous listener usable by Core's independent HTTP clients.
        REJECTED_LOCAL_GATEWAY.store(true, std::sync::atomic::Ordering::Release);
        let admin = required_gateway_admin_key()?;
        let relay = gateway_bearer()?;
        let core_relay = required_gateway_core_token()?;
        anyhow::ensure!(
            core_relay != admin && core_relay != relay,
            "Core forwarding credentials must be distinct"
        );
        anyhow::ensure!(
            admin != relay,
            "Gateway admin and inference credentials must differ"
        );
        // A healthy old listener is not proof of the managed authentication contract.
        let base = configured_gateway_url();
        if health_check(&base).await {
            REJECTED_LOCAL_GATEWAY.store(true, std::sync::atomic::Ordering::Release);
            if managed_llamacpp_selected() && !managed_llamacpp_ready() {
                anyhow::bail!(
                    "managed llama.cpp is not ready; refusing to adopt the existing Gateway listener"
                );
            }
            verify_managed_gateway(&base, &admin, &relay, &core_relay).await?;
            REJECTED_LOCAL_GATEWAY.store(false, std::sync::atomic::Ordering::Release);
            tracing::info!(url = %base, "gateway: authenticated existing listener verified");
            return Ok(true);
        }

        let bin = std::env::var(ENV_GATEWAY_BIN)
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_GATEWAY_BIN.to_owned());

        let bind = gateway_bind_from_url();
        tracing::info!(bin = %bin, bind = %bind, "gateway: spawning");

        // Inherit Core's environment so provider credentials flow to the
        // gateway, which owns them and forwards to the engine/provider. On top
        // of that, point the gateway's `local` provider at the active local
        // engine so a model bound to it routes through the gateway to that
        // engine (U19).
        let env = gateway_spawn_env();
        let args = [format!("--bind={bind}")];
        // Defense-in-depth (WS1): `start()` returns early on a remote data plane,
        // so this spawn is only reached on a LOCAL plane where the gateway legitimately
        // inherits provider creds. Should a gateway child ever be spawned in remote
        // mode, route its env through the scrub allowlist so it cannot inherit a
        // provider key from Core's own process env.
        let spawned = if remote_data_plane() {
            self.handle
                .start_path_with_scrubbed_env(&bin, &args, &env)
                .await
        } else {
            self.handle.start_path_with_env(&bin, &args, &env).await
        };
        spawned.map_err(|e| anyhow::anyhow!("failed to spawn ryu-gateway ({bin}): {e}"))?;
        // The opted-in guard tier serves the endpoint the spawn env just
        // published. Fire-and-forget: a guard still loading is a down backend
        // to the Gateway, never a failed spawn.
        crate::sidecar::node_screener::maybe_start_guard_tier(SIDECAR_MANAGER.get().cloned());

        // Wait long enough for a cold first launch to load its config and
        // initialize provider clients. A seven-second window quarantined a
        // healthy managed child when the binary was present but still starting,
        // leaving Core stuck on the intentionally invalid `:0` URL for its whole
        // process lifetime. Keep polling rather than treating slow startup as a
        // permanent data-plane failure.
        for _ in 0..120 {
            if health_check(&base).await {
                if let Err(error) = verify_managed_gateway(&base, &admin, &relay, &core_relay).await
                {
                    REJECTED_LOCAL_GATEWAY.store(true, std::sync::atomic::Ordering::Release);
                    return Err(error);
                }
                REJECTED_LOCAL_GATEWAY.store(false, std::sync::atomic::Ordering::Release);
                tracing::info!(url = %gateway_url(), "gateway: healthy");
                return Ok(true);
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }

        anyhow::bail!("ryu-gateway spawned but did not become healthy in time")
    }

    /// Re-point the gateway at the currently active local engine.
    ///
    /// Called after a local-engine swap (U4) so the gateway's `local` provider
    /// follows the active engine and the swap stays invisible to agents (U19).
    /// For a Core-managed gateway this stops and respawns the child with fresh
    /// `LOCAL_LLM_URL` env. For an externally managed gateway it is a no-op
    /// (Core does not own that process), so the caller should treat a swap as
    /// best-effort there.
    pub async fn refresh(&self) -> anyhow::Result<bool> {
        if !is_managed() {
            tracing::info!("gateway: externally managed, skipping refresh after engine swap");
            return Ok(false);
        }
        if self.handle.is_running() {
            self.handle.stop_graceful(GATEWAY_STOP_GRACE).await?;
        }
        self.start().await
    }

    /// Whether a managed gateway child is currently running.
    pub fn is_running(&self) -> bool {
        self.handle.is_running()
    }

    /// Stop the managed gateway child (if any).
    pub async fn stop(&self) -> anyhow::Result<()> {
        self.handle.stop_graceful(GATEWAY_STOP_GRACE).await
    }
}

/// How long a managed Gateway gets after SIGTERM to drain and flush its OTLP
/// batch (bounded there by a 5 s flush timeout) before it is killed.
const GATEWAY_STOP_GRACE: std::time::Duration = std::time::Duration::from_secs(7);

async fn send_provider_revision(
    base_url: &str,
    admin: &str,
    revision: &ryu_gw_credentials::ConfigRevision,
) -> ryu_gw_credentials::ProviderApplyOutcome {
    use ryu_gw_credentials::{ProviderApplyErrorCode as Code, ProviderApplyOutcome as Outcome};
    let failure = |code| Outcome::Failed {
        requested_revision: revision.clone(),
        active_revision: None,
        code,
    };
    let Some(mut url) = local_gateway_control_url(base_url) else {
        return failure(Code::Transport);
    };
    url.set_path(&format!(
        "{}/v1/config/providers/apply",
        url.path().trim_end_matches('/')
    ));
    let client = match local_gateway_control_client(&url).build() {
        Ok(client) => client,
        Err(_) => return failure(Code::Transport),
    };
    let mut response = match client
        .post(url)
        .bearer_auth(admin)
        .json(&serde_json::json!({"revision":revision}))
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return failure(Code::Transport),
    };
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > 16 * 1024)
    {
        return failure(Code::UnexpectedResponse);
    }
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if bytes.len() + chunk.len() <= 16 * 1024 => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(Some(_)) => return failure(Code::UnexpectedResponse),
            Ok(None) => break,
            Err(_) => return failure(Code::Transport),
        }
    }
    match serde_json::from_slice::<Outcome>(&bytes) {
        Ok(outcome) if outcome.validates_request(revision) => outcome,
        _ => failure(Code::UnexpectedResponse),
    }
}

fn local_gateway_control_url(base: &str) -> Option<reqwest::Url> {
    let url = reqwest::Url::parse(base).ok()?;
    let loopback = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    });
    if !loopback
        || !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(url)
}

fn local_gateway_control_client(url: &reqwest::Url) -> reqwest::ClientBuilder {
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(10));
    if url.host_str() == Some("localhost") {
        let port = url.port_or_known_default().unwrap_or(80);
        builder = builder.resolve_to_addrs(
            "localhost",
            &[
                std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port)),
                std::net::SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, port)),
            ],
        );
    }
    builder
}

impl Default for GatewayManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Derive the gateway `--bind=host:port` from the configured URL so the spawned
/// process listens where Core forwards.
fn gateway_bind_from_url() -> String {
    let url = configured_gateway_url();
    let stripped = url
        .trim_end_matches('/')
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    if stripped.contains(':') {
        stripped.to_owned()
    } else {
        format!("{stripped}:7981")
    }
}

/// Returns `true` when the gateway at [`gateway_url`] responds healthy.
///
/// Used by the OpenAI-compat routing path to decide whether to forward through
/// the gateway or fall back to the direct provider path (graceful degradation).
pub async fn is_healthy() -> bool {
    health_check(&gateway_url()).await
}

// ── Exec audit / budget gate (M6 / #192) ─────────────────────────────────────
//
// Core calls these two functions to implement the Gateway-owns-policy rule for
// sandbox executions:
//   1. `check_exec_budget`  — pre-run, fail-closed gate (policy = allowed/deny).
//   2. `report_exec_audit`  — post-run, best-effort record (already ran, so
//      if the gateway blinks here we log a warning but don't fail the caller).
//
// Env: `RYU_ALLOW_GATEWAY_FALLBACK=1` opts into fail-open on the pre-run gate
// (identical semantics to the chat-path fallback env var). The permanent-file
// deletion guard is independent of that fallback and remains local/default-deny.

/// Env var name: when set to `1`, a gateway-unreachable pre-run check allows
/// execution instead of failing closed. Default: fail-closed.
const ENV_ALLOW_GATEWAY_FALLBACK: &str = "RYU_ALLOW_GATEWAY_FALLBACK";

/// Env var that controls gateway base-URL injection into ACP subprocess spawns.
///
/// Default: injection enabled (`"1"`). Set to `"0"` / `"false"` / `"no"` to
/// disable injection so the subprocess talks directly to its provider (BYO-endpoint
/// mode). This satisfies the BYO principle: users who supply their own provider
/// keys and endpoints can bypass the local gateway completely.
const ENV_ACP_GATEWAY_INJECT: &str = "RYU_ACP_GATEWAY_INJECT";

/// Returns `true` when gateway base-URL injection into ACP subprocess spawns is
/// enabled (the default). Opt out by setting `RYU_ACP_GATEWAY_INJECT=0`.
pub fn should_inject_gateway() -> bool {
    !matches!(
        std::env::var(ENV_ACP_GATEWAY_INJECT)
            .as_deref()
            .unwrap_or("1"),
        "0" | "false" | "no"
    )
}

fn allow_fallback() -> bool {
    matches!(
        std::env::var(ENV_ALLOW_GATEWAY_FALLBACK)
            .as_deref()
            .unwrap_or(""),
        "1" | "true" | "yes"
    )
}

/// Outcome of a pre-run exec budget check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecBudgetOutcome {
    /// Execution is permitted.
    Allow,
    /// Gateway denied the execution (budget exhausted, action=stop).
    Deny(String),
}

/// Check with the gateway whether a sandbox execution is permitted.
///
/// Fail-closed: if the gateway is unreachable AND `RYU_ALLOW_GATEWAY_FALLBACK`
/// is not set, this returns `Deny` so Core refuses to run the exec. This
/// satisfies hard constraint #1 (fail-closed gateway).
///
/// `api_key` is the bearer token Core uses to talk to the gateway.
pub async fn check_exec_budget(backend: &str, command: &str) -> ExecBudgetOutcome {
    check_exec_budget_request(serde_json::json!({
        "backend": backend,
        "command": command,
    }))
    .await
}

/// Check the Gateway-owned per-instance follow-up budget before a widget prompt
/// enters model context. The Gateway remains the policy owner; Core only carries
/// the provenance envelope and refuses the follow-up on any denied response.
pub async fn check_widget_followup(instance_id: &str, origin_server: &str) -> ExecBudgetOutcome {
    check_widget_budget_request(serde_json::json!({
        "backend": "widget-followup",
        "command": "follow_up",
        "feature": "widget-followup",
        "widget": {
            "instance_id": instance_id,
            "origin_server": origin_server,
        },
    }))
    .await
}

/// Widget governance is always fail-closed. The general execution fallback
/// must never turn a missing or malformed Gateway verdict into permission to
/// inject a prompt into model context.
async fn check_widget_budget_request(payload: serde_json::Value) -> ExecBudgetOutcome {
    let endpoint = format!(
        "{}/v1/exec/budget/check",
        gateway_url().trim_end_matches('/')
    );
    let mut req = gateway_http_client()
        .post(&endpoint)
        .timeout(std::time::Duration::from_secs(5))
        .json(&payload);
    if let Some(tok) = gateway_core_token() {
        req = req.bearer_auth(tok);
    }

    match req.send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
            Ok(body) => parse_widget_budget_response(body),
            Err(e) => {
                tracing::warn!("widget budget check: could not parse gateway response: {e}");
                ExecBudgetOutcome::Deny("widget budget response parse error".to_owned())
            }
        },
        Ok(resp) => {
            let status = resp.status();
            tracing::warn!("widget budget check: gateway returned {status}");
            ExecBudgetOutcome::Deny(format!("widget budget gateway returned HTTP {status}"))
        }
        Err(e) => {
            tracing::warn!("widget budget check: gateway unreachable: {e}");
            ExecBudgetOutcome::Deny(format!("widget budget gateway unreachable: {e}"))
        }
    }
}

fn parse_widget_budget_response(body: serde_json::Value) -> ExecBudgetOutcome {
    match body.get("allowed").and_then(serde_json::Value::as_bool) {
        Some(true) => ExecBudgetOutcome::Allow,
        Some(false) => ExecBudgetOutcome::Deny(
            body.get("reason")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("widget budget denied")
                .to_owned(),
        ),
        None => ExecBudgetOutcome::Deny(
            "widget budget response missing boolean allowed verdict".to_owned(),
        ),
    }
}

fn parse_exec_budget_response(body: serde_json::Value) -> ExecBudgetOutcome {
    let Some(allowed) = body.get("allowed").and_then(serde_json::Value::as_bool) else {
        return ExecBudgetOutcome::Deny(
            "exec budget response missing boolean allowed verdict".to_owned(),
        );
    };
    if allowed {
        ExecBudgetOutcome::Allow
    } else {
        ExecBudgetOutcome::Deny(
            body.get("reason")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("exec budget exhausted")
                .to_owned(),
        )
    }
}

async fn check_exec_budget_request(payload: serde_json::Value) -> ExecBudgetOutcome {
    let base = gateway_url();
    let endpoint = format!("{}/v1/exec/budget/check", base.trim_end_matches('/'));
    let token = gateway_core_token();

    let client = gateway_http_client();
    let mut req = client
        .post(&endpoint)
        .timeout(std::time::Duration::from_secs(5))
        .json(&payload);
    if let Some(tok) = token {
        req = req.bearer_auth(tok);
    }

    match req.send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
            Ok(body) => parse_exec_budget_response(body),
            Err(e) => {
                tracing::warn!("exec budget check: could not parse gateway response: {e}");
                if allow_fallback() {
                    ExecBudgetOutcome::Allow
                } else {
                    ExecBudgetOutcome::Deny(
                        "gateway response parse error; set RYU_ALLOW_GATEWAY_FALLBACK=1 to allow"
                            .to_owned(),
                    )
                }
            }
        },
        Ok(resp) => {
            // Non-2xx from gateway = explicit deny.
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            tracing::warn!("exec budget check: gateway returned {status}: {body}");
            ExecBudgetOutcome::Deny(format!("gateway denied exec: HTTP {status}"))
        }
        Err(e) => {
            // Network error: gateway unreachable.
            tracing::warn!("exec budget check: gateway unreachable: {e}");
            if allow_fallback() {
                tracing::warn!(
                    "exec budget check: gateway unreachable but RYU_ALLOW_GATEWAY_FALLBACK=1, allowing"
                );
                ExecBudgetOutcome::Allow
            } else {
                ExecBudgetOutcome::Deny(format!(
                    "gateway unreachable ({e}); set RYU_ALLOW_GATEWAY_FALLBACK=1 to allow"
                ))
            }
        }
    }
}

// ── Command-approval scan gate (POST /v1/exec/scan) ──────────────────────────
//
// A second, orthogonal pre-run gate alongside the budget check: the gateway
// scans the actual command against its policy (firewall patterns, allow/deny
// rules) and returns a verdict. This gate is armed BY DEFAULT — an unset
// `RYU_EXEC_APPROVAL_MODE` scans (the gateway's own default mode governs the
// verdict); only an explicit `off` disarms it. The default-on posture is what
// closes the headless auto-approve hole: non-interactive runs (scheduler,
// triggers, healing, delegation) auto-approve permission requests, so without
// this scan they get unattended arbitrary shell/file-write. When armed it is
// fail-closed on the same terms as the budget gate: unreachable / non-2xx /
// parse error => Deny unless `RYU_ALLOW_GATEWAY_FALLBACK=1`. Permanent file and
// directory deletion is a stronger local hard stop and never follows that
// fallback.

/// Env var selecting the command-approval mode. An explicit `off`
/// (case-insensitive) disables the scan entirely (Core does not call the gateway
/// and always allows). Unset/empty or any other value arms the fail-closed scan
/// gate — armed is the default.
const ENV_EXEC_APPROVAL_MODE: &str = "RYU_EXEC_APPROVAL_MODE";

/// Whether the command-approval scan gate is enabled. Armed by default (unset /
/// empty env); only an explicit `off` (case-insensitive, trimmed) disarms —
/// governance must be an explicit opt-OUT, never a silent default-off.
fn exec_approval_enabled() -> bool {
    match std::env::var(ENV_EXEC_APPROVAL_MODE) {
        Ok(v) => !v.trim().eq_ignore_ascii_case("off"),
        Err(_) => true,
    }
}

/// Outcome of a pre-run exec scan (`POST /v1/exec/scan`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecScanOutcome {
    /// The gateway allows the command (or the gate is disabled).
    Allow,
    /// The gateway denied the command (policy violation, or fail-closed on an
    /// unreachable/unparseable gateway). Carries a human-readable reason.
    Deny(String),
    /// The gateway requires human approval before the command may run. Carries
    /// the gateway's reason so the caller can surface it.
    ApprovalRequired(String),
}

/// Map a gateway `decision` string (+ `reason`) to an [`ExecScanOutcome`].
/// `allow` allows; `approval_required` requires approval; **any other value**
/// (including `deny` and unknown verdicts) is a fail-closed deny.
fn map_scan_decision(decision: &str, reason: &str) -> ExecScanOutcome {
    match decision {
        "allow" => ExecScanOutcome::Allow,
        "approval_required" => ExecScanOutcome::ApprovalRequired(if reason.is_empty() {
            "command requires approval".to_owned()
        } else {
            reason.to_owned()
        }),
        _ => ExecScanOutcome::Deny(if reason.is_empty() {
            "command denied by gateway policy".to_owned()
        } else {
            reason.to_owned()
        }),
    }
}

/// Scan a command against gateway policy before running it
/// (`POST /v1/exec/scan`). Mirrors [`check_exec_budget`]'s base-url, auth, and
/// fail-closed semantics.
///
/// Armed by default: only an EXPLICIT `RYU_EXEC_APPROVAL_MODE=off` short-circuits
/// to `Allow` without any network call (the operator's documented opt-out).
///
/// Fail-closed when armed: an unreachable gateway, a non-2xx response, or an
/// unparseable body all map to `Deny` unless `RYU_ALLOW_GATEWAY_FALLBACK=1` is
/// set (then `Allow`), identical to the budget gate.
pub async fn check_exec_scan(
    backend: &str,
    command: &str,
    session_id: Option<&str>,
    agent: Option<&str>,
) -> ExecScanOutcome {
    // Do this before the network call. A gateway outage plus the documented
    // fallback must not turn a permanent deletion into an allowed command.
    if let Some(rule) = ryu_deletion_guard::detect_command(command) {
        return ExecScanOutcome::Deny(format!(
            "permanent file deletion blocked by local Ryu guard: {rule}; move the target to the host Trash or Recycle Bin"
        ));
    }

    let (organization_id, project_id, managed_rules) = crate::fleet::command_scan_context();
    // The local off switch disables only the built-in risk scanner. Managed
    // rules remain enforceable, including after an LKG snapshot expires (when
    // the fleet cache returns denies only).
    if !exec_approval_enabled() && managed_rules.is_empty() {
        return ExecScanOutcome::Allow;
    }

    let base = gateway_url();
    let endpoint = format!("{}/v1/exec/scan", base.trim_end_matches('/'));
    let token = gateway_core_token();

    let client = gateway_http_client();
    let mut req = client
        .post(&endpoint)
        .timeout(std::time::Duration::from_secs(5))
        .json(&serde_json::json!({
            "backend": backend,
            "command": command,
            "managed_rules": managed_rules,
            "organization_id": organization_id,
            "project_id": project_id,
            "session_id": session_id,
            "agent": agent,
        }));
    if let Some(tok) = token {
        req = req.bearer_auth(tok);
    }

    match req.send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
            Ok(body) => {
                let decision = body
                    .get("decision")
                    .and_then(|v| v.as_str())
                    .unwrap_or("deny");
                let reason = body.get("reason").and_then(|v| v.as_str()).unwrap_or("");
                map_scan_decision(decision, reason)
            }
            Err(e) => {
                tracing::warn!("exec scan: could not parse gateway response: {e}");
                if allow_fallback() {
                    ExecScanOutcome::Allow
                } else {
                    ExecScanOutcome::Deny(
                        "gateway response parse error; set RYU_ALLOW_GATEWAY_FALLBACK=1 to allow"
                            .to_owned(),
                    )
                }
            }
        },
        Ok(resp) => {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            tracing::warn!("exec scan: gateway returned {status}: {body}");
            ExecScanOutcome::Deny(format!("gateway denied exec scan: HTTP {status}"))
        }
        Err(e) => {
            tracing::warn!("exec scan: gateway unreachable: {e}");
            if allow_fallback() {
                tracing::warn!(
                    "exec scan: gateway unreachable but RYU_ALLOW_GATEWAY_FALLBACK=1, allowing"
                );
                ExecScanOutcome::Allow
            } else {
                ExecScanOutcome::Deny(format!(
                    "gateway unreachable ({e}); set RYU_ALLOW_GATEWAY_FALLBACK=1 to allow"
                ))
            }
        }
    }
}

/// Report a completed sandbox execution to the gateway audit store.
///
/// Best-effort: the exec already ran with permission, so if the gateway is
/// unreachable we log a warning but do not fail the caller.
#[derive(Debug, Clone, Default)]
pub struct ExecAuditAttribution {
    /// Stable Core agent id that performed the execution, when known.
    pub agent_id: Option<String>,
    /// Verified user id on whose behalf the execution ran, when known.
    pub user_id: Option<String>,
    /// Bounded display label for the verified user, when known.
    pub user_name: Option<String>,
    /// Product surface that initiated the execution, when known.
    pub feature: Option<String>,
}

pub async fn report_exec_audit(
    backend: &str,
    command: &str,
    duration_ms: u64,
    exit_code: i32,
    session_id: Option<String>,
    error: Option<String>,
) {
    report_exec_audit_with_attribution(
        backend,
        command,
        duration_ms,
        exit_code,
        session_id,
        error,
        ExecAuditAttribution::default(),
    )
    .await;
}

/// Report a completed execution with the verified agent/user attribution that
/// was available at the Core boundary. The legacy helper above remains the
/// compatibility path for callers that do not have that context yet.
pub async fn report_exec_audit_with_attribution(
    backend: &str,
    command: &str,
    duration_ms: u64,
    exit_code: i32,
    session_id: Option<String>,
    error: Option<String>,
    attribution: ExecAuditAttribution,
) {
    let base = gateway_url();
    let endpoint = format!("{}/v1/exec/audit", base.trim_end_matches('/'));
    let token = gateway_core_token();

    let client = gateway_http_client();
    let mut req = client
        .post(&endpoint)
        .timeout(std::time::Duration::from_secs(5))
        .json(&serde_json::json!({
            "backend": backend,
            "command": command,
            "duration_ms": duration_ms,
            "exit_code": exit_code,
            "session_id": session_id,
            "error": error,
            "agent_id": attribution.agent_id,
            "user_id": attribution.user_id,
            "user_name": attribution.user_name,
            "feature": attribution.feature,
        }));
    if let Some(tok) = token {
        req = req.bearer_auth(tok);
    }

    match req.send().await {
        Ok(resp) if resp.status().is_success() => {
            tracing::debug!(
                backend,
                command,
                duration_ms,
                exit_code,
                "exec audit: reported to gateway"
            );
        }
        Ok(resp) => {
            tracing::warn!(
                status = %resp.status(),
                "exec audit: gateway returned non-2xx, event may be lost"
            );
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                "exec audit: gateway unreachable, event lost (best-effort)"
            );
        }
    }
}

// ── Identity-vault credential reads (#523) ───────────────────────────────────
//
// The Identity Vault's sealed store lives in Core (it decides *what runs*), but
// reading a credential is a governed action the Gateway owns (*what is
// allowed/measured*). So a credential read mirrors the exec pattern above:
//   1. `check_identity_grant`        — pre-read, fail-closed grant gate.
//   2. `report_credential_read_audit`— post-read, best-effort audit record.
// Same `RYU_ALLOW_GATEWAY_FALLBACK` opt-in to fail-open as the exec gate.

/// Outcome of a pre-read identity grant check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityGrantOutcome {
    /// The read is permitted (the gateway approved the grant).
    Allow,
    /// The read is denied (grant not approved, or gateway unreachable while
    /// fail-closed). Carries a human-readable reason.
    Deny(String),
}

/// Check with the Gateway whether reading an identity-vault credential is
/// permitted, by validating the `identity.read` grant against gateway policy
/// (`POST /v1/grants/validate`, the same endpoint the plugin lifecycle uses).
///
/// Fail-closed: a denied grant, an unparseable response, or an unreachable
/// gateway all return `Deny` unless `RYU_ALLOW_GATEWAY_FALLBACK=1` is set. This
/// keeps scope enforcement in the Gateway: Core never approves a read
/// on its own.
///
/// `scope` is the grant scope to check (e.g. `"identity.read"`); `context` is an
/// opaque attribution string (e.g. the domain) forwarded as `app_id` for the
/// gateway's logs — never a secret.
pub async fn check_identity_grant(scope: &str, context: &str) -> IdentityGrantOutcome {
    let base = gateway_url();
    let endpoint = format!("{}/v1/grants/validate", base.trim_end_matches('/'));
    let token = gateway_core_token();

    let client = gateway_http_client();
    let mut req = client
        .post(&endpoint)
        .timeout(std::time::Duration::from_secs(5))
        .json(&serde_json::json!({
            "app_id": context,
            "grants": [scope],
        }));
    if let Some(tok) = token {
        req = req.bearer_auth(tok);
    }

    match req.send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
            Ok(body) => {
                // `all_approved` is authoritative; fall back to an empty `denied`
                // list (the gateway derives one from the other).
                let approved = body
                    .get("all_approved")
                    .and_then(|v| v.as_bool())
                    .unwrap_or_else(|| {
                        body.get("denied")
                            .and_then(|v| v.as_array())
                            .map(|d| d.is_empty())
                            .unwrap_or(false)
                    });
                if approved {
                    IdentityGrantOutcome::Allow
                } else {
                    IdentityGrantOutcome::Deny(format!("grant `{scope}` denied by gateway policy"))
                }
            }
            Err(e) => {
                tracing::warn!("identity grant check: could not parse gateway response: {e}");
                if allow_fallback() {
                    IdentityGrantOutcome::Allow
                } else {
                    IdentityGrantOutcome::Deny(
                        "gateway response parse error; set RYU_ALLOW_GATEWAY_FALLBACK=1 to allow"
                            .to_owned(),
                    )
                }
            }
        },
        Ok(resp) => {
            let status = resp.status();
            tracing::warn!("identity grant check: gateway returned {status}");
            IdentityGrantOutcome::Deny(format!("gateway denied identity read: HTTP {status}"))
        }
        Err(e) => {
            tracing::warn!("identity grant check: gateway unreachable: {e}");
            if allow_fallback() {
                tracing::warn!(
                    "identity grant check: gateway unreachable but RYU_ALLOW_GATEWAY_FALLBACK=1, allowing"
                );
                IdentityGrantOutcome::Allow
            } else {
                IdentityGrantOutcome::Deny(format!(
                    "gateway unreachable ({e}); set RYU_ALLOW_GATEWAY_FALLBACK=1 to allow"
                ))
            }
        }
    }
}

/// Report a completed identity-vault credential read to the gateway audit store
/// (`POST /v1/exec/audit` with `event_type=credential_read`).
///
/// Best-effort, like [`report_exec_audit`]: the read already happened under a
/// granted scope, so a gateway blink here only logs a warning. The payload
/// carries the `source` (CredentialSource id) and `domain` for attribution —
/// **never** the decrypted credential.
pub async fn report_credential_read_audit(
    source: &str,
    domain: &str,
    session_id: Option<String>,
    error: Option<String>,
) {
    report_credential_read_audit_with_attribution(
        source,
        domain,
        session_id,
        error,
        ExecAuditAttribution::default(),
    )
    .await;
}

/// Report a credential read with the agent/user attribution available at the
/// tool-call boundary. The credential value itself is never included.
pub async fn report_credential_read_audit_with_attribution(
    source: &str,
    domain: &str,
    session_id: Option<String>,
    error: Option<String>,
    attribution: ExecAuditAttribution,
) {
    let base = gateway_url();
    let endpoint = format!("{}/v1/exec/audit", base.trim_end_matches('/'));
    let token = gateway_core_token();

    let client = gateway_http_client();
    let mut req = client
        .post(&endpoint)
        .timeout(std::time::Duration::from_secs(5))
        .json(&serde_json::json!({
            "event_type": "credential_read",
            // `backend` = the CredentialSource id, `command` = the domain. The
            // exec-only fields are inert for a credential-read row.
            "backend": source,
            "command": domain,
            "duration_ms": 0,
            "exit_code": 0,
            "session_id": session_id,
            "error": error,
            "agent_id": attribution.agent_id,
            "user_id": attribution.user_id,
            "user_name": attribution.user_name,
            "feature": attribution.feature,
        }));
    if let Some(tok) = token {
        req = req.bearer_auth(tok);
    }

    match req.send().await {
        Ok(resp) if resp.status().is_success() => {
            tracing::debug!(
                source,
                domain,
                "identity audit: credential read reported to gateway"
            );
        }
        Ok(resp) => {
            tracing::warn!(
                status = %resp.status(),
                "identity audit: gateway returned non-2xx, event may be lost"
            );
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                "identity audit: gateway unreachable, event lost (best-effort)"
            );
        }
    }
}

/// The Gateway version last seen on a successful `/health`, or `None` before the
/// first probe succeeds.
///
/// Core and the Gateway ship from ONE release train, so drift here means a stale
/// binary — most often a Gateway left in `~/.ryu/bin` after the app self-updated.
/// Detecting that needs the Gateway's *observed* version, and the readiness probe
/// is the only place Core already talks to it. Caching what that probe sees keeps
/// `/api/version` honest without adding a network round-trip to every call.
static OBSERVED_GATEWAY_VERSION: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

/// The Gateway version last observed on `/health`. `None` until a probe succeeds
/// (or if the Gateway reported no version, e.g. an older build).
pub fn observed_gateway_version() -> Option<String> {
    OBSERVED_GATEWAY_VERSION.read().ok().and_then(|g| g.clone())
}

/// GET `{base}/health`; returns true on a 2xx response.
///
/// The body — which carries `version` — used to be discarded, which is why nothing
/// in Core could ever notice a version mismatch with the Gateway it spawned. It is
/// now read and cached, but ONLY as an observation: a malformed or version-less
/// body still counts as healthy, because liveness and version agreement are
/// separate questions and conflating them would make a stale-but-working Gateway
/// look dead.
async fn verify_managed_gateway(
    base: &str,
    admin: &str,
    relay: &str,
    core_relay: &str,
) -> anyhow::Result<()> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()?;
    verify_managed_gateway_with_client(&client, base, admin, relay, core_relay).await
}

async fn verify_managed_gateway_with_client(
    client: &reqwest::Client,
    base: &str,
    admin: &str,
    relay: &str,
    core_relay: &str,
) -> anyhow::Result<()> {
    let base = base.trim_end_matches('/');
    // Prove key possession without sending any bearer to an untrusted listener.
    // Binding the signature to its real socket prevents forwarding this nonce to
    // a legitimate Gateway on a different port and then harvesting credentials.
    let nonce = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut response = client
        .get(format!("{base}/v1/auth/readiness"))
        .query(&[("nonce", &nonce)])
        .header(
            "x-ryu-readiness-proof",
            ryu_gw_credentials::readiness_request_signature(&nonce, admin)?,
        )
        .send()
        .await?;
    anyhow::ensure!(
        response.status().is_success(),
        "existing Gateway cannot prove managed readiness; restart or replace the listener"
    );
    let peer = response
        .remote_addr()
        .ok_or_else(|| anyhow::anyhow!("Gateway readiness response has no peer address"))?;
    const MAX_READINESS_BYTES: usize = 64 * 1024;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        anyhow::ensure!(
            bytes.len().saturating_add(chunk.len()) <= MAX_READINESS_BYTES,
            "Gateway readiness response exceeds the allowed size"
        );
        bytes.extend_from_slice(&chunk);
    }
    let proof: ryu_gw_credentials::ReadinessProof = serde_json::from_slice(&bytes)?;
    proof.verify(
        admin,
        &nonce,
        peer,
        env!("CARGO_PKG_VERSION"),
        relay,
        core_relay,
    )?;
    let config = client
        .get(format!("{base}/v1/config"))
        .bearer_auth(admin)
        .send()
        .await?;
    anyhow::ensure!(
        config.status().is_success(),
        "existing Gateway rejected the managed admin credential; restart it before using this node"
    );
    let config: serde_json::Value = config.json().await?;
    anyhow::ensure!(config.pointer("/auth/require_auth").and_then(|v| v.as_bool()) == Some(true), "existing Gateway has inference authentication disabled; restart it with the managed credentials");
    let anonymous = client.get(format!("{base}/v1/auth/status")).send().await?;
    anyhow::ensure!(
        anonymous.status() == reqwest::StatusCode::UNAUTHORIZED,
        "existing Gateway accepts unauthenticated inference access"
    );
    let authenticated = client
        .get(format!("{base}/v1/auth/status"))
        .bearer_auth(relay)
        .send()
        .await?;
    anyhow::ensure!(
        authenticated.status().is_success(),
        "existing Gateway rejected the managed inference credential"
    );
    let role: serde_json::Value = authenticated.json().await?;
    anyhow::ensure!(
        role["admin"] == false && role["trustedForwarder"] == false,
        "exported Gateway relay must have inference-only authority"
    );
    let trusted = client
        .get(format!("{base}/v1/auth/status"))
        .bearer_auth(core_relay)
        .send()
        .await?;
    anyhow::ensure!(
        trusted.status().is_success(),
        "existing Gateway rejected Core forwarding credential"
    );
    let role: serde_json::Value = trusted.json().await?;
    anyhow::ensure!(
        role["admin"] == false && role["trustedForwarder"] == true,
        "Core Gateway relay must have forwarding-only authority"
    );
    let relay_admin = client
        .get(format!("{base}/v1/config"))
        .bearer_auth(relay)
        .send()
        .await?;
    anyhow::ensure!(
        relay_admin.status() == reqwest::StatusCode::UNAUTHORIZED,
        "Gateway inference credential must not grant administration"
    );
    Ok(())
}

/// Process-wide client for Core to Gateway calls. The per-turn health probe and
/// the per-command firewall, budget, scan and audit calls used to build a fresh
/// client each time, which reloads the TLS config and opens a new connection
/// for every call. One shared pool keeps the Gateway connection warm. Timeouts
/// stay on each request, so callers keep their own deadlines.
pub(crate) fn gateway_http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

async fn health_check(base_url: &str) -> bool {
    let endpoint = format!("{}/health", base_url.trim_end_matches('/'));
    let client = gateway_http_client();
    let Ok(resp) = client
        .get(&endpoint)
        .timeout(Duration::from_millis(500))
        .send()
        .await
    else {
        return false;
    };
    if !resp.status().is_success() {
        return false;
    }
    if let Ok(body) = resp.json::<serde_json::Value>().await {
        if let Some(v) = body.get("version").and_then(|v| v.as_str()) {
            if let Ok(mut slot) = OBSERVED_GATEWAY_VERSION.write() {
                *slot = Some(v.to_string());
            }
        }
    }
    true
}

/// Shared, poison-tolerant lock serializing EVERY test — in ANY module — that
/// mutates the process-global gateway env vars (`RYU_GATEWAY_URL`,
/// `RYU_ALLOW_GATEWAY_FALLBACK`, and the scan gate's `RYU_EXEC_APPROVAL_MODE`),
/// or that mutates ACP gateway-injection env (`RYU_ACP_GATEWAY_INJECT`) whose
/// spawn commands read `gateway_url()`. cargo runs all tests in one process in
/// parallel, so these globals are only race-free when every toucher holds the
/// *same* lock. This module owns the env constants, so the canonical lock lives
/// here; identity/tool_exec/acp/codex_config/delegate/delegation all grab it.
#[cfg(test)]
pub(crate) static GATEWAY_ENV_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Acquire [`GATEWAY_ENV_TEST_LOCK`], recovering a poisoned guard so one
/// panicking test never cascade-fails the rest.
#[cfg(test)]
pub(crate) fn lock_gateway_env() -> std::sync::MutexGuard<'static, ()> {
    GATEWAY_ENV_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Shared, poison-tolerant lock serializing EVERY test — in ANY module — that
/// touches the managed-node gate (`RYU_MANAGED_NODE`) or the process-global
/// provider-auth key caches (`openrouter_auth` / `composio_auth`, plus their
/// `RYU_*_API_KEY` env vars). These globals are entangled (the managed-node
/// zero-setup test reads both), so a single lock guards them all.
#[cfg(test)]
pub(crate) static MANAGED_NODE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Acquire [`MANAGED_NODE_TEST_LOCK`], recovering a poisoned guard.
///
/// A test that needs both locks takes this one first, then
/// [`lock_gateway_env`]; the opposite order deadlocks under the parallel test
/// harness.
#[cfg(test)]
pub(crate) fn lock_managed_node_env() -> std::sync::MutexGuard<'static, ()> {
    MANAGED_NODE_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

// ── Side-model call attribution ──────────────────────────────────────────────
//
// Core makes many one-shot "side" completions next to the main chat turn (the
// `/btw` aside, the advisor, compaction, titles, suggestions, the learning
// judge, plugin `host.sideModel`, …). Without a tag every one of them landed in
// the Gateway's audit log looking like an ordinary chat turn, so their spend
// could not be told apart. Each such request now carries `x-ryu-purpose`: a
// bounded identifier the Gateway stores verbatim (and stores as NULL when it is
// malformed). The names are a closed set shared with the Gateway; plugins get a
// `plugin:<id>` value so one noisy plugin is visible on its own.

/// Header naming what a Core side-model call is for.
pub const PURPOSE_HEADER: &str = "x-ryu-purpose";
/// Local-engine admission priority the Gateway already honors
/// (`concurrency::Priority::from_header`).
pub const PRIORITY_HEADER: &str = "x-ryu-priority";
/// Upper bound on an `x-ryu-purpose` value, shared with the Gateway's parser.
pub const MAX_PURPOSE_LEN: usize = 64;

/// What a Core side-model call is for. The named variants are the closed set
/// the Gateway understands; [`SidePurpose::Plugin`] carries the calling
/// plugin's id and renders as `plugin:<id>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidePurpose {
    Btw,
    Advisor,
    Compaction,
    Handoff,
    AutoTitle,
    ChatSuggestions,
    ComposerPrediction,
    Predict,
    MemoryDream,
    Recommendations,
    LearningJudge,
    AgentAutoRoute,
    WorkflowPrompt,
    Delegate,
    AppModelStream,
    RetrievalExpansion,
    Plugin(String),
}

impl SidePurpose {
    /// The purpose name. A plugin call is just `plugin` here; its full header
    /// value (with the id) comes from [`SidePurpose::header_value`].
    pub fn as_str(&self) -> &str {
        match self {
            Self::Btw => "btw",
            Self::Advisor => "advisor",
            Self::Compaction => "compaction",
            Self::Handoff => "handoff",
            Self::AutoTitle => "auto_title",
            Self::ChatSuggestions => "chat_suggestions",
            Self::ComposerPrediction => "composer_prediction",
            Self::Predict => "predict",
            Self::MemoryDream => "memory_dream",
            Self::Recommendations => "recommendations",
            Self::LearningJudge => "learning_judge",
            Self::AgentAutoRoute => "agent_auto_route",
            Self::WorkflowPrompt => "workflow_prompt",
            Self::Delegate => "delegate",
            Self::AppModelStream => "app_model_stream",
            Self::RetrievalExpansion => "retrieval_expansion",
            Self::Plugin(_) => "plugin",
        }
    }

    /// The `x-ryu-purpose` value, or `None` when it would not be a valid
    /// identifier. A plugin id is lowercased, every character outside the
    /// header charset becomes `-`, and the whole value is cut to
    /// [`MAX_PURPOSE_LEN`]; an id that sanitizes to nothing sends no header.
    pub fn header_value(&self) -> Option<String> {
        let value = match self {
            Self::Plugin(id) => {
                let id: String = id
                    .trim()
                    .chars()
                    .map(|c| {
                        let c = c.to_ascii_lowercase();
                        if is_purpose_char(c) {
                            c
                        } else {
                            '-'
                        }
                    })
                    .collect();
                let id = id.trim_matches('-');
                if id.is_empty() {
                    return None;
                }
                let mut value = format!("plugin:{id}");
                // Every char is ASCII after sanitizing, so a byte cut is safe.
                value.truncate(MAX_PURPOSE_LEN);
                value
            }
            named => named.as_str().to_owned(),
        };
        is_valid_purpose(&value).then_some(value)
    }

    /// Whether the Gateway may queue this call behind interactive turns on a
    /// busy local engine. This keeps the priority these calls already sent
    /// (titles, suggestions, predictions, the routing classifier) and adds the
    /// periodic jobs nobody waits on. Calls a user is watching for (`/btw`, the
    /// advisor, compaction and handoff inside a turn, workflows, delegation,
    /// app streams, plugin calls of unknown shape) stay interactive.
    pub fn is_background(&self) -> bool {
        matches!(
            self,
            Self::AutoTitle
                | Self::ChatSuggestions
                | Self::ComposerPrediction
                | Self::AgentAutoRoute
                | Self::MemoryDream
                | Self::Recommendations
                | Self::LearningJudge
        )
    }
}

fn is_purpose_char(c: char) -> bool {
    matches!(c, 'a'..='z' | '0'..='9' | '_' | ':' | '.' | '@' | '/' | '-')
}

/// The shared `x-ryu-purpose` grammar: 1..=64 chars from `[a-z0-9_:.@/-]`.
pub fn is_valid_purpose(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_PURPOSE_LEN && value.chars().all(is_purpose_char)
}

/// The attribution headers for one Gateway side-model request: the purpose and
/// `background` priority for calls nobody is waiting on. `x-ryu-feature` is
/// deliberately absent: it names the product surface for usage points, and a
/// side call must not be counted as a chat or agent turn.
///
/// `x-ryu-session-id` is deliberately absent too, even when the call belongs to
/// a chat. The Gateway keys per-session routing state on it (the smart
/// router's decision cache and escalation streaks, the session budget, and
/// provider cache affinity), so a small title or suggestions prompt carrying
/// the chat's id would reset the chat's escalation streak, inherit or seed the
/// chat's cached model, and pin the routing classifier's choice for the whole
/// conversation.
pub fn side_call_headers(purpose: &SidePurpose) -> Vec<(&'static str, String)> {
    let mut headers = Vec::with_capacity(2);
    if let Some(value) = purpose.header_value() {
        headers.push((PURPOSE_HEADER, value));
    }
    if purpose.is_background() {
        headers.push((PRIORITY_HEADER, "background".to_owned()));
    }
    headers
}

/// Stamp [`side_call_headers`] onto a Gateway request.
pub fn with_side_call_headers(
    mut request: reqwest::RequestBuilder,
    purpose: &SidePurpose,
) -> reqwest::RequestBuilder {
    for (name, value) in side_call_headers(purpose) {
        request = request.header(name, value);
    }
    request
}

/// Token counts reported for one side-model completion. A field is `None`
/// when the provider did not report it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SideUsage {
    pub prompt: Option<u64>,
    pub completion: Option<u64>,
    pub cache_read: Option<u64>,
    pub cache_write: Option<u64>,
}

/// Read token usage from a non-streaming completion body. Accepts the whole
/// response (`usage` plus llama.cpp's `timings`) or a bare usage object, and
/// covers the OpenAI (`prompt_tokens`, `prompt_tokens_details.cached_tokens`),
/// Anthropic (`input_tokens`, `cache_read_input_tokens`,
/// `cache_creation_input_tokens`) and llama.cpp (`timings.prompt_n`,
/// `predicted_n`, `cache_n`) shapes. The key order mirrors the chat stream's
/// stats builder in `sidecar::adapters`, so both report the same numbers.
pub fn parse_side_usage(body: &serde_json::Value) -> SideUsage {
    use serde_json::Value;
    let usage = body.get("usage").unwrap_or(body);
    let timings = body.get("timings");
    let top = |key: &str| usage.get(key).and_then(Value::as_u64);
    let nested = |outer: &str, inner: &str| {
        usage
            .get(outer)
            .and_then(|d| d.get(inner))
            .and_then(Value::as_u64)
    };
    let timing = |key: &str| {
        timings
            .and_then(|t| t.get(key))
            .and_then(Value::as_f64)
            .map(|n| n as u64)
    };
    // llama.cpp counts prompt tokens reused from its KV cache as `cache_n`;
    // `prompt_n` is only the part it had to evaluate.
    let llama_cache = timing("cache_n");
    SideUsage {
        prompt: timing("prompt_n")
            .map(|n| n + llama_cache.unwrap_or(0))
            .or_else(|| top("prompt_tokens"))
            .or_else(|| top("input_tokens")),
        completion: timing("predicted_n")
            .or_else(|| top("completion_tokens"))
            .or_else(|| top("output_tokens")),
        cache_read: nested("prompt_tokens_details", "cached_tokens")
            .or_else(|| nested("input_tokens_details", "cached_tokens"))
            .or_else(|| top("cached_tokens"))
            .or_else(|| top("cache_read_input_tokens"))
            .or(llama_cache),
        cache_write: nested("prompt_tokens_details", "cache_write_tokens")
            .or_else(|| nested("prompt_tokens_details", "cache_creation_input_tokens"))
            .or_else(|| nested("input_tokens_details", "cache_write_tokens"))
            .or_else(|| top("cache_write_tokens"))
            .or_else(|| top("cache_creation_input_tokens")),
    }
}

/// Log a side call's token usage at debug level. The Gateway's audit row is
/// the durable record (keyed by `x-ryu-purpose`); this is the Core-side trace
/// for correlating it. Counts and the purpose only, never content.
pub fn log_side_usage(purpose: &SidePurpose, model: &str, body: &serde_json::Value) {
    let usage = parse_side_usage(body);
    tracing::debug!(
        purpose = purpose
            .header_value()
            .as_deref()
            .unwrap_or(purpose.as_str()),
        model,
        prompt_tokens = usage.prompt,
        completion_tokens = usage.completion,
        cache_read_tokens = usage.cache_read,
        cache_write_tokens = usage.cache_write,
        "side-model usage"
    );
}

#[cfg(test)]
mod side_call_tests {
    use super::*;
    use serde_json::json;

    const NAMED: [(SidePurpose, &str); 16] = [
        (SidePurpose::Btw, "btw"),
        (SidePurpose::Advisor, "advisor"),
        (SidePurpose::Compaction, "compaction"),
        (SidePurpose::Handoff, "handoff"),
        (SidePurpose::AutoTitle, "auto_title"),
        (SidePurpose::ChatSuggestions, "chat_suggestions"),
        (SidePurpose::ComposerPrediction, "composer_prediction"),
        (SidePurpose::Predict, "predict"),
        (SidePurpose::MemoryDream, "memory_dream"),
        (SidePurpose::Recommendations, "recommendations"),
        (SidePurpose::LearningJudge, "learning_judge"),
        (SidePurpose::AgentAutoRoute, "agent_auto_route"),
        (SidePurpose::WorkflowPrompt, "workflow_prompt"),
        (SidePurpose::Delegate, "delegate"),
        (SidePurpose::AppModelStream, "app_model_stream"),
        (SidePurpose::RetrievalExpansion, "retrieval_expansion"),
    ];

    fn header<'a>(headers: &'a [(&'static str, String)], name: &str) -> Option<&'a str> {
        headers
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.as_str())
    }

    #[test]
    fn every_named_purpose_sends_its_snake_case_name() {
        for (purpose, name) in NAMED {
            assert_eq!(purpose.as_str(), name);
            assert!(
                is_valid_purpose(name),
                "{name} must satisfy the shared grammar"
            );
            let headers = side_call_headers(&purpose);
            assert_eq!(header(&headers, PURPOSE_HEADER), Some(name));
            assert_eq!(
                header(&headers, PRIORITY_HEADER),
                purpose.is_background().then_some("background"),
                "{name} priority"
            );
            assert!(header(&headers, "x-ryu-feature").is_none());
        }
    }

    #[test]
    fn background_is_limited_to_calls_nobody_waits_on() {
        assert!(SidePurpose::AutoTitle.is_background());
        assert!(SidePurpose::MemoryDream.is_background());
        assert!(!SidePurpose::Btw.is_background());
        assert!(!SidePurpose::Compaction.is_background());
        assert!(!SidePurpose::Plugin("@ryu/browser".into()).is_background());
    }

    #[test]
    fn side_calls_never_carry_the_session_header() {
        // The Gateway keys smart-router and budget state on `x-ryu-session-id`;
        // a side call must not touch the chat's routing state.
        let plugin = SidePurpose::Plugin("@ryu/browser".into());
        for (purpose, _) in NAMED.into_iter().chain([(plugin, "plugin")]) {
            let headers = side_call_headers(&purpose);
            assert!(header(&headers, "x-ryu-session-id").is_none());
        }
    }

    #[test]
    fn plugin_ids_are_sanitized_truncated_or_dropped() {
        let value = |id: &str| SidePurpose::Plugin(id.to_owned()).header_value();
        assert_eq!(
            value("@ryu/browser").as_deref(),
            Some("plugin:@ryu/browser")
        );
        assert_eq!(
            value("  My Plugin!v2 ").as_deref(),
            Some("plugin:my-plugin-v2")
        );
        assert_eq!(value("Ünïcode").as_deref(), Some("plugin:n-code"));

        let long = value(&"a".repeat(200)).expect("long id still renders");
        assert_eq!(long.len(), MAX_PURPOSE_LEN);
        assert!(long.starts_with("plugin:aaa"));
        assert!(is_valid_purpose(&long));

        for id in ["", "   ", "!!!", "\u{1F600}"] {
            assert_eq!(value(id), None, "{id:?}");
            let headers = side_call_headers(&SidePurpose::Plugin(id.to_owned()));
            assert!(header(&headers, PURPOSE_HEADER).is_none());
        }
    }

    #[test]
    fn purpose_grammar_rejects_out_of_charset_and_overlong_values() {
        assert!(!is_valid_purpose(""));
        assert!(!is_valid_purpose("Auto_Title"));
        assert!(!is_valid_purpose("a b"));
        assert!(!is_valid_purpose(&"a".repeat(MAX_PURPOSE_LEN + 1)));
        assert!(is_valid_purpose(&"a".repeat(MAX_PURPOSE_LEN)));
    }

    #[test]
    fn parses_openai_usage() {
        let body = json!({
            "choices": [],
            "usage": {
                "prompt_tokens": 120,
                "completion_tokens": 30,
                "prompt_tokens_details": { "cached_tokens": 100, "cache_write_tokens": 20 }
            }
        });
        assert_eq!(
            parse_side_usage(&body),
            SideUsage {
                prompt: Some(120),
                completion: Some(30),
                cache_read: Some(100),
                cache_write: Some(20),
            }
        );
    }

    #[test]
    fn parses_anthropic_usage() {
        let usage = json!({
            "input_tokens": 50,
            "output_tokens": 12,
            "cache_read_input_tokens": 40,
            "cache_creation_input_tokens": 8
        });
        let expected = SideUsage {
            prompt: Some(50),
            completion: Some(12),
            cache_read: Some(40),
            cache_write: Some(8),
        };
        assert_eq!(
            parse_side_usage(&json!({ "usage": usage.clone() })),
            expected
        );
        assert_eq!(parse_side_usage(&usage), expected);
    }

    #[test]
    fn parses_llama_timings_over_usage() {
        let body = json!({
            "usage": { "prompt_tokens": 1, "completion_tokens": 1 },
            "timings": { "prompt_n": 10.0, "predicted_n": 7.0, "cache_n": 90.0 }
        });
        assert_eq!(
            parse_side_usage(&body),
            SideUsage {
                prompt: Some(100),
                completion: Some(7),
                cache_read: Some(90),
                cache_write: None,
            }
        );
    }

    #[test]
    fn missing_usage_is_all_none() {
        assert_eq!(
            parse_side_usage(&json!({ "choices": [] })),
            SideUsage::default()
        );
    }
}

#[cfg(test)]
mod provider_apply_transport_tests {
    use super::*;
    use axum::{http::HeaderMap, routing::post, Json, Router};
    use ryu_gw_credentials::{ProviderApplyErrorCode as Code, ProviderApplyOutcome as Outcome};

    fn revision() -> ryu_gw_credentials::ConfigRevision {
        ryu_gw_credentials::ConfigRevision::parse(&"a".repeat(64)).unwrap()
    }

    #[tokio::test]
    async fn private_transport_sends_only_revision_and_binds_auth_and_receipt() {
        let revision = revision();
        let receipt = Outcome::Applied {
            requested_revision: revision.clone(),
            applied_revision: revision.clone(),
            epoch: ryu_gw_credentials::ProviderRuntimeEpoch {
                boot: uuid::Uuid::new_v4(),
                sequence: 2,
            },
        };
        let expected = receipt.clone();
        let app = Router::new().route(
            "/v1/config/providers/apply",
            post(
                move |headers: HeaderMap, Json(body): Json<serde_json::Value>| {
                    let receipt = receipt.clone();
                    async move {
                        assert_eq!(headers["authorization"], "Bearer apply-admin-test");
                        assert_eq!(body.as_object().unwrap().len(), 1);
                        assert_eq!(body["revision"], receipt.requested_revision().as_str());
                        Json(receipt)
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        assert_eq!(
            send_provider_revision(&base, "apply-admin-test", &revision).await,
            expected
        );
        assert!(matches!(
            send_provider_revision(
                &base.replace("127.0.0.1", "localhost"),
                "apply-admin-test",
                &revision
            )
            .await,
            Outcome::Applied { .. }
        ));
        server.abort();
    }

    #[tokio::test]
    async fn mismatched_or_oversized_receipts_fail_without_echoing_material() {
        let revision = revision();
        let bad = serde_json::json!({"status":"applied","requestedRevision":revision,"appliedRevision":"b".repeat(64),"epoch":{"boot":uuid::Uuid::new_v4(),"sequence":1}});
        let app = Router::new().route(
            "/v1/config/providers/apply",
            post(move || {
                let bad = bad.clone();
                async move { Json(bad) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        assert!(matches!(
            send_provider_revision(&base, "apply-admin-test", &revision).await,
            Outcome::Failed {
                code: Code::UnexpectedResponse,
                ..
            }
        ));
        server.abort();
        let app = Router::new().route(
            "/v1/config/providers/apply",
            post(|| async { "private-material".repeat(2048) }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let outcome = send_provider_revision(&base, "apply-admin-test", &revision).await;
        assert!(matches!(
            outcome,
            Outcome::Failed {
                code: Code::UnexpectedResponse,
                ..
            }
        ));
        assert!(!serde_json::to_string(&outcome)
            .unwrap()
            .contains("private-material"));
        server.abort();
    }

    #[tokio::test]
    async fn transport_refuses_remote_destination_and_redirect_replay() {
        let revision = revision();
        assert!(matches!(
            send_provider_revision("https://example.invalid", "apply-admin-test", &revision).await,
            Outcome::Failed {
                code: Code::Transport,
                ..
            }
        ));
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let sink = Router::new().route(
            "/sink",
            post({
                let calls = calls.clone();
                move || {
                    calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    async { "unexpected" }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let destination = format!("http://{}/sink", listener.local_addr().unwrap());
        let sink_server = tokio::spawn(async move {
            axum::serve(listener, sink).await.unwrap();
        });
        let app = Router::new().route(
            "/v1/config/providers/apply",
            post(move || {
                let destination = destination.clone();
                async move {
                    (
                        axum::http::StatusCode::TEMPORARY_REDIRECT,
                        [(axum::http::header::LOCATION, destination)],
                        "redirect",
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let source_server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        assert!(matches!(
            send_provider_revision(&base, "apply-admin-test", &revision).await,
            Outcome::Failed {
                code: Code::UnexpectedResponse,
                ..
            }
        ));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        source_server.abort();
        sink_server.abort();
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod managed_readiness_tests;
