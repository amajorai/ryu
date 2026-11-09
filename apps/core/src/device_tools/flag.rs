//! The `mobile.device_tools` rollout gate (design §2.4 step 1).
//!
//! - A caller with a cloud identity: the flag must be in the signed `ryu_flags`
//!   claim of the request's verified user JWT; on an org-bound node the claim
//!   must have been evaluated for exactly this node's org. No token, or a token that no longer
//!   verifies, is off (fail closed).
//! - The local owner with no JWT: the node preference `device-tools-enabled`
//!   (`"true"`/`"false"`), which defaults to off in every profile except `dev`.

use std::collections::BTreeSet;

pub(crate) const FLAG_KEY: &str = "mobile.device_tools";
pub(crate) const LOCAL_PREF_KEY: &str = "device-tools-enabled";

/// What the gate knows about the caller.
pub(crate) enum FlagSubject<'a> {
    /// Verified JWT flags (`None` when there is no token or it does not verify)
    /// and the org they were evaluated for.
    Cloud {
        flags: Option<&'a BTreeSet<String>>,
        flags_org: Option<&'a str>,
    },
    /// The local owner; `pref` is the stored `device-tools-enabled` value.
    LocalOwner { pref: Option<&'a str> },
}

/// Whether device tools are enabled for this caller on this node.
pub(crate) fn enabled(subject: FlagSubject<'_>, node_org: Option<&str>, profile: &str) -> bool {
    match subject {
        FlagSubject::Cloud { flags, flags_org } => {
            let Some(flags) = flags else {
                return false;
            };
            // On an org-bound node the claim must have been evaluated for
            // this node's org: a personal or unscoped claim does not count.
            if let Some(node_org) = node_org {
                if flags_org != Some(node_org) {
                    return false;
                }
            }
            flags.contains(FLAG_KEY)
        }
        FlagSubject::LocalOwner { pref } => match pref.map(str::trim) {
            Some("true") => true,
            Some("false") => false,
            _ => profile == "dev",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_callers_need_the_signed_flag_for_this_org() {
        let on: BTreeSet<String> = [FLAG_KEY.to_owned()].into();
        let off: BTreeSet<String> = BTreeSet::new();
        let cloud = |flags, flags_org| FlagSubject::Cloud { flags, flags_org };
        assert!(enabled(cloud(Some(&on), None), None, "release"));
        assert!(enabled(
            cloud(Some(&on), Some("org-1")),
            Some("org-1"),
            "release"
        ));
        assert!(!enabled(
            cloud(Some(&on), Some("org-2")),
            Some("org-1"),
            "release"
        ));
        assert!(
            !enabled(cloud(Some(&on), None), Some("org-1"), "release"),
            "an unscoped claim does not enable an org-bound node"
        );
        assert!(!enabled(cloud(Some(&off), None), None, "dev"));
        assert!(!enabled(cloud(None, None), None, "dev"));
    }

    #[test]
    fn token_only_owner_is_off_by_default_outside_dev() {
        let local = |pref| FlagSubject::LocalOwner { pref };
        assert!(!enabled(local(None), None, "release"));
        assert!(!enabled(local(None), None, "nightly"));
        assert!(enabled(local(None), None, "dev"));
        assert!(!enabled(local(Some("false")), None, "dev"));
        assert!(enabled(local(Some("true")), None, "release"));
        assert!(!enabled(local(Some("yes")), None, "release"));
    }
}
