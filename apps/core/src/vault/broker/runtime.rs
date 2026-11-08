//! Broker sessions for the agent runtimes Core spawns (Pi, ACP agents,
//! Claude Code).
//!
//! When the listener is up and the active environment has enabled services,
//! each runtime start mints its own `rvb_` session over those services and
//! receives [`super::proxy_env`], so its outbound HTTPS goes through the
//! broker and credentials are injected without the agent holding them. The
//! returned [`RuntimeBrokerLease`] revokes the session when the run ends
//! (dropped with the process).
//!
//! Each runtime kind has its own machine identity (`ryu-agent-<kind>`, see
//! [`crate::vault::agent_identity`]). Until the operator binds policies to
//! it, a runtime session is minted by Core on the local node's behalf: it
//! resolves `secret:` references as an operator-minted session does, and
//! carries no minter scope, so it never uses payment cards. Each such run
//! gets its own `runtime:<kind>:<id>` subject so concurrent runs do not share
//! the per-principal session cap. Once policies are bound, the session is
//! minted by the identity instead, over only the services its policies give
//! `use` on, and resolves credentials under those policies; a disabled
//! identity leaves its runs unbrokered.
//!
//! [`decide`] keeps the default safe: a run is brokered only when doing so
//! neither breaks nor widens it, or when the operator opted in. That means a
//! trusted workspace under the `passthrough` policy. Under `deny` (the
//! default) the broker refuses every host no service covers, cutting the
//! agent and its tools off from the network they reach today, so a trusted
//! run is brokered there only when the environment opts in
//! ([`settings::EnvironmentSettings::broker_runs_under_deny`]) and its model
//! traffic goes to a loopback endpoint the proxy variables exempt (an agent
//! that signs in to its provider directly would otherwise lose its model).
//!
//! An untrusted workspace is never brokered, under any setting. Its sandbox
//! cuts the network down to the Ryu Gateway (and Core for Ryu's own engine);
//! brokering it means relaying the broker port into that cut, which hands
//! code from a folder the user has not vetted authenticated requests to
//! every service in the session, as the operator. Neither the folder nor the
//! agent kind narrows which services that would be, and the trust prompt is
//! the only consent the user gave, so the cut stays as it is. Trusting the
//! folder (or running in a Box, whose egress substitutes network secrets) is
//! the brokered path. A run is also left unbrokered when its account access
//! is limited or an upstream proxy is configured (the broker dials directly).

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::Result;
use serde_json::json;

use super::settings::UnmatchedHostPolicy;
use super::{ca, proxy_env, service_key, services, sessions, settings};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::agent_identity::{AgentBinding, BoundAgent};
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::policy::{Capability, CapabilitySet};

/// Subject prefix of runtime-minted sessions.
pub const SUBJECT_PREFIX: &str = "runtime:";

/// What Core knows about a runtime it is about to start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeLaunch {
    /// `pi`, `claude-code`, or `acp`; shown in the session label.
    pub kind: &'static str,
    /// The workspace is trusted (no network cut).
    pub trusted_workspace: bool,
    /// The agent's account access is limited.
    pub account_confined: bool,
    /// Model traffic goes to a loopback Gateway or Core proxy, which the
    /// proxy variables exempt.
    pub model_via_loopback: bool,
    /// Core or the agent's own environment names an upstream proxy.
    pub upstream_proxy: bool,
}

/// Whether to broker a run, and why not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeDecision {
    Skip(&'static str),
    Broker,
}

/// Decide whether a run is brokered, given the environment's settings and
/// how many enabled services it has.
pub fn decide(
    launch: &RuntimeLaunch,
    settings: &settings::EnvironmentSettings,
    enabled_services: usize,
) -> RuntimeDecision {
    if launch.account_confined {
        return RuntimeDecision::Skip("account_confined");
    }
    if launch.upstream_proxy {
        return RuntimeDecision::Skip("upstream_proxy");
    }
    if enabled_services == 0 {
        return RuntimeDecision::Skip("no_services");
    }
    // A sandboxed agent never gets the broker relayed into its network cut:
    // that would give it every enabled service with the operator's
    // credentials.
    if !launch.trusted_workspace {
        return RuntimeDecision::Skip("untrusted_workspace");
    }
    match settings.unmatched_host_policy {
        UnmatchedHostPolicy::Passthrough => RuntimeDecision::Broker,
        // `deny` refuses hosts no service covers, which would cut the agent
        // and everything it spawns off from the network it has today.
        UnmatchedHostPolicy::Deny if !settings.broker_runs_under_deny => {
            RuntimeDecision::Skip("deny_would_cut_trusted_network")
        }
        // Opted in, but the agent's own model traffic would be refused.
        UnmatchedHostPolicy::Deny if !launch.model_via_loopback => {
            RuntimeDecision::Skip("deny_would_cut_model_traffic")
        }
        UnmatchedHostPolicy::Deny => RuntimeDecision::Broker,
    }
}

/// A runtime's broker session. Dropping it revokes the session.
pub struct RuntimeBrokerLease {
    store: &'static PluginSecretStore,
    session_id: String,
    /// The run's internal identity token, when the runtime is bound.
    run_token: Option<String>,
    env: BTreeMap<String, String>,
}

impl std::fmt::Debug for RuntimeBrokerLease {
    // Never print `env`: the proxy URL carries the session token.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeBrokerLease")
            .field("session_id", &self.session_id)
            .finish_non_exhaustive()
    }
}

impl RuntimeBrokerLease {
    /// A lease over a session another broker caller minted (a command tool's,
    /// [`super::command_tools`]): revoked on drop, with no identity token.
    pub(super) fn for_session(store: &'static PluginSecretStore, session_id: String) -> Self {
        Self {
            store,
            session_id,
            run_token: None,
            env: BTreeMap::new(),
        }
    }

    pub(super) fn set_env(&mut self, env: BTreeMap<String, String>) {
        self.env = env;
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// The child environment ([`super::proxy_env`]) for the run.
    pub fn env(&self) -> &BTreeMap<String, String> {
        &self.env
    }
}

impl Drop for RuntimeBrokerLease {
    fn drop(&mut self) {
        let store = self.store;
        let id = std::mem::take(&mut self.session_id);
        let run_token = self.run_token.take();
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(async move {
                    let conn = store.conn.lock().await;
                    revoke_locked(store, &conn, &id, run_token.as_deref());
                });
            }
            Err(_) => match store.conn.try_lock() {
                Ok(conn) => revoke_locked(store, &conn, &id, run_token.as_deref()),
                // Expiry and maintenance end it instead.
                Err(_) => {
                    tracing::warn!(session = %id, "could not revoke a runtime broker session")
                }
            },
        }
    }
}

fn revoke_locked(
    store: &PluginSecretStore,
    conn: &rusqlite::Connection,
    id: &str,
    run_token: Option<&str>,
) {
    if let Some(accessor) = run_token {
        if let Err(error) = crate::vault::agent_identity::revoke_run_token_locked(conn, accessor) {
            tracing::warn!(session = %id, "revoking a runtime's identity token failed: {error:#}");
        }
    }
    match sessions::revoke(conn, id) {
        Ok(true) => {
            store.audit_locked(
                conn,
                &AuditEntry::new(&AuditActor::system(), "broker.session.revoke", "ok")
                    .details(json!({ "session": id, "reason": "runtime_exit" })),
            );
        }
        Ok(false) => {}
        Err(error) => {
            tracing::warn!(session = %id, "revoking a runtime broker session failed: {error:#}")
        }
    }
}

/// Mint a session for `launch` on the listener at `port`, writing the public
/// CA files into `ca_dir`. `Ok(None)` when [`decide`] skips the run.
pub async fn lease(
    store: &'static PluginSecretStore,
    port: u16,
    ca_dir: &Path,
    launch: RuntimeLaunch,
) -> Result<Option<RuntimeBrokerLease>> {
    let environment = crate::vault::active_environment();
    let (decision, names) = {
        let conn = store.conn.lock().await;
        let settings = settings::get(&conn, &environment)?;
        let names: Vec<String> = services::list(&conn, Some(&environment))?
            .into_iter()
            .filter(|service| service.input.enabled)
            .map(|service| service.input.name)
            .take(sessions::MAX_SERVICES)
            .collect();
        (decide(&launch, &settings, names.len()), names)
    };
    if let RuntimeDecision::Skip(reason) = decision {
        tracing::debug!(kind = launch.kind, reason, "runtime run not brokered");
        return Ok(None);
    }
    let binding = store
        .agent_binding(launch.kind, sessions::MAX_TTL_SECS)
        .await?;
    let (bound, names) = match binding {
        AgentBinding::Disabled => {
            tracing::debug!(
                kind = launch.kind,
                "runtime identity disabled; run not brokered"
            );
            return Ok(None);
        }
        AgentBinding::Unbound => (None, names),
        AgentBinding::Bound(bound) => {
            let permitted = permitted_services(&bound, names);
            if permitted.is_empty() {
                let conn = store.conn.lock().await;
                crate::vault::agent_identity::revoke_run_token_locked(&conn, &bound.accessor)?;
                tracing::debug!(kind = launch.kind, "runtime identity may use no service");
                return Ok(None);
            }
            (Some(bound), permitted)
        }
    };
    let request = mint_request(launch.kind, environment, names, bound.as_ref());
    let minted = {
        let conn = store.conn.lock().await;
        let minted = sessions::mint(&conn, request);
        if let (Err(_), Some(bound)) = (&minted, &bound) {
            crate::vault::agent_identity::revoke_run_token_locked(&conn, &bound.accessor)?;
        }
        minted
    };
    let (token, session) = minted?;
    // Built before anything else can fail, so an error revokes the session.
    let mut lease = RuntimeBrokerLease {
        store,
        session_id: session.id.clone(),
        run_token: bound.as_ref().map(|bound| bound.accessor.clone()),
        env: BTreeMap::new(),
    };
    store
        .audit(
            &AuditEntry::new(&AuditActor::system(), "broker.session.create", "ok").details(json!({
                "session": session.id,
                "environment": session.environment,
                "services": session.services,
                "runtime": launch.kind,
                "identity": bound.as_ref().map(|bound| bound.identity_id.clone()),
            })),
        )
        .await;
    let files = ca::write_bundle_in(ca_dir, &ca::certificate_pem(store).await?)?;
    lease.env = proxy_env(&token, port, &files);
    Ok(Some(lease))
}

/// The enabled services a bound runtime's policies give `use` on.
fn permitted_services(bound: &BoundAgent, names: Vec<String>) -> Vec<String> {
    let context = crate::vault::policy_ext::TemplateContext::from_subjects(&[bound.subject()]);
    names
        .into_iter()
        .filter(|name| {
            crate::vault::policy::evaluate_with(
                &CapabilitySet::new(),
                &bound.policies,
                &service_key(name),
                &context,
            )
            .contains(&Capability::Use)
        })
        .collect()
}

/// The session a run mints: as its runtime identity when bound (living only
/// while the run's identity token does), else under its own `runtime:`
/// subject.
fn mint_request(
    kind: &str,
    environment: String,
    services: Vec<String>,
    bound: Option<&BoundAgent>,
) -> sessions::MintRequest {
    let (minted_by, not_after, minted_token) = match bound {
        Some(bound) => (
            bound.subject(),
            Some(bound.expires_at),
            Some(bound.accessor.clone()),
        ),
        None => (
            format!("{SUBJECT_PREFIX}{kind}:{}", uuid::Uuid::new_v4().simple()),
            None,
            None,
        ),
    };
    sessions::MintRequest {
        environment,
        services,
        label: format!("{kind} run"),
        ttl_secs: Some(sessions::MAX_TTL_SECS),
        minted_by,
        not_after,
        minted_token,
        // No minter scope: an unbound runtime session never uses payment
        // cards; a bound one uses only what its identity's policies grant.
        minter_scope: None,
    }
}

/// Where runtime sessions write the public CA files: the data dir's cache,
/// which a sandboxed agent can read (unlike `state/`).
pub fn runtime_ca_dir() -> std::path::PathBuf {
    crate::paths::cache_path("vault-broker")
}

/// Mint a session for `launch` against the process-wide listener and store.
/// `None` when the listener is off, the store is unavailable, the run is
/// skipped, or minting fails (logged; the run then starts unbrokered).
pub async fn lease_for_launch(launch: RuntimeLaunch) -> Option<RuntimeBrokerLease> {
    let port = super::listening_port()?;
    let store = crate::plugin_secrets::global()?;
    match lease(store, port, &runtime_ca_dir(), launch).await {
        Ok(lease) => lease,
        Err(error) => {
            tracing::warn!(
                kind = launch.kind,
                "runtime broker session failed: {error:#}"
            );
            None
        }
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
