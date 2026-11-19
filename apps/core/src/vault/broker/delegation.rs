//! Session attributes beyond the core session row: `onBehalfOf` delegation
//! and remote-listener admission.
//!
//! * **onBehalfOf.** A session minted for a named member resolves credentials
//!   as that member: their personal (user-scope) values come first, including
//!   the values a member provides for a service's credential slots (see
//!   `server/vault_broker_api/member_values.rs`), and their `user:`, `role:`
//!   and `team:` policies apply. The minter's own limits still hold (a
//!   machine's policies with no baseline, a human minter's denies), so reach
//!   is the intersection of the two. Minting needs `use` on
//!   [`delegate_key`]`(member)`; the member's role and teams are re-verified
//!   with the control plane at mint and the mint fails closed without them.
//!   Every brokered request records both principals (the session and its
//!   minter, and the member) and every credential use is audited as the
//!   member, tagged with the session.
//! * **remote.** Only a session minted with `remote` (which needs `use` on
//!   [`REMOTE_KEY`]) is admitted on the remote listener (see `remote.rs`).
//!
//! Attributes live in `vault_broker_session_attrs`, keyed by session id and
//! written in the same transaction as the session; a session without a row
//! has neither attribute.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::vault::VaultError;

/// Policy key for minting remote-admissible sessions.
pub const REMOTE_KEY: &str = "sys/broker/remote";
const MAX_MEMBER_ID_LEN: usize = 128;

/// Policy key for minting sessions on behalf of `member` (a user id).
pub fn delegate_key(member: &str) -> String {
    format!("sys/broker/delegate/{member}")
}

/// A delegated session's member.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub user_id: String,
    /// `user:<id>`, `role:<name>`, `team:<id>`, as verified at mint.
    pub subjects: Vec<String>,
}

impl Member {
    /// The member's organization roles.
    pub fn roles(&self) -> Vec<String> {
        self.subjects
            .iter()
            .filter_map(|subject| subject.strip_prefix("role:"))
            .map(str::to_owned)
            .collect()
    }

    /// `user:<id>`, for logs and audit details.
    pub fn subject(&self) -> String {
        format!("user:{}", self.user_id)
    }
}

/// What a session carries beyond its core row.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionAttrs {
    pub on_behalf_of: Option<Member>,
    pub remote: bool,
}

impl SessionAttrs {
    fn is_empty(&self) -> bool {
        self.on_behalf_of.is_none() && !self.remote
    }
}

/// Create the attributes table. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_broker_session_attrs (
             session_id   TEXT PRIMARY KEY,
             on_behalf_of TEXT,
             remote       INTEGER NOT NULL DEFAULT 0
         );",
    )
    .context("initializing broker session attributes schema")
}

/// Record a new session's attributes (nothing for plain sessions).
pub fn insert(conn: &Connection, session_id: &str, attrs: &SessionAttrs) -> Result<()> {
    if attrs.is_empty() {
        return Ok(());
    }
    let member = attrs
        .on_behalf_of
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    conn.execute(
        "INSERT INTO vault_broker_session_attrs (session_id, on_behalf_of, remote)
         VALUES (?1, ?2, ?3)",
        params![session_id, member, attrs.remote],
    )?;
    Ok(())
}

/// A session's attributes (defaults when it has none).
pub fn get(conn: &Connection, session_id: &str) -> Result<SessionAttrs> {
    let row: Option<(Option<String>, bool)> = conn
        .query_row(
            "SELECT on_behalf_of, remote FROM vault_broker_session_attrs WHERE session_id = ?1",
            params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((member, remote)) = row else {
        return Ok(SessionAttrs::default());
    };
    // A stored member that no longer parses must not silently widen the
    // session back to its minter's own reach.
    let on_behalf_of = member
        .map(|text| serde_json::from_str(&text))
        .transpose()
        .context("reading a delegated session's member")?;
    Ok(SessionAttrs {
        on_behalf_of,
        remote,
    })
}

/// Drop attributes of sessions that no longer exist.
pub fn prune(conn: &Connection) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM vault_broker_session_attrs WHERE session_id NOT IN
             (SELECT id FROM vault_broker_sessions)",
        [],
    )?)
}

/// A well-formed member id (a control-plane user id).
pub fn valid_member_id(member: &str) -> bool {
    !member.is_empty()
        && member.len() <= MAX_MEMBER_ID_LEN
        && member
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// Normalize an `onBehalfOf` value: `<id>` or `user:<id>`.
pub fn parse_member(raw: &str) -> Result<String, VaultError> {
    let raw = raw.trim();
    let member = raw.strip_prefix("user:").unwrap_or(raw);
    if valid_member_id(member) {
        Ok(member.to_owned())
    } else {
        Err(VaultError::Invalid(
            "onBehalfOf must name a member's user id".to_owned(),
        ))
    }
}

/// Policy subjects of a verified principal.
fn subjects_of(
    caller: &crate::identity_verify::VerifiedCaller,
    policy_team_ids: Option<Vec<String>>,
) -> Result<Vec<String>, VaultError> {
    // Without the complete team list a `team:` deny could be missed.
    let teams = policy_team_ids
        .ok_or_else(|| VaultError::Denied("the member's teams could not be verified".to_owned()))?;
    let mut subjects = vec![
        format!("user:{}", caller.user_id),
        format!("role:{}", caller.role.label()),
    ];
    subjects.extend(teams.into_iter().map(|team| format!("team:{team}")));
    Ok(subjects)
}

#[cfg(test)]
static TEST_MEMBERS: std::sync::Mutex<Option<std::collections::HashMap<String, Vec<String>>>> =
    std::sync::Mutex::new(None);

/// Test hook: verified subjects for `member` without a control plane.
#[cfg(test)]
pub(crate) fn set_test_member(member: &str, subjects: &[&str]) {
    let mut members = TEST_MEMBERS.lock().unwrap();
    members.get_or_insert_with(Default::default).insert(
        member.to_owned(),
        subjects
            .iter()
            .map(|subject| (*subject).to_owned())
            .collect(),
    );
}

/// The member's current, control-plane-verified policy subjects. Fails
/// closed: an unbound node has no members, and an unreachable control plane,
/// a non-member, or an incomplete team list refuses the delegation.
pub async fn verify_member(member: &str) -> Result<Member, VaultError> {
    let member = parse_member(member)?;
    #[cfg(test)]
    if let Some(subjects) = TEST_MEMBERS
        .lock()
        .ok()
        .and_then(|members| members.as_ref()?.get(&member).cloned())
    {
        return Ok(Member {
            user_id: member,
            subjects,
        });
    }
    if crate::sidecar::control_plane::registered_node().is_none() {
        return Err(VaultError::Invalid(
            "onBehalfOf needs a node bound to an organization".to_owned(),
        ));
    }
    let current = crate::sidecar::control_plane::resolve_current_authorization(&member)
        .await
        .map_err(|error| {
            tracing::warn!("verifying a broker delegation member failed: {error:#}");
            VaultError::Denied(format!(
                "`{member}` is not a verified member of this organization"
            ))
        })?;
    let subjects = subjects_of(&current.caller, current.policy_team_ids)?;
    Ok(Member {
        user_id: member,
        subjects,
    })
}

#[cfg(test)]
#[path = "delegation_tests.rs"]
mod tests;
