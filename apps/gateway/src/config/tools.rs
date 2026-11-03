//! Unified tool loop and context-compression config.

use super::*;

/// Unified search-based tool loop (#475, P2). The gateway injects a `tool_search`
/// meta-tool on the openai-compat chat plane and runs a buffered tool-call loop
/// against Core's unified tool catalog when the request carries the tool signal.
///
/// `enabled` defaults true: the no-signal fast path is preserved (plain chat
/// streams directly), so enabling it costs nothing until a request opts in via
/// `x-ryu-tools` / `x-ryu-tool-search`. Nothing hardcoded — every knob is a
/// swappable default.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ToolsConfig {
    /// Master switch for the unified tool loop. Default: true.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Tool definitions always injected (and always allowlisted) for every
    /// tool-active request. Default: empty. Each entry is an OpenAI tool def.
    #[serde(default)]
    pub always_on: Vec<serde_json::Value>,
    /// Maximum tool-call rounds before returning the last turn. Default: 6.
    #[serde(default = "default_tools_max_rounds")]
    pub max_rounds: u8,
    /// How many top search hits to describe + inject per `tool_search`. Default: 5.
    #[serde(default = "default_describe_top_n")]
    pub describe_top_n: usize,
    /// How many contiguous read-only tool calls of one model step the unified
    /// loop runs at once. Only tools Core describes as read-only (an MCP
    /// `readOnlyHint: true` without `destructiveHint: true`) qualify; every other
    /// call, `tool_search`, and denied calls run one at a time. Results are
    /// always appended in call order. Default: 4. `1` (or `0`) disables
    /// concurrency; values above 8 are clamped to 8.
    #[serde(default = "default_tools_parallel_reads")]
    pub parallel_reads: usize,
    /// Named tool-policy profiles (presets) layered ABOVE the per-request
    /// `x-ryu-tools` allowlist, modeled on OpenClaw's profile layering
    /// (profile → allow/deny → sandbox, checked in that order). A request
    /// selects one by name via `x-ryu-tool-profile`; the gateway resolves it to
    /// an effective allowlist (see `effective_tool_allowlist`). Default: empty
    /// map ⇒ no profiles ⇒ the allowlist path is byte-for-byte unchanged. An
    /// unknown/typo'd profile name falls back to today's behavior, never deny-all.
    #[serde(default)]
    pub profiles: HashMap<String, ToolProfile>,
}

/// A named tool-policy profile (preset). Resolves to an allowlist that an
/// explicit per-request `x-ryu-tools` allow/deny still overrides.
///
/// Resolution (in `effective_tool_allowlist`): seed the allow set from `allow`
/// (or the wildcard `"*"` when `unrestricted`), union the explicit
/// `x-ryu-tools` CSV on top, then strip any id listed in `deny` (deny wins over
/// allow). `always_on` tools are appended last and are never deny-stripped.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct ToolProfile {
    /// Fully-qualified tool ids this profile grants. Ignored when `unrestricted`.
    #[serde(default)]
    pub allow: Vec<String>,
    /// Fully-qualified tool ids this profile denies. Deny wins over `allow` and
    /// over the per-request `x-ryu-tools` grant. Does not strip `always_on`.
    #[serde(default)]
    pub deny: Vec<String>,
    /// The "full"/unrestricted preset: resolves the allow set to the wildcard
    /// `"*"`, which `ToolLoopContext::is_allowed` treats as allow-any. Opt-in:
    /// only a request that explicitly selects this profile gets the wildcard.
    #[serde(default)]
    pub unrestricted: bool,
}

pub(super) fn default_tools_max_rounds() -> u8 {
    6
}
pub(super) fn default_describe_top_n() -> usize {
    5
}
pub(super) fn default_tools_parallel_reads() -> usize {
    4
}

impl Default for ToolsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            always_on: Vec::new(),
            max_rounds: default_tools_max_rounds(),
            describe_top_n: default_describe_top_n(),
            parallel_reads: default_tools_parallel_reads(),
            profiles: HashMap::new(),
        }
    }
}

/// Context compression (M2 / #425). When enabled, the gateway sends the request
/// messages to an external compression service (headroom's `/v1/compress`)
/// before the upstream provider call and swaps in the compressed result. This
/// is the egress transform that auto-wraps every gateway-routed agent. It fails
/// open: any error leaves the original messages untouched so chat never breaks
/// when the service is absent.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CompressionConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Base URL of the compression service. Default: headroom proxy on :8787.
    #[serde(default = "default_compression_url")]
    pub url: String,
    /// Optional bearer token for the compression service.
    pub token: Option<String>,
    /// Per-request timeout in milliseconds. Default: 4000.
    #[serde(default = "default_compression_timeout_ms")]
    pub timeout_ms: u64,
    /// Only compress requests carrying at least this many messages; short
    /// single-turn prompts rarely benefit and add a round-trip. Default: 4.
    #[serde(default = "default_compression_min_messages")]
    pub min_messages: usize,
}

pub(super) fn default_compression_url() -> String {
    "http://127.0.0.1:8787".to_string()
}
pub(super) fn default_compression_timeout_ms() -> u64 {
    4000
}
pub(super) fn default_compression_min_messages() -> usize {
    4
}

impl Default for CompressionConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            url: default_compression_url(),
            token: None,
            timeout_ms: default_compression_timeout_ms(),
            min_messages: default_compression_min_messages(),
        }
    }
}
