//! Text helpers (pull request URLs, participants, titles, previews), the
//! `cfg(test)` append shim and the continuity hand-off marker.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

/// Upper bound on pull requests explicitly linked to one conversation.
pub const MAX_LINKED_PULL_REQUESTS: usize = 20;

/// Normalize a GitHub pull request URL to `https://github.com/<owner>/<repo>/pull/<n>`.
/// Returns `None` for anything that is not a GitHub pull request link.
pub fn normalize_pull_request_url(raw: &str) -> Option<String> {
    let rest = raw.trim().strip_prefix("https://github.com/")?;
    let mut segments = rest.split(['/', '?', '#']);
    let owner = segments.next().filter(|s| is_github_name(s))?;
    let repo = segments.next().filter(|s| is_github_name(s))?;
    if !matches!(segments.next(), Some("pull" | "pulls")) {
        return None;
    }
    let number = segments
        .next()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n > 0)?;
    Some(format!("https://github.com/{owner}/{repo}/pull/{number}"))
}

pub(super) fn is_github_name(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 100
        && segment != "."
        && segment != ".."
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Parse a JSON array of strings (agent ids in `participants`, pull request
/// URLs in `linked_pull_requests`). Returns an empty vec on null/empty/malformed
/// input.
pub(super) fn parse_participants_json(json: Option<&str>) -> Vec<String> {
    json.filter(|s| !s.is_empty())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default()
}

/// Build a short conversation title from the first user message: its first line,
/// capped at 60 chars. This is the DEFAULT title every chat gets the moment it is
/// persisted — no plugin involved — so a thread reads as what the user actually
/// asked instead of a placeholder while the LLM rename is still pending.
///
/// `None` for a turn with no text (an image- or file-only opener). Returning a
/// literal placeholder here would be worse than nothing: the upsert COALESCEs
/// (`COALESCE(conversations.title, excluded.title)`), so a placeholder written
/// once wins over every later derivation and only an LLM rename could displace
/// it. A NULL title lets the next user turn title the thread.
///
/// The client mirrors this rule (`deriveDraftTitle` in the desktop's chat history
/// context) so the sidebar can show the same string immediately on send, without
/// waiting for the round trip. Change one, change the other.
pub(super) fn derive_title(content: &str) -> Option<String> {
    const MAX: usize = 60;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return None;
    }
    let first_line = trimmed.lines().next().unwrap_or(trimmed).trim();
    if first_line.is_empty() {
        return None;
    }
    if first_line.chars().count() <= MAX {
        return Some(first_line.to_owned());
    }
    let truncated: String = first_line.chars().take(MAX).collect();
    Some(format!("{truncated}…"))
}

/// Longest message preview served on a conversation summary, in characters.
pub(super) const PREVIEW_MAX_CHARS: usize = 140;

/// Flatten a message body into the single line a messaging-style row shows.
/// Newlines collapse to spaces (a two-line row must not grow), runs of
/// whitespace collapse with them, and the result is capped at
/// [`PREVIEW_MAX_CHARS`] so a 40 KB tool dump does not travel to the sidebar.
///
/// Unlike [`derive_title`] this keeps the *whole* message flattened rather than
/// only its first line: an assistant reply whose first line is a bare "```rust"
/// would otherwise preview as nothing readable.
pub(super) fn preview_line(content: &str) -> String {
    let flattened = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if flattened.chars().count() <= PREVIEW_MAX_CHARS {
        return flattened;
    }
    let truncated: String = flattened.chars().take(PREVIEW_MAX_CHARS).collect();
    format!("{truncated}…")
}

/// Test-only conveniences.
///
/// `append_message` has ~55 call sites, nearly all of them tests that model an
/// unbound personal node. Rather than churn them, the pre-tenancy signature lives
/// on **only** in `cfg(test)`, hard-wired to [`Tenancy::Unattributed`]. Production
/// code therefore has exactly one entry point — [`ConversationStore::append_message_as`],
/// which cannot be called without choosing a `Tenancy`. A production caller that
/// forgets fails `cargo check` (not `cargo test`), which is the whole point.
#[cfg(test)]
impl ConversationStore {
    pub(crate) async fn append_message(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        agent_id: Option<&str>,
        author_user_id: Option<&str>,
        author_name: Option<&str>,
    ) -> Result<String> {
        self.append_message_as(
            conversation_id,
            role,
            content,
            agent_id,
            author_user_id,
            author_name,
            Tenancy::Unattributed,
        )
        .await
    }
}

// RNP working-tree handoff: the source marks a thread it handed off so two
// nodes do not keep editing the same branch. Kept in its own `impl` block, and
// deliberately not touching `updated_at`, so marking never invalidates a
// reviewed export (`ifUpdatedAt`).
impl ConversationStore {
    /// Record where the thread continued (`{ nodeLabel, bundleId?, workspaceId?, at }`).
    /// Returns `false` when the conversation does not exist.
    pub async fn set_continued_on(&self, conversation_id: &str, record: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let changed = conn
            .execute(
                "UPDATE conversations SET continued_on = ?2 WHERE id = ?1",
                params![conversation_id, record],
            )
            .context("setting continued_on")?;
        Ok(changed == 1)
    }

    /// Take the thread back on this node. Returns `false` when it does not exist.
    pub async fn clear_continued_on(&self, conversation_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let changed = conn
            .execute(
                "UPDATE conversations SET continued_on = NULL WHERE id = ?1",
                params![conversation_id],
            )
            .context("clearing continued_on")?;
        Ok(changed == 1)
    }
}
