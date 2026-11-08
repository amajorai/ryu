//! Authorization and release for a session Box credential fill (design
//! `docs/vault-env-session-parity/box-fill-verb/` 1.2 steps 4 and 8).
//!
//! [`authorize`] decides what may be filled, and where its value may go,
//! from metadata alone: the agent's account policy, the account's host and
//! login URLs, or the attached item's set, host, login URLs and opt-in. It
//! reads no value, and it never pins an attached set (that happens only after
//! the Box prepared the fill and Core checked the page). [`release`] then
//! reveals the one value, audited as an item reveal by the agent.

use anyhow::{anyhow, Result};

use crate::agent_access::AgentAccountPolicy;
use crate::agents::AgentStore;
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::agent_accounts::fill_sets::{self, AttachedItem, Registry, HANDLE_PREFIX};
use crate::vault::agent_accounts::fill_target::{account_target, box_bind_hosts, box_page_hosts};
use crate::vault::agent_accounts::{self, FillField};
use crate::vault::audit::AuditActor;
use crate::vault::VaultError;
use ryu_sandbox::box_types::SecretString;

/// Where the value of a fill comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FillSource {
    /// One of the agent's own accounts, by id.
    Own { account: String },
    /// An item of the set `set_id` the user attached.
    Attached { set_id: String, item: AttachedItem },
}

/// What a fill may do: decided before any value is read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FillGrant {
    pub source: FillSource,
    pub host: String,
    /// `[host, www.host]`, compared exactly by Core and the Box's daemon.
    pub page_hosts: Vec<String>,
    /// The page hosts and every login URL's host.
    pub bind_hosts: Vec<String>,
    pub submit_urls: Vec<String>,
    /// The user's opt-in for an attached item without a login URL.
    pub unbound: bool,
    pub field: FillField,
}

impl FillGrant {
    pub fn set_id(&self) -> Option<&str> {
        match &self.source {
            FillSource::Own { .. } => None,
            FillSource::Attached { set_id, .. } => Some(set_id),
        }
    }
}

fn denied(message: impl Into<String>) -> anyhow::Error {
    VaultError::Denied(message.into()).into()
}

/// The account policy of `agent_id` from its record: `None` without an id or
/// a record (the unassigned folder and legacy callers). A store error is an
/// error, never "no policy".
pub(crate) async fn policy_for(
    agents: &AgentStore,
    agent_id: Option<&str>,
) -> Result<Option<AgentAccountPolicy>> {
    let Some(agent_id) = agent_id else {
        return Ok(None);
    };
    let record = agents
        .get(agent_id)
        .await
        .map_err(|error| anyhow!("agent lookup unavailable: {error}"))?;
    Ok(record.map(|record| AgentAccountPolicy::from_record(&record)))
}

/// Why `policy` may not use its own account `account`, if it may not.
pub(crate) fn own_account_refusal(
    policy: Option<&AgentAccountPolicy>,
    account: &str,
) -> Option<&'static str> {
    let policy = policy?;
    if !policy.allows_own_accounts() {
        return Some(
            "this agent acts as you and has no accounts of its own; change its identity in the agent's settings",
        );
    }
    (!policy.allows_agent_account(account)).then_some(
        "this agent is not allowed to use that account; allow it in the agent's account access",
    )
}

/// Decide whether `agent_id` may fill `field` of `account` in Box `box_id`,
/// and where the value may go. Reads metadata only; pins nothing.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn authorize(
    store: &PluginSecretStore,
    registry: &Registry,
    policy: Option<&AgentAccountPolicy>,
    agent_id: Option<&str>,
    box_id: &str,
    account: &str,
    field: FillField,
    now: i64,
) -> Result<FillGrant> {
    let (source, host, submit_urls, unbound) = if account.starts_with(HANDLE_PREFIX) {
        let Some(agent_id) = agent_id else {
            return Err(denied(
                "attached items fill only for an agent; ask the user to start a single-agent session Box",
            ));
        };
        if policy.is_some_and(|policy| !policy.allows_user_accounts()) {
            return Err(denied("this agent may not use your accounts"));
        }
        let (set_id, item) = registry.peek_box(agent_id, box_id, account, now)?;
        if field == FillField::Username {
            // A Box username needs a field named like one (no first-text
            // fallback); read from metadata, before anything is pinned.
            let view = store.item_get(&item.coords()?, true).await?;
            if view.id != item.item_id || fill_sets::field_for_box(&view, field).is_none() {
                return Err(denied(format!(
                    "attached item `{account}` has no field named username, user, login or user_name",
                )));
            }
        }
        if item.submit_urls.is_empty() && !item.box_unbound {
            return Err(denied(format!(
                "attached item `{account}` has no login URL; ask the user to add one, or to allow a Box fill without one",
            )));
        }
        let (host, urls, unbound) = (
            item.host.clone(),
            item.submit_urls.clone(),
            item.submit_urls.is_empty(),
        );
        (FillSource::Attached { set_id, item }, host, urls, unbound)
    } else {
        if let Some(refusal) = own_account_refusal(policy, account) {
            return Err(denied(refusal));
        }
        let target = account_target(store, agent_id, account).await?;
        if target.submit_urls.is_empty() {
            return Err(denied(format!(
                "account `{account}` has no login URL; save the site's login URL on the account first",
            )));
        }
        let own = FillSource::Own {
            account: account.to_owned(),
        };
        (own, target.host, target.submit_urls, false)
    };
    let page_hosts = box_page_hosts(&host)
        .ok_or_else(|| denied(format!("{host} cannot be filled in a session Box")))?;
    let bind_hosts = box_bind_hosts(&page_hosts, &submit_urls);
    Ok(FillGrant {
        source,
        host,
        page_hosts,
        bind_hosts,
        submit_urls,
        unbound,
        field,
    })
}

/// Reveal the granted value for the page Core checked. Audited as an item
/// reveal by the agent; a `totp` fill yields the current code only.
pub(crate) async fn release(
    store: &PluginSecretStore,
    grant: &FillGrant,
    agent_id: Option<&str>,
    page_url: &str,
) -> Result<SecretString> {
    let actor = AuditActor::new("agent", agent_id);
    let value = match &grant.source {
        FillSource::Own { account } => {
            agent_accounts::release_for_fill(
                store,
                agent_id,
                account,
                grant.field,
                page_url,
                &actor,
            )
            .await?
        }
        FillSource::Attached { item, .. } => {
            fill_sets::release_box(
                store,
                item,
                grant.field,
                page_url,
                &grant.page_hosts,
                &actor,
            )
            .await?
        }
    };
    Ok(SecretString::new(value))
}

#[cfg(test)]
#[path = "box_fill_tests.rs"]
mod tests;
