//! The **capability tool facade** — stable, provider-independent tool ids for the
//! hot-swappable layers (search, extract, crawl, browser, computer-use, memory).
//!
//! ## Why this exists
//!
//! The capability binding registry (`crate::plugins::binding`) already lets a
//! capability's provider be swapped: `provides`/`requires` edges resolve to a
//! concrete app id, overridable per capability. What it does NOT do is keep the
//! *model-visible tool surface* stable — binding lowers to a dependency-graph edge,
//! not to a tool route. So swapping Exa for Tavily used to rename `exa.search` to
//! `tavily.search` and reshape its arguments, breaking every agent allowlist and
//! every prompt that named the tool.
//!
//! This module closes that gap the way Hermes does: one canonical verb per thing an
//! agent actually wants to do (`web.search`, `browser.navigate`, `memory.store`,
//! …), registered as reserved built-in tools. At call time the facade resolves the
//! capability's bound provider, renames the arguments per the provider's manifest,
//! re-enters dispatch on the provider's own tool, and normalizes the response back
//! into the canonical shape. Swap the provider and neither the tool id, its schema,
//! nor its result shape changes.
//!
//! ## What lives where
//!
//! * The **verb table** below is the canonical contract: ids, descriptions, input
//!   schemas, and the capability each verb belongs to. It is generic mechanism — it
//!   names capabilities only, never a provider app id, port, or vendor.
//! * A **provider** declares, in its manifest's `provides[].tools`, which of its own
//!   tools serves each verb plus the argument/response mapping
//!   ([`CapabilityToolBinding`]). A provider that omits a verb simply does not serve
//!   it, and the facade does not advertise that verb while it is bound.
//! * `mcp::mod` owns the enabled-set gathering and the dispatch re-entry, because
//!   only the registry can call another tool.
//!
//! ## Invariants
//!
//! * Provider-native ids (`exa.search`, `spider.crawl`) stay registered. The facade
//!   is purely additive, so existing agents and allowlists are untouched.
//! * The facade adds no authority **relative to a direct tool call**: the re-entered
//!   call is the provider's own tool, gated by the provider's own grants exactly as
//!   calling that tool by its native id would be. The agent-facing boundary is the
//!   per-agent tool allowlist, checked here on the stable verb id — which is the
//!   point, since that permission then survives a provider swap.
//!
//!   Stated precisely, because it is an asymmetry worth knowing about: the facade
//!   does NOT check [`ProvidesEntry::grant`], while the HTTP capability broker
//!   (`sidecar::ext_proxy`) does. That is deliberate — `grant` expresses
//!   *plugin → plugin* authority, and the broker's caller is another plugin that
//!   declares `requires.capabilities`. A facade caller is an agent, which has no
//!   grant set to check against; gating on one would refuse every facade call.
//!   The consequence to keep in view is that a privileged verb is only as safe as
//!   the allowlist, so a genuinely dangerous capability should not become a verb at
//!   all. `browser.eval` (arbitrary JS in a page carrying the user's live session)
//!   was left OUT of the table for exactly this reason, on an app that ships
//!   pre-installed.
//! * A verb is only listed when its capability resolves over the ENABLED set AND the
//!   bound provider declares that verb — feature detection, never a tool that errors
//!   on first use.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use super::RegistryTool;
use crate::plugin_manifest::{CapabilityResponseMap, CapabilityToolBinding, PluginManifest};
use crate::plugins::binding::{BindingConfig, BindingRegistry};

/// Reserved server name for the web layers (search / extract / crawl).
pub const SERVER_WEB: &str = "web";
/// Reserved server name for browser control.
pub const SERVER_BROWSER: &str = "browser";
/// Reserved server name for computer (desktop) control.
pub const SERVER_COMPUTER: &str = "computer";
/// Reserved server name for the memory layer.
pub const SERVER_MEMORY: &str = "memory";

/// Capability name for web search.
pub const CAP_WEB_SEARCH: &str = "web.search";
/// Capability name for single-page content extraction.
pub const CAP_WEB_EXTRACT: &str = "web.extract";
/// Capability name for multi-page crawling.
pub const CAP_WEB_CRAWL: &str = "web.crawl";
/// Capability name for browser control.
pub const CAP_BROWSER: &str = "browser.control";
/// Capability name for desktop/computer control.
pub const CAP_COMPUTER: &str = "computer.control";
/// Capability name for the memory layer.
pub const CAP_MEMORY: &str = "memory";

/// Every reserved server name this module owns. Used by the registry's
/// `contains_server` / summary paths so a plugin cannot squat one.
pub const SERVERS: &[&str] = &[SERVER_WEB, SERVER_BROWSER, SERVER_COMPUTER, SERVER_MEMORY];

/// Whether `name` is one of the facade's reserved server names.
pub fn is_server(name: &str) -> bool {
    SERVERS.contains(&name)
}

/// One-line description of a reserved server, for the `GET /api/mcp/servers`
/// listing. `None` for a name the facade does not own.
pub fn server_description(name: &str) -> Option<&'static str> {
    match name {
        SERVER_WEB => Some(
            "Swappable web layer: search, extract, and crawl. The tools stay the same; which \
             provider serves them (Exa, Tavily, Spider, …) is selected in the layer picker.",
        ),
        SERVER_BROWSER => Some(
            "Swappable browser layer: navigate, snapshot, context, annotate, click, type, screenshot and \
             coordinate input. Backed by \
             whichever browser provider is selected (local Chromium or a cloud browser).",
        ),
        SERVER_COMPUTER => Some(
            "Swappable computer-use layer: capture the screen and drive mouse/keyboard through \
             the selected desktop-control provider.",
        ),
        SERVER_MEMORY => Some(
            "Swappable memory layer: search, store, and forget durable facts. The built-in store \
             is always available; an external provider can be selected alongside it.",
        ),
        _ => None,
    }
}

/// One canonical capability verb — a stable tool the model sees regardless of which
/// provider is bound.
pub struct Verb {
    /// Fully-qualified tool id (`<server>.<name>`), e.g. `"web.search"`.
    pub id: &'static str,
    /// The reserved server this verb belongs to.
    pub server: &'static str,
    /// The bare tool name within the server.
    pub name: &'static str,
    /// The capability whose bound provider serves it.
    pub capability: &'static str,
    /// Model-facing description. Deliberately provider-neutral.
    pub description: &'static str,
    /// Builds the canonical input schema.
    pub schema: fn() -> Value,
}

fn schema_search() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": { "type": "string", "description": "The search query. Natural language or keywords." },
            "limit": { "type": "integer", "description": "Maximum number of results (default 10).", "minimum": 1, "maximum": 100 }
        },
        "required": ["query"]
    })
}

fn schema_extract() -> Value {
    json!({
        "type": "object",
        "properties": {
            "url": { "type": "string", "description": "The URL whose main content should be extracted." },
            "format": { "type": "string", "description": "Preferred output format.", "enum": ["markdown", "text", "html"] }
        },
        "required": ["url"]
    })
}

fn schema_crawl() -> Value {
    json!({
        "type": "object",
        "properties": {
            "url": { "type": "string", "description": "The start URL to crawl from." },
            "depth": { "type": "integer", "description": "Link hops to follow (0 = the start page only).", "minimum": 0, "maximum": 10 },
            "limit": { "type": "integer", "description": "Maximum pages to fetch (default 10).", "minimum": 1, "maximum": 500 }
        },
        "required": ["url"]
    })
}

fn schema_browser_navigate() -> Value {
    // Deliberately NO `tab_id`. The verb means "open this URL in a new tab and tell
    // me which tab that is" — the cold-start move an agent actually needs, and the
    // one every browser provider can serve. Re-pointing an EXISTING tab was dropped
    // from the contract because a declarative provider tool has a single static URL
    // and cannot branch between "open" and "navigate" routes; advertising an
    // optional `tab_id` that the bound provider silently ignores is worse than not
    // offering it, since the model cannot tell the difference from the result.
    json!({
        "type": "object",
        "properties": {
            "url": { "type": "string", "description": "URL to open in a new browser tab." }
        },
        "required": ["url"]
    })
}

fn schema_browser_tab_only() -> Value {
    // `tab_id` is REQUIRED, not "omit for the active tab". A declarative provider
    // tool interpolates it into a static URL path, so omitting it is a hard error
    // rather than a fall back to some active tab — and providers have no shared
    // notion of an active tab anyway. Call `browser.tabs` or `browser.navigate`
    // first; both return the id.
    json!({
        "type": "object",
        "properties": {
            "tab_id": { "type": "string", "description": "Target tab id, from browser.tabs or browser.navigate." }
        },
        "required": ["tab_id"]
    })
}

fn schema_browser_click() -> Value {
    json!({
        "type": "object",
        "properties": {
            "ref": { "type": "string", "description": "Element reference from a prior browser.snapshot (e.g. \"@e3\")." },
            "tab_id": { "type": "string", "description": "Target tab; omit for the active tab." }
        },
        "required": ["ref"]
    })
}

fn schema_browser_type() -> Value {
    json!({
        "type": "object",
        "properties": {
            "ref": { "type": "string", "description": "Element reference from a prior browser.snapshot." },
            "text": { "type": "string", "description": "Text to type into the element." },
            "replace": { "type": "boolean", "description": "Overwrite the field's current value instead of appending to it. Default false: text is inserted at the caret, so a field that already has a value ends up with both." },
            "submit": { "type": "boolean", "description": "Press Enter after typing." },
            "tab_id": { "type": "string", "description": "Target tab; omit for the active tab." }
        },
        "required": ["ref", "text"]
    })
}

fn schema_browser_scroll() -> Value {
    json!({
        "type": "object",
        "properties": {
            "direction": { "type": "string", "enum": ["up", "down", "left", "right"] },
            "amount": { "type": "integer", "description": "Scroll distance in pixels (provider default when omitted)." },
            "tab_id": { "type": "string", "description": "Target tab; omit for the active tab." }
        },
        "required": ["direction"]
    })
}

fn schema_browser_context() -> Value {
    json!({
        "type": "object",
        "properties": {
            "tab_id": { "type": "string", "description": "Target tab id." },
            "include_screenshot": { "type": "boolean", "description": "Include the current PNG frame; set false for a text-only context refresh." },
            "selections": {
                "type": "array",
                "description": "Optional CSS-pixel points or rectangles to inspect. The result includes DOM identity, selectors, attributes, computed styles, component hints and text.",
                "maxItems": 8,
                "items": {
                    "type": "object",
                    "properties": {
                        "x": { "type": "number" },
                        "y": { "type": "number" },
                        "width": { "type": "number", "minimum": 0 },
                        "height": { "type": "number", "minimum": 0 }
                    },
                    "required": ["x", "y"]
                }
            }
        },
        "required": ["tab_id"]
    })
}

fn schema_browser_annotate() -> Value {
    json!({
        "type": "object",
        "properties": {
            "tab_id": { "type": "string", "description": "Target tab id." },
            "kind": { "type": "string", "enum": ["area", "element", "elements"] },
            "rect": { "type": "object", "properties": { "x": { "type": "number" }, "y": { "type": "number" }, "width": { "type": "number", "minimum": 0 }, "height": { "type": "number", "minimum": 0 } }, "required": ["x", "y"] },
            "selections": { "type": "array", "maxItems": 8, "items": { "type": "object", "properties": { "x": { "type": "number" }, "y": { "type": "number" }, "width": { "type": "number", "minimum": 0 }, "height": { "type": "number", "minimum": 0 } }, "required": ["x", "y"] } },
            "comment": { "type": "string", "description": "Specific change request for the pointed target or region." },
            "style": { "type": "object", "description": "Optional safe style feedback such as font_size, color, letter_spacing, padding, or margin." }
        },
        "required": ["tab_id", "kind", "rect", "comment"]
    })
}

fn schema_browser_hover() -> Value {
    json!({
        "type": "object",
        "properties": {
            "ref": { "type": "string", "description": "Element reference from browser.snapshot." },
            "tab_id": { "type": "string", "description": "Target tab; omit for the active tab." }
        },
        "required": ["ref"]
    })
}

fn schema_browser_click_at() -> Value {
    json!({
        "type": "object",
        "properties": {
            "x": { "type": "number", "description": "Viewport x coordinate in CSS pixels." },
            "y": { "type": "number", "description": "Viewport y coordinate in CSS pixels." },
            "button": { "type": "string", "enum": ["left", "middle", "right"] },
            "count": { "type": "integer", "minimum": 1, "maximum": 3 },
            "tab_id": { "type": "string", "description": "Target tab; omit for the active tab." }
        },
        "required": ["x", "y"]
    })
}

fn schema_browser_key() -> Value {
    json!({
        "type": "object",
        "properties": {
            "keys": { "type": "array", "description": "Key tokens pressed together, e.g. [\"cmd\", \"l\"] or [\"Escape\"].", "items": { "type": "string" } },
            "tab_id": { "type": "string", "description": "Target tab; omit for the active tab." }
        },
        "required": ["keys"]
    })
}

fn schema_browser_drag() -> Value {
    json!({
        "type": "object",
        "properties": {
            "from": { "type": "object", "properties": { "x": { "type": "number" }, "y": { "type": "number" } }, "required": ["x", "y"] },
            "to": { "type": "object", "properties": { "x": { "type": "number" }, "y": { "type": "number" } }, "required": ["x", "y"] },
            "tab_id": { "type": "string", "description": "Target tab; omit for the active tab." }
        },
        "required": ["from", "to"]
    })
}

fn schema_computer_capture() -> Value {
    // Deliberately NO `mode`. The verb captures the screen the one way the bound
    // provider knows how; advertising a som/ax/screenshot choice that providers
    // silently ignore is worse than not offering it, because the model cannot tell
    // from the result which mode it actually got. (Ghost, the only provider today,
    // always returns set-of-mark output — an image plus an indexed element list.)
    json!({ "type": "object", "properties": {} })
}

fn schema_computer_click() -> Value {
    json!({
        "type": "object",
        "properties": {
            "x": { "type": "integer", "description": "Screen x coordinate." },
            "y": { "type": "integer", "description": "Screen y coordinate." },
            "button": { "type": "string", "enum": ["left", "right", "middle"] },
            "count": { "type": "integer", "description": "Click count (2 = double-click).", "minimum": 1, "maximum": 3 }
        },
        "required": ["x", "y"]
    })
}

fn schema_computer_type() -> Value {
    json!({
        "type": "object",
        "properties": { "text": { "type": "string", "description": "Text to type at the current focus." } },
        "required": ["text"]
    })
}

fn schema_computer_key() -> Value {
    // An ARRAY of key tokens, not a `"cmd+s"` chord string. Desktop drivers press
    // and release individual keys, so they take the tokens already split; a chord
    // string would force every provider to re-parse it, and each would disagree
    // about the separator. Splitting is also not something the declarative argument
    // mapping can express, so a string here would be unserveable by construction.
    json!({
        "type": "object",
        "properties": {
            "keys": {
                "type": "array",
                "description": "Keys to press together, one token each, e.g. [\"cmd\", \"s\"] or [\"Escape\"].",
                "items": { "type": "string" }
            }
        },
        "required": ["keys"]
    })
}

fn schema_computer_scroll() -> Value {
    json!({
        "type": "object",
        "properties": {
            "x": { "type": "integer", "description": "Screen x to scroll at. Strongly recommended: a provider that has no coordinate falls back to a fixed point, which may not be over the content you mean." },
            "y": { "type": "integer", "description": "Screen y to scroll at. See `x`." },
            "direction": { "type": "string", "enum": ["up", "down", "left", "right"] },
            "amount": { "type": "integer", "description": "Scroll distance (provider-defined units)." }
        },
        "required": ["direction"]
    })
}

fn schema_computer_focus_app() -> Value {
    json!({
        "type": "object",
        "properties": { "app": { "type": "string", "description": "Application name to bring to the front." } },
        "required": ["app"]
    })
}

fn schema_empty() -> Value {
    json!({ "type": "object", "properties": {} })
}

fn schema_memory_search() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": { "type": "string", "description": "What to recall." },
            "scope": { "type": "string", "description": "Restrict to one scope level.", "enum": ["agent", "user", "node", "project", "org"] },
            "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
        },
        "required": ["query"]
    })
}

fn schema_memory_store() -> Value {
    json!({
        "type": "object",
        "properties": {
            "content": { "type": "string", "description": "The durable fact to remember." },
            "scope": { "type": "string", "description": "How broadly the fact applies.", "enum": ["agent", "user", "node", "project", "org"] },
            "category": { "type": "string", "description": "What kind of fact this is." },
            "importance": { "type": "integer", "minimum": 1, "maximum": 5 },
            "when_to_use": { "type": "string", "description": "Hint describing when this fact is relevant." }
        },
        "required": ["content"]
    })
}

fn schema_memory_context() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": { "type": "string", "description": "What the current turn is about, so the provider can tailor the summary." }
        }
    })
}

fn schema_memory_sync() -> Value {
    json!({
        "type": "object",
        "properties": {
            "content": { "type": "string", "description": "The raw conversation turn to hand over." },
            "role": { "type": "string", "description": "Who produced it.", "enum": ["user", "assistant"] }
        },
        "required": ["content"]
    })
}

fn schema_memory_forget() -> Value {
    json!({
        "type": "object",
        "properties": { "id": { "type": "string", "description": "Id of the memory to delete." } },
        "required": ["id"]
    })
}

/// The canonical verb table. Adding a verb here is a contract change: providers opt
/// in by declaring it in `provides[].tools`, and a verb no provider declares is
/// simply never listed.
///
/// ## Every verb here is served by at least one shipped provider
///
/// That was not true when the table was written — six verbs were forward-declared
/// placeholders — and the gap was not a design problem but a GRAMMAR one: the binding
/// language could rename keys and array-wrap a scalar, so any provider whose request
/// body was an array of objects (Mem0's `messages: [{role, content}]`) was unbindable
/// in principle. `arg_template` closed it, and the browser sidecar gained real
/// accessibility-tree and synthetic-input routes.
///
/// Keep it that way when adding a verb: a verb no provider can serve is never
/// advertised, so it fails silently rather than loudly. Before adding one, name the
/// provider that will serve it and check the grammar can express its request shape.
pub fn verbs() -> &'static [Verb] {
    &[
        Verb {
            id: "web.search",
            server: SERVER_WEB,
            name: "search",
            capability: CAP_WEB_SEARCH,
            description: "Search the web and return ranked results (title, url, snippet). Backed by \
                          the currently selected search provider; the tool and its result shape are \
                          the same whichever provider is selected.",
            schema: schema_search,
        },
        Verb {
            id: "web.extract",
            server: SERVER_WEB,
            name: "extract",
            capability: CAP_WEB_EXTRACT,
            description: "Extract the readable content of a single web page. Backed by the currently \
                          selected extraction provider.",
            schema: schema_extract,
        },
        Verb {
            id: "web.crawl",
            server: SERVER_WEB,
            name: "crawl",
            capability: CAP_WEB_CRAWL,
            description: "Crawl a site from a start URL, following links, and return the extracted \
                          pages. Backed by the currently selected crawl provider.",
            schema: schema_crawl,
        },
        Verb {
            id: "browser.navigate",
            server: SERVER_BROWSER,
            name: "navigate",
            capability: CAP_BROWSER,
            description: "Open a URL in a real browser and return the resulting tab. Backed by the \
                          currently selected browser provider (local Chromium or a cloud browser).",
            schema: schema_browser_navigate,
        },
        Verb {
            id: "browser.snapshot",
            server: SERVER_BROWSER,
            name: "snapshot",
            capability: CAP_BROWSER,
            description: "Return the page's accessibility tree with stable element references \
                          (@e1, @e2, …) to use with browser.click and browser.type.",
            schema: schema_browser_tab_only,
        },
        Verb {
            id: "browser.click",
            server: SERVER_BROWSER,
            name: "click",
            capability: CAP_BROWSER,
            description: "Click an element identified by a reference from browser.snapshot.",
            schema: schema_browser_click,
        },
        Verb {
            id: "browser.type",
            server: SERVER_BROWSER,
            name: "type",
            capability: CAP_BROWSER,
            description: "Type text into an element identified by a reference from browser.snapshot. \
                          Text is inserted at the caret and APPENDS by default — pass `replace` to \
                          overwrite a field that already has a value.",
            schema: schema_browser_type,
        },
        Verb {
            id: "browser.scroll",
            server: SERVER_BROWSER,
            name: "scroll",
            capability: CAP_BROWSER,
            description: "Scroll the page in a direction.",
            schema: schema_browser_scroll,
        },
        Verb {
            id: "browser.screenshot",
            server: SERVER_BROWSER,
            name: "screenshot",
            capability: CAP_BROWSER,
            description: "Capture a screenshot of the page, for visual content the accessibility \
                          tree cannot describe.",
            schema: schema_browser_tab_only,
        },
        Verb {
            id: "browser.tabs",
            server: SERVER_BROWSER,
            name: "tabs",
            capability: CAP_BROWSER,
            description: "List the open browser tabs with their ids, urls, and titles.",
            schema: schema_empty,
        },
        Verb {
            id: "browser.context",
            server: SERVER_BROWSER,
            name: "context",
            capability: CAP_BROWSER,
            description: "Return the current page's screenshot, accessibility snapshot, saved annotations, and optional DOM context for pointed elements.",
            schema: schema_browser_context,
        },
        Verb {
            id: "browser.annotate",
            server: SERVER_BROWSER,
            name: "annotate",
            capability: CAP_BROWSER,
            description: "Attach a frozen-frame visual comment to a browser element, group of elements, or area so the next agent turn can act on it.",
            schema: schema_browser_annotate,
        },
        Verb {
            id: "browser.clear_annotations",
            server: SERVER_BROWSER,
            name: "clear_annotations",
            capability: CAP_BROWSER,
            description: "Clear the saved visual annotations from a browser tab.",
            schema: schema_browser_tab_only,
        },
        Verb {
            id: "browser.hover",
            server: SERVER_BROWSER,
            name: "hover",
            capability: CAP_BROWSER,
            description: "Move the real pointer over a snapshot element without clicking it.",
            schema: schema_browser_hover,
        },
        Verb {
            id: "browser.click_at",
            server: SERVER_BROWSER,
            name: "click_at",
            capability: CAP_BROWSER,
            description: "Click a CSS-pixel viewport coordinate when no accessibility reference exists, such as a canvas control.",
            schema: schema_browser_click_at,
        },
        Verb {
            id: "browser.key",
            server: SERVER_BROWSER,
            name: "key",
            capability: CAP_BROWSER,
            description: "Press a browser key or key chord at the current focus.",
            schema: schema_browser_key,
        },
        Verb {
            id: "browser.drag",
            server: SERVER_BROWSER,
            name: "drag",
            capability: CAP_BROWSER,
            description: "Drag the real browser pointer between two CSS-pixel viewport coordinates.",
            schema: schema_browser_drag,
        },
        Verb {
            id: "computer.capture",
            server: SERVER_COMPUTER,
            name: "capture",
            capability: CAP_COMPUTER,
            description: "Capture the screen with accessibility metadata, so subsequent computer.* \
                          calls can target what is on screen.",
            schema: schema_computer_capture,
        },
        Verb {
            id: "computer.click",
            server: SERVER_COMPUTER,
            name: "click",
            capability: CAP_COMPUTER,
            description: "Click at a screen coordinate.",
            schema: schema_computer_click,
        },
        Verb {
            id: "computer.type",
            server: SERVER_COMPUTER,
            name: "type",
            capability: CAP_COMPUTER,
            description: "Type text into whatever currently has keyboard focus.",
            schema: schema_computer_type,
        },
        Verb {
            id: "computer.key",
            server: SERVER_COMPUTER,
            name: "key",
            capability: CAP_COMPUTER,
            description: "Press a key or key chord.",
            schema: schema_computer_key,
        },
        Verb {
            id: "computer.scroll",
            server: SERVER_COMPUTER,
            name: "scroll",
            capability: CAP_COMPUTER,
            description: "Scroll at a screen coordinate.",
            schema: schema_computer_scroll,
        },
        Verb {
            id: "computer.focus_app",
            server: SERVER_COMPUTER,
            name: "focus_app",
            capability: CAP_COMPUTER,
            description: "Bring an application to the front before interacting with it.",
            schema: schema_computer_focus_app,
        },
        Verb {
            id: "memory.search",
            server: SERVER_MEMORY,
            name: "search",
            capability: CAP_MEMORY,
            description: "Recall durable facts from long-term memory. Backed by the currently \
                          selected memory provider; the built-in store is always available.",
            schema: schema_memory_search,
        },
        Verb {
            id: "memory.store",
            server: SERVER_MEMORY,
            name: "store",
            capability: CAP_MEMORY,
            description: "Remember a durable fact at a given scope level (agent, user, node, \
                          project, or org).",
            schema: schema_memory_store,
        },
        Verb {
            id: "memory.context",
            server: SERVER_MEMORY,
            name: "context",
            capability: CAP_MEMORY,
            description: "Ask the memory provider for a short standing summary of what it knows \
                          about this user — the provider's own synthesis, not a list of raw \
                          facts. Providers that model a user over time (Honcho's dialectic, \
                          Mem0's summaries) serve this; ones that only do retrieval do not.",
            schema: schema_memory_context,
        },
        Verb {
            id: "memory.sync",
            server: SERVER_MEMORY,
            name: "sync",
            capability: CAP_MEMORY,
            description: "Hand a raw conversation turn to the memory provider and let IT decide \
                          what is worth remembering. Distinct from memory.store, which records \
                          a fact you have already decided on: sync delegates the extraction, \
                          which is how server-side-extraction providers are meant to be fed.",
            schema: schema_memory_sync,
        },
        Verb {
            id: "memory.forget",
            server: SERVER_MEMORY,
            name: "forget",
            capability: CAP_MEMORY,
            description: "Delete a remembered fact by id.",
            schema: schema_memory_forget,
        },
    ]
}

/// Look up a verb by its fully-qualified id.
pub fn verb_by_id(id: &str) -> Option<&'static Verb> {
    let normalized = super::canonical_tool_id(id);
    verbs().iter().find(|v| v.id == normalized)
}

/// The preference key holding the user's default for one canonical argument of a
/// capability — e.g. `layer.web.search.default.limit`.
///
/// Deliberately ONE KEY PER ARGUMENT rather than a single JSON blob per capability.
/// Preferences store bare strings and the settings-field types (`number`, `select`,
/// `toggle`, …) each write one scalar, so per-argument keys are authorable from a
/// plain manifest `settings_tabs` entry with no new field type and no client-side
/// JSON assembly. The cost is one small read per argument at call time, which is
/// nothing next to the network call the verb is about to make.
pub fn layer_default_key(capability: &str, arg: &str) -> String {
    format!("layer.{capability}.default.{arg}")
}

/// The canonical argument names of a verb, read off its own input schema — the set
/// of arguments a user may set a layer default for.
pub fn canonical_args(verb: &Verb) -> Vec<String> {
    (verb.schema)()
        .get("properties")
        .and_then(Value::as_object)
        .map(|props| props.keys().cloned().collect())
        .unwrap_or_default()
}

/// Coerce a stored preference string into the JSON type the canonical schema
/// declares for that argument.
///
/// Preferences are strings, but a verb argument may be an integer, a number or a
/// boolean, and forwarding `"20"` where the provider expects `20` is the kind of
/// mismatch that produces a confusing upstream 400. A value that does not parse as
/// its declared type is DROPPED rather than passed through as a string: a malformed
/// preference must not turn into a malformed API call.
pub fn coerce_to_schema_type(verb: &Verb, arg: &str, raw: &str) -> Option<Value> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let schema = (verb.schema)();
    let declared = schema
        .get("properties")
        .and_then(Value::as_object)
        .and_then(|p| p.get(arg))
        .and_then(|p| p.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("string");
    match declared {
        "integer" => raw.parse::<i64>().ok().map(Value::from),
        "number" => raw.parse::<f64>().ok().map(Value::from),
        "boolean" => match raw {
            "true" => Some(Value::Bool(true)),
            "false" => Some(Value::Bool(false)),
            _ => None,
        },
        // `array` and `object` defaults are not expressible as a scalar preference,
        // so they are simply not offered rather than half-parsed.
        "array" | "object" => None,
        _ => Some(Value::String(raw.to_owned())),
    }
}

/// The prefix marking an [`CapabilityToolBinding::arg_defaults`] value as a
/// PREFERENCE reference rather than a literal.
pub const PREF_TOKEN: &str = "pref:";

/// Every preference key referenced by a binding's `arg_defaults`, at any depth.
///
/// Providers need per-install configuration that is NOT a canonical verb argument —
/// Mem0 scopes every read to an entity id that lives inside its `filters` object, and
/// no canonical memory verb has (or should have) such a field. Without this a manifest
/// can only hard-code the value, which means one fixed bucket for every install: the
/// provider then returns nothing, forever, silently. That is the same
/// silently-serves-nothing failure a provider with no verbs would cause.
pub fn referenced_pref_keys(binding: &CapabilityToolBinding) -> Vec<String> {
    fn walk(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::String(s) => {
                if let Some(key) = s.strip_prefix(PREF_TOKEN) {
                    let key = key.trim();
                    if !key.is_empty() {
                        out.push(key.to_owned());
                    }
                }
            }
            Value::Array(items) => items.iter().for_each(|v| walk(v, out)),
            Value::Object(map) => map.values().for_each(|v| walk(v, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    for value in binding.arg_defaults.values() {
        walk(value, &mut out);
    }
    out.sort();
    out.dedup();
    out
}

/// Substitute `pref:<key>` tokens in a binding's `arg_defaults` with their stored
/// values, returning the resolved defaults.
///
/// A key with no stored value keeps whatever the manifest declared AFTER the token —
/// there is no such thing, so the token itself would be sent. Rather than ship a
/// literal `"pref:mem0.user-id"` upstream, an unresolved token DROPS its argument, so
/// the provider sees a missing field and can say so, instead of a nonsense value it
/// will treat as real.
pub fn resolve_arg_defaults(
    binding: &CapabilityToolBinding,
    prefs: &BTreeMap<String, String>,
) -> Map<String, Value> {
    fn subst(value: &Value, prefs: &BTreeMap<String, String>) -> Option<Value> {
        match value {
            Value::String(s) => match s.strip_prefix(PREF_TOKEN) {
                Some(key) => prefs
                    .get(key.trim())
                    .filter(|v| !v.trim().is_empty())
                    .map(|v| Value::String(v.clone())),
                None => Some(value.clone()),
            },
            Value::Array(items) => Some(Value::Array(
                items.iter().filter_map(|v| subst(v, prefs)).collect(),
            )),
            Value::Object(map) => {
                let mut out = Map::new();
                for (k, v) in map {
                    if let Some(resolved) = subst(v, prefs) {
                        out.insert(k.clone(), resolved);
                    }
                }
                Some(Value::Object(out))
            }
            other => Some(other.clone()),
        }
    }
    let mut out = Map::new();
    for (name, value) in &binding.arg_defaults {
        if let Some(resolved) = subst(value, prefs) {
            out.insert(name.clone(), resolved);
        }
    }
    out
}

/// Merge the user's per-layer argument defaults underneath the caller's arguments.
///
/// Precedence is **caller > layer default > provider `arg_defaults`**. The user's
/// layer default outranks the provider's because it is an explicit choice about how
/// this layer should behave ("search returns 25 results"), whereas a provider's
/// `arg_defaults` is vendor-specific tuning that should give way to it. An explicit
/// caller argument beats both — a model asking for 5 results gets 5.
pub fn apply_layer_defaults(defaults: &Map<String, Value>, arguments: Value) -> Value {
    if defaults.is_empty() {
        return arguments;
    }
    let mut merged = defaults.clone();
    match arguments {
        Value::Object(caller) => {
            for (k, v) in caller {
                merged.insert(k, v);
            }
            Value::Object(merged)
        }
        // A non-object payload has no named arguments to merge into; the caller's
        // value stands rather than being silently replaced by defaults.
        other => other,
    }
}

/// Bumped whenever anything that could change a capability's resolution changes:
/// the user's provider selection, or the set of enabled plugins. The registry caches
/// resolved verbs against this value so the enabled-set join (a plugin-store read
/// plus a manifest clone) does not run on every single tool call and every tool
/// listing.
///
/// Correctness over cheapness: the counter is bumped by the *mutators*, so a stale
/// read is only possible if a new mutation path forgets to call [`invalidate`]. The
/// failure that matters — "I picked Tavily but calls still go to Exa" — is covered
/// directly, because `PUT /api/capabilities/bindings` bumps it.
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Invalidate every cached capability resolution. Call from any path that changes
/// the provider selection or the enabled plugin set.
pub fn invalidate() {
    GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

/// The current resolution generation, for cache validity checks.
pub fn generation() -> u64 {
    GENERATION.load(std::sync::atomic::Ordering::Relaxed)
}

/// A verb the facade can currently serve: the canonical contract plus the concrete
/// provider tool it forwards to.
#[derive(Clone)]
pub struct ResolvedVerb {
    /// The canonical verb.
    pub verb: &'static Verb,
    /// The bound provider's app id (surfaced to the model in the response envelope,
    /// so a swap is observable when it matters — e.g. differing result quality).
    pub provider_id: String,
    /// The provider's declared mapping for this verb.
    pub binding: CapabilityToolBinding,
}

/// Resolve every verb the facade can serve over `enabled` (the ENABLED manifest set —
/// the same set the binding registry's invariants are stated over) with the user's
/// `config` overrides applied.
///
/// A capability that does not resolve (unprovided, or ambiguous and not selectable)
/// contributes no verbs, and a bound provider that does not declare a verb does not
/// get that verb advertised. Both are silent by design: the facade is feature
/// detection, not an error surface.
pub fn resolve_verbs(enabled: &[PluginManifest], config: &BindingConfig) -> Vec<ResolvedVerb> {
    let registry = BindingRegistry::new(config, enabled);
    // Resolve each capability once — the table has many verbs per capability.
    let mut bound: BTreeMap<
        &'static str,
        Option<(String, &crate::plugin_manifest::ProvidesEntry)>,
    > = BTreeMap::new();
    let mut out = Vec::new();
    for verb in verbs() {
        let entry = bound.entry(verb.capability).or_insert_with(|| {
            registry
                .resolve_provider(verb.capability)
                .ok()
                .map(|(m, p)| (m.id.clone(), p))
        });
        let Some((provider_id, provides)) = entry.as_ref() else {
            continue;
        };
        let Some(binding) = provides.tools.get(verb.id).or_else(|| {
            provides.tools.iter().find_map(|(id, binding)| {
                (super::canonical_tool_id(id) == verb.id).then_some(binding)
            })
        }) else {
            continue;
        };
        out.push(ResolvedVerb {
            verb,
            provider_id: provider_id.clone(),
            binding: binding.clone(),
        });
    }
    out
}

/// The registry rows for a set of resolved verbs.
pub fn tools(resolved: &[ResolvedVerb]) -> Vec<RegistryTool> {
    resolved
        .iter()
        .map(|r| RegistryTool {
            id: r.verb.id.to_owned(),
            server: r.verb.server.to_owned(),
            name: r.verb.name.to_owned(),
            description: Some(r.verb.description.to_owned()),
            input_schema: Some((r.verb.schema)()),
            ..Default::default()
        })
        .collect()
}

/// Rename the canonical arguments into the provider's own argument names and merge
/// the provider's constant defaults.
///
/// Rules, in order:
/// * A canonical argument with a mapping to a **non-empty** name is renamed.
/// * A mapping to the **empty string** drops the argument — the provider cannot
///   express it, and forwarding it verbatim would be a silent schema violation.
/// * A mapping ending in `[]` renames *and* wraps the value in a single-element
///   array (`"url" -> "urls[]"`). This is the one shape mismatch common enough to
///   be worth expressing declaratively: several extract/scrape APIs take a batch
///   array where the canonical verb passes one item. An already-array value is
///   passed through unwrapped rather than double-wrapped.
/// * An unmapped argument passes through under its own name, so a provider whose
///   argument names already match the canonical ones needs no `args` table at all.
/// * `arg_defaults` are merged first, so an explicit caller argument always wins.
pub fn map_args(binding: &CapabilityToolBinding, arguments: Value) -> Value {
    map_args_with_defaults(binding, binding.arg_defaults.clone(), arguments)
}

/// [`map_args`] with the provider defaults supplied — the form dispatch uses, so
/// `pref:` tokens can be resolved against the preferences store first.
pub fn map_args_with_defaults(
    binding: &CapabilityToolBinding,
    defaults: Map<String, Value>,
    arguments: Value,
) -> Value {
    let arguments = clamp_args(binding, arguments);
    // The TEMPLATE is expanded from the canonical arguments BEFORE renaming, and the
    // arguments it consumes are withheld from the rename pass so they cannot also
    // appear flat under a second name.
    let (templated, consumed) = expand_arg_template(binding, &arguments);
    let mut out: Map<String, Value> = defaults;
    out.extend(templated);
    let Value::Object(incoming) = arguments else {
        // A non-object argument payload has no names to rename; forward verbatim so
        // a provider taking a bare scalar still works.
        return if out.is_empty() {
            arguments
        } else {
            Value::Object(out)
        };
    };
    for (key, value) in incoming {
        if consumed.contains(&key) {
            continue;
        }
        match binding.args.get(&key).map(String::as_str) {
            Some("") => {}
            Some(renamed) => match renamed.strip_suffix("[]") {
                Some(name) if !name.is_empty() => {
                    let wrapped = match value {
                        already @ Value::Array(_) => already,
                        single => Value::Array(vec![single]),
                    };
                    out.insert(name.to_owned(), wrapped);
                }
                // `"[]"` alone names no field — treat as a drop rather than
                // inventing an empty key.
                Some(_) => {}
                None => {
                    out.insert(renamed.to_owned(), value);
                }
            },
            None => {
                out.insert(key, value);
            }
        }
    }
    Value::Object(out)
}

/// Expand a provider's `arg_template`, returning the produced fields and the set of
/// canonical arguments it consumed.
///
/// Substitution rules, kept deliberately small — this is a shape adapter, not a
/// language, and a manifest that can run logic is a far larger trust surface:
/// * a string that is EXACTLY `"{arg}"` becomes that argument's value, TYPE PRESERVED
///   (so a numeric argument stays a number rather than becoming `"5"`);
/// * a string merely CONTAINING `{arg}` interpolates it as text;
/// * a placeholder whose argument is absent drops the field containing it, rather
///   than emitting a literal `"{arg}"` the provider would treat as real content.
fn expand_arg_template(
    binding: &CapabilityToolBinding,
    arguments: &Value,
) -> (Map<String, Value>, std::collections::HashSet<String>) {
    let mut consumed = std::collections::HashSet::new();
    if binding.arg_template.is_empty() {
        return (Map::new(), consumed);
    }
    let Some(args) = arguments.as_object() else {
        return (Map::new(), consumed);
    };

    fn subst(
        value: &Value,
        args: &Map<String, Value>,
        consumed: &mut std::collections::HashSet<String>,
    ) -> Option<Value> {
        match value {
            Value::String(s) => {
                // Whole-string placeholder: keep the argument's own JSON type.
                if let Some(name) = s
                    .strip_prefix('{')
                    .and_then(|r| r.strip_suffix('}'))
                    .filter(|n| !n.contains('{') && !n.is_empty())
                {
                    consumed.insert(name.to_owned());
                    return args.get(name).cloned();
                }
                // Interpolated placeholders inside a larger string.
                let mut out = s.clone();
                let mut missing = false;
                for (name, v) in args {
                    let token = format!("{{{name}}}");
                    if out.contains(&token) {
                        consumed.insert(name.clone());
                        let text = match v {
                            Value::String(t) => t.clone(),
                            other => other.to_string(),
                        };
                        out = out.replace(&token, &text);
                    }
                }
                // Any placeholder left unresolved means the field is incomplete.
                if out.contains('{') && out.contains('}') {
                    missing = true;
                }
                if missing {
                    None
                } else {
                    Some(Value::String(out))
                }
            }
            Value::Array(items) => Some(Value::Array(
                items
                    .iter()
                    .filter_map(|v| subst(v, args, consumed))
                    .collect(),
            )),
            Value::Object(map) => {
                let mut out = Map::new();
                for (k, v) in map {
                    // A missing placeholder drops its FIELD, not the whole object, so
                    // an optional templated field stays optional.
                    if let Some(resolved) = subst(v, args, consumed) {
                        out.insert(k.clone(), resolved);
                    }
                }
                Some(Value::Object(out))
            }
            other => Some(other.clone()),
        }
    }

    let mut produced = Map::new();
    for (field, shape) in &binding.arg_template {
        if let Some(resolved) = subst(shape, args, &mut consumed) {
            produced.insert(field.clone(), resolved);
        }
    }
    (produced, consumed)
}

/// Clamp numeric arguments to what the bound provider can actually honour, BEFORE
/// the rename (so the manifest keys its bounds by canonical name).
///
/// Clamping rather than erroring: the caller asked for "up to N" results, and getting
/// fewer is a normal outcome — a failed search is not. Without this, swapping to a
/// provider with a lower ceiling turns a valid request into an upstream 4xx, and the
/// swap stops being transparent.
fn clamp_args(binding: &CapabilityToolBinding, arguments: Value) -> Value {
    if binding.arg_clamp.is_empty() {
        return arguments;
    }
    let Value::Object(mut obj) = arguments else {
        return arguments;
    };
    for (arg, bounds) in &binding.arg_clamp {
        let Some(slot) = obj.get_mut(arg) else {
            continue;
        };
        // Only whole numbers are clamped; a provider bound on a non-integer argument
        // is a manifest mistake, and silently coercing one would be worse than
        // leaving it for the provider to reject.
        let Some(n) = slot.as_i64() else {
            continue;
        };
        let mut clamped = n;
        if let Some(min) = bounds.min {
            clamped = clamped.max(min);
        }
        if let Some(max) = bounds.max {
            clamped = clamped.min(max);
        }
        if clamped != n {
            *slot = Value::from(clamped);
        }
    }
    Value::Object(obj)
}

/// Read a dotted path (`"data.items"`) out of a JSON value. A path segment that is
/// missing yields `None` rather than an error — a provider that omits an optional
/// field must not fail the whole call.
fn dotted<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut cur = value;
    for segment in path.split('.') {
        if segment.is_empty() {
            continue;
        }
        cur = cur.get(segment)?;
    }
    Some(cur)
}

/// Normalize a provider response into the canonical shape.
///
/// With no [`CapabilityResponseMap`] the provider's output is returned verbatim under
/// `raw`, so a verb whose result is inherently provider-shaped (a screenshot, a tab
/// list) still works without inventing a normalization that would lose information.
/// With one, the result array is located and each item's fields are renamed, and the
/// provider's original item is kept under `raw` so nothing is destroyed by the
/// mapping.
pub fn map_response(binding: &CapabilityToolBinding, provider_id: &str, raw: Value) -> Value {
    let Some(map) = binding.response.as_ref() else {
        return json!({ "provider": provider_id, "raw": raw });
    };
    let located = match map.results.as_deref() {
        Some(path) => match dotted(&raw, path) {
            Some(found) => found.clone(),
            // The declared results path is ABSENT. That is not "the provider found
            // nothing" — a provider that found nothing still returns its envelope
            // with an empty array. It means the payload is not a result set at all,
            // which is exactly what `tool_exec` returns on the failure paths:
            // `{available:false, reason, hint}` when `fail_open` swallows a 401/403
            // (a bad or missing API key), and `{status, body}` for any other
            // non-2xx. Mapping those to `results: []` would report a broken key as
            // "no search results" — an invisible, plausible-looking lie. Pass the
            // payload straight through instead so the caller sees what happened.
            None => return json!({ "provider": provider_id, "raw": raw }),
        },
        None => raw.clone(),
    };
    let items: Vec<Value> = match located {
        Value::Array(items) => items,
        Value::Null => Vec::new(),
        single => vec![single],
    };
    let results: Vec<Value> = items.iter().map(|item| map_item(map, item)).collect();
    json!({ "provider": provider_id, "results": results })
}

fn map_item(map: &CapabilityResponseMap, item: &Value) -> Value {
    let mut out = Map::new();
    for (canonical, source) in &map.fields {
        if let Some(found) = dotted(item, source) {
            out.insert(canonical.clone(), found.clone());
        }
    }
    out.insert("raw".to_owned(), item.clone());
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_manifest::ProvidesEntry;

    fn search_provider(id: &str, is_default: bool, tool: &str) -> PluginManifest {
        let mut binding = CapabilityToolBinding {
            tool: tool.to_owned(),
            ..Default::default()
        };
        binding
            .args
            .insert("limit".to_owned(), "num_results".to_owned());
        binding.response = Some(CapabilityResponseMap {
            results: Some("results".to_owned()),
            fields: [
                ("title".to_owned(), "title".to_owned()),
                ("url".to_owned(), "url".to_owned()),
                ("snippet".to_owned(), "text".to_owned()),
            ]
            .into_iter()
            .collect(),
        });
        let mut tools = BTreeMap::new();
        tools.insert("web.search".to_owned(), binding);
        PluginManifest {
            id: id.to_owned(),
            name: id.to_owned(),
            version: "1.0.0".to_owned(),
            provides: vec![ProvidesEntry {
                capability: CAP_WEB_SEARCH.to_owned(),
                version: "1.0.0".to_owned(),
                selectable: true,
                default_provider: is_default,
                tools,
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    // ── Guards over the REAL built-in manifests ──────────────────────────────
    //
    // Every other test in this module builds synthetic manifests, so none of them
    // can see a typo in a shipped fixture. These four can. They matter more than
    // usual here because Core's manifest loader never calls `validate_capabilities`,
    // so nothing else validates a `provides` block at all: a single-underscore verb
    // key (`web_search` for `web.search`) is not an error anywhere — it simply
    // makes the layer silently serve nothing.

    fn builtins() -> Vec<PluginManifest> {
        crate::plugin_manifest::PluginManifestLoader::load_builtins()
    }

    #[test]
    fn every_shipped_verb_key_is_a_real_verb() {
        for m in builtins() {
            for entry in m.provided_capabilities() {
                for key in entry.tools.keys() {
                    let verb = verb_by_id(key).unwrap_or_else(|| {
                        panic!(
                            "plugin '{}' binds unknown capability verb '{key}' — check for a \
                            single-underscore typo; the canonical ids are `<server>.<name>`",
                            m.id
                        )
                    });
                    assert_eq!(
                        verb.capability, entry.capability,
                        "plugin '{}' binds verb '{key}' under capability '{}', but that verb \
                         belongs to '{}'",
                        m.id, entry.capability, verb.capability
                    );
                }
            }
        }
    }

    // Capabilities where "swap the provider" changes WHICH MACHINE is acted on, not
    // merely who answers. Every provider of one of these must say what it drives.
    const MACHINE_CAPABILITIES: [&str; 2] = [CAP_COMPUTER, CAP_BROWSER];

    #[test]
    fn every_machine_controlling_provider_declares_what_it_acts_on() {
        // Swapping web.search from exa to tavily changes who answers the same
        // question. Swapping computer.control from ghost to bytebot changes which
        // COMPUTER gets typed on — ghost drives this machine, bytebot drives the
        // desktop bytebotd runs on. A picker that renders those two swaps the same
        // way is telling the user something false, and it can only tell them apart
        // if the manifest says so structurally.
        for m in builtins() {
            for entry in m.provided_capabilities() {
                if !MACHINE_CAPABILITIES.contains(&entry.capability.as_str()) {
                    continue;
                }
                assert!(
                    entry.target.is_some(),
                    "provider '{}' serves '{}', which controls a machine, but declares no \
                     `target` — a user cannot tell whether selecting it acts on their own \
                     computer or somewhere else",
                    m.id,
                    entry.capability
                );
            }
        }
    }

    #[test]
    fn the_two_computer_control_providers_do_not_claim_the_same_machine() {
        // The specific falsehood this whole field exists to stop: offering ghost and
        // bytebot as interchangeable ways to drive "your computer". If a future
        // provider genuinely drives the local machine it may join ghost here, but
        // that has to be a deliberate edit to this test, not a silent default.
        let targets: Vec<_> = builtins()
            .iter()
            .flat_map(|m| {
                m.provided_capabilities()
                    .iter()
                    .filter(|e| e.capability == CAP_COMPUTER)
                    .map(|e| (m.id.clone(), e.target))
                    .collect::<Vec<_>>()
            })
            .collect();
        assert!(
            targets.len() >= 2,
            "expected at least two computer.control providers, found {targets:?}"
        );
        let distinct: std::collections::BTreeSet<_> =
            targets.iter().map(|(_, t)| format!("{t:?}")).collect();
        assert!(
            distinct.len() > 1,
            "every computer.control provider claims the same target ({distinct:?}) — if that \
             is now true the picker's swap wording is fine, but verify it rather than \
             letting a missing declaration look like agreement"
        );
    }

    #[test]
    fn a_shipped_verb_never_targets_another_verb() {
        // Dispatch refuses this at call time; catching it here means a bad fixture
        // fails the build instead of one agent's turn.
        for m in builtins() {
            for entry in m.provided_capabilities() {
                for (key, binding) in &entry.tools {
                    assert!(
                        !binding.tool.is_empty(),
                        "plugin '{}' binds verb '{key}' to an empty target",
                        m.id
                    );
                    assert!(
                        verb_by_id(&binding.tool).is_none(),
                        "plugin '{}' points verb '{key}' at another facade verb ('{}') — that \
                         would be a manifest-authored dispatch loop",
                        m.id,
                        binding.tool
                    );
                }
            }
        }
    }

    #[test]
    fn shipped_capabilities_with_two_providers_are_unanimously_selectable() {
        // The failure this prevents is silent: `pick_selectable` requires unanimity,
        // so one provider missing `"selectable": true` makes the capability ambiguous
        // and the whole layer resolves to nothing — no error, no refused enable
        // (nothing `requires` these capabilities), just verbs that stop being served.
        let all = builtins();
        let mut by_capability: BTreeMap<&str, Vec<&PluginManifest>> = BTreeMap::new();
        for m in &all {
            for entry in m.provided_capabilities() {
                by_capability
                    .entry(entry.capability.as_str())
                    .or_default()
                    .push(m);
            }
        }
        for (capability, providers) in by_capability {
            if providers.len() < 2 {
                continue;
            }
            let ids: Vec<&str> = providers.iter().map(|m| m.id.as_str()).collect();
            assert!(
                crate::plugins::binding::is_selectable(&all, capability),
                "capability '{capability}' ships {} providers ({}) but is not unanimously \
                 selectable — it will resolve to nothing. Add \"selectable\": true to every \
                 provider, or stop shipping a second one.",
                providers.len(),
                ids.join(", ")
            );
        }
    }

    #[test]
    fn no_shipped_capability_declares_two_defaults() {
        // Resolution degrades to lexicographic rather than erroring, so a duplicate
        // `default` is a silently wrong pick, not a crash.
        let mut defaults: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for m in builtins() {
            for entry in m.provided_capabilities() {
                if entry.default_provider {
                    defaults
                        .entry(entry.capability.clone())
                        .or_default()
                        .push(m.id.clone());
                }
            }
        }
        for (capability, claimants) in defaults {
            assert_eq!(
                claimants.len(),
                1,
                "capability '{capability}' has {} providers claiming \"default\" ({}) — exactly \
                 one may",
                claimants.len(),
                claimants.join(", ")
            );
        }
    }

    #[test]
    fn the_shipped_search_layer_actually_resolves_and_is_swappable() {
        // End-to-end over real fixtures: two shipped providers, deterministic default,
        // and an override that moves the target without moving the tool.
        let all = builtins();
        let default_pick = resolve_verbs(&all, &BindingConfig::default());
        let search = default_pick
            .iter()
            .find(|r| r.verb.id == "web.search")
            .expect("the shipped fixtures must serve web.search");
        assert_eq!(
            search.provider_id, "@ryu/exa",
            "exa declares itself the default"
        );
        assert_eq!(search.binding.tool, "exa.search");

        let mut cfg = BindingConfig::default();
        cfg.overrides
            .insert(CAP_WEB_SEARCH.to_owned(), "@ryu/tavily".to_owned());
        let swapped = resolve_verbs(&all, &cfg);
        let search_after = swapped
            .iter()
            .find(|r| r.verb.id == "web.search")
            .expect("web.search must survive the swap");
        assert_eq!(search_after.provider_id, "@ryu/tavily");
        assert_eq!(search_after.binding.tool, "tavily.search");
    }

    #[test]
    fn the_shipped_browser_layer_serves_the_whole_verb_set() {
        // The browser sidecar now answers snapshot/context/annotation and full
        // mouse/keyboard input over its own CDP session, so the local browser's
        // extended verb set must resolve to it. Pinned because the
        // failure is silent in both directions: a mistyped verb key just stops being
        // advertised, and a runnable renamed out from under `binding.tool` only fails
        // at call time, on someone's turn.
        let all = builtins();
        let resolved = resolve_verbs(&all, &BindingConfig::default());
        let served: BTreeMap<&str, (&str, &str)> = resolved
            .iter()
            .filter(|r| r.verb.capability == CAP_BROWSER)
            .map(|r| (r.verb.id, (r.provider_id.as_str(), r.binding.tool.as_str())))
            .collect();
        for (verb, tool) in [
            ("browser.tabs", "chromium.list_tabs"),
            ("browser.navigate", "chromium.open_tab"),
            ("browser.screenshot", "chromium.screenshot_tab"),
            ("browser.snapshot", "chromium.snapshot_tab"),
            ("browser.click", "chromium.click"),
            ("browser.type", "chromium.type"),
            ("browser.scroll", "chromium.scroll"),
            ("browser.context", "chromium.context"),
            ("browser.annotate", "chromium.annotate"),
            ("browser.clear_annotations", "chromium.clear_annotations"),
            ("browser.hover", "chromium.hover"),
            ("browser.click_at", "chromium.click_at"),
            ("browser.key", "chromium.key"),
            ("browser.drag", "chromium.drag"),
        ] {
            assert_eq!(
                served.get(verb),
                Some(&("@ryu/browser", tool)),
                "the shipped browser provider must serve {verb} via {tool}"
            );
        }
        // `browser.eval` is not a verb at all (see the module docs); nothing may
        // reintroduce it through a binding.
        assert!(verb_by_id("browser.eval").is_none());

        // Every `chromium.*` target must be a runnable the app actually registers,
        // and each declared route must exist on the sidecar — a binding pointing at a
        // slug or path that is not there 404s at call time and nowhere else.
        let browser = all
            .iter()
            .find(|m| m.id == "@ryu/browser")
            .expect("the browser app must be compiled in and parseable");
        let slugs: Vec<&str> = browser
            .runnables
            .iter()
            .filter_map(|r| r.config.as_ref()?.get("slug").and_then(Value::as_str))
            .collect();
        let urls: Vec<&str> = browser
            .runnables
            .iter()
            .filter_map(|r| r.config.as_ref()?.get("url").and_then(Value::as_str))
            .collect();
        for (_, (_, tool)) in &served {
            assert!(
                slugs.contains(tool),
                "verb target '{tool}' is not a runnable slug on @ryu/browser"
            );
        }
        for url in [
            "/tabs/{id}/snapshot",
            "/tabs/{id}/context",
            "/tabs/{id}/annotations",
            "/click",
            "/type",
            "/scroll",
            "/hover",
            "/click-at",
            "/key",
            "/drag",
        ] {
            let full = format!("core:/api/ext/@ryu/browser{url}");
            assert!(
                urls.contains(&full.as_str()),
                "no runnable targets {full}; the new control routes would be unreachable"
            );
            // The ext-proxy refuses a sub-path matching none of the declared routes,
            // so the manifest's own route list has to carry it too.
            let declared = url.replace("{id}", ":id");
            assert!(
                browser.sidecars.iter().any(|s| s
                    .http
                    .as_ref()
                    .is_some_and(|h| h.routes.iter().any(|r| r.path == declared))),
                "route '{declared}' is not declared on the browser sidecar"
            );
        }
    }

    // ── Layer argument defaults ──────────────────────────────────────────────

    #[test]
    fn the_layers_settings_app_loads_and_every_field_targets_a_real_argument() {
        // Three silent failure modes at once, none of which any other test can see:
        //
        // 1. A malformed fixture. `load_builtins()` SKIPS a manifest it cannot parse,
        //    and every guard test iterates that same set — so a skipped manifest is
        //    indistinguishable from a clean pass.
        // 2. A `pref_key` typo. The key is a plain string on both sides; a mismatch
        //    means the facade reads a key nothing ever writes and the knob does
        //    nothing, with no error anywhere.
        // 3. A field for an argument no verb has. Same outcome: pure decoration.
        let builtins = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let layers = builtins
            .iter()
            .find(|m| m.id == "@ryu/layers")
            .expect("the layers settings app must be compiled in and parseable");
        assert!(
            crate::plugins::builtins::is_preinstalled("@ryu/layers"),
            "a settings surface the user cannot reach is not a setting"
        );

        // `Contributes::settings_tabs` forwards the ORIGINAL JSON (so a newer
        // manifest still round-trips through an older Core), so read it as JSON
        // rather than through the typed struct.
        let tabs = &layers
            .contributes
            .as_ref()
            .expect("layers contributes settings")
            .settings_tabs;
        let fields: Vec<String> = tabs
            .iter()
            .flat_map(|t| {
                t.get("fields")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
            })
            .filter_map(|f| f.get("pref_key").and_then(Value::as_str).map(str::to_owned))
            .collect();
        assert!(!fields.is_empty(), "layers must declare settings fields");

        for pref_key in &fields {
            // Reconstruct which capability + argument the key names, exactly as
            // `layer_default_key` composes it, and prove BOTH halves are real.
            let (capability, arg) = verbs()
                .iter()
                .flat_map(|v| {
                    canonical_args(v)
                        .into_iter()
                        .map(move |a| (v.capability, a))
                })
                .find(|(cap, a)| &layer_default_key(cap, a) == pref_key)
                .unwrap_or_else(|| {
                    panic!(
                        "settings field '{pref_key}' does not correspond to any canonical \
                         verb argument — nothing will ever read it"
                    )
                });

            // And prove at least one SHIPPED provider actually forwards that argument
            // rather than dropping it, which is the difference between a working knob
            // and one whose value `map_args` discards on the way out.
            let served = builtins.iter().any(|m| {
                m.provided_capabilities().iter().any(|p| {
                    p.capability == capability
                        && p.tools
                            .values()
                            .any(|b| b.args.get(&arg).map(String::as_str) != Some(""))
                })
            });
            assert!(
                served,
                "settings field '{pref_key}' targets '{arg}' on '{capability}', but every \
                 shipped provider drops that argument — the setting would be decoration"
            );
        }
    }

    #[test]
    fn layer_defaults_sit_under_the_caller_but_over_the_provider() {
        let search = verb_by_id("web.search").unwrap();
        let mut defaults = Map::new();
        defaults.insert("limit".to_owned(), json!(25));

        // No caller `limit` → the user's layer default applies.
        let merged = apply_layer_defaults(&defaults, json!({ "query": "rust" }));
        assert_eq!(merged, json!({ "query": "rust", "limit": 25 }));

        // Caller asked for 5 → the caller wins.
        let merged = apply_layer_defaults(&defaults, json!({ "query": "rust", "limit": 5 }));
        assert_eq!(merged["limit"], json!(5));

        // And the layer default outranks the provider's own arg_defaults, because
        // `map_args` merges arg_defaults first and the merged args overwrite them.
        let mut binding = CapabilityToolBinding {
            tool: "exa.search".to_owned(),
            ..Default::default()
        };
        binding.arg_defaults.insert("limit".to_owned(), json!(10));
        let mapped = map_args(
            &binding,
            apply_layer_defaults(&defaults, json!({ "query": "q" })),
        );
        assert_eq!(mapped["limit"], json!(25));

        // Sanity: the key the settings UI must write.
        assert_eq!(
            layer_default_key(search.capability, "limit"),
            "layer.web.search.default.limit"
        );
    }

    #[test]
    fn a_stored_default_is_coerced_to_the_type_the_schema_declares() {
        let search = verb_by_id("web.search").unwrap();
        // `limit` is an integer in the canonical schema; preferences store strings.
        assert_eq!(
            coerce_to_schema_type(search, "limit", "25"),
            Some(json!(25))
        );
        // A string default stays a string.
        assert_eq!(
            coerce_to_schema_type(search, "query", "rust"),
            Some(json!("rust"))
        );
        // Garbage is DROPPED, not forwarded as a string — a malformed preference
        // must not become a malformed upstream request.
        assert_eq!(coerce_to_schema_type(search, "limit", "twenty"), None);
        assert_eq!(coerce_to_schema_type(search, "limit", "  "), None);
    }

    #[test]
    fn booleans_and_unset_defaults_behave() {
        let crawl = verb_by_id("web.crawl").unwrap();
        assert_eq!(coerce_to_schema_type(crawl, "depth", "3"), Some(json!(3)));
        // No defaults at all is a pure pass-through.
        assert_eq!(
            apply_layer_defaults(&Map::new(), json!({ "url": "https://e" })),
            json!({ "url": "https://e" })
        );
    }

    #[test]
    fn every_verb_exposes_its_canonical_args_for_defaulting() {
        // The settings UI enumerates these to know which keys it may offer, so a
        // verb whose schema has no readable properties would silently be
        // un-configurable.
        let search = verb_by_id("web.search").unwrap();
        let mut args = canonical_args(search);
        args.sort();
        assert_eq!(args, vec!["limit".to_owned(), "query".to_owned()]);
    }

    #[test]
    fn legacy_provider_ids_resolve_through_the_canonical_lookup() {
        assert_eq!(
            verb_by_id("web__search").map(|verb| verb.id),
            Some("web.search")
        );
    }

    #[test]
    fn verb_ids_match_their_server_and_name() {
        for v in verbs() {
            assert_eq!(v.id, format!("{}.{}", v.server, v.name), "verb id mismatch");
            assert!(is_server(v.server), "verb {} has unreserved server", v.id);
        }
    }

    #[test]
    fn verb_ids_are_unique() {
        let mut ids: Vec<&str> = verbs().iter().map(|v| v.id).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(before, ids.len(), "duplicate verb id in the table");
    }

    #[test]
    fn only_verbs_the_bound_provider_declares_are_listed() {
        let enabled = vec![search_provider("@ryu/exa", true, "exa.search")];
        let resolved = resolve_verbs(&enabled, &BindingConfig::default());
        // exa declares web.search only — no extract/crawl/browser/computer/memory.
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].verb.id, "web.search");
        assert_eq!(resolved[0].provider_id, "@ryu/exa");
        assert_eq!(resolved[0].binding.tool, "exa.search");

        let rows = tools(&resolved);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "web.search");
        assert_eq!(rows[0].server, "web");
    }

    #[test]
    fn swapping_the_provider_keeps_the_verb_and_changes_only_the_target() {
        let enabled = vec![
            search_provider("@ryu/exa", true, "exa.search"),
            search_provider("@ryu/tavily", false, "tavily.search"),
        ];
        // Zero-config: the declared default wins.
        let before = resolve_verbs(&enabled, &BindingConfig::default());
        assert_eq!(before[0].verb.id, "web.search");
        assert_eq!(before[0].binding.tool, "exa.search");

        // One override later, the model-visible id is identical and only the
        // forwarding target moved.
        let mut cfg = BindingConfig::default();
        cfg.overrides
            .insert(CAP_WEB_SEARCH.to_owned(), "@ryu/tavily".to_owned());
        let after = resolve_verbs(&enabled, &cfg);
        assert_eq!(after[0].verb.id, before[0].verb.id);
        assert_eq!(after[0].binding.tool, "tavily.search");
        assert_eq!(
            tools(&after)[0].input_schema,
            tools(&before)[0].input_schema
        );
    }

    #[test]
    fn unresolvable_capability_advertises_nothing() {
        let resolved = resolve_verbs(&[], &BindingConfig::default());
        assert!(resolved.is_empty());
    }

    #[test]
    fn args_are_renamed_dropped_and_defaulted() {
        let mut binding = CapabilityToolBinding {
            tool: "x".to_owned(),
            ..Default::default()
        };
        binding
            .args
            .insert("limit".to_owned(), "num_results".to_owned());
        // This provider cannot express `format` at all.
        binding.args.insert("format".to_owned(), String::new());
        binding
            .arg_defaults
            .insert("use_autoprompt".to_owned(), json!(true));

        let mapped = map_args(
            &binding,
            json!({ "query": "rust", "limit": 5, "format": "markdown" }),
        );
        assert_eq!(
            mapped,
            json!({ "query": "rust", "num_results": 5, "use_autoprompt": true })
        );
    }

    #[test]
    fn a_batch_argument_is_wrapped_declaratively() {
        let mut binding = CapabilityToolBinding {
            tool: "tavily.extract".to_owned(),
            ..Default::default()
        };
        binding.args.insert("url".to_owned(), "urls[]".to_owned());
        assert_eq!(
            map_args(&binding, json!({ "url": "https://e" })),
            json!({ "urls": ["https://e"] })
        );
        // An already-array value is not double-wrapped.
        assert_eq!(
            map_args(&binding, json!({ "url": ["https://a", "https://b"] })),
            json!({ "urls": ["https://a", "https://b"] })
        );
    }

    #[test]
    fn the_binding_grammar_survives_json_deserialization() {
        // Every other grammar test constructs `CapabilityToolBinding` in-process, so
        // NONE of them would catch a serde rename/alias mistake — the manifest field
        // would simply deserialize to empty and the provider would silently stop
        // templating, clamping or substituting. Providers are DATA; parsing them from
        // JSON is the path that actually runs.
        let binding: CapabilityToolBinding = serde_json::from_value(json!({
            "tool": "mem0.add",
            "args": { "limit": "top_k", "scope": "" },
            "arg_defaults": { "user_id": "pref:mem0.user-id" },
            "arg_template": { "messages": [{ "role": "user", "content": "{content}" }] },
            "arg_clamp": { "limit": { "min": 1, "max": 20 } },
            "response": { "results": "results", "fields": { "content": "memory" } }
        }))
        .expect("the manifest form must deserialize");

        assert_eq!(binding.tool, "mem0.add");
        assert_eq!(binding.args.get("limit").map(String::as_str), Some("top_k"));
        assert!(
            !binding.arg_template.is_empty(),
            "arg_template must round-trip"
        );
        assert_eq!(
            referenced_pref_keys(&binding),
            vec!["mem0.user-id".to_owned()],
            "pref: tokens must be discoverable from the parsed form"
        );
        assert_eq!(binding.arg_clamp["limit"].max, Some(20));

        // And the parsed form behaves: template builds the nested body, the clamp
        // narrows, the drop drops.
        let prefs: BTreeMap<String, String> = [("mem0.user-id".to_owned(), "alice".to_owned())]
            .into_iter()
            .collect();
        let mapped = map_args_with_defaults(
            &binding,
            resolve_arg_defaults(&binding, &prefs),
            json!({ "content": "I moved to Berlin", "limit": 99, "scope": "user" }),
        );
        assert_eq!(
            mapped["messages"],
            json!([{ "role": "user", "content": "I moved to Berlin" }])
        );
        assert_eq!(mapped["user_id"], json!("alice"));
        assert_eq!(mapped["top_k"], json!(20), "clamped from 99");
        assert!(mapped.get("scope").is_none(), "dropped");
        assert!(mapped.get("content").is_none(), "consumed by the template");
    }

    #[test]
    fn a_template_builds_the_nested_body_a_flat_rename_cannot() {
        // THE case this exists for: Mem0's write endpoint takes
        // `messages: [{role, content}]`. Renames and the `[]` scalar wrap cannot build
        // an array of objects, which is why the whole write half of that provider —
        // and with it the `mirror` and `sync` kernel bridges — was unbindable.
        let mut binding = CapabilityToolBinding {
            tool: "mem0.add".to_owned(),
            ..Default::default()
        };
        binding.arg_template.insert(
            "messages".to_owned(),
            json!([{ "role": "user", "content": "{content}" }]),
        );

        let mapped = map_args(&binding, json!({ "content": "I moved to Berlin" }));
        assert_eq!(
            mapped["messages"],
            json!([{ "role": "user", "content": "I moved to Berlin" }])
        );
        // The consumed argument must NOT also appear flat, or the provider sees it
        // twice under two names.
        assert!(mapped.get("content").is_none());
    }

    #[test]
    fn a_whole_string_placeholder_preserves_the_arguments_json_type() {
        let mut binding = CapabilityToolBinding {
            tool: "p.x".to_owned(),
            ..Default::default()
        };
        binding
            .arg_template
            .insert("page".to_owned(), json!({ "size": "{limit}" }));
        let mapped = map_args(&binding, json!({ "limit": 25 }));
        // `25`, not `"25"` — a provider declaring an integer would reject the string.
        assert_eq!(mapped["page"]["size"], json!(25));
        assert!(mapped["page"]["size"].is_i64());
    }

    #[test]
    fn interpolation_inside_a_larger_string_still_works() {
        let mut binding = CapabilityToolBinding {
            tool: "p.x".to_owned(),
            ..Default::default()
        };
        binding
            .arg_template
            .insert("q".to_owned(), json!("site-search: {query}"));
        assert_eq!(
            map_args(&binding, json!({ "query": "rust" }))["q"],
            json!("site-search: rust")
        );
    }

    #[test]
    fn an_absent_placeholder_drops_its_field_instead_of_sending_the_token() {
        // Emitting a literal "{role}" would be sent upstream and treated as real
        // content — the same class of silent-wrongness as an unresolved `pref:` token.
        let mut binding = CapabilityToolBinding {
            tool: "p.x".to_owned(),
            ..Default::default()
        };
        binding.arg_template.insert(
            "messages".to_owned(),
            json!([{ "role": "{role}", "content": "{content}" }]),
        );
        let mapped = map_args(&binding, json!({ "content": "hi" }));
        // The object survives with the field it could fill; the unfillable one is gone.
        assert_eq!(mapped["messages"][0]["content"], json!("hi"));
        assert!(mapped["messages"][0].get("role").is_none());
    }

    #[test]
    fn a_binding_with_no_template_is_completely_unaffected() {
        let mut binding = CapabilityToolBinding {
            tool: "exa.search".to_owned(),
            ..Default::default()
        };
        binding
            .args
            .insert("limit".to_owned(), "num_results".to_owned());
        let mapped = map_args(&binding, json!({ "query": "q", "limit": 3 }));
        assert_eq!(mapped, json!({ "query": "q", "num_results": 3 }));
    }

    #[test]
    fn provider_defaults_can_reference_a_preference_instead_of_hardcoding() {
        // The concrete failure this prevents: Mem0 scopes every read to an entity id
        // that lives inside its `filters` object, which is not (and should not be) a
        // canonical verb argument. Hard-coding it gives every install the same fixed
        // bucket, so the provider returns nothing forever, silently.
        let mut binding = CapabilityToolBinding {
            tool: "mem0.search".to_owned(),
            ..Default::default()
        };
        binding.arg_defaults.insert(
            "filters".to_owned(),
            json!({ "user_id": "pref:mem0.user-id" }),
        );

        assert_eq!(
            referenced_pref_keys(&binding),
            vec!["mem0.user-id".to_owned()],
            "nested tokens must be discoverable so dispatch knows what to read"
        );

        let prefs: BTreeMap<String, String> = [("mem0.user-id".to_owned(), "alice".to_owned())]
            .into_iter()
            .collect();
        let resolved = resolve_arg_defaults(&binding, &prefs);
        assert_eq!(resolved["filters"]["user_id"], json!("alice"));

        // End to end through the mapper.
        let mapped = map_args_with_defaults(&binding, resolved, json!({ "query": "q" }));
        assert_eq!(mapped["filters"]["user_id"], json!("alice"));
        assert_eq!(mapped["query"], json!("q"));
    }

    #[test]
    fn an_unresolved_pref_token_drops_its_field_rather_than_sending_the_token() {
        // Sending a literal `"pref:mem0.user-id"` upstream would be treated as a real
        // entity id and silently match nothing. A missing field at least makes the
        // provider say so.
        let mut binding = CapabilityToolBinding {
            tool: "mem0.search".to_owned(),
            ..Default::default()
        };
        binding.arg_defaults.insert(
            "filters".to_owned(),
            json!({ "user_id": "pref:mem0.user-id", "app_id": "fixed" }),
        );

        let resolved = resolve_arg_defaults(&binding, &BTreeMap::new());
        assert!(resolved["filters"].get("user_id").is_none());
        // A literal sibling is untouched — only the token is conditional.
        assert_eq!(resolved["filters"]["app_id"], json!("fixed"));

        // An empty stored value counts as unset, not as an empty entity id.
        let blank: BTreeMap<String, String> = [("mem0.user-id".to_owned(), "   ".to_owned())]
            .into_iter()
            .collect();
        assert!(resolve_arg_defaults(&binding, &blank)["filters"]
            .get("user_id")
            .is_none());
    }

    #[test]
    fn a_binding_with_no_tokens_is_untouched_by_resolution() {
        let mut binding = CapabilityToolBinding {
            tool: "exa.search".to_owned(),
            ..Default::default()
        };
        binding
            .arg_defaults
            .insert("use_autoprompt".to_owned(), json!(true));
        assert!(referenced_pref_keys(&binding).is_empty());
        assert_eq!(
            resolve_arg_defaults(&binding, &BTreeMap::new())["use_autoprompt"],
            json!(true)
        );
    }

    #[test]
    fn a_provider_ceiling_clamps_instead_of_failing_the_call() {
        // The real case: `web.search.limit` allows up to 100, but Brave's `count`
        // maxes at 20. Without clamping, selecting Brave turns a valid `limit: 50`
        // into an upstream 4xx and the swap stops being transparent.
        let mut binding = CapabilityToolBinding {
            tool: "brave.search".to_owned(),
            ..Default::default()
        };
        binding.args.insert("limit".to_owned(), "count".to_owned());
        binding.arg_clamp.insert(
            "limit".to_owned(),
            crate::plugin_manifest::ArgBounds {
                min: Some(1),
                max: Some(20),
            },
        );

        // Over the ceiling → clamped, and renamed. Still an integer, not 20.0.
        let mapped = map_args(&binding, json!({ "query": "rust", "limit": 50 }));
        assert_eq!(mapped["count"], json!(20));
        assert!(
            mapped["count"].is_i64(),
            "clamping must not float-ify an integer"
        );

        // Inside the range → untouched.
        assert_eq!(
            map_args(&binding, json!({ "query": "rust", "limit": 5 }))["count"],
            json!(5)
        );
        // Below the floor → raised.
        assert_eq!(
            map_args(&binding, json!({ "query": "rust", "limit": 0 }))["count"],
            json!(1)
        );
    }

    #[test]
    fn clamping_is_keyed_by_the_canonical_name_and_ignores_the_irrelevant() {
        let mut binding = CapabilityToolBinding {
            tool: "p.search".to_owned(),
            ..Default::default()
        };
        binding.arg_clamp.insert(
            "limit".to_owned(),
            crate::plugin_manifest::ArgBounds {
                min: None,
                max: Some(20),
            },
        );
        // A non-numeric value under a clamped key is left for the provider to reject
        // rather than silently coerced.
        assert_eq!(
            map_args(&binding, json!({ "limit": "lots" }))["limit"],
            json!("lots")
        );
        // An absent argument is not invented.
        assert!(map_args(&binding, json!({ "query": "q" }))
            .get("limit")
            .is_none());
        // A binding with no clamps is a pure pass-through.
        let plain = CapabilityToolBinding {
            tool: "p.x".to_owned(),
            ..Default::default()
        };
        assert_eq!(map_args(&plain, json!({ "limit": 99 }))["limit"], json!(99));
    }

    #[test]
    fn caller_arguments_beat_provider_defaults() {
        let mut binding = CapabilityToolBinding {
            tool: "x".to_owned(),
            ..Default::default()
        };
        binding.arg_defaults.insert("limit".to_owned(), json!(10));
        let mapped = map_args(&binding, json!({ "limit": 3 }));
        assert_eq!(mapped, json!({ "limit": 3 }));
    }

    #[test]
    fn response_is_normalized_and_keeps_the_raw_item() {
        let provider = search_provider("@ryu/exa", true, "exa.search");
        let binding = provider.provides[0].tools.get("web.search").unwrap();
        let mapped = map_response(
            binding,
            "@ryu/exa",
            json!({ "results": [{ "title": "T", "url": "https://e", "text": "body", "score": 0.9 }] }),
        );
        assert_eq!(mapped["provider"], json!("@ryu/exa"));
        let first = &mapped["results"][0];
        assert_eq!(first["title"], json!("T"));
        assert_eq!(first["url"], json!("https://e"));
        assert_eq!(first["snippet"], json!("body"));
        // Nothing is destroyed: the provider's own record survives under `raw`.
        assert_eq!(first["raw"]["score"], json!(0.9));
    }

    #[test]
    fn two_providers_normalize_to_the_same_canonical_shape() {
        let exa = search_provider("@ryu/exa", true, "exa.search");
        let exa_binding = exa.provides[0].tools.get("web.search").unwrap();

        // A provider with a different envelope and different field names.
        let mut tavily_binding = CapabilityToolBinding {
            tool: "tavily.search".to_owned(),
            ..Default::default()
        };
        tavily_binding.response = Some(CapabilityResponseMap {
            results: Some("data.items".to_owned()),
            fields: [
                ("title".to_owned(), "name".to_owned()),
                ("url".to_owned(), "link".to_owned()),
                ("snippet".to_owned(), "content.summary".to_owned()),
            ]
            .into_iter()
            .collect(),
        });

        let from_exa = map_response(
            exa_binding,
            "@ryu/exa",
            json!({ "results": [{ "title": "T", "url": "https://e", "text": "body" }] }),
        );
        let from_tavily = map_response(
            &tavily_binding,
            "@ryu/tavily",
            json!({ "data": { "items": [{ "name": "T", "link": "https://e", "content": { "summary": "body" } }] } }),
        );

        for envelope in [&from_exa, &from_tavily] {
            let first = &envelope["results"][0];
            assert_eq!(first["title"], json!("T"));
            assert_eq!(first["url"], json!("https://e"));
            assert_eq!(first["snippet"], json!("body"));
        }
    }

    #[test]
    fn missing_response_map_passes_the_provider_output_through() {
        let binding = CapabilityToolBinding {
            tool: "x".to_owned(),
            ..Default::default()
        };
        let mapped = map_response(&binding, "p", json!({ "anything": 1 }));
        assert_eq!(mapped, json!({ "provider": "p", "raw": { "anything": 1 } }));
    }

    #[test]
    fn the_declarative_response_map_does_not_reshape_a_providers_values() {
        // The field map RENAMES; it does not transform. This used to be untrue: a
        // `collapse_scalar` helper here unwrapped single-element arrays purely
        // because Firecrawl types `metadata.title` as `string | string[]`. One
        // vendor's quirk sitting in shared code that every provider flows through
        // is the wrong place for it — Firecrawl now normalizes that in its own
        // adapter, which is what adapters exist for. Guard the boundary so the next
        // provider-specific transform does not get added here either.
        let mut binding = CapabilityToolBinding {
            tool: "firecrawl.scrape".to_owned(),
            ..Default::default()
        };
        binding.response = Some(CapabilityResponseMap {
            results: Some("data".to_owned()),
            fields: [("title".to_owned(), "metadata.title".to_owned())]
                .into_iter()
                .collect(),
        });

        let scalar = map_response(
            &binding,
            "@ryu/firecrawl",
            json!({ "data": { "metadata": { "title": "Foo" } } }),
        );
        assert_eq!(scalar["results"][0]["title"], json!("Foo"));

        // Verbatim, array and all — no kernel-side unwrapping.
        let array = map_response(
            &binding,
            "@ryu/firecrawl",
            json!({ "data": { "metadata": { "title": ["Foo"] } } }),
        );
        assert_eq!(array["results"][0]["title"], json!(["Foo"]));
    }

    // The acceptance test for the adapter seam: this file must contain no
    // provider-specific transform. `collapse_scalar` existed here solely for
    // Firecrawl; if a helper like it reappears, the grammar is growing per-vendor
    // again and the adapter seam is being bypassed.
    #[test]
    fn no_vendor_specific_transform_lives_in_the_shared_mapping_code() {
        let source = include_str!("capability_tools.rs");
        // Assembled at runtime so this guard does not match its OWN source text.
        let needle = format!("fn {}", "collapse_scalar");
        assert!(
            !source.contains(&needle),
            "that helper belongs in the provider's adapter, not in shared kernel code"
        );
    }

    #[test]
    fn a_provider_failure_envelope_is_never_flattened_into_zero_results() {
        // These are the EXACT shapes `tool_exec::finalize_http_result` returns when a
        // declarative http tool fails: the `fail_open` 401/403 envelope (a bad or
        // missing API key) and the generic non-2xx envelope. Reporting either as
        // `results: []` would tell the model "no search results" when the truth is
        // "your key is rejected" — the failure this test exists to prevent.
        let provider = search_provider("@ryu/exa", true, "exa.search");
        let binding = provider.provides[0].tools.get("web.search").unwrap();

        for failure in [
            json!({ "available": false, "reason": "endpoint returned HTTP 401", "hint": "check the key" }),
            json!({ "status": 500, "body": "upstream exploded" }),
        ] {
            let mapped = map_response(binding, "@ryu/exa", failure.clone());
            assert!(
                mapped.get("results").is_none(),
                "a failure envelope must not be presented as a result set: {mapped}"
            );
            assert_eq!(mapped["raw"], failure, "the real payload must survive");
        }
    }

    #[test]
    fn a_genuinely_empty_result_set_still_maps_to_zero_results() {
        // The other side of the coin: a provider that really found nothing returns
        // its envelope with an empty array, and that MUST stay a normal empty result
        // set rather than being mistaken for a failure.
        let provider = search_provider("@ryu/exa", true, "exa.search");
        let binding = provider.provides[0].tools.get("web.search").unwrap();
        let mapped = map_response(binding, "@ryu/exa", json!({ "results": [] }));
        assert_eq!(mapped["results"], json!([]));
    }

    #[test]
    fn the_success_shape_matches_what_an_unwrapped_http_tool_returns() {
        // Every provider manifest sets `unwrap_body: true`, and
        // `tool_exec::finalize_http_result` returns "the parsed upstream body
        // VERBATIM, no envelope" for a 2xx in that mode. So the declared `results`
        // paths are relative to the provider's OWN body — this test pins that
        // assumption, since a wrapped envelope would make every mapping miss.
        let provider = search_provider("@ryu/exa", true, "exa.search");
        let binding = provider.provides[0].tools.get("web.search").unwrap();
        let upstream_body_verbatim = json!({
            "requestId": "abc",
            "results": [{ "title": "T", "url": "https://e", "text": "body" }]
        });
        let mapped = map_response(binding, "@ryu/exa", upstream_body_verbatim);
        assert_eq!(mapped["results"][0]["title"], json!("T"));
        assert_eq!(mapped["results"][0]["snippet"], json!("body"));
    }
}
