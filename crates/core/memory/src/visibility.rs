//! Per-caller read visibility for long-term memory: the SQL predicate and the
//! caller context it is evaluated against.

use ryu_kernel_contracts::ResourceKey;

/// The SQL twin of the memory per-caller ACL — the ONE place memory read
/// visibility is expressed (mirrors `conversations.rs::TENANCY_VISIBLE_PREDICATE`,
/// but keyed on SCOPE, since memory sharing is scope-based, not org/visibility-based):
///   - `:bound = 0` (node UNBOUND / personal): no restriction. One principal; the
///     node token is the boundary — byte-identical to the pre-ACL behaviour.
///   - node ORG-BOUND: an `agent`/`user`-scope fact is PRIVATE — visible only to its owner
///     (`user_id = :uid`). `node`/`project`-scope facts are the shared "company
///     brain" — visible to every member. A `user`-scope row whose `user_id` is the
///     legacy `'local'` sentinel matches no real caller (fail closed) until the
///     bind-time backfill re-stamps it to the real owner.
///   - ORG scope: visible only to a caller in THAT org. Memory has no `org_id`
///     column, so the owning org id lives in `scope_id` — the same "the id that
///     qualifies this scope" contract `scope_id` already serves for `project` (a
///     folder path) and `node` (a node id). The comparison is against the caller's
///     org, so a NULL `scope_id`, a NULL caller org, or a mismatch all fail CLOSED.
///     Note the write path (`record_full`) refuses to store an org-scope fact
///     without a `scope_id`, so a row that would be invisible to everyone can never
///     be created in the first place.
pub(crate) const MEMORY_VISIBLE_PREDICATE: &str = "(
        :bound = 0
        OR scope = 'node'
        OR (scope = 'project' AND scope_id IS NOT NULL AND trim(scope_id) <> '')
        OR (:uid IS NOT NULL AND scope IN ('agent', 'user') AND user_id = :uid)
        OR (:org IS NOT NULL AND scope = 'org' AND scope_id = :org)
     )";

/// The caller context a tenancy-filtered memory query is evaluated against.
#[derive(Clone, Copy)]
pub struct MemoryVisibility<'a> {
    /// Whether THIS node is bound to an org. Unbound → no filtering.
    pub node_bound: bool,
    /// The verified caller's user id, or `None` for an anonymous caller.
    pub caller_user_id: Option<&'a str>,
    /// The caller's org id, or `None` when the caller has no org. `None` makes
    /// every `org`-scope fact invisible — the fail-closed direction.
    pub caller_org_id: Option<&'a str>,
}

impl<'a> MemoryVisibility<'a> {
    /// The in-process, full-trust filter (used internally / on an unbound node).
    pub fn unrestricted() -> Self {
        Self {
            node_bound: false,
            caller_user_id: None,
            caller_org_id: None,
        }
    }

    /// The filter for an HTTP caller on a possibly-bound node.
    pub fn for_caller(caller_user_id: Option<&'a str>, node_bound: bool) -> Self {
        Self::for_caller_in_org(caller_user_id, None, node_bound)
    }

    /// The filter for an HTTP caller on a possibly-bound node, including the
    /// caller's org so `org`-scope facts resolve. Prefer this over
    /// [`Self::for_caller`] on any path that can see org-scoped memory;
    /// `for_caller` passes `None` and therefore hides every org fact.
    pub fn for_caller_in_org(
        caller_user_id: Option<&'a str>,
        caller_org_id: Option<&'a str>,
        node_bound: bool,
    ) -> Self {
        Self {
            node_bound,
            caller_user_id,
            caller_org_id,
        }
    }

    /// Derive the read filter from the shared [`ResourceKey`] composition layer.
    /// Only the key's `user` participates (memory shares by scope, not org), so
    /// this is byte-identical to [`Self::for_caller`] fed `key.user`. `node_bound
    /// = false` collapses to [`Self::unrestricted`] regardless of the key — the
    /// UNBOUND-node no-op that keeps a personal node from ever filtering itself out.
    pub fn from_resource_key(key: &'a ResourceKey, node_bound: bool) -> Self {
        Self::for_caller_in_org(key.user.as_deref(), key.org.as_deref(), node_bound)
    }
}
