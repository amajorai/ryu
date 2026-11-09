//! Device data in what an ACP agent reports, and what a conversation's
//! history already holds.
//!
//! On the ACP plane the bridge returns the full device envelope to the agent,
//! and the agent echoes its own `tool_call` / `tool_call_update` frames with
//! `rawInput` / `rawOutput`. Those frames are rendered, persisted, replayed on
//! resume and recorded on trace spans, so for a device tool they are replaced
//! by the redacted display forms (design §0.9, §3.1) before anything sees them.
//!
//! The same scan of tool names decides what a stored history already holds:
//! untrusted external content (any tool output that is not a device tool's)
//! and earlier device reads (design §2.4 step 9).

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};

use super::catalog::{catalog, CatalogTool};
use super::display;
use super::gate;
use super::offer::DeviceOffer;

/// The catalog tool an agent-reported tool title names. Agents prefix bridge
/// tools in their own ways (`mcp__ryu__device_calendar_create`,
/// `ryu.device_calendar_create`, `ryu_device_calendar_create`), so every
/// `device` token that starts at a word boundary is tried.
pub(crate) fn device_tool_in_title(title: &str) -> Option<&'static CatalogTool> {
    title.match_indices("device").find_map(|(index, _)| {
        let boundary = title[..index]
            .chars()
            .next_back()
            .is_none_or(|before| !before.is_ascii_alphanumeric());
        if !boundary {
            return None;
        }
        let candidate: String = title[index..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '.')
            .collect();
        catalog().tool(candidate.trim_end_matches('.'))
    })
}

/// The display input persisted in place of the agent's `rawInput`.
pub(crate) fn redact_agent_input(tool: &CatalogTool, input: Option<Value>) -> Option<Value> {
    input.map(|input| display::redact_input_for_display(tool, &input))
}

/// The display result persisted in place of the agent's `rawOutput` /
/// content. The envelope is looked for in whatever shape the agent echoed
/// (the object itself, a content block, or JSON inside a text); when none is
/// found nothing of the output is kept.
pub(crate) fn redact_agent_output(tool: &CatalogTool, output: Option<Value>) -> Option<Value> {
    let output = output?;
    Some(match find_envelope(&output, 0) {
        Some(envelope) => display::redact_result_for_display(tool, &envelope),
        None => json!({ "display": { "summary": "Phone action finished" } }),
    })
}

fn is_envelope(value: &Value) -> bool {
    value.get("ok").is_some_and(Value::is_boolean)
}

fn find_envelope(value: &Value, depth: usize) -> Option<Value> {
    if depth > 6 {
        return None;
    }
    match value {
        Value::Object(map) => {
            if is_envelope(value) {
                return Some(value.clone());
            }
            map.values()
                .find_map(|child| find_envelope(child, depth + 1))
        }
        Value::Array(items) => items
            .iter()
            .find_map(|child| find_envelope(child, depth + 1)),
        Value::String(text) => envelope_in_text(text),
        _ => None,
    }
}

fn envelope_in_text(text: &str) -> Option<Value> {
    text.match_indices('{').find_map(|(index, _)| {
        let parsed = serde_json::Deserializer::from_str(&text[index..])
            .into_iter::<Value>()
            .next()?
            .ok()?;
        is_envelope(&parsed).then_some(parsed)
    })
}

/// ACP tool kinds that never bring outside content into the turn.
const INERT_KINDS: &[&str] = &["think", "switch_mode"];
/// Unclassified calls whose raw input is kept for correlation at result time.
const MAX_HELD_INPUTS: usize = 64;

/// An offered device tool whose argument shape `input` has: every key is one
/// of its properties and every required property is present. Used before the
/// bridge has seen a call (agents usually announce a call before running it).
fn shape_match(offer: &DeviceOffer, input: &Value) -> Option<&'static CatalogTool> {
    let map = input.as_object().filter(|map| !map.is_empty())?;
    offer
        .offerable
        .iter()
        .filter_map(|id| catalog().tool(id))
        .find(|tool| {
            let properties = tool
                .input_schema
                .get("properties")
                .and_then(Value::as_object);
            let required = tool.input_schema.get("required").and_then(Value::as_array);
            map.keys()
                .all(|key| properties.is_some_and(|props| props.contains_key(key)))
                && required
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .all(|key| map.contains_key(key))
        })
}

/// The display form of an input that only LOOKS like a device call: the
/// device-tool redaction without claiming which tool it was.
fn redact_suspect(tool: &CatalogTool, input: &Value) -> Value {
    let mut shown = display::redact_input_for_display(tool, input);
    if let Some(map) = shown.as_object_mut() {
        map.remove("tool");
    }
    shown
}

/// Applied to an ACP turn's agent-reported tool frames before they are
/// rendered, persisted, replayed or traced: device calls keep only their
/// display forms, and while the turn carries a device offer any other tool
/// the agent runs (its own fetch, shell or file tools included, which never
/// pass through the bridge) marks the turn as holding untrusted input.
///
/// A device call is recognized by the tool name in the agent's title, or by
/// bridge-side correlation (`DeviceOffer::bridge_calls`): its input holds the
/// arguments the bridge dispatched, or its output the envelope the bridge
/// returned. A call announced BEFORE the bridge saw it whose input has the
/// shape of an offered device tool is shown redacted until its result settles
/// it.
pub(crate) struct AgentToolFilter {
    offer: Option<Arc<DeviceOffer>>,
    device_calls: HashMap<String, &'static CatalogTool>,
    /// Shape-matched calls not yet confirmed by the bridge.
    suspects: HashMap<String, &'static CatalogTool>,
    /// Raw inputs of unclassified calls (offer turns only).
    held_inputs: HashMap<String, Value>,
}

impl AgentToolFilter {
    pub(crate) fn new(offer: Option<Arc<DeviceOffer>>) -> Self {
        Self {
            offer,
            device_calls: HashMap::new(),
            suspects: HashMap::new(),
            held_inputs: HashMap::new(),
        }
    }

    fn correlate(&self, input: Option<&Value>) -> Option<&'static CatalogTool> {
        let offer = self.offer.as_ref()?;
        offer.bridge_calls.match_input(input?)
    }

    fn device(&mut self, id: &str, tool: &'static CatalogTool) -> &'static CatalogTool {
        self.suspects.remove(id);
        self.held_inputs.remove(id);
        self.device_calls.insert(id.to_owned(), tool);
        tool
    }

    /// A `tool_call`: the title and input to show.
    pub(crate) fn on_call(
        &mut self,
        id: &str,
        title: String,
        kind: &str,
        input: Option<Value>,
    ) -> (String, Option<Value>) {
        let known = device_tool_in_title(&title)
            .or_else(|| self.device_calls.get(id).copied())
            .or_else(|| self.correlate(input.as_ref()));
        if let Some(tool) = known {
            let tool = self.device(id, tool);
            return (tool.alias.clone(), redact_agent_input(tool, input));
        }
        let Some(offer) = self.offer.clone() else {
            return (title, input);
        };
        if let Some(raw) = input.as_ref() {
            if self.held_inputs.len() < MAX_HELD_INPUTS {
                self.held_inputs.insert(id.to_owned(), raw.clone());
            }
        }
        if let Some(tool) = input.as_ref().and_then(|raw| shape_match(&offer, raw)) {
            self.suspects.insert(id.to_owned(), tool);
            let shown = input.as_ref().map(|raw| redact_suspect(tool, raw));
            return (title, shown);
        }
        if !INERT_KINDS.contains(&kind) {
            offer.mark_tainted_input();
        }
        (title, input)
    }

    /// A `tool_call_update`: the output and input to show. `terminal` is set
    /// on the call's final update.
    pub(crate) fn on_result(
        &mut self,
        id: &str,
        output: Option<Value>,
        input: Option<Value>,
        terminal: bool,
    ) -> (Option<Value>, Option<Value>) {
        if let Some(tool) = self.device_calls.get(id).copied() {
            return (
                redact_agent_output(tool, output),
                redact_agent_input(tool, input),
            );
        }
        let Some(offer) = self.offer.clone() else {
            return (output, input);
        };
        if let Some(raw) = input.as_ref() {
            if self.held_inputs.contains_key(id) || self.held_inputs.len() < MAX_HELD_INPUTS {
                self.held_inputs.insert(id.to_owned(), raw.clone());
            }
        }
        let held = self.held_inputs.get(id).cloned();
        let correlated = self
            .correlate(input.as_ref())
            .or_else(|| self.correlate(held.as_ref()))
            .or_else(|| {
                let envelope = find_envelope(output.as_ref()?, 0)?;
                offer.bridge_calls.match_output(&envelope)
            });
        if let Some(tool) = correlated {
            self.device(id, tool);
            // The re-emitted input corrects the frame the call opened with,
            // in the stream and in the persisted part.
            let shown = redact_agent_input(tool, input.or(held));
            return (redact_agent_output(tool, output), shown);
        }
        if let Some(tool) = self.suspects.get(id).copied() {
            // Still unconfirmed: keep showing the redacted form.
            let shown = input.as_ref().map(|raw| redact_suspect(tool, raw));
            if terminal {
                // It ran without the bridge, so it was the agent's own tool.
                self.suspects.remove(id);
                self.held_inputs.remove(id);
                offer.mark_tainted_input();
            }
            return (output, shown);
        }
        if terminal {
            self.held_inputs.remove(id);
        }
        (output, input)
    }
}

/// What a stored or submitted history already holds.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct HistoryMarks {
    /// A non-device tool produced output (web, files, connectors, browser).
    pub(crate) untrusted: bool,
    /// The first device read whose result is in the history.
    pub(crate) private_read: Option<String>,
}

/// The tool name of an AI SDK tool part (`tool-<name>` or `dynamic-tool`).
fn part_tool_name(part: &Value) -> Option<&str> {
    let kind = part.get("type")?.as_str()?;
    if kind == "dynamic-tool" {
        return part.get("toolName")?.as_str();
    }
    kind.strip_prefix("tool-")
}

fn has_output(part: &Value) -> bool {
    part.get("output").is_some_and(|output| !output.is_null())
        || part
            .get("state")
            .and_then(Value::as_str)
            .is_some_and(|state| state.starts_with("output"))
}

impl HistoryMarks {
    /// Fold one message: its role and its render parts.
    pub(crate) fn add_message(&mut self, role: &str, parts: &[Value]) {
        if role == "tool" {
            self.untrusted = true;
        }
        for part in parts {
            let Some(name) = part_tool_name(part) else {
                continue;
            };
            if !has_output(part) {
                continue;
            }
            match device_tool_in_title(name) {
                Some(tool) if gate::is_read(tool) => {
                    if self.private_read.is_none() {
                        self.private_read = Some(tool.id.clone());
                    }
                }
                Some(_) => {}
                None => self.untrusted = true,
            }
        }
    }
}
