//! Provider prompt-cache and node-routing request knobs.

use super::*;

/// Node-level provider prompt-cache policy — the serde face of
/// [`ryu_gw_providers::PromptCacheOptions`], which holds the actual injection
/// logic and documents the wire formats and precedence.
///
/// The default mode (`auto`) adds cache markers only for supported model families
/// that need them. An operator can set `mode = "off"` to restore unmarked requests.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct PromptCacheConfig {
    /// `"auto"` (default) | `"off"` | `"explicit"`. `auto` chooses a compatible
    /// marker for supported model families; `explicit` places multiple breakpoints.
    #[serde(default = "prompt_cache_mode")]
    pub mode: String,
    /// `cache_control.ttl`, e.g. `"1h"`. Empty ⇒ the provider default (5 min).
    #[serde(default)]
    pub ttl: String,
    /// Skip injection below this estimated prompt size; under a provider's
    /// minimum cacheable prefix a breakpoint cannot hit but can still bill a
    /// write. 1024 is the smallest documented provider minimum.
    #[serde(default = "prompt_cache_min_prefix_tokens")]
    pub min_prefix_tokens: u64,
    /// Explicit-mode breakpoint budget, clamped to the Anthropic maximum of 4.
    #[serde(default = "prompt_cache_breakpoints")]
    pub breakpoints: usize,
    /// Forward `x-ryu-session-id` as the provider's cache-affinity `session_id`.
    /// Off by default: that header is an audit identifier, and reusing it as a
    /// cache key is a tenancy decision, not plumbing.
    #[serde(default)]
    pub session_affinity: bool,
    /// Honour the per-request `x-ryu-prompt-cache` / `x-ryu-prompt-cache-ttl`
    /// headers. On by default; an operator who needs a node-wide posture (fixed
    /// cost profile, compliance) turns it off so config is the only lever.
    #[serde(default = "default_true")]
    pub allow_request_override: bool,
}

impl Default for PromptCacheConfig {
    fn default() -> Self {
        Self {
            mode: prompt_cache_mode(),
            ttl: String::new(),
            min_prefix_tokens: prompt_cache_min_prefix_tokens(),
            breakpoints: prompt_cache_breakpoints(),
            session_affinity: false,
            allow_request_override: true,
        }
    }
}

/// Node-level policy for the per-request `x-ryu-node-routing` preference channel.
///
/// The defaults reproduce today's behaviour on an untouched install: nothing
/// changes until a caller actually sends the header, and a caller that never
/// sends it never notices this section exists. The size caps exist because the
/// document is parsed BEFORE it is trusted — they bound the work an unauthorized
/// (or merely buggy) sender can make the parser do, and they are byte counts on
/// the wire rather than semantic limits so they can be enforced without decoding.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct NodeRoutingConfig {
    /// Honour the per-request `x-ryu-node-routing` header at all. On by default,
    /// mirroring [`PromptCacheConfig::allow_request_override`]: an operator
    /// running a fixed routing profile (fixed cost envelope, compliance) turns it
    /// off so node config is the only lever and the header is dropped whole.
    #[serde(default = "default_true")]
    pub allow_request_override: bool,
    /// Reject (ignore) an encoded header longer than this many bytes, measured
    /// before base64 decoding. 4096 sits well inside the usual terminating-proxy
    /// per-header limits (nginx 8k, Cloudflare 16k total).
    #[serde(default = "node_routing_max_header_bytes")]
    pub max_header_bytes: usize,
    /// Ignore a document whose DECODED JSON exceeds this many bytes. Bounds the
    /// serde work, which the wire bound alone cannot (base64 expands 4:3).
    #[serde(default = "node_routing_max_doc_bytes")]
    pub max_doc_bytes: usize,
    /// Maximum `fallback` entries considered. Each surviving entry costs a pool
    /// lookup plus a credit-gate evaluation, so this is a work bound, not a
    /// policy one — the clamp already refuses ids outside the fleet chain.
    #[serde(default = "node_routing_max_fallback")]
    pub max_fallback: usize,
    /// Maximum `firewall.custom_patterns` a request may append.
    #[serde(default = "node_routing_max_patterns")]
    pub max_patterns: usize,
    /// Maximum total bytes of regex source across `firewall.custom_patterns`.
    #[serde(default = "node_routing_max_pattern_bytes")]
    pub max_pattern_bytes: usize,
}

pub(super) fn node_routing_max_header_bytes() -> usize {
    4096
}
pub(super) fn node_routing_max_doc_bytes() -> usize {
    3072
}
pub(super) fn node_routing_max_fallback() -> usize {
    16
}
pub(super) fn node_routing_max_patterns() -> usize {
    16
}
pub(super) fn node_routing_max_pattern_bytes() -> usize {
    1024
}

impl Default for NodeRoutingConfig {
    fn default() -> Self {
        Self {
            allow_request_override: true,
            max_header_bytes: node_routing_max_header_bytes(),
            max_doc_bytes: node_routing_max_doc_bytes(),
            max_fallback: node_routing_max_fallback(),
            max_patterns: node_routing_max_patterns(),
            max_pattern_bytes: node_routing_max_pattern_bytes(),
        }
    }
}

impl PromptCacheConfig {
    /// Resolve into the provider-side policy. An unparseable `mode` falls back
    /// to `Off` rather than guessing: a typo must not silently start billing
    /// cache writes. An unsupported `ttl` likewise degrades to the provider
    /// default instead of being forwarded — an arbitrary value is rejected
    /// upstream mid-request, and on the Anthropic path it would also trigger the
    /// extended-TTL beta header. Same closed set Core validates against, so the
    /// two layers cannot disagree about what a legal TTL is.
    pub fn options(&self) -> ryu_gw_providers::PromptCacheOptions {
        let ttl = self.ttl.trim().to_ascii_lowercase();
        ryu_gw_providers::PromptCacheOptions {
            mode: ryu_gw_providers::PromptCacheMode::parse(&self.mode)
                .unwrap_or(ryu_gw_providers::PromptCacheMode::Off),
            ttl: ryu_gw_providers::prompt_cache::is_supported_ttl(&ttl).then_some(ttl),
            min_prefix_tokens: self.min_prefix_tokens,
            breakpoints: self.breakpoints,
            session_affinity: self.session_affinity,
        }
    }
}

pub(super) fn prompt_cache_mode() -> String {
    "auto".to_string()
}
pub(super) fn prompt_cache_min_prefix_tokens() -> u64 {
    1024
}
pub(super) fn prompt_cache_breakpoints() -> usize {
    2
}
