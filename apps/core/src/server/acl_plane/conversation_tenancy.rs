//! The per-resource ACL plane (HTTP side), connections and sandbox handlers: `claim_conversation_tenancy` through `require_parent_conversation`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Stamp the verified caller as the owner of a conversation — **the write that
/// makes the ACL bite**. Before this existed every conversation row was created
/// with NULL tenancy, which the matrix above read as "the untenanted local row" and
/// granted to every holder of the node token.
///
/// Only runs on an **org-bound** node (see the [`resource_access`] preamble):
/// scoping rows on a personal node buys nothing and risks locking the owner out
/// offline. Anonymous callers stamp nothing (on a bound node they are already
/// denied by [`enforce_permission`] before reaching here).
///
/// Best-effort by design — a failed stamp must never fail the user's chat turn. The
/// row simply stays untenanted, and on a bound node the ACL then DENIES it (fail
/// closed), which is loud rather than silent.
pub(in crate::server) async fn claim_conversation_tenancy(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    conversation_id: &str,
) {
    let Some(node_org) = node_org_id() else {
        return;
    };
    let Some(caller) = caller.as_ref() else {
        return;
    };
    if let Err(e) = state
        .conversations
        .claim_tenancy(conversation_id, &caller.user_id, Some(node_org.as_str()))
        .await
    {
        tracing::warn!("failed to stamp conversation tenancy on {conversation_id}: {e:#}");
    }
}

/// The strict by-id READ gate for a conversation: the row must exist (404 if not)
/// and the caller must be able to read it. The `pub(crate)` form used by handlers in
/// sibling modules (`learning::synthesize`, …) that take a client-supplied
/// conversation id.
pub(crate) async fn require_conversation_read_by_id(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    conversation_id: &str,
) -> Result<(), axum::response::Response> {
    require_resource_read(
        state.conversations.get_access_meta(conversation_id).await,
        caller.as_ref(),
        &format!("conversation '{conversation_id}' not found"),
    )
}

/// Lower a verified caller into the [`Tenancy`](conversations::Tenancy) a new
/// conversation row is CREATED with — the single place an HTTP principal becomes a
/// stored owner.
///
/// Mirrors [`claim_conversation_tenancy`] / [`enforce_permission`] exactly: only an
/// **org-bound** node stamps. On an unbound personal node there is one principal and
/// `RYU_TOKEN` is the boundary, so rows stay NULL-tenanted and every path behaves
/// byte-identically to the pre-ACL build (no offline lockout).
pub(crate) fn caller_tenancy(
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> conversations::Tenancy {
    let Some(node_org) = node_org_id() else {
        return conversations::Tenancy::Unattributed;
    };
    match caller.as_ref() {
        Some(c) => conversations::Tenancy::Owned {
            user_id: c.user_id.clone(),
            org_id: Some(node_org),
        },
        None => conversations::Tenancy::Unattributed,
    }
}

/// Build the Spaces visibility filter ([`spaces::DocFilter`]) for an HTTP caller.
/// Mirrors [`resource_access`] / [`ConversationStore::list_conversations_visible`]:
/// only an anonymous request from a trusted local peer on an UNBOUND node gets the
/// unrestricted filter; every other caller is narrowed to the rows it may read.
pub(crate) fn caller_doc_filter(
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> spaces::DocFilter<'_> {
    match (node_org_id().is_some(), caller.as_ref()) {
        (true, Some(c)) => {
            // Keep list/search/graph visibility aligned with the by-id ACL: every
            // verified team membership must reach the SQL predicate. Using only the
            // first membership silently hid shared Spaces from multi-team users.
            let team_ids = caller_team_ids(c);
            spaces::DocFilter::for_caller_with_teams(
                Some(c.user_id.as_str()),
                c.org_id.as_deref(),
                &team_ids,
                true,
            )
        }
        // Bound node + anonymous caller: bound with no ids → predicate matches only
        // system spaces / shared rows (nothing owner-scoped).
        (true, None) => spaces::DocFilter::for_caller(None, None, true),
        // Unbound node + verified caller: legacy rows plus what the by-id ACL
        // grants this user, so a list never names a row the caller cannot open.
        (false, Some(c)) => {
            let team_ids = caller_team_ids(c);
            spaces::DocFilter::for_caller_with_teams(
                Some(c.user_id.as_str()),
                c.org_id.as_deref(),
                &team_ids,
                false,
            )
            .restricted_when_unbound()
        }
        // Unbound node + anonymous: the local principal sees everything; a remote
        // request sees only untenanted legacy rows.
        (false, None) if anonymous_request_is_local() => spaces::DocFilter::unrestricted(),
        (false, None) => spaces::DocFilter::unrestricted().restricted_when_unbound(),
    }
}

pub(in crate::server) fn caller_team_ids(
    caller: &crate::identity_verify::VerifiedCaller,
) -> Vec<&str> {
    caller.teams.iter().map(|team| team.id.as_str()).collect()
}

/// The memory `user_id` an HTTP write attributes to. Bound node + verified caller →
/// the caller's id (the per-user tenancy key); otherwise the `LOCAL_USER` sentinel,
/// so an unbound personal node is byte-identical to the pre-ACL build.
pub(in crate::server) fn memory_owner_user_id(
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> String {
    match (node_org_id().is_some(), caller.as_ref()) {
        (true, Some(c)) => c.user_id.clone(),
        _ => memory::LOCAL_USER.to_owned(),
    }
}

/// The memory `user_id` a BACKGROUND capture (chat auto-capture, learning) attributes
/// to — no HTTP caller, so it resolves the local vault owner exactly as the bind-time
/// backfill does. On an unbound node → `LOCAL_USER` (byte-identical). This is what
/// stops a bound-node auto-capture writing a `'local'` row the real owner can never
/// recall (a lockout).
pub(crate) fn background_memory_user_id() -> String {
    match (
        node_org_id().is_some(),
        crate::auth::load_accounts().active(),
    ) {
        (true, Some(acct)) => acct.user_id.clone(),
        _ => memory::LOCAL_USER.to_owned(),
    }
}

/// Whether `caller` may READ/WRITE memory `entry`. UNBOUND node → always (one
/// principal). BOUND node → `node`/`project`-scope facts are the shared brain (any
/// member); an `agent`/`user`-scope fact is private to its owner; an `org`-scope fact is
/// readable by any caller in THAT org. Missing owner on a bound user-scope row
/// (legacy `'local'`/None the backfill has not reached) → denied (fail closed), as
/// is an org fact with no scope id or a caller with no org.
///
/// This is the Rust twin of `MEMORY_VISIBLE_PREDICATE` in the memory crate; the two
/// must stay in step, so every arm here has a matching clause there.
pub(in crate::server) fn memory_access_ok(
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    entry: &memory::LongTermEntry,
) -> bool {
    if node_org_id().is_none() {
        return true;
    }
    match entry.scope {
        memory::MemoryScope::Node => true,
        memory::MemoryScope::Project => entry
            .scope_id
            .as_deref()
            .map(str::trim)
            .is_some_and(|scope_id| !scope_id.is_empty()),
        memory::MemoryScope::Agent | memory::MemoryScope::User => matches!(
            (entry.owner_user_id.as_deref(), caller.as_ref()),
            (Some(owner), Some(c)) if owner == c.user_id
        ),
        memory::MemoryScope::Org => matches!(
            (entry.scope_id.as_deref(), caller.as_ref().and_then(|c| c.org_id.as_deref())),
            (Some(fact_org), Some(caller_org)) if fact_org == caller_org
        ),
    }
}

/// The create-or-use gate for a conversation id supplied by the client.
///
/// `chat_stream` is the ONLY handler that both CREATES and REUSES a conversation:
/// the desktop pre-generates the id client-side, so a brand-new chat has no row yet
/// and must NOT 404. So:
///   - row already exists → full WRITE gate (this is what closes the
///     `POST /api/chat/stream` bypass, where user B simply passed user A's
///     `conversation_id` and had A's history streamed back as context and B's turn
///     appended into A's thread);
///   - no row yet → nothing to gate; fall through and CLAIM it for this caller,
///     which also means the id can never be claimed by anyone else afterwards.
pub(in crate::server) async fn gate_and_claim_conversation(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    conversation_id: &str,
) -> Result<(), axum::response::Response> {
    match state.conversations.get_access_meta(conversation_id).await {
        Ok(Some(tenancy)) => require_resource_write(
            Ok(Some(tenancy)),
            caller.as_ref(),
            &format!("conversation '{conversation_id}' not found"),
        )?,
        Ok(None) => {}
        Err(e) => {
            tracing::warn!("per-resource ACL: tenancy lookup failed: {e:#}");
            return Err(json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "resource access lookup failed".to_owned(),
            ));
        }
    }
    claim_conversation_tenancy(state, caller, conversation_id).await;
    Ok(())
}

/// Gate a route keyed by a conversation id whose OWN resource lives elsewhere (a
/// worktree keyed by `run_id`, an in-flight ACP stream, a trace) — i.e. the
/// conversation row may legitimately not exist yet and its absence is NOT a denial
/// (those handlers have their own "nothing here" response, and there is nothing to
/// leak from a conversation that was never created).
///
/// Once the row DOES exist the full gate applies, which is what matters: the
/// worktree of a run, the live token stream of a turn, and a run's trace are all
/// derived from a conversation's content.
pub(in crate::server) async fn require_conversation_access_if_known(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    conversation_id: &str,
    write: bool,
) -> Result<(), axum::response::Response> {
    let meta = match state.conversations.get_access_meta(conversation_id).await {
        Ok(Some(tenancy)) => Ok(Some(tenancy)),
        Ok(None) => return Ok(()),
        Err(e) => Err(e),
    };
    let not_found = format!("conversation '{conversation_id}' not found");
    if write {
        require_resource_write(meta, caller.as_ref(), &not_found)
    } else {
        require_resource_read(meta, caller.as_ref(), &not_found)
    }
}

/// The machine-ingress variant: gate ONLY when the conversation is actually owned
/// by somebody. Used by `POST /api/channels/run`, whose caller is a bot service
/// holding the node token and carrying NO human identity — so a strict gate would
/// deny it its own (necessarily untenanted) bot conversations on an org-bound node
/// and take every Telegram/Slack bot down with it.
///
/// What it still closes — and this is the point — is the cross-user bypass: a
/// caller cannot pass a HUMAN's conversation id to the channel endpoint and have
/// that thread's history loaded and appended to. Bot conversations remain reachable
/// by any holder of the node token, which is exactly the trust level a bot ingress
/// already has.
pub(in crate::server) async fn require_conversation_write_if_owned(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    conversation_id: &str,
) -> Result<(), axum::response::Response> {
    // Store-backed channel sessions are org-shared machine resources. The
    // gateway's node credential is the writer for that resource; human desktop
    // reads still pass through the normal org visibility ACL.
    match state
        .conversations
        .is_channel_conversation(conversation_id)
        .await
    {
        Ok(true) => return Ok(()),
        Ok(false) => {}
        Err(e) => {
            tracing::warn!("per-resource ACL: channel metadata lookup failed: {e:#}");
            return Err(json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "resource access lookup failed".to_owned(),
            ));
        }
    }
    match state.conversations.get_access_meta(conversation_id).await {
        Ok(Some(tenancy)) if tenancy.owner_user_id.is_some() || tenancy.org_id.is_some() => {
            require_resource_write(
                Ok(Some(tenancy)),
                caller.as_ref(),
                &format!("conversation '{conversation_id}' not found"),
            )
        }
        Ok(_) => Ok(()),
        Err(e) => {
            tracing::warn!("per-resource ACL: tenancy lookup failed: {e:#}");
            Err(json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "resource access lookup failed".to_owned(),
            ))
        }
    }
}

/// Gate a route keyed by a CHILD id (a session, a `/btw` entry) on its PARENT
/// conversation's tenancy — children carry no tenancy of their own. `Ok(None)` from
/// the resolver means the child does not exist → 404 (never a silent allow).
pub(in crate::server) async fn require_parent_conversation(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    parent: anyhow::Result<Option<String>>,
    write: bool,
    not_found: &str,
) -> Result<(), axum::response::Response> {
    let conversation_id = match parent {
        Ok(Some(id)) => id,
        Ok(None) => return Err(json_error(StatusCode::NOT_FOUND, not_found.to_owned())),
        Err(e) => {
            tracing::warn!("per-resource ACL: parent lookup failed: {e:#}");
            return Err(json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "resource access lookup failed".to_owned(),
            ));
        }
    };
    let meta = state.conversations.get_access_meta(&conversation_id).await;
    if write {
        require_resource_write(meta, caller.as_ref(), not_found)
    } else {
        require_resource_read(meta, caller.as_ref(), not_found)
    }
}
