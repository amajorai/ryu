use super::*;

// ── Output styles (docs/output-styles.md §5) ──────────────────────────────────
//
// A style changes HOW the agent answers by editing the system prompt for the turn.
// Agent profile assignment is resolved here, at turn assembly, so changing an
// agent's profile takes effect on its next turn; injection happens at the two seams
// the skills block already uses, one per plane.

/// The style in force for this turn, resolved against `registry`.
///
/// The tiers, most specific first, are the caller's one-turn override followed by
/// the selected agent's persisted personality profile. A plugin style with
/// `force-for-plugin: true` beats both while its plugin is enabled.
///
/// Takes the registry and both selection ids as **arguments** rather than reading
/// process globals itself so the agent-profile precedence is unit-testable against a
/// locally built registry; [`output_style_for_turn`] is the thin wrapper that supplies
/// the global registry.
///
/// A tier that names an id which no longer resolves (style deleted, plugin disabled,
/// stale client state) **falls through to the next tier** instead of failing the
/// turn. A missing agent id is the explicit "agent's own voice" state; a missing
/// one-turn id can still fall through to the agent's profile.
pub(crate) fn resolve_output_style(
    registry: &ryu_output_styles::OutputStyleRegistry,
    per_turn: Option<&str>,
    per_agent: Option<&str>,
) -> Option<ryu_output_styles::OutputStyleRecord> {
    if let Some(forced) = registry.forced_style() {
        return Some(forced);
    }
    [per_turn, per_agent]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .find_map(|id| match registry.get(id) {
            Some(record) => Some(record),
            None => {
                tracing::debug!("output style '{id}' is selected but not installed; ignoring");
                None
            }
        })
}

/// [`resolve_output_style`] against the process-global registry. `None` before Core
/// has mounted the registry (a headless/embedded caller that never built the router),
/// which keeps the feature inert rather than panicking on a handle that was never
/// published.
pub(crate) fn output_style_for_turn(
    per_turn: Option<&str>,
    per_agent: Option<&str>,
) -> Option<ryu_output_styles::OutputStyleRecord> {
    let registry = ryu_output_styles::global_registry()?;
    resolve_output_style(registry, per_turn, per_agent)
}

/// The system-prompt prefix a resolved style contributes to this turn, or `None`
/// when it contributes nothing.
///
/// This is the ONE place `keep-coding-instructions` is interpreted (design §2 — the
/// crate carries the flag and deliberately does not act on it):
///
/// - `true` — the style body is **appended after** the agent's base instructions, so
///   both apply. This is what "change how it talks while it keeps doing the same
///   work" needs, and it is what all but one of the built-ins want.
/// - `false` (the default) — the style body **replaces** them, for a style that turns
///   the agent into something else entirely (a writing editor, a data analyst).
///
/// `base_instructions` is the agent record's `system_prompt`. Without a style those
/// instructions enter every turn as their own layer ([`agent_instructions_layer`]);
/// a style that contributes a body takes that layer over, so `true` carries the
/// instructions in front of the style body and `false` leaves them out. Everything
/// else — skills, memory, persona, tool descriptions — is untouched by either value.
///
/// Returns `None` for a body-less (frontmatter-only) style, because
/// [`ryu_output_styles::style_block`] yields an empty string for one and injecting a
/// bare adherence reminder would point the model at instructions that do not exist.
pub(crate) fn output_style_prefix(
    record: &ryu_output_styles::OutputStyleRecord,
    base_instructions: Option<&str>,
) -> Option<String> {
    let block = ryu_output_styles::style_block(record);
    if block.is_empty() {
        return None;
    }
    match base_instructions.map(str::trim).filter(|s| !s.is_empty()) {
        Some(base) if record.keep_coding_instructions => Some(format!("{base}\n\n{block}")),
        _ => Some(block),
    }
}

/// The agent's own instructions (its record's `system_prompt`) as a system-prompt
/// layer for this turn, or `None` when there are none or an output style owns them.
///
/// Every agent's instructions reach the model through this one layer, on both
/// planes and on every turn kind (main chat, delegated, team, scheduled, channel):
/// a built-in seeded with instructions (Jay Jr.'s persona and guardrails), a
/// custom agent written in the editor, or an imported one. An ACP agent still keeps
/// its own base prompt; these instructions ride in front of the user's message the
/// same way the persona and skills do.
///
/// `style_applied` is whether [`output_style_prefix`] produced a prefix this turn.
/// Such a style decides the instructions itself (`keep-coding-instructions: true`
/// carries them in front of the style body, `false` replaces them), so the layer
/// stands down rather than sending them twice or undoing the replacement.
pub(crate) fn agent_instructions_layer(
    instructions: Option<&str>,
    style_applied: bool,
) -> Option<String> {
    if style_applied {
        return None;
    }
    instructions
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// Prepend `prefix` to the leading `system` message of an OpenAI-compat message
/// array, inserting one at the front when there is none.
///
/// Deliberately targets the SAME message
/// [`ryu_skills::SkillRegistry::inject_into_messages_filtered`] writes into, and is
/// called after it, so the style lands in front of the skills block (design §5).
/// Messages whose `content` is not a string are skipped as injection targets: a
/// client may send a multimodal `system` message whose content is a parts array, and
/// flattening that to a string would silently drop its parts.
pub(crate) fn prepend_system_prefix(messages: &mut Vec<Value>, prefix: &str) {
    match messages
        .iter_mut()
        .find(|m| m["role"] == "system" && m["content"].is_string())
    {
        Some(sys) => {
            let existing = sys["content"].as_str().unwrap_or_default().to_owned();
            // NB argument order: `merge_system_prompt` PREPENDS its second argument.
            if let Some(merged) = merge_system_prompt(Some(existing), Some(prefix.to_owned())) {
                sys["content"] = Value::String(merged);
            }
        }
        None => messages.insert(
            0,
            serde_json::json!({ "role": "system", "content": prefix }),
        ),
    }
}

/// Join two pieces of per-turn context with a blank line, dropping blank ones.
/// `existing` stays first, so callers append in the order the model should read.
pub(crate) fn append_turn_context(
    existing: Option<String>,
    next: Option<String>,
) -> Option<String> {
    let existing = existing.filter(|text| !text.trim().is_empty());
    let next = next.filter(|text| !text.trim().is_empty());
    match (existing, next) {
        (Some(existing), Some(next)) => Some(format!("{existing}\n\n{next}")),
        (existing, next) => existing.or(next),
    }
}

/// Append a private capability hint to the current user turn. This keeps the
/// reusable system/history prefix byte-stable for provider prompt caching, and
/// the caller's original `UiMessage` remains untouched for persistence.
pub(crate) fn append_ephemeral_turn_context(messages: &mut [Value], context: &str) {
    let Some(message) = messages
        .iter_mut()
        .rev()
        .find(|message| message["role"] == "user")
    else {
        return;
    };

    let separator = "\n\n";
    match message.get_mut("content") {
        Some(Value::String(content)) => {
            content.push_str(separator);
            content.push_str(context);
        }
        Some(Value::Array(parts)) => parts.push(serde_json::json!({
            "type": "text",
            "text": format!("{separator}{context}"),
        })),
        _ => {
            message["content"] = Value::String(format!("{separator}{context}"));
        }
    }
}
