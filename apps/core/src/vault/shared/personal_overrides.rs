//! Personal overrides: whether a user's own value for a name wins over the
//! shared (project, team or organization) value for the same name.
//!
//! Resolution walks [`SecretScope::precedence`], which puts the user scope
//! first (`user > node > project > team > org`). That is the default, "on".
//! A user can switch it off for themselves: their personal values then move
//! to the end of the walk, so they only fill names that no node, project,
//! team or organization value defines. The setting is per user and per node.
//!
//! The setting is stored in the encrypted plugin-secret table under the
//! reserved owner [`OWNER`] (it contains `:`, so no plugin id can collide),
//! keyed by the user id. Only "off" is stored; no row means on, so a node
//! that never touched the setting keeps today's precedence.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::Result;

use crate::plugin_secrets::{
    PluginSecretStore, SecretCoords, SecretResolutionContext, SecretScope,
};

/// Reserved plugin-secret owner the per-user setting is stored under.
pub const OWNER: &str = "vault:personal-overrides";

const OFF: &str = "off";

/// Whether `user_id`'s personal values override shared ones (default on).
/// A row that cannot be read counts as on, the precedence before the setting
/// existed.
pub async fn enabled(store: &PluginSecretStore, user_id: &str) -> bool {
    !matches!(store.get(OWNER, user_id).await, Ok(Some(value)) if value == OFF)
}

/// [`enabled`] for a resolution context. A context without a user has no
/// personal values to move, so it is always on.
pub async fn enabled_for(store: &PluginSecretStore, context: &SecretResolutionContext) -> bool {
    match context.user_id.as_deref() {
        Some(user_id) => enabled(store, user_id).await,
        None => true,
    }
}

/// Switch `user_id`'s personal overrides on or off.
pub async fn set(store: &PluginSecretStore, user_id: &str, on: bool) -> Result<()> {
    if on {
        store.delete(OWNER, user_id).await
    } else {
        store.set(OWNER, user_id, OFF).await
    }
}

/// Candidate scopes in resolution order. On keeps them as they are. Off
/// moves the user scope after every other scope, keeping the rest in order.
pub fn ordered(scopes: Vec<(SecretScope, String)>, on: bool) -> Vec<(SecretScope, String)> {
    if on {
        return scopes;
    }
    let (personal, rest): (Vec<_>, Vec<_>) = scopes
        .into_iter()
        .partition(|(scope, _)| *scope == SecretScope::User);
    rest.into_iter().chain(personal).collect()
}

/// The scopes `context` resolves through, in the order its user's setting
/// gives.
pub async fn resolution_order(
    store: &PluginSecretStore,
    context: &SecretResolutionContext,
) -> Vec<(SecretScope, String)> {
    let on = enabled_for(store, context).await;
    ordered(PluginSecretStore::candidate_scopes(context), on)
}

/// Merge this node's effective values over the control plane's shared values
/// for an export, matching runtime precedence. A name a local sealed value
/// holds (`withheld`) drops its shared value. With personal overrides off, a
/// personal value only fills a name the shared values do not have.
pub fn overlay(
    mut values: BTreeMap<String, String>,
    local: BTreeMap<String, (SecretCoords, String)>,
    withheld: &BTreeSet<String>,
    on: bool,
) -> BTreeMap<String, String> {
    values.retain(|name, _| !withheld.contains(name));
    for (name, (coords, value)) in local {
        if !on && coords.scope == SecretScope::User && values.contains_key(&name) {
            continue;
        }
        values.insert(name, value);
    }
    values
}

#[cfg(test)]
#[path = "personal_overrides_tests.rs"]
mod tests;
