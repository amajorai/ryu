//! Search-based tool injection front (#475, P2).
//!
//! This is the gateway-side front of the unified tool gateway. On the
//! openai-compat chat plane it:
//!   1. injects a single `tool_search` meta-tool (Contract 3) so the model can
//!      discover capabilities on demand instead of being handed every tool;
//!   2. runs a buffered tool-call loop ([`run_tool_loop`]) where `tool_search`
//!      hits Core's catalog, the model picks a tool by FQ id, the gateway
//!      describes + injects it, and executes allowlisted calls via Core;
//!   3. exposes `POST /v1/exec/tool` ([`exec`]) as the governance front for
//!      direct tool/code execution (Contract 2).
//!
//! Placement (CLAUDE.md §1): the gateway decides *what is allowed/measured*
//! (allowlist gate, audit, budget) and drives the loop; Core decides *what
//! runs* (Needle 2-backed search ranking, tool execution). Every privileged op crosses to Core
//! over HTTP via [`catalog_client::CoreCatalog`].

pub mod catalog_client;
pub mod exec;

use std::collections::HashSet;

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::{debug, info, warn};

use crate::error::GatewayError;
use crate::providers::Provider;

pub use catalog_client::{CoreCatalog, ToolSearchClient};

/// The `tool_search` meta-tool name. Always permitted; never allowlist-gated
/// (Contract 3: search ≠ grant).
pub const TOOL_SEARCH_NAME: &str = "tool_search";

// Canonical fully-qualified prefix of Composio tools. These are the only tool
// executions the managed plan bills for; model-facing function aliases are
// converted back to this prefix before billing and dispatch.

/// FQ id of Core's Agent-Skill loader. Mirrors `skills_tool::LOAD_TOOL_ID`
/// (`apps/core/src/sidecar/mcp/skills_tool.rs`) the same way
/// [`catalog_client::COMPOSIO_TOOL_PREFIX`] mirrors Core's Composio id shape — the gateway does not
/// link Core, so this is a hand-kept string.
///
/// It cannot be checked at compile time, so [`handle_search`] fails **loudly**: if
/// Core ever renames the tool, `describe` returns `Err` and the injection is skipped
/// with a `warn`, rather than silently leaving the model unable to act on the skill
/// rows the same response advertised.
pub const SKILLS_LOAD_TOOL_ID: &str = "skills.load";

/// Whether the mesh is enabled (B-9). When userspace networking is on, mesh
/// peers appear as `127.0.0.1`, so loopback-trust gates fail open; the exec gate
/// must neutralize loopback trust. Read locally so P2 compiles without P5.
pub fn mesh_enabled() -> bool {
    std::env::var("RYU_MESH_ENABLED")
        .ok()
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            !matches!(v.as_str(), "" | "0" | "false" | "no")
        })
        .unwrap_or(false)
}

/// The `tool_search` function-tool definition (Contract 3). Permits the model to
/// query Core's catalog for a capability — tools **and** Agent Skills, one door.
///
/// The twin lives in Core's ACP bridge (`apps/core/src/sidecar/adapters/
/// mcp_bridge.rs::tool_search_def`). Both advertise the same `kind` set, and both
/// cross-check it against Core's `ToolKind::parse_filter`
/// (`crates/core/tool-registry`), which is the only thing that honors the
/// `?kind=` value — so neither plane advertises a filter Core would silently
/// drop (`parse_filter` maps anything unrecognized to "no filter", which would
/// have made a `core-api` filter look like it worked while returning every
/// plane).
///
/// The description tells the model what to do with a `skill` row, because the
/// gateway deliberately does **not** inject a function definition for one (see
/// [`handle_search`]): without that sentence the model would see a row it has no
/// tool for and no instruction on how to reach it.
pub fn tool_search_def() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": TOOL_SEARCH_NAME,
            "description": "Search the available catalog for tools AND Agent Skills that can accomplish a task. Returns a ranked list of descriptors (id, name, description, kind). Call this FIRST when you need a capability not already provided as a tool. A row whose kind is 'skill' is instruction text, not a function: do NOT call its id — pass the part after the 'skills.' prefix to skills.load and follow what it returns. Every other kind is called directly by its exact id (or describe it first for its argument schema).",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Natural-language description of the capability you need (e.g. 'send a slack message')." },
                    "kind":  { "type": "string", "enum": ["mcp","builtin","composio","app","core-api","command","skill","ext-api","any"], "description": "Optional filter by source plane. 'skill' returns only Agent Skills. 'ext-api' returns only tools derived from an installed app's OpenAPI document. 'any' (default) searches all.", "default": "any" },
                    "limit": { "type": "integer", "description": "Max results.", "default": 8, "minimum": 1, "maximum": 25 }
                },
                "required": ["query"]
            }
        }
    })
}

/// Identity + governance inputs threaded into the tool loop.
#[derive(Debug, Clone, Default)]
pub struct ToolLoopContext {
    pub agent_id: Option<String>,
    pub user_id: Option<String>,
    /// Gateway-derived Composio identity. It is separate from the user id
    /// supplied to other Core tools and from wallet attribution.
    pub composio_user_id: Option<String>,
    /// A shared managed Gateway must refuse Composio execution without an
    /// authenticated organization instead of reaching Core's global fallback.
    pub require_composio_user_id: bool,
    /// Effective egress allowlist (FQ tool ids) for this request, from
    /// `x-ryu-tools` (or the legacy `x-ryu-composio-actions`). Empty ⇒ deny all
    /// non-`tool_search` execution (search still works; execution is gated).
    pub allowed: Vec<String>,
    /// The request's resolved firewall. `None` skips in-loop inspection (unit
    /// tests); the pipeline always supplies it.
    pub firewall: Option<ToolLoopFirewall>,
    /// Core marked this turn as spoken by an unverified caller
    /// (`x-ryu-untrusted-caller`). The loop then answers no `tool_search` call,
    /// even one the model names without being offered it, and asks Core to
    /// apply its untrusted-caller profile to every execution it forwards.
    pub untrusted_caller: bool,
    /// `tools.parallel_reads`: how many contiguous read-only calls of one model
    /// step may run at once. Clamped to `1..=`[`MAX_PARALLEL_READS`]; the
    /// `Default` of 0 therefore means fully sequential, which keeps every
    /// construction that does not opt in on today's behaviour.
    pub parallel_reads: usize,
    /// The Core conversation this turn runs in, with Core's process-local proof
    /// for it. Relayed only from a trusted forwarder (see
    /// `pipeline::trusted_host_conversation`), so Core resolves the turn's
    /// owner and applies that member's own tool rules to every execution. `None`
    /// keeps Core's fail-closed, node-wide principal.
    pub host_conversation: Option<HostConversation>,
    /// The organization's tool policy (C2) for this request's caller. Core
    /// enforces it at dispatch; the loop applies it too, as defence in depth,
    /// so a denied tool is neither offered nor forwarded. The default gate
    /// enforces nothing.
    pub org_tools: crate::policy::OrgToolGate,
}

/// A Core host conversation id and the proof Core minted for it before the
/// Gateway hop. The Gateway cannot verify the proof; it only relays it back to
/// Core with each tool call, where `authorize_tool_host_conversation` checks it.
#[derive(Clone, PartialEq, Eq)]
pub struct HostConversation {
    pub id: String,
    pub proof: String,
}

impl std::fmt::Debug for HostConversation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostConversation")
            .field("id", &self.id)
            .field("proof", &"[redacted]")
            .finish()
    }
}

/// Upper bound for [`ToolLoopContext::parallel_reads`] (and `tools.parallel_reads`).
pub const MAX_PARALLEL_READS: usize = 8;

/// The request's resolved (node → org → agent) firewall, applied inside a
/// buffered tool loop. The first completion was scanned by the pipeline, but
/// the loop's follow-up completions go straight to the provider, so without
/// this a tool result (file contents, an email, a web page) and the model's
/// tool arguments would never be inspected.
#[derive(Clone)]
pub struct ToolLoopFirewall {
    pub scanner: std::sync::Arc<crate::firewall::FirewallScanner>,
    /// The request's inbound screen over content the loop is about to append
    /// (a model turn before its calls run, a raw tool result before it is
    /// forwarded). It reads that content only, never earlier history, and
    /// never rewrites it, so the cached request prefix is untouched. An `Err`
    /// ends the loop before the next provider call. `None` keeps only the
    /// scanner checks below (unit tests); the pipeline always supplies it.
    pub screen: Option<AppendedScreen>,
    /// The request's screen over tool definitions the loop injects itself
    /// (described by Core after `tool_search`, or from capability hints),
    /// run before they join `tools`. An `Err` ends the loop before the next
    /// provider call. `None` skips it (unit tests); the pipeline always
    /// supplies it.
    pub screen_definitions: Option<DefinitionsScreen>,
    /// The request's platform-standing check (`crate::standing`), awaited
    /// before each round runs its tools and before each follow-up provider
    /// call. An `Err` ends the loop with the standing's 00.7 refusal. `None`
    /// skips it (unit tests and requests with no resolved credential).
    pub standing: Option<StandingCheck>,
    /// The hazard screener over the same appended content
    /// (`crate::screening`), awaited after [`Self::screen`]. An `Err` ends
    /// the loop before the next provider call. `None` skips it (unit tests).
    pub hazard: Option<HazardScreen>,
}

/// See [`ToolLoopFirewall::standing`].
pub type StandingCheck = std::sync::Arc<
    dyn Fn() -> futures_util::future::BoxFuture<'static, Result<(), GatewayError>> + Send + Sync,
>;

/// See [`ToolLoopFirewall::hazard`]. Called with the appended item, which
/// part of the round it is, and the zero-based round.
pub type HazardScreen = std::sync::Arc<
    dyn Fn(
            Value,
            ToolRoundPart,
            u8,
        ) -> futures_util::future::BoxFuture<'static, Result<(), GatewayError>>
        + Send
        + Sync,
>;

/// Which part of a tool round the hazard screen reads, so its violation
/// events carry the right direction (spec 03.4.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolRoundPart {
    /// The model's own turn: its text and the arguments of the calls it chose.
    ModelTurn,
    /// One tool's result.
    ToolResult,
}

/// See [`ToolLoopFirewall::screen`].
pub type AppendedScreen = std::sync::Arc<dyn Fn(&Value) -> Result<(), GatewayError> + Send + Sync>;

/// See [`ToolLoopFirewall::screen_definitions`].
pub type DefinitionsScreen =
    std::sync::Arc<dyn Fn(&[Value]) -> Result<(), GatewayError> + Send + Sync>;

impl std::fmt::Debug for ToolLoopFirewall {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ToolLoopFirewall")
    }
}

impl ToolLoopFirewall {
    /// A firewall with the scanner checks only (no appended-content screen).
    pub fn scanner_only(scanner: std::sync::Arc<crate::firewall::FirewallScanner>) -> Self {
        Self {
            scanner,
            screen: None,
            screen_definitions: None,
            standing: None,
            hazard: None,
        }
    }

    /// Check the request's platform standing again, if a check is set.
    pub async fn check_standing(&self) -> Result<(), GatewayError> {
        match &self.standing {
            Some(check) => check().await,
            None => Ok(()),
        }
    }

    /// Run the appended-content screen over `appended`, if one is set.
    pub fn screen_appended(&self, appended: &Value) -> Result<(), GatewayError> {
        match &self.screen {
            Some(screen) => screen(appended),
            None => Ok(()),
        }
    }

    /// Run the hazard screener over `appended`, part `part` of the zero-based
    /// `round`, if one is set.
    pub async fn screen_hazard(
        &self,
        appended: &Value,
        part: ToolRoundPart,
        round: u8,
    ) -> Result<(), GatewayError> {
        match &self.hazard {
            Some(screen) => screen(appended.clone(), part, round).await,
            None => Ok(()),
        }
    }

    /// Run the injected-definition screen over `definitions`, if one is set.
    pub fn screen_injected_definitions(&self, definitions: &[Value]) -> Result<(), GatewayError> {
        match &self.screen_definitions {
            Some(screen) => screen(definitions),
            None => Ok(()),
        }
    }

    /// The reason to refuse executing a model-chosen tool call, if its arguments
    /// trip the inbound scan. This is the same check `/v1/exec/tool` applies, so
    /// an injected tool result cannot exfiltrate data through tool arguments.
    pub fn deny_call(&self, tool_id: &str, arguments: &str) -> Option<String> {
        let violation = self
            .scanner
            .scan_inbound(&format!("{tool_id}\n{arguments}"))?;
        Some(format!(
            "firewall {:?}: {}",
            violation.kind, violation.pattern_name
        ))
    }

    /// Apply the inbound firewall policy to an external tool result before it
    /// re-enters the model. Returns the content to forward, or `Err` with a
    /// Gateway-generated replacement when the result is withheld: `Block`
    /// withholds any match, `Sanitize` redacts and withholds only a PII/secret
    /// match that survives redaction, `WarnAndContinue` logs and forwards.
    pub fn screen_result(&self, tool_id: &str, content: String) -> Result<String, String> {
        let Some(violation) = self.scanner.scan_inbound(&content) else {
            return Ok(content);
        };
        let withheld = |pattern: &str, kind: &crate::firewall::DetectionKind| {
            warn!(
                tool = tool_id,
                pattern, "tool result withheld by the Gateway firewall"
            );
            json!({
                "error": format!(
                    "tool result withheld by the Gateway firewall ({kind:?}: {pattern})"
                )
            })
            .to_string()
        };
        match self.scanner.policy() {
            crate::config::FirewallPolicy::Block => {
                Err(withheld(&violation.pattern_name, &violation.kind))
            }
            crate::config::FirewallPolicy::Sanitize => {
                let sanitized = self.scanner.sanitize(&content);
                let config = self.scanner.config();
                let mut categories: Vec<String> = Vec::with_capacity(2);
                if config.redact_pii {
                    categories.push("pii".to_owned());
                }
                if config.redact_secrets {
                    categories.push("secrets".to_owned());
                }
                match self.scanner.scan_locked_guardrails(&sanitized, &categories) {
                    Some(survivor) => Err(withheld(&survivor.pattern_name, &survivor.kind)),
                    None => Ok(sanitized),
                }
            }
            crate::config::FirewallPolicy::WarnAndContinue => {
                warn!(
                    tool = tool_id,
                    pattern = %violation.pattern_name,
                    "tool result firewall violation (warn-and-continue)"
                );
                Ok(content)
            }
        }
    }
}

/// The `tool` message content for an external tool result: screened by the
/// request firewall (when present), size-bounded ([`bound_tool_result`]), then
/// wrapped in untrusted-content boundary markers with chat-template tokens
/// stripped (default-ON, gated by `firewall.wrap_untrusted_tool_results`). The
/// bound runs before the wrap so a cut never removes a boundary marker. A
/// withheld result is a Gateway-generated envelope and is not wrapped.
pub fn external_tool_result_content(
    firewall: Option<&ToolLoopFirewall>,
    tool_id: &str,
    result: &Value,
) -> String {
    let content = result.to_string();
    let content = match firewall {
        Some(firewall) => match firewall.screen_result(tool_id, content) {
            Ok(content) => content,
            Err(withheld) => return withheld,
        },
        None => content,
    };
    let content = bound_model_result(content);
    if crate::untrusted::is_enabled() {
        crate::untrusted::neutralize(&content)
    } else {
        content
    }
}

/// The `tool` message content for a result the loop did not get from an
/// external tool (denial and error envelopes). Bounded like an external result,
/// except the `tool_search` / `describe` meta-tool envelopes, which the next
/// round parses as JSON and a cut would corrupt.
fn internal_tool_result_content(tool_id: &str, result: &Value) -> String {
    let content = result.to_string();
    if matches!(tool_id, TOOL_SEARCH_NAME | "describe") {
        content
    } else {
        bound_model_result(content)
    }
}

/// Elide inline base64 images, then cap at [`MAX_TOOL_RESULT_CHARS`]. Mirrors
/// Core's `neutralize_external_result` edge so a result is bounded the same
/// way whichever plane runs the tool loop.
fn bound_model_result(text: String) -> String {
    bound_tool_result(elide_inline_images(text), MAX_TOOL_RESULT_CHARS)
}

/// Base64 payloads shorter than this are left alone (icons, tiny thumbnails).
const MIN_ELIDED_IMAGE_CHARS: usize = 1_024;

/// Replace inline base64 image payloads in a JSON tool result with a short
/// placeholder. A port of Core's `mcp_bridge::elide_inline_images`: the tool
/// message carries text only, so a screenshot envelope would otherwise reach
/// the model as hundreds of KB of base64 it cannot decode, then be sliced in
/// the middle by [`bound_tool_result`]. Non-JSON text and JSON without such a
/// payload pass through untouched.
fn elide_inline_images(text: String) -> String {
    if text.len() < MIN_ELIDED_IMAGE_CHARS || !text.trim_start().starts_with('{') {
        return text;
    }
    let Ok(mut value) = serde_json::from_str::<Value>(&text) else {
        return text;
    };
    if !elide_images_in(&mut value) {
        return text;
    }
    serde_json::to_string(&value).unwrap_or(text)
}

/// Recursively elide `{image|data, encoding: "base64", mime: "image/*"}` objects
/// and MCP `{type: "image", data, mimeType}` blocks. Returns whether anything
/// was replaced.
fn elide_images_in(value: &mut Value) -> bool {
    match value {
        Value::Object(map) => {
            let ryu_mime = (map.get("encoding").and_then(Value::as_str) == Some("base64"))
                .then(|| map.get("mime").and_then(Value::as_str))
                .flatten();
            let mcp_mime = (map.get("type").and_then(Value::as_str) == Some("image"))
                .then(|| map.get("mimeType").and_then(Value::as_str))
                .flatten();
            let image_mime = ryu_mime
                .or(mcp_mime)
                .filter(|mime| mime.starts_with("image/"))
                .map(str::to_owned);
            let mut changed = false;
            if let Some(mime) = image_mime {
                for key in ["image", "data"] {
                    let Some(payload) = map.get(key).and_then(Value::as_str) else {
                        continue;
                    };
                    if payload.len() < MIN_ELIDED_IMAGE_CHARS {
                        continue;
                    }
                    let bytes = payload.len() / 4 * 3;
                    map.insert(
                        key.to_owned(),
                        Value::String(format!(
                            "[{mime} image, ~{} KB, omitted: base64 is not readable as text. \
                             Use an accessibility snapshot or page text to inspect content]",
                            bytes / 1024
                        )),
                    );
                    changed = true;
                }
            }
            for child in map.values_mut() {
                changed |= elide_images_in(child);
            }
            changed
        }
        Value::Array(items) => items
            .iter_mut()
            .fold(false, |changed, item| elide_images_in(item) | changed),
        _ => false,
    }
}

/// Most characters of one tool result that reach the model; the same ceiling
/// as Core's MCP bridge. About 28k tokens, so it only bites on pathological
/// outputs, which would otherwise be re-sent on every later round and turn.
const MAX_TOOL_RESULT_CHARS: usize = 100_000;

/// Cap a model-facing tool result at `limit` characters, keeping its head and
/// its tail around a marker that says how much was left out. A port of Core's
/// `mcp_bridge::bound_tool_result`; the parity test pins identical output.
fn bound_tool_result(text: String, limit: usize) -> String {
    let total = text.chars().count();
    if total <= limit {
        return text;
    }
    let head_chars = limit / 2;
    let tail_chars = limit - head_chars;
    let head_end = text
        .char_indices()
        .nth(head_chars)
        .map_or(text.len(), |(index, _)| index);
    let tail_start = text
        .char_indices()
        .nth(total - tail_chars)
        .map_or(text.len(), |(index, _)| index);
    let omitted = total - head_chars - tail_chars;
    format!(
        "{}\n...[{omitted} characters omitted from the middle of this tool result; \
         narrow the request to see them]...\n{}",
        &text[..head_end],
        &text[tail_start..]
    )
}

impl ToolLoopContext {
    /// Whether a tool id is permitted to execute. `tool_search` is always
    /// allowed (Contract 3); the single wildcard entry `"*"` (produced only by an
    /// `unrestricted` / "full" tool-policy profile that the request explicitly
    /// selected) permits any catalog tool; every other tool must appear in the
    /// allowlist by its exact fully-qualified id (`e == tool.id` only). Bare-name
    /// and bare-server matches are deliberately rejected — they would let an
    /// allowlist entry like `search` authorize `exa.search`/`composio.search`
    /// across planes (spec §3 security fix #1; lines 218/961/966). Server-scoped
    /// grants, when desired, are expressed as the explicit `<server>.*` id form
    /// upstream, never as a bare-server equality here. Absent `"*"`, the exact
    /// deny-by-default gate is unchanged. A tool the organization's tool policy
    /// denies ([`Self::org_tools`]) is never permitted, even under `"*"`.
    pub fn is_allowed(&self, tool_id: &str) -> bool {
        let canonical_id = catalog_client::canonical_tool_id(tool_id);
        if canonical_id == TOOL_SEARCH_NAME {
            return !self.untrusted_caller;
        }
        if !self.org_tools.permits(&canonical_id) {
            return false;
        }
        if self.allowed.iter().any(|a| a == "*") {
            return true;
        }
        self.allowed
            .iter()
            .any(|a| catalog_client::canonical_tool_id(a) == canonical_id)
    }
}

/// A capability-hint envelope naming exactly `allowed`, so the loop describes
/// and offers those tools directly. An untrusted-caller turn uses this instead
/// of `tool_search`: it is shown its explicit allowlist and nothing to search.
/// Offering a tool is not a grant; every call is still checked by
/// [`ToolLoopContext::is_allowed`]. `None` when there is nothing to offer.
pub fn allowlist_hint_envelope(allowed: &[String]) -> Option<String> {
    let tools: Vec<&String> = allowed.iter().filter(|id| id.as_str() != "*").collect();
    (!tools.is_empty()).then(|| json!({ "tools": tools }).to_string())
}

/// Merge the `tool_search` meta-tool (and any always-on tools) into the request
/// body, preserving caller-supplied tools and deduping by `function.name`.
///
/// Called AFTER budget enforcement (B-12): a `Restrict` budget action strips
/// `tools`, and the caller skips injection in that case so the strip is not
/// undone. `always_on` tool definitions are injected verbatim.
pub fn inject_search_tool(body: &mut Value, always_on: &[Value]) {
    let mut tools: Vec<Value> = body
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut seen: std::collections::HashSet<String> = tools
        .iter()
        .filter_map(|t| t["function"]["name"].as_str().map(str::to_string))
        .collect();

    let push_unique =
        |def: Value, seen: &mut std::collections::HashSet<String>, tools: &mut Vec<Value>| {
            if let Some(name) = def["function"]["name"].as_str() {
                if seen.insert(name.to_string()) {
                    tools.push(def);
                }
            }
        };

    push_unique(tool_search_def(), &mut seen, &mut tools);
    for def in always_on {
        push_unique(def.clone(), &mut seen, &mut tools);
    }

    body["tools"] = Value::Array(tools);
}

#[derive(Debug, Deserialize)]
struct CapabilityHintWire {
    #[serde(default)]
    tools: Vec<String>,
    #[serde(default)]
    skills: Vec<String>,
}

/// Return the canonical callable IDs from a Core-generated hint envelope.
/// Only the pipeline's trusted-forwarder gate may use these as a per-turn
/// allowlist supplement; ordinary callers cannot grant themselves tools.
pub fn capability_hint_tool_ids(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw.filter(|value| !value.is_empty()) else {
        return Vec::new();
    };
    serde_json::from_str::<CapabilityHintWire>(raw)
        .map(|hints| {
            hints
                .tools
                .into_iter()
                .take(8)
                .map(|id| catalog_client::canonical_tool_id(&id))
                .collect()
        })
        .unwrap_or_default()
}

pub fn capability_hint_has_skills(raw: Option<&str>) -> bool {
    let Some(raw) = raw.filter(|value| !value.is_empty()) else {
        return false;
    };
    serde_json::from_str::<CapabilityHintWire>(raw)
        .map(|hints| !hints.skills.is_empty())
        .unwrap_or(false)
}

/// Inject only the current turn's suggested callable definitions. Suggestions
/// are filtered by the same execution allowlist before they reach the model;
/// this is a UX/cache optimization, never a grant. The described definitions
/// pass the request's definition screen first: `pre_process` has already run,
/// so nothing else reads them before the first provider call.
async fn inject_capability_hints(
    body: &mut Value,
    catalog: &dyn CoreCatalog,
    ctx: &ToolLoopContext,
    raw: Option<&str>,
    read_only_tools: &mut HashSet<String>,
) -> Result<(), GatewayError> {
    let Some(raw) = raw.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let Ok(hints) = serde_json::from_str::<CapabilityHintWire>(raw) else {
        warn!("ignoring malformed capability suggestions");
        return Ok(());
    };

    let mut existing: std::collections::HashSet<String> = body
        .get("tools")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item["function"]["name"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let mut defs = Vec::new();

    for id in hints.tools.into_iter().take(8) {
        let id = catalog_client::canonical_tool_id(&id);
        if !ctx.is_allowed(&id) {
            continue;
        }
        let Ok(described) = catalog
            .describe_for_agent(&id, ctx.agent_id.as_deref())
            .await
        else {
            continue;
        };
        note_read_only(read_only_tools, &described);
        let definition = described.to_tool_def();
        let Some(name) = definition["function"]["name"].as_str() else {
            continue;
        };
        if existing.insert(name.to_owned()) {
            defs.push(definition);
        }
    }

    if !hints.skills.is_empty() && ctx.is_allowed(SKILLS_LOAD_TOOL_ID) {
        if let Ok(described) = catalog
            .describe_for_agent(SKILLS_LOAD_TOOL_ID, ctx.agent_id.as_deref())
            .await
        {
            let definition = described.to_tool_def();
            if let Some(name) = definition["function"]["name"].as_str() {
                if existing.insert(name.to_owned()) {
                    defs.push(definition);
                }
            }
        }
    }

    if defs.is_empty() {
        return Ok(());
    }
    if let Some(firewall) = ctx.firewall.as_ref() {
        firewall.screen_injected_definitions(&defs)?;
    }
    body["tools"] = body
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .chain(defs)
        .collect::<Vec<_>>()
        .into();
    Ok(())
}

/// Run the buffered, search-based tool-call loop over a non-streaming provider.
///
/// Decision A (streaming): on the streaming path the caller buffers via this
/// loop with `stream:false`, then synthesizes the final SSE from the returned
/// turn. This function only does the non-streamed loop; the caller owns the SSE
/// synthesis.
///
/// Each round:
///   1. `provider.complete` produces an assistant turn.
///   2. If it has no `tool_calls`, return it (terminal).
///   3. Append the assistant turn, then for each tool call:
///      - `tool_search` → query Core's catalog, describe each hit, inject the
///        described tool defs into `body["tools"]`, and return the descriptor
///        list as the tool result.
///      - any other id → allowlist gate; denial returns an error *result* (not
///        an execution); allowed ids execute via Core `call_tool`.
///      A contiguous run of allowed calls to tools Core described as read-only
///      (`DescribedTool::read_only`) executes concurrently, at most
///      `ctx.parallel_reads` at a time; every other call is a sequential
///      barrier. Tool messages are appended in `tool_calls` order either way.
///   4. Loop until no tool calls or `max_rounds` is reached.
///
/// Returns the final assistant turn plus a legacy billing counter. Unified tool
/// execution is charged by Core, the execution authority, so this counter is
/// always zero and callers cannot double-debit the same Composio action (#496).
///
pub async fn run_tool_loop(
    body: &mut Value,
    provider: &dyn Provider,
    model: &str,
    catalog: &dyn CoreCatalog,
    ctx: &ToolLoopContext,
    max_rounds: u8,
    describe_top_n: usize,
) -> Result<(Value, u64), GatewayError> {
    run_tool_loop_with_hints(
        body,
        provider,
        model,
        catalog,
        ctx,
        max_rounds,
        describe_top_n,
        None,
    )
    .await
}

pub async fn run_tool_loop_with_hints(
    body: &mut Value,
    provider: &dyn Provider,
    model: &str,
    catalog: &dyn CoreCatalog,
    ctx: &ToolLoopContext,
    max_rounds: u8,
    describe_top_n: usize,
    capability_hints: Option<&str>,
) -> Result<(Value, u64), GatewayError> {
    run_tool_loop_with_hints_for_session(
        body,
        provider,
        model,
        catalog,
        ctx,
        max_rounds,
        describe_top_n,
        capability_hints,
        None,
    )
    .await
}

pub async fn run_tool_loop_with_hints_for_session(
    body: &mut Value,
    provider: &dyn Provider,
    model: &str,
    catalog: &dyn CoreCatalog,
    ctx: &ToolLoopContext,
    max_rounds: u8,
    describe_top_n: usize,
    capability_hints: Option<&str>,
    session: Option<&str>,
) -> Result<(Value, u64), GatewayError> {
    // The buffered loop must never request a stream from the provider. Also
    // strip `stream_options` (e.g. `{include_usage:true}`, injected on the
    // streaming path before the tools branch): OpenAI / OpenAI-compat providers
    // reject `stream_options` on a non-streaming request with HTTP 400. The
    // buffered completion carries `usage` regardless, and `value_to_sse_stream`
    // re-synthesizes the usage frame for the stream observer.
    body["stream"] = Value::Bool(false);
    if let Some(obj) = body.as_object_mut() {
        obj.remove("stream_options");
    }

    // Canonical ids of the tools Core described as read-only during this loop.
    // Only those may share a concurrent batch; caller-supplied and `always_on`
    // tools were never described here, so they stay sequential.
    let mut read_only_tools: HashSet<String> = HashSet::new();
    let parallel_limit = ctx.parallel_reads.clamp(1, MAX_PARALLEL_READS);

    inject_capability_hints(body, catalog, ctx, capability_hints, &mut read_only_tools).await?;

    let mut response = provider.complete_for_session(model, body, session).await?;

    for round in 0..max_rounds {
        let tool_calls = match response["choices"][0]["message"]["tool_calls"].as_array() {
            Some(tc) if !tc.is_empty() => tc.clone(),
            _ => break, // terminal turn
        };

        info!(round, count = tool_calls.len(), "unified tool-call round");

        // Screen the model turn (its text and every call's arguments) before
        // any call runs or the turn is sent back to the provider.
        if let Some(firewall) = ctx.firewall.as_ref() {
            firewall.screen_appended(&response["choices"][0]["message"])?;
            firewall
                .screen_hazard(
                    &response["choices"][0]["message"],
                    ToolRoundPart::ModelTurn,
                    round,
                )
                .await?;
            // A suspension pushed mid-loop stops it before any tool runs.
            firewall.check_standing().await?;
        }

        // Append the assistant turn carrying the tool_calls.
        if let Some(msgs) = body["messages"].as_array_mut() {
            msgs.push(response["choices"][0]["message"].clone());
        }

        // Decide every call of the round before running any of them, so a
        // `tool_search` in this round cannot retroactively make a later call of
        // the same round concurrent: its injections take effect next round.
        let mut plans = tool_calls
            .iter()
            .map(|tc| plan_tool_call(tc, ctx, &read_only_tools, parallel_limit))
            .collect::<Vec<_>>()
            .into_iter()
            .peekable();

        while let Some(call) = plans.next() {
            if call.concurrent {
                // A maximal contiguous run of read-only executions. `buffered`
                // (not `buffer_unordered`) yields in input order, so the tool
                // messages land in `tool_calls` order and the transcript bytes
                // equal a sequential run. Every future lives inside this request
                // future (no spawn), so dropping it cancels in-flight calls.
                let mut batch = vec![call];
                while let Some(next) = plans.next_if(|planned| planned.concurrent) {
                    batch.push(next);
                }
                // Futures are built eagerly in a plain loop rather than through a
                // `map` closure: a closure returning an async block here trips
                // rustc's higher-ranked `Send` inference for the request future.
                let parent = tracing::Span::current();
                let mut pending = Vec::with_capacity(batch.len());
                for call in batch {
                    pending.push(run_planned_call(call, catalog, ctx, parent.clone(), round));
                }
                let mut results = futures_util::stream::iter(pending).buffered(parallel_limit);
                while let Some(outcome) = results.next().await {
                    // A result the firewall refuses ends the loop before it
                    // reaches the model; later calls of the batch are dropped.
                    let (tool_call_id, content) = outcome?;
                    push_tool_message(body, tool_call_id, content);
                }
                continue;
            }

            // A sequential barrier: `tool_search`, a denied or unknown call, a
            // write, or anything Core did not describe as read-only.
            let content = match call.action {
                CallAction::Search(input) => {
                    let tool_span = crate::telemetry::gen_ai_span::execute_tool_span(
                        &call.name,
                        call.tool_call_id,
                        tool_type(&call.name),
                    );
                    let result = tracing::Instrument::instrument(
                        handle_search(
                            body,
                            catalog,
                            ctx,
                            input,
                            describe_top_n,
                            &mut read_only_tools,
                        ),
                        tool_span.clone(),
                    )
                    .await?;
                    // `tool_search` is a Ryu-generated discovery envelope the next
                    // round parses, so it is never boundary-wrapped.
                    finish_tool_call(tool_span, &call.name, ctx, &result, false, round).await?
                }
                action => {
                    run_tool_action(
                        &call.name,
                        call.tool_call_id,
                        action,
                        catalog,
                        ctx,
                        &tracing::Span::current(),
                        round,
                    )
                    .await?
                }
            };
            push_tool_message(body, call.tool_call_id, content);
        }

        if let Some(firewall) = ctx.firewall.as_ref() {
            firewall.check_standing().await?;
        }
        response = provider.complete_for_session(model, body, session).await?;
    }

    // If the loop exhausted `max_rounds` while the model was still emitting
    // tool calls, the final turn carries no content. Mark it `length` so the
    // client/observer can tell the turn was truncated rather than an empty stop.
    let still_calling = response["choices"][0]["message"]["tool_calls"]
        .as_array()
        .is_some_and(|tc| !tc.is_empty());
    if still_calling {
        if let Some(choice) = response["choices"].get_mut(0) {
            choice["finish_reason"] = Value::String("length".to_string());
        }
    }

    // Core owns both execution and the charge notification. Keep the tuple's
    // second field for the existing pipeline contract, but never debit here.
    Ok((response, 0))
}

/// What the loop does with one model tool call, decided before the round runs.
enum CallAction<'a> {
    /// `tool_search`: mutates `body["tools"]`, so it always runs alone.
    Search(Value),
    /// Execute through Core's `call_tool` as `user_id`.
    Execute {
        input: Value,
        user_id: Option<&'a str>,
    },
    /// A gateway-generated error result (not allowed, no Composio org, or a
    /// firewall denial); nothing executes.
    Refuse(Value),
}

/// One tool call of a round with its decided action.
struct PlannedCall<'a> {
    tool_call_id: &'a str,
    /// Canonical id (`catalog_client::canonical_tool_id` of the model's name).
    name: String,
    action: CallAction<'a>,
    /// May share a concurrent batch with adjacent calls that may too.
    concurrent: bool,
}

/// Record a described tool as concurrency-safe when Core marked it read-only.
fn note_read_only(
    read_only_tools: &mut HashSet<String>,
    described: &catalog_client::DescribedTool,
) {
    if described.read_only {
        read_only_tools.insert(catalog_client::canonical_tool_id(&described.id));
    }
}

fn tool_type(name: &str) -> &'static str {
    if name == TOOL_SEARCH_NAME {
        "datastore"
    } else {
        "extension"
    }
}

/// Apply the allowlist, the Composio-identity rule and the firewall to one call,
/// in that order, and decide whether it may run concurrently. Pure per call.
///
/// Concurrency is opt-in and fail-closed: only an allowed, non-denied execution
/// of a non-Composio tool that Core described as read-only during this loop
/// qualifies. `tool_search`, refusals, caller-supplied, `always_on`, unknown and
/// mutating tools are sequential barriers.
fn plan_tool_call<'a>(
    tc: &'a Value,
    ctx: &'a ToolLoopContext,
    read_only_tools: &HashSet<String>,
    parallel_limit: usize,
) -> PlannedCall<'a> {
    let raw_name = tc["function"]["name"].as_str().unwrap_or("");
    let name = catalog_client::canonical_tool_id(raw_name);
    let arguments = call_arguments(tc);
    let args_str: &str = &arguments;
    let tool_call_id = tc["id"].as_str().unwrap_or("");
    let input: Value = serde_json::from_str(args_str).unwrap_or_else(|_| json!({}));
    let is_composio = name.starts_with(catalog_client::COMPOSIO_TOOL_PREFIX);

    let action = if name == TOOL_SEARCH_NAME && !ctx.untrusted_caller {
        CallAction::Search(input)
    } else if let Some(reason) = (name != TOOL_SEARCH_NAME)
        .then(|| ctx.org_tools.check(&name).err())
        .flatten()
    {
        CallAction::Refuse(json!({ "error": reason }))
    } else if !ctx.is_allowed(&name) {
        warn!(tool = name, "tool not in allowlist; denying execution");
        CallAction::Refuse(
            json!({ "error": format!("tool '{name}' is not allowed for this request") }),
        )
    } else if is_composio && ctx.require_composio_user_id && ctx.composio_user_id.is_none() {
        CallAction::Refuse(json!({ "error": "Composio requires an authenticated organization" }))
    } else if let Some(reason) = ctx
        .firewall
        .as_ref()
        .and_then(|firewall| firewall.deny_call(&name, args_str))
    {
        warn!(tool = name, %reason, "tool call denied by the Gateway firewall");
        CallAction::Refuse(json!({ "error": format!("tool call denied ({reason})") }))
    } else {
        let user_id = if is_composio {
            ctx.composio_user_id.as_deref().or(ctx.user_id.as_deref())
        } else {
            ctx.user_id.as_deref()
        };
        CallAction::Execute { input, user_id }
    };

    let concurrent = parallel_limit > 1
        && matches!(action, CallAction::Execute { .. })
        && !is_composio
        && name != TOOL_SEARCH_NAME
        && read_only_tools.contains(&name);
    PlannedCall {
        tool_call_id,
        name,
        action,
        concurrent,
    }
}

/// Run one non-search call and return its model-facing `content`. Never touches
/// `body`, so concurrent calls share nothing but the catalog and the context.
///
/// The `execute_tool` span is created when the call starts, explicitly under
/// `parent` (the loop's span), so a call that waited for a concurrency slot is
/// timed from its start and still nests under the request span; Core's
/// `tools/call` span nests under it through the propagated `traceparent`.
async fn run_tool_action(
    name: &str,
    tool_call_id: &str,
    action: CallAction<'_>,
    catalog: &dyn CoreCatalog,
    ctx: &ToolLoopContext,
    parent: &tracing::Span,
    round: u8,
) -> Result<String, GatewayError> {
    let tool_span = parent.in_scope(|| {
        crate::telemetry::gen_ai_span::execute_tool_span(name, tool_call_id, tool_type(name))
    });
    // Only a successful external `call_tool` RESULT is untrusted content
    // (poisoned web/tool output). The refusal and execution-error envelopes are
    // gateway-generated and are not boundary-wrapped.
    let (result, is_external_result) = match action {
        CallAction::Refuse(error) => (error, false),
        // Planned searches are run by the loop itself with `&mut body`; one can
        // only reach here through a programming error, so answer it as an error.
        CallAction::Search(_) => (json!({ "error": "tool_search must run on its own" }), false),
        CallAction::Execute { input, user_id } => {
            // Relay the Core-proved host conversation (trusted forwarder
            // only) so Core resolves the turn's owner and applies that
            // member's own tool rules, the same as the exec plane
            // (`/v1/exec/tool`). Without it Core stays fail-closed.
            let host = ctx.host_conversation.as_ref();
            let call = catalog.call_tool(
                name,
                input,
                ctx.agent_id.as_deref(),
                user_id,
                host.map(|host| host.id.as_str()),
                host.map(|host| host.proof.as_str()),
                ctx.untrusted_caller,
            );
            match tracing::Instrument::instrument(call, tool_span.clone()).await {
                Ok(out) => (out, true),
                Err(e) => {
                    warn!(tool = name, error = %e, "tool execution failed; returning error result");
                    (json!({ "error": e }), false)
                }
            }
        }
    };
    finish_tool_call(tool_span, name, ctx, &result, is_external_result, round).await
}

/// [`run_tool_action`] for one call of a concurrent batch, returning its id with
/// the content so the batch can append results in call order.
async fn run_planned_call<'a>(
    call: PlannedCall<'a>,
    catalog: &dyn CoreCatalog,
    ctx: &ToolLoopContext,
    parent: tracing::Span,
    round: u8,
) -> Result<(&'a str, String), GatewayError> {
    let content = run_tool_action(
        &call.name,
        call.tool_call_id,
        call.action,
        catalog,
        ctx,
        &parent,
        round,
    )
    .await?;
    Ok((call.tool_call_id, content))
}

/// Close a call's span and render its `content`. The raw result is screened
/// first, before it is wrapped or redacted, so a blocking match ends the loop
/// instead of reaching the next round. An external result is then screened by
/// the request firewall, bounded, then wrapped in untrusted-content boundary
/// markers with chat-template control tokens stripped before it re-enters the
/// model.
async fn finish_tool_call(
    tool_span: tracing::Span,
    name: &str,
    ctx: &ToolLoopContext,
    result: &Value,
    is_external_result: bool,
    round: u8,
) -> Result<String, GatewayError> {
    crate::telemetry::gen_ai_span::record_tool_result(&tool_span, result);
    drop(tool_span);
    if let Some(firewall) = ctx.firewall.as_ref() {
        firewall.screen_appended(result)?;
        firewall
            .screen_hazard(result, ToolRoundPart::ToolResult, round)
            .await?;
    }
    Ok(if is_external_result {
        external_tool_result_content(ctx.firewall.as_ref(), name, result)
    } else {
        internal_tool_result_content(name, result)
    })
}

fn push_tool_message(body: &mut Value, tool_call_id: &str, content: String) {
    if let Some(msgs) = body["messages"].as_array_mut() {
        msgs.push(json!({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "content": content,
        }));
    }
}

/// Handle a `tool_search` call: query Core's catalog, describe the top *callable*
/// hits and inject their tool defs so the model can call them next round. Returns
/// the descriptor list (id/name/description/kind) as the tool result the model sees.
///
/// The described definitions pass the request's definition screen before they
/// join `tools`; a refusal ends the loop before the round that would send them.
///
/// ## Agent Skills are listed but never injected
///
/// Core's catalog now returns Agent Skills alongside tools so the model has one
/// search door. A skill is instruction text loaded with `skills.load`, not a
/// function — so `kind == "skill"` rows are **filtered out before** the
/// `describe_top_n` budget is applied, not skipped inside the loop. Skipping inside
/// would let a skill-heavy top-N consume the injection budget and leave the model
/// with no tool definitions at all.
///
/// They stay in the returned list, carrying their `kind`, which is how the model
/// learns they exist and (via the `tool_search` description) that `skills.load` is
/// the way to reach them — and when any skill row is surfaced, that loader is
/// injected alongside, because on this plane the model does not otherwise have it.
async fn handle_search(
    body: &mut Value,
    catalog: &dyn CoreCatalog,
    ctx: &ToolLoopContext,
    input: Value,
    describe_top_n: usize,
    read_only_tools: &mut HashSet<String>,
) -> Result<Value, GatewayError> {
    let query = input["query"].as_str().unwrap_or_default();
    let kind = input["kind"].as_str();
    let limit = input["limit"]
        .as_u64()
        .map(|n| n as usize)
        .filter(|n| *n > 0)
        .unwrap_or(8)
        .min(25);

    let descriptors = match catalog
        .search(query, kind, limit, ctx.agent_id.as_deref())
        .await
    {
        Ok(d) => d,
        Err(e) => {
            warn!(error = %e, "tool_search failed");
            return Ok(json!({ "error": format!("tool_search failed: {e}") }));
        }
    };

    // Describe the top-N hits and inject their full tool defs so the model can
    // call them by exact id next round. Search ≠ grant: execution is still
    // allowlist-gated in the loop above.
    let mut existing: std::collections::HashSet<String> = body
        .get("tools")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|t| t["function"]["name"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let mut to_inject: Vec<Value> = Vec::new();
    for d in descriptors
        .iter()
        // Skills are not callable, so they must not consume the injection budget.
        .filter(|d| d.kind != catalog_client::ToolKind::Skill)
        .take(describe_top_n)
    {
        let model_name = catalog_client::model_tool_name(&d.id);
        if existing.contains(&model_name) {
            continue;
        }
        match catalog
            .describe_for_agent(&d.id, ctx.agent_id.as_deref())
            .await
        {
            Ok(described) => {
                existing.insert(catalog_client::model_tool_name(&described.id));
                note_read_only(read_only_tools, &described);
                to_inject.push(described.to_tool_def());
            }
            Err(e) => {
                debug!(id = %d.id, error = %e, "describe failed; skipping injection");
            }
        }
    }

    // The loader companion. Telling the model to reach a skill with `skills.load`
    // is worthless if it has no such function: on this plane the only tools a model
    // holds are `tool_search`, the caller's own, the `always_on` set, and whatever
    // previous searches injected — `skills.load` is in none of those by default.
    // So the moment a search surfaces a skill, inject the loader in the same round.
    //
    // Outside the `describe_top_n` budget on purpose: it is the *access path* for
    // rows that were themselves excluded from that budget, not a competing hit.
    // Deduped through `existing`, so repeated searches inject it once.
    //
    // Injection is not a grant — `ToolLoopContext::is_allowed` still gates the call,
    // and a request without `skills.load` in its allowlist gets the usual denial
    // result. That is the correct governance outcome; what this fixes is the model
    // being told to call something it could not even emit.
    let surfaced_a_skill = descriptors
        .iter()
        .any(|d| d.kind == catalog_client::ToolKind::Skill);
    let skills_load_model_name = catalog_client::model_tool_name(SKILLS_LOAD_TOOL_ID);
    if surfaced_a_skill && !existing.contains(&skills_load_model_name) {
        match catalog
            .describe_for_agent(SKILLS_LOAD_TOOL_ID, ctx.agent_id.as_deref())
            .await
        {
            Ok(described) => {
                existing.insert(skills_load_model_name);
                to_inject.push(described.to_tool_def());
            }
            // `warn`, not `debug`: every other describe failure costs the model one
            // tool it can search for again, but this one leaves skill rows in the
            // result with no way to act on them — an advertised path gone dark.
            Err(e) => {
                warn!(error = %e, "could not describe {SKILLS_LOAD_TOOL_ID}; skill rows in this \
                      search are not loadable by the model this round");
            }
        }
    }

    if !to_inject.is_empty() {
        if let Some(firewall) = ctx.firewall.as_ref() {
            firewall.screen_injected_definitions(&to_inject)?;
        }
        let tools = body.get_mut("tools").and_then(Value::as_array_mut);
        match tools {
            Some(arr) => arr.extend(to_inject),
            None => body["tools"] = Value::Array(to_inject),
        }
    }

    // The result the model sees: a compact descriptor list. `kind` is included so a
    // `skill` row is distinguishable from a callable tool — without it the model
    // gets an id it was never given a function for and no way to tell why.
    let listed: Vec<Value> = descriptors
        .iter()
        .map(|d| {
            json!({
                "id": d.id,
                "name": d.name,
                "description": d.description,
                "kind": d.kind.wire_name(),
            })
        })
        .collect();
    Ok(json!({ "object": "list", "data": listed }))
}

/// A model tool call's `function.arguments` as the JSON text the firewall
/// reads and the tool receives. Most providers send a string; one that sends
/// the parsed object (or any other value) is serialized, so its arguments are
/// neither skipped by `deny_call` nor dropped from the tool input. Only a
/// missing value reads as `{}`.
pub(crate) fn call_arguments(tool_call: &Value) -> std::borrow::Cow<'_, str> {
    match &tool_call["function"]["arguments"] {
        Value::String(text) => std::borrow::Cow::Borrowed(text.as_str()),
        Value::Null => std::borrow::Cow::Borrowed("{}"),
        other => std::borrow::Cow::Owned(other.to_string()),
    }
}

/// Synthesize an OpenAI SSE stream from a buffered non-streamed completion.
///
/// Emits, in order:
///   1. a `chat.completion.chunk` with the final assistant content as a `delta`
///      and `finish_reason`;
///   2. a terminal `{choices:[],usage:{...}}` chunk carrying the buffered
///      response's usage so the stream observer records real tokens;
///   3. `data: [DONE]`.
///
/// Only the final (post-loop) assistant content is streamed; intermediate
/// tool-call turns stay internal.
pub fn value_to_sse_stream(response: &Value) -> axum::body::Body {
    let id = response["id"].as_str().unwrap_or("chatcmpl-buffered");
    let model = response["model"].as_str().unwrap_or("unknown");
    let created = response["created"].as_u64().unwrap_or(0);
    let content = response["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");
    let finish_reason = response["choices"][0]["finish_reason"]
        .as_str()
        .unwrap_or("stop");
    let usage = response.get("usage").cloned().unwrap_or_else(|| json!({}));

    let content_chunk = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{
            "index": 0,
            "delta": { "role": "assistant", "content": content },
            "finish_reason": finish_reason,
        }],
    });

    let usage_chunk = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [],
        "usage": usage,
    });

    let payload = format!(
        "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        content_chunk, usage_chunk
    );
    axum::body::Body::from(payload)
}

#[cfg(test)]
mod tests;
