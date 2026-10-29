//! One installed profile owns one public URI scheme and one app-data identity.
use anyhow::{ensure, Result};
use std::collections::BTreeMap;

fn schemes() -> BTreeMap<String, String> {
    serde_json::from_str(include_str!(
        "../../../../packages/protocol/src/deep-link-profiles.json"
    ))
    .expect("canonical deep-link profile table must be valid")
}

fn identifier(profile: &str) -> String {
    if profile == "release" {
        "ai.amajor.ryu.desktop".into()
    } else {
        format!("ai.amajor.ryu.desktop.{profile}")
    }
}

pub(crate) fn registration_scheme(bundle: &str, profile: &str, debug: bool) -> Option<String> {
    if bundle != identifier(profile) || (debug && profile == "release") {
        return None;
    }
    schemes().remove(profile)
}

fn link_profile(url: &str) -> Option<String> {
    let (scheme, _) = url.split_once("://")?;
    schemes()
        .into_iter()
        .find_map(|(profile, expected)| scheme.eq_ignore_ascii_case(&expected).then_some(profile))
}

pub(crate) fn registration_schemes(
    bundle: &str,
    profile: &str,
    debug: bool,
    configured: &[String],
) -> Vec<String> {
    let owned = registration_scheme(bundle, profile, debug);
    let reserved = schemes();
    configured
        .iter()
        .filter(|scheme| {
            if reserved
                .values()
                .any(|value| value.eq_ignore_ascii_case(scheme))
            {
                owned
                    .as_ref()
                    .is_some_and(|owned| owned.eq_ignore_ascii_case(scheme))
            } else {
                true // Private schemes belong to their embedded bundle configuration.
            }
        })
        .cloned()
        .collect()
}

fn validate_launch(profile: &str, arguments: &[String]) -> Result<()> {
    for argument in arguments {
        if let Some(requested) = link_profile(argument) {
            ensure!(
                requested == profile,
                "This link belongs to the {requested} profile, not {profile}"
            );
        }
    }
    Ok(())
}

pub(crate) fn before_boot(bundle: &str) -> Result<()> {
    // A profile bundle can carry a stable-versioned train (notably Beta). The
    // installed identity is authoritative when no explicit runtime override exists.
    if std::env::var("RYU_PROFILE").map_or(true, |value| value.trim().is_empty()) {
        for profile in schemes().keys() {
            if profile != "release" && bundle == identifier(profile) {
                std::env::set_var("RYU_PROFILE", profile);
                break;
            }
        }
    }
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    validate_bundle_launch(bundle, &arguments)?;
    validate_launch(&crate::profile::name(), &arguments)
}

fn validate_bundle_launch(bundle: &str, arguments: &[String]) -> Result<()> {
    if let Some(owner) = schemes()
        .keys()
        .find(|profile| bundle == identifier(profile))
    {
        for argument in arguments {
            if let Some(requested) = link_profile(argument) {
                ensure!(
                    requested == *owner,
                    "This installed app owns the {owner} profile, not {requested}"
                );
            }
        }
    }
    Ok(())
}

pub(crate) fn link_profile_for_bundle(bundle: &str, active: &str, debug: bool) -> Option<String> {
    registration_scheme(bundle, active, debug).map(|_| active.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stable_is_never_claimed_by_debug_or_unrelated_bundles() {
        assert_eq!(
            registration_scheme("ai.amajor.ryu.desktop", "release", false).as_deref(),
            Some("ryu")
        );
        assert!(registration_scheme("ai.amajor.ryu.desktop", "release", true).is_none());
        assert!(registration_scheme("com.ryu.update-proof", "release", false).is_none());
        assert!(registration_scheme("ai.amajor.ryu.desktop.dev", "release", false).is_none());
        assert_eq!(
            registration_schemes(
                "com.ryu.update-proof",
                "dev",
                true,
                &["ryu".into(), "ryu-dev".into(), "ryu-update-proof".into()]
            ),
            vec!["ryu-update-proof"]
        );
    }
    #[test]
    fn each_profile_claims_only_its_own_scheme() {
        for (profile, scheme) in schemes() {
            assert!(crate::profile::offset_of(&profile).is_some());
            assert_eq!(
                registration_scheme(&identifier(&profile), &profile, false),
                Some(scheme.clone())
            );
            validate_launch(&profile, &[format!("{scheme}://open/settings")]).unwrap();
            if profile != "release" {
                assert!(validate_launch(&profile, &["ryu://open/settings".into()]).is_err());
            }
        }
    }

    #[test]
    fn runtime_override_cannot_make_dev_bundle_accept_stable_links() {
        assert!(validate_launch("release", &["ryu://open/settings".into()]).is_ok());
        assert!(validate_bundle_launch(
            "ai.amajor.ryu.desktop.dev",
            &["ryu://open/settings".into()]
        )
        .is_err());
        assert!(link_profile_for_bundle("ai.amajor.ryu.desktop.dev", "release", false).is_none());
    }
}
