//! Dream's source material: the caller's resource-scope working memory (the
//! per-user scratchpad agents keep across chats) and a bounded,
//! visibility-filtered window of recent chat messages.

use ryu_kernel_contracts::ResourceKey;

use super::candidates::bounded_text;
use super::{
    DREAM_MAX_CONVERSATIONS, DREAM_MAX_TRANSCRIPT_CHARS, DREAM_MAX_WORKING_DOC_CHARS,
    DREAM_MESSAGES_PER_CONVERSATION,
};
use crate::server::{memory, ServerState};
use crate::sidecar::untrusted::strip_template_tokens;

/// Prefix of the synthetic source id a working-memory document is cited by.
pub(super) const WORKING_SOURCE_PREFIX: &str = "working:";
/// The `role` and `conversation` a working-memory source is shown with.
pub(super) const WORKING_SOURCE_ROLE: &str = "working_memory";
const WORKING_SOURCE_TITLE: &str = "Working memory";
/// Longest part of a resource id kept in a working-memory source id.
const WORKING_SOURCE_ID_CHARS: usize = 64;

#[derive(Debug, Clone)]
pub(super) struct DreamSource {
    /// The chat the message is in; `None` for a working-memory document.
    pub(super) conversation_id: Option<String>,
    pub(super) conversation_title: String,
    pub(super) message_id: String,
    pub(super) role: String,
    pub(super) content: String,
    /// When the message was stored; the newest one is Dream's run watermark.
    pub(super) created_at: i64,
}

pub(super) async fn load_sources(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    include_sensitive: bool,
) -> anyhow::Result<Vec<DreamSource>> {
    let summaries = state
        .conversations
        .list_conversations_visible(
            caller.as_ref().map(|caller| caller.user_id.as_str()),
            caller.as_ref().and_then(|caller| caller.org_id.as_deref()),
            crate::sidecar::control_plane::registered_org().is_some(),
        )
        .await?;
    let mut sources = load_working_sources(state, caller, include_sensitive).await;
    let mut transcript_chars: usize = sources
        .iter()
        .map(|source| source.content.len() + source.message_id.len() + 40)
        .sum();
    'conversations: for summary in summaries.into_iter().take(DREAM_MAX_CONVERSATIONS) {
        let messages = state
            .conversations
            .get_recent_messages(&summary.id, DREAM_MESSAGES_PER_CONVERSATION)
            .await?;
        for message in messages {
            if !matches!(message.role.as_str(), "user" | "assistant")
                || message.content.trim().is_empty()
            {
                continue;
            }
            if !include_sensitive && !memory::detect_sensitive_topics(&message.content).is_empty() {
                continue;
            }
            let Some(content) = bounded_text(&message.content, 4_000) else {
                continue;
            };
            let cost = content.len() + message.id.len() + 40;
            if transcript_chars + cost > DREAM_MAX_TRANSCRIPT_CHARS && !sources.is_empty() {
                break 'conversations;
            }
            transcript_chars += cost;
            sources.push(DreamSource {
                conversation_id: Some(summary.id.clone()),
                conversation_title: summary
                    .title
                    .clone()
                    .unwrap_or_else(|| "Conversation".to_owned()),
                message_id: message.id,
                role: message.role,
                content,
                created_at: message.created_at,
            });
        }
    }
    Ok(sources)
}

/// The caller's own resource-scope working-memory document as a source. Only
/// the document Core's chat turns address for this person (its id is the
/// memory owner, see `memory_working::target_id`) is read: SDK and API callers
/// may key other resource documents by something else (a customer, a project),
/// and those notes are not facts about this user. The partition is the same
/// owner the chat turns and working-memory routes use, so another user's
/// scratchpad is never read; an org-bound node without a verified caller reads
/// none. Fail-open: a storage error logs and yields no working-memory source,
/// so the chats are still reviewed.
pub(super) async fn load_working_sources(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    include_sensitive: bool,
) -> Vec<DreamSource> {
    let Some(owner) = crate::server::memory_settings_user_id(caller) else {
        return Vec::new();
    };
    let key = ResourceKey::owned(Some(&owner), None);
    let docs = match state
        .memory
        .get_working_memory(&key, memory::WorkingMemoryScope::Resource, &owner)
        .await
    {
        Ok(doc) => doc.into_iter().collect::<Vec<_>>(),
        Err(error) => {
            tracing::warn!("Dream could not read working memory: {error:#}");
            return Vec::new();
        }
    };
    let mut sources: Vec<DreamSource> = Vec::with_capacity(docs.len());
    for doc in docs {
        let Some(text) = working_text(&doc) else {
            continue;
        };
        if !include_sensitive && !memory::detect_sensitive_topics(&text).is_empty() {
            continue;
        }
        let Some(content) = bounded_text(&text, DREAM_MAX_WORKING_DOC_CHARS) else {
            continue;
        };
        let message_id = working_source_id(&doc.id, doc.version);
        if sources.iter().any(|source| source.message_id == message_id) {
            continue;
        }
        sources.push(DreamSource {
            conversation_id: None,
            conversation_title: WORKING_SOURCE_TITLE.to_owned(),
            message_id,
            role: WORKING_SOURCE_ROLE.to_owned(),
            content,
            created_at: doc.updated_at,
        });
    }
    sources
}

/// The stable id a proposal cites a working-memory document by:
/// `working:<resource id>@v<version>`. The resource id is caller-chosen, so it
/// is stripped of chat-template tokens and bounded like any other source text;
/// the version pins the revision the model read.
pub(super) fn working_source_id(resource_id: &str, version: i64) -> String {
    let id: String = strip_template_tokens(resource_id)
        .trim()
        .chars()
        .take(WORKING_SOURCE_ID_CHARS)
        .collect();
    format!("{WORKING_SOURCE_PREFIX}{id}@v{version}")
}

/// The document's text: Markdown in template mode, compact JSON in schema
/// mode. A document still equal to its unfilled template, or an empty object,
/// holds nothing to learn from.
fn working_text(doc: &memory::WorkingMemory) -> Option<String> {
    let text = match doc.mode {
        memory::WorkingMemoryMode::Template => {
            let content = doc.content.as_deref()?.trim();
            if doc.template.as_deref().map(str::trim) == Some(content) {
                return None;
            }
            content.to_owned()
        }
        memory::WorkingMemoryMode::Schema => {
            let data = doc.data.as_ref()?;
            if data.as_object().is_some_and(serde_json::Map::is_empty) {
                return None;
            }
            serde_json::to_string(data).ok()?
        }
    };
    (!text.is_empty()).then_some(text)
}
