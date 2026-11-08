//! Regression tests: `tool:command:<bin>` grants are owner-exclusive.
//!
//! A `command` tool lets its manifest choose literal argv for a trusted binary
//! (`rtk proxy sh -c <payload>`), which is unsandboxed process execution. The
//! Gateway must approve each such grant only for the first-party plugin that
//! ships that command, never for an arbitrary marketplace app.

use super::*;

/// (first-party owner id, legacy alias, the command grant it ships).
const COMMAND_OWNERS: &[(&str, &str, &str)] = &[
    ("@ryu/rtk", "com.ryu.rtk", "tool:command:rtk"),
    ("@ryu/spider", "com.ryu.spider", "tool:command:spider"),
    ("@ryu/ripgrep", "com.ryu.ripgrep", "tool:command:rg"),
    (
        "@ryu/just-bash",
        "com.ryu.just-bash",
        "tool:command:just-bash",
    ),
    ("@ryu/bitwarden", "com.ryu.bitwarden", "tool:command:bws"),
];

fn one(grant: &str) -> Vec<String> {
    vec![grant.to_string()]
}

#[test]
fn third_party_apps_cannot_obtain_trusted_command_grants() {
    for (_, _, grant) in COMMAND_OWNERS {
        for app_id in [
            "@evil/x",
            "com.evil.x",
            "rtk",
            "@ryu/rtk-evil",
            "com.ryu.evil",
        ] {
            let d = validate_grants_for(Some(app_id), &one(grant));
            assert_eq!(d.denied, one(grant), "{app_id} must be denied {grant}");
            assert!(d.approved.is_empty(), "{app_id} approved {grant}");
        }
        let anonymous = validate_grants_for(None, &one(grant));
        assert_eq!(
            anonymous.denied,
            one(grant),
            "no app id must be denied {grant}"
        );
    }
}

#[test]
fn each_first_party_owner_gets_only_its_own_command_grant() {
    for (owner, alias, grant) in COMMAND_OWNERS {
        for id in [*owner, *alias] {
            let d = validate_grants_for(Some(id), &one(grant));
            assert!(
                d.all_approved(),
                "{id} must be approved {grant}: {:?}",
                d.denied
            );
        }
        for (_, _, other) in COMMAND_OWNERS {
            if other == grant {
                continue;
            }
            let d = validate_grants_for(Some(owner), &one(other));
            assert_eq!(d.denied, one(other), "{owner} must not receive {other}");
        }
    }
}

#[test]
fn no_command_grant_is_on_the_default_allowlist() {
    let leaked: Vec<String> = default_grant_allowlist()
        .into_iter()
        .filter(|g| g.starts_with("tool:command:"))
        .collect();
    assert!(
        leaked.is_empty(),
        "command grants are unsandboxed exec and must be owner-exclusive: {leaked:?}"
    );
}
