use super::*;

/// Best-effort extraction of a shell command from a serialized ACP tool call.
///
/// Exec-capable agents surface the command under a handful of shapes: a
/// `command`/`cmd`/`script`/`shellCommand` string (or an argv array) either at
/// the top level or nested under `rawInput`/`raw_input`/`input`. Returns `None`
/// when nothing command-like is present, so non-exec tool calls are not scanned.
/// The scanner is a heuristic accident-prevention layer, not containment, so a
/// command it cannot see is out of scope by design.
pub(super) fn extract_exec_command(tool_call: &serde_json::Value) -> Option<String> {
    fn command_in(obj: &serde_json::Value) -> Option<String> {
        for key in ["command", "cmd", "script", "shellCommand"] {
            if let Some(s) = obj.get(key).and_then(serde_json::Value::as_str) {
                if !s.trim().is_empty() {
                    return Some(s.to_owned());
                }
            }
        }
        // Some agents pass argv as an array of strings.
        if let Some(arr) = obj.get("command").and_then(serde_json::Value::as_array) {
            let joined = arr
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect::<Vec<_>>()
                .join(" ");
            if !joined.trim().is_empty() {
                return Some(joined);
            }
        }
        None
    }

    if let Some(c) = command_in(tool_call) {
        return Some(c);
    }
    for key in ["rawInput", "raw_input", "input"] {
        if let Some(c) = tool_call.get(key).and_then(command_in) {
            return Some(c);
        }
    }
    None
}

/// Extract a scannable representation of a FILE-MUTATING tool call
/// (Write/Edit/MultiEdit/NotebookEdit and the like) so path-based gateway deny
/// rules apply to native file tools that carry no shell command. Native coding
/// agents (Claude Code, Codex, …) edit files through dedicated tools whose input
/// is `{ file_path, content }` / `{ file_path, new_string }` — there is no
/// `command` field, so [`extract_exec_command`] misses them and the write slips
/// the gate. We synthesize a `"write <path>"` string so a policy that denies
/// writes under, e.g., `.ssh` / `.env` / `/etc` still fires. Read-only tools
/// (Read/Grep with a path but no content/edit payload) are deliberately NOT swept
/// in. Returns `None` when nothing write-like is present.
pub(super) fn extract_file_write(tool_call: &serde_json::Value) -> Option<String> {
    fn path_in(obj: &serde_json::Value) -> Option<String> {
        for key in [
            "file_path",
            "filePath",
            "path",
            "abs_path",
            "absPath",
            "notebook_path",
            "notebookPath",
        ] {
            if let Some(s) = obj.get(key).and_then(serde_json::Value::as_str) {
                if !s.trim().is_empty() {
                    return Some(s.to_owned());
                }
            }
        }
        None
    }
    // A write is a path PLUS a mutating payload; without the payload it may be a
    // read (Read/Grep take a path too), which must not be treated as a write.
    fn is_write(obj: &serde_json::Value) -> bool {
        [
            "content",
            "new_string",
            "newString",
            "edits",
            "new_source",
            "newSource",
        ]
        .iter()
        .any(|k| obj.get(k).is_some())
    }
    fn write_path(obj: &serde_json::Value) -> Option<String> {
        if is_write(obj) {
            path_in(obj)
        } else {
            None
        }
    }

    if let Some(p) = write_path(tool_call) {
        return Some(format!("write {p}"));
    }
    for key in ["rawInput", "raw_input", "input"] {
        if let Some(p) = tool_call.get(key).and_then(write_path) {
            return Some(format!("write {p}"));
        }
    }
    None
}

fn patch_deletes_file_in_value(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(object) => {
            for key in ["patch", "diff"] {
                if object
                    .get(key)
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(ryu_deletion_guard::patch_deletes_file)
                {
                    return true;
                }
            }
            object.values().any(patch_deletes_file_in_value)
        }
        serde_json::Value::Array(items) => items.iter().any(patch_deletes_file_in_value),
        _ => false,
    }
}

/// Run an ACP tool call through the gateway command-approval scanner. Scans the
/// shell command for exec tools, else a synthesized `"write <path>"` for
/// file-mutating tools, so native file tools are governed too (not just shell
/// exec). An explicit `apply_patch` deletion marker is checked locally before
/// extraction because it may not carry a path/content shape the generic write
/// synthesizer recognizes. `Allow` means no scannable mutation was recovered;
/// the permanent-deletion guard remains active even when pattern approval is off.
pub(super) async fn acp_exec_scan_verdict(
    tool_call: &serde_json::Value,
    agent: &str,
) -> ExecScanOutcome {
    if patch_deletes_file_in_value(tool_call)
        || extract_exec_command(tool_call)
            .as_deref()
            .is_some_and(ryu_deletion_guard::patch_deletes_file)
    {
        return ExecScanOutcome::Deny(
            "permanent file deletion through apply_patch is blocked by Ryu; use the host Trash or Recycle Bin command instead".to_owned(),
        );
    }
    match extract_exec_command(tool_call).or_else(|| extract_file_write(tool_call)) {
        Some(scannable) => check_exec_scan("acp", &scannable, None, Some(agent)).await,
        None => ExecScanOutcome::Allow,
    }
}

/// Serialize ACP `ToolCallLocation`s to `[{ path, line? }, …]` for the client.
pub(super) fn locations_json(locations: &[ToolCallLocation]) -> Vec<serde_json::Value> {
    locations
        .iter()
        .map(|loc| {
            let mut obj = serde_json::json!({ "path": loc.path.display().to_string() });
            if let Some(line) = loc.line {
                obj["line"] = serde_json::json!(line);
            }
            obj
        })
        .collect()
}

/// Build a `ToolCall` event from an ACP `ToolCall` notification.
pub(super) fn tool_call_event(call: &ToolCall) -> AcpEvent {
    AcpEvent::ToolCall {
        id: call.tool_call_id.to_string(),
        title: call.title.clone(),
        kind: tool_kind_str(&call.kind),
        input: call.raw_input.clone(),
        locations: locations_json(&call.locations),
    }
}

/// Build a `ToolResult` event from an ACP `ToolCallUpdate` notification.
///
/// Updates only carry the fields that changed, so we surface whatever status
/// and/or output is present. Prefer the tool's raw output, falling back to its
/// rendered content blocks. Returns `None` when an update carries nothing the
/// client can act on (no status, no output) — e.g. a bare title tweak.
pub(super) fn tool_update_event(update: &ToolCallUpdate) -> Option<AcpEvent> {
    let fields = &update.fields;
    let status = fields.status.as_ref().map(tool_status_str);
    // Prefer an ACP `Diff` content block (the standard file-edit signal) so the
    // desktop's diff card renders old↔new; fall back to raw_output, then to the
    // collapsed text/structured content for non-edit tools.
    let output = fields
        .content
        .as_ref()
        .and_then(|content| extract_diff_output(content))
        .or_else(|| fields.raw_output.clone())
        .or_else(|| {
            fields
                .content
                .as_ref()
                .and_then(|content| tool_content_to_output(content))
        });
    if status.is_none() && output.is_none() {
        return None;
    }
    Some(AcpEvent::ToolResult {
        id: update.tool_call_id.to_string(),
        status: status.unwrap_or_else(|| "in_progress".to_owned()),
        output,
        // Carried, never interpreted here: an update that fills in arguments the
        // opening `tool_call` frame did not have yet is the ONLY way the desktop
        // ever learns them (see `AcpEvent::ToolResult::input`). `None` and an
        // empty object are both "nothing new"; mod.rs is what decides that, so
        // this stays a verbatim pass-through.
        input: fields.raw_input.clone(),
    })
}

/// Extract a managed-Pi widget binding from a `ToolCallUpdate`'s raw output.
///
/// The `ryu-mcp` Pi extension stamps `details.ryuWidget = { tool, arguments,
/// output }` on its tool result; pi-acp preserves that verbatim as the ACP
/// `rawOutput`. This returns `(tool_id, arguments, mcp_result)` — the exact inputs
/// the shared [`super::mcp_bridge::build_widget_event`] needs — or `None` when the
/// update is not a completed Pi widget result.
///
/// Gating on [`ToolCallStatus::Completed`] is load-bearing: pi-acp also emits an
/// in-progress `tool_call_update` (`tool_execution_update`) carrying a partial
/// `rawOutput`, and a widget must render only from the final result.
pub(super) fn pi_widget_binding(
    status: Option<&ToolCallStatus>,
    raw_output: Option<&serde_json::Value>,
) -> Option<(String, serde_json::Value, serde_json::Value)> {
    if !matches!(status, Some(ToolCallStatus::Completed)) {
        return None;
    }
    let binding = raw_output?.get("details")?.get("ryuWidget")?;
    let tool = binding.get("tool").and_then(serde_json::Value::as_str)?;
    let result = binding.get("output")?.clone();
    let args = binding
        .get("arguments")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    Some((tool.to_owned(), args, result))
}

/// Extract the nested sub-steps a tool result declared it performed internally.
///
/// A tool result may carry `details.ryuSteps = [{ name, input, output?, status },
/// …]`; pi-acp preserves a tool result's `details` verbatim as the ACP
/// `rawOutput`. ACP models tool calls as a flat list with no parent/child
/// relation, so this `details` marker is the only correlation channel that
/// exists — the same seam [`pi_widget_binding`]'s `details.ryuWidget` already
/// uses.
///
/// Keyed on the generic `details.*` marker and **never** on `agent_id`: this
/// module is agent-neutral ACP plumbing, so any producer that stamps the marker
/// gets the fan-out and no agent's name is compiled in here.
///
/// DIVERGES from [`pi_widget_binding`] on exactly one point, deliberately: there
/// is **no** [`ToolCallStatus::Completed`] gate. A widget renders once, from a
/// final result, so a partial `tool_execution_update` must not reach it. Steps
/// are the opposite — the producer appends one entry per nested call and re-emits
/// the growing array on every `tool_call_update`, so gating on `Completed` would
/// collapse a live nested transcript into a single frame at the very end.
/// Idempotency is handled downstream instead, by synthetic child part id.
pub(super) fn pi_subagent_steps(
    raw_output: Option<&serde_json::Value>,
) -> Option<&Vec<serde_json::Value>> {
    raw_output?.get("details")?.get("ryuSteps")?.as_array()
}

/// Extract a client-side session-config write-back from a `ToolCallUpdate`.
///
/// A tool result may carry `details.ryuConfig = { "<configId>": "<valueId>" }`;
/// pi-acp preserves a tool result's `details` verbatim as the ACP `rawOutput`.
/// This is the agent→client direction of the session-config channel: a client that
/// PERSISTS a config pick re-sends it on every later turn, so an agent-side action
/// that invalidates the pick (approving an exit from a mode the pick turns on, say)
/// needs a way to say "stop sending that". Returns the requested pairs, or `None`
/// when the update is not a completed result carrying a well-formed marker.
///
/// Keyed on the generic `details.*` marker — the same seam
/// [`pi_widget_binding`]'s `details.ryuWidget` and [`pi_subagent_steps`]'
/// `details.ryuSteps` already use — and **never** on a tool name or an `agent_id`:
/// this module is agent-neutral ACP plumbing, so no producer's vocabulary is
/// compiled in here. The config ids and values are opaque strings forwarded
/// verbatim; Core does not know which options a client holds and must not
/// second-guess them.
///
/// Gates on [`ToolCallStatus::Completed`], like [`pi_widget_binding`] and unlike
/// [`pi_subagent_steps`]: pi-acp also emits in-progress `tool_call_update` frames
/// carrying a partial `rawOutput`, and a write-back is a one-shot instruction, not
/// a growing snapshot. Acting on a partial frame would flip a user's picker while
/// the tool was still running — and, worse, before the tool could still fail.
///
/// Non-string values are dropped per key rather than failing the whole marker (a
/// config value is a `valueId` by ACP's own typing); a marker that yields no usable
/// pair at all returns `None`, so no empty event is emitted.
pub(super) fn pi_config_updates(
    status: Option<&ToolCallStatus>,
    raw_output: Option<&serde_json::Value>,
) -> Option<std::collections::BTreeMap<String, String>> {
    if !matches!(status, Some(ToolCallStatus::Completed)) {
        return None;
    }
    let updates: std::collections::BTreeMap<String, String> = raw_output?
        .get("details")?
        .get("ryuConfig")?
        .as_object()?
        .iter()
        .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
        .collect();
    (!updates.is_empty()).then_some(updates)
}

/// The parent tool result's own answer text, for the synthetic `<parent>:out`
/// `TaskOutput` part minted in mod.rs.
///
/// Read from the tool-result envelope pi-acp forwards as `rawOutput`
/// (`{ content: [{ type: "text", text }, …], details: { … } }`) — deliberately
/// NOT from a second `details.*` marker. A marker the producing extension does
/// not happen to stamp would make the final-answer part silently absent (the
/// "shipped and simply not there at runtime" failure class), whereas `content`
/// is the one field every tool result already has.
///
/// Returns `None` when the envelope carries no text at all, so the caller emits
/// no empty `TaskOutput` row.
pub(super) fn pi_subagent_answer(raw_output: Option<&serde_json::Value>) -> Option<String> {
    let mut text = String::new();
    for block in raw_output?.get("content")?.as_array()? {
        if let Some(t) = block.get("text").and_then(serde_json::Value::as_str) {
            text.push_str(t);
        }
    }
    (!text.is_empty()).then_some(text)
}
