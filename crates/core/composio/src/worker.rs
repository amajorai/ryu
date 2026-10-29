//! Operator-selected background consumers. No caller identity is inferred from
//! an event payload, tenant credential, or unsigned token claims.
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::{collections::HashSet, path::PathBuf};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerIdentity {
    pub owner_user_id: String,
    pub jwt_file: Option<PathBuf>,
}

pub fn parse_identities(raw: &str) -> Result<Vec<WorkerIdentity>> {
    if raw.len() > 64 * 1024 {
        bail!("Connect worker configuration exceeds its limit");
    }
    let identities: Vec<WorkerIdentity> =
        serde_json::from_str(raw).context("Invalid Connect worker configuration")?;
    if identities.len() > 32 {
        bail!("At most 32 Connect workers may be configured");
    }
    let mut owners = HashSet::new();
    for identity in &identities {
        let owner = &identity.owner_user_id;
        if owner.is_empty()
            || owner.len() > 256
            || owner.chars().any(|c| c.is_control() || c.is_whitespace())
            || !owners.insert(owner)
            || (owner != "local" && identity.jwt_file.is_none())
            || identity
                .jwt_file
                .as_ref()
                .is_some_and(|path| !path.is_absolute())
        {
            bail!("Invalid or duplicate Connect worker identity");
        }
    }
    Ok(identities)
}

/// A credential-free local worker is admitted only on an unbound personal node.
/// A credential-backed worker must match the subject returned by Core's verifier.
pub fn identity_matches(
    identity: &WorkerIdentity,
    verified_user: Option<&str>,
    managed_or_bound: bool,
) -> bool {
    match (&identity.jwt_file, verified_user) {
        (Some(_), Some(user)) => user == identity.owner_user_id,
        (None, None) => !managed_or_bound && identity.owner_user_id == "local",
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configuration_refuses_ambiguous_or_unverified_workers() {
        for raw in [
            r#"[{"ownerUserId":"alice"}]"#,
            r#"[{"ownerUserId":"local"},{"ownerUserId":"local"}]"#,
            r#"[{"ownerUserId":"alice","jwtFile":"relative"}]"#,
            r#"[{"ownerUserId":"local","tenantId":"other"}]"#,
            r#"[{"ownerUserId":" "}]"#,
        ] {
            assert!(parse_identities(raw).is_err(), "{raw}");
        }
        assert!(parse_identities("[]").unwrap().is_empty());
    }

    #[test]
    fn missing_credentials_never_downgrade_to_local() {
        let local = parse_identities(r#"[{"ownerUserId":"local"}]"#)
            .unwrap()
            .remove(0);
        assert!(identity_matches(&local, None, false));
        assert!(!identity_matches(&local, None, true));
        let jwt_file = std::env::temp_dir().join("identity.jwt");
        let user_raw = serde_json::json!([{"ownerUserId":"alice","jwtFile":jwt_file}]).to_string();
        let user = parse_identities(&user_raw).unwrap().remove(0);
        assert!(identity_matches(&user, Some("alice"), true));
        assert!(!identity_matches(&user, Some("bob"), true));
        assert!(!identity_matches(&user, None, false));
        assert!(!identity_matches(&user, None, true));
    }
}
