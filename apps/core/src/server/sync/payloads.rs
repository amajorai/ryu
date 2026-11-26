//! Building and applying conversation and document sync payloads.

use super::*;

/// True unless this exact `updated_at` of the document was already pushed
/// successfully to the current destination. Keyed on `updated_at` (not
/// `revision`) because that is the server's last-writer-wins guard: an icon or
/// visibility edit moves only `updated_at`, and an equal one is a server no-op.
pub(super) fn document_needs_push(
    pushed: &std::collections::HashMap<String, i64>,
    payload: &DocumentSyncPayload,
) -> bool {
    pushed.get(&payload.document_id) != Some(&payload.updated_at)
}

/// Serialize every non-system, non-binary Spaces document with its stable Space
/// metadata. The server mirror remains a transport; local Spaces is authoritative.
pub async fn build_document_sync_payloads(
    store: &crate::server::spaces::SpaceStore,
) -> Result<Vec<DocumentSyncPayload>> {
    use std::collections::HashMap;

    let spaces = store
        .list_spaces(crate::server::spaces::DocFilter::unrestricted())
        .await?;
    let spaces_by_id: HashMap<String, ryu_spaces::SpaceSyncRecord> = spaces
        .into_iter()
        .filter(|space| !space.system)
        .map(|space| {
            let id = space.id.clone();
            (
                id,
                ryu_spaces::SpaceSyncRecord {
                    id: space.id,
                    name: space.name,
                    description: space.description,
                    created_at: space.created_at,
                    updated_at: space.updated_at,
                    retrieval_mode: space.retrieval_mode.as_str().to_owned(),
                    visibility: space.visibility,
                    team_id: space.team_id,
                },
            )
        })
        .collect();
    let documents = store.list_documents_for_sync().await?;
    Ok(documents
        .into_iter()
        .filter_map(|record| {
            let space = spaces_by_id.get(&record.document.space_id)?.clone();
            Some(DocumentSyncPayload {
                document_id: record.document.id,
                title: record.document.title,
                source: record.document.source,
                kind: record.document.kind,
                parent_id: record.document.parent_id,
                icon: record.document.icon,
                created_at: record.document.created_at,
                updated_at: record.document.updated_at,
                revision: record.document.revision,
                owner_user_id: record.owner_user_id,
                space,
            })
        })
        .collect())
}

/// Apply one document snapshot after deriving its owner from the payload author
/// and the receiving node's org context, matching conversation replay semantics.
pub async fn apply_document_sync_payload(
    store: &crate::server::spaces::SpaceStore,
    payload: &DocumentSyncPayload,
    context: Tenancy,
) -> Result<bool> {
    if payload.document_id.is_empty()
        || payload.document_id.len() > 200
        || payload.space.id.is_empty()
        || payload.space.id.len() > 200
        || payload.title.len() > 1000
        || payload.source.len() > 5_000_000
        || payload.kind == "file"
        || payload.updated_at < 0
        || payload.created_at < 0
    {
        anyhow::bail!("invalid document sync payload")
    }
    let tenancy = match &context {
        Tenancy::Unattributed => Tenancy::Unattributed,
        Tenancy::Owned { org_id, .. } => {
            Tenancy::owned_by(payload.owner_user_id.as_deref(), org_id.as_deref())
        }
        Tenancy::SharedOrg { org_id } => Tenancy::shared_with_org(org_id),
    };
    if tenancy == Tenancy::Unattributed && node_bound() {
        anyhow::bail!("refusing author-less document replay on an org-bound node (fail closed)")
    }
    let owner = crate::server::spaces::owner_of(&tenancy);
    store.apply_synced_space(&payload.space, &owner).await?;
    let record = ryu_spaces::DocumentSyncRecord {
        document: ryu_spaces::DocumentContent {
            id: payload.document_id.clone(),
            space_id: payload.space.id.clone(),
            title: payload.title.clone(),
            source: payload.source.clone(),
            created_at: payload.created_at,
            updated_at: payload.updated_at,
            revision: payload.revision,
            chunk_count: 0,
            kind: payload.kind.clone(),
            parent_id: payload.parent_id.clone(),
            icon: payload.icon.clone(),
        },
        owner_user_id: payload.owner_user_id.clone(),
    };
    store.apply_synced_document(&record, &owner).await
}

/// Serialize a conversation from `store` into a [`SyncPayload`].
///
/// This is the "export" half of the round-trip that [`apply_sync_payload`]
/// ingests.  Both halves are tested together in [`tests::round_trip`].
pub async fn build_sync_payload(
    store: &ConversationStore,
    conversation_id: &str,
) -> Result<SyncPayload> {
    // One-row read. Listing every conversation here made each sync tick
    // quadratic: the loop calls this once per conversation.
    let summary = store
        .get_summary(conversation_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("conversation {} not found in store", conversation_id))?;

    let stored_messages = store.get_messages(conversation_id).await?;
    // Parents describe a tree only once the conversation has branched; a flat
    // conversation's rows are ordered by time, so it sends none.
    let branched = store.active_leaf(conversation_id).await?.is_some();

    let messages = stored_messages
        .into_iter()
        .map(|m| SyncMessage {
            id: m.id,
            role: m.role,
            content: m.content,
            created_at: m.created_at,
            version_root: branched && m.parent_message_id.is_none(),
            parent_message_id: m.parent_message_id.filter(|_| branched),
        })
        .collect();

    // Carry the source row's OWNER so the receiving node can attribute the replay
    // to its original author (not the pulling device). `None` on an unbound source
    // (rows are NULL-tenanted there), which serializes away — byte-identical wire.
    let owner_user_id = store
        .get_access_meta(conversation_id)
        .await?
        .and_then(|m| m.owner_user_id);

    Ok(SyncPayload {
        conversation_id: summary.id,
        title: summary.title,
        agent_id: summary.agent_id,
        folder_path: summary.folder_path,
        branch: summary.branch,
        worktree_path: summary.worktree_path,
        run_status: summary.run_status,
        owner_user_id,
        created_at: summary.created_at,
        updated_at: summary.updated_at,
        messages,
    })
}

/// A non-reversible fingerprint of the sync token, so the push record resets
/// when the signed-in account changes without holding a second token copy.
pub(super) fn token_fingerprint(token: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    token.hash(&mut hasher);
    hasher.finish()
}

/// Whether THIS node is bound to an org (a shared "company brain"). The one place
/// the sync loop asks, so its fail-closed rule reads the same signal as
/// `resource_access` / `enforce_permission`.
pub(super) fn node_bound() -> bool {
    crate::sidecar::control_plane::registered_org().is_some()
}

/// Resolve the CONTEXT the receive half replays under this tick.
///
/// - **Unbound node** → `Some(Tenancy::Unattributed)`: rows stay NULL-tenanted,
///   byte-identical to before. No principal resolution happens on this path.
/// - **Bound node with a signed-in device account** → `Some(Tenancy::Owned { .. })`
///   carrying the node's org. This is the resolved per-user principal: its presence
///   GATES the receive half (the device must be a real, logged-in org member), while
///   each replayed row's actual owner still comes from its own payload author (see
///   [`effective_replay_tenancy`]). The account's `user_id` is the device's own —
///   never stamped onto a pulled row.
/// - **Bound node with NO resolvable account** → `None`: skip the receive half
///   (fail-closed), exactly as the device-token-only loop did before. The device
///   carries no human principal to authorise attributing replayed rows.
pub(super) fn resolve_replay_context() -> Option<Tenancy> {
    let Some(org) = crate::sidecar::control_plane::registered_org() else {
        // Unbound personal node: the pre-existing, byte-identical path.
        return Some(Tenancy::Unattributed);
    };
    // Bound node: require a real signed-in account (the device→user principal). The
    // control-plane device token maps to the account vault written by device login.
    let user_id = crate::auth::load_accounts()
        .active()
        .map(|a| a.user_id.clone())?;
    Some(Tenancy::Owned {
        user_id,
        org_id: Some(org.id),
    })
}

/// Apply a [`SyncPayload`] to a local store.
///
/// Conflict rule:
/// - Conversation row: upserted on first apply; on subsequent applies,
///   metadata is only overwritten when the incoming `updated_at` is strictly
///   newer than the stored value (last-writer-wins).
/// - Messages: union-merged by `id` — messages absent from the local store
///   are inserted; messages already present are left unchanged (append-only).
/// - Version tree: in a branched receiver, inserted rows keep their source
///   parent when the receiver holds it and it keeps the tree acyclic; rows
///   without one continue its active thread, and the leaf only advances onto
///   rows that descend from it (see [`ConversationStore::link_synced_messages`]).
///   A never-branched receiver stays flat.
///
/// **Tenancy (fail-closed).** Replay is a CREATION path: a payload for a
/// conversation this device has never seen mints the row. `tenancy` is the receiving
/// node's CONTEXT, not the row owner — the owner is resolved from the payload's own
/// author via [`effective_replay_tenancy`], so a pulled row lands owned by whoever
/// wrote it, never the device that pulled it. On an ORG-BOUND node a replay whose
/// payload carries no author resolves to [`Tenancy::Unattributed`] and is REFUSED
/// rather than writing rows that would be invisible/denied to everyone (the lockout
/// this whole unit exists to prevent). On an unbound personal node the context is
/// `Unattributed`, the author is ignored, and the behaviour is byte-identical.
pub async fn apply_sync_payload(
    store: &ConversationStore,
    payload: &SyncPayload,
    tenancy: Tenancy,
) -> Result<()> {
    apply_sync_payload_at(store, payload, tenancy, node_bound()).await
}

/// The tenancy a replayed row is actually born with, derived from the source
/// payload's ORIGINAL author and the receiving node's org **context**.
///
/// - **Unbound node** (`ctx == Unattributed`): rows stay NULL-tenanted, exactly as
///   before the ACL existed — byte-identical local-first behaviour. The payload's
///   author is ignored (an unbound node has one principal; `RYU_TOKEN` is the
///   boundary).
/// - **Bound node** (`ctx == Owned { org_id, .. }`): the row is owned by the
///   **payload's author**, scoped to THIS node's org. The context's `user_id` (the
///   syncing device's own account) is deliberately NOT used as the owner — that would
///   re-attribute every pulled row to whoever's device pulled it. Where the payload
///   carries no author, the result is `Unattributed`, which the caller refuses
///   (fail-closed) rather than mis-attributing it to the local device.
pub(super) fn effective_replay_tenancy(payload: &SyncPayload, ctx: &Tenancy) -> Tenancy {
    match ctx {
        Tenancy::Unattributed => Tenancy::Unattributed,
        Tenancy::Owned { org_id, .. } => {
            Tenancy::owned_by(payload.owner_user_id.as_deref(), org_id.as_deref())
        }
        Tenancy::SharedOrg { org_id } => Tenancy::shared_with_org(org_id),
    }
}

/// [`apply_sync_payload`] with the node's org-binding passed in — the pure form the
/// unit tests drive (they cannot register an org).
///
/// `tenancy` is the receiving loop's **context** (the node's org + the signed-in
/// device account), NOT the owner written to the row: the owner is resolved from the
/// payload's own author via [`effective_replay_tenancy`].
pub async fn apply_sync_payload_at(
    store: &ConversationStore,
    payload: &SyncPayload,
    tenancy: Tenancy,
    node_bound: bool,
) -> Result<()> {
    let inserted = insert_sync_payload(store, payload, tenancy, node_bound).await?;
    store
        .link_synced_messages(
            &payload.conversation_id,
            &sync_links(&payload.messages),
            &inserted,
        )
        .await
}

/// [`apply_sync_payload`] without placing the inserted rows in the version
/// tree, returning the ids it inserted. For a caller that links them itself
/// (the RNP resume handler's `link_resumed_messages`).
pub async fn apply_sync_payload_unlinked(
    store: &ConversationStore,
    payload: &SyncPayload,
    tenancy: Tenancy,
) -> Result<HashSet<String>> {
    insert_sync_payload(store, payload, tenancy, node_bound()).await
}

/// Each message's source tree position, read per row. A pulled payload merges
/// rows pushed by every device, so whether some row carries a parent says
/// nothing about another: only a row the source marked [`SyncMessage::version_root`]
/// is a root, and any other parentless row (a flat source's or an older peer's)
/// has an unknown position.
pub(super) fn sync_links(messages: &[SyncMessage]) -> Vec<SyncLink> {
    messages
        .iter()
        .map(|message| SyncLink {
            id: message.id.clone(),
            parent: match &message.parent_message_id {
                Some(parent) => SyncParent::Message(parent.clone()),
                None if message.version_root => SyncParent::Root,
                None => SyncParent::Unknown,
            },
        })
        .collect()
}

pub(super) async fn insert_sync_payload(
    store: &ConversationStore,
    payload: &SyncPayload,
    tenancy: Tenancy,
    node_bound: bool,
) -> Result<HashSet<String>> {
    let tenancy = effective_replay_tenancy(payload, &tenancy);
    if tenancy == Tenancy::Unattributed && node_bound {
        anyhow::bail!(
            "refusing to replay conversation '{}' on an org-bound node with no resolvable owner: \
             the row would be denied to every user (fail closed)",
            payload.conversation_id
        );
    }
    // Ensure the conversation row exists (creates it with initial metadata if
    // this is the first time we see this conversation on this device).
    store
        .ensure_sync_conversation(
            &payload.conversation_id,
            payload.agent_id.as_deref(),
            payload.title.as_deref(),
            payload.created_at,
            payload.updated_at,
            tenancy.clone(),
        )
        .await?;

    // LWW: update metadata only when the incoming timestamp beats stored one.
    store
        .update_metadata_if_newer(
            &payload.conversation_id,
            payload.title.as_deref(),
            payload.agent_id.as_deref(),
            payload.folder_path.as_deref(),
            payload.branch.as_deref(),
            payload.worktree_path.as_deref(),
            payload.run_status.as_deref(),
            payload.updated_at,
        )
        .await?;

    // Union-merge messages. The store's insert is idempotent and deliberately
    // metadata-neutral; metadata was resolved by LWW above.
    let mut inserted = HashSet::new();
    for msg in &payload.messages {
        if store
            .append_sync_message_with_id(
                &payload.conversation_id,
                &msg.id,
                &msg.role,
                &msg.content,
                payload.agent_id.as_deref(),
                msg.created_at,
            )
            .await?
        {
            inserted.insert(msg.id.clone());
        }
    }

    Ok(inserted)
}
