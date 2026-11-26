//! Custom account pools that an agent can be limited to.
//!
//! The owner names any number of pools, puts saved provider accounts into
//! them (one account may sit in several), and gives an agent one pool or
//! none. While an agent with a pool talks to a provider for which its pool
//! holds at least one saved account, only those accounts are candidates, in
//! the native provider proxies and in the SDK capture alike. The provider's
//! own account pool policy (strategy, enabled, priority, drain threshold)
//! keeps working inside the pool. An agent with no pool, and a provider its
//! pool holds no account of, behave as they did before pools existed.
//!
//! - [`model`] is the stored shape and its rules, [`store`] the preferences
//!   record, [`routes`] the HTTP surface.
//! - [`scope`] turns an agent's pool into a restriction on a provider's
//!   [`super::Policy`].
//! - [`engine_token`] is how a provider proxy learns which agent sent a
//!   request.
//! - [`modes`] is Auto and the backup models of an agent; [`auto`] runs a
//!   provider request of an agent on Auto or with a pool account by account,
//!   so a limited account hands over to the next one.

pub(crate) mod auto;
pub(crate) mod engine_token;
pub(crate) mod model;
pub(crate) mod modes;
pub(crate) mod routes;
pub(crate) mod scope;
pub(crate) mod store;

#[cfg(test)]
mod acceptance_tests;
#[cfg(test)]
mod modes_tests;
#[cfg(test)]
mod request_tests;
#[cfg(test)]
mod selection_tests;
#[cfg(test)]
mod tests;

/// Remove a deleted provider account from every pool. Best effort: the
/// account is already gone from the vault, and a member that is not saved
/// any more never counts (see [`scope::restrict_with`]).
pub(crate) async fn forget_account(
    preferences: &crate::server::preferences::PreferencesStore,
    provider_id: &str,
    account_id: &str,
) {
    let result = store::edit_if_changed(preferences, |catalog| {
        catalog.forget_account(account_id, |member| {
            scope::same_account_list(member, provider_id)
        })
    })
    .await;
    if result.is_err() {
        tracing::warn!("a removed account could not be cleared from the account pools");
    }
}

/// Drop a deleted agent's pool assignment, Auto and backups, so a later agent
/// that reuses the id does not inherit them. Best effort, like the rest of the
/// delete clean-up.
pub(crate) async fn forget_deleted_agent(agent_id: &str) {
    let Some(state) = crate::learning::global_state() else {
        return;
    };
    let result =
        store::edit_if_changed(&state.preferences, |catalog| catalog.forget_agent(agent_id)).await;
    if result.is_err() {
        tracing::warn!("the account pool of deleted agent '{agent_id}' was not cleared");
    }
}
