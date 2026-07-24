//! Plugin dependency graph — resolution, ordering, and cycle detection.
//!
//! This is the foundation for decomposing Ryu into a **minimal kernel plus
//! plugins that depend on other plugins** (npm-shaped, but for features). A
//! manifest declares its edges in [`crate::plugin_manifest::Requires`]; this
//! module turns the resulting graph into the two orders the lifecycle needs:
//!
//! - [`resolve_enable_order`] — the dependencies that must be enabled, in
//!   topological order, ending with the target. Deps first, target last.
//! - [`resolve_disable_order`] — the reverse: the enabled dependents that would
//!   break, in reverse-topological order, ending with the target. Dependents
//!   first, target last.
//! - [`dependents_of`] — the reverse edges (transitive), so a caller can *refuse*
//!   a disable and name exactly who is in the way.
//!
//! # Core-vs-Gateway boundary
//!
//! Pure Core. This module decides **what runs and in what order** — it performs
//! no policy, no I/O, and no grant checks. Grant validation stays where it is
//! (the Gateway, called from [`crate::plugins::lifecycle`]); every plugin this
//! module orders still goes through that gate individually.
//!
//! # The "installed set" contract (important)
//!
//! Every function takes a `&[PluginManifest]` slice that the caller has ALREADY
//! filtered to the relevant lifecycle state:
//!
//! - [`resolve_enable_order`] expects the **installed** manifests. A dependency
//!   absent from the slice is therefore reported as
//!   [`DependencyError::MissingDependency`] — "declared but not installed".
//! - [`dependents_of`] / [`resolve_disable_order`] expect the **installed AND
//!   enabled** manifests, so the dependents they name are exactly the ones that
//!   would actually break.
//!
//! Keeping the filter in the caller is what makes these functions pure and
//! exhaustively testable without a store, a Gateway, or a tokio runtime.
//!
//! # Version semantics
//!
//! A dependency's `min_version` is a **minimum**, not a caret range: a bare
//! `"1.2.0"` means `">=1.2.0"`, so an installed `2.0.0` satisfies it. That single
//! definition lives in [`crate::plugin_manifest::parse_min_version`] and is shared
//! with manifest load-time validation — there is no second semver comparison here.

use std::collections::{HashMap, HashSet};

use crate::plugin_manifest::{parse_min_version, PluginManifest};

/// A typed dependency-graph failure.
///
/// Every variant carries the **ids** involved rather than a prose blob, so a UI
/// can render "Disable Meetings, Whiteboard, Canvas first" (or offer a one-click
/// cascade) without string-parsing an error message. `code()` gives a stable
/// machine token for the same reason.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum DependencyError {
    /// The plugin itself is not installed.
    NotInstalled { plugin: String },

    /// A plugin declares itself as a dependency. (Also rejected at manifest load;
    /// re-checked here so the graph is safe on any input.)
    SelfDependency { plugin: String },

    /// A declared dependency is not installed.
    MissingDependency {
        /// The plugin that declared the edge.
        plugin: String,
        /// The dependency it needs.
        dependency: String,
        /// The version requirement, if one was declared.
        required: Option<String>,
    },

    /// A declared dependency IS installed, but its version does not satisfy the
    /// requirement.
    VersionMismatch {
        plugin: String,
        dependency: String,
        /// The requirement as written in the manifest (e.g. `"1.2.0"`).
        required: String,
        /// The version actually installed (e.g. `"1.0.0"`).
        installed: String,
    },

    /// A dependency's `min_version` is not a parseable semver requirement.
    InvalidVersionReq {
        plugin: String,
        dependency: String,
        requirement: String,
        reason: String,
    },

    /// The dependency graph contains a cycle. `cycle` names the loop in order,
    /// with the entry point repeated at the end (`["a", "b", "a"]`).
    Cycle { cycle: Vec<String> },

    /// A disable was refused because other ENABLED plugins depend on this one.
    /// `dependents` is the full transitive blast radius, in the order they would
    /// have to be disabled (dependents before their dependencies).
    BlockedByDependents {
        plugin: String,
        dependents: Vec<String>,
    },
}

impl DependencyError {
    /// Stable machine-readable token for this failure (matches the serde tag).
    pub const fn code(&self) -> &'static str {
        match self {
            DependencyError::NotInstalled { .. } => "not_installed",
            DependencyError::SelfDependency { .. } => "self_dependency",
            DependencyError::MissingDependency { .. } => "missing_dependency",
            DependencyError::VersionMismatch { .. } => "version_mismatch",
            DependencyError::InvalidVersionReq { .. } => "invalid_version_req",
            DependencyError::Cycle { .. } => "cycle",
            DependencyError::BlockedByDependents { .. } => "blocked_by_dependents",
        }
    }
}

impl std::fmt::Display for DependencyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DependencyError::NotInstalled { plugin } => {
                write!(f, "plugin '{plugin}' is not installed")
            }
            DependencyError::SelfDependency { plugin } => {
                write!(f, "plugin '{plugin}' cannot depend on itself")
            }
            DependencyError::MissingDependency {
                plugin,
                dependency,
                required,
            } => match required {
                Some(req) => write!(
                    f,
                    "plugin '{plugin}' requires '{dependency}' ({req}), which is not installed"
                ),
                None => write!(
                    f,
                    "plugin '{plugin}' requires '{dependency}', which is not installed"
                ),
            },
            DependencyError::VersionMismatch {
                plugin,
                dependency,
                required,
                installed,
            } => write!(
                f,
                "plugin '{plugin}' requires '{dependency}' {required}, but version \
                 {installed} is installed"
            ),
            DependencyError::InvalidVersionReq {
                plugin,
                dependency,
                requirement,
                reason,
            } => write!(
                f,
                "plugin '{plugin}' declares an invalid version requirement \
                 '{requirement}' for '{dependency}': {reason}"
            ),
            DependencyError::Cycle { cycle } => {
                write!(f, "dependency cycle detected: {}", cycle.join(" -> "))
            }
            DependencyError::BlockedByDependents { plugin, dependents } => write!(
                f,
                "cannot disable '{plugin}': still required by {}",
                dependents.join(", ")
            ),
        }
    }
}

impl std::error::Error for DependencyError {}

/// Index the manifest slice by id for O(1) edge lookups.
fn index<'a>(manifests: &'a [PluginManifest]) -> HashMap<&'a str, &'a PluginManifest> {
    manifests.iter().map(|m| (m.id.as_str(), m)).collect()
}

/// DFS colour, for cycle detection during the topological walk.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mark {
    /// On the current DFS stack (a second visit means a cycle).
    InProgress,
    /// Fully expanded and already emitted.
    Done,
}

/// Resolve the full set of plugins that must be enabled for `target_id` to run,
/// in **topological order: dependencies first, `target_id` last**.
///
/// `installed` must be the **installed** manifest set (see the module contract).
/// The returned order includes `target_id` itself and every transitive dependency
/// — including ones that are already enabled. The caller decides what to do with
/// each (the lifecycle skips the already-enabled ones); returning the complete
/// order keeps this function a pure statement about the graph rather than about
/// current enable state.
///
/// Detects, with the ids attached: a missing dependency, a version-too-low
/// dependency, an unparseable requirement, a self-dependency, and a cycle.
pub fn resolve_enable_order(
    target_id: &str,
    installed: &[PluginManifest],
) -> Result<Vec<String>, DependencyError> {
    let by_id = index(installed);
    if !by_id.contains_key(target_id) {
        return Err(DependencyError::NotInstalled {
            plugin: target_id.to_owned(),
        });
    }

    let mut marks: HashMap<String, Mark> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    visit_deps(target_id, &by_id, &mut marks, &mut order, &mut stack)?;
    Ok(order)
}

/// Post-order DFS over the forward (`requires`) edges. A node is pushed only
/// after every dependency it needs, which yields the topological enable order.
fn visit_deps(
    id: &str,
    by_id: &HashMap<&str, &PluginManifest>,
    marks: &mut HashMap<String, Mark>,
    order: &mut Vec<String>,
    stack: &mut Vec<String>,
) -> Result<(), DependencyError> {
    match marks.get(id) {
        // Already fully expanded — its deps are in `order` ahead of us.
        Some(Mark::Done) => return Ok(()),
        // Back-edge onto the current DFS stack: a cycle. Report the loop itself
        // (from where it closes), not the whole traversal path.
        Some(Mark::InProgress) => {
            let start = stack.iter().position(|s| s == id).unwrap_or(0);
            let mut cycle: Vec<String> = stack[start..].to_vec();
            cycle.push(id.to_owned());
            return Err(DependencyError::Cycle { cycle });
        }
        None => {}
    }

    // A manifest that reached this walk is installed (the caller filtered), so a
    // missing entry is only possible for a *declared* edge, handled below.
    let Some(manifest) = by_id.get(id) else {
        return Ok(());
    };

    marks.insert(id.to_owned(), Mark::InProgress);
    stack.push(id.to_owned());

    for dep in manifest.dependencies() {
        // Defence in depth: manifest load already rejects a self-edge, but the
        // graph must be safe on any input (a record could predate that gate).
        if dep.id == manifest.id {
            return Err(DependencyError::SelfDependency {
                plugin: manifest.id.clone(),
            });
        }

        let Some(installed_dep) = by_id.get(dep.id.as_str()) else {
            return Err(DependencyError::MissingDependency {
                plugin: manifest.id.clone(),
                dependency: dep.id.clone(),
                required: dep.min_version.clone(),
            });
        };

        // Version gate: `min_version` is a MINIMUM (a bare "1.2.0" means
        // ">=1.2.0"), compared against the dependency's manifest version.
        if let Some(min) = &dep.min_version {
            let req = parse_min_version(min).map_err(|e| DependencyError::InvalidVersionReq {
                plugin: manifest.id.clone(),
                dependency: dep.id.clone(),
                requirement: min.clone(),
                reason: e,
            })?;
            let have = semver::Version::parse(&installed_dep.version).map_err(|e| {
                DependencyError::InvalidVersionReq {
                    plugin: manifest.id.clone(),
                    dependency: dep.id.clone(),
                    requirement: min.clone(),
                    reason: format!(
                        "installed version '{}' is not valid semver: {e}",
                        installed_dep.version
                    ),
                }
            })?;
            if !req.matches(&have) {
                return Err(DependencyError::VersionMismatch {
                    plugin: manifest.id.clone(),
                    dependency: dep.id.clone(),
                    required: min.clone(),
                    installed: installed_dep.version.clone(),
                });
            }
        }

        visit_deps(&dep.id, by_id, marks, order, stack)?;
    }

    stack.pop();
    marks.insert(id.to_owned(), Mark::Done);
    order.push(id.to_owned());
    Ok(())
}

/// The plugins in `manifests` that depend on `id`, **transitively** — the full
/// blast radius of disabling it.
///
/// Pass the **installed AND enabled** manifests to get the dependents that would
/// actually break (which is what a disable must refuse on). Returns them in
/// reverse-topological order: a dependent always appears before the plugin it
/// depends on, so the list doubles as a safe disable order. `id` itself is NOT
/// included.
pub fn dependents_of(id: &str, manifests: &[PluginManifest]) -> Vec<String> {
    let mut order = collect_dependents(id, manifests);
    // `collect_dependents` ends with `id` (post-order); the dependents are
    // everything before it.
    order.pop();
    order
}

/// The order in which to disable `id` **and everything that depends on it**:
/// dependents first (deepest first), `id` last.
///
/// Pass the **installed AND enabled** manifests. This is the cascade order — the
/// exact inverse of [`resolve_enable_order`] over the reverse graph, so a plugin
/// is never left enabled with a disabled dependency.
pub fn resolve_disable_order(id: &str, manifests: &[PluginManifest]) -> Vec<String> {
    collect_dependents(id, manifests)
}

/// Post-order DFS over the REVERSE edges from `id`. Emits each node after all of
/// its own dependents, so the result is [deepest dependents … direct dependents,
/// `id`] — i.e. a valid disable order, `id` last.
///
/// A cycle cannot produce infinite recursion here: `seen` gates re-entry. (A
/// cyclic graph could never have been enabled in the first place — the enable
/// path rejects cycles — so this is purely defensive.)
fn collect_dependents(id: &str, manifests: &[PluginManifest]) -> Vec<String> {
    // Reverse adjacency: dependency id -> the plugins that declare it.
    let mut reverse: HashMap<&str, Vec<&str>> = HashMap::new();
    for m in manifests {
        for dep in m.dependencies() {
            reverse.entry(dep.id.as_str()).or_default().push(&m.id);
        }
    }
    // Deterministic output regardless of manifest load order.
    for dependents in reverse.values_mut() {
        dependents.sort_unstable();
    }

    let mut seen: HashSet<&str> = HashSet::new();
    let mut order: Vec<String> = Vec::new();
    walk_dependents(id, &reverse, &mut seen, &mut order);
    order
}

fn walk_dependents<'a>(
    id: &'a str,
    reverse: &HashMap<&'a str, Vec<&'a str>>,
    seen: &mut HashSet<&'a str>,
    order: &mut Vec<String>,
) {
    if !seen.insert(id) {
        return;
    }
    if let Some(dependents) = reverse.get(id) {
        for dependent in dependents {
            walk_dependents(dependent, reverse, seen, order);
        }
    }
    order.push(id.to_owned());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_manifest::{AppDependency, Requires};

    /// Build a manifest with the given plugin-to-plugin dependency edges.
    /// `deps` entries are `(id, min_version)`.
    fn m(id: &str, version: &str, deps: &[(&str, Option<&str>)]) -> PluginManifest {
        PluginManifest {
            id: id.to_owned(),
            name: id.to_owned(),
            version: version.to_owned(),
            requires: if deps.is_empty() {
                None
            } else {
                Some(Requires {
                    apps: deps
                        .iter()
                        .map(|(d, mv)| AppDependency {
                            id: (*d).to_owned(),
                            min_version: mv.map(str::to_owned),
                        })
                        .collect(),
                    capabilities: vec![],
                    grants: vec![],
                })
            },
            ..Default::default()
        }
    }

    // ── resolve_enable_order ───────────────────────────────────────────────────

    #[test]
    fn no_deps_resolves_to_just_the_target() {
        let installed = vec![m("solo", "1.0.0", &[])];
        assert_eq!(
            resolve_enable_order("solo", &installed).unwrap(),
            vec!["solo"]
        );
    }

    #[test]
    fn deps_come_before_the_target_in_topological_order() {
        // meetings -> spaces, voice ; spaces -> storage
        let installed = vec![
            m("meetings", "1.0.0", &[("spaces", None), ("voice", None)]),
            m("spaces", "1.0.0", &[("storage", None)]),
            m("voice", "1.0.0", &[]),
            m("storage", "1.0.0", &[]),
        ];
        let order = resolve_enable_order("meetings", &installed).unwrap();
        assert_eq!(order.last().unwrap(), "meetings", "target must be last");

        let pos = |id: &str| order.iter().position(|s| s == id).unwrap();
        assert!(pos("storage") < pos("spaces"), "transitive dep first");
        assert!(pos("spaces") < pos("meetings"));
        assert!(pos("voice") < pos("meetings"));
        assert_eq!(order.len(), 4, "every transitive dep exactly once");
    }

    #[test]
    fn diamond_dependency_emits_each_node_once() {
        // d -> b, c ; b -> a ; c -> a
        let installed = vec![
            m("d", "1.0.0", &[("b", None), ("c", None)]),
            m("b", "1.0.0", &[("a", None)]),
            m("c", "1.0.0", &[("a", None)]),
            m("a", "1.0.0", &[]),
        ];
        let order = resolve_enable_order("d", &installed).unwrap();
        assert_eq!(order, vec!["a", "b", "c", "d"]);
    }

    #[test]
    fn missing_dependency_is_reported_with_ids() {
        let installed = vec![m("meetings", "1.0.0", &[("spaces", Some("1.0.0"))])];
        let err = resolve_enable_order("meetings", &installed).unwrap_err();
        assert_eq!(
            err,
            DependencyError::MissingDependency {
                plugin: "meetings".to_owned(),
                dependency: "spaces".to_owned(),
                required: Some("1.0.0".to_owned()),
            }
        );
        assert_eq!(err.code(), "missing_dependency");
    }

    #[test]
    fn enabling_an_uninstalled_plugin_is_not_installed() {
        let installed = vec![m("other", "1.0.0", &[])];
        assert_eq!(
            resolve_enable_order("ghost", &installed).unwrap_err(),
            DependencyError::NotInstalled {
                plugin: "ghost".to_owned()
            }
        );
    }

    #[test]
    fn version_too_low_is_rejected_with_both_versions() {
        let installed = vec![
            m("meetings", "1.0.0", &[("spaces", Some("2.0.0"))]),
            m("spaces", "1.5.0", &[]),
        ];
        assert_eq!(
            resolve_enable_order("meetings", &installed).unwrap_err(),
            DependencyError::VersionMismatch {
                plugin: "meetings".to_owned(),
                dependency: "spaces".to_owned(),
                required: "2.0.0".to_owned(),
                installed: "1.5.0".to_owned(),
            }
        );
    }

    #[test]
    fn version_satisfied_exactly_resolves() {
        let installed = vec![
            m("meetings", "1.0.0", &[("spaces", Some("2.0.0"))]),
            m("spaces", "2.0.0", &[]),
        ];
        assert_eq!(
            resolve_enable_order("meetings", &installed).unwrap(),
            vec!["spaces", "meetings"]
        );
    }

    /// The load-bearing semver decision: a bare `min_version` is a MINIMUM, not a
    /// caret range. `semver::VersionReq::parse("1.0.0")` would mean `^1.0.0` and
    /// wrongly REJECT an installed 2.0.0 — this pins that it is accepted.
    #[test]
    fn bare_min_version_is_a_minimum_not_a_caret_range() {
        let installed = vec![
            m("app", "1.0.0", &[("lib", Some("1.0.0"))]),
            m("lib", "2.0.0", &[]), // major bump — a caret req would reject this
        ];
        assert_eq!(
            resolve_enable_order("app", &installed).unwrap(),
            vec!["lib", "app"],
            "a bare min_version must accept a NEWER major version"
        );
    }

    #[test]
    fn explicit_comparator_syntax_is_honoured_verbatim() {
        // An explicit caret DOES pin the major — the escape hatch still works.
        let installed = vec![
            m("app", "1.0.0", &[("lib", Some("^1.0.0"))]),
            m("lib", "2.0.0", &[]),
        ];
        assert!(matches!(
            resolve_enable_order("app", &installed).unwrap_err(),
            DependencyError::VersionMismatch { .. }
        ));
    }

    #[test]
    fn malformed_min_version_is_rejected() {
        let installed = vec![
            m("app", "1.0.0", &[("lib", Some("not-a-version"))]),
            m("lib", "1.0.0", &[]),
        ];
        assert!(matches!(
            resolve_enable_order("app", &installed).unwrap_err(),
            DependencyError::InvalidVersionReq { .. }
        ));
    }

    #[test]
    fn cycle_is_detected_and_names_the_loop() {
        let installed = vec![
            m("a", "1.0.0", &[("b", None)]),
            m("b", "1.0.0", &[("c", None)]),
            m("c", "1.0.0", &[("a", None)]),
        ];
        let err = resolve_enable_order("a", &installed).unwrap_err();
        let DependencyError::Cycle { cycle } = err else {
            panic!("expected a cycle, got {err:?}");
        };
        assert_eq!(cycle, vec!["a", "b", "c", "a"], "loop named in order");
    }

    #[test]
    fn two_node_cycle_is_detected() {
        let installed = vec![
            m("a", "1.0.0", &[("b", None)]),
            m("b", "1.0.0", &[("a", None)]),
        ];
        assert!(matches!(
            resolve_enable_order("a", &installed).unwrap_err(),
            DependencyError::Cycle { .. }
        ));
    }

    #[test]
    fn self_dependency_is_rejected_by_the_graph() {
        // Manifest load also rejects this; the graph must be safe on any input.
        let installed = vec![m("a", "1.0.0", &[("a", None)])];
        assert_eq!(
            resolve_enable_order("a", &installed).unwrap_err(),
            DependencyError::SelfDependency {
                plugin: "a".to_owned()
            }
        );
    }

    // ── dependents_of / resolve_disable_order ──────────────────────────────────

    #[test]
    fn dependents_of_is_transitive_and_excludes_the_target() {
        // meetings -> spaces ; whiteboard -> spaces ; canvas -> whiteboard
        let enabled = vec![
            m("spaces", "1.0.0", &[]),
            m("meetings", "1.0.0", &[("spaces", None)]),
            m("whiteboard", "1.0.0", &[("spaces", None)]),
            m("canvas", "1.0.0", &[("whiteboard", None)]),
        ];
        let mut deps = dependents_of("spaces", &enabled);
        deps.sort();
        assert_eq!(
            deps,
            vec!["canvas", "meetings", "whiteboard"],
            "the full transitive blast radius, target excluded"
        );
    }

    #[test]
    fn dependents_of_is_empty_for_a_leaf() {
        let enabled = vec![
            m("spaces", "1.0.0", &[]),
            m("meetings", "1.0.0", &[("spaces", None)]),
        ];
        assert!(dependents_of("meetings", &enabled).is_empty());
    }

    #[test]
    fn dependents_only_counts_the_manifests_passed_in() {
        // Caller passes the ENABLED set; a disabled dependent is simply absent,
        // so it never blocks a disable.
        let enabled_without_meetings = vec![m("spaces", "1.0.0", &[])];
        assert!(dependents_of("spaces", &enabled_without_meetings).is_empty());
    }

    #[test]
    fn disable_order_is_dependents_first_target_last() {
        // canvas -> whiteboard -> spaces : disabling spaces must take canvas
        // down before whiteboard, and whiteboard before spaces.
        let enabled = vec![
            m("spaces", "1.0.0", &[]),
            m("whiteboard", "1.0.0", &[("spaces", None)]),
            m("canvas", "1.0.0", &[("whiteboard", None)]),
        ];
        assert_eq!(
            resolve_disable_order("spaces", &enabled),
            vec!["canvas", "whiteboard", "spaces"]
        );
    }

    #[test]
    fn disable_order_of_a_leaf_is_just_itself() {
        let enabled = vec![
            m("spaces", "1.0.0", &[]),
            m("meetings", "1.0.0", &[("spaces", None)]),
        ];
        assert_eq!(
            resolve_disable_order("meetings", &enabled),
            vec!["meetings"]
        );
    }

    /// The disable order is exactly the reverse of the enable order — the property
    /// that guarantees a plugin is never left enabled with a disabled dependency.
    #[test]
    fn disable_order_is_the_reverse_of_enable_order() {
        let plugins = vec![
            m("a", "1.0.0", &[]),
            m("b", "1.0.0", &[("a", None)]),
            m("c", "1.0.0", &[("b", None)]),
        ];
        let enable = resolve_enable_order("c", &plugins).unwrap();
        let mut disable = resolve_disable_order("a", &plugins);
        disable.reverse();
        assert_eq!(enable, disable);
    }

    // ── backward compatibility ─────────────────────────────────────────────────

    /// Every manifest that predates this feature declares no `requires`. It must
    /// resolve as "no dependencies" and never block anything.
    #[test]
    fn manifests_without_requires_have_no_edges() {
        let installed = vec![
            m("legacy-a", "1.0.0", &[]),
            m("legacy-b", "1.0.0", &[]),
            m("legacy-c", "1.0.0", &[]),
        ];
        for id in ["legacy-a", "legacy-b", "legacy-c"] {
            assert_eq!(resolve_enable_order(id, &installed).unwrap(), vec![id]);
            assert!(dependents_of(id, &installed).is_empty());
            assert_eq!(resolve_disable_order(id, &installed), vec![id]);
        }
    }

    /// The real built-in set: all shipped manifests must resolve standalone.
    /// Uses `load_builtins` (not `load`) so a plugin the developer happens to
    /// have in ~/.ryu/plugins cannot fail this.
    #[test]
    fn every_builtin_manifest_resolves_with_no_dependencies() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        assert!(!manifests.is_empty(), "built-ins must load");
        for manifest in &manifests {
            let order = resolve_enable_order(&manifest.id, &manifests)
                .unwrap_or_else(|e| panic!("built-in '{}' failed to resolve: {e}", manifest.id));
            assert_eq!(
                order.last().unwrap(),
                &manifest.id,
                "target is always last in the enable order"
            );
        }
    }
}
