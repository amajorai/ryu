//! Gateway config write + status proxy (M2 / U018).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Gateway config write + status proxy (M2 / U018) ─────────────────────────

/// Writable subset of `GatewayConfig` accepted by `PUT /api/gateway/config`.
///
/// Only `firewall`, `routing`, and `budgets` are writable from Core. Provider
/// credentials require an environment-variable change (to avoid ever round-
/// tripping sensitive API keys through Core). All fields are optional — the
/// patch is merged over the existing persisted config.
///
/// The structs mirror the relevant sections of `apps/gateway/src/config.rs`.
/// Because the gateway is a binary crate (no lib target), we cannot import its
/// types; we define a compatible subset here and rely on TOML serialization
/// compatibility. The gateway's `toml::from_str` deserializes the same keys, so
/// the schema must stay in sync. Unknown keys in `gateway.toml` are ignored by
/// the gateway's serde config, making additive changes safe.
#[derive(serde::Deserialize, serde::Serialize, Default)]
pub(in crate::server) struct GatewayConfigPatch {
    #[serde(default)]
    pub(in crate::server) firewall: Option<GatewayFirewallPatch>,
    #[serde(default)]
    pub(in crate::server) routing: Option<GatewayRoutingPatch>,
    #[serde(default)]
    pub(in crate::server) budgets: Option<GatewayBudgetPatch>,
    /// When present, replaces the `[auth]` section's `api_keys` in gateway.toml.
    #[serde(default)]
    pub(in crate::server) auth: Option<GatewayAuthPatch>,
}

/// Subset of the gateway's `FirewallConfig` exposed for Core writes.
///
/// Scalar fields are declared first and the array-of-tables (`custom_patterns`)
/// last so the serialized `[firewall]` table always emits values before tables —
/// avoiding the toml crate's `ValueAfterTable` error when the merged config is
/// re-serialized (`write_gateway_toml`).
#[derive(serde::Deserialize, serde::Serialize)]
pub(in crate::server) struct GatewayFirewallPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::server) enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::server) scan_inbound: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::server) scan_outbound: Option<bool>,
    /// "block" | "warn_and_continue" | "sanitize"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::server) policy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::server) log_detections: Option<bool>,
    /// Redact PII patterns when `policy = sanitize` (DLP card). Dropped before
    /// this was added, so the desktop DLP toggles never persisted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(in crate::server) redact_pii: Option<bool>,
    /// Redact secret patterns (API keys, tokens, PEM keys) when
    /// `policy = sanitize` (DLP card).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(in crate::server) redact_secrets: Option<bool>,
    /// User-defined firewall patterns authored in the desktop custom-pattern
    /// editor (node scope). `None` leaves the persisted set untouched; `Some([])`
    /// clears it (full replacement, matching the editor's read-modify-write). The
    /// gateway reads these from `[firewall].custom_patterns` and merges them onto
    /// the curated built-in sets when the scanner is (re)built. Declared last so
    /// this array-of-tables serializes after every scalar (see the type doc).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(in crate::server) custom_patterns: Option<Vec<GatewayCustomPatternPatch>>,
}

/// A single user-defined firewall pattern accepted by Core's config write.
/// Mirrors `apps/gateway/src/config.rs::CustomPattern`. `kind` is passed through
/// verbatim as a snake_case string ("pii" | "secret" | "prompt_injection" | …);
/// an empty `kind` is omitted so the gateway applies its own default (`pii`).
#[derive(serde::Deserialize, serde::Serialize)]
pub(in crate::server) struct GatewayCustomPatternPatch {
    pub(in crate::server) name: String,
    pub(in crate::server) regex: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(in crate::server) kind: String,
}

/// Subset of the gateway's `RoutingConfig` exposed for Core writes.
#[derive(serde::Deserialize, serde::Serialize)]
pub(in crate::server) struct GatewayRoutingPatch {
    /// Provider to use when no model-map entry matches.
    /// One of: "openai", "anthropic", "local", "openrouter", "core".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::server) default_provider: Option<String>,
    /// Ordered fallback chain, same provider names.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::server) fallback_chain: Option<Vec<String>>,
}

/// Subset of the gateway's `BudgetConfig` exposed for Core writes.
/// Each entry maps an id (user or agent) to a charged-cost limit in micro-USD
/// plus its action.
#[derive(serde::Deserialize, serde::Serialize, Default)]
pub(in crate::server) struct GatewayBudgetPatch {
    /// Per-user budgets keyed by user id.
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub(in crate::server) users: std::collections::HashMap<String, GatewayBudgetRule>,
    /// Per-agent budgets keyed by agent id.
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub(in crate::server) agents: std::collections::HashMap<String, GatewayBudgetRule>,
    /// A single global per-session budget rule (#510). Mirrors the gateway's
    /// `SessionBudgetConfig`, which shares `BudgetRule`'s shape. Omitted when
    /// unset so it never clobbers an existing `[budgets.session]`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(in crate::server) session: Option<GatewayBudgetRule>,
}

/// A single budget rule: lifetime charged-cost cap in micro-USD and the
/// enforcement action.
/// Mirrors `apps/gateway/src/config.rs::BudgetRule`.
#[derive(serde::Deserialize, serde::Serialize)]
pub(in crate::server) struct GatewayBudgetRule {
    /// Lifetime charged-cost cap in micro-USD. 1_000_000 = $1; 0 = unlimited.
    pub(in crate::server) limit: u64,
    /// "notify" | "downgrade" | "restrict" | "stop"
    #[serde(default = "default_budget_action")]
    pub(in crate::server) action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(in crate::server) downgrade_to: Option<String>,
    /// Notification fan-out tier, preserved through Core's typed write proxy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(in crate::server) alert: Option<String>,
    /// Cap applied to `max_tokens` when `action = restrict`. Preserved through
    /// the write path so a save never drops a hand-set value (the gateway
    /// defaults it to 256 when omitted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(in crate::server) restrict_max_tokens: Option<u64>,
    /// Charged work categories included in this rule. Preserved through Core's
    /// typed write proxy so a save cannot silently reset an agent's spend scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(in crate::server) include: Option<GatewayBudgetInclusion>,
}

#[derive(serde::Deserialize, serde::Serialize)]
pub(in crate::server) struct GatewayBudgetInclusion {
    pub(in crate::server) model: bool,
    pub(in crate::server) media: bool,
    pub(in crate::server) tools: bool,
}

pub(in crate::server) fn default_budget_action() -> String {
    "notify".to_string()
}

/// Auth section of gateway.toml: the list of per-client API keys.
/// Only `api_keys` is writable from Core; `master_key` and `require_auth`
/// are startup-only (env vars) to prevent lockout.
#[derive(serde::Deserialize, serde::Serialize, Default)]
pub(in crate::server) struct GatewayAuthPatch {
    /// Full replacement list of API keys.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(in crate::server) api_keys: Vec<GatewayApiKeyEntry>,
    /// Whether to enable auth (require a key on every request).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::server) require_auth: Option<bool>,
}

/// A single API key entry. Mirrors `apps/gateway/src/config.rs::ApiKeyConfig`.
#[derive(serde::Deserialize, serde::Serialize)]
pub(in crate::server) struct GatewayApiKeyEntry {
    pub key: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default)]
    pub trusted_forwarder: bool,
}

/// Resolve the path of `gateway.toml` using the same logic as the gateway's
/// `GatewayConfig::config_path()` so writes land where the gateway reads.
pub(crate) fn gateway_config_path() -> Option<std::path::PathBuf> {
    std::env::var("GATEWAY_CONFIG")
        .ok()
        .map(std::path::PathBuf::from)
        .or_else(|| {
            dirs::config_dir().map(|directory| {
                directory
                    .join(format!("ryu{}", crate::profile::suffix()))
                    .join("gateway.toml")
            })
        })
}

pub(in crate::server) fn gateway_config_document(
    transaction: &ryu_gw_credentials::ConfigFileTransaction,
) -> Result<toml::Value, String> {
    if !transaction.snapshot().exists() {
        return Ok(toml::Value::Table(toml::map::Map::new()));
    }
    let raw = std::str::from_utf8(transaction.snapshot().bytes())
        .map_err(|_| "Gateway configuration is not valid UTF-8")?;
    // Secrets are sealed on disk (`encc:v1:`); editors work on the opened
    // document so account ids hash the plaintext, and `commit` seals again.
    let raw = ryu_gw_credentials::sealed_config::open_text(raw).map_err(|error| match error {
        ryu_gw_credentials::sealed_config::SealedConfigError::Syntax => {
            "Gateway configuration is invalid; repair it before editing accounts".to_owned()
        }
        error => error.to_string(),
    })?;
    let document = toml::from_str::<toml::Value>(&raw)
        .map_err(|_| "Gateway configuration is invalid; repair it before editing accounts")?;
    if let Some(providers) = document.get("providers") {
        let providers = providers.as_table().ok_or("providers must be a table")?;
        if let Some(compatible) = providers.get("compatible") {
            if !compatible.is_table() {
                return Err("compatible providers must be a table".into());
            }
        }
    }
    Ok(document)
}

pub(in crate::server) fn gateway_config_transaction_error(
    error: ryu_gw_credentials::ConfigCommitError,
) -> (StatusCode, Json<serde_json::Value>) {
    match error {
        ryu_gw_credentials::ConfigCommitError::Conflict { current_revision } => (
            StatusCode::CONFLICT,
            Json(
                json!({"success":false,"code":"config_revision_conflict","error":"Gateway configuration changed; refresh before saving","currentRevision":current_revision}),
            ),
        ),
        ryu_gw_credentials::ConfigCommitError::SealingBlocked(reason) => (
            StatusCode::CONFLICT,
            Json(json!({"success":false,"code":"gateway_seal_key_required","error":reason})),
        ),
        ryu_gw_credentials::ConfigCommitError::LockTimeout => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(
                json!({"success":false,"code":"config_busy","error":"Gateway configuration is being edited; retry shortly"}),
            ),
        ),
        error => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"success":false,"error":error.to_string()})),
        ),
    }
}
