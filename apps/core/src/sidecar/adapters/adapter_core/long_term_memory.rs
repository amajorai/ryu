use super::*;

/// Resolve the long-term memory scope key for an agent. Long-term memory is
/// scoped per user/agent; while Core is local-first/single-user the user is the
/// `LOCAL_USER` sentinel (see `memory.rs`).
pub(crate) fn long_term_agent_scope(agent_id: Option<&str>) -> String {
    agent_id
        .filter(|s| !s.is_empty())
        .unwrap_or("default")
        .to_owned()
}

/// Auto-classify a captured fact from its text and the active project.
///
/// A cheap, deterministic first pass (no model call): the scope **level** comes
/// from context — inside a working folder (`project_id`) a fact is Project-scoped
/// to that folder, otherwise User-scoped; the **category** is a keyword heuristic.
/// This is intentionally conservative; users refine level/category/importance/tags
/// in the desktop Memory Library, and a Gateway classifier can replace the
/// heuristic later without changing callers. Importance defaults to the mid of the
/// 1..=5 scale.
pub(crate) fn infer_new_memory(
    content: &str,
    project_id: Option<&str>,
    agent_id: Option<&str>,
) -> NewMemory {
    let lower = content.to_lowercase();
    let category = if lower.contains("prefer")
        || lower.contains("i like")
        || lower.contains("i want")
        || lower.contains("don't")
        || lower.contains("do not")
        || lower.contains("always")
        || lower.contains("never")
    {
        MemoryCategory::Preference
    } else if project_id.is_some() {
        MemoryCategory::ProjectContext
    } else {
        MemoryCategory::UserFact
    };
    // Sensitive facts are user-scoped in this release. Keep the automatic capture
    // usable when a user has opted in by avoiding a project-scoped row, even if the
    // turn also has a working-folder project.
    let sensitive = crate::server::memory::detect_sensitive_topics(content);
    let (scope, scope_id) = if !sensitive.is_empty() {
        (MemoryScope::User, None)
    } else {
        match project_id.filter(|p| !p.trim().is_empty()) {
            Some(p) => (MemoryScope::Project, Some(p.to_string())),
            None => (MemoryScope::User, None),
        }
    };
    NewMemory {
        content: content.to_string(),
        scope,
        scope_id,
        category,
        importance: crate::server::memory::DEFAULT_IMPORTANCE,
        when_to_use: None,
        tags: Vec::new(),
        author_agent_id: agent_id.map(str::to_string),
    }
}

/// A durable memory fact that Core actually included in the model context for
/// this turn. The desktop receives this as message metadata, not as assistant
/// prose, so it can explain the context without asking the model to self-report.
#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub(crate) struct MemoryCitation {
    pub(crate) id: String,
    pub(crate) content: String,
}

#[derive(Default)]
pub(crate) struct LongTermMemoryContext {
    pub(crate) system: Option<String>,
    pub(crate) citations: Vec<MemoryCitation>,
    pub(crate) recency_ids: Vec<String>,
}

pub(crate) fn dedupe_memory_citations(
    citations: impl IntoIterator<Item = MemoryCitation>,
) -> Vec<MemoryCitation> {
    let mut seen = std::collections::HashSet::new();
    let mut unique = Vec::new();
    for citation in citations {
        if seen.insert(citation.id.clone()) {
            unique.push(citation);
        }
    }
    unique
}

/// Build the long-term-memory system message plus the exact fact ids that were
/// recalled. The ids are reused by auto-recall's deduplication, while the
/// bounded snippets are emitted as the user-facing citation metadata.
async fn assemble_long_term_context(
    memory: &MemoryStore,
    enabled: bool,
    agent_id: Option<&str>,
    limit: usize,
) -> LongTermMemoryContext {
    assemble_long_term_context_for_user(
        memory,
        enabled,
        LOCAL_USER,
        agent_id,
        None,
        &[],
        MemoryVisibility::unrestricted(),
        limit,
        true,
    )
    .await
}

/// Build the recency block for the server-resolved owner and sensitive-topic
/// consent of the current turn. The legacy wrapper above remains for pure tests
/// and callers on an unbound personal node.
pub(crate) async fn assemble_long_term_context_for_user(
    memory: &MemoryStore,
    enabled: bool,
    user_id: &str,
    agent_id: Option<&str>,
    project_id: Option<&str>,
    read_levels: &[String],
    visibility: MemoryVisibility<'_>,
    limit: usize,
    include_sensitive: bool,
) -> LongTermMemoryContext {
    if !enabled {
        return LongTermMemoryContext::default();
    }
    let parsed_levels = read_levels
        .iter()
        .map(|level| MemoryScope::from_str(level))
        .collect::<Vec<_>>();
    let entries = match memory
        .recall_visible_scoped_for_agent(
            user_id,
            &parsed_levels,
            agent_id,
            project_id,
            visibility,
            limit,
            include_sensitive,
        )
        .await
    {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!("failed to recall long-term memory: {e:#}");
            return LongTermMemoryContext::default();
        }
    };
    if entries.is_empty() {
        return LongTermMemoryContext::default();
    }
    // Render oldest-first so the model reads facts in the order learned.
    let mut facts = String::new();
    for entry in entries.iter().rev() {
        facts.push_str("- ");
        facts.push_str(entry.content.trim());
        facts.push('\n');
    }
    // Recalled memory is STORED text: a fact captured from an earlier turn can
    // carry whatever untrusted content that turn contained (pasted web text,
    // poisoned tool output echoed by the user), and this block re-enters at
    // system rank next session. Neutralize like any other external result —
    // template tokens stripped + boundary-wrapped — so stored injection cannot
    // impersonate the transcript at the highest privilege.
    let facts = if untrusted::is_enabled() {
        untrusted::neutralize(facts.trim_end())
    } else {
        facts
    };
    LongTermMemoryContext {
        system: Some(format!(
			"The following are durable facts remembered about the user from previous sessions:\n{facts}",
		)),
        citations: entries
            .iter()
            .rev()
            .filter_map(|entry| {
                let content = truncate_snippet(&entry.content);
                (!content.is_empty()).then(|| MemoryCitation {
                    content,
                    id: entry.id.clone(),
                })
            })
            .collect(),
        recency_ids: entries.into_iter().map(|entry| entry.id).collect(),
    }
}

/// Build only the legacy system-message half for callers and tests that do not
/// need citation metadata.
pub(crate) async fn assemble_long_term_system_message(
    memory: &MemoryStore,
    enabled: bool,
    agent_id: Option<&str>,
    limit: usize,
) -> Option<String> {
    assemble_long_term_context(memory, enabled, agent_id, limit)
        .await
        .system
}

/// Decide whether a via-gateway request should actually forward to the gateway
/// or degrade to the direct provider path.
///
/// Extracting the decision into a pure function makes it unit-testable without
/// standing up an HTTP server or spawning a gateway child.
pub(crate) fn forward_via_gateway(via_gateway: bool, gateway_healthy: bool) -> bool {
    via_gateway && gateway_healthy
}
