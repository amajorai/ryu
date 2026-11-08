//! The JSON file that holds each agent's egress allowlist.
//!
//! A missing file is an empty store. A file that cannot be read or parsed is an
//! error on every read and write until it is fixed: an unreadable policy must
//! never read as "no allowlist", which would leave the agent unrestricted.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::Context;
use serde::{Deserialize, Serialize};

use super::{normalize_patterns, validate_agent_id};

/// The file's shape.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    #[serde(default)]
    agents: BTreeMap<String, Vec<String>>,
}

/// Per-agent egress allowlists, cached after the first successful read.
pub struct AllowlistStore {
    path: PathBuf,
    cache: Mutex<Option<BTreeMap<String, Vec<String>>>>,
}

impl AllowlistStore {
    /// A store backed by the file at `path`.
    pub fn at(path: PathBuf) -> Self {
        Self {
            path,
            cache: Mutex::new(None),
        }
    }

    fn load(path: &Path) -> anyhow::Result<BTreeMap<String, Vec<String>>> {
        let raw = match std::fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(BTreeMap::new())
            }
            Err(error) => return Err(error).context("reading the agent egress allowlists"),
        };
        let document: Document =
            serde_json::from_str(&raw).context("parsing the agent egress allowlists")?;
        // Re-check what is on disk: a hand-edited entry that the API would have
        // refused fails closed instead of reaching an app.
        for (agent_id, patterns) in &document.agents {
            validate_agent_id(agent_id)?;
            if normalize_patterns(patterns)? != *patterns {
                anyhow::bail!("an agent egress allowlist on disk is not normalized");
            }
        }
        Ok(document.agents)
    }

    fn with_loaded<R>(
        &self,
        f: impl FnOnce(&mut BTreeMap<String, Vec<String>>) -> anyhow::Result<R>,
    ) -> anyhow::Result<R> {
        let mut cache = self.cache.lock().unwrap_or_else(|error| error.into_inner());
        if cache.is_none() {
            *cache = Some(Self::load(&self.path)?);
        }
        let loaded = cache.as_mut().expect("loaded above");
        f(loaded)
    }

    /// The agent's allowlist, or `None` when it has none.
    pub fn get(&self, agent_id: &str) -> anyhow::Result<Option<Vec<String>>> {
        self.with_loaded(|agents| Ok(agents.get(agent_id).cloned()))
    }

    /// Replace the agent's allowlist (`Some`, normalized here) or remove it
    /// (`None`). Returns the stored list. The file is replaced atomically and
    /// the cache changes only after the write succeeded.
    pub fn set(
        &self,
        agent_id: &str,
        patterns: Option<&[String]>,
    ) -> anyhow::Result<Option<Vec<String>>> {
        validate_agent_id(agent_id)?;
        let normalized = patterns.map(|list| normalize_patterns(list)).transpose()?;
        let path = self.path.clone();
        self.with_loaded(|agents| {
            let mut next = agents.clone();
            match &normalized {
                Some(list) => {
                    next.insert(agent_id.to_owned(), list.clone());
                }
                None => {
                    next.remove(agent_id);
                }
            }
            let document = Document { agents: next };
            let mut bytes = serde_json::to_vec_pretty(&document)?;
            bytes.push(b'\n');
            crate::atomic_file::write_atomic(&path, &bytes)
                .context("writing the agent egress allowlists")?;
            *agents = document.agents;
            Ok(normalized.clone())
        })
    }
}
