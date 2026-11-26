//! Auto and backups: the two per-agent settings next to a custom pool.
//!
//! - An agent is on Auto, on one pool, or on neither ("none", the behaviour
//!   from before pools existed). On Auto every saved account of a provider is
//!   a candidate and [`super::auto`] tries them one after another.
//! - Backups are an ordered list of models, each on a provider, that an agent
//!   falls back to when no account can serve the model a request names. They
//!   belong to the agent, not to a pool: several agents share a pool and can
//!   run different models, and an agent on Auto has no pool at all.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::model::{valid_id, Catalog, PoolError, MAX_ASSIGNMENTS};

pub(crate) const MAX_BACKUPS: usize = 8;
const MAX_MODEL_CHARS: usize = 200;

/// One backup model of an agent.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Backup {
    pub provider_id: String,
    pub model: String,
}

/// Which accounts an agent's provider requests may use.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Every account the provider's own policy allows, chosen as before.
    None,
    /// Every saved account of the provider, tried one after another.
    Auto,
    /// Only the accounts of the agent's custom pool.
    Pool,
}

fn clean_model(model: &str) -> Option<String> {
    let model = model.trim();
    (!model.is_empty()
        && model.chars().count() <= MAX_MODEL_CHARS
        && !model.chars().any(char::is_control))
    .then(|| model.to_owned())
}

/// Keep valid entries in their order, without repeats.
fn valid_backups(backups: Vec<Backup>) -> Vec<Backup> {
    let mut seen = BTreeSet::new();
    backups
        .into_iter()
        .filter_map(|backup| {
            let model = clean_model(&backup.model)?;
            valid_id(&backup.provider_id).then_some(Backup {
                provider_id: backup.provider_id,
                model,
            })
        })
        .filter(|backup| seen.insert((backup.provider_id.clone(), backup.model.clone())))
        .collect()
}

impl Catalog {
    /// What a hand-edited or older record may hold that [`Catalog::set_mode`]
    /// and [`Catalog::set_backups`] would refuse is dropped. A pool assignment
    /// wins over Auto, because it is the narrower of the two.
    pub(super) fn sanitize_modes(&mut self) {
        let agents = &self.agents;
        self.auto
            .retain(|agent| valid_id(agent) && !agents.contains_key(agent));
        while self.auto.len() > MAX_ASSIGNMENTS {
            self.auto.pop_last();
        }
        let backups = std::mem::take(&mut self.backups);
        self.backups = backups
            .into_iter()
            .filter(|(agent, _)| valid_id(agent))
            .map(|(agent, list)| {
                let mut list = valid_backups(list);
                list.truncate(MAX_BACKUPS);
                (agent, list)
            })
            .filter(|(_, list)| !list.is_empty())
            .take(MAX_ASSIGNMENTS)
            .collect();
    }

    pub(crate) fn mode_of(&self, agent_id: &str) -> Mode {
        if self.pool_of(agent_id).is_some() {
            Mode::Pool
        } else if self.auto.contains(agent_id) {
            Mode::Auto
        } else {
            Mode::None
        }
    }

    /// Put an agent on Auto, on a pool (`pool_id` is then required) or on
    /// neither.
    pub(crate) fn set_mode(
        &mut self,
        agent_id: &str,
        mode: Mode,
        pool_id: Option<&str>,
    ) -> Result<(), PoolError> {
        match mode {
            Mode::None => self.assign(agent_id, None),
            Mode::Pool => match pool_id {
                Some(pool_id) => self.assign(agent_id, Some(pool_id)),
                None => Err(PoolError::Invalid("poolId is required for a pool")),
            },
            Mode::Auto => {
                if !valid_id(agent_id) {
                    return Err(PoolError::Invalid("agent id is invalid"));
                }
                if !self.auto.contains(agent_id) && self.auto.len() >= MAX_ASSIGNMENTS {
                    return Err(PoolError::LimitReached);
                }
                self.agents.remove(agent_id);
                self.auto.insert(agent_id.to_owned());
                Ok(())
            }
        }
    }

    /// Replace an agent's backup models. An empty list removes them.
    pub(crate) fn set_backups(
        &mut self,
        agent_id: &str,
        backups: Vec<Backup>,
    ) -> Result<(), PoolError> {
        if !valid_id(agent_id) {
            return Err(PoolError::Invalid("agent id is invalid"));
        }
        if backups.len() > MAX_BACKUPS {
            return Err(PoolError::Invalid("an agent has at most 8 backup models"));
        }
        let count = backups.len();
        let backups = valid_backups(backups);
        if backups.len() != count {
            return Err(PoolError::Invalid(
                "a backup needs a provider id and a model of 1 to 200 characters, each once",
            ));
        }
        if backups.is_empty() {
            self.backups.remove(agent_id);
            return Ok(());
        }
        if !self.backups.contains_key(agent_id) && self.backups.len() >= MAX_ASSIGNMENTS {
            return Err(PoolError::LimitReached);
        }
        self.backups.insert(agent_id.to_owned(), backups);
        Ok(())
    }

    pub(crate) fn backups_of(&self, agent_id: &str) -> &[Backup] {
        self.backups.get(agent_id).map_or(&[], Vec::as_slice)
    }

    /// Drop everything stored for a deleted agent. Returns whether anything
    /// changed.
    pub(crate) fn forget_agent(&mut self, agent_id: &str) -> bool {
        let pool = self.agents.remove(agent_id).is_some();
        let auto = self.auto.remove(agent_id);
        let backups = self.backups.remove(agent_id).is_some();
        pool || auto || backups
    }
}
