//! Input schemas of the machine verbs: `browser.*` and `computer.*`, which a
//! conversation with a session Box runs on that Box (`box_desktop::plan`
//! checks every call against them).

use super::*;

pub(super) fn schema_browser_navigate() -> Value {
    // Deliberately NO `tab_id`. The verb means "open this URL in a new tab and tell
    // me which tab that is" — the cold-start move an agent actually needs, and the
    // one every browser provider can serve. Re-pointing an EXISTING tab was dropped
    // from the contract because a declarative provider tool has a single static URL
    // and cannot branch between "open" and "navigate" routes; advertising an
    // optional `tab_id` that the bound provider silently ignores is worse than not
    // offering it, since the model cannot tell the difference from the result.
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "url": { "type": "string", "description": "URL to open in a new browser tab." }
        },
        "required": ["url"]
    })
}

pub(super) fn schema_browser_tab_only() -> Value {
    // `tab_id` is REQUIRED, not "omit for the active tab". A declarative provider
    // tool interpolates it into a static URL path, so omitting it is a hard error
    // rather than a fall back to some active tab — and providers have no shared
    // notion of an active tab anyway. Call `browser.tabs` or `browser.navigate`
    // first; both return the id.
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "tab_id": { "type": "string", "description": "Target tab id, from browser.tabs or browser.navigate." }
        },
        "required": ["tab_id"]
    })
}

pub(super) fn schema_browser_click() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "ref": { "type": "string", "description": "Element reference from a prior browser.snapshot (e.g. \"@e3\")." },
            "tab_id": { "type": "string", "description": "Target tab; omit for the active tab." }
        },
        "required": ["ref"]
    })
}

pub(super) fn schema_browser_type() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
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

pub(super) fn schema_browser_scroll() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "direction": { "type": "string", "enum": ["up", "down", "left", "right"] },
            "amount": { "type": "integer", "description": "Scroll distance in pixels (provider default when omitted)." },
            "tab_id": { "type": "string", "description": "Target tab; omit for the active tab." }
        },
        "required": ["direction"]
    })
}

pub(super) fn schema_browser_context() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
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

pub(super) fn schema_browser_annotate() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
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

pub(super) fn schema_browser_hover() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "ref": { "type": "string", "description": "Element reference from browser.snapshot." },
            "tab_id": { "type": "string", "description": "Target tab; omit for the active tab." }
        },
        "required": ["ref"]
    })
}

pub(super) fn schema_browser_click_at() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
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

pub(super) fn schema_browser_key() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "keys": { "type": "array", "description": "Key tokens pressed together, e.g. [\"cmd\", \"l\"] or [\"Escape\"].", "items": { "type": "string" } },
            "tab_id": { "type": "string", "description": "Target tab; omit for the active tab." }
        },
        "required": ["keys"]
    })
}

pub(super) fn schema_browser_drag() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "from": { "type": "object", "properties": { "x": { "type": "number" }, "y": { "type": "number" } }, "required": ["x", "y"] },
            "to": { "type": "object", "properties": { "x": { "type": "number" }, "y": { "type": "number" } }, "required": ["x", "y"] },
            "tab_id": { "type": "string", "description": "Target tab; omit for the active tab." }
        },
        "required": ["from", "to"]
    })
}

pub(super) fn schema_computer_capture() -> Value {
    // Deliberately NO `mode`. The verb captures the screen the one way the bound
    // provider knows how; advertising a som/ax/screenshot choice that providers
    // silently ignore is worse than not offering it, because the model cannot tell
    // from the result which mode it actually got. (Ghost, the only provider today,
    // always returns set-of-mark output — an image plus an indexed element list.)
    json!({ "type": "object", "properties": {}, "additionalProperties": false })
}

pub(super) fn schema_computer_click() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "x": { "type": "integer", "description": "Screen x coordinate." },
            "y": { "type": "integer", "description": "Screen y coordinate." },
            "button": { "type": "string", "enum": ["left", "right", "middle"] },
            "count": { "type": "integer", "description": "Click count (2 = double-click).", "minimum": 1, "maximum": 3 }
        },
        "required": ["x", "y"]
    })
}

pub(super) fn schema_computer_type() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": { "text": { "type": "string", "description": "Text to type at the current focus." } },
        "required": ["text"]
    })
}

pub(super) fn schema_computer_key() -> Value {
    // An ARRAY of key tokens, not a `"cmd+s"` chord string. Desktop drivers press
    // and release individual keys, so they take the tokens already split; a chord
    // string would force every provider to re-parse it, and each would disagree
    // about the separator. Splitting is also not something the declarative argument
    // mapping can express, so a string here would be unserveable by construction.
    json!({
        "type": "object",
        "additionalProperties": false,
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

pub(super) fn schema_computer_scroll() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "x": { "type": "integer", "description": "Screen x to scroll at. Strongly recommended: a provider that has no coordinate falls back to a fixed point, which may not be over the content you mean." },
            "y": { "type": "integer", "description": "Screen y to scroll at. See `x`." },
            "direction": { "type": "string", "enum": ["up", "down", "left", "right"] },
            "amount": { "type": "integer", "description": "Scroll distance (provider-defined units)." }
        },
        "required": ["direction"]
    })
}

pub(super) fn schema_computer_focus_app() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": { "app": { "type": "string", "description": "Application name to bring to the front." } },
        "required": ["app"]
    })
}

/// `browser.fill_credential`: one field of an account into one element. The
/// account is an id from `browser.list_credentials`; the value never appears
/// in the arguments or the result.
pub(super) fn schema_browser_fill_credential() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "account": { "type": "string", "description": "An account id from your account list (browser.list_credentials), or an attached item's handle such as \"attached:1\"." },
            "field": { "type": "string", "enum": ["username", "email", "password", "totp"], "description": "Which field of the account to fill." },
            "ref": { "type": "string", "description": "Element reference from browser.snapshot, e.g. \"@e3\"." },
            "tab_id": { "type": "string", "description": "Target tab; omit for the active tab." },
            "submit": { "type": "boolean", "description": "Press Enter after filling." }
        },
        "required": ["account", "field", "ref"]
    })
}

/// `browser.list_credentials` takes no arguments, and refuses any.
pub(super) fn schema_browser_list_credentials() -> Value {
    json!({ "type": "object", "properties": {}, "additionalProperties": false })
}

pub(super) fn schema_browser_tabs() -> Value {
    json!({ "type": "object", "properties": {}, "additionalProperties": false })
}
