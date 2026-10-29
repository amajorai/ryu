//! Provider prompt-cache control: deciding what cache markers (if any) ryu adds
//! to an outgoing chat payload.
//!
//! This is *provider-side prompt caching* — the upstream keeping a prefix of the
//! prompt warm so a repeated prefix is billed at a discount. It is unrelated to
//! the gateway's own exact/semantic **response** cache, which answers before a
//! provider is ever called.
//!
//! # Default policy
//!
//! The default [`PromptCacheMode::Auto`] adds a provider-compatible marker only
//! for model families that need one. Cache writes may cost more than ordinary
//! input tokens, so callers can disable injection with `mode = "off"`; a
//! caller's own markers always win. Provider-side automatic caching can still
//! apply when ryu adds no marker.
//! Automatic markers use the provider's short default TTL; longer TTLs remain
//! an explicit cost choice.
//!
//! # Precedence
//!
//! Highest wins:
//!
//! 1. **Markers already in the caller's body** — if the payload carries any
//!    cache marker, nothing is injected and the body is forwarded verbatim.
//! 2. **Per-request override** — the `x-ryu-prompt-cache` header, resolved by
//!    the pipeline into [`PromptCacheRequest::override_mode`].
//! 3. **Node config** — `[prompt_cache]` in `gateway.toml` / `RYU_PROMPT_CACHE_*`.
//! 4. **Auto** — the default.
//!
//! # Wire formats
//!
//! Which marker is correct depends on the model family, so the dialect is
//! derived from the model id ([`PromptCacheDialect::for_model`]) rather than
//! hardcoded per model:
//!
//! - **Anthropic-style**: Claude supports top-level automatic caching; supported
//!   Qwen/DeepSeek and older Gemini routes need a per-message `cache_control`
//!   breakpoint. Explicit placement supports up to 4 breakpoints.
//! - **OpenAI-style**: caches automatically with no marker; explicit control is
//!   `prompt_cache_breakpoint` on a text block plus `prompt_cache_options` at the
//!   root. Sticky routing uses `prompt_cache_key`.
//! - **Automatic**: no marker is added; this includes OpenAI, Gemini 2.5+,
//!   DeepSeek models other than V3.2, Grok, Groq, Moonshot, and Z.AI.
//!
//! [`Auto`]: PromptCacheMode::Auto

use serde_json::{json, Value};

/// Anthropic's hard limit on explicit `cache_control` breakpoints per request.
pub const MAX_BREAKPOINTS: usize = 4;

/// OpenRouter's documented maximum length for a `session_id`. Enforced in
/// **bytes**, not chars: the limit upstream is on the encoded value, so a
/// multibyte id truncated by char count could still exceed it and be rejected.
pub const MAX_SESSION_ID_LEN: usize = 256;

/// The `cache_control.ttl` values the providers document. A TTL outside this set
/// is rejected upstream mid-request, and on the Anthropic path it also decides
/// whether the extended-TTL beta header is sent — so an unknown value is dropped
/// rather than forwarded. Mirrors `is_prompt_cache_ttl` in Core.
pub const SUPPORTED_TTLS: [&str; 2] = ["5m", "1h"];

/// Whether `ttl` is one of [`SUPPORTED_TTLS`].
pub fn is_supported_ttl(ttl: &str) -> bool {
    SUPPORTED_TTLS.contains(&ttl)
}

/// How much ryu does on the caller's behalf.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PromptCacheMode {
    /// Hand marker placement to the provider when supported. Uses top-level
    /// automatic caching for Claude and one content-block breakpoint for model
    /// families that require explicit markers. The default.
    #[default]
    Auto,
    /// Inject nothing. Caller-supplied markers and provider-side implicit
    /// caching still work.
    Off,
    /// Place breakpoints ourselves: on the system prompt and the trailing
    /// conversation turns, up to [`PromptCacheOptions::breakpoints`].
    Explicit,
}

impl PromptCacheMode {
    /// Parse a config value or the `x-ryu-prompt-cache` header. Unknown values
    /// return `None` so the caller can fall through to the next precedence level
    /// rather than silently enabling a billing-relevant feature on a typo.
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "off" | "false" | "0" | "none" => Some(Self::Off),
            "auto" | "on" | "true" | "1" => Some(Self::Auto),
            "explicit" | "manual" => Some(Self::Explicit),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Auto => "auto",
            Self::Explicit => "explicit",
        }
    }
}

/// The marker vocabulary a model family understands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptCacheDialect {
    /// `cache_control: { type: "ephemeral" }` breakpoints (Claude, Qwen, Gemini).
    Anthropic,
    /// `prompt_cache_breakpoint` / `prompt_cache_key` (GPT, o-series).
    OpenAi,
    /// Caches automatically with no request-side marker at all.
    Automatic,
}

impl PromptCacheDialect {
    /// Derive the dialect from a model id. The explicit-cache Qwen set is kept
    /// aligned with OpenRouter's published support; unknown snapshots are not
    /// opted into explicit caching by a broad `qwen` match.
    pub fn for_model(model: &str) -> Self {
        let id = model.to_ascii_lowercase();
        if id.contains("claude") || id.contains("anthropic") {
            return Self::Anthropic;
        }
        if has_explicit_qwen_cache(&id) || id.contains("deepseek-v3.2") {
            return Self::Anthropic;
        }
        if id.contains("gemini") {
            return if gemini_implicit_cache(&id) {
                Self::Automatic
            } else {
                Self::Anthropic
            };
        }
        if id.contains("gpt") || id.contains("o1") || id.contains("o3") || id.contains("o4") {
            return Self::OpenAi;
        }
        Self::Automatic
    }
}

/// GPT-5.6 and later accept `prompt_cache_options` / `prompt_cache_breakpoint`;
/// earlier models only cache implicitly.
fn openai_explicit_cache(model: &str) -> bool {
    let id = model.to_ascii_lowercase();
    let Some(start) = id.find("gpt-") else {
        return false;
    };
    let digits = |text: &str| -> (Option<u32>, usize) {
        let len = text.chars().take_while(char::is_ascii_digit).count();
        (text[..len].parse().ok(), len)
    };
    let version = &id[start + 4..];
    let (Some(major), len) = digits(version) else {
        return false;
    };
    let minor = version[len..]
        .strip_prefix('.')
        .and_then(|rest| digits(rest).0)
        .unwrap_or(0);
    major > 5 || (major == 5 && minor >= 6)
}

fn has_explicit_qwen_cache(id: &str) -> bool {
    [
        "qwen3-max",
        "qwen-plus",
        "qwen3.6-plus",
        "qwen3-coder-plus",
        "qwen3-coder-flash",
    ]
    .iter()
    .any(|model| id.contains(model))
}

fn gemini_implicit_cache(id: &str) -> bool {
    let Some(version) = id
        .split("gemini-")
        .nth(1)
        .and_then(|tail| tail.split('-').next())
    else {
        return false;
    };
    let mut parts = version.split('.');
    let Some(major) = parts.next().and_then(|part| part.parse::<u32>().ok()) else {
        return false;
    };
    let minor = parts
        .next()
        .and_then(|part| part.parse::<u32>().ok())
        .unwrap_or(0);
    major > 2 || (major == 2 && minor >= 5)
}

/// Node-level prompt-cache policy. Held in gateway config; resolved per request
/// against a [`PromptCacheRequest`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptCacheOptions {
    /// Default mode for requests that do not override it.
    pub mode: PromptCacheMode,
    /// `cache_control.ttl` to request. `None` ⇒ the provider default (5 min).
    /// A non-default TTL costs more to write, so it is opt-in like the mode.
    pub ttl: Option<String>,
    /// Skip injection when the estimated prompt is smaller than this. Below a
    /// provider's minimum cacheable prefix a breakpoint does nothing but can
    /// still incur a write, so the floor is a cost guard, not an optimisation.
    /// Defaults to 1024 — the smallest documented minimum across providers
    /// (OpenAI all models, Anthropic Sonnet/Opus 4.x, Gemini 2.5 Flash); models
    /// with a higher floor (4096) simply no-op on the provider side.
    pub min_prefix_tokens: u64,
    /// Maximum breakpoints placed in [`PromptCacheMode::Explicit`]. Clamped to
    /// [`MAX_BREAKPOINTS`].
    pub breakpoints: usize,
    /// Forward ryu's conversation id as OpenRouter's `session_id` (sticky
    /// routing: requests sharing an id are pinned to one provider so its cache
    /// is reachable).
    ///
    /// **Default off, deliberately.** `x-ryu-session-id` exists for ryu's own
    /// audit correlation. OpenRouter's `session_id` is a cache-affinity key, so
    /// joining the two namespaces makes an audit identifier decide which
    /// requests can share a warm cache. That is a tenancy decision an operator
    /// must make explicitly.
    pub session_affinity: bool,
}

impl Default for PromptCacheOptions {
    fn default() -> Self {
        Self {
            mode: PromptCacheMode::Auto,
            ttl: None,
            min_prefix_tokens: 1024,
            breakpoints: 2,
            session_affinity: false,
        }
    }
}

/// Per-request inputs the node policy is resolved against.
#[derive(Debug, Clone, Default)]
pub struct PromptCacheRequest<'a> {
    /// Routed model id — selects the marker dialect.
    pub model: &'a str,
    /// Per-request mode from `x-ryu-prompt-cache`. Overrides the node default.
    pub override_mode: Option<PromptCacheMode>,
    /// Per-request TTL from `x-ryu-prompt-cache-ttl`.
    pub override_ttl: Option<String>,
    /// The pipeline's prompt-size estimate, checked against `min_prefix_tokens`.
    /// `None` skips the floor check (the estimate is unavailable, so refusing to
    /// inject would make the feature silently inert).
    pub estimated_input_tokens: Option<u64>,
    /// ryu conversation id, used only when `session_affinity` is on.
    pub session_id: Option<&'a str>,
}

/// What [`PromptCacheOptions::apply`] did, for logging and the response headers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptCacheOutcome {
    /// Injection is off for this request.
    Disabled,
    /// The request body carries a *root-level* marker (`cache_control`,
    /// `prompt_cache_key`, `prompt_cache_options`) — the caller is driving, so
    /// the body was forwarded verbatim.
    CallerSupplied,
    /// A `cache_control` / `prompt_cache_breakpoint` was already present inside
    /// `messages` or `tools`, so injection was suppressed and the body forwarded
    /// verbatim.
    ///
    /// Reported separately from [`Self::CallerSupplied`] because the two look
    /// identical from outside but mean different things. A single stray marker —
    /// left by a plugin turn hook, a Pi body stamped
    /// `compat.cacheControlFormat: "anthropic"`, or a client replaying a prior
    /// turn's marked messages — suppresses the node's whole policy. Without its
    /// own label that is indistinguishable from "the caller marked everything
    /// deliberately", and an operator would see zero breakpoints with no way to
    /// tell why.
    CallerBreakpoints,
    /// The model family caches automatically — no marker exists to add.
    AutomaticProvider,
    /// The prompt is below `min_prefix_tokens`, so a breakpoint would be inert.
    BelowMinimum,
    /// Markers were injected. Carries how many breakpoints were placed (0 for
    /// [`PromptCacheMode::Auto`], which delegates placement to the provider).
    Injected { breakpoints: usize },
}

impl PromptCacheOutcome {
    /// Stable label for the `x-ryu-prompt-cache` response header.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::CallerSupplied => "caller",
            Self::CallerBreakpoints => "caller-breakpoints",
            Self::AutomaticProvider => "automatic",
            Self::BelowMinimum => "below-minimum",
            Self::Injected { .. } => "injected",
        }
    }
}

impl PromptCacheOptions {
    /// Apply this policy to an outgoing chat-completions payload.
    ///
    /// Never overwrites a marker the caller supplied, and never touches a
    /// payload that is not a JSON object. See the module docs for precedence.
    pub fn apply(&self, payload: &mut Value, req: &PromptCacheRequest<'_>) -> PromptCacheOutcome {
        let mode = req.override_mode.unwrap_or(self.mode);
        if mode == PromptCacheMode::Off {
            return PromptCacheOutcome::Disabled;
        }
        let Some(obj) = payload.as_object_mut() else {
            return PromptCacheOutcome::Disabled;
        };
        if has_root_markers(obj, PromptCacheDialect::for_model(req.model)) {
            return PromptCacheOutcome::CallerSupplied;
        }
        if has_message_markers(obj) {
            return PromptCacheOutcome::CallerBreakpoints;
        }

        // Session affinity is independent of the marker dialect: it pins the
        // request to one provider so *any* warm cache stays reachable. Apply it
        // before the dialect and floor checks bail out.
        // A caller's own `session_id` is never overwritten.
        let mut applied_session = false;
        if self.session_affinity && !obj.contains_key("session_id") {
            if let Some(sid) = session_key(req.session_id) {
                obj.insert("session_id".into(), Value::String(sid));
                applied_session = true;
            }
        }

        let dialect = PromptCacheDialect::for_model(req.model);
        if dialect == PromptCacheDialect::Automatic {
            return PromptCacheOutcome::AutomaticProvider;
        }
        if let Some(estimate) = req.estimated_input_tokens {
            if estimate < self.min_prefix_tokens {
                return PromptCacheOutcome::BelowMinimum;
            }
        }

        let ttl = req.override_ttl.clone().or_else(|| self.ttl.clone());

        match (dialect, mode) {
            // OpenAI caches automatically; the only useful knob is the sticky
            // key, and `prompt_cache_options` for explicit-mode control. Explicit
            // breakpoints exist only on GPT-5.6 and later; older models reject the
            // fields, so they keep implicit caching. No `ttl` is sent: OpenAI accepts
            // only "30m" (its default), and the configured "5m"/"1h" lifetimes are
            // Anthropic values that would fail the request.
            (PromptCacheDialect::OpenAi, _) => {
                if let Some(sid) = session_key(req.session_id) {
                    obj.insert("prompt_cache_key".into(), Value::String(sid));
                }
                if mode == PromptCacheMode::Explicit && openai_explicit_cache(req.model) {
                    obj.insert("prompt_cache_options".into(), json!({ "mode": "explicit" }));
                    let placed = place_openai_breakpoints(obj, self.effective_breakpoints());
                    return PromptCacheOutcome::Injected {
                        breakpoints: placed,
                    };
                }
                if applied_session || obj.contains_key("prompt_cache_key") {
                    return PromptCacheOutcome::Injected { breakpoints: 0 };
                }
                PromptCacheOutcome::AutomaticProvider
            }
            // One top-level marker; OpenRouter picks the last cacheable block.
            (PromptCacheDialect::Anthropic, PromptCacheMode::Auto) => {
                if req.model.to_ascii_lowercase().contains("claude")
                    || req.model.to_ascii_lowercase().contains("anthropic")
                {
                    obj.insert("cache_control".into(), ephemeral(ttl.as_deref()));
                    PromptCacheOutcome::Injected { breakpoints: 0 }
                } else {
                    let placed = place_anthropic_breakpoints(obj, 1, ttl.as_deref());
                    PromptCacheOutcome::Injected {
                        breakpoints: placed,
                    }
                }
            }
            (PromptCacheDialect::Anthropic, PromptCacheMode::Explicit) => {
                let placed =
                    place_anthropic_breakpoints(obj, self.effective_breakpoints(), ttl.as_deref());
                PromptCacheOutcome::Injected {
                    breakpoints: placed,
                }
            }
            (_, PromptCacheMode::Off) => PromptCacheOutcome::Disabled,
            (PromptCacheDialect::Automatic, _) => PromptCacheOutcome::AutomaticProvider,
        }
    }

    fn effective_breakpoints(&self) -> usize {
        self.breakpoints.clamp(1, MAX_BREAKPOINTS)
    }
}

/// A non-empty session id truncated to the provider's documented maximum,
/// measured in bytes and cut on a char boundary so the result stays valid UTF-8.
fn session_key(session_id: Option<&str>) -> Option<String> {
    let sid = session_id?.trim();
    if sid.is_empty() {
        return None;
    }
    if sid.len() <= MAX_SESSION_ID_LEN {
        return Some(sid.to_string());
    }
    let mut end = MAX_SESSION_ID_LEN;
    while end > 0 && !sid.is_char_boundary(end) {
        end -= 1;
    }
    Some(sid[..end].to_string())
}

fn ephemeral(ttl: Option<&str>) -> Value {
    match ttl {
        Some(ttl) => json!({ "type": "ephemeral", "ttl": ttl }),
        None => json!({ "type": "ephemeral" }),
    }
}

/// True when the payload carries a root-level prompt-cache marker — the signal
/// that the caller is driving caching itself.
///
/// `session_id` is deliberately NOT one of these: it is a routing-affinity key,
/// not a cache marker, and a caller that sets one should still get the node's
/// configured breakpoints. It is instead never overwritten.
///
/// `prompt_cache_key` / `prompt_cache_options` are OpenAI knobs: an
/// Anthropic-dialect provider ignores them, so they must not stand in for a
/// breakpoint there. A Responses request forwarding its `prompt_cache_key` to a
/// Claude model otherwise suppressed injection and got no caching at all.
fn has_root_markers(obj: &serde_json::Map<String, Value>, dialect: PromptCacheDialect) -> bool {
    if dialect == PromptCacheDialect::Anthropic {
        return obj.contains_key("cache_control");
    }
    const ROOT_KEYS: [&str; 3] = ["cache_control", "prompt_cache_key", "prompt_cache_options"];
    ROOT_KEYS.iter().any(|k| obj.contains_key(*k))
}

/// True when a marker already sits on a content block inside `messages` or
/// `tools`. Injection is suppressed either way — placing more breakpoints could
/// push past the provider's four-breakpoint cap and would silently relocate a
/// prefix the caller chose — but the caller learns *which* condition applied
/// (see [`PromptCacheOutcome::CallerBreakpoints`]).
fn has_message_markers(obj: &serde_json::Map<String, Value>) -> bool {
    fn walk(v: &Value) -> bool {
        match v {
            Value::Object(map) => {
                map.contains_key("cache_control")
                    || map.contains_key("prompt_cache_breakpoint")
                    || map.values().any(walk)
            }
            Value::Array(items) => items.iter().any(walk),
            _ => false,
        }
    }
    obj.get("messages").is_some_and(walk) || obj.get("tools").is_some_and(walk)
}

/// Indices of the messages worth caching, most valuable first: the system
/// prompt (a stable prefix every turn reuses), then the trailing turns (so a
/// multi-turn conversation keeps extending its own warm prefix).
fn breakpoint_targets(messages: &[Value], limit: usize) -> Vec<usize> {
    let mut targets: Vec<usize> = Vec::new();
    for (i, m) in messages.iter().enumerate() {
        if m["role"] == json!("system") {
            targets.push(i);
        }
    }
    // Trailing turns, latest first, skipping any already picked as system.
    for i in (0..messages.len()).rev() {
        if targets.len() >= limit {
            break;
        }
        if !targets.contains(&i) {
            targets.push(i);
        }
    }
    targets.truncate(limit);
    targets.sort_unstable();
    targets
}

/// Convert a message's `content` to a block array in place and return it, so a
/// marker can be attached to its last block. A string becomes one `text` block;
/// anything unrecognised yields `None` and is left alone.
fn content_blocks_mut(message: &mut Value) -> Option<&mut Vec<Value>> {
    let content = message.get_mut("content")?;
    if let Value::String(s) = content {
        *content = json!([{ "type": "text", "text": s }]);
    }
    content.as_array_mut().filter(|blocks| !blocks.is_empty())
}

fn place_anthropic_breakpoints(
    obj: &mut serde_json::Map<String, Value>,
    limit: usize,
    ttl: Option<&str>,
) -> usize {
    let Some(messages) = obj.get_mut("messages").and_then(Value::as_array_mut) else {
        return 0;
    };
    let targets = breakpoint_targets(messages, limit);
    let mut placed = 0;
    for i in targets {
        let Some(blocks) = content_blocks_mut(&mut messages[i]) else {
            continue;
        };
        if let Some(last) = blocks.last_mut() {
            if let Some(block) = last.as_object_mut() {
                block.insert("cache_control".into(), ephemeral(ttl));
                placed += 1;
            }
        }
    }
    placed
}

fn place_openai_breakpoints(obj: &mut serde_json::Map<String, Value>, limit: usize) -> usize {
    let Some(messages) = obj.get_mut("messages").and_then(Value::as_array_mut) else {
        return 0;
    };
    let targets = breakpoint_targets(messages, limit);
    let mut placed = 0;
    for i in targets {
        let Some(blocks) = content_blocks_mut(&mut messages[i]) else {
            continue;
        };
        if let Some(last) = blocks.last_mut() {
            if let Some(block) = last.as_object_mut() {
                block.insert(
                    "prompt_cache_breakpoint".into(),
                    json!({ "mode": "explicit" }),
                );
                placed += 1;
            }
        }
    }
    placed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body() -> Value {
        json!({
            "model": "anthropic/claude-sonnet-4",
            "messages": [
                { "role": "system", "content": "big stable prefix" },
                { "role": "user", "content": "turn one" },
                { "role": "assistant", "content": "reply" },
                { "role": "user", "content": "turn two" }
            ]
        })
    }

    fn req<'a>(model: &'a str) -> PromptCacheRequest<'a> {
        PromptCacheRequest {
            model,
            estimated_input_tokens: Some(50_000),
            ..Default::default()
        }
    }

    fn opts(mode: PromptCacheMode) -> PromptCacheOptions {
        PromptCacheOptions {
            mode,
            ..Default::default()
        }
    }

    #[test]
    fn default_auto_uses_the_supported_model_marker() {
        let mut claude = body();
        let out =
            PromptCacheOptions::default().apply(&mut claude, &req("anthropic/claude-sonnet-4"));
        assert_eq!(out, PromptCacheOutcome::Injected { breakpoints: 0 });
        assert_eq!(claude["cache_control"], json!({ "type": "ephemeral" }));

        let mut qwen = body();
        let out = PromptCacheOptions::default().apply(&mut qwen, &req("qwen/qwen3-max"));
        assert_eq!(out, PromptCacheOutcome::Injected { breakpoints: 1 });
        assert_eq!(count_breakpoints(&qwen), 1);
        assert!(qwen.get("cache_control").is_none());

        let mut off = body();
        let before = off.clone();
        let out = opts(PromptCacheMode::Off).apply(&mut off, &req("qwen/qwen3-max"));
        assert_eq!(out, PromptCacheOutcome::Disabled);
        assert_eq!(off, before, "off mode must not touch the payload");
    }

    #[test]
    fn auto_adds_one_top_level_marker() {
        let mut b = body();
        let out = opts(PromptCacheMode::Auto).apply(&mut b, &req("anthropic/claude-sonnet-4"));
        assert_eq!(out, PromptCacheOutcome::Injected { breakpoints: 0 });
        assert_eq!(b["cache_control"], json!({ "type": "ephemeral" }));
        // Messages are untouched in auto mode.
        assert_eq!(b["messages"][0]["content"], json!("big stable prefix"));
    }

    #[test]
    fn auto_uses_one_block_breakpoint_for_supported_qwen_and_deepseek() {
        for model in ["qwen/qwen3-coder-plus", "deepseek/deepseek-v3.2"] {
            let mut b = body();
            let out = opts(PromptCacheMode::Auto).apply(&mut b, &req(model));
            assert_eq!(
                out,
                PromptCacheOutcome::Injected { breakpoints: 1 },
                "{model}"
            );
            assert_eq!(count_breakpoints(&b), 1, "{model}");
            assert!(b.get("cache_control").is_none(), "{model}");
        }
    }

    #[test]
    fn unsupported_qwen_snapshots_are_not_marked() {
        for model in [
            "qwen/qwen3.5-plus-02-15",
            "qwen/qwen3.5-flash-02-23",
            "qwen/qwen3-coder",
        ] {
            let mut b = body();
            let before = b.clone();
            let out = opts(PromptCacheMode::Auto).apply(&mut b, &req(model));
            assert_eq!(out, PromptCacheOutcome::AutomaticProvider, "{model}");
            assert_eq!(b, before, "{model}");
        }
    }

    #[test]
    fn auto_carries_the_configured_ttl() {
        let mut b = body();
        let o = PromptCacheOptions {
            mode: PromptCacheMode::Auto,
            ttl: Some("1h".into()),
            ..Default::default()
        };
        o.apply(&mut b, &req("anthropic/claude-sonnet-4"));
        assert_eq!(b["cache_control"]["ttl"], json!("1h"));
    }

    #[test]
    fn explicit_breakpoints_land_on_system_and_last_turn() {
        let mut b = body();
        let out = opts(PromptCacheMode::Explicit).apply(&mut b, &req("anthropic/claude-sonnet-4"));
        assert_eq!(out, PromptCacheOutcome::Injected { breakpoints: 2 });
        // System message became a block array carrying the breakpoint.
        assert_eq!(
            b["messages"][0]["content"][0]["text"],
            json!("big stable prefix")
        );
        assert_eq!(
            b["messages"][0]["content"][0]["cache_control"]["type"],
            json!("ephemeral")
        );
        // Last turn also marked, and the middle turns are not: exactly the two
        // breakpoints the budget allows, never more than the Anthropic maximum.
        assert_eq!(
            b["messages"][3]["content"][0]["cache_control"]["type"],
            json!("ephemeral")
        );
        assert_eq!(count_breakpoints(&b), 2);
    }

    #[test]
    fn explicit_respects_the_breakpoint_budget_and_the_hard_cap() {
        let mut b = body();
        let o = PromptCacheOptions {
            mode: PromptCacheMode::Explicit,
            breakpoints: 99,
            ..Default::default()
        };
        o.apply(&mut b, &req("anthropic/claude-sonnet-4"));
        assert_eq!(count_breakpoints(&b), MAX_BREAKPOINTS);
    }

    #[test]
    fn an_existing_message_breakpoint_suppresses_injection_and_says_so() {
        let mut b = json!({
            "messages": [{ "role": "system", "content": [
                { "type": "text", "text": "mine", "cache_control": { "type": "ephemeral" } }
            ]}]
        });
        let before = b.clone();
        let out = opts(PromptCacheMode::Explicit).apply(&mut b, &req("anthropic/claude-sonnet-4"));
        // Distinct from CallerSupplied: a stray marker left by a turn hook or a
        // replayed transcript suppresses the node's whole policy, and the
        // operator must be able to tell that apart from a deliberate caller.
        assert_eq!(out, PromptCacheOutcome::CallerBreakpoints);
        assert_eq!(out.as_str(), "caller-breakpoints");
        assert_eq!(b, before);
    }

    #[test]
    fn a_marker_on_a_tool_definition_also_suppresses_injection() {
        let mut b = body();
        b["tools"] = json!([{ "type": "function", "function": { "name": "f" },
                             "cache_control": { "type": "ephemeral" } }]);
        let before = b.clone();
        let out = opts(PromptCacheMode::Explicit).apply(&mut b, &req("anthropic/claude-sonnet-4"));
        assert_eq!(out, PromptCacheOutcome::CallerBreakpoints);
        assert_eq!(b, before);
    }

    #[test]
    fn openai_cache_key_does_not_suppress_claude_breakpoints() {
        // A Responses request forwards its `prompt_cache_key`; Anthropic ignores
        // it, so it must not count as the caller driving caching.
        let mut b = body();
        b["prompt_cache_key"] = json!("conv-1");
        let out = opts(PromptCacheMode::Auto).apply(&mut b, &req("claude-sonnet-4-5"));
        assert_eq!(out, PromptCacheOutcome::Injected { breakpoints: 0 });
        assert_eq!(b["cache_control"]["type"], json!("ephemeral"));
    }

    #[test]
    fn root_and_message_markers_are_reported_as_different_outcomes() {
        // Root marker ⇒ the caller is driving caching itself.
        let mut root = body();
        root["prompt_cache_key"] = json!("k");
        assert_eq!(
            opts(PromptCacheMode::Auto).apply(&mut root, &req("openai/gpt-4o")),
            PromptCacheOutcome::CallerSupplied
        );

        // In-message marker ⇒ suppressed, but for a different reason.
        let mut inner = body();
        inner["messages"][1]["content"] =
            json!([{ "type": "text", "text": "x", "cache_control": { "type": "ephemeral" } }]);
        assert_eq!(
            opts(PromptCacheMode::Auto).apply(&mut inner, &req("anthropic/claude-sonnet-4")),
            PromptCacheOutcome::CallerBreakpoints
        );
    }

    #[test]
    fn caller_top_level_marker_also_wins() {
        let mut b = body();
        b["cache_control"] = json!({ "type": "ephemeral", "ttl": "1h" });
        let before = b.clone();
        let out = opts(PromptCacheMode::Auto).apply(&mut b, &req("anthropic/claude-sonnet-4"));
        assert_eq!(out, PromptCacheOutcome::CallerSupplied);
        assert_eq!(b, before);
    }

    #[test]
    fn below_the_minimum_prefix_nothing_is_injected() {
        let mut b = body();
        let mut r = req("anthropic/claude-sonnet-4");
        r.estimated_input_tokens = Some(100);
        let before = b.clone();
        let out = opts(PromptCacheMode::Auto).apply(&mut b, &r);
        assert_eq!(out, PromptCacheOutcome::BelowMinimum);
        assert_eq!(b, before);
    }

    #[test]
    fn a_missing_estimate_does_not_block_injection() {
        let mut b = body();
        let mut r = req("anthropic/claude-sonnet-4");
        r.estimated_input_tokens = None;
        let out = opts(PromptCacheMode::Auto).apply(&mut b, &r);
        assert_eq!(out, PromptCacheOutcome::Injected { breakpoints: 0 });
    }

    #[test]
    fn auto_caching_families_get_no_marker() {
        for model in [
            "deepseek/deepseek-chat",
            "x-ai/grok-4",
            "moonshotai/kimi-k2",
        ] {
            let mut b = body();
            let before = b.clone();
            let out = opts(PromptCacheMode::Auto).apply(&mut b, &req(model));
            assert_eq!(out, PromptCacheOutcome::AutomaticProvider, "{model}");
            assert_eq!(b, before, "{model}");
        }
    }

    #[test]
    fn dialect_is_derived_from_the_model_family() {
        use PromptCacheDialect::{Anthropic, Automatic, OpenAi};
        assert_eq!(
            PromptCacheDialect::for_model("claude-sonnet-4-5"),
            Anthropic
        );
        assert_eq!(
            PromptCacheDialect::for_model("anthropic/claude-opus-4"),
            Anthropic
        );
        assert_eq!(
            PromptCacheDialect::for_model("qwen/qwen3-coder-plus"),
            Anthropic
        );
        assert_eq!(PromptCacheDialect::for_model("openai/gpt-4o"), OpenAi);
        assert_eq!(PromptCacheDialect::for_model("o3-mini"), OpenAi);
        // Gemini 2.5 caches implicitly; older Gemini needs a breakpoint.
        assert_eq!(
            PromptCacheDialect::for_model("google/gemini-2.5-pro"),
            Automatic
        );
        assert_eq!(
            PromptCacheDialect::for_model("google/gemini-3.0-flash"),
            Automatic
        );
        assert_eq!(
            PromptCacheDialect::for_model("google/gemini-1.5-pro"),
            Anthropic
        );
        assert_eq!(
            PromptCacheDialect::for_model("deepseek/deepseek-chat"),
            Automatic
        );
        assert_eq!(
            PromptCacheDialect::for_model("deepseek/deepseek-v3.2"),
            Anthropic
        );
    }

    #[test]
    fn openai_dialect_gets_a_sticky_key_not_a_cache_control() {
        let mut b = body();
        let o = PromptCacheOptions {
            mode: PromptCacheMode::Auto,
            session_affinity: true,
            ..Default::default()
        };
        let mut r = req("openai/gpt-4o");
        r.session_id = Some("conv-123");
        let out = o.apply(&mut b, &r);
        assert_eq!(out, PromptCacheOutcome::Injected { breakpoints: 0 });
        assert_eq!(b["prompt_cache_key"], json!("conv-123"));
        assert!(b.get("cache_control").is_none());
    }

    #[test]
    fn openai_explicit_mode_sets_options_and_breakpoints() {
        let mut b = body();
        let out = opts(PromptCacheMode::Explicit).apply(&mut b, &req("openai/gpt-5.6"));
        assert_eq!(out, PromptCacheOutcome::Injected { breakpoints: 2 });
        assert_eq!(b["prompt_cache_options"], json!({ "mode": "explicit" }));
        assert_eq!(
            b["messages"][0]["content"][0]["prompt_cache_breakpoint"]["mode"],
            json!("explicit")
        );
    }

    #[test]
    fn openai_explicit_mode_never_sends_fields_the_model_rejects() {
        // An Anthropic-style TTL is not an OpenAI value: the option is sent
        // without it rather than failing the request.
        let explicit = |ttl: &str| PromptCacheOptions {
            mode: PromptCacheMode::Explicit,
            ttl: Some(ttl.into()),
            ..Default::default()
        };
        let mut b = body();
        explicit("1h").apply(&mut b, &req("gpt-5.6-terra"));
        assert_eq!(b["prompt_cache_options"], json!({ "mode": "explicit" }));

        // Before GPT-5.6 explicit breakpoints do not exist: implicit caching.
        let mut old = body();
        let out = explicit("1h").apply(&mut old, &req("openai/gpt-4o"));
        assert_eq!(out, PromptCacheOutcome::AutomaticProvider);
        assert!(old.get("prompt_cache_options").is_none());
        assert!(!old.to_string().contains("prompt_cache_breakpoint"));
    }

    #[test]
    fn openai_explicit_cache_starts_at_gpt_5_6() {
        for model in [
            "gpt-5.6",
            "openai/gpt-5.6-terra",
            "gpt-5.10",
            "gpt-6",
            "gpt-6.1-mini",
        ] {
            assert!(openai_explicit_cache(model), "{model}");
        }
        for model in [
            "gpt-4o",
            "gpt-5",
            "gpt-5.5-pro",
            "openai/gpt-5.1",
            "o4-mini",
            "gpt-oss-120b",
        ] {
            assert!(!openai_explicit_cache(model), "{model}");
        }
    }

    #[test]
    fn session_affinity_is_off_by_default() {
        let mut b = body();
        let mut r = req("anthropic/claude-sonnet-4");
        r.session_id = Some("conv-123");
        opts(PromptCacheMode::Auto).apply(&mut b, &r);
        assert!(
            b.get("session_id").is_none(),
            "audit session id must not become a cache-affinity key implicitly"
        );
    }

    #[test]
    fn session_affinity_when_enabled_truncates_to_the_documented_limit() {
        let o = PromptCacheOptions {
            mode: PromptCacheMode::Auto,
            session_affinity: true,
            ..Default::default()
        };

        let mut b = body();
        let long = "x".repeat(400);
        let mut r = req("anthropic/claude-sonnet-4");
        r.session_id = Some(&long);
        o.apply(&mut b, &r);
        assert_eq!(b["session_id"].as_str().unwrap().len(), MAX_SESSION_ID_LEN);

        // Multibyte ids cut on a char boundary and stay within the BYTE limit —
        // truncating by char count would overshoot it and be rejected upstream.
        let mut b = body();
        let wide = "é".repeat(400);
        let mut r = req("anthropic/claude-sonnet-4");
        r.session_id = Some(&wide);
        o.apply(&mut b, &r);
        let sid = b["session_id"].as_str().unwrap();
        assert!(sid.len() <= MAX_SESSION_ID_LEN, "{} bytes", sid.len());
        assert!(sid.chars().all(|c| c == 'é'), "cut mid-character: {sid}");
    }

    #[test]
    fn only_documented_ttls_are_supported() {
        assert!(is_supported_ttl("5m"));
        assert!(is_supported_ttl("1h"));
        for bad in ["10m", "1H", "", "forever"] {
            assert!(!is_supported_ttl(bad), "{bad}");
        }
    }

    #[test]
    fn request_override_beats_node_config_in_both_directions() {
        // node off, request asks for auto
        let mut b = body();
        let mut r = req("anthropic/claude-sonnet-4");
        r.override_mode = Some(PromptCacheMode::Auto);
        assert_eq!(
            PromptCacheOptions::default().apply(&mut b, &r),
            PromptCacheOutcome::Injected { breakpoints: 0 }
        );

        // node auto, request opts out
        let mut b = body();
        let before = b.clone();
        let mut r = req("anthropic/claude-sonnet-4");
        r.override_mode = Some(PromptCacheMode::Off);
        assert_eq!(
            opts(PromptCacheMode::Auto).apply(&mut b, &r),
            PromptCacheOutcome::Disabled
        );
        assert_eq!(b, before);
    }

    #[test]
    fn mode_parses_the_documented_spellings_and_rejects_typos() {
        assert_eq!(PromptCacheMode::parse("off"), Some(PromptCacheMode::Off));
        assert_eq!(
            PromptCacheMode::parse(" AUTO "),
            Some(PromptCacheMode::Auto)
        );
        assert_eq!(PromptCacheMode::parse("on"), Some(PromptCacheMode::Auto));
        assert_eq!(
            PromptCacheMode::parse("explicit"),
            Some(PromptCacheMode::Explicit)
        );
        assert_eq!(PromptCacheMode::parse("aut0"), None);
        assert_eq!(PromptCacheMode::parse(""), None);
    }

    #[test]
    fn non_object_payloads_are_left_alone() {
        let mut b = json!("not an object");
        let out = opts(PromptCacheMode::Auto).apply(&mut b, &req("claude"));
        assert_eq!(out, PromptCacheOutcome::Disabled);
        assert_eq!(b, json!("not an object"));
    }

    fn count_breakpoints(v: &Value) -> usize {
        match v {
            Value::Object(map) => {
                let here = usize::from(map.contains_key("cache_control"));
                here + map.values().map(count_breakpoints).sum::<usize>()
            }
            Value::Array(items) => items.iter().map(count_breakpoints).sum(),
            _ => 0,
        }
    }
}
