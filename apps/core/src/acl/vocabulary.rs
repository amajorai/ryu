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
    pub id: String,
    pub label: String,
    pub description: String,
    pub implies: Vec<String>,
}

/// The assembled vocabulary plus everything a UI needs to render it.
#[derive(Debug, Clone, Default)]
pub struct Vocabulary {
    pub registry: PermissionRegistry,
    /// App-declared levels, in declaration order, for the grant picker.
    pub declared: Vec<DeclaredLevel>,
    /// App level ids whose `implies` edges were DROPPED because the id is a
    /// kernel key. Surfaced rather than swallowed: the app asked for semantics it
    /// did not get, and whoever installed it deserves to know. A declaration that
    /// only supplies a label/description for a kernel key is NOT a collision —
    /// that is the supported way to make a built-in permission renderable.
    pub collisions: Vec<String>,
}

/// Build the registry from the kernel keys plus every app-declared level.
///
/// Implication edges are added only for app levels; the kernel keys are a flat
/// set today (`permissions.rs` models role→set membership, not implication), so
/// inventing edges between them here would encode a hierarchy the control plane
/// does not share and the two sides would disagree.
pub fn build_vocabulary(declared: Vec<DeclaredLevel>) -> Vocabulary {
    let kernel: BTreeSet<&str> = permissions::PERMISSIONS.iter().copied().collect();

    let mut collisions = Vec::new();
    let mut ids: Vec<String> = Vec::new();
    for level in &declared {
        // A kernel key keeps the app's metadata but never its semantics, so it is
        // NOT re-declared here; the kernel tier below owns the id. An app that
        // also tried to attach implications to it is reported.
        if kernel.contains(level.id.as_str()) {
            if !level.implies.is_empty() {
                collisions.push(level.id.clone());
            }
            continue;
        }
        ids.push(level.id.clone());
    }
    // Kernel keys last so they win on any id that slipped through.
    ids.extend(kernel.iter().map(|k| (*k).to_string()));

    let mut registry = PermissionRegistry::new(ids);
    for level in &declared {
        // Edges are only ever honoured for ids the app genuinely owns.
        if kernel.contains(level.id.as_str()) {
            continue;
        }
        for implied in &level.implies {
            registry = registry.with_implication(&level.id, implied);
        }
    }

    // A kernel key may legitimately be referenced by several apps. Keep the FIRST
    // declaration (load order is deterministic) and drop the rest, so a picker
    // shows one row per permission instead of the same id with two different
    // explanations of what granting it does.
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let declared: Vec<DeclaredLevel> = declared
        .into_iter()
        .filter(|level| seen.insert(level.id.clone()))
        .collect();

    Vocabulary {
        registry,
        declared,
        collisions,
    }
}

/// The role catalog for the built-in Better Auth roles.
///
/// Custom org roles are resolved per-user at request time by the control plane
/// (`control_plane::resolve_permissions`) and are therefore NOT baked in here —
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
            id: id.to_owned(),
            label: id.to_owned(),
            description: "d".to_owned(),
            implies: Vec::new(),
        }
    }

    fn level(id: &str, implies: &[&str]) -> DeclaredLevel {
        DeclaredLevel {
            plugin_id: "@ryu/workflows".to_owned(),
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
            level_named("gateway.configure", "@ryu/routing"),
            level_named("gateway.configure", "@ryu/layers"),
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

    /// [`build_vocabulary`] drops an app's implications only when the app names a
    /// kernel key as its OWN id. An app-owned level that IMPLIES a kernel key
    /// keeps that edge, so `myapp.edit implies space.write` would hand out
    /// node-wide write with nothing reported — the same widening by the back
    /// door. No shipped manifest may ladder out of its own namespace.
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
