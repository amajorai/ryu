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
        let name = identity_name(kind);
        if let Ok(identity) = self.machine_get(&name).await {
            return Ok(identity);
        }
        let created = self
            .machine_create_as(
                &name,
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
            Err(error) => self.machine_get(&name).await.map_err(|_| error),
        }
    }

    /// Bind one run of runtime `kind` to its identity, issuing the run's
    /// internal token (living `ttl_secs`) when policies are bound.
    pub async fn agent_binding(&self, kind: &str, ttl_secs: i64) -> Result<AgentBinding> {
        let identity = self.agent_identity(kind).await?;
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
        let mut new = super::tokens::identity_token(&identity, names.clone(), None, now);
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
            .details(json!({ "tokenAccessor": token.accessor, "runtime": kind })),
        ) {
            super::tokens::withhold_token_locked(&conn, &token.accessor)?;
            return Err(VaultError::AuditUnavailable.into());
        }
        let policies = super::policy::list_policies(&conn)?
            .into_iter()
            .filter(|policy| names.contains(&policy.name))
            .collect();
        Ok(AgentBinding::Bound(BoundAgent {
            identity_id: identity.id,
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
}
