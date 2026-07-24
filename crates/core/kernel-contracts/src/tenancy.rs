//! # `ResourceKey` — the compound tenancy composition layer
//!
//! One key type that *composes* the full tenancy address of a resource — org,
//! node, project, session, user — and *collapses* to the exact `(owner_user_id,
//! org_id)` column pair every Core store writes and filters on today. It is the
//! layer **above** the choke points ([`Tenancy`] in `conversations.rs`,
//! [`DocOwner`] in `ryu-spaces`, the memory/rag owner fields): those keep their
//! byte-identical SQL and semantics, and `ResourceKey` gives call sites a single
//! typed way to build the principal so they never hand-assemble the pair.
//!
//! ## Behavior-preserving contract (this is the whole point)
//!
//! This code path has caused an offline-user lockout twice. The invariant that
//! must survive byte-for-byte:
//!
//!   - [`ResourceKey::to_tenancy_parts`] **collapses exactly like the existing
//!     owner types**: when `user` is absent it yields `(None, None)` — an org
//!     without a user is *never* emitted, matching `Tenancy::owned_by(None, org)
//!     → Unattributed → (None, None)` and `DocOwner::owned(None, org) →
//!     (None, None)`. No production path has ever produced `(None, Some(org))`,
//!     and neither does this.
//!   - The `node` / `project` / `session` fields **compose but never emit** this
//!     wave: a `ResourceKey` carrying them yields a pair byte-identical to one
//!     without them. They exist so a future wave can fold project/session
//!     scoping (see the followups below) with the address already threaded — they
//!     change no SQL and no filter today.
//!   - An unbound node disables every filter upstream (`bound = 0` /
//!     `node_bound = false`); `ResourceKey` never re-enables it.
//!
//! ## Deferred (documented followups, out of scope this wave)
//!
//!   - Fold `MemoryScope` (`ryu-memory`) — memory has no `org_id` and shares by
//!     scope, so `project`/`node` here would drive `MemoryScope::Project`/`Node`
//!     rather than the `(user, org)` pair. Not this wave.
//!   - Fold `permission_scope_id` — the ACP bridge's per-turn scope id maps to
//!     `session` here, but the choke points still key on `(user, org)`. Not this
//!     wave.
//!   - Migrate the DB to store `project`/`session` columns. Not this wave — the
//!     fields are in-memory composition only.

/// The compound tenancy address of a resource. Every field is optional; the
/// production-relevant collapse is user-driven (see [`Self::to_tenancy_parts`]).
///
/// Deliberately **not** in the `PluginManifest`/`JsonSchema` reachable graph — it
/// is a tenancy composition type, not a manifest shape, so it derives only the
/// plain data traits and never lands in a schema snapshot.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResourceKey {
    /// The owning org, if any. Emitted in the collapsed pair only when `user` is
    /// also present (mirroring the existing owner types' collapse).
    pub org: Option<String>,
    /// The owning Core node / machine. Composed for a future wave; not emitted in
    /// the collapsed `(user, org)` pair today.
    pub node: Option<String>,
    /// The owning project / working folder. Composed for a future wave (would
    /// drive `MemoryScope::Project`); not emitted in the collapsed pair today.
    pub project: Option<String>,
    /// The owning session / host conversation (the ACP `permission_scope_id`).
    /// Composed for a future wave; not emitted in the collapsed pair today.
    pub session: Option<String>,
    /// The owning user. This is the field that drives the collapse: absent ⇒ the
    /// row is unattributed `(None, None)`.
    pub user: Option<String>,
}

impl ResourceKey {
    /// The unattributed key — collapses to `(None, None)`, byte-identical to
    /// `Tenancy::Unattributed` / `DocOwner::unattributed()`. This is what an
    /// unbound personal node, or a write into an already-existing row, passes.
    pub fn unattributed() -> Self {
        Self::default()
    }

    /// Attribute to `user` (with optional `org`) unless `user` is absent, in which
    /// case the key is unattributed. The single constructor a call site uses so it
    /// never hand-assembles the `(owner_user_id, org_id)` pair. Mirrors
    /// `Tenancy::owned_by` / `DocOwner::owned` exactly.
    pub fn owned(user: Option<&str>, org: Option<&str>) -> Self {
        match user {
            Some(uid) => Self {
                user: Some(uid.to_owned()),
                org: org.map(str::to_owned),
                ..Self::default()
            },
            None => Self::unattributed(),
        }
    }

    /// Reconstruct a key from the collapsed `(owner_user_id, org_id)` pair a store
    /// row already holds — the inverse of [`Self::to_tenancy_parts`]. Used to lift
    /// an existing owner type into a `ResourceKey` without re-deriving it.
    pub fn from_tenancy_parts(owner_user_id: Option<&str>, org_id: Option<&str>) -> Self {
        Self::owned(owner_user_id, org_id)
    }

    /// Set the composed session (host conversation / `permission_scope_id`).
    /// Chainable get-or-create composition; does not affect the collapsed pair.
    #[must_use]
    pub fn with_session(mut self, session: Option<&str>) -> Self {
        self.session = session.map(str::to_owned);
        self
    }

    /// Set the composed project (working folder). Chainable; does not affect the
    /// collapsed pair this wave (a future wave folds it into `MemoryScope`).
    #[must_use]
    pub fn with_project(mut self, project: Option<&str>) -> Self {
        self.project = project.map(str::to_owned);
        self
    }

    /// Set the composed node. Chainable; does not affect the collapsed pair.
    #[must_use]
    pub fn with_node(mut self, node: Option<&str>) -> Self {
        self.node = node.map(str::to_owned);
        self
    }

    /// **THE COLLAPSE** — the `(owner_user_id, org_id)` column pair this key
    /// writes/filters on, byte-identical to today's owner types.
    ///
    /// `user` absent ⇒ `(None, None)`: an org without a user is never emitted, so
    /// this can never produce the `(None, Some(org))` pair the existing SQL has
    /// never seen. The `node`/`project`/`session` fields are **not** emitted —
    /// a populated key collapses identically to a bare one.
    pub fn to_tenancy_parts(&self) -> (Option<&str>, Option<&str>) {
        match &self.user {
            Some(user) => (Some(user.as_str()), self.org.as_deref()),
            None => (None, None),
        }
    }

    /// Owned + carries a concrete `(user, org)` (i.e. the collapse yields a user).
    /// Convenience for call sites that branch on attribution.
    pub fn is_attributed(&self) -> bool {
        self.user.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The collapse matches the existing owner types' collapse exactly:
    /// `user` absent ⇒ `(None, None)`, regardless of `org`.
    #[test]
    fn collapse_drops_org_when_user_absent() {
        // org-only (no user) must NOT emit (None, Some(org)) — the pair the SQL
        // has never seen. It collapses to fully unattributed.
        let org_only = ResourceKey {
            org: Some("acme".into()),
            ..ResourceKey::default()
        };
        assert_eq!(org_only.to_tenancy_parts(), (None, None));

        // The public constructor collapses identically.
        assert_eq!(
            ResourceKey::owned(None, Some("acme")).to_tenancy_parts(),
            (None, None)
        );
        assert_eq!(ResourceKey::unattributed().to_tenancy_parts(), (None, None));
    }

    /// An attributed key emits `(Some(user), org)` — matching
    /// `Tenancy::Owned { user_id, org_id }.parts()`.
    #[test]
    fn attributed_emits_user_and_org() {
        assert_eq!(
            ResourceKey::owned(Some("u1"), Some("acme")).to_tenancy_parts(),
            (Some("u1"), Some("acme"))
        );
        assert_eq!(
            ResourceKey::owned(Some("u1"), None).to_tenancy_parts(),
            (Some("u1"), None)
        );
    }

    /// The compound fields COMPOSE but never EMIT: a key carrying
    /// node/project/session collapses byte-identically to one without them.
    #[test]
    fn compound_fields_compose_but_do_not_emit() {
        let bare = ResourceKey::owned(Some("u1"), Some("acme"));
        let compound = ResourceKey::owned(Some("u1"), Some("acme"))
            .with_node(Some("node-7"))
            .with_project(Some("/home/u1/proj"))
            .with_session(Some("conv-123"));

        // Same collapsed pair — the extra address is carried, never emitted.
        assert_eq!(bare.to_tenancy_parts(), compound.to_tenancy_parts());

        // And it is genuinely carried (not silently dropped by the builders).
        assert_eq!(compound.node.as_deref(), Some("node-7"));
        assert_eq!(compound.project.as_deref(), Some("/home/u1/proj"));
        assert_eq!(compound.session.as_deref(), Some("conv-123"));
    }

    /// Round-trip through the collapsed pair is stable (the inverse constructor).
    #[test]
    fn from_tenancy_parts_round_trips() {
        for (u, o) in [(Some("u1"), Some("acme")), (Some("u1"), None), (None, None)] {
            let key = ResourceKey::from_tenancy_parts(u, o);
            assert_eq!(key.to_tenancy_parts(), (u, o));
        }
        // The one asymmetric input collapses (org-only in ⇒ unattributed out).
        let key = ResourceKey::from_tenancy_parts(None, Some("acme"));
        assert_eq!(key.to_tenancy_parts(), (None, None));
    }
}
