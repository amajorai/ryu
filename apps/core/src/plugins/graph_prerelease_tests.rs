//! Pre-release and partial `min_version` floors through the dependency graph.
//!
//! A plugin on the beta or nightly channel carries a pre-release version. Plain
//! `VersionReq::matches` rejects every pre-release against a floor such as
//! `>=0.1.14`, so these cases pin the shared `min_version_satisfied` semantics at
//! both graph call sites: the forward enable walk and the reverse update gate.

use super::graph::{resolve_enable_order, validate_dependents_of_update, DependencyError};
use crate::plugin_manifest::{AppDependency, PluginManifest, Requires};

fn m(id: &str, version: &str, dep: Option<(&str, &str)>) -> PluginManifest {
    PluginManifest {
        id: id.to_owned(),
        name: id.to_owned(),
        version: version.to_owned(),
        requires: dep.map(|(dep_id, min)| Requires {
            apps: vec![AppDependency {
                id: dep_id.to_owned(),
                min_version: Some(min.to_owned()),
            }],
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn enables(installed_dep_version: &str, floor: &str) -> Result<Vec<String>, DependencyError> {
    let installed = vec![
        m("@ryu/spaces", installed_dep_version, None),
        m("@ryu/meetings", "1.0.0", Some(("@ryu/spaces", floor))),
    ];
    resolve_enable_order("@ryu/meetings", &installed)
}

fn updates(incoming: &str, floor: &str) -> Result<(), DependencyError> {
    let installed = vec![
        m("@ryu/spaces", "1.0.0", None),
        m("@ryu/meetings", "1.0.0", Some(("@ryu/spaces", floor))),
    ];
    validate_dependents_of_update(&m("@ryu/spaces", incoming, None), &installed)
}

#[test]
fn a_beta_dependency_above_the_floor_enables() {
    assert!(enables("1.0.1-beta.2", "0.1.14").is_ok());
}

#[test]
fn a_nightly_dependency_above_the_floor_enables() {
    assert!(enables("0.0.13-nightly.20260728.932", "0.0.12").is_ok());
}

#[test]
fn a_prerelease_of_the_floor_itself_does_not_enable() {
    let err = enables("1.2.0-beta.1", "1.2.0").expect_err("1.2.0-beta.1 precedes 1.2.0");
    assert_eq!(err.code(), "version_mismatch");
}

#[test]
fn a_partial_floor_does_not_cap_the_major() {
    assert!(enables("2.0.0", "1.2").is_ok());
    assert!(enables("2.0.0", "1").is_ok());
    assert!(enables("1.1.9", "1.2").is_err());
}

#[test]
fn an_rc_update_above_the_floor_is_allowed() {
    assert!(updates("2.0.0-rc.1", "1.0.0").is_ok());
}

#[test]
fn a_switch_to_the_beta_channel_is_allowed() {
    assert!(updates("1.0.1-beta.2", "0.1.14").is_ok());
}

#[test]
fn an_rc_of_an_excluded_major_is_still_refused() {
    let err = updates("2.0.0-rc.1", ">=1.0, <2").expect_err("<2 excludes 2.0.0-rc.1");
    assert_eq!(err.code(), "dependent_version_mismatch");
}

#[test]
fn a_partial_floor_does_not_block_a_major_update() {
    assert!(updates("2.0.0", "1.2").is_ok());
}
