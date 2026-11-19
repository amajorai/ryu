//! Machine identities for the agent runtimes Core starts (roadmap P1-4).
//!
//! Every runtime kind Core launches (Ryu's Pi, Claude Code, other ACP
//! agents) has its own machine identity, `ryu-agent-<kind>`, created on the
//! kind's first brokered run with no policies. The operator governs what that
//! runtime's runs may broker by binding policies to it, like any machine:
//!
//! * no policies bound ([`AgentBinding::Unbound`]): runs keep Core's
//!   per-run `runtime:` session, so a node that never configures agents
//!   behaves exactly as before;
//! * policies bound ([`AgentBinding::Bound`]): each run's broker session is
//!   minted by the identity, under its policies and no baseline. Core issues
//!   the run an internal vault token whose value is discarded at once (only
//!   its accessor anchors the session), so revoking the identity's tokens or
//!   disabling it ends every run's brokering;
//! * the identity disabled ([`AgentBinding::Disabled`]): runs are not
//!   brokered at all.
//!
//! A run that names its agent (the ACP agent record the run was spawned
//! for) also has a per-agent identity, `ryu-agent-<kind>--<agent>-<hash>`
//! ([`agent_identity_name`]), created the same way. It narrows the kind's
//! identity for that one agent ([`PluginSecretStore::run_binding`]): bound,
//! the run authenticates as the agent's identity; unbound, the run falls back
//! to the kind's identity, so an operator who only bound the kind keeps that
//! restriction; either identity disabled leaves the run unbrokered.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde_json::json;

use super::audit::{AuditActor, AuditEntry};
use super::machine::{AuthMethod, MachineIdentity};
use super::policy::Policy;
use super::{now_millis, VaultError};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::dynamic::target_guard::RoleWriter;

/// Name prefix of agent identities.
pub const NAME_PREFIX: &str = "ryu-agent-";

/// The machine identity name of a runtime kind (`pi`, `claude-code`, `acp`).
pub fn identity_name(kind: &str) -> String {
    format!("{NAME_PREFIX}{kind}")
}

/// Longest machine identity name (`transit::is_valid_key_name`).
const MAX_NAME_LEN: usize = 64;
/// Hex digits of the agent id's SHA-256 every per-agent name ends with.
const AGENT_HASH_LEN: usize = 10;

/// The machine identity name of one agent of runtime `kind`, or `None` for
/// an empty agent id. The `--` separator never occurs in a kind name, so no
/// per-agent name equals a per-kind one. The name always ends with a hash of
/// the raw agent id, so two agents whose readable part is cut or folded to
/// the same text still get distinct identities.
pub fn agent_identity_name(kind: &str, agent: &str) -> Option<String> {
    use sha2::{Digest, Sha256};
    let agent = agent.trim();
    if agent.is_empty() {
        return None;
    }
    let hash = hex::encode(Sha256::digest(agent.as_bytes()));
    let prefix = format!("{NAME_PREFIX}{kind}--");
    let budget = MAX_NAME_LEN
        .checked_sub(prefix.len() + 1 + AGENT_HASH_LEN)
        .filter(|budget| *budget > 0)?;
    let mut slug = String::with_capacity(budget);
    for character in agent.chars().map(|c| c.to_ascii_lowercase()) {
        if slug.len() == budget {
            break;
        }
        let keep = character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_';
        let next = if keep { character } else { '-' };
        // Collapse runs of `-` so the slug stays readable.
        if next == '-' && (slug.is_empty() || slug.ends_with('-')) {
            continue;
        }
        slug.push(next);
    }
    let slug = slug.trim_end_matches('-');
    let tail = &hash[..AGENT_HASH_LEN];
    Some(if slug.is_empty() {
        format!("{prefix}{tail}")
    } else {
        format!("{prefix}{slug}-{tail}")
    })
}

/// A run bound to its runtime's identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundAgent {
    pub identity_id: String,
    /// Accessor of the run's internal token (the session's `minted_token`).
    pub accessor: String,
    pub expires_at: i64,
    /// The identity's policies now (its own plus `machine:<id>` bindings).
    pub policies: Vec<Policy>,
}

impl BoundAgent {
    /// The policy subject the run's session is minted as.
    pub fn subject(&self) -> String {
        format!("machine:{}", self.identity_id)
    }
}

/// How a runtime's next run relates to its identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentBinding {
    Unbound,
    Disabled,
    Bound(BoundAgent),
}

impl PluginSecretStore {
    /// The identity of runtime `kind`, created (AppRole, no policies) when
    /// missing.
    pub async fn agent_identity(&self, kind: &str) -> Result<MachineIdentity> {
        self.identity_named(&identity_name(kind)).await
    }

    /// The identity called `name`, created (AppRole, no policies) when
    /// missing.
    async fn identity_named(&self, name: &str) -> Result<MachineIdentity> {
        if let Ok(identity) = self.machine_get(name).await {
            return Ok(identity);
        }
        let created = self
            .machine_create_as(
                name,
                AuthMethod::AppRole {
                    role_id: String::new(),
                },
                Vec::new(),
                None,
                RoleWriter::Manager,
                &AuditActor::system(),
            )
            .await;
        match created {
            Ok(identity) => Ok(identity),
            // A concurrent first run created it.
            Err(error) => self.machine_get(name).await.map_err(|_| error),
        }
    }

    /// Bind one run of runtime `kind` to its identity, issuing the run's
    /// internal token (living `ttl_secs`) when policies are bound.
    pub async fn agent_binding(&self, kind: &str, ttl_secs: i64) -> Result<AgentBinding> {
        let identity = self.agent_identity(kind).await?;
        self.bind_identity(&identity, kind, None, ttl_secs).await
    }

    /// Bind one run of runtime `kind` for `agent`: as the agent's own
    /// identity when it has policies, else as the kind's identity. Either
    /// identity disabled means [`AgentBinding::Disabled`]. A run without an
    /// agent id binds as the kind, exactly as [`Self::agent_binding`].
    pub async fn run_binding(
        &self,
        kind: &str,
        agent: Option<&str>,
        ttl_secs: i64,
    ) -> Result<AgentBinding> {
        let Some((agent, name)) =
            agent.and_then(|agent| Some((agent, agent_identity_name(kind, agent)?)))
        else {
            return self.agent_binding(kind, ttl_secs).await;
        };
        let kind_identity = self.agent_identity(kind).await?;
        if kind_identity.disabled {
            return Ok(AgentBinding::Disabled);
        }
        let agent_identity = self.identity_named(&name).await?;
        // Unbound issues no token, so falling back leaks none.
        match self
            .bind_identity(&agent_identity, kind, Some(agent), ttl_secs)
            .await?
        {
            AgentBinding::Unbound => {
                self.bind_identity(&kind_identity, kind, Some(agent), ttl_secs)
                    .await
            }
            binding => Ok(binding),
        }
    }

    async fn bind_identity(
        &self,
        identity: &MachineIdentity,
        kind: &str,
        agent: Option<&str>,
        ttl_secs: i64,
    ) -> Result<AgentBinding> {
        if identity.disabled {
            return Ok(AgentBinding::Disabled);
        }
        let conn = self.conn.lock().await;
        let names =
            super::machine::effective_machine_policies(&conn, &identity.id, &identity.policies)?;
        if names.is_empty() {
            return Ok(AgentBinding::Unbound);
        }
        let now = now_millis();
        let mut new = super::tokens::identity_token(identity, names.clone(), None, now);
        // Never presented by anyone: no use count, network binding, period or
        // renewal, and it lives exactly as long as the run's session may.
        new.ttl_secs = ttl_secs;
        new.max_expires_at = None;
        new.period_secs = None;
        new.num_uses = None;
        new.bound_cidrs = Vec::new();
        new.renewable = false;
        let token = super::tokens::insert_token_locked(&conn, &new)?;
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(
                &AuditActor::new("machine", Some(&identity.id)),
                "agent.identity.bind",
                "ok",
            )
            .details(json!({ "tokenAccessor": token.accessor, "runtime": kind, "agent": agent })),
        ) {
            super::tokens::withhold_token_locked(&conn, &token.accessor)?;
            return Err(VaultError::AuditUnavailable.into());
        }
        let policies = super::policy::list_policies(&conn)?
            .into_iter()
            .filter(|policy| names.contains(&policy.name))
            .collect();
        Ok(AgentBinding::Bound(BoundAgent {
            identity_id: identity.id.clone(),
            accessor: token.accessor,
            expires_at: token.expires_at,
            policies,
        }))
    }
}

/// End a run's internal token (the run is over).
pub fn revoke_run_token_locked(conn: &Connection, accessor: &str) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE vault_tokens SET revoked_at = ?1 WHERE accessor = ?2 AND revoked_at IS NULL",
        params![now_millis(), accessor],
    )? > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::policy::{Capability, PolicyRule};

    async fn put_policy(store: &PluginSecretStore, name: &str) {
        let conn = store.conn.lock().await;
        crate::vault::policy::put_policy(
            &conn,
            &Policy {
                name: name.to_owned(),
                description: String::new(),
                rules: vec![PolicyRule {
                    path: "sys/broker/github".into(),
                    capabilities: vec![Capability::Use],
                    ..Default::default()
                }],
            },
        )
        .unwrap();
    }

    #[tokio::test]
    async fn each_runtime_gets_one_identity_created_on_first_use() {
        let store = PluginSecretStore::in_memory().unwrap();
        let first = store.agent_identity("claude-code").await.unwrap();
        assert_eq!(first.name, "ryu-agent-claude-code");
        assert!(first.policies.is_empty());
        assert!(!first.disabled);
        let again = store.agent_identity("claude-code").await.unwrap();
        assert_eq!(again.id, first.id);
        let pi = store.agent_identity("pi").await.unwrap();
        assert_ne!(pi.id, first.id);
        assert_eq!(store.machine_list().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn an_identity_without_policies_leaves_runs_unbound() {
        let store = PluginSecretStore::in_memory().unwrap();
        assert_eq!(
            store.agent_binding("pi", 3600).await.unwrap(),
            AgentBinding::Unbound
        );
    }

    #[tokio::test]
    async fn bound_policies_issue_a_live_run_token_until_revoked() {
        let store = PluginSecretStore::in_memory().unwrap();
        put_policy(&store, "agents").await;
        let identity = store.agent_identity("acp").await.unwrap();
        store
            .machine_update(
                &identity.id,
                Some(vec!["agents".into()]),
                None,
                None,
                &AuditActor::system(),
            )
            .await
            .unwrap();
        let AgentBinding::Bound(bound) = store.agent_binding("acp", 3600).await.unwrap() else {
            panic!("expected a bound run");
        };
        assert_eq!(bound.subject(), format!("machine:{}", identity.id));
        assert_eq!(bound.policies.len(), 1);
        assert_eq!(bound.policies[0].name, "agents");
        let conn = store.conn.lock().await;
        let principal = crate::vault::machine::principal_by_accessor_locked(&conn, &bound.accessor)
            .unwrap()
            .expect("live");
        assert_eq!(principal.policies, vec!["agents".to_owned()]);
        assert!(revoke_run_token_locked(&conn, &bound.accessor).unwrap());
        assert!(
            crate::vault::machine::principal_by_accessor_locked(&conn, &bound.accessor)
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn a_disabled_identity_is_reported_and_issues_nothing() {
        let store = PluginSecretStore::in_memory().unwrap();
        put_policy(&store, "agents").await;
        let identity = store.agent_identity("pi").await.unwrap();
        store
            .machine_update(
                &identity.id,
                Some(vec!["agents".into()]),
                None,
                Some(true),
                &AuditActor::system(),
            )
            .await
            .unwrap();
        assert_eq!(
            store.agent_binding("pi", 3600).await.unwrap(),
            AgentBinding::Disabled
        );
    }

    #[test]
    fn agent_names_are_valid_distinct_and_never_a_kind_name() {
        let valid = crate::vault::transit::is_valid_key_name;
        let named = |agent: &str| agent_identity_name("claude-code", agent).unwrap();
        let plain = named("reviewer");
        assert!(plain.starts_with("ryu-agent-claude-code--reviewer-"));
        assert!(valid(&plain));
        // Folded to the same readable text, still two identities.
        let (spaced, dashed) = (named("My Agent"), named("my-agent"));
        assert_ne!(spaced, dashed);
        assert!(valid(&spaced) && valid(&dashed));
        // Cut to fit, still distinct and within the name limit.
        let long_a = named(&"a".repeat(200));
        let long_b = named(&format!("{}b", "a".repeat(199)));
        assert_ne!(long_a, long_b);
        assert!(long_a.len() <= MAX_NAME_LEN && valid(&long_a));
        // Nothing readable left: the hash alone names it.
        let symbols = named("+++");
        assert!(valid(&symbols));
        for kind in ["pi", "claude-code", "acp"] {
            let name = agent_identity_name(kind, "pi").unwrap();
            assert_ne!(name, identity_name(kind));
            assert_ne!(name, identity_name("pi"));
        }
        assert_eq!(agent_identity_name("pi", "  "), None);
    }

    async fn set_identity(store: &PluginSecretStore, name: &str, policies: &[&str], off: bool) {
        let identity = store.identity_named(name).await.unwrap();
        store
            .machine_update(
                &identity.id,
                Some(policies.iter().map(|p| (*p).to_owned()).collect()),
                None,
                Some(off),
                &AuditActor::system(),
            )
            .await
            .unwrap();
    }

    async fn live_tokens(store: &PluginSecretStore) -> i64 {
        let conn = store.conn.lock().await;
        conn.query_row(
            "SELECT COUNT(*) FROM vault_tokens WHERE revoked_at IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn bound_id(binding: AgentBinding) -> String {
        match binding {
            AgentBinding::Bound(bound) => bound.identity_id,
            other => panic!("expected a bound run, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_bound_agent_identity_runs_as_itself() {
        let store = PluginSecretStore::in_memory().unwrap();
        put_policy(&store, "agents").await;
        let name = agent_identity_name("acp", "reviewer").unwrap();
        set_identity(&store, &name, &["agents"], false).await;
        let binding = store
            .run_binding("acp", Some("reviewer"), 3600)
            .await
            .unwrap();
        let agent = store.machine_get(&name).await.unwrap();
        assert_eq!(bound_id(binding), agent.id);
        // Another agent of the kind has no policies of its own: unbound.
        assert_eq!(
            store.run_binding("acp", Some("writer"), 3600).await.unwrap(),
            AgentBinding::Unbound
        );
        assert!(store
            .machine_get(&agent_identity_name("acp", "writer").unwrap())
            .await
            .is_ok());
        assert_eq!(live_tokens(&store).await, 1);
    }

    #[tokio::test]
    async fn an_unbound_agent_falls_back_to_its_bound_kind_without_a_spare_token() {
        let store = PluginSecretStore::in_memory().unwrap();
        put_policy(&store, "agents").await;
        set_identity(&store, &identity_name("pi"), &["agents"], false).await;
        let kind = store.agent_identity("pi").await.unwrap();
        let binding = store.run_binding("pi", Some("helper"), 3600).await.unwrap();
        assert_eq!(bound_id(binding), kind.id);
        // No agent id binds as the kind, as before.
        let binding = store.run_binding("pi", None, 3600).await.unwrap();
        assert_eq!(bound_id(binding), kind.id);
        assert_eq!(live_tokens(&store).await, 2);
    }

    #[tokio::test]
    async fn either_identity_disabled_leaves_the_run_unbrokered() {
        let store = PluginSecretStore::in_memory().unwrap();
        put_policy(&store, "agents").await;
        let agent = agent_identity_name("claude-code", "reviewer").unwrap();
        set_identity(&store, &agent, &["agents"], false).await;
        set_identity(&store, &identity_name("claude-code"), &[], true).await;
        let run = || store.run_binding("claude-code", Some("reviewer"), 3600);
        assert_eq!(run().await.unwrap(), AgentBinding::Disabled);
        set_identity(&store, &identity_name("claude-code"), &["agents"], false).await;
        set_identity(&store, &agent, &["agents"], true).await;
        assert_eq!(run().await.unwrap(), AgentBinding::Disabled);
        assert_eq!(live_tokens(&store).await, 0);
    }
}
