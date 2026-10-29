//! Routing settings, quota cooldowns and run records. Nothing here is a credential: the
//! provider CLIs keep their own sign-in, and run records hold only ids, links, statuses
//! and scrubbed text.

use super::accounts::{self, PlanAccount, ProviderId};
use super::{routing, CloudTaskBackend};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

/// How long a backend is skipped after the user's plan reports a usage or rate limit.
/// Neither CLI exposes a machine-readable reset time.
pub(crate) const QUOTA_COOLDOWN_SECONDS: u64 = 60 * 60;

/// A Ryu environment's handles on the provider side.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EnvironmentLink {
    /// Absolute path of a local git checkout on this node. `claude --cloud` runs there
    /// and the cloud session clones its GitHub remote at its current branch. Runs on this
    /// node (`claude -p`, `codex exec`) work in a worktree of it. The wire name predates
    /// the local Codex run and is kept for compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) claude_checkout: Option<String>,
    /// The Codex cloud environment id that `codex cloud exec --env` targets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) codex_environment_id: Option<String>,
}

/// The node owner's routing choices.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RoutingSettings {
    /// Off until the owner turns it on: no task uses a subscription backend before.
    #[serde(default)]
    pub(crate) enabled: bool,
    /// Tried in order for every agent without an override. The Ryu Box is always the
    /// last fallback, listed or not.
    #[serde(default = "default_order")]
    pub(crate) default_order: Vec<CloudTaskBackend>,
    /// Per-agent order, keyed by the agent id the client sends.
    #[serde(default)]
    pub(crate) agent_overrides: BTreeMap<String, Vec<CloudTaskBackend>>,
    /// Per-environment provider handles, keyed by Ryu environment id.
    #[serde(default)]
    pub(crate) environments: BTreeMap<String, EnvironmentLink>,
    /// The account each provider's tasks use unless the session or agent picks one.
    /// Absent means the CLI's own default sign-in.
    #[serde(default)]
    pub(crate) default_accounts: BTreeMap<ProviderId, String>,
    /// Per-agent account, keyed by agent id, then provider.
    #[serde(default)]
    pub(crate) agent_accounts: BTreeMap<String, BTreeMap<ProviderId, String>>,
    /// Accounts to try, in this order, after the chosen account reports a usage or rate
    /// limit. Empty (the default) means no other account is tried: the task goes on to
    /// the next backend or the Ryu Box. Ryu never picks these by itself (§0b).
    #[serde(default)]
    pub(crate) account_fallbacks: BTreeMap<ProviderId, Vec<String>>,
}

fn default_order() -> Vec<CloudTaskBackend> {
    routing::DEFAULT_ORDER.to_vec()
}

impl Default for RoutingSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            default_order: default_order(),
            agent_overrides: BTreeMap::new(),
            environments: BTreeMap::new(),
            default_accounts: BTreeMap::new(),
            agent_accounts: BTreeMap::new(),
            account_fallbacks: BTreeMap::new(),
        }
    }
}

/// One cloud task started on a user's plan.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunRecord {
    pub(crate) conversation_id: String,
    pub(crate) owner: String,
    pub(crate) backend: CloudTaskBackend,
    pub(crate) environment_id: String,
    pub(crate) executor: String,
    /// The linked account that started the run. Status, follow-ups, the diff and Stop
    /// always use it; a run never moves to another account. Absent (older records)
    /// means the CLI's default sign-in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) account_id: Option<String>,
    /// The provider's id (`session_…` for Claude, `task_…` for Codex), when printed.
    pub(crate) external_id: Option<String>,
    /// Where the user reviews the run (claude.ai/code or chatgpt.com/codex).
    pub(crate) url: Option<String>,
    /// `submitted` until the provider reports more (Codex only).
    pub(crate) status: String,
    /// Codex's summary, scrubbed.
    pub(crate) summary: Option<String>,
    /// The last failure, scrubbed.
    pub(crate) last_error: Option<String>,
    /// The run's own words so far (assistant text and tool names), scrubbed and cut to
    /// the last 8 KiB. Runs on this node only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) output_tail: Option<String>,
    /// The worktree a run on this node works in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) workspace: Option<String>,
    /// The worktree's branch in the owner's checkout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) branch: Option<String>,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
    /// The finished run's result was posted into its conversation.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) result_posted: bool,
}

impl RunRecord {
    /// The account that owns this run.
    pub(crate) fn account(&self) -> &str {
        self.account_id
            .as_deref()
            .unwrap_or(accounts::DEFAULT_ACCOUNT)
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    #[serde(default)]
    settings: BTreeMap<String, RoutingSettings>,
    /// Keyed by [`accounts::account_key`]: one cooldown per linked account. Older files
    /// keyed by backend still load; those keys simply never match again.
    #[serde(default)]
    cooldowns: BTreeMap<String, u64>,
    #[serde(default)]
    runs: BTreeMap<String, RunRecord>,
    /// Linked accounts per owner.
    #[serde(default)]
    accounts: BTreeMap<String, Vec<PlanAccount>>,
}

struct Store {
    state: Mutex<Option<State>>,
    /// The saved file exists but could not be read. Ryu then fails closed: it never
    /// overwrites the file, and every conversation is treated as fenced from Ryu Boxes,
    /// so a plan conversation can never lose its fence and pick up a Box charge.
    unreadable: Mutex<bool>,
    /// Off in tests, so they never touch the data dir.
    persist: Mutex<bool>,
}

static STORE: LazyLock<Store> = LazyLock::new(|| Store {
    state: Mutex::new(None),
    unreadable: Mutex::new(false),
    persist: Mutex::new(true),
});

#[cfg(test)]
static TEST_PATH: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

fn path() -> std::path::PathBuf {
    #[cfg(test)]
    if let Some(path) = TEST_PATH
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
    {
        return path;
    }
    crate::paths::state_path("subscription-cloud.json")
}

fn lock() -> MutexGuard<'static, Option<State>> {
    STORE
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn persisting() -> bool {
    *STORE
        .persist
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn with_state<T>(mutate: bool, apply: impl FnOnce(&mut State) -> T) -> T {
    let mut guard = lock();
    let state = guard.get_or_insert_with(|| {
        if !persisting() {
            return State::default();
        }
        match std::fs::read(path()) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|_| {
                tracing::warn!(
                    "Subscription cloud state is unreadable; plans are off and Ryu Boxes are refused until it is repaired"
                );
                set_unreadable(true);
                State::default()
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => State::default(),
            Err(_) => {
                tracing::warn!(
                    "Subscription cloud state could not be read; plans are off and Ryu Boxes are refused until it is readable"
                );
                set_unreadable(true);
                State::default()
            }
        }
    });
    let result = apply(state);
    if mutate && persisting() && !unreadable() {
        if let Err(error) = write(state) {
            tracing::warn!(error = %error, "Subscription cloud state could not be saved");
        }
    }
    result
}

fn set_unreadable(value: bool) {
    *STORE
        .unreadable
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = value;
}

fn unreadable() -> bool {
    *STORE
        .unreadable
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn write(state: &State) -> std::io::Result<()> {
    let path = path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(state)?)?;
    std::fs::rename(temporary, path)
}

pub(crate) fn settings(owner: &str) -> RoutingSettings {
    let settings = with_state(false, |state| {
        state.settings.get(owner).cloned().unwrap_or_default()
    });
    if unreadable() {
        // Plans stay off while the saved state cannot be trusted.
        return RoutingSettings::default();
    }
    settings
}

pub(crate) fn save_settings(owner: &str, settings: RoutingSettings) {
    with_state(true, |state| {
        state.settings.insert(owner.to_owned(), settings);
    });
}

/// Seconds left on an account's quota cooldown at `now`, if any.
pub(crate) fn cooldown_remaining(account_key: &str, now: u64) -> Option<u64> {
    with_state(false, |state| {
        state
            .cooldowns
            .get(account_key)
            .and_then(|until| until.checked_sub(now))
            .filter(|left| *left > 0)
    })
}

/// Skip this account for the cooldown, on every backend it runs on: the limit is the
/// account's plan, not one backend's.
pub(crate) fn start_cooldown(account_key: &str, now: u64) {
    with_state(true, |state| {
        state
            .cooldowns
            .insert(account_key.to_owned(), now + QUOTA_COOLDOWN_SECONDS);
    });
}

pub(crate) fn clear_cooldown(account_key: &str) {
    with_state(true, |state| {
        state.cooldowns.remove(account_key);
    });
}

pub(crate) fn accounts(owner: &str) -> Vec<PlanAccount> {
    with_state(false, |state| {
        state.accounts.get(owner).cloned().unwrap_or_default()
    })
}

pub(crate) fn account(owner: &str, provider: ProviderId, id: &str) -> Option<PlanAccount> {
    accounts(owner)
        .into_iter()
        .find(|account| account.provider == provider && account.id == id)
}

/// Add a linked account. `Err` when the owner already has the most accounts allowed
/// for that provider.
pub(crate) fn add_account(owner: &str, account: PlanAccount) -> Result<(), ()> {
    with_state(true, |state| {
        let list = state.accounts.entry(owner.to_owned()).or_default();
        let same = list
            .iter()
            .filter(|other| other.provider == account.provider)
            .count();
        if same >= accounts::MAX_ACCOUNTS_PER_PROVIDER {
            return Err(());
        }
        list.push(account);
        Ok(())
    })
}

/// Forget a linked account, and every routing choice that named it.
pub(crate) fn remove_account(owner: &str, provider: ProviderId, id: &str) {
    with_state(true, |state| {
        if let Some(list) = state.accounts.get_mut(owner) {
            list.retain(|account| !(account.provider == provider && account.id == id));
        }
        if let Some(settings) = state.settings.get_mut(owner) {
            if settings.default_accounts.get(&provider).map(String::as_str) == Some(id) {
                settings.default_accounts.remove(&provider);
            }
            for choice in settings.agent_accounts.values_mut() {
                if choice.get(&provider).map(String::as_str) == Some(id) {
                    choice.remove(&provider);
                }
            }
            if let Some(order) = settings.account_fallbacks.get_mut(&provider) {
                order.retain(|other| other != id);
            }
        }
        state
            .cooldowns
            .remove(&accounts::account_key(provider.provider(), id));
    });
}

/// The owner's runs, newest first.
pub(crate) fn runs_for(owner: &str) -> Vec<RunRecord> {
    let mut runs: Vec<RunRecord> = with_state(false, |state| {
        state
            .runs
            .values()
            .filter(|record| record.owner == owner)
            .cloned()
            .collect()
    });
    runs.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    runs
}

pub(crate) fn run(conversation_id: &str) -> Option<RunRecord> {
    with_state(false, |state| state.runs.get(conversation_id).cloned())
}

pub(crate) fn save_run(record: RunRecord) {
    with_state(true, |state| {
        state.runs.insert(record.conversation_id.clone(), record);
    });
}

/// Whether a conversation ever ran on a user's plan. Such a conversation never gets a
/// Ryu Box (docs/subscription-cloud-sessions.md §4).
pub(crate) fn is_subscription_conversation(conversation_id: &str) -> bool {
    let known = with_state(false, |state| state.runs.contains_key(conversation_id));
    known || unreadable()
}

pub(crate) fn forget_conversation(conversation_id: &str) {
    super::local_run::stop(conversation_id);
    with_state(true, |state| {
        state.runs.remove(conversation_id);
    });
}

#[cfg(test)]
/// Persist to `file` (a temp path) and load it fresh on the next access.
pub(crate) fn load_for_test(file: &std::path::Path, bytes: &[u8]) {
    std::fs::write(file, bytes).expect("write test state");
    *TEST_PATH
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(file.to_path_buf());
    set_unreadable(false);
    *STORE
        .persist
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
    *lock() = None;
}

#[cfg(test)]
pub(crate) fn reset_for_test() {
    set_unreadable(false);
    *TEST_PATH
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    *STORE
        .persist
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = false;
    *lock() = Some(State::default());
}
