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

use std::time::Duration;

use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::sidecar::active_engine::{local_engine_url, ActiveEngineStore};
use crate::sidecar::process::ProcessHandle;
// The classify sidecar's registered name, imported (not re-spelled) so the lazy-start
// call below can never target a name the sidecar does not answer to. See
// [`CLASSIFY_SIDECAR_NAME`]'s doc for why the literal is banned.
use crate::sidecar::providers::llamacpp::classify::CLASSIFY_SIDECAR_NAME;

/// Default address the local gateway binds to and Core forwards chat to.
/// Matches `apps/gateway` default bind (`0.0.0.0:7981`) on the loopback host.
pub const DEFAULT_GATEWAY_URL: &str = "http://127.0.0.1:7981";

/// Env var pointing Core at the gateway base URL (no trailing `/v1`).
const ENV_GATEWAY_URL: &str = "RYU_GATEWAY_URL";
/// Env var with a bearer token for the gateway, when it runs with auth enabled.
const ENV_GATEWAY_TOKEN: &str = "RYU_GATEWAY_TOKEN";
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
/// The two that had nowhere to go are the node's preferred FALLBACK ORDER and its
/// own EXTRA firewall rules — this is their carrier.
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
/// cannot loosen one). Both empty ⇒ the header is omitted entirely.
pub fn set_node_routing_prefs(fallback: Vec<String>, firewall: Option<serde_json::Value>) {
    use base64::Engine as _;

    let fallback: Vec<String> = fallback
        .into_iter()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect();
    let encoded = if fallback.is_empty() && firewall.is_none() {
        None
    } else {
        let mut doc = serde_json::Map::new();
        if !fallback.is_empty() {
            doc.insert("fallback".to_owned(), serde_json::json!(fallback));
        }
        if let Some(fw) = firewall {
            doc.insert("firewall".to_owned(), fw);
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
/// set of KV keys: fallback order and the additive firewall overlay must update
/// atomically. Unknown fields are ignored for forward compatibility, while a
/// malformed value clears the old carrier so an invalid edit cannot continue to
/// affect requests.
pub fn set_node_routing_prefs_from_json(raw: &str) {
    #[derive(Default, serde::Deserialize)]
    #[serde(default)]
    struct NodeRoutingPreference {
        fallback: Vec<String>,
        firewall: Option<serde_json::Value>,
    }

    let Ok(value) = serde_json::from_str::<NodeRoutingPreference>(raw) else {
        set_node_routing_prefs(Vec::new(), None);
        return;
    };

    let firewall = value.firewall.filter(|value| !value.is_null());
    set_node_routing_prefs(value.fallback, firewall);
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

/// Base URL Core forwards chat completions to. Always non-empty.
///
/// Profile-aware default: release ⇒ `http://127.0.0.1:7981`, dev ⇒ `:8981`, ….
/// (Under a non-release profile `profile::apply_env_defaults` also seeds
/// `RYU_GATEWAY_URL`, so the env branch normally wins; the default is computed via
/// the same `profile::port(7981)` so both agree.)
pub fn gateway_url() -> String {
    std::env::var(ENV_GATEWAY_URL)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("http://127.0.0.1:{}", crate::profile::port(7981)))
}

/// Optional bearer token Core presents to the gateway (only when the gateway
/// runs with `require_auth`). This is the gateway token slot — never a provider
/// API key.
pub fn gateway_relay_token() -> Option<String> {
    std::env::var(ENV_GATEWAY_TOKEN)
        .ok()
        .filter(|s| !s.is_empty())
}

/// Compatibility name used by the local-gateway call sites. On a managed
/// remote data plane this resolves only the relay credential; node-control
/// traffic reads `control_plane::gateway_key()` instead.
pub fn gateway_token() -> Option<String> {
    gateway_relay_token()
}

/// Resolve the bearer Core presents to the gateway, fail-closed on a remote data
/// plane (WS1).
///
/// On the normal local path a missing [`gateway_token`] falls back to the local
/// gateway's `"ryu-local"` dev bearer (the local gateway accepts it). In
/// [`remote_data_plane`] mode Core talks to a hosted, multi-tenant gateway fleet
/// that MUST reject the shared `"ryu-local"` literal, so a missing token is a hard
/// error instead of silently presenting a bearer the fleet would 401 — the caller
/// fails closed with a clear reason rather than emitting the shared literal.
pub fn gateway_bearer() -> anyhow::Result<String> {
    if let Some(token) = gateway_relay_token() {
        return Ok(token);
    }
    if remote_data_plane() {
        anyhow::bail!(
            "remote data plane requires RYU_GATEWAY_TOKEN; refusing to present the shared \"ryu-local\" bearer to a hosted multi-tenant gateway"
        );
    }
    Ok("ryu-local".to_owned())
}

/// Mint the proof carried by an agent-scoped Gateway URL.
///
/// A managed `rgw_` bearer is intentionally not treated as a trusted-forwarder
/// key by the Gateway: callers holding it can reach the fleet, but they must not
/// be able to rotate `x-ryu-agent-id` and move spend between agents. Core is the
/// holder of the bearer and therefore signs the concrete agent route with it.
/// The fleet verifies the same HMAC before accepting the agent identity.
pub fn gateway_agent_proof(agent_id: &str) -> anyhow::Result<String> {
    type AgentRouteMac = Hmac<Sha256>;

    let token = gateway_bearer()?;
    let mut mac = AgentRouteMac::new_from_slice(token.as_bytes())
        .map_err(|_| anyhow::anyhow!("gateway bearer cannot sign agent route"))?;
    mac.update(b"ryu-agent-route-v1\0");
    mac.update(agent_id.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
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
) -> anyhow::Result<()> {
    if tool_calls == 0 {
        return Ok(());
    }
    let token = if remote_data_plane() {
        gateway_relay_token()
    } else {
        gateway_admin_key()
    }
    .ok_or_else(|| anyhow::anyhow!("gateway tool-charge credential is unavailable"))?;
    let agent_proof = agent_id.and_then(|id| gateway_agent_proof(id).ok());
    let url = format!("{}/v1/budget/charge", gateway_url().trim_end_matches('/'));
    let body = serde_json::json!({
        "tool_calls": tool_calls,
        "agent_id": agent_id,
        "agent_proof": agent_proof,
        "user_id": user_id,
        "session_id": session_id,
        "request_id": format!("acp-tool:{}", uuid::Uuid::new_v4()),
    });
    let response = client
        .post(url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await?;
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
    let token = if remote_data_plane() {
        gateway_relay_token()
    } else {
        gateway_admin_key()
    }
    .ok_or_else(|| anyhow::anyhow!("gateway tool-charge credential is unavailable"))?;
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
    });
    let response = client
        .post(url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await?;
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let detail = response.text().await.unwrap_or_default();
    anyhow::bail!("gateway external tool charge returned {status}: {detail}");
}

/// Ask the managed Gateway whether a provider is configured. Provider credentials
/// stay in Gateway's runtime/vault; Core only carries the authenticated app request.
pub async fn managed_provider_status(
    client: &reqwest::Client,
    provider: &str,
) -> Result<bool, ryu_app_events::ProviderRouterError> {
    let token = if remote_data_plane() {
        gateway_relay_token()
    } else {
        gateway_admin_key()
    }
    .ok_or(ryu_app_events::ProviderRouterError::NotHosted)?;
    let url = format!(
        "{}/v1/providers/status",
        gateway_url().trim_end_matches('/')
    );
    let response = client
        .post(url)
        .bearer_auth(token)
        .json(&serde_json::json!({ "provider": provider }))
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

/// Forward one provider-neutral app operation to Gateway. Gateway injects the
/// provider credential, executes the call, and schedules the org-wallet debit.
pub async fn call_managed_provider(
    client: &reqwest::Client,
    org_id: Option<&str>,
    call: ryu_app_events::ManagedProviderCall,
) -> Result<serde_json::Value, ryu_app_events::ProviderRouterError> {
    let token = if remote_data_plane() {
        gateway_relay_token()
    } else {
        gateway_admin_key()
    }
    .ok_or(ryu_app_events::ProviderRouterError::NotHosted)?;
    let url = format!("{}/v1/providers/call", gateway_url().trim_end_matches('/'));
    let mut body = serde_json::to_value(call).map_err(|error| {
        ryu_app_events::ProviderRouterError::Invalid(format!(
            "managed provider call could not be serialized: {error}"
        ))
    })?;
    if let Some(org_id) = org_id.filter(|value| !value.trim().is_empty()) {
        body["orgId"] = serde_json::Value::String(org_id.to_owned());
    }
    let response = client
        .post(url)
        .bearer_auth(token)
        .json(&body)
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

/// Env var carrying the admin credential to the spawned gateway. Sets the
/// gateway's `auth.master_key` WITHOUT flipping `require_auth` — see the block
/// that reads it in `apps/gateway/src/config.rs`.
const ENV_GATEWAY_ADMIN_KEY: &str = "GATEWAY_ADMIN_KEY";

/// The file the minted gateway admin key is persisted to, so the key survives a
/// Core restart and a gateway respawn.
fn gateway_admin_key_path() -> std::path::PathBuf {
    crate::paths::ryu_dir().join("gateway-admin.key")
}

/// The admin credential Core presents on the gateway's ADMIN surface
/// (`/v1/config`, audit, budget/spend).
///
/// Why this exists at all: the gateway grants its admin surface to loopback
/// callers only while loopback is trustworthy, and `admin_loopback_allowed`
/// revokes that trust as soon as the MESH is on — a userspace mesh peer arrives
/// as `127.0.0.1`, so keeping loopback trust would fail OPEN to the tailnet. The
/// gate is right; the casualty was Core, which had no credential to fall back on.
/// Every gateway settings tab (budgets, safety filters, cost tiers, account keys)
/// answered `/api/gateway/config failed: 401` the moment the user enabled the
/// mesh, and no bearer Core could invent would pass: `require_local_admin` only
/// bypasses for a bearer equal to the real master key, so the shared
/// `"ryu-local"` literal was never going to work.
///
/// NOT `gateway_bearer`, deliberately. That one is also handed to the plugin
/// sandbox (`sandbox_host.rs`), and routing the admin key through it would give
/// every sandboxed plugin the gateway's admin surface. This accessor is Core-only.
///
/// Precedence mirrors `node_token`: an operator's own key wins, then the key this
/// machine minted earlier, then a fresh mint. Returns `None` only when no key
/// could be established AND none could be persisted (an unwritable home) — which
/// is not fatal, it just leaves the admin surface on its previous loopback-trust
/// behaviour rather than refusing to boot.
pub fn gateway_admin_key() -> Option<String> {
    static ADMIN_KEY: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    ADMIN_KEY
        .get_or_init(|| {
            // 0. On a remote data plane Core talks to a hosted fleet it did not
            //    spawn. Relay credentials may call inference and the narrowly
            //    proof-bound tool-charge endpoint, but they are never admin keys.
            if remote_data_plane() {
                return None;
            }

            // 1. Operator-provisioned. A real master key outranks a minted admin
            //    key, and the gateway applies the same precedence on its side.
            for var in [ENV_GATEWAY_ADMIN_KEY, "GATEWAY_MASTER_KEY"] {
                if let Ok(key) = std::env::var(var) {
                    let trimmed = key.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.to_owned());
                    }
                }
            }

            let path = gateway_admin_key_path();

            // 2. Minted earlier on this machine.
            if let Ok(existing) = std::fs::read_to_string(&path) {
                let trimmed = existing.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_owned());
                }
            }

            // 3. Mint one. Same shape as the node auth token: a random opaque
            //    secret, never derived from anything guessable.
            let key = format!("gwadm_{}", uuid::Uuid::new_v4().simple());
            match write_admin_key_file(&path, &key) {
                Ok(()) => {
                    tracing::info!(path = %path.display(), "gateway: minted admin key");
                    Some(key)
                }
                Err(e) => {
                    tracing::warn!(
                        path = %path.display(),
                        "gateway: could not persist admin key ({e}); admin surface stays on loopback trust"
                    );
                    None
                }
            }
        })
        .clone()
}

/// Write the admin key `0600` (owner-only). A world-readable admin credential
/// beside the data dir would be worse than the loopback trust it replaces.
fn write_admin_key_file(path: &std::path::Path, key: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, key)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
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

    let client = reqwest::Client::new();
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
///      persists its resolved resident engine now, but the gateway spawns
///      concurrently with `start_all`, so this closes the first-boot race too.
///
/// Returns `None` when none apply, in which case the gateway falls back to
/// its own built-in default (Ollama on `11434`).
pub fn local_engine_gateway_url() -> Option<String> {
    if let Ok(url) = std::env::var(ENV_LOCAL_LLM_URL) {
        if !url.is_empty() {
            return Some(url);
        }
    }
    if let Some(active) = ActiveEngineStore::load().active {
        return local_engine_url(&active);
    }
    let versions = crate::sidecar::download_manager::VersionStore::load();
    if versions.installed_version("llamacpp").is_some() {
        return local_engine_url("llamacpp");
    }
    None
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
/// (`apps/gateway/src/pipeline/mod.rs`'s `flag_inline_binding`) settles what the
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
            // `warn`, not `debug`, and recorded — not because `debug` is filtered
            // (Core's default `EnvFilter` is `ryu_core=debug,info`, so it does print)
            // but because a `debug!` line is indistinguishable from the whole
            // `ryu_core=debug` firehose, disappears under any operator `RUST_LOG=info`,
            // and leaves NO queryable record. This is the one failure class the
            // desktop's classify-tier badge cannot derive: it crosses
            // `/api/sidecar/status` with a weights probe, which covers exactly one
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
        gateway_token().as_deref(),
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
/// Targets [`gateway_url`] and forwards [`gateway_token`] (the master key), so it
/// works against a remote gateway exactly like the PUT. Errs on a transport failure
/// or a non-2xx status.
pub(crate) async fn fetch_config(client: &reqwest::Client) -> anyhow::Result<serde_json::Value> {
    let base = gateway_url();
    let resp = gateway_config_get_request(client, &base, gateway_token().as_deref())
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
    // Ryu-owned analytics is a typed relay, not the customer's OTLP exporter.
    // Managed local Gateways receive only the relay URL/key and the explicit
    // product-analytics gate; no Ryu Axiom credential is ever forwarded.
    env.extend(crate::ryu_analytics::gateway_child_env());
    // The admin credential for THIS gateway. Sets `auth.master_key` on the child
    // without turning on `require_auth`, so the admin surface starts demanding a
    // key while every ordinary call Core and its sidecars make (chat, media,
    // titles, widgets, …) keeps working unauthenticated exactly as before. See
    // `gateway_admin_key` for why loopback trust alone stopped being enough.
    if let Some(key) = gateway_admin_key() {
        env.push((ENV_GATEWAY_ADMIN_KEY.to_owned(), key));
    }
    if let Some(url) = local_engine_gateway_url() {
        tracing::info!(local_llm_url = %url, "gateway: registering active local engine as provider");
        env.push((ENV_LOCAL_LLM_URL.to_owned(), url));
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
    // local gateway in remote mode, so this env is not built there anyway.)
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
        if let Some(headers) = crate::telemetry::otlp_headers_env() {
            env.push((crate::telemetry::OTLP_HEADERS_ENV.to_owned(), headers));
        }
    } else {
        // Consent OFF (or no endpoint): push an EXPLICIT "0" rather than relying on
        // absence. The gateway child inherits Core's process env, so an operator-set
        // `OTEL_EXPORTER_OTLP_ENDPOINT` + `RYU_DIAGNOSTICS_EXPORT_ENABLED=1` would
        // otherwise leak through and the gateway would export while Core does not.
        // Forcing "0" neutralizes any inherited endpoint (the gateway's `should_export`
        // requires enabled=true), so "off → nothing sent" holds end-to-end. Mirrors
        // the crash tier, which pushes an explicit "0" for the same reason.
        env.push(("RYU_DIAGNOSTICS_EXPORT_ENABLED".to_owned(), "0".to_owned()));
    }
    env
}

/// Resolve and inject the local provider-credential env (Composio / OpenRouter /
/// Replicate / Fal) onto the gateway spawn env. Only called on a LOCAL data plane
/// (see [`gateway_spawn_env`]) — on a remote data plane the keys live only in the
/// hosted fleet and this is never called, so no local key pref is even resolved.
fn push_provider_key_env(env: &mut Vec<(String, String)>) {
    // Composio (#456 deep integration): inject the user's Composio API key so the
    // gateway's tool loop is enabled — key presence alone flips
    // `ComposioConfig.enabled` (apps/gateway/src/config.rs). Resolved from the
    // in-process resolver (preferences-first, env fallback); this spawn path is
    // sync, so it must not touch the async PreferencesStore. On a key change the
    // preferences handler calls `GatewayManager::refresh()` to respawn with the
    // new value.
    if let Some(key) = crate::composio_auth::key() {
        tracing::info!("gateway: Composio key present, enabling tool loop");
        env.push(("COMPOSIO_API_KEY".to_owned(), key));
    } else if managed_node() {
        // On a managed node Composio is the expected zero-setup default (mirrors
        // the OpenRouter block below); warn (do not fail) so an operator notices
        // a missing credential. Resolved through the env fallback in
        // `composio_auth::key()` (`RYU_COMPOSIO_API_KEY` / `COMPOSIO_API_KEY`),
        // which a headless managed node sets — never the desktop UI.
        tracing::warn!(
            "gateway: managed node has no Composio key (set RYU_COMPOSIO_API_KEY); Composio tool loop will be inactive"
        );
    }
    // OpenRouter (A4 / #501): inject the resolved OpenRouter API key so the
    // gateway activates its `openrouter` provider — key presence alone flips it
    // on (apps/gateway/src/config.rs). Resolved through the same preferences-
    // first/env-fallback resolver as Composio, so a key set in the desktop UI
    // (persisted, never on Core's process env) still reaches the gateway. This
    // is unconditional, not gated on `managed`: a key resolving means the
    // operator/user wants OpenRouter, exactly like the Composio block above.
    // The whole point on a MANAGED Ryu Cloud node is that the operator sets this
    // once and every end user gets OpenRouter routing with zero setup.
    if let Some(key) = crate::openrouter_auth::key() {
        tracing::info!("gateway: OpenRouter key present, enabling openrouter provider");
        env.push(("OPENROUTER_API_KEY".to_owned(), key));
        // Managed nodes: privacy-by-default. Route only to OpenRouter providers
        // that do not retain/train on prompts. Scoped to managed nodes so a
        // self-host / BYOK user's own routing is never overridden, and skipped
        // when the operator already pinned the policy explicitly.
        if managed_node() && std::env::var_os("OPENROUTER_DATA_COLLECTION").is_none() {
            tracing::info!("gateway: managed node — defaulting OpenRouter data_collection=deny");
            env.push(("OPENROUTER_DATA_COLLECTION".to_owned(), "deny".to_owned()));
        }
    } else if managed_node() {
        // On a managed node OpenRouter is the expected zero-setup default; warn
        // (do not fail) so an operator notices a missing credential.
        tracing::warn!(
            "gateway: managed node has no OpenRouter key (set RYU_OPENROUTER_API_KEY); openrouter provider will be inactive"
        );
    }
    // Cloud media providers (Replicate / Fal): inject the resolved keys so the
    // gateway activates its `replicate` / `fal` providers for cloud image/video
    // generation — key presence alone flips each on. Same preferences-first/env-
    // fallback resolver as OpenRouter above, so a key set in the desktop UI (BYOK)
    // or by a managed-node operator both reach the gateway. On a managed node the
    // operator sets these once and every end user gets cloud media with zero setup.
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
/// Default `300` ⇒ the current standard $0.30/1,000 execution rate. Deployments
/// using managed-app or premium-tool contracts can override it explicitly.
const ENV_CREDITS_COST_PER_TOOL_CALL: &str = "GATEWAY_CREDITS_COST_PER_TOOL_CALL_MICRO_USD";
const DEFAULT_CREDITS_COST_PER_TOOL_CALL_MICRO_USD: u64 = 300;

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
/// On a managed node Core self-registers to the control plane and the gateway
/// is expected to be pre-provisioned with provider creds (OpenRouter, Composio)
/// + the credits hook so end users do zero setup. Default off — a normal local
/// install is never "managed". Read by [`managed_node`] and surfaced on
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
    // defaulting to the current standard $0.30/1,000 execution rate. Only a
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

        // Already healthy (e.g. a separately launched gateway on the same port)?
        if health_check(&gateway_url()).await {
            tracing::info!(url = %gateway_url(), "gateway: already running, reusing");
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

        // Wait for health, polling for a short window.
        for _ in 0..30 {
            if health_check(&gateway_url()).await {
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
            self.handle.stop().await?;
        }
        self.start().await
    }

    /// Whether a managed gateway child is currently running.
    pub fn is_running(&self) -> bool {
        self.handle.is_running()
    }

    /// Stop the managed gateway child (if any).
    pub async fn stop(&self) -> anyhow::Result<()> {
        self.handle.stop().await
    }
}

impl Default for GatewayManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Derive the gateway `--bind=host:port` from the configured URL so the spawned
/// process listens where Core forwards.
fn gateway_bind_from_url() -> String {
    let url = gateway_url();
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

/// Explicit operator opt-out for the permanent-deletion guard. The absence of
/// this value is the safe default; it is carried to the authenticated Gateway
/// scan so Core and its sidecar make the same decision.
const ENV_ALLOW_PERMANENT_DELETE: &str = "RYU_ALLOW_PERMANENT_DELETE";

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
    let mut req = reqwest::Client::new()
        .post(&endpoint)
        .timeout(std::time::Duration::from_secs(5))
        .json(&payload);
    if let Some(tok) = gateway_token() {
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

async fn check_exec_budget_request(payload: serde_json::Value) -> ExecBudgetOutcome {
    let base = gateway_url();
    let endpoint = format!("{}/v1/exec/budget/check", base.trim_end_matches('/'));
    let token = gateway_token();

    let client = reqwest::Client::new();
    let mut req = client
        .post(&endpoint)
        .timeout(std::time::Duration::from_secs(5))
        .json(&payload);
    if let Some(tok) = token {
        req = req.bearer_auth(tok);
    }

    match req.send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
            Ok(body) => {
                let allowed = body
                    .get("allowed")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                if allowed {
                    ExecBudgetOutcome::Allow
                } else {
                    let reason = body
                        .get("reason")
                        .and_then(|v| v.as_str())
                        .unwrap_or("exec budget exhausted")
                        .to_owned();
                    ExecBudgetOutcome::Deny(reason)
                }
            }
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
// fallback unless the operator explicitly changes `RYU_ALLOW_PERMANENT_DELETE`.

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
    let allow_permanent_delete = ryu_deletion_guard::permanent_delete_allowed(
        std::env::var(ENV_ALLOW_PERMANENT_DELETE).ok().as_deref(),
    );
    // Do this before the network call. A gateway outage plus the documented
    // fallback must not turn a permanent deletion into an allowed command.
    if ryu_deletion_guard::is_execution_backend(backend) && !allow_permanent_delete {
        if let Some(rule) = ryu_deletion_guard::detect_command(command) {
            return ExecScanOutcome::Deny(format!(
                "permanent file deletion blocked by local Ryu guard: {rule}; move the target to the host Trash or Recycle Bin"
            ));
        }
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
    let token = gateway_token();

    let client = reqwest::Client::new();
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
            "allow_permanent_delete": allow_permanent_delete,
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
pub async fn report_exec_audit(
    backend: &str,
    command: &str,
    duration_ms: u64,
    exit_code: i32,
    session_id: Option<String>,
    error: Option<String>,
) {
    let base = gateway_url();
    let endpoint = format!("{}/v1/exec/audit", base.trim_end_matches('/'));
    let token = gateway_token();

    let client = reqwest::Client::new();
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
    let token = gateway_token();

    let client = reqwest::Client::new();
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
    let base = gateway_url();
    let endpoint = format!("{}/v1/exec/audit", base.trim_end_matches('/'));
    let token = gateway_token();

    let client = reqwest::Client::new();
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
async fn health_check(base_url: &str) -> bool {
    let endpoint = format!("{}/health", base_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
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
#[cfg(test)]
pub(crate) fn lock_managed_node_env() -> std::sync::MutexGuard<'static, ()> {
    MANAGED_NODE_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_fleet_precedence_is_environment_then_enrollment_then_manual_preference() {
        let environment = Some((" https://env.example ".into(), " env-token ".into()));
        let enrolled = Some(("https://enrolled.example".into(), "enrolled-token".into()));
        let preference = Some(("https://manual.example".into(), "manual-token".into()));
        assert_eq!(
            select_managed_fleet(environment, enrolled.clone(), preference.clone()),
            Some(("https://env.example".into(), "env-token".into()))
        );
        assert_eq!(
            select_managed_fleet(None, enrolled.clone(), preference.clone()),
            enrolled
        );
        assert_eq!(
            select_managed_fleet(None, None, preference.clone()),
            preference
        );
    }

    /// One test for the whole `x-ryu-node-routing` encoder, deliberately: the
    /// slot is a process-global and cargo runs tests in one process in parallel,
    /// so splitting these would make them observe each other's writes.
    #[test]
    fn node_routing_header_encodes_and_clears() {
        // Default: an untouched node states nothing, so the header is omitted and
        // the request stays byte-identical to before this channel existed.
        set_node_routing_prefs(Vec::new(), None);
        assert_eq!(node_routing_header(), None);

        // Blank-only input is the same as no input — never a `v1.` of nothing.
        set_node_routing_prefs(vec!["  ".into(), String::new()], None);
        assert_eq!(node_routing_header(), None);

        set_node_routing_prefs(
            vec![" anthropic ".into(), "groq".into()],
            Some(serde_json::json!({ "redact_pii": true })),
        );
        let raw = node_routing_header().expect("stated prefs produce a header");
        let encoded = raw
            .strip_prefix("v1.")
            .expect("the version tag is part of the grammar the reader parses");

        use base64::Engine as _;
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded)
            .expect("base64url, no padding — header-safe by construction");
        let doc: serde_json::Value =
            serde_json::from_slice(&decoded).expect("the payload is compact JSON");
        assert_eq!(doc["fallback"], serde_json::json!(["anthropic", "groq"]));
        assert_eq!(doc["firewall"]["redact_pii"], serde_json::json!(true));

        // The preference-store reader feeds the same carrier and clears a
        // previous value when an edit is malformed rather than leaving stale
        // routing active.
        set_node_routing_prefs_from_json(
            r#"{"fallback":["groq"],"firewall":{"custom_patterns":[]}}"#,
        );
        assert!(node_routing_header().is_some());
        set_node_routing_prefs_from_json("not-json");
        assert_eq!(node_routing_header(), None);

        // Clearing is reachable, so a node that retracts its preferences stops
        // sending the header rather than pinning the last value forever.
        set_node_routing_prefs(Vec::new(), None);
        assert_eq!(node_routing_header(), None);
    }

    #[test]
    fn gateway_url_defaults_to_loopback() {
        // Without RYU_GATEWAY_URL set in this process, the default applies.
        if std::env::var(ENV_GATEWAY_URL).is_err() {
            assert_eq!(
                gateway_url(),
                format!("http://127.0.0.1:{}", crate::profile::port(7981))
            );
        }
    }

    #[test]
    fn bind_extracts_host_port_from_url() {
        // Default URL has an explicit port → host:port preserved.
        let bind = gateway_bind_from_url();
        assert!(
            bind.contains(':'),
            "bind should contain host:port, got {bind}"
        );
    }

    #[test]
    fn explicit_local_llm_url_takes_precedence() {
        // An operator-set LOCAL_LLM_URL must win over the active-engine mapping
        // so a custom/external local server can be targeted.
        let prev = std::env::var(ENV_LOCAL_LLM_URL).ok();
        std::env::set_var(ENV_LOCAL_LLM_URL, "http://example.test:9999/v1");
        assert_eq!(
            local_engine_gateway_url().as_deref(),
            Some("http://example.test:9999/v1")
        );
        match prev {
            Some(v) => std::env::set_var(ENV_LOCAL_LLM_URL, v),
            None => std::env::remove_var(ENV_LOCAL_LLM_URL),
        }
    }

    /// Snapshot + restore a set of env vars so a test that mutates process env
    /// does not leak into the others (cargo runs tests in the same process).
    struct EnvGuard {
        saved: Vec<(&'static str, Option<String>)>,
    }
    impl EnvGuard {
        fn capture(names: &[&'static str]) -> Self {
            let saved = names.iter().map(|n| (*n, std::env::var(n).ok())).collect();
            for n in names {
                std::env::remove_var(n);
            }
            Self { saved }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (n, v) in &self.saved {
                match v {
                    Some(val) => std::env::set_var(n, val),
                    None => std::env::remove_var(n),
                }
            }
        }
    }

    /// Serializes the credits tests that mutate process-global env vars. cargo
    /// runs tests in one process and in parallel, so without this two of them can
    /// race on the same vars between `EnvGuard::capture` and its `Drop` restore.
    /// Poison-tolerant: a panicking test must not cascade-fail the rest.
    static CREDITS_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn lock_credits_env() -> std::sync::MutexGuard<'static, ()> {
        CREDITS_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    const CREDITS_ENV: &[&str] = &[
        ENV_CREDITS_ENABLED,
        ENV_CREDITS_INTERNAL_SECRET,
        ENV_CREDITS_URL,
        ENV_CREDITS_WALLET_EMPTY_ACTION,
        ENV_CREDITS_COST_PER_TOOL_CALL,
        "RYU_CONTROL_PLANE_URL",
        "RYU_SERVER_URL",
    ];

    #[test]
    fn credits_env_absent_when_unconfigured() {
        let _lock = lock_credits_env();
        let _g = EnvGuard::capture(CREDITS_ENV);
        // Nothing set → NOP, no vars injected (graceful degrade preserved).
        assert!(credits_spawn_env().is_empty());
        assert!(!credits_configured());

        // Enabled but no secret → still inert (control plane would reject).
        std::env::set_var(ENV_CREDITS_ENABLED, "true");
        assert!(!credits_configured());
        assert!(credits_spawn_env().is_empty());

        // Secret but not enabled → still inert.
        std::env::remove_var(ENV_CREDITS_ENABLED);
        std::env::set_var(ENV_CREDITS_INTERNAL_SECRET, "shh");
        assert!(!credits_configured());
        assert!(credits_spawn_env().is_empty());
    }

    #[test]
    fn credits_env_present_when_configured() {
        let _lock = lock_credits_env();
        let _g = EnvGuard::capture(CREDITS_ENV);
        std::env::set_var(ENV_CREDITS_ENABLED, "1");
        std::env::set_var(ENV_CREDITS_INTERNAL_SECRET, "  top-secret  ");
        std::env::set_var("RYU_CONTROL_PLANE_URL", "https://cp.example.test");

        assert!(credits_configured());
        let env = credits_spawn_env();
        let get = |k: &str| {
            env.iter()
                .find(|(name, _)| name == k)
                .map(|(_, v)| v.as_str())
        };

        assert_eq!(get(ENV_CREDITS_ENABLED), Some("true"));
        // Secret trimmed, never echoed elsewhere.
        assert_eq!(get(ENV_CREDITS_INTERNAL_SECRET), Some("top-secret"));
        // Markup pinned to 0 — margin is at deposit (B2).
        assert_eq!(get("GATEWAY_CREDITS_MARKUP_BPS"), Some("0"));
        // Per-tool-call cost defaults to the current standard Composio rate.
        assert_eq!(get(ENV_CREDITS_COST_PER_TOOL_CALL), Some("300"));
        // Wallet-empty action defaults to Stop.
        assert_eq!(get(ENV_CREDITS_WALLET_EMPTY_ACTION), Some("stop"));
        // Base derived from the control-plane URL + the `/api` mount.
        assert_eq!(get(ENV_CREDITS_URL), Some("https://cp.example.test/api"));
    }

    #[test]
    fn credits_base_url_resolution() {
        let _lock = lock_credits_env();
        let _g = EnvGuard::capture(CREDITS_ENV);

        // Default local dev when nothing is set.
        assert_eq!(credits_base_url(), "http://127.0.0.1:3000/api");

        // RYU_SERVER_URL is the fallback.
        std::env::set_var("RYU_SERVER_URL", "http://server.test:3000/");
        assert_eq!(credits_base_url(), "http://server.test:3000/api");

        // RYU_CONTROL_PLANE_URL wins over RYU_SERVER_URL.
        std::env::set_var("RYU_CONTROL_PLANE_URL", "http://cp.test:3000");
        assert_eq!(credits_base_url(), "http://cp.test:3000/api");

        // An explicit GATEWAY_CREDITS_URL always wins, and an existing `/api`
        // mount is not doubled.
        std::env::set_var(ENV_CREDITS_URL, "http://explicit.test/api/");
        assert_eq!(credits_base_url(), "http://explicit.test/api");
    }

    #[test]
    fn credits_wallet_empty_action_downgrade_passthrough() {
        let _lock = lock_credits_env();
        let _g = EnvGuard::capture(CREDITS_ENV);
        std::env::set_var(ENV_CREDITS_ENABLED, "yes");
        std::env::set_var(ENV_CREDITS_INTERNAL_SECRET, "s");
        std::env::set_var(ENV_CREDITS_WALLET_EMPTY_ACTION, "Downgrade");
        let env = credits_spawn_env();
        let action = env
            .iter()
            .find(|(k, _)| k == ENV_CREDITS_WALLET_EMPTY_ACTION)
            .map(|(_, v)| v.as_str());
        assert_eq!(action, Some("downgrade"));
    }

    #[test]
    fn credits_tool_call_cost_passthrough() {
        // #496: an operator-provisioned per-tool-call (Composio) cost is forwarded
        // to the gateway verbatim; a non-integer value falls back to "0" (free).
        let _lock = lock_credits_env();
        let _g = EnvGuard::capture(CREDITS_ENV);
        std::env::set_var(ENV_CREDITS_ENABLED, "1");
        std::env::set_var(ENV_CREDITS_INTERNAL_SECRET, "s");

        std::env::set_var(ENV_CREDITS_COST_PER_TOOL_CALL, "1500");
        let env = credits_spawn_env();
        let cost = env
            .iter()
            .find(|(k, _)| k == ENV_CREDITS_COST_PER_TOOL_CALL)
            .map(|(_, v)| v.as_str());
        assert_eq!(cost, Some("1500"));

        // Garbage → the safe standard rate, never propagated as an invalid value.
        std::env::set_var(ENV_CREDITS_COST_PER_TOOL_CALL, "not-a-number");
        let env = credits_spawn_env();
        let cost = env
            .iter()
            .find(|(k, _)| k == ENV_CREDITS_COST_PER_TOOL_CALL)
            .map(|(_, v)| v.as_str());
        assert_eq!(cost, Some("300"));
    }

    #[test]
    fn managed_node_zero_setup_provider_keys_resolve_from_env() {
        // A4 / #501: a headless managed node sets provider keys via env (never the
        // desktop UI), and the resolvers must pick them up so the gateway spawn
        // injects them with zero user setup. Pins the env-fallback contract both
        // `gateway_spawn_env` blocks depend on.
        let _lock = super::lock_managed_node_env();
        let _g = EnvGuard::capture(&[
            ENV_MANAGED_NODE,
            "RYU_OPENROUTER_API_KEY",
            "OPENROUTER_API_KEY",
            "RYU_COMPOSIO_API_KEY",
            "COMPOSIO_API_KEY",
        ]);
        std::env::set_var(ENV_MANAGED_NODE, "1");
        std::env::set_var("RYU_OPENROUTER_API_KEY", "sk-or-managed");
        std::env::set_var("RYU_COMPOSIO_API_KEY", "comp-managed");
        // Clear any in-process preference cache a concurrent test may have set, so
        // resolution falls through to the env vars this test controls.
        crate::openrouter_auth::set_key("");
        crate::composio_auth::set_key("");
        assert!(managed_node());
        assert_eq!(
            crate::openrouter_auth::key().as_deref(),
            Some("sk-or-managed")
        );
        assert_eq!(crate::composio_auth::key().as_deref(), Some("comp-managed"));
    }

    #[test]
    fn managed_node_defaults_off_and_reads_env() {
        let _lock = super::lock_managed_node_env();
        let _g = EnvGuard::capture(&[ENV_MANAGED_NODE]);
        // Unset → not managed.
        assert!(!managed_node());
        // Truthy values flip it on.
        for v in ["1", "true", "yes", "YES", " True "] {
            std::env::set_var(ENV_MANAGED_NODE, v);
            assert!(managed_node(), "{v:?} should be managed");
        }
        // Anything else stays off.
        std::env::set_var(ENV_MANAGED_NODE, "0");
        assert!(!managed_node());
    }

    /// #447: the four gateway/sandbox policy plugins (compression / firewall /
    /// routing / sandbox) round-trip through their on/off flag into the surface
    /// the gateway actually reads. Three are gateway-spawn-env policies, so they
    /// must appear in `gateway_spawn_env` when ON and vanish when OFF; the fourth
    /// (sandbox) is Core-local, so it round-trips through `sandbox::is_enabled()`,
    /// NOT the gateway env. This is the test that lets #447 close: every policy
    /// `apply_policy` flips is observable end-to-end.
    #[test]
    fn policy_flags_roundtrip_into_their_surface() {
        // These flip the process-global policy atomics (firewall / routing /
        // headroom / sandbox); serialize against every other test that reads or
        // writes them, and restore each to its prior value on exit.
        let _flags = crate::sidecar::gateway_policy::lock_policy_flags();
        let prev_firewall = crate::sidecar::gateway_policy::firewall_enabled();
        let prev_routing = crate::sidecar::gateway_policy::routing_enabled();
        let prev_headroom = crate::sidecar::headroom::is_enabled();
        let prev_sandbox = crate::sidecar::mcp::sandbox::is_enabled();
        // The three gateway-env policies. Capture their dev-seed env so a stray
        // GATEWAY_* in the runner does not skew the OFF assertions.
        let _g = EnvGuard::capture(&[
            "GATEWAY_FIREWALL_ENABLED",
            "GATEWAY_SMART_ROUTING_ENABLED",
            "RYU_HEADROOM_ENABLED",
            "GATEWAY_COMPRESSION_ENABLED",
            // Sandbox toggles via this env var; restore it so the test leaves no
            // residue (cargo runs all tests in one process).
            "RYU_SANDBOX_DISABLED",
        ]);
        let has = |env: &[(String, String)], key: &str| env.iter().any(|(k, _)| k == key);

        // ── ON: flip every flag the way apply_policy does, assert it lands. ──
        crate::sidecar::gateway_policy::set_firewall_enabled(true);
        crate::sidecar::gateway_policy::set_routing_enabled(true);
        crate::sidecar::headroom::set_enabled(true);
        crate::sidecar::mcp::sandbox::set_enabled(true);

        let env_on = gateway_spawn_env();
        assert!(
            has(&env_on, "GATEWAY_FIREWALL_ENABLED"),
            "firewall policy ON must inject GATEWAY_FIREWALL_ENABLED"
        );
        assert!(
            has(&env_on, "GATEWAY_SMART_ROUTING_ENABLED"),
            "routing policy ON must inject GATEWAY_SMART_ROUTING_ENABLED"
        );
        assert!(
            has(&env_on, "GATEWAY_COMPRESSION_ENABLED"),
            "compression policy ON must inject GATEWAY_COMPRESSION_ENABLED"
        );
        // Sandbox is Core-local — it round-trips through is_enabled, not the env.
        assert!(
            crate::sidecar::mcp::sandbox::is_enabled(),
            "sandbox policy ON must flip sandbox::is_enabled()"
        );

        // ── OFF: every flag back down, every surface clears. ──
        crate::sidecar::gateway_policy::set_firewall_enabled(false);
        crate::sidecar::gateway_policy::set_routing_enabled(false);
        crate::sidecar::headroom::set_enabled(false);
        crate::sidecar::mcp::sandbox::set_enabled(false);

        let env_off = gateway_spawn_env();
        assert!(
            !has(&env_off, "GATEWAY_FIREWALL_ENABLED"),
            "firewall OFF must not inject the env"
        );
        assert!(
            !has(&env_off, "GATEWAY_SMART_ROUTING_ENABLED"),
            "routing OFF must not inject the env"
        );
        assert!(
            !has(&env_off, "GATEWAY_COMPRESSION_ENABLED"),
            "compression OFF must not inject the env"
        );
        assert!(
            !crate::sidecar::mcp::sandbox::is_enabled(),
            "sandbox OFF must flip sandbox::is_enabled() back"
        );

        // Restore the flags to their prior values so this test leaves no residue.
        crate::sidecar::gateway_policy::set_firewall_enabled(prev_firewall);
        crate::sidecar::gateway_policy::set_routing_enabled(prev_routing);
        crate::sidecar::headroom::set_enabled(prev_headroom);
        crate::sidecar::mcp::sandbox::set_enabled(prev_sandbox);
    }

    // ── Classify tier (llamacpp-classify) ───────────────────────────────────

    /// The gateway can only register the `classify` provider if Core tells it where
    /// the tier lives, and it must be told UNCONDITIONALLY: the spawn env is
    /// computed once, so gating on install state would hide a later-installed
    /// classifier until a respawn.
    #[test]
    fn spawn_env_always_publishes_the_classify_tier_url() {
        // Two locks, both required: `lock_policy_flags` because `gateway_spawn_env`
        // folds the policy atomics in, and the crate-wide gateway-env lock because
        // this asserts an exact URL *value* — a stricter contract on process-global
        // env than the presence-only policy test above, and `RYU_CLASSIFY_LLM_URL`
        // is a gateway env var this module owns.
        let _flags = crate::sidecar::gateway_policy::lock_policy_flags();
        let _env = super::lock_gateway_env();
        let _g = EnvGuard::capture(&["RYU_CLASSIFY_LLM_URL"]);
        let env = gateway_spawn_env();
        let url = env
            .iter()
            .find(|(k, _)| k == "RYU_CLASSIFY_LLM_URL")
            .map(|(_, v)| v.clone())
            .expect("gateway spawn env must always carry RYU_CLASSIFY_LLM_URL");
        // Profile-aware loopback port + the OpenAI-compatible `/v1` suffix the
        // gateway's provider base URLs expect.
        assert_eq!(
            url,
            format!(
                "http://127.0.0.1:{}/v1",
                crate::sidecar::providers::llamacpp::classify::classify_port()
            )
        );
        // And it must NOT be the resident chat engine's URL — pointing the classify
        // tier at `local` is exactly the bug this unit fixes.
        assert!(!url.contains(&format!(":{}/", crate::profile::port(8080))));
        // The URL alone is not enough: the gateway also needs the resolved model ID,
        // or its inspector default stays an independent literal and a registry swap
        // produces an unroutable config.
        let model = env
            .iter()
            .find(|(k, _)| k == "RYU_CLASSIFY_MODEL_ID")
            .map(|(_, v)| v.clone())
            .expect("gateway spawn env must carry RYU_CLASSIFY_MODEL_ID beside the URL");
        // It must be the id the SIDECAR serves, resolved from the same registry entry
        // that picks its GGUF — not a second literal, which is the whole bug.
        assert_eq!(
            model,
            crate::registry::ModelRegistry::from_env()
                .local_classifier_model
                .id
        );
        assert!(!model.trim().is_empty(), "a blank id would break the seed");
        // And Core's start predicate must agree with what it published, or Core
        // starts a tier for one id while the gateway routes another.
        assert!(patch_selects_classify_tier(
            &serde_json::json!({ "firewall": { "inspector": { "enabled": true, "model": model } } }),
            &model
        ));
    }

    /// An operator-set `RYU_CLASSIFY_LLM_URL` points the tier at an external small
    /// model and must win over the built-in loopback default.
    #[test]
    fn explicit_classify_url_env_wins() {
        // Same lock as the test above — these two are the only writers of
        // `RYU_CLASSIFY_LLM_URL`, so they must serialize against each other.
        let _env = super::lock_gateway_env();
        let _g = EnvGuard::capture(&["RYU_CLASSIFY_LLM_URL"]);
        std::env::set_var("RYU_CLASSIFY_LLM_URL", "http://example.test:1234/v1");
        assert_eq!(classify_gateway_url(), "http://example.test:1234/v1");
    }

    /// The composition `maybe_start_classify_tier`'s second spend gate performs: an
    /// operator who repoints the tier at an EXTERNAL small model must not still pay for
    /// a local 300-400 MB llama-server nobody dials.
    ///
    /// This is only sound because the gateway obeys the variable over its own
    /// `[providers.classify]` (`apps/gateway/src/config.rs`, env-wins); the
    /// `cores_published_classify_url_wins_the_file_table` test in that crate is the
    /// other half. Asserted through the real `classify_gateway_url` rather than a
    /// literal, so a change to how Core resolves the URL breaks this too.
    #[test]
    fn external_classify_url_blocks_the_local_lazy_start() {
        let _env = super::lock_gateway_env();
        let _g = EnvGuard::capture(&["RYU_CLASSIFY_LLM_URL"]);

        std::env::set_var(
            "RYU_CLASSIFY_LLM_URL",
            "http://small-model.internal:9999/v1",
        );
        assert!(
            !url_targets_this_machine(&classify_gateway_url()),
            "an external classify endpoint must not spend local RAM on a tier it \
             replaced"
        );

        // A loopback override is still local: the operator swapped the port, not the box.
        std::env::set_var("RYU_CLASSIFY_LLM_URL", "http://127.0.0.1:18083/v1");
        assert!(url_targets_this_machine(&classify_gateway_url()));

        // …and the computed default (no override) is loopback by construction, so the
        // ordinary node is unaffected by the gate.
        std::env::remove_var("RYU_CLASSIFY_LLM_URL");
        assert!(
            url_targets_this_machine(&classify_gateway_url()),
            "the default must still start the tier — a gate that blocked the common \
             case would silently disable the guardrail everywhere"
        );
    }

    /// The half-configuration detector, over the four states it has to separate.
    ///
    /// Pure, so no env and no registry: `(url, id)` in, verdict out. The loopback row
    /// is the one that matters most — an ordinary node must never be told its default
    /// configuration is suspect.
    #[test]
    fn a_repointed_classify_url_with_the_default_model_id_is_half_configured() {
        let default_id = crate::registry::DEFAULT_LOCAL_CLASSIFIER_MODEL_ID;

        // Repointed endpoint, id left at the registry default: the gateway will ask
        // that endpoint for OUR id. Indistinguishable from a misconfiguration.
        assert!(half_configured_external_classify_tier(
            "http://small-model.internal:9999/v1",
            default_id
        ));
        // Whitespace must not smuggle the default id past the comparison — the
        // gateway seeds its route from a trimmed id.
        assert!(half_configured_external_classify_tier(
            "http://small-model.internal:9999/v1",
            &format!("  {default_id}  ")
        ));
        // Both halves moved: a deliberate, complete external tier. Silence is correct.
        assert!(!half_configured_external_classify_tier(
            "http://small-model.internal:9999/v1",
            "some-other-tiny-model"
        ));
        // Local target — the ordinary node, and a loopback port swap. The tier gets
        // started, so there is nothing to warn about in either.
        assert!(!half_configured_external_classify_tier(
            &format!(
                "http://127.0.0.1:{}/v1",
                crate::sidecar::providers::llamacpp::classify::classify_port()
            ),
            default_id
        ));
        assert!(!half_configured_external_classify_tier(
            "http://localhost:18083/v1",
            default_id
        ));
        // An unparseable override cannot be proven local either, so it lands in the
        // same reported bucket. Documented on the predicate rather than special-cased:
        // it is also a misconfiguration.
        assert!(half_configured_external_classify_tier(
            "not a url",
            default_id
        ));
    }

    /// The regression this pairs with: spend gate 2 must not log a half-configuration
    /// past at `debug!`.
    ///
    /// Gate 2 stopped the local sidecar from accidentally answering for the registry
    /// id at a repointed endpoint. That was the ONLY thing making the half-configured
    /// state visible, and `/api/sidecar/status` reports the skipped tier exactly like a
    /// lazy tier nobody has needed yet. So the skip has to leave a queryable record —
    /// which this drives through the real `maybe_start_classify_tier`, not through the
    /// predicate, because the recording is the behaviour under test.
    #[test]
    fn a_half_configured_classify_tier_records_why_the_start_was_skipped() {
        use crate::sidecar::providers::llamacpp::classify as classify_sidecar;

        // Both globals: the env (this reads `RYU_CLASSIFY_LLM_URL` + `RYU_GATEWAY_URL`)
        // and the record itself, whose other test writer lives in `classify.rs`.
        let _env = super::lock_gateway_env();
        let _rec = classify_sidecar::lock_lazy_start_record();
        let _g = EnvGuard::capture(&["RYU_CLASSIFY_LLM_URL", "RYU_GATEWAY_URL"]);

        // Gate 1 must pass, or gate 2 is never reached: keep the gateway on this box.
        std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:8088");
        // A patch that genuinely selects the tier (inspector on, naming the classify
        // model), so the skip below is the gate's decision and not the predicate's.
        let patch = serde_json::json!({
            "firewall": { "inspector": { "enabled": true, "model": classify_model_id() } }
        });

        classify_sidecar::clear_lazy_start_failure_for_test();
        std::env::set_var(
            "RYU_CLASSIFY_LLM_URL",
            "http://small-model.internal:9999/v1",
        );
        maybe_start_classify_tier(&patch);
        let recorded = classify_sidecar::lazy_start_failure_reason_for_test()
            .expect("a half-configured external tier must leave a reason behind");
        // The reason has to name both halves and the fix, or it is just another
        // "something is wrong" line.
        assert!(recorded.contains("http://small-model.internal:9999/v1"));
        assert!(recorded.contains(&classify_model_id()));
        assert!(recorded.contains("RYU_LOCAL_CLASSIFIER_MODEL_ID"));

        // The ordinary node must stay quiet: a local target is not a skip at all, so
        // nothing is recorded (the start itself then no-ops in a test process, which
        // has no registered sidecar manager). Asserted against a freshly cleared slot
        // so it cannot pass on the previous write.
        //
        // The other quiet case — a fully configured EXTERNAL tier — is covered by
        // `a_repointed_classify_url_with_the_default_model_id_is_half_configured`
        // rather than here, deliberately: driving it needs
        // `RYU_LOCAL_CLASSIFIER_MODEL_ID`, whose only serializing lock is private to
        // `registry::tests`, so setting it here would race that module's own
        // override test in the shared test process.
        classify_sidecar::clear_lazy_start_failure_for_test();
        std::env::set_var("RYU_CLASSIFY_LLM_URL", "http://127.0.0.1:18083/v1");
        maybe_start_classify_tier(&patch);
        assert_eq!(
            classify_sidecar::lazy_start_failure_reason_for_test(),
            None,
            "a local classify target is not a skip and must not be reported as one"
        );

        // Leave the slot as we found it for whatever runs next.
        classify_sidecar::clear_lazy_start_failure_for_test();
    }

    /// The lazy-start predicate must fire for ALL THREE consumers of the classify
    /// tier and for both ways of naming it (the configured id, and the router's
    /// builtin `gemma-3-270m` prefix — matched case-insensitively, mirroring
    /// `RoutingTables::route`) — and only when that consumer is switched ON.
    #[test]
    fn classify_predicate_fires_for_every_enabled_consumer() {
        let id = crate::registry::DEFAULT_LOCAL_CLASSIFIER_MODEL_ID;

        // 1. Firewall inspector selection, inspector enabled.
        assert!(patch_selects_classify_tier(
            &serde_json::json!({ "firewall": { "enabled": true, "inspector": { "enabled": true, "model": id } } }),
            id
        ));
        // The inspector is independent of the OUTER firewall switch (`pipeline` gates
        // it on `inspector.enabled` alone), so an armed inspector inside a disarmed
        // firewall still fires — requiring `firewall.enabled` would be a miss.
        assert!(patch_selects_classify_tier(
            &serde_json::json!({ "firewall": { "enabled": false, "inspector": { "enabled": true, "model": id } } }),
            id
        ));
        // 2. Smart-routing classifier selection — the exact patch shape
        // `build_routing_patch` produces (top-level `routing` → `smart_routing`).
        assert!(patch_selects_classify_tier(
            &serde_json::json!({ "routing": { "smart_routing": { "enabled": true, "classifier_model": id } } }),
            id
        ));
        // Prefix + case: the router lowercases before matching builtin prefixes, so
        // Core must too or it would decline to start a tier the gateway will use.
        assert!(patch_selects_classify_tier(
            &serde_json::json!({ "routing": { "smart_routing": { "enabled": true, "classifier_model": "GEMMA-3-270M-IT" } } }),
            id
        ));
        // 3. An LLM-judge evaluator binding borrows `inspector.model` REGARDLESS of
        // `inspector.enabled`, so an enabled binding is its own arm. Without it, the
        // feature gate would leave judge users with a permanently cold tier.
        assert!(patch_selects_classify_tier(
            &serde_json::json!({ "firewall": {
                "inspector": { "enabled": false, "model": id },
                "evaluators": [{ "id": "toxicity", "enabled": true }],
            } }),
            id
        ));
        // A custom (registry-swapped) classifier id with no gemma prefix still fires,
        // because the predicate also matches the configured id itself.
        assert!(patch_selects_classify_tier(
            &serde_json::json!({ "firewall": { "inspector": { "enabled": true, "model": " my-tiny-classifier " } } }),
            "my-tiny-classifier"
        ));
    }

    /// The blank/absent-model contract for BOTH fields that can name the classify
    /// tier. Pinned here because neither is true by anything in this crate: both hold
    /// only by virtue of a serde attribute in `apps/gateway/src/config.rs` that runs
    /// in another PROCESS, downstream of this predicate.
    ///
    /// * `InspectorConfig::model` → `deserialize_with = de_inspector_model`, which
    ///   maps a blank to `classify_model_id()`, plus a field default and a manual
    ///   `Default` impl that both fill the same id. Blank therefore MEANS "the
    ///   classify tier" — so declining here (what the code did before) is what left
    ///   the guardrail silently dead for a user who followed the dialog's own advice
    ///   to leave the box empty.
    /// * `SmartRoutingConfig::classifier_model` → the SAME pair as of the P1-2 fix
    ///   (`default = "default_classifier_model"`, `deserialize_with =
    ///   "de_classifier_model"`). It used to be a plain `#[serde(default)] String`
    ///   documented "Empty ⇒ smart routing is inert", and this test used to assert
    ///   the OPPOSITE for it.
    ///
    /// **The assertion flipped, and that is the point of the rename.** While the
    /// field resolved blanks and this arm did not, Core declined to start the tier
    /// and the gateway dialled it anyway — connection refused, fail open, nothing
    /// warned. Identical in shape to the inspector bug above, reintroduced through
    /// the other field. A green test asserting the old rationale is what would have
    /// hidden it, so the rationale is pinned to the CURRENT serde attributes and
    /// fails loudly if either field stops resolving.
    #[test]
    fn a_blank_model_on_either_field_selects_the_classify_tier() {
        let id = crate::registry::DEFAULT_LOCAL_CLASSIFIER_MODEL_ID;

        for blank in ["", "   "] {
            // The shape that reaches `PUT /api/gateway/config` from any client that
            // does not pre-resolve the field: the inspector switched on with the
            // Model box left empty. (The current desktop resolves it client-side in
            // `withResolvedInspectorModels`; this endpoint is a generic proxy, so
            // Core cannot depend on that.)
            assert!(
                patch_selects_classify_tier(
                    &serde_json::json!({ "firewall": {
                        "enabled": true,
                        "inspector": { "enabled": true, "model": blank },
                    } }),
                    id
                ),
                "a blank inspector model ({blank:?}) resolves to the classify id in the \
                 gateway, so Core must start the tier"
            );
            // …and now the same rule, not the mirror of it: `de_classifier_model`
            // resolves this blank to the classify id too, so declining here would
            // leave the gateway dialling a tier Core never started.
            assert!(
                patch_selects_classify_tier(
                    &serde_json::json!({ "routing": {
                        "smart_routing": { "enabled": true, "classifier_model": blank },
                    } }),
                    id
                ),
                "a blank classifier_model ({blank:?}) resolves to the classify id in the \
                 gateway, so Core must start the tier"
            );
        }

        // An ABSENT `classifier_model` inside a PRESENT, ENABLED `smart_routing` hits
        // `#[serde(default = "default_classifier_model")]` — the same resolved id.
        assert!(patch_selects_classify_tier(
            &serde_json::json!({ "routing": { "smart_routing": { "enabled": true } } }),
            id
        ));
        // The feature gate still holds: smart routing that this patch does not switch
        // ON never arms, however its model reads. This is what keeps the widening from
        // reopening the spawn-on-every-routing-push regression.
        assert!(!patch_selects_classify_tier(
            &serde_json::json!({ "routing": {
                "smart_routing": { "enabled": false, "classifier_model": "" },
            } }),
            id
        ));

        // An ABSENT `model` inside a PRESENT `inspector` hits
        // `#[serde(default = "default_inspector_model")]` — same resolved id.
        assert!(patch_selects_classify_tier(
            &serde_json::json!({ "firewall": { "inspector": { "enabled": true } } }),
            id
        ));
        // An absent `inspector` OBJECT resolves through `FirewallConfig`'s
        // `#[serde(default)] pub inspector` → the manual `Default for InspectorConfig`,
        // which also fills the classify id. So a judge binding still gets the tier
        // even when the patch names no inspector at all.
        assert!(patch_selects_classify_tier(
            &serde_json::json!({ "firewall": {
                "evaluators": [{ "id": "llm_as_a_judge", "enabled": true }],
            } }),
            id
        ));
        // A non-string `model` is NOT a selection: `de_inspector_model` begins with
        // `String::deserialize`, so the gateway rejects the whole push and nothing
        // ever dials the tier.
        assert!(!patch_selects_classify_tier(
            &serde_json::json!({ "firewall": { "inspector": { "enabled": true, "model": 7 } } }),
            id
        ));
        // Blank still needs the consuming feature ON — the flag gate is what stops a
        // "Log detections" checkbox save from spawning a resident llama-server.
        assert!(!patch_selects_classify_tier(
            &serde_json::json!({ "firewall": {
                "log_detections": true,
                "inspector": { "enabled": false, "model": "" },
                "evaluators": [],
            } }),
            id
        ));
    }

    /// The regression this gate exists for: the gateway resolves a blank
    /// `inspector.model` to the classify id, so EVERY firewall push names the
    /// classifier. Selecting the model must not be enough — the consuming feature has
    /// to be on, or a "Log detections" checkbox save (and enabling *or disabling* the
    /// firewall plugin, whose patch is sourced from the live config) spawns a 241 MB
    /// llama-server that never exits.
    #[test]
    fn classify_predicate_declines_when_the_consuming_feature_is_off() {
        let id = crate::registry::DEFAULT_LOCAL_CLASSIFIER_MODEL_ID;

        // The firewall-plugin toggle shape, both directions: the live firewall section
        // carries the resolved classify id in `inspector.model` while the inspector
        // itself is off, and no evaluator binding is enabled. That this is what a
        // fresh node's `FirewallConfig` actually serializes to is pinned in the crate
        // that owns the default, by
        // `ryu-gateway`'s `default_firewall_section_selects_nothing_for_cores_lazy_start`.
        for firewall_enabled in [true, false] {
            let patch = serde_json::json!({ "firewall": {
                "enabled": firewall_enabled,
                "log_detections": true,
                "inspector": { "enabled": false, "model": id },
                "evaluators": [{ "id": "toxicity", "enabled": false }],
            } });
            assert!(
                !patch_selects_classify_tier(&patch, id),
                "firewall.enabled={firewall_enabled} with the inspector off must not start the tier"
            );
        }
        // Smart routing configured but not switched on.
        assert!(!patch_selects_classify_tier(
            &serde_json::json!({ "routing": { "smart_routing": { "enabled": false, "classifier_model": id } } }),
            id
        ));
        // An ABSENT flag reads as off. Every real writer sends whole sections, so a
        // missing flag means "this patch does not turn the consumer on"; treating it
        // as enabled would restore the spawn-on-any-push bug.
        assert!(!patch_selects_classify_tier(
            &serde_json::json!({ "firewall": { "inspector": { "model": id } } }),
            id
        ));
        assert!(!patch_selects_classify_tier(
            &serde_json::json!({ "routing": { "smart_routing": { "classifier_model": id } } }),
            id
        ));
        // An empty evaluator list is not "an enabled binding".
        assert!(!patch_selects_classify_tier(
            &serde_json::json!({ "firewall": { "inspector": { "model": id }, "evaluators": [] } }),
            id
        ));
    }

    /// The host-locality test behind both classify spend gates: pushing a classify
    /// selection at a REMOTE gateway must not start a local sidecar (~300-400 MB here
    /// for a server nothing dials, while the remote gateway's own loopback `classify`
    /// provider stays empty either way), and neither must a classify URL pointing at an
    /// external small model.
    #[test]
    fn classify_start_is_local_only() {
        for local in [
            "http://127.0.0.1:7981",
            "http://127.0.0.1:8981/",
            "http://localhost:7981",
            "http://LOCALHOST:7981",
            "http://[::1]:7981",
            "http://127.5.5.5:7981",
            // The gateway's own default BIND address still means "this box".
            "http://0.0.0.0:7981",
        ] {
            assert!(
                url_targets_this_machine(local),
                "{local} is this machine — the lazy start must run"
            );
        }
        for remote in [
            "http://gateway.internal:7981",
            "https://gw.example.com",
            "http://10.0.0.7:7981",
            "http://192.168.1.20:7981",
            "http://[2606:4700::1]:7981",
            // Unparseable ⇒ cannot prove local ⇒ do not spend the RAM.
            "not a url",
            "",
        ] {
            assert!(
                !url_targets_this_machine(remote),
                "{remote} is not this machine — the remote node must start its own tier"
            );
        }
    }

    /// The negative that earns its keep: the DEFAULT local chat model must not trip
    /// the predicate. A prefix slip there would start a second llama-server on every
    /// routing config push.
    #[test]
    fn classify_predicate_ignores_the_default_chat_model_and_empty_patches() {
        let id = crate::registry::DEFAULT_LOCAL_CLASSIFIER_MODEL_ID;
        for model in [
            crate::registry::DEFAULT_LOCAL_CHAT_MODEL_ID, // gemma-4-E2B-it-Q4_K_M
            "gemma-3-27b-it",                             // same family, 100x the size
            "gpt-4o-mini",
        ] {
            // Both consumers ENABLED, so the model id is the only discriminator left
            // — this is a model-matching assertion, not a feature-gate one.
            let patch = serde_json::json!({
                "firewall": { "inspector": { "enabled": true, "model": model } },
                "routing": { "smart_routing": { "enabled": true, "classifier_model": model } },
            });
            assert!(
                !patch_selects_classify_tier(&patch, id),
                "{model:?} must not select the classify tier"
            );
        }
        // A BLANK model is deliberately NOT in the loop above: it is a SELECTION on
        // both fields rather than a non-match, so it belongs to
        // `a_blank_model_on_either_field_selects_the_classify_tier`, not here.
        // Patches that carry neither key at all (the common case: a firewall
        // pattern-pack toggle) never fire.
        assert!(!patch_selects_classify_tier(
            &serde_json::json!({ "firewall": { "enabled": true, "custom_patterns": [] } }),
            id
        ));
        assert!(!patch_selects_classify_tier(&serde_json::json!({}), id));
    }

    // ── Command-approval scan gate (check_exec_scan) ─────────────────────────

    /// Serializes the scan-gate tests: they mutate the process-global
    /// `RYU_EXEC_APPROVAL_MODE` / `RYU_GATEWAY_URL` / `RYU_ALLOW_GATEWAY_FALLBACK`
    /// env vars. These are the SAME vars other modules' tests touch, so this
    /// delegates to the one crate-wide [`super::GATEWAY_ENV_TEST_LOCK`] rather
    /// than a second parallel lock (two locks on one global do not serialize).
    fn lock_scan_env() -> std::sync::MutexGuard<'static, ()> {
        super::lock_gateway_env()
    }

    const SCAN_ENV: &[&str] = &[
        ENV_EXEC_APPROVAL_MODE,
        ENV_GATEWAY_URL,
        ENV_ALLOW_GATEWAY_FALLBACK,
        ENV_ALLOW_PERMANENT_DELETE,
    ];

    #[test]
    fn exec_scan_verdict_mapping() {
        // The pure decision mapper: allow → Allow, approval_required → Approval,
        // deny / anything else → fail-closed Deny.
        assert_eq!(map_scan_decision("allow", ""), ExecScanOutcome::Allow);
        assert_eq!(
            map_scan_decision("approval_required", "needs sign-off"),
            ExecScanOutcome::ApprovalRequired("needs sign-off".to_owned())
        );
        assert_eq!(
            map_scan_decision("deny", "blocked by firewall"),
            ExecScanOutcome::Deny("blocked by firewall".to_owned())
        );
        // Unknown verdict is fail-closed (Deny), never a silent allow.
        assert!(matches!(
            map_scan_decision("wat", ""),
            ExecScanOutcome::Deny(_)
        ));
        // Empty reasons get sensible defaults.
        assert!(matches!(
            map_scan_decision("approval_required", ""),
            ExecScanOutcome::ApprovalRequired(_)
        ));
    }

    #[test]
    fn exec_scan_off_mode_reads_env() {
        let _lock = lock_scan_env();
        let _g = EnvGuard::capture(SCAN_ENV);
        // Unset → ARMED (the default-on posture; only explicit `off` disarms).
        std::env::remove_var(ENV_EXEC_APPROVAL_MODE);
        assert!(exec_approval_enabled(), "unset must arm the gate");
        // "off" (any case, trimmed) → disabled.
        for v in ["off", "OFF", " Off "] {
            std::env::set_var(ENV_EXEC_APPROVAL_MODE, v);
            assert!(!exec_approval_enabled(), "{v:?} should disable the gate");
        }
        // Any other value → enabled.
        for v in ["on", "enforce", "prompt", ""] {
            std::env::set_var(ENV_EXEC_APPROVAL_MODE, v);
            assert!(exec_approval_enabled(), "{v:?} should enable the gate");
        }
    }

    #[tokio::test]
    async fn exec_scan_off_mode_short_circuits_without_network() {
        let _lock = lock_scan_env();
        let _g = EnvGuard::capture(SCAN_ENV);
        // Gate explicitly disarmed + a guaranteed-unreachable gateway + NO
        // fallback. If the off-mode path touched the network it would fail-closed
        // to Deny; an Allow proves it short-circuited before any HTTP call.
        std::env::set_var(ENV_EXEC_APPROVAL_MODE, "off");
        std::env::set_var(ENV_GATEWAY_URL, "http://127.0.0.1:1");
        std::env::remove_var(ENV_ALLOW_GATEWAY_FALLBACK);
        let out = check_exec_scan("deno", "echo hi", Some("sess"), Some("ryu")).await;
        assert_eq!(out, ExecScanOutcome::Allow);
    }

    #[tokio::test]
    async fn permanent_deletion_is_denied_before_gateway_fallback() {
        let _lock = lock_scan_env();
        let _g = EnvGuard::capture(SCAN_ENV);
        std::env::set_var(ENV_EXEC_APPROVAL_MODE, "off");
        std::env::set_var(ENV_GATEWAY_URL, "http://127.0.0.1:1");
        std::env::set_var(ENV_ALLOW_GATEWAY_FALLBACK, "1");
        let out = check_exec_scan("acp", "rm -rf ./disposable", None, Some("ryu")).await;
        assert!(
            matches!(&out, ExecScanOutcome::Deny(reason) if reason.contains("permanent file deletion")),
            "permanent deletion must stay denied even with approval and gateway fallbacks: {out:?}"
        );
    }

    #[tokio::test]
    async fn explicit_permanent_deletion_policy_change_reaches_gateway() {
        let _lock = lock_scan_env();
        let _g = EnvGuard::capture(SCAN_ENV);
        std::env::set_var(ENV_EXEC_APPROVAL_MODE, "off");
        std::env::set_var(ENV_ALLOW_PERMANENT_DELETE, "1");
        std::env::set_var(ENV_GATEWAY_URL, "http://127.0.0.1:1");
        std::env::set_var(ENV_ALLOW_GATEWAY_FALLBACK, "1");
        let out = check_exec_scan("acp", "rm -rf ./disposable", None, Some("ryu")).await;
        assert_eq!(out, ExecScanOutcome::Allow);
    }

    #[tokio::test]
    async fn exec_scan_default_is_armed_and_fail_closed() {
        let _lock = lock_scan_env();
        let _g = EnvGuard::capture(SCAN_ENV);
        // The load-bearing default: with NOTHING configured, the scan runs and an
        // unreachable gateway fails closed — a default install's headless runs
        // cannot execute unscanned commands.
        std::env::remove_var(ENV_EXEC_APPROVAL_MODE);
        std::env::set_var(ENV_GATEWAY_URL, "http://127.0.0.1:1");
        std::env::remove_var(ENV_ALLOW_GATEWAY_FALLBACK);
        let out = check_exec_scan("deno", "echo hi", None, None).await;
        assert!(
            matches!(out, ExecScanOutcome::Deny(_)),
            "default-armed gate must fail closed on an unreachable gateway, got {out:?}"
        );
    }

    #[tokio::test]
    async fn exec_scan_unreachable_denies_unless_fallback() {
        let _lock = lock_scan_env();
        let _g = EnvGuard::capture(SCAN_ENV);
        // Gate enabled, gateway unreachable, no fallback → fail-closed Deny.
        std::env::set_var(ENV_EXEC_APPROVAL_MODE, "enforce");
        std::env::set_var(ENV_GATEWAY_URL, "http://127.0.0.1:1");
        std::env::remove_var(ENV_ALLOW_GATEWAY_FALLBACK);
        let denied = check_exec_scan("deno", "echo hi", None, None).await;
        assert!(
            matches!(denied, ExecScanOutcome::Deny(_)),
            "unreachable gateway must fail closed, got {denied:?}"
        );

        // Same, but with the fallback opt-in → Allow.
        std::env::set_var(ENV_ALLOW_GATEWAY_FALLBACK, "1");
        let allowed = check_exec_scan("deno", "echo hi", None, None).await;
        assert_eq!(allowed, ExecScanOutcome::Allow);
    }

    #[test]
    fn widget_budget_response_requires_a_boolean_allowed_verdict() {
        for body in [
            serde_json::json!({}),
            serde_json::json!({ "allowed": null }),
            serde_json::json!({ "allowed": "true" }),
        ] {
            assert!(matches!(
                parse_widget_budget_response(body),
                ExecBudgetOutcome::Deny(_)
            ));
        }
        assert_eq!(
            parse_widget_budget_response(serde_json::json!({ "allowed": true })),
            ExecBudgetOutcome::Allow
        );
    }

    #[tokio::test]
    async fn widget_budget_ignores_gateway_fallback_on_unreachable_gateway() {
        let _lock = lock_gateway_env();
        let _env = EnvGuard::capture(&[ENV_GATEWAY_URL, ENV_ALLOW_GATEWAY_FALLBACK]);
        std::env::set_var(ENV_GATEWAY_URL, "http://127.0.0.1:1");
        std::env::set_var(ENV_ALLOW_GATEWAY_FALLBACK, "1");

        assert!(matches!(
            check_widget_followup("widget-instance", "com.example.widget").await,
            ExecBudgetOutcome::Deny(_)
        ));
    }

    /// The config-push transport must PUT `/v1/config` and forward the gateway
    /// bearer (the master key on a remote gateway) so a remote/unmanaged gateway
    /// toggle is actually authorized — the item-1 "verify the master-key auth is
    /// sent" requirement. Drives a oneshot listener so no process env is touched.
    #[tokio::test]
    async fn config_request_puts_config_path_and_forwards_bearer() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind oneshot listener");
        let addr = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            // Read until we have the full request (header block + JSON body). One
            // small localhost request usually arrives at once, but loop with a
            // short timeout so a split header/body still assembles.
            let mut raw = Vec::new();
            let mut buf = [0u8; 2048];
            loop {
                match tokio::time::timeout(
                    std::time::Duration::from_millis(500),
                    sock.read(&mut buf),
                )
                .await
                {
                    Ok(Ok(0)) => break,
                    Ok(Ok(n)) => {
                        raw.extend_from_slice(&buf[..n]);
                        // Stop once the body token has arrived.
                        if String::from_utf8_lossy(&raw).contains("\"firewall\"") {
                            break;
                        }
                    }
                    _ => break,
                }
            }
            let _ = sock
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                .await;
            String::from_utf8_lossy(&raw).into_owned()
        });

        let client = reqwest::Client::new();
        let base = format!("http://{addr}");
        let patch = serde_json::json!({ "firewall": { "enabled": true } });
        let resp = gateway_config_request(&client, &base, Some("secret-master-key"), &patch)
            .send()
            .await
            .expect("request sent to oneshot listener");
        assert!(resp.status().is_success());

        let raw = server.await.unwrap();
        let lower = raw.to_ascii_lowercase();
        assert!(
            lower.contains("put /v1/config"),
            "must target PUT /v1/config, got:\n{raw}"
        );
        assert!(
            lower.contains("authorization: bearer secret-master-key"),
            "must forward the master-key bearer, got:\n{raw}"
        );
        assert!(
            raw.contains("\"firewall\""),
            "must carry the config patch body, got:\n{raw}"
        );
    }

    /// The live-config READ (the read-modify-write source for a firewall toggle)
    /// must GET `/v1/config` and forward the gateway bearer, so a remote gateway's
    /// live firewall section is actually readable (else the toggle fail-closed
    /// no-ops remotely). Mirror of the PUT test, driven off a oneshot listener.
    #[tokio::test]
    async fn config_get_request_targets_config_path_and_forwards_bearer() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind oneshot listener");
        let addr = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut raw = Vec::new();
            let mut buf = [0u8; 2048];
            loop {
                match tokio::time::timeout(
                    std::time::Duration::from_millis(500),
                    sock.read(&mut buf),
                )
                .await
                {
                    Ok(Ok(0)) => break,
                    Ok(Ok(n)) => {
                        raw.extend_from_slice(&buf[..n]);
                        // A GET has no body; stop as soon as the header block ends.
                        if String::from_utf8_lossy(&raw).contains("\r\n\r\n") {
                            break;
                        }
                    }
                    _ => break,
                }
            }
            let body = b"{\"firewall\":{\"enabled\":true,\"policy\":\"block\"}}";
            let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len());
            let _ = sock.write_all(head.as_bytes()).await;
            let _ = sock.write_all(body).await;
            String::from_utf8_lossy(&raw).into_owned()
        });

        let client = reqwest::Client::new();
        let base = format!("http://{addr}");
        let resp = gateway_config_get_request(&client, &base, Some("secret-master-key"))
            .send()
            .await
            .expect("request sent to oneshot listener");
        assert!(resp.status().is_success());
        let cfg: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(cfg["firewall"]["policy"], serde_json::json!("block"));

        let raw = server.await.unwrap();
        let lower = raw.to_ascii_lowercase();
        assert!(
            lower.contains("get /v1/config"),
            "must target GET /v1/config, got:\n{raw}"
        );
        assert!(
            lower.contains("authorization: bearer secret-master-key"),
            "must forward the master-key bearer, got:\n{raw}"
        );
    }
}
