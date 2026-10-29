use super::*;

/// Build a persona tone prefix for the system prompt from a [`PersonaSlot`].
///
/// If `persona.tone` is set, returns a string of the form:
///   "Your name is {name}.\nYou are {tone}. Respond in that voice consistently."
/// (the name line is omitted when `display_name` is absent).
/// Returns `None` when neither tone nor display_name is set.
pub(crate) fn persona_tone_prefix(persona: Option<&PersonaSlot>) -> Option<String> {
    let persona = persona?;
    let has_name = persona.display_name.is_some();
    let has_tone = persona.tone.is_some();
    if !has_name && !has_tone {
        return None;
    }
    let mut prefix = String::new();
    if let Some(name) = &persona.display_name {
        prefix.push_str(&format!("Your name is {name}.\n"));
    }
    if let Some(tone) = &persona.tone {
        prefix.push_str(&format!(
            "You are {tone}. Respond in that voice consistently."
        ));
    }
    Some(prefix)
}

/// Resolve the engine and model bound to an agent (the first two fields of
/// [`resolve_binding`]). Used by the context-window resolver to apply
/// engine-scoped / local-only budgets and the engine's launch `ctx_size`.
pub(crate) async fn resolve_agent_engine_model(
    agent_id: &str,
    store: &AgentStore,
) -> (Option<String>, Option<String>) {
    let binding = resolve_binding(agent_id, store).await;
    (binding.0, binding.1)
}

/// Merge a persona tone prefix into an optional existing system prompt.
///
/// When `tone_prefix` is `Some`, it is prepended to `existing` (separated by
/// a blank line when `existing` is non-empty). When `tone_prefix` is `None`,
/// `existing` is returned unchanged.
pub(crate) fn merge_system_prompt(
    existing: Option<String>,
    tone_prefix: Option<String>,
) -> Option<String> {
    match (existing, tone_prefix) {
        (Some(e), Some(p)) if !e.is_empty() => Some(format!("{p}\n\n{e}")),
        (Some(e), Some(p)) => Some(if p.is_empty() { e } else { p }),
        (None, Some(p)) if !p.is_empty() => Some(p),
        (existing, _) => existing,
    }
}

/// Append `suffix` to the TAIL of an optional system prompt — the mirror of
/// [`merge_system_prompt`], which prepends.
///
/// Used for the per-conversation compaction and handoff summaries. Those change
/// whenever the history is re-summarized, so placing them last keeps every
/// stable layer before them (platform contract, docs hint, persona, memory)
/// byte-identical across turns and inside the provider's prompt-cache prefix.
pub(crate) fn append_system_suffix(
    existing: Option<String>,
    suffix: Option<String>,
) -> Option<String> {
    match (existing, suffix) {
        (Some(e), Some(s)) if !e.is_empty() && !s.is_empty() => Some(format!("{e}\n\n{s}")),
        (Some(e), Some(s)) => Some(if e.is_empty() { s } else { e }),
        (None, Some(s)) if !s.is_empty() => Some(s),
        (existing, _) => existing,
    }
}

// ── Ryu self-documentation pointer ────────────────────────────────────────────
//
// A model asked "how do I configure Ryu?" answers from pre-training, which
// predates most of this product — so it invents settings paths, plugin fields
// and CLI flags that never existed. The fix is not a bigger prompt: it is
// telling the agent that an authoritative, fetchable source exists, and that
// guessing a doc URL is worse than fetching the index.
//
// This is the FIRST standing Core-authored preamble layer (everything else in
// the system block comes from the user's own configuration — persona, memory,
// skills, output style), so it sets the pattern rather than following one:
// a named const merged once in `route_chat_stream`, appended LAST so it never
// outranks anything the user configured, and suppressed under Safe Mode on the
// same rule the skills block follows — a baseline turn carries nothing extra.

/// The standing pointer to Ryu's own documentation, appended to every turn's
/// system block. Kept to a few lines because it is paid for on every turn of
/// every channel; the `llms.txt` index is what makes brevity affordable, since
/// the agent can expand it on demand instead of carrying doc text it may not
/// need.
pub(crate) const RYU_DOCS_HINT: &str = "## Ryu's own documentation\n\
    You are running inside Ryu. Ryu's documentation is published at \
    https://docs.ryuhq.com — a machine-readable index of every page is at \
    https://docs.ryuhq.com/llms.txt, and the whole site as one document is at \
    https://docs.ryuhq.com/llms-full.txt.\n\
    When the user asks how to install, configure or use Ryu itself — settings, \
    agents, plugins, apps, nodes, workflows, the marketplace, the CLI — read \
    those docs before answering rather than relying on prior knowledge, and \
    point the user at https://docs.ryuhq.com. Never cite a documentation URL \
    you have not actually fetched; fetch the index and follow it instead of \
    guessing a path. If you cannot fetch pages, say so and link \
    https://docs.ryuhq.com rather than inventing the answer. When speaking to \
    someone who is not technical, use familiar terms such as apps, connections, \
    files, instructions, routines, and approvals instead of internal platform \
    names unless they ask for the technical detail.";

/// [`RYU_DOCS_HINT`], or `None` when Safe Mode is active.
///
/// Safe Mode's contract is a turn with nothing in the prompt but the user's own
/// words, which is what makes it usable for diagnosing "is the model or is it
/// us?" — a standing instruction to go read a website is exactly the sort of
/// extra the mode exists to strip.
pub(crate) fn ryu_docs_hint() -> Option<String> {
    ryu_docs_hint_when(crate::safe_mode::is_active())
}

/// The gate itself, taking Safe Mode as an argument rather than reading the
/// process global, so a test can pin both answers without mutating state the
/// rest of the binary's tests share.
pub(crate) fn ryu_docs_hint_when(safe_mode: bool) -> Option<String> {
    if safe_mode {
        return None;
    }
    Some(RYU_DOCS_HINT.to_owned())
}

// ── Project instructions (AGENTS.md / CLAUDE.md) ─────────────────────────────
//
// The runtime half of "import agent setup": an imported (or merely opened)
// project folder's instruction file is injected into the turn's system block so
// the agent actually follows it. `crate::import::project_instructions` owns the
// read + bounds; this thin wrapper formats the block and applies the same
// Safe Mode rule as `RYU_DOCS_HINT`.

/// The `## Project instructions` block for `cwd`, or `None` when Safe Mode is
/// active or the folder has no instruction file.
pub(crate) fn project_instructions_hint(cwd: Option<&str>) -> Option<String> {
    project_instructions_hint_when(crate::safe_mode::is_active(), cwd)
}

/// The gate itself, Safe Mode as an argument so a test can pin both answers.
pub(crate) fn project_instructions_hint_when(safe_mode: bool, cwd: Option<&str>) -> Option<String> {
    if safe_mode {
        return None;
    }
    let (file, content) = crate::import::project_instructions(cwd?)?;
    Some(format!("## Project instructions ({file})\n{content}"))
}

const USER_PERSONALIZATION_PREF: &str = "user-personalization";

pub(crate) fn should_include_user_personalization(
    setup_kind: Option<crate::server::onboarding_state::NodeSetupKind>,
    node_scope: Option<crate::sidecar::control_plane::NodeScope>,
    managed_node: bool,
) -> bool {
    if managed_node
        || matches!(
            node_scope,
            Some(
                crate::sidecar::control_plane::NodeScope::Org
                    | crate::sidecar::control_plane::NodeScope::Team
            )
        )
    {
        return false;
    }
    !matches!(
        setup_kind,
        Some(crate::server::onboarding_state::NodeSetupKind::Team)
    )
}

pub(crate) async fn user_personalization_block(
    preferences: &crate::server::preferences::PreferencesStore,
) -> Option<String> {
    // The preference is a desktop-facing personal field. Never fold it into a
    // shared team node's prompt, even if an older client left the preference
    // behind; company context and shared knowledge have their own node scope.
    let onboarding = crate::server::onboarding_state::read_state(preferences)
        .await
        .ok()?;
    if !should_include_user_personalization(
        onboarding.setup_kind,
        crate::sidecar::control_plane::registered_node().map(|node| node.scope),
        crate::sidecar::control_plane::is_managed_node(),
    ) {
        return None;
    }
    let raw = preferences
        .get(USER_PERSONALIZATION_PREF)
        .await
        .ok()
        .flatten()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let labels = [
        ("Nickname", "nickname"),
        ("Occupation", "occupation"),
        ("About you", "aboutYou"),
        ("About your organization", "aboutOrganization"),
    ];
    let lines: Vec<String> = labels
        .iter()
        .filter_map(|(label, key)| {
            value
                .get(*key)
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(|v| format!("- {label}: {v}"))
        })
        .collect();
    (!lines.is_empty()).then(|| format!("## User personalization\n{}", lines.join("\n")))
}
