// All 30 MCP tool definitions — ported from ghost-os MCPTools.swift, plus
// ghost_snapshot (snapshot/ref model, ported in spirit from lahfir/agent-desktop).
// These are the agent-facing contracts: names, descriptions, and parameter schemas.

use serde_json::{json, Value};

pub fn definitions() -> Vec<Value> {
    vec![
        // Perception (8)
        tool("ghost_context",
            "Get orientation: focused app, window title, URL (browsers), focused element, and interactive elements. Call this before acting on any app.",
            &[("app", "string", "App name to get context for. If omitted, returns focused app.", false)],
            &[]),

        tool("ghost_state",
            "List all running apps and their windows with titles, positions, and sizes.",
            &[("app", "string", "Filter to a specific app.", false)],
            &[]),

        tool_rich("ghost_find",
            "Find elements in any app. Returns matching elements with role, name, position, and available actions.",
            json!({
                "type": "object",
                "properties": {
                    "query":      { "type": "string",  "description": "Text to search for (matches title, value, identifier, description)." },
                    "role":       { "type": "string",  "description": "AX role filter (e.g. AXButton, AXTextField, AXLink)." },
                    "dom_id":     { "type": "string",  "description": "Find by DOM id (web apps, bypasses depth limits)." },
                    "dom_class":  { "type": "string",  "description": "Find by CSS class." },
                    "identifier": { "type": "string",  "description": "Find by AX identifier." },
                    "app":        { "type": "string",  "description": "Which app to search in." },
                    "depth":      { "type": "integer", "description": "Max search depth (default: 25, max: 100)." }
                }
            })),

        tool("ghost_read",
            "Read text content from screen. Returns concatenated text from the element subtree.",
            &[
                ("app",   "string",  "Which app to read from.", false),
                ("query", "string",  "Narrow to specific element.", false),
                ("depth", "integer", "How deep to read (default: 25).", false),
            ],
            &[]),

        tool_rich("ghost_inspect",
            "Full metadata about one element. Call this before acting on something you're unsure about. Returns role, title, position, size, actionable status, supported actions, editable, DOM id, and more.",
            json!({
                "type": "object",
                "properties": {
                    "query":     { "type": "string", "description": "Element to inspect (text/name)." },
                    "dom_id":    { "type": "string", "description": "Find by DOM id (CDP)." },
                    "dom_class": { "type": "string", "description": "Find by CSS class (CDP)." }
                }
            })),

        tool_rich("ghost_element_at",
            "What element is at this screen position? Bridges screenshots and accessibility tree.",
            json!({
                "type": "object",
                "properties": {
                    "x": { "type": "number", "description": "X coordinate." },
                    "y": { "type": "number", "description": "Y coordinate." }
                },
                "required": ["x", "y"]
            })),

        tool("ghost_screenshot",
            "Take a screenshot for visual debugging. Returns base64 PNG.",
            &[
                ("full_resolution","boolean", "Native resolution instead of 1280px resize (default: false).", false),
            ],
            &[]),

        tool_rich("ghost_snapshot",
            "Capture a compact skeleton of the focused window with stable @eN element refs and children_count per node. Token-efficient orientation: snapshot once, then act on refs (ghost_click/ghost_type with {\"ref\":\"@eN\"}) instead of re-describing elements. Pass 'root':'@eN' to expand a container without re-capturing. Drill-down is bounded by the original capture depth (~6 levels on Windows/Linux, ~25 on macOS); for elements below that, snapshot that app/window directly.",
            json!({
                "type": "object",
                "properties": {
                    "app":      { "type": "string",  "description": "App to focus and snapshot first. If omitted, uses the currently focused window." },
                    "root":     { "type": "string",  "description": "Expand this @eN container from an existing snapshot instead of capturing fresh." },
                    "snapshot": { "type": "string",  "description": "Snapshot id to drill into with 'root' (default: latest)." },
                    "depth":    { "type": "integer", "description": "Skeleton render depth (default: 3, max: 10). Higher = more nodes, more tokens." }
                }
            })),

        // Actions (10)
        tool_rich("ghost_click",
            "Click an element. Tries AX-native first, falls back to synthetic click. Returns post-click context.",
            json!({
                "type": "object",
                "properties": {
                    "ref":       { "type": "string",  "description": "Click an @eN ref from a prior ghost_snapshot (re-identified live; errors STALE_REF if gone)." },
                    "query":     { "type": "string",  "description": "What to click (element text/name)." },
                    "dom_id":    { "type": "string",  "description": "Click by DOM id (CDP)." },
                    "dom_class": { "type": "string",  "description": "Click by CSS class (CDP)." },
                    "app":    { "type": "string",  "description": "Which app (auto-focuses if needed)." },
                    "x":      { "type": "number",  "description": "Click at X coordinate instead of element." },
                    "y":      { "type": "number",  "description": "Click at Y coordinate." },
                    "button": { "type": "string",  "description": "left (default), right, or middle." },
                    "count":  { "type": "integer", "description": "Click count: 1=single, 2=double, 3=triple." }
                }
            })),

        tool_rich("ghost_type",
            "Type text into a field. If 'into' is specified, finds the field first. Returns readback verification.",
            json!({
                "type": "object",
                "properties": {
                    "text":      { "type": "string",  "description": "Text to type." },
                    "ref":       { "type": "string",  "description": "Target field by @eN ref from a prior ghost_snapshot (clicks to focus, then types; errors STALE_REF if gone)." },
                    "into":      { "type": "string",  "description": "Target field name (finds via accessibility). If omitted, types at focus." },
                    "dom_id":    { "type": "string",  "description": "Target field by DOM id." },
                    "dom_class": { "type": "string",  "description": "Target field by CSS class." },
                    "app":       { "type": "string",  "description": "Which app." },
                    "clear":     { "type": "boolean", "description": "Clear field before typing (default: false)." }
                },
                "required": ["text"]
            })),

        tool_rich("ghost_press",
            "Press a single key. Always include app parameter to ensure correct target.",
            json!({
                "type": "object",
                "properties": {
                    "key":       { "type": "string",  "description": "Key name: return, tab, escape, space, delete, up, down, left, right, f1-f12." },
                    "modifiers": { "type": "array", "items": { "type": "string" }, "description": "Modifier keys: cmd, shift, option, control." },
                    "app":       { "type": "string",  "description": "Auto-focus this app first (IMPORTANT for synthetic input)." }
                },
                "required": ["key"]
            })),

        tool_rich("ghost_hotkey",
            "Press a key combination. Modifier keys are auto-cleared afterward. Always include app parameter.",
            json!({
                "type": "object",
                "properties": {
                    "keys": { "type": "array", "items": { "type": "string" }, "description": "Key combo, e.g. [\"cmd\", \"return\"] or [\"ctrl\", \"shift\", \"p\"]." },
                    "app":  { "type": "string", "description": "Auto-focus this app first (IMPORTANT for synthetic input)." }
                },
                "required": ["keys"]
            })),

        tool_rich("ghost_scroll",
            "Scroll content in a direction.",
            json!({
                "type": "object",
                "properties": {
                    "direction": { "type": "string",  "description": "up, down, left, or right." },
                    "amount":    { "type": "integer", "description": "Scroll amount in lines (default: 3)." },
                    "app":       { "type": "string",  "description": "Auto-focus this app first." },
                    "x":         { "type": "number",  "description": "Scroll at specific X position." },
                    "y":         { "type": "number",  "description": "Scroll at specific Y position." }
                },
                "required": ["direction"]
            })),

        tool_rich("ghost_hover",
            "Move cursor to an element or position WITHOUT clicking. Triggers tooltips, CSS :hover, menu navigation. Use ghost_read after to see what appeared.",
            json!({
                "type": "object",
                "properties": {
                    "query":     { "type": "string",  "description": "Element to hover over (centers cursor on element)." },
                    "dom_id":    { "type": "string",  "description": "Hover by DOM id (CDP)." },
                    "dom_class": { "type": "string",  "description": "Hover by CSS class." },
                    "app":       { "type": "string",  "description": "Which app (auto-focuses — hover effects need focus)." },
                    "x":         { "type": "number",  "description": "Hover at X coordinate instead of element." },
                    "y":         { "type": "number",  "description": "Hover at Y coordinate." }
                }
            })),

        tool_rich("ghost_long_press",
            "Press and hold at a position for a duration. Triggers long-press menus, context menus, and drag-initiation behaviors.",
            json!({
                "type": "object",
                "properties": {
                    "query":     { "type": "string",  "description": "Element to long-press (centers on element)." },
                    "dom_id":    { "type": "string",  "description": "Long-press by DOM id (CDP)." },
                    "dom_class": { "type": "string",  "description": "Long-press by CSS class." },
                    "app":       { "type": "string",  "description": "Which app (auto-focuses)." },
                    "x":         { "type": "number",  "description": "Long-press at X coordinate." },
                    "y":         { "type": "number",  "description": "Long-press at Y coordinate." },
                    "duration":  { "type": "number",  "description": "Hold duration in seconds (default: 1.0)." },
                    "button":    { "type": "string",  "description": "left (default) or right." }
                }
            })),

        tool_rich("ghost_drag",
            "Drag from one point to another. Use for: moving files, adjusting sliders, reordering lists, selecting text, resizing panes.",
            json!({
                "type": "object",
                "properties": {
                    "from_x":        { "type": "number", "description": "Start X coordinate." },
                    "from_y":        { "type": "number", "description": "Start Y coordinate." },
                    "to_x":          { "type": "number", "description": "End X coordinate." },
                    "to_y":          { "type": "number", "description": "End Y coordinate." },
                    "query":         { "type": "string", "description": "Element to drag (finds center as start point). Alternative to from_x/from_y." },
                    "dom_id":        { "type": "string", "description": "Find drag source by DOM id." },
                    "app":           { "type": "string", "description": "Which app (auto-focuses for synthetic input)." },
                    "duration":      { "type": "number", "description": "Drag duration in seconds (default: 0.5)." },
                    "hold_duration": { "type": "number", "description": "Seconds to hold at start before moving (default: 0.1)." }
                },
                "required": ["to_x", "to_y"]
            })),

        tool_rich("ghost_focus",
            "Bring an app or window to the front.",
            json!({
                "type": "object",
                "properties": {
                    "app":    { "type": "string", "description": "App name to focus." },
                    "window": { "type": "string", "description": "Window title substring to focus specific window." }
                },
                "required": ["app"]
            })),

        tool_rich("ghost_window",
            "Window management: minimize, maximize, close, restore, move, resize, or list windows.",
            json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "description": "minimize, maximize, close, restore, move, resize, or list." },
                    "app":    { "type": "string", "description": "Target app." },
                    "window": { "type": "string", "description": "Window title (if omitted, acts on frontmost window of app)." },
                    "x":      { "type": "number", "description": "X position for move." },
                    "y":      { "type": "number", "description": "Y position for move." },
                    "width":  { "type": "number", "description": "Width for resize." },
                    "height": { "type": "number", "description": "Height for resize." }
                },
                "required": ["action", "app"]
            })),

        // Wait (1)
        tool_rich("ghost_wait",
            "Wait for a condition instead of using fixed delays. Polls until condition is met or timeout.",
            json!({
                "type": "object",
                "properties": {
                    "condition": { "type": "string", "description": "urlContains, titleContains, elementExists, elementGone, urlChanged, titleChanged, delay. For delay, timeout is the sleep duration and no value is needed." },
                    "value":     { "type": "string", "description": "Match value (required for urlContains, titleContains, elementExists, elementGone; not used for delay)." },
                    "timeout":   { "type": "number", "description": "Max seconds to wait (default: 10)." },
                    "interval":  { "type": "number", "description": "Poll interval in seconds (default: 0.5)." }
                },
                "required": ["condition"]
            })),

        // Recipes (5)
        tool("ghost_recipes",
            "List all installed recipes with descriptions and parameters. ALWAYS check this first before doing multi-step tasks manually.",
            &[], &[]),

        tool_rich("ghost_run",
            "Execute a recipe with parameter substitution. Returns step-by-step results.",
            json!({
                "type": "object",
                "properties": {
                    "recipe": { "type": "string", "description": "Recipe name." },
                    "params": { "type": "object", "description": "Parameter values for substitution." }
                },
                "required": ["recipe"]
            })),

        tool_rich("ghost_recipe_show",
            "View full recipe details: steps, parameters, preconditions.",
            json!({
                "type": "object",
                "properties": { "name": { "type": "string", "description": "Recipe name." } },
                "required": ["name"]
            })),

        tool_rich("ghost_recipe_save",
            "Install a new recipe from JSON.",
            json!({
                "type": "object",
                "properties": { "recipe_json": { "type": "string", "description": "Complete recipe JSON string." } },
                "required": ["recipe_json"]
            })),

        tool_rich("ghost_recipe_delete",
            "Delete a recipe.",
            json!({
                "type": "object",
                "properties": { "name": { "type": "string", "description": "Recipe name to delete." } },
                "required": ["name"]
            })),

        // Vision (2)
        tool("ghost_parse_screen",
            "Detect ALL interactive UI elements on screen using vision (YOLO + VLM). Returns bounding boxes, types, and labels. Use when AX tree returns generic elements (web apps in Chrome).",
            &[
                ("app",            "string",  "Screenshot specific app window.", false),
                ("full_resolution","boolean", "Native resolution instead of 1280px resize (default: false).", false),
            ],
            &[]),

        tool_rich("ghost_ground",
            "Find precise screen coordinates for a described UI element using vision (VLM). Use when ghost_find can't locate the element or returns AXGroup elements.",
            json!({
                "type": "object",
                "properties": {
                    "description": { "type": "string", "description": "What to find (e.g. 'Compose button', 'Send button', 'search field')." },
                    "crop_box":    { "type": "array", "items": { "type": "number" }, "description": "Optional crop region [x1, y1, x2, y2] in logical points." }
                },
                "required": ["description"]
            })),

        // Annotate (1)
        tool_rich("ghost_annotate",
            "Screenshot with numbered labels [1], [2], [3]... on interactive UI elements. Returns an annotated image and a text index mapping each label to its element's role, name, and click coordinates. Call this for visual orientation, then use ghost_click with the x/y from the index. Zero ML — instant, uses the accessibility tree.",
            json!({
                "type": "object",
                "properties": {
                    "roles":      { "type": "array", "items": { "type": "string" }, "description": "AX roles to include (default: buttons, links, fields, checkboxes, combos, tabs, sliders)." },
                    "max_labels": { "type": "integer", "description": "Maximum number of labels (default: 50, max: 100)." }
                }
            })),

        // Learning (3)
        tool("ghost_learn_start",
            "Start observing the user's actions for workflow learning. Ghost records clicks, keystrokes, and app switches. Call ghost_learn_stop when done. Requires Input Monitoring permission (System Settings > Privacy & Security > Input Monitoring).",
            &[("task_description", "string", "Brief description of what the user is about to do (e.g., 'send an email in Gmail').", false)],
            &[]),

        tool("ghost_learn_stop",
            "Stop observing and return the recorded action sequence. Returns an array of observed actions with AX context for each click and typed text.",
            &[], &[]),

        tool("ghost_learn_status",
            "Check if learning mode is active, how many actions have been recorded, and how long the session has been running.",
            &[], &[]),
    ]
}

// ─── Schema helpers ───────────────────────────────────────────────────────────

fn tool(name: &str, description: &str, props: &[(&str, &str, &str, bool)], required: &[&str]) -> Value {
    let mut properties = serde_json::Map::new();
    for (pname, ptype, pdesc, _) in props {
        properties.insert(pname.to_string(), json!({ "type": ptype, "description": pdesc }));
    }
    let mut schema = json!({ "type": "object", "properties": properties });
    if !required.is_empty() {
        schema["required"] = json!(required);
    }
    json!({
        "name": name,
        "description": description,
        "inputSchema": schema,
    })
}

fn tool_rich(name: &str, description: &str, schema: Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": schema,
    })
}
