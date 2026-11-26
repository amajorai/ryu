//! The stored shape of custom account pools and the rules for changing it.
//! Pools and assignments hold ids only; no credential is ever part of them.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::modes::Backup;

pub(crate) const MAX_POOLS: usize = 50;
pub(crate) const MAX_POOL_ACCOUNTS: usize = 200;
pub(crate) const MAX_NAME_CHARS: usize = 64;
pub(super) const MAX_ASSIGNMENTS: usize = 2000;
const MAX_ID_BYTES: usize = 128;

/// One saved account, named by the provider that lists it and its vault id.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PoolAccount {
    pub provider_id: String,
    pub account_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pool {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub accounts: Vec<PoolAccount>,
}

/// Every pool and which pool each agent is limited to.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    #[serde(default)]
    pub pools: Vec<Pool>,
    /// Agent id to pool id. An agent that is absent has no pool.
    #[serde(default)]
    pub agents: BTreeMap<String, String>,
    /// Agents on Auto: every saved account of a provider is a candidate, tried
    /// one after another. An agent is on Auto or on one pool, never both.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub auto: BTreeSet<String>,
    /// Agent id to its backup models, tried in this order when no account
    /// can serve the model a request names.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub backups: BTreeMap<String, Vec<Backup>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PoolError {
    NotFound,
    LimitReached,
    Invalid(&'static str),
}

pub(super) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID_BYTES && !id.chars().any(char::is_control)
}

fn clean_name(name: &str) -> Result<String, PoolError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(PoolError::Invalid("name must have 1 to 64 characters"));
    }
    if name.chars().any(char::is_control) {
        return Err(PoolError::Invalid("name must not hold control characters"));
    }
    Ok(name.to_owned())
}

fn clean_accounts(accounts: Vec<PoolAccount>) -> Result<Vec<PoolAccount>, PoolError> {
    if accounts
        .iter()
        .any(|account| !valid_id(&account.provider_id) || !valid_id(&account.account_id))
    {
        return Err(PoolError::Invalid("provider id or account id is invalid"));
    }
    let unique: BTreeSet<PoolAccount> = accounts.into_iter().collect();
    if unique.len() > MAX_POOL_ACCOUNTS {
        return Err(PoolError::Invalid("a pool holds at most 200 accounts"));
    }
    Ok(unique.into_iter().collect())
}

impl Catalog {
    fn name_taken(&self, name: &str, except: Option<&str>) -> bool {
        self.pools.iter().any(|pool| {
            Some(pool.id.as_str()) != except && pool.name.to_lowercase() == name.to_lowercase()
        })
    }

    /// Drop everything a hand-edited or older record could hold that the
    /// rules below would have refused, so a bad record can never widen a pool.
    pub(crate) fn sanitized(mut self) -> Self {
        self.pools.truncate(MAX_POOLS);
        self.pools.retain(|pool| valid_id(&pool.id));
        for pool in &mut self.pools {
            let accounts = std::mem::take(&mut pool.accounts);
            pool.accounts = clean_accounts(
                accounts
                    .into_iter()
                    .filter(|account| {
                        valid_id(&account.provider_id) && valid_id(&account.account_id)
                    })
                    .take(MAX_POOL_ACCOUNTS)
                    .collect(),
            )
            .unwrap_or_default();
        }
        let known: BTreeSet<&str> = self.pools.iter().map(|pool| pool.id.as_str()).collect();
        self.agents
            .retain(|agent, pool| valid_id(agent) && known.contains(pool.as_str()));
        self.sanitize_modes();
        self
    }

    pub(crate) fn create(
        &mut self,
        name: &str,
        accounts: Vec<PoolAccount>,
    ) -> Result<Pool, PoolError> {
        let name = clean_name(name)?;
        let accounts = clean_accounts(accounts)?;
        if self.pools.len() >= MAX_POOLS {
            return Err(PoolError::LimitReached);
        }
        if self.name_taken(&name, None) {
            return Err(PoolError::Invalid("a pool with this name already exists"));
        }
        let pool = Pool {
            id: uuid::Uuid::new_v4().simple().to_string(),
            name,
            accounts,
        };
        self.pools.push(pool.clone());
        Ok(pool)
    }

    /// Rename a pool, replace its accounts, or both. `None` keeps a part.
    pub(crate) fn update(
        &mut self,
        pool_id: &str,
        name: Option<&str>,
        accounts: Option<Vec<PoolAccount>>,
    ) -> Result<Pool, PoolError> {
        let name = name.map(clean_name).transpose()?;
        let accounts = accounts.map(clean_accounts).transpose()?;
        if !self.pools.iter().any(|pool| pool.id == pool_id) {
            return Err(PoolError::NotFound);
        }
        if name
            .as_deref()
            .is_some_and(|name| self.name_taken(name, Some(pool_id)))
        {
            return Err(PoolError::Invalid("a pool with this name already exists"));
        }
        let pool = self
            .pools
            .iter_mut()
            .find(|pool| pool.id == pool_id)
            .ok_or(PoolError::NotFound)?;
        if let Some(name) = name {
            pool.name = name;
        }
        if let Some(accounts) = accounts {
            pool.accounts = accounts;
        }
        Ok(pool.clone())
    }

    /// Delete a pool and clear it from every agent that had it.
    pub(crate) fn delete(&mut self, pool_id: &str) -> Result<(), PoolError> {
        let before = self.pools.len();
        self.pools.retain(|pool| pool.id != pool_id);
        if self.pools.len() == before {
            return Err(PoolError::NotFound);
        }
        self.agents.retain(|_, assigned| assigned != pool_id);
        Ok(())
    }

    /// Give an agent one pool, or none.
    pub(crate) fn assign(
        &mut self,
        agent_id: &str,
        pool_id: Option<&str>,
    ) -> Result<(), PoolError> {
        if !valid_id(agent_id) {
            return Err(PoolError::Invalid("agent id is invalid"));
        }
        let Some(pool_id) = pool_id else {
            self.agents.remove(agent_id);
            self.auto.remove(agent_id);
            return Ok(());
        };
        if !self.pools.iter().any(|pool| pool.id == pool_id) {
            return Err(PoolError::NotFound);
        }
        if !self.agents.contains_key(agent_id) && self.agents.len() >= MAX_ASSIGNMENTS {
            return Err(PoolError::LimitReached);
        }
        self.agents.insert(agent_id.to_owned(), pool_id.to_owned());
        self.auto.remove(agent_id);
        Ok(())
    }

    /// Remove one account from every pool. `same_provider` says whether a
    /// stored provider id lists the same accounts as the removed one's
    /// provider. Returns whether anything changed.
    pub(crate) fn forget_account(
        &mut self,
        account_id: &str,
        same_provider: impl Fn(&str) -> bool,
    ) -> bool {
        let mut changed = false;
        for pool in &mut self.pools {
            let before = pool.accounts.len();
            pool.accounts.retain(|account| {
                account.account_id != account_id || !same_provider(&account.provider_id)
            });
            changed |= pool.accounts.len() != before;
        }
        changed
    }

    pub(crate) fn pool_of(&self, agent_id: &str) -> Option<&Pool> {
        let pool_id = self.agents.get(agent_id)?;
        self.pools.iter().find(|pool| &pool.id == pool_id)
    }

    /// The account ids an agent's pool holds for one provider. `None` when
    /// the agent has no pool or its pool holds no account of that provider.
    pub(crate) fn accounts_of(
        &self,
        agent_id: &str,
        same_provider: impl Fn(&str) -> bool,
    ) -> Option<BTreeSet<String>> {
        let members: BTreeSet<String> = self
            .pool_of(agent_id)?
            .accounts
            .iter()
            .filter(|account| same_provider(&account.provider_id))
            .map(|account| account.account_id.clone())
            .collect();
        (!members.is_empty()).then_some(members)
    }
}
