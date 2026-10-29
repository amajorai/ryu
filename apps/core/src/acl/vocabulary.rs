//! Where the resolver's inputs actually come from.
//!
//! [`super::resolve`] is deliberately pure — it takes a [`PermissionRegistry`] and
//! a [`RoleCatalog`] and knows nothing about how they were built. This module is
//! the seam that builds them, and it exists so the vocabulary has exactly ONE
//! assembly point. Two independent sources feed it:
//!
//!   1. **The kernel's canonical keys** — [`crate::identity_verify::permissions`],
//!      shared byte-for-byte with the TypeScript control plane. These are the
//!      built-in permissions every node understands (`space.read`,
//!      `workflow.edit`, …) and they must never be forked or re-spelled here.
//!   2. **App-declared levels** — each installed plugin's
//!      `PluginManifest::permission_levels`, the vocabulary an app publishes so an
//!      admin can grant "team X may edit in this app" without Core knowing what
//!      that app does.
//!
//! Both land in one flat namespace, which is why the manifest validator forces
//! app level ids onto the same `[a-z0-9._-]` charset the kernel keys use: a
//! collision must look like a collision, not like two different permissions that
//! happen to render the same.
//!
//! # What an app may and may not say about a kernel key
//!
//! An app whose permissions ARE kernel concepts (the Workflows app and
//! `workflow.edit`) still has something useful to contribute: the human LABEL and
//! DESCRIPTION a grant picker renders. The kernel keys are bare strings; only the
//! app knows that `workflow.delete` also destroys run history.
//!
//! So a declaration naming a kernel key is accepted for its METADATA and ignored
//! for its SEMANTICS. Concretely: the label and description are kept, and the
//! `implies` edges are dropped. Dropping the edges is the security-relevant half
//! — honouring them would let an installed plugin widen a permission the kernel
//! already enforces elsewhere by declaring that it implies something bigger.
//!
//! The same widening is closed from the other direction: an app-owned level may
//! imply only levels that the SAME app owns. An edge from an app level to a
//! kernel key (`notes.view implies agent.edit`) would hand out the kernel key to
//! anyone granted the innocuous app level, and an edge into another app's level
//! would let one app lend semantics to another's grants. App level ids are owned
//! by the FIRST plugin that declares them (load order is deterministic); a later
//! plugin re-declaring the id gets none of its edges honoured.
//!
//! A dropped edge is REPORTED in [`Vocabulary::collisions`] rather than silently
//! swallowed: the app asked for something it did not get, and the admin granting
//! permissions deserves to know its declaration does not mean what it says.

use std::collections::BTreeSet;

use super::{PermissionRegistry, RoleCatalog};
use crate::identity_verify::{permissions, OrgRole};

/// A permission level as an app declared it, flattened out of the manifest so
/// this module does not depend on the manifest types.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeclaredLevel {
    /// Which plugin declared it, for attribution in the grant picker.
    pub plugin_id: String,
    /// Whether the declaring plugin is a compiled-in built-in. A built-in's
    /// non-kernel level ids cannot be taken over by an installed package.
    pub builtin: bool,
    pub id: String,
    pub label: String,
    pub description: String,
    pub implies: Vec<String>,
}

/// The assembled vocabulary plus everything a UI needs to render it.
#[derive(Debug, Clone, Default)]
pub struct Vocabulary {
    pub registry: PermissionRegistry,
    /// Picker rows, at most one per id, in declaration order. A non-kernel id
    /// shows its owner's declaration; a kernel key shows a built-in app's
    /// wording. An id with no trustworthy author has NO row: a level contested by
    /// two installed apps, or a kernel key only installed packages describe.
    /// Their wording is attacker-chosen (a package can sort its id first and call
    /// someone else's `foo.admin` "View only"), so it is never shown, and the id
    /// is reported in `collisions` instead. Each row's `implies` lists only the
    /// edges the registry honours for grants, so the picker never shows an
    /// implication that enforcement ignores.
    pub declared: Vec<DeclaredLevel>,
    /// App level ids whose `implies` edges were not honoured for grants: the id
    /// is a kernel key, the id is contested by two installed plugins, the
    /// declarer does not own the id, or an edge targets a kernel key or a level
    /// the declarer does not own. Surfaced rather than swallowed: the app asked
    /// for semantics it did not get, and whoever installed it deserves to know.
    /// A declaration that only supplies a label/description for a kernel key is
    /// NOT a collision — that is the supported way to make a built-in
    /// permission renderable.
    pub collisions: Vec<String>,
}

/// Build the registry from the kernel keys plus every app-declared level.
///
/// Implication edges are added only for app levels; the kernel keys are a flat
/// set today (`permissions.rs` models role→set membership, not implication), so
/// inventing edges between them here would encode a hierarchy the control plane
/// does not share and the two sides would disagree.
///
/// An edge is honoured in one of three ways:
///
/// - **both directions** when its declarer owns both ends (see [`level_owners`]);
/// - **deny direction only** when its declarer declared both ends and owns or
///   contests each of them, but owns at least one only jointly. A contested id
///   cannot be trusted to convey anything, yet dropping the edge outright would
///   LOOSEN access: a deny of `foo.view` would stop reaching the victim's
///   `foo.admin`, and a less specific tier's allow of `foo.admin` would win.
///   Keeping the deny half means a contest can only ever tighten a decision;
/// - **not at all** when an end is a kernel key, is owned by some other plugin,
///   or was not declared by this declarer.
pub fn build_vocabulary(declared: Vec<DeclaredLevel>) -> Vocabulary {
    let kernel: BTreeSet<&str> = permissions::PERMISSIONS.iter().copied().collect();
    let owners = level_owners(&declared, &kernel);

    let mut collisions: Vec<String> = Vec::new();

    let mut ids: Vec<String> = Vec::new();
    for level in &declared {
        // A kernel key keeps the app's metadata but never its semantics, so it is
        // NOT re-declared here; the kernel tier below owns the id. An app that
        // also tried to attach implications to it is reported.
        if kernel.contains(level.id.as_str()) {
            if !level.implies.is_empty() && !collisions.contains(&level.id) {
                collisions.push(level.id.clone());
            }
            continue;
        }
        ids.push(level.id.clone());
    }
    // A contested id conveys nothing by grant (see `level_owners`), which is a
    // dropped declaration whoever made it.
    for (id, ownership) in &owners {
        if ownership.owner.is_none() && !collisions.iter().any(|c| c == id) {
            collisions.push((*id).to_owned());
        }
    }
    // Kernel keys last so they win on any id that slipped through.
    ids.extend(kernel.iter().map(|k| (*k).to_string()));

    let mut registry = PermissionRegistry::new(ids);
    let mut honoured: Vec<Vec<String>> = vec![Vec::new(); declared.len()];
    for (index, level) in declared.iter().enumerate() {
        // Edges are only ever honoured for ids the app genuinely owns.
        if kernel.contains(level.id.as_str()) {
            continue;
        }
        let declarer = level.plugin_id.as_str();
        let implier = owners.get(level.id.as_str());
        let mut dropped = false;
        for implied in &level.implies {
            // An edge may only ladder WITHIN the declaring app's own levels. A
            // kernel target (`myapp.use implies space.delete`) would widen a
            // node-wide permission, and a target owned by another app would
            // widen that app's grants; neither is the declarer's to hand out.
            let target = owners.get(implied.as_str());
            let stake = |end: Option<&Ownership<'_>>| end.map(|o| o.stake(declarer));
            if kernel.contains(implied.as_str()) {
                dropped = true;
                continue;
            }
            match (stake(implier), stake(target)) {
                (Some(Stake::Owns), Some(Stake::Owns)) => {
                    registry = registry.with_implication(&level.id, implied);
                    honoured[index].push(implied.clone());
                }
                (Some(Stake::Owns | Stake::Contests), Some(Stake::Owns | Stake::Contests)) => {
                    // A contested end: keep the edge for denials only, so the
                    // contest can tighten a decision but never loosen one.
                    registry = registry.with_denial_only_implication(&level.id, implied);
                    dropped = true;
                }
                _ => dropped = true,
            }
        }
        if dropped && !collisions.contains(&level.id) {
            collisions.push(level.id.clone());
        }
    }

    // One picker row per id whose wording has a trustworthy author: the owner's
    // declaration for a non-kernel id, a built-in's for a kernel key. A
    // contested id, or a kernel key only installed packages describe, has none.
    let mut chosen: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
    for (index, level) in declared.iter().enumerate() {
        let trusted = if kernel.contains(level.id.as_str()) {
            level.builtin
        } else {
            owners
                .get(level.id.as_str())
                .is_some_and(|o| o.owner == Some(level.plugin_id.as_str()))
        };
        if trusted {
            chosen.entry(level.id.as_str()).or_insert(index);
        }
    }
    let keep: BTreeSet<usize> = chosen.into_values().collect();
    drop(owners);
    let declared: Vec<DeclaredLevel> = declared
        .into_iter()
        .zip(honoured)
        .enumerate()
        .filter(|(index, _)| keep.contains(index))
        .map(|(_, (mut level, edges))| {
            level.implies = edges;
            level
        })
        .collect();

    Vocabulary {
        registry,
        declared,
        collisions,
    }
}

/// Who may speak for one non-kernel level id.
#[derive(Debug, Default)]
struct Ownership<'a> {
    /// The single plugin whose edges on this id are honoured both ways, or
    /// `None` when the id is contested.
    owner: Option<&'a str>,
    /// Every plugin that declared the id, built-in or installed.
    declarers: BTreeSet<&'a str>,
}

/// A declarer's standing on one end of an edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stake {
    /// The declarer owns the id outright.
    Owns,
    /// The id is contested and the declarer is one of the contenders.
    Contests,
    /// Someone else owns the id, or the declarer never declared it.
    Foreign,
}

impl Ownership<'_> {
    fn stake(&self, plugin_id: &str) -> Stake {
        match self.owner {
            Some(owner) if owner == plugin_id => Stake::Owns,
            None if self.declarers.contains(plugin_id) => Stake::Contests,
            _ => Stake::Foreign,
        }
    }
}

/// The owning plugin of every non-kernel level id, or `None` when it is contested.
///
/// Ownership must not depend on load order between installed packages: the
/// plugins directory is read in filesystem order, and a package's id names its
/// directory, so a "first declarer wins" rule would let an attacker pick an id
/// that sorts ahead of its victim and take over the victim's level at the next
/// rebuild. So:
///
/// - a compiled-in built-in that declares an id owns it, whatever any installed
///   package says (built-ins are fixed at build time, and a guard test forbids
///   two built-ins minting the same id);
/// - otherwise an id declared by exactly one installed plugin is that plugin's;
/// - an id declared by two or more installed plugins has NO owner. No edge into
///   or out of it conveys a grant, and it is reported. Each contender's own
///   edges on it are still kept for DENIALS (see [`build_vocabulary`]), so the
///   contest fails closed in both directions: a grant of the id conveys only
///   itself, and a deny that used to reach it still does.
fn level_owners<'a>(
    declared: &'a [DeclaredLevel],
    kernel: &BTreeSet<&str>,
) -> std::collections::BTreeMap<&'a str, Ownership<'a>> {
    let mut builtin_owner: std::collections::BTreeMap<&str, &str> = Default::default();
    let mut installed: std::collections::BTreeMap<&str, BTreeSet<&str>> = Default::default();
    let mut owners: std::collections::BTreeMap<&str, Ownership<'a>> = Default::default();
    for level in declared {
        if kernel.contains(level.id.as_str()) {
            continue;
        }
        owners
            .entry(level.id.as_str())
            .or_default()
            .declarers
            .insert(level.plugin_id.as_str());
        if level.builtin {
            builtin_owner
                .entry(level.id.as_str())
                .or_insert(level.plugin_id.as_str());
        } else {
            installed
                .entry(level.id.as_str())
                .or_default()
                .insert(level.plugin_id.as_str());
        }
    }
    for (id, plugins) in installed {
        let sole = (plugins.len() == 1)
            .then(|| plugins.into_iter().next())
            .flatten();
        if let Some(entry) = owners.get_mut(id) {
            entry.owner = sole;
        }
    }
    for (id, plugin) in builtin_owner {
        if let Some(entry) = owners.get_mut(id) {
            entry.owner = Some(plugin);
        }
    }
    owners
}

/// The role catalog for the built-in Better Auth roles.
///
/// Custom org roles are resolved per-user at request time by the control plane
/// (`control_plane::resolve_permission_context`) and are therefore NOT baked in here —
/// they are a property of a caller, not of the node, and caching them into a
/// node-wide catalog would serve a stale answer after a role edit.
pub fn builtin_role_catalog() -> RoleCatalog {
    let mut catalog = RoleCatalog::new();
    for (role_id, role) in BUILTIN_ROLE_IDS {
        catalog = catalog.with_role(role_id, permissions::permissions_for_role(*role));
    }
    catalog
}

/// The role ids a grant editor may target, in privilege order.
///
/// Read straight off [`BUILTIN_ROLE_IDS`] rather than restated, because the ids
/// the editor writes into an overwrite must be exactly the ones
/// [`builtin_role_catalog`] is keyed by — a parallel list would drift into rules
/// the resolver ignores while the UI shows them as granted.
pub fn builtin_role_ids() -> impl Iterator<Item = &'static str> {
    BUILTIN_ROLE_IDS.iter().map(|(id, _)| *id)
}

/// The Better Auth role strings, paired with the [`OrgRole`] each parses to.
///
/// `OrgRole` has no `as_str` — it is a parse-only ladder (`from_ba_str` widens
/// anything unknown to the least privilege). The catalog is keyed by the string a
/// principal actually carries, so the mapping is spelled out here and pinned by
/// `builtin_role_ids_round_trip` below; a drift between these strings and
/// `from_ba_str` would leave a real role with no base permissions at all.
const BUILTIN_ROLE_IDS: &[(&str, OrgRole)] = &[
    ("owner", OrgRole::Owner),
    ("admin", OrgRole::Admin),
    ("member", OrgRole::Member),
    ("viewer", OrgRole::Viewer),
];

#[cfg(test)]
mod tests {
    use super::*;

    fn level_named(id: &str, plugin_id: &str) -> DeclaredLevel {
        DeclaredLevel {
            plugin_id: plugin_id.to_owned(),
            builtin: false,
            id: id.to_owned(),
            label: id.to_owned(),
            description: "d".to_owned(),
            implies: Vec::new(),
        }
    }

    fn level(id: &str, implies: &[&str]) -> DeclaredLevel {
        DeclaredLevel {
            plugin_id: "@ryu/workflows".to_owned(),
            builtin: false,
            id: id.to_owned(),
            label: id.to_owned(),
            description: "x".to_owned(),
            implies: implies.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    #[test]
    fn kernel_keys_are_always_declared() {
        // Every canonical key must resolve, or a permission the control plane
        // enforces would be denied here purely for being unknown.
        let vocab = build_vocabulary(Vec::new());
        for key in permissions::PERMISSIONS {
            assert!(
                vocab.registry.is_declared(key),
                "kernel key {key} must be declared"
            );
        }
    }

    #[test]
    fn every_offered_role_id_carries_base_permissions_in_the_catalog() {
        // `builtin_role_ids` is what a grant editor writes into an overwrite, and
        // `builtin_role_catalog` is what the resolver looks the id up in. An id
        // the catalog does not know contributes nothing, so a drift between the
        // two would render a targetable role whose rules silently never resolve.
        let vocab = build_vocabulary(Vec::new());
        let catalog = builtin_role_catalog();
        let acl = super::super::ResourceAcl::new();
        let ids: Vec<&str> = builtin_role_ids().collect();
        assert_eq!(ids, vec!["owner", "admin", "member", "viewer"]);
        for id in ids {
            let principal = super::super::Principal {
                user_id: "u1".into(),
                org_id: None,
                team_ids: Default::default(),
                role_ids: [id.to_owned()].into_iter().collect(),
            };
            assert_eq!(
                super::super::resolve(
                    &vocab.registry,
                    &catalog,
                    &principal,
                    &acl,
                    permissions::SPACE_READ
                ),
                super::super::Decision::Allowed,
                "role `{id}` is offered but the catalog gives it no base set"
            );
        }
    }

    #[test]
    fn app_levels_join_the_same_namespace() {
        let vocab = build_vocabulary(vec![level("myapp.read", &[])]);
        assert!(vocab.registry.is_declared("myapp.read"));
        assert!(vocab.collisions.is_empty());
    }

    #[test]
    fn an_app_cannot_redefine_a_kernel_key() {
        // The security property: an installed plugin must not be able to widen a
        // permission the kernel already enforces by re-declaring it with its own
        // implications.
        let kernel_key = permissions::PERMISSIONS[0];
        let vocab = build_vocabulary(vec![level(kernel_key, &["workflow.delete"])]);

        assert_eq!(
            vocab.collisions,
            vec![kernel_key.to_string()],
            "attaching implications to a kernel key must be reported"
        );
        // Still declared (the kernel owns it) but WITHOUT the app's implication.
        assert!(vocab.registry.is_declared(kernel_key));
        let catalog = builtin_role_catalog();
        let principal = super::super::Principal {
            user_id: "u1".into(),
            org_id: None,
            team_ids: Default::default(),
            role_ids: ["viewer".to_owned()].into_iter().collect(),
        };
        // The hijack attempt would have made holding the kernel key also grant
        // workflow.delete. It must not.
        let acl = super::super::ResourceAcl::new();
        assert_eq!(
            super::super::resolve(
                &vocab.registry,
                &catalog,
                &principal,
                &acl,
                "workflow.delete"
            ),
            super::super::Decision::Denied
        );
    }

    fn level_from(plugin_id: &str, id: &str, implies: &[&str]) -> DeclaredLevel {
        DeclaredLevel {
            plugin_id: plugin_id.to_owned(),
            builtin: false,
            id: id.to_owned(),
            label: id.to_owned(),
            description: "d".to_owned(),
            implies: implies.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    fn resolves(vocab: &Vocabulary, held: &str, wanted: &str) -> bool {
        let catalog = RoleCatalog::new().with_role("holder", [held]);
        let principal = super::super::Principal {
            user_id: "u1".into(),
            org_id: None,
            team_ids: Default::default(),
            role_ids: ["holder".to_owned()].into_iter().collect(),
        };
        super::super::resolve(
            &vocab.registry,
            &catalog,
            &principal,
            &super::super::ResourceAcl::new(),
            wanted,
        ) == super::super::Decision::Allowed
    }

    #[test]
    fn an_app_level_cannot_imply_a_kernel_key() {
        // `myapp.use implies space.delete` would turn a grant of the app's level
        // into node-wide delete. The edge is dropped and reported.
        let vocab = build_vocabulary(vec![
            level_from("@acme/myapp", permissions::SPACE_READ, &[]),
            level_from("@acme/myapp", "myapp.use", &[permissions::SPACE_READ]),
        ]);
        assert!(!resolves(&vocab, "myapp.use", permissions::SPACE_READ));
        assert!(resolves(&vocab, "myapp.use", "myapp.use"));
        assert_eq!(vocab.collisions, vec!["myapp.use".to_owned()]);
    }

    fn builtin_from(plugin_id: &str, id: &str, implies: &[&str]) -> DeclaredLevel {
        DeclaredLevel {
            builtin: true,
            ..level_from(plugin_id, id, implies)
        }
    }

    #[test]
    fn an_installed_app_cannot_borrow_or_extend_a_built_in_apps_level() {
        // `@acme/evil` re-declares `crm.admin` (owned by the built-in `@ryu/crm`)
        // to satisfy the same-manifest closure rule, then ladders its own level
        // into it, and also tries to bolt a new edge onto `crm.view`. It is listed
        // FIRST, so ownership cannot be a matter of load order.
        let vocab = build_vocabulary(vec![
            level_from("@acme/evil", "crm.admin", &[]),
            level_from("@acme/evil", "evil.use", &[]),
            level_from("@acme/evil", "crm.view", &["evil.use"]),
            level_from("@acme/evil", "evil.grab", &["crm.admin"]),
            builtin_from("@ryu/crm", "crm.view", &[]),
            builtin_from("@ryu/crm", "crm.admin", &["crm.view"]),
        ]);
        // The owner's own hierarchy still works.
        assert!(resolves(&vocab, "crm.admin", "crm.view"));
        // Granting the evil app's level does not convey the CRM's admin level.
        assert!(!resolves(&vocab, "evil.grab", "crm.admin"));
        // And a grant of crm.view already in place is not widened.
        assert!(!resolves(&vocab, "crm.view", "evil.use"));
        assert!(vocab.collisions.contains(&"crm.view".to_owned()));
        assert!(vocab.collisions.contains(&"evil.grab".to_owned()));
        assert!(!vocab.collisions.contains(&"crm.admin".to_owned()));
        // The picker attributes the id to its owner, once, with the owner's edges.
        let crm_admin: Vec<_> = vocab
            .declared
            .iter()
            .filter(|l| l.id == "crm.admin")
            .collect();
        assert_eq!(crm_admin.len(), 1);
        assert_eq!(crm_admin[0].plugin_id, "@ryu/crm");
        assert_eq!(crm_admin[0].implies, vec!["crm.view".to_owned()]);
        // And never shows an edge the resolver ignores.
        let grab = vocab.declared.iter().find(|l| l.id == "evil.grab").unwrap();
        assert!(grab.implies.is_empty());
    }

    /// Two INSTALLED apps: their relative order is filesystem order, which the
    /// attacker controls by choosing its plugin id. Whichever order they load
    /// in, a shared id is contested and conveys no grant, so neither can lend the
    /// other's grants anything.
    #[test]
    fn a_level_contested_by_two_installed_apps_conveys_no_grant_in_either_order() {
        let victim = vec![
            level_from("@vendor/victim", "foo.view", &[]),
            level_from("@vendor/victim", "foo.admin", &["foo.view"]),
        ];
        let evil = vec![
            level_from("@aaa/evil", "foo.admin", &[]),
            level_from("@aaa/evil", "evil.grab", &["foo.admin"]),
        ];
        for declared in [
            victim.iter().chain(&evil).cloned().collect::<Vec<_>>(),
            evil.iter().chain(&victim).cloned().collect::<Vec<_>>(),
        ] {
            let vocab = build_vocabulary(declared);
            assert!(!resolves(&vocab, "evil.grab", "foo.admin"));
            assert!(!resolves(&vocab, "evil.grab", "foo.view"));
            // The contested id conveys only itself by grant.
            assert!(!resolves(&vocab, "foo.admin", "foo.view"));
            assert!(resolves(&vocab, "foo.admin", "foo.admin"));
            assert!(vocab.collisions.contains(&"foo.admin".to_owned()));
            assert!(vocab.collisions.contains(&"evil.grab".to_owned()));
            // An uncontested level of the victim keeps working.
            assert!(resolves(&vocab, "foo.view", "foo.view"));
            for row in &vocab.declared {
                assert!(
                    row.implies.is_empty(),
                    "picker shows an edge enforcement ignores: {row:?}"
                );
            }
        }
    }

    /// The decision for `wanted` when the org tier allows `org_allow` and the
    /// member tier denies `member_deny` on one resource.
    fn org_allow_member_deny(
        vocab: &Vocabulary,
        org_allow: &str,
        member_deny: &str,
        wanted: &str,
    ) -> super::super::Decision {
        use super::super::{Overwrite, OverwriteTarget, ResourceAcl};
        let acl = ResourceAcl::new()
            .with(Overwrite::new(OverwriteTarget::Org("org_1".into())).allowing([org_allow]))
            .with(Overwrite::new(OverwriteTarget::Member("u1".into())).denying([member_deny]));
        let principal = super::super::Principal {
            user_id: "u1".into(),
            org_id: Some("org_1".into()),
            team_ids: Default::default(),
            role_ids: Default::default(),
        };
        super::super::resolve(
            &vocab.registry,
            &RoleCatalog::new(),
            &principal,
            &acl,
            wanted,
        )
    }

    /// The deny half of a contest. A member-tier deny of `foo.view` reaches the
    /// victim's `foo.admin` through `foo.admin -> foo.view`, so an org-tier allow
    /// of `foo.admin` is overruled. Installing a package that names either end of
    /// that edge must not cut the deny off and let the org allow through.
    #[test]
    fn contesting_either_end_of_a_victims_edge_keeps_its_deny_reaching_the_implier() {
        use super::super::Decision;
        let victim = vec![
            level_from("@vendor/victim", "foo.view", &[]),
            level_from("@vendor/victim", "foo.admin", &["foo.view"]),
        ];
        let before = build_vocabulary(victim.clone());
        assert_eq!(
            org_allow_member_deny(&before, "foo.admin", "foo.view", "foo.admin"),
            Decision::Denied
        );

        for contested in ["foo.admin", "foo.view"] {
            let evil = vec![level_from("@aaa/evil", contested, &[])];
            for declared in [
                victim.iter().chain(&evil).cloned().collect::<Vec<_>>(),
                evil.iter().chain(&victim).cloned().collect::<Vec<_>>(),
            ] {
                let vocab = build_vocabulary(declared);
                assert_eq!(
                    org_allow_member_deny(&vocab, "foo.admin", "foo.view", "foo.admin"),
                    Decision::Denied,
                    "contesting {contested} let the org allow of foo.admin win"
                );
                // The grant direction stays closed.
                assert!(!resolves(&vocab, "foo.admin", "foo.view"));
                assert!(vocab.collisions.contains(&contested.to_owned()));
            }
        }
    }

    /// The contest's deny-only edges never widen: with no deny anywhere, an org
    /// allow of the contested id still decides only that id.
    #[test]
    fn a_contested_edge_kept_for_denials_grants_nothing() {
        use super::super::Decision;
        let vocab = build_vocabulary(vec![
            level_from("@vendor/victim", "foo.view", &[]),
            level_from("@vendor/victim", "foo.admin", &["foo.view"]),
            level_from("@aaa/evil", "foo.admin", &[]),
        ]);
        assert_eq!(
            org_allow_member_deny(&vocab, "foo.admin", "unrelated.id", "foo.admin"),
            Decision::Allowed
        );
        assert_eq!(
            org_allow_member_deny(&vocab, "foo.admin", "unrelated.id", "foo.view"),
            Decision::Denied
        );
    }

    /// An installed package can only keep deny edges between ids it declared
    /// itself: it cannot reach into a level a built-in or another installed app
    /// owns outright, even in the deny direction.
    #[test]
    fn a_contender_keeps_no_edge_onto_a_level_it_does_not_declare_or_contest() {
        use super::super::Decision;
        let vocab = build_vocabulary(vec![
            builtin_from("@ryu/crm", "crm.view", &[]),
            level_from("@vendor/victim", "foo.admin", &[]),
            level_from("@aaa/evil", "foo.admin", &["crm.view"]),
        ]);
        // A deny of crm.view does not drag the contested foo.admin with it,
        // because the evil package does not own or contest crm.view.
        assert_eq!(
            org_allow_member_deny(&vocab, "foo.admin", "crm.view", "foo.admin"),
            Decision::Allowed
        );
        assert!(!resolves(&vocab, "foo.admin", "crm.view"));
    }

    /// The picker never shows a contested id with a contender's wording: the
    /// attacker could sort its plugin id first and label the victim's
    /// `foo.admin` "View only". The id is reported in `collisions` instead.
    #[test]
    fn a_contested_level_gets_no_picker_row_in_either_order() {
        let victim = vec![
            level_from("@vendor/victim", "foo.view", &[]),
            DeclaredLevel {
                label: "Administer".to_owned(),
                ..level_from("@vendor/victim", "foo.admin", &["foo.view"])
            },
        ];
        let evil = vec![DeclaredLevel {
            label: "View only".to_owned(),
            ..level_from("@aaa/evil", "foo.admin", &[])
        }];
        for declared in [
            victim.iter().chain(&evil).cloned().collect::<Vec<_>>(),
            evil.iter().chain(&victim).cloned().collect::<Vec<_>>(),
        ] {
            let vocab = build_vocabulary(declared);
            assert!(vocab.declared.iter().all(|row| row.id != "foo.admin"));
            assert!(vocab.collisions.contains(&"foo.admin".to_owned()));
            // Still a real id: an existing grant of it keeps resolving.
            assert!(vocab.registry.is_declared("foo.admin"));
            // The victim's uncontested level is still offered, under its owner.
            let view = vocab
                .declared
                .iter()
                .find(|row| row.id == "foo.view")
                .unwrap();
            assert_eq!(view.plugin_id, "@vendor/victim");
        }
    }

    /// The same applies to a kernel key: only a built-in app's wording is shown.
    /// An installed package that sorts first cannot relabel `space.delete`.
    #[test]
    fn only_a_built_in_app_can_word_a_kernel_key() {
        let kernel_key = permissions::PERMISSIONS[0];
        let installed_only = build_vocabulary(vec![DeclaredLevel {
            label: "View only".to_owned(),
            ..level_from("@aaa/evil", kernel_key, &[])
        }]);
        assert!(installed_only
            .declared
            .iter()
            .all(|row| row.id != kernel_key));
        assert!(installed_only.registry.is_declared(kernel_key));

        let with_builtin = build_vocabulary(vec![
            DeclaredLevel {
                label: "View only".to_owned(),
                ..level_from("@aaa/evil", kernel_key, &[])
            },
            DeclaredLevel {
                label: "Real wording".to_owned(),
                ..builtin_from("@ryu/workflows", kernel_key, &[])
            },
        ]);
        let rows: Vec<_> = with_builtin
            .declared
            .iter()
            .filter(|row| row.id == kernel_key)
            .collect();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "Real wording");
        assert_eq!(rows[0].plugin_id, "@ryu/workflows");
    }

    #[test]
    fn a_sole_installed_app_keeps_its_own_ladder() {
        let vocab = build_vocabulary(vec![
            level_from("@vendor/app", "app.view", &[]),
            level_from("@vendor/app", "app.admin", &["app.view"]),
        ]);
        assert!(resolves(&vocab, "app.admin", "app.view"));
        assert!(vocab.collisions.is_empty());
    }

    #[test]
    fn app_implications_are_registered() {
        let vocab = build_vocabulary(vec![
            level("myapp.read", &[]),
            level("myapp.edit", &["myapp.read"]),
        ]);
        let catalog = RoleCatalog::new().with_role("editor", ["myapp.edit"]);
        let principal = super::super::Principal {
            user_id: "u1".into(),
            org_id: None,
            team_ids: Default::default(),
            role_ids: ["editor".to_owned()].into_iter().collect(),
        };
        // Holding edit must grant read through the declared edge, or an app's
        // level hierarchy would have to be granted twice.
        assert_eq!(
            super::super::resolve(
                &vocab.registry,
                &catalog,
                &principal,
                &super::super::ResourceAcl::new(),
                "myapp.read"
            ),
            super::super::Decision::Allowed
        );
    }

    #[test]
    fn builtin_role_ids_round_trip_through_from_ba_str() {
        // If these strings drift from what `from_ba_str` parses, a principal
        // carrying a real role id would find no entry in the catalog and get an
        // empty base — silently losing every built-in permission.
        for (role_id, role) in BUILTIN_ROLE_IDS {
            assert_eq!(
                OrgRole::from_ba_str(role_id).rank(),
                role.rank(),
                "role id {role_id} does not parse back to its own OrgRole"
            );
        }
    }

    #[test]
    fn a_viewers_base_is_a_subset_of_an_owners() {
        // The catalog is the node's answer to "what does this role mean"; an
        // inversion here would invert every base decision the resolver makes.
        let owner = permissions::permissions_for_role(OrgRole::Owner);
        let viewer = permissions::permissions_for_role(OrgRole::Viewer);
        assert!(viewer.is_subset(&owner));

        // And the catalog actually carries a base for each built-in role: an
        // owner must resolve a permission their role grants.
        let catalog = builtin_role_catalog();
        let vocab = build_vocabulary(Vec::new());
        let owner_principal = super::super::Principal {
            user_id: "u1".into(),
            org_id: None,
            team_ids: Default::default(),
            role_ids: ["owner".to_owned()].into_iter().collect(),
        };
        let some_owner_perm = owner.iter().next().expect("owner holds permissions");
        assert_eq!(
            super::super::resolve(
                &vocab.registry,
                &catalog,
                &owner_principal,
                &super::super::ResourceAcl::new(),
                some_owner_perm
            ),
            super::super::Decision::Allowed
        );
    }

    /// The end-to-end proof that an app's declaration is REACHABLE, not inert:
    /// the real packaged Workflows manifest is parsed, its levels flow into the
    /// vocabulary, and the implication chain it declares actually resolves.
    ///
    /// Uses the compiled-in manifest rather than a hand-written fixture on
    /// purpose — a fixture would keep passing after someone deleted the block
    /// from the shipped manifest.
    #[test]
    fn the_packaged_workflows_app_declares_working_levels() {
        let raw = include_str!("../../../../generated/ryu-runtime/apps-store/workflows/manifest.json");
        let manifest: ryu_kernel_contracts::manifest::PluginManifest =
            serde_json::from_str(raw).expect("packaged workflows manifest parses");

        let declared: Vec<DeclaredLevel> = manifest
            .permission_levels
            .iter()
            .map(|l| DeclaredLevel {
                plugin_id: manifest.id.clone(),
                builtin: true,
                id: l.id.clone(),
                label: l.label.clone(),
                description: l.description.clone(),
                implies: l.implies.clone(),
            })
            .collect();
        assert!(
            declared.iter().any(|l| l.id == "workflow.edit"),
            "the shipped manifest must declare workflow.edit"
        );

        let vocab = build_vocabulary(declared);
        // `workflow.*` ARE kernel keys, so the app contributes only its human
        // label/description for them — that is the supported case, not an error.
        // Its `implies` edges are dropped (the kernel owns the semantics), which
        // IS reported.
        assert!(
            vocab.collisions.contains(&"workflow.edit".to_owned()),
            "workflow.edit declares implications over a kernel key, so the dropped edges must be reported"
        );
        // The metadata survives for the picker to render.
        let rendered = vocab
            .declared
            .iter()
            .find(|l| l.id == "workflow.delete")
            .expect("declared levels are retained for rendering");
        assert!(
            !rendered.description.is_empty(),
            "an admin needs the app's own words for what deleting allows"
        );

        // And the kernel key still resolves for a role that holds it, so the
        // collision degraded safely rather than losing the permission.
        let catalog = builtin_role_catalog();
        let owner = super::super::Principal {
            user_id: "u1".into(),
            org_id: None,
            team_ids: Default::default(),
            role_ids: ["owner".to_owned()].into_iter().collect(),
        };
        assert_eq!(
            super::super::resolve(
                &vocab.registry,
                &catalog,
                &owner,
                &super::super::ResourceAcl::new(),
                "workflow.edit"
            ),
            super::super::Decision::Allowed
        );
    }

    /// One flat namespace only works if it is genuinely flat — for the ids an APP
    /// owns. Two apps minting the same private id land on one registry node, so
    /// whichever also attaches implications lends them to the other app's grant.
    ///
    /// KERNEL keys are deliberately exempt: they are the kernel's vocabulary, not
    /// any app's, and several apps legitimately reference the same one (both the
    /// routing and toolkit apps are about node configuration, so both reference
    /// `gateway.configure`). Their `implies` edges are dropped and only their
    /// label/description is kept, so sharing one cannot lend semantics.
    #[test]
    fn no_two_built_in_apps_mint_the_same_private_permission_level_id() {
        let kernel: std::collections::BTreeSet<&str> =
            crate::identity_verify::permissions::PERMISSIONS
                .iter()
                .copied()
                .collect();
        let mut owner: std::collections::BTreeMap<String, String> = Default::default();
        for manifest in crate::plugin_manifest::PluginManifestLoader::load_builtins() {
            for level in &manifest.permission_levels {
                if kernel.contains(level.id.as_str()) {
                    continue;
                }
                if let Some(first) = owner.insert(level.id.clone(), manifest.id.clone()) {
                    panic!(
                        "permission level '{}' is minted by both '{first}' and '{}'",
                        level.id, manifest.id
                    );
                }
            }
        }
    }

    /// A kernel key referenced by several apps must render ONCE in a picker, or an
    /// admin sees the same permission twice with two different explanations and
    /// cannot tell which one they are granting.
    #[test]
    fn a_kernel_key_referenced_by_several_apps_is_offered_once() {
        let vocab = build_vocabulary(vec![
            DeclaredLevel {
                builtin: true,
                ..level_named("gateway.configure", "@ryu/routing")
            },
            DeclaredLevel {
                builtin: true,
                ..level_named("gateway.configure", "@ryu/layers")
            },
            level_named("myapp.thing", "@ryu/routing"),
        ]);
        let shown = vocab
            .declared
            .iter()
            .filter(|l| l.id == "gateway.configure")
            .count();
        assert_eq!(shown, 1, "a shared kernel key must be offered exactly once");
        assert!(vocab.declared.iter().any(|l| l.id == "myapp.thing"));
    }

    fn team_grant(allowed: &str) -> super::super::ResourceAcl {
        super::super::ResourceAcl::new().with(
            super::super::Overwrite::new(super::super::OverwriteTarget::Team("t1".to_owned()))
                .allowing([allowed]),
        )
    }

    fn team_member() -> super::super::Principal {
        super::super::Principal {
            user_id: "u1".into(),
            org_id: None,
            team_ids: ["t1".to_owned()].into_iter().collect(),
            role_ids: Default::default(),
        }
    }

    /// A third-party app level must not ladder into a kernel key: granting the
    /// innocuous `notes.view` would otherwise also grant `agent.edit`.
    #[test]
    fn an_app_level_edge_onto_a_kernel_key_grants_nothing() {
        let kernel_key = permissions::PERMISSIONS[0];
        let vocab = build_vocabulary(vec![
            level_from("@acme/notes", kernel_key, &[]),
            level_from("@acme/notes", "notes.view", &[kernel_key]),
        ]);
        assert_eq!(vocab.collisions, vec!["notes.view".to_owned()]);
        let rendered = vocab
            .declared
            .iter()
            .find(|l| l.id == "notes.view")
            .unwrap();
        assert!(
            rendered.implies.is_empty(),
            "the dropped edge is not offered"
        );
        assert_eq!(
            super::super::resolve(
                &vocab.registry,
                &RoleCatalog::new(),
                &team_member(),
                &team_grant("notes.view"),
                kernel_key
            ),
            super::super::Decision::Denied
        );
    }

    /// A second app re-declaring another app's private id must not attach its own
    /// edges to it, and an app must not imply another app's level.
    #[test]
    fn an_app_cannot_widen_another_apps_level() {
        let vocab = build_vocabulary(vec![
            level_from("@acme/notes", "notes.read", &[]),
            level_from("@acme/notes", "notes.write", &["notes.read"]),
            level_from("@evil/app", "notes.read", &["notes.write"]),
            level_from("@evil/app", "evil.view", &["notes.write"]),
        ]);
        // Both installed apps declare `notes.read`, so it has no owner whatever
        // the load order, and acme's own `notes.write -> notes.read` edge loses
        // its grant half with it (reported too).
        assert_eq!(
            vocab.collisions,
            vec![
                "notes.read".to_owned(),
                "notes.write".to_owned(),
                "evil.view".to_owned()
            ]
        );
        for (granted, wanted) in [("notes.read", "notes.write"), ("evil.view", "notes.write")] {
            assert_eq!(
                super::super::resolve(
                    &vocab.registry,
                    &RoleCatalog::new(),
                    &team_member(),
                    &team_grant(granted),
                    wanted
                ),
                super::super::Decision::Denied,
                "{granted} must not grant {wanted}"
            );
        }
        // A contested id conveys nothing by grant: the ladder into it is gone for
        // the owner of the other rung too, which fails closed.
        assert_eq!(
            super::super::resolve(
                &vocab.registry,
                &RoleCatalog::new(),
                &team_member(),
                &team_grant("notes.write"),
                "notes.read"
            ),
            super::super::Decision::Denied
        );
        assert!(
            vocab.declared.iter().all(|l| l.id != "notes.read"),
            "a contested id has no trustworthy wording, so no picker row"
        );
        let write = vocab
            .declared
            .iter()
            .find(|l| l.id == "notes.write")
            .unwrap();
        assert_eq!(write.plugin_id, "@acme/notes");
        assert!(write.implies.is_empty(), "the dropped edge is not offered");
    }

    /// `myapp.edit implies space.write` would hand out node-wide write — the same
    /// widening by the back door. The loader now refuses such a manifest and
    /// [`build_vocabulary`] drops the edge as defence in depth; this pins that no
    /// shipped manifest even tries to ladder out of its own namespace.
    #[test]
    fn no_built_in_app_level_implies_a_kernel_key() {
        let kernel: BTreeSet<&str> = permissions::PERMISSIONS.iter().copied().collect();
        for manifest in crate::plugin_manifest::PluginManifestLoader::load_builtins() {
            for level in &manifest.permission_levels {
                if kernel.contains(level.id.as_str()) {
                    continue;
                }
                for implied in &level.implies {
                    assert!(
                        !kernel.contains(implied.as_str()),
                        "'{}' declares '{}' implying kernel key '{implied}', which would widen it \
                         node-wide",
                        manifest.id,
                        level.id
                    );
                }
            }
        }
    }
}
