//! Capability edges in the reverse update/rollback gate.
//!
//! [`super::graph::validate_dependents_of_update`] checks only `requires.apps`
//! edges. Capability consumers bind through `requires.capabilities`, so an update
//! or rollback that drops a `provides` entry, lowers a provided capability version
//! below an enabled consumer's floor, or adds a second provider of a strict
//! capability would leave an enabled consumer unbound. The enable path refuses the
//! same state (`lifecycle::enable_app` runs [`first_binding_error`] over the
//! post-enable set); this module applies that check to the post-transition set.

use super::binding::{BindingConfig, BindingError, BindingRegistry};
use crate::plugin_manifest::PluginManifest;

/// The first enabled consumer (other than `incoming` itself) whose required
/// capabilities stop binding once `incoming` replaces the installed manifest with
/// the same id.
///
/// Pass the currently **enabled** manifests. When the target is not enabled its
/// `provides` reach no broker binding, so the transition cannot break a consumer
/// and this returns `None`. The target's own forward requirements are not judged
/// here: its new dependencies are installed after this gate, and the enable path
/// checks them.
///
/// [`first_binding_error`]: super::binding::first_binding_error
pub fn post_transition_binding_error(
    enabled: &[PluginManifest],
    incoming: &PluginManifest,
    config: &BindingConfig,
) -> Option<(String, BindingError)> {
    if !enabled.iter().any(|m| m.id == incoming.id) {
        return None;
    }
    let post: Vec<PluginManifest> = enabled
        .iter()
        .map(|m| {
            if m.id == incoming.id {
                incoming.clone()
            } else {
                m.clone()
            }
        })
        .collect();
    let registry = BindingRegistry::new(config, &post);
    post.iter().filter(|m| m.id != incoming.id).find_map(|m| {
        registry
            .resolve_all(m)
            .1
            .into_iter()
            .next()
            .map(|err| (m.id.clone(), err))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_manifest::{CapabilityReq, ProvidesEntry, Requires};

    fn provider(id: &str, version: &str, provides: &[(&str, &str)]) -> PluginManifest {
        PluginManifest {
            id: id.to_owned(),
            name: id.to_owned(),
            version: version.to_owned(),
            provides: provides
                .iter()
                .map(|(cap, v)| ProvidesEntry {
                    capability: (*cap).to_owned(),
                    version: (*v).to_owned(),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }

    fn consumer(id: &str, cap: &str, min: Option<&str>) -> PluginManifest {
        PluginManifest {
            id: id.to_owned(),
            name: id.to_owned(),
            version: "1.0.0".to_owned(),
            requires: Some(Requires {
                capabilities: vec![CapabilityReq {
                    capability: cap.to_owned(),
                    min_version: min.map(str::to_owned),
                }],
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn enabled_set() -> Vec<PluginManifest> {
        vec![
            provider("@ryu/rlm", "2.0.0", &[("rlm.query", "1.2.0")]),
            consumer("@ryu/research", "rlm.query", Some("1.2.0")),
        ]
    }

    #[test]
    fn unchanged_provides_passes() {
        let incoming = provider("@ryu/rlm", "2.1.0", &[("rlm.query", "1.3.0")]);
        let cfg = BindingConfig::default();
        assert!(post_transition_binding_error(&enabled_set(), &incoming, &cfg).is_none());
    }

    #[test]
    fn lowered_capability_version_is_refused() {
        let incoming = provider("@ryu/rlm", "1.0.0", &[("rlm.query", "1.0.0")]);
        let cfg = BindingConfig::default();
        let (plugin, err) =
            post_transition_binding_error(&enabled_set(), &incoming, &cfg).expect("refused");
        assert_eq!(plugin, "@ryu/research");
        assert!(
            matches!(err, BindingError::VersionUnsatisfied { .. }),
            "{err:?}"
        );
    }

    #[test]
    fn dropped_capability_is_refused() {
        let incoming = provider("@ryu/rlm", "3.0.0", &[]);
        let cfg = BindingConfig::default();
        let (plugin, err) =
            post_transition_binding_error(&enabled_set(), &incoming, &cfg).expect("refused");
        assert_eq!(plugin, "@ryu/research");
        assert!(matches!(err, BindingError::Unprovided { .. }), "{err:?}");
    }

    #[test]
    fn newly_ambiguous_strict_capability_is_refused() {
        let mut enabled = enabled_set();
        enabled.push(provider("@acme/other", "1.0.0", &[]));
        let incoming = provider("@acme/other", "1.1.0", &[("rlm.query", "1.5.0")]);
        let cfg = BindingConfig::default();
        let (plugin, err) =
            post_transition_binding_error(&enabled, &incoming, &cfg).expect("refused");
        assert_eq!(plugin, "@ryu/research");
        assert!(matches!(err, BindingError::Ambiguous { .. }), "{err:?}");
    }

    #[test]
    fn disabled_target_cannot_break_consumers() {
        let enabled = vec![consumer("@ryu/research", "rlm.query", None)];
        let incoming = provider("@ryu/rlm", "1.0.0", &[]);
        let cfg = BindingConfig::default();
        assert!(post_transition_binding_error(&enabled, &incoming, &cfg).is_none());
    }

    #[test]
    fn prerelease_provider_meets_a_plain_floor() {
        let incoming = provider("@ryu/rlm", "2.1.0-beta.1", &[("rlm.query", "1.3.0-beta.2")]);
        let cfg = BindingConfig::default();
        assert!(post_transition_binding_error(&enabled_set(), &incoming, &cfg).is_none());
    }
}
