//! The conversation-row choke point: the one `INSERT INTO conversations`, its
//! tenancy clause, and the source version derived from a row's identity.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

/// How [`upsert_conversation_row`] treats `updated_at` when the row already exists.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Touch {
    /// Leave `updated_at` alone (`ensure_conversation`, `add_participant`,
    /// `create_session`, `claim_tenancy` — none of them is a new turn).
    Keep,
    /// Bump to the supplied timestamp (`append_message` — a real new turn).
    Set,
    /// `max(stored, incoming)` — the sync replay's last-writer-wins clock.
    Max,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ConversationConflict {
    Merge,
    Ignore,
}

/// The non-tenancy columns a creation path may seed. Every field is EXISTING-WINS
/// on conflict (except `agent_id`, which is NEW-wins, matching the pre-choke-point
/// upserts), so a caller that leaves one `None` can never clobber a value another
/// path already wrote.
#[derive(Default)]
pub(super) struct ConvRow<'a> {
    /// Already SEALED by the caller (`seal_opt`) — the choke point does no crypto.
    pub(super) title: Option<&'a str>,
    pub(super) agent_id: Option<&'a str>,
    pub(super) created_at: Option<i64>,
    pub(super) updated_at: Option<i64>,
    pub(super) folder_path: Option<&'a str>,
    pub(super) branch: Option<&'a str>,
    pub(super) worktree_path: Option<&'a str>,
    pub(super) participants: Option<&'a str>,
    /// Stable control-plane channel config id for a channel-backed session.
    pub(super) channel_id: Option<&'a str>,
    /// Visibility is seeded as `org` for org-shared channel sessions and remains
    /// existing-wins on later message writes.
    pub(super) visibility: Option<&'a str>,
}

/// A conversation row's source version: 12 hex characters of
/// `SHA-256(id NUL created_at NUL owner NUL org)`. None of those change for the
/// life of a row (owner and org are first-writer-wins, see
/// [`upsert_conversation_row`]), while deleting a conversation and creating
/// another under the same id yields a different version, because the new row is
/// owned by its creator and stamped with its own creation time.
pub(crate) fn conversation_source_version(
    id: &str,
    created_at: i64,
    owner_user_id: Option<&str>,
    org_id: Option<&str>,
) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(id.as_bytes());
    hasher.update([0]);
    hasher.update(created_at.to_string().as_bytes());
    hasher.update([0]);
    hasher.update(owner_user_id.unwrap_or("").as_bytes());
    hasher.update([0]);
    hasher.update(org_id.unwrap_or("").as_bytes());
    let digest = hasher.finalize();
    hex::encode(&digest[..6])
}

/// **THE CHOKE POINT** — the one and only `INSERT INTO conversations` in Core.
///
/// Every path that can bring a conversation row into existence
/// ([`ConversationStore::ensure_conversation`], [`ConversationStore::append_message_as`],
/// [`ConversationStore::append_message_with_id`], [`ConversationStore::fork_conversation`],
/// [`ConversationStore::add_participant`], [`ConversationStore::create_session`],
/// [`ConversationStore::claim_tenancy`]) funnels through here, and this statement
/// ALWAYS emits the tenancy clause. So "a new creation path forgot to stamp its
/// owner" is not a mistake that can be made: `tenancy` is a mandatory argument with
/// no default.
///
/// Three load-bearing properties, all in the `ON CONFLICT` clause:
///   - **Stamp on create.** A brand-new row is born with its owner.
///   - **Preserve, never clobber.** `owner_user_id`/`org_id` are
///     `COALESCE(existing, excluded)`, so a later `append_message` (which passes
///     `Unattributed`, the row already existing) can never wipe a claimed owner.
///   - **First-writer-wins.** The same COALESCE means a row can never be
///     RE-tenanted: a racing or deliberate second claimer cannot steal it.
pub(super) fn upsert_conversation_row(
    conn: &Connection,
    conversation_id: &str,
    now: i64,
    tenancy: &Tenancy,
    row: &ConvRow<'_>,
    touch: Touch,
) -> Result<()> {
    insert_conversation_row(
        conn,
        conversation_id,
        now,
        tenancy,
        row,
        touch,
        ConversationConflict::Merge,
    )
}

pub(super) fn insert_conversation_row(
    conn: &Connection,
    conversation_id: &str,
    now: i64,
    tenancy: &Tenancy,
    row: &ConvRow<'_>,
    touch: Touch,
    conflict: ConversationConflict,
) -> Result<()> {
    let (owner_user_id, org_id) = tenancy.parts();
    let touch_flag: i64 = match touch {
        Touch::Keep => 0,
        Touch::Set => 1,
        Touch::Max => 2,
    };
    let conflict_clause = match conflict {
        ConversationConflict::Merge => {
            "ON CONFLICT(id) DO UPDATE SET
             title         = COALESCE(conversations.title, excluded.title),
             agent_id      = COALESCE(excluded.agent_id, conversations.agent_id),
             updated_at    = CASE :touch
                                 WHEN 1 THEN excluded.updated_at
                                 WHEN 2 THEN max(conversations.updated_at, excluded.updated_at)
                                 ELSE conversations.updated_at
                             END,
             folder_path   = COALESCE(conversations.folder_path, excluded.folder_path),
             branch        = COALESCE(conversations.branch, excluded.branch),
             worktree_path = COALESCE(conversations.worktree_path, excluded.worktree_path),
             participants  = COALESCE(conversations.participants, excluded.participants),
             channel_id    = COALESCE(conversations.channel_id, excluded.channel_id),
             visibility    = COALESCE(conversations.visibility, excluded.visibility),
             owner_user_id = COALESCE(conversations.owner_user_id, excluded.owner_user_id),
             org_id        = COALESCE(conversations.org_id, excluded.org_id)"
        }
        ConversationConflict::Ignore => "ON CONFLICT(id) DO NOTHING",
    };
    let statement = format!(
        "INSERT INTO conversations
            (id, title, agent_id, created_at, updated_at,
             folder_path, branch, worktree_path, participants,
             channel_id, visibility, owner_user_id, org_id)
         VALUES (:id, :title, :agent_id,
                 COALESCE(:created_at, :now + (:touch * 0)),
                 COALESCE(:updated_at, :now + (:touch * 0)),
                 :folder_path, :branch, :worktree_path,
                 -- `participants` is NOT NULL DEFAULT '[]'; the choke point names it
                 -- explicitly (so `fork` can carry the source's list), which bypasses
                 -- the column default — restore it here for the callers that pass none.
                 COALESCE(:participants, '[]'),
                 :channel_id, COALESCE(:visibility, 'private'), :owner, :org)
         {conflict_clause}"
    );
    conn.execute(
        &statement,
        named_params! {
            ":id": conversation_id,
            ":title": row.title,
            ":agent_id": row.agent_id,
            ":created_at": row.created_at,
            ":updated_at": row.updated_at,
            ":now": now,
            ":folder_path": row.folder_path,
            ":branch": row.branch,
            ":worktree_path": row.worktree_path,
            ":participants": row.participants,
            ":channel_id": row.channel_id,
            ":visibility": row.visibility,
            ":owner": owner_user_id,
            ":org": org_id,
            ":touch": touch_flag,
        },
    )
    .context("inserting conversation row (choke point)")?;
    Ok(())
}
