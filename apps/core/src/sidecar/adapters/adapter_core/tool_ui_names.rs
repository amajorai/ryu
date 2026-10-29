use super::*;

/// The canonical Claude-style tool names the desktop binds rich renderers to
/// (`tool-Bash` terminal, `tool-Edit` diff, `tool-TodoWrite` checklist, …).
///
/// Module-level rather than a `fn`-local const because the nested sub-step
/// fan-out canonicalizes against the SAME list via [`nested_step_tool_name`].
/// Two copies would drift, and the drift would surface only as nested rows with
/// no title — no error, no failing test.
///
/// `TaskOutput` is the odd entry: no agent titles a call that, and the desktop
/// deliberately SUPPRESSES `tool-TaskOutput` from the message list while
/// `CoworkContextPanel` reads it as a subagent's final answer. It lives here so
/// Core's own synthetic `<parent>:out` part shares one source of truth with
/// every other tool name — [`acp_tool_ui_name`] does not need it, since that
/// path mints the name directly.
pub(crate) const KNOWN_TOOLS: [&str; 15] = [
    "Bash",
    "Read",
    "Edit",
    "Write",
    "Grep",
    "Glob",
    "WebFetch",
    "WebSearch",
    "TodoWrite",
    "PlanWrite",
    "ExitPlanMode",
    "Task",
    "Agent",
    "NotebookEdit",
    "TaskOutput",
];

/// Map a nested sub-step's declared tool name onto the part type the desktop's
/// nested-row registry can title.
///
/// Returns `(tool_name, dynamic)` with the same meaning as [`acp_tool_ui_name`].
///
/// The case fold is load-bearing, not cosmetic. Pi's built-in tools are
/// LOWERCASE (`read`, `bash`, `edit`, `write` — observed in a live
/// `before_agent_start` tool set) while [`KNOWN_TOOLS`] and the desktop's tool
/// registry key on the capitalized Claude-style spellings. Passing a step's name
/// through verbatim would mint `tool-read`, which no renderer knows, so the
/// nested row would render blank-titled — visible only in the UI, invisible to
/// every test on this side of the wire.
///
/// An unrecognized name (an MCP tool, a producer-specific verb) stays a
/// `dynamic` row under its own label: generic, but never blank.
pub(crate) fn nested_step_tool_name(raw: &str) -> (String, bool) {
    KNOWN_TOOLS
        .iter()
        .find(|known| known.eq_ignore_ascii_case(raw))
        .map_or_else(
            || (raw.to_owned(), true),
            |known| ((*known).to_owned(), false),
        )
}

/// One nested sub-step (`details.ryuSteps[n]`), resolved into everything the
/// synthetic child part's two frames need. Pure, so the defaulting rules are
/// testable without a live ACP stream.
pub(crate) struct NestedStep {
    /// Part type name: a canonical [`KNOWN_TOOLS`] spelling, or the producer's
    /// own name when it is not a known tool.
    pub(crate) name: String,
    /// `dynamic` flag — BOTH frames of the child part must carry the same one.
    pub(crate) dynamic: bool,
    /// Tool arguments; `null` while the producer has not filled them in yet.
    pub(crate) input: Value,
    /// The step's status verbatim, defaulting to `in_progress` when unstated —
    /// an unstated status means "still running", never "done".
    pub(crate) status: String,
    /// The step can no longer change, so its output frame (which CLOSES the row)
    /// may be emitted.
    pub(crate) terminal: bool,
}

/// Resolve one `details.ryuSteps` entry. Every field is optional on the wire: a
/// step is typically announced before its arguments, output and final status
/// exist, so each default here has to mean "not yet", not "absent".
pub(crate) fn nested_step(step: &Value) -> NestedStep {
    let raw_name = step.get("name").and_then(Value::as_str).unwrap_or("tool");
    let (name, dynamic) = nested_step_tool_name(raw_name);
    let status = step
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("in_progress")
        .to_owned();
    NestedStep {
        name,
        dynamic,
        input: step.get("input").cloned().unwrap_or(Value::Null),
        terminal: matches!(status.as_str(), "completed" | "error" | "failed"),
        status,
    }
}

/// Stable suffix for a synthetic nested transaction id.
///
/// Array position remains the compatibility fallback. Producers that emit
/// parallel work can provide `id`, because inserting a new step in one child
/// must not rename every later child's already-open transaction. Keep the id in
/// the parent's one-level namespace and reserve `out` for
/// [`acp::AcpEvent::ToolSteps`]
/// final-answer fan-out.
pub(crate) fn nested_step_suffix(step: &Value, fallback: usize) -> String {
    step.get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && *id != "out" && !id.contains(':') && id.len() <= 80)
        .map_or_else(|| fallback.to_string(), str::to_owned)
}

/// Map an ACP tool call (category `kind`, human `title`, raw `input`) onto the
/// canonical tool name the desktop renders rich UI for.
///
/// Returns `(tool_name, dynamic)`: `dynamic = false` means the name is one of
/// the known Claude-style tools (`tool-Bash`, `tool-Edit`, `tool-TodoWrite`, …)
/// with a matching input shape, so the client shows the specialized card.
/// Anything unrecognized stays a dynamic tool row under its original title.
pub(crate) fn acp_tool_ui_name(kind: &str, title: &str, input: &Value) -> (String, bool) {
    // Some ACP adapters put the underlying tool name straight into the title.
    if KNOWN_TOOLS.contains(&title) {
        return (title.to_owned(), false);
    }
    let has = |key: &str| input.get(key).is_some();
    match kind {
        "execute" if has("command") => ("Bash".to_owned(), false),
        "read" if has("file_path") => ("Read".to_owned(), false),
        "edit" if has("file_path") => {
            if has("content") && !has("old_string") {
                ("Write".to_owned(), false)
            } else {
                ("Edit".to_owned(), false)
            }
        }
        "fetch" if has("url") => ("WebFetch".to_owned(), false),
        "search" if has("query") => ("WebSearch".to_owned(), false),
        "search" if has("pattern") => ("Grep".to_owned(), false),
        "think" if has("todos") => ("TodoWrite".to_owned(), false),
        "think" => ("Thinking".to_owned(), false),
        // Kind-only fallbacks: ACP does not standardize `raw_input` field names,
        // so when the specific-key arms above don't match (a non-Claude input
        // schema), map on the protocol `kind` alone. This keeps an ACP agent's
        // edits/reads/commands/searches on their rich renderers (diff card,
        // terminal, search group) instead of dropping to a generic row — the
        // edit's actual diff still arrives via the ACP `Diff` content block
        // (see `extract_diff_output`).
        "execute" => ("Bash".to_owned(), false),
        "read" => ("Read".to_owned(), false),
        "edit" => ("Edit".to_owned(), false),
        "fetch" => ("WebFetch".to_owned(), false),
        "search" => ("WebSearch".to_owned(), false),
        // Built-in artifact surface (`artifact.render`). ACP exposes no stable
        // machine tool name either, so detect it by its unique payload shape — a
        // nested `artifact` object, or a top-level `kind` + `content` pair — and
        // emit a stable name the desktop matches to render the inline card.
        _ if input.get("artifact").is_some_and(Value::is_object)
            || (input.get("kind").is_some_and(Value::is_string)
                && input.get("content").is_some_and(Value::is_string)) =>
        {
            ("artifact.render".to_owned(), true)
        }
        // Built-in generative-UI tool (`ui.render`). ACP exposes no stable machine
        // tool name (the `title` is humanized per-adapter), so detect it by its
        // unique format/spec-shaped input and emit a stable name the desktop matches
        // to render the UI inline. Native json-render uses `{ root, elements }`,
        // while A2UI is explicitly tagged with `format: "a2ui"`.
        _ if input
            .get("spec")
            .and_then(Value::as_object)
            .is_some_and(|s| s.contains_key("root") && s.contains_key("elements"))
            || (input.get("format").and_then(Value::as_str) == Some("a2ui")
                && input.get("spec").is_some()) =>
        {
            ("ui.render".to_owned(), true)
        }
        // Built-in consent cards (`consent.connect_app` / `consent.install_plugin`).
        // Only the qualified tool name in the title counts. No payload shape is
        // unique enough: an unrelated tool taking `{ app, reason }` must keep its
        // own row instead of becoming an actionable OAuth or install card.
        _ if title.ends_with("consent.connect_app") => ("consent.connect_app".to_owned(), true),
        _ if title.ends_with("consent.install_plugin") => {
            ("consent.install_plugin".to_owned(), true)
        }
        // Built-in suggested next task (`tasks.suggest`), matched by name for the
        // same reason: only Core's own tool may become a Start card.
        _ if title.ends_with("tasks.suggest") => ("tasks.suggest".to_owned(), true),
        _ => {
            let name = if title.is_empty() { kind } else { title };
            (name.to_owned(), true)
        }
    }
}

/// One ACP tool call whose opening `tool-input-available` frame has been sent,
/// kept so a later update carrying the call's arguments can correct that frame
/// instead of minting a second one.
pub(crate) struct OpenToolCall {
    /// ACP `kind` and `title` verbatim — the two inputs to [`acp_tool_frame`]
    /// that an update never repeats, so they have to be remembered here.
    pub(crate) kind: String,
    pub(crate) title: String,
    /// ACP `ToolCall.locations`, folded into every frame under `_ryuLocations`.
    pub(crate) locations: Vec<Value>,
    /// The part type and `dynamic` flag the opening frame declared. Both are
    /// PINNED: a re-emission that changed either would create a second part
    /// rather than update the first, so a later frame that would resolve
    /// differently is dropped instead (see the `ToolResult` arm).
    pub(crate) name: String,
    pub(crate) dynamic: bool,
    /// The raw arguments last turned into a frame, so an update that repeats
    /// them costs nothing.
    pub(crate) input: Value,
}
