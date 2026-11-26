//! What Auto remembers between requests, in memory and bounded: which
//! account is at a limit for a model until when, which account has no access
//! to a model, which account each session last used, and where the next new
//! session starts. Nothing here is a credential. A Core restart forgets it,
//! which costs one more try per account.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::{body::Body, response::Response};
use futures_util::StreamExt;

/// How long "this account has no access to this model" holds, so a later
/// plan change is picked up.
pub(crate) const NO_MODEL_TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// How long a session keeps starting at the account it last used (prompt
/// caching), as the proxies keep their session bindings.
pub(crate) const STICKY_TTL: Duration = Duration::from_secs(60 * 60);
const MAX_ENTRIES: usize = 10_000;

/// One account an agent may use for a provider.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Candidate {
    pub id: String,
    /// The provider policy's priority; lower goes first.
    pub priority: u8,
    /// The provider's active account, where "manual" starts.
    pub active: bool,
}

type AccountKey = (String, String);
type ModelKey = (String, String, String);

#[derive(Default)]
pub(crate) struct Memory {
    limited: HashMap<ModelKey, Instant>,
    no_model: HashMap<ModelKey, Instant>,
    sticky: HashMap<AccountKey, (String, Instant)>,
    cursor: HashMap<String, usize>,
    /// Requests each account is serving right now, (provider, account).
    in_flight: HashMap<AccountKey, usize>,
}

fn key(provider: &str, account: &str, model: &str) -> ModelKey {
    (provider.to_owned(), account.to_owned(), model.to_owned())
}

fn bound<K: std::hash::Hash + Eq, V>(map: &mut HashMap<K, V>, live: impl Fn(&V) -> bool) {
    if map.len() >= MAX_ENTRIES {
        map.retain(|_, value| live(value));
    }
    if map.len() >= MAX_ENTRIES {
        map.clear();
    }
}

impl Memory {
    fn usable(&self, provider: &str, account: &str, model: &str, now: Instant) -> bool {
        let key = key(provider, account, model);
        !self.limited.get(&key).is_some_and(|until| *until > now)
            && !self.no_model.get(&key).is_some_and(|until| *until > now)
    }

    fn busy(&self, provider: &str, account: &str) -> usize {
        self.in_flight
            .get(&(provider.to_owned(), account.to_owned()))
            .copied()
            .unwrap_or(0)
    }

    /// The accounts to try for `model`, in order. Accounts at a limit or
    /// without access are left out. A new session starts one account further
    /// along the first priority group than the previous new session, and in
    /// that group an account serving fewer requests right now goes first, so
    /// parallel sessions (subagents) spread over the accounts. A session
    /// starts at the account it last used (prompt caching) unless that one
    /// is busier than another account of the group. "Manual" starts at the
    /// active account instead and does not spread.
    pub(crate) fn order(
        &mut self,
        provider: &str,
        session: Option<&str>,
        model: &str,
        candidates: &[Candidate],
        manual: bool,
        now: Instant,
    ) -> Vec<String> {
        let mut usable: Vec<&Candidate> = candidates
            .iter()
            .filter(|candidate| self.usable(provider, &candidate.id, model, now))
            .collect();
        if usable.is_empty() {
            return Vec::new();
        }
        usable.sort_by(|left, right| {
            (left.priority, !(manual && left.active), &left.id).cmp(&(
                right.priority,
                !(manual && right.active),
                &right.id,
            ))
        });
        let sticky = session
            .and_then(|session| self.sticky.get(&(provider.to_owned(), session.to_owned())))
            .filter(|(_, at)| now.duration_since(*at) < STICKY_TTL)
            .map(|(account, _)| account.clone());
        let top = usable[0].priority;
        let group = usable
            .iter()
            .take_while(|candidate| candidate.priority == top)
            .count();
        if manual {
            return usable.into_iter().map(|c| c.id.clone()).collect();
        }
        if sticky.is_none() {
            let cursor = self.cursor.entry(provider.to_owned()).or_default();
            usable[..group].rotate_left(*cursor % group);
            *cursor = cursor.wrapping_add(1);
        }
        usable[..group].sort_by_key(|candidate| self.busy(provider, &candidate.id));
        let least = self.busy(provider, &usable[0].id);
        let mut order: Vec<String> = usable.into_iter().map(|c| c.id.clone()).collect();
        let sticky = sticky.filter(|id| self.busy(provider, id) <= least);
        if let Some(position) = sticky.and_then(|id| order.iter().position(|item| *item == id)) {
            let account = order.remove(position);
            order.insert(0, account);
        }
        order
    }

    /// The account served `model` for `session`.
    pub(crate) fn served(
        &mut self,
        provider: &str,
        session: Option<&str>,
        account: &str,
        model: &str,
        now: Instant,
    ) {
        let key = key(provider, account, model);
        self.limited.remove(&key);
        self.no_model.remove(&key);
        if let Some(session) = session {
            bound(&mut self.sticky, |(_, at)| {
                now.duration_since(*at) < STICKY_TTL
            });
            self.sticky.insert(
                (provider.to_owned(), session.to_owned()),
                (account.to_owned(), now),
            );
        }
    }

    /// The account is at a limit for `model` until `until`.
    pub(crate) fn limit(&mut self, provider: &str, account: &str, model: &str, until: Instant) {
        let now = Instant::now();
        bound(&mut self.limited, |at| *at > now);
        self.limited.insert(key(provider, account, model), until);
    }

    /// The account has no access to `model`; it stays usable for every other
    /// model and does not count as limited.
    pub(crate) fn refuse_model(
        &mut self,
        provider: &str,
        account: &str,
        model: &str,
        now: Instant,
    ) {
        bound(&mut self.no_model, |at| *at > now);
        self.no_model
            .insert(key(provider, account, model), now + NO_MODEL_TTL);
    }

    /// The time until the first of `candidates` is out of its limit for one
    /// of `models`. `None` when none of them is limited.
    pub(crate) fn first_reset(
        &self,
        provider: &str,
        candidates: &[Candidate],
        models: &[String],
        now: Instant,
    ) -> Option<Duration> {
        self.limited
            .iter()
            .filter(|((owner, account, model), until)| {
                owner == provider
                    && **until > now
                    && models.contains(model)
                    && candidates.iter().any(|candidate| &candidate.id == account)
            })
            .map(|(_, until)| until.duration_since(now))
            .min()
    }
}

/// One request an account is serving; counted in [`Memory::order`] until
/// dropped.
pub(crate) struct Busy {
    memory: &'static Mutex<Memory>,
    key: AccountKey,
}

impl Busy {
    pub(crate) fn start(memory: &'static Mutex<Memory>, provider: &str, account: &str) -> Self {
        let key = (provider.to_owned(), account.to_owned());
        let mut held = lock(memory);
        if held.in_flight.len() >= MAX_ENTRIES && !held.in_flight.contains_key(&key) {
            held.in_flight.retain(|_, count| *count > 0);
        }
        *held.in_flight.entry(key.clone()).or_default() += 1;
        Self { memory, key }
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        let mut held = lock(self.memory);
        if let Some(count) = held.in_flight.get_mut(&self.key) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                held.in_flight.remove(&self.key);
            }
        }
    }
}

/// Keep `busy` until the answer's body is sent or dropped, so a streamed
/// answer counts for its account as long as it runs.
pub(crate) fn hold(response: Response, busy: Busy) -> Response {
    let (parts, body) = response.into_parts();
    let stream = body.into_data_stream().map(move |chunk| {
        let _held = &busy;
        chunk
    });
    Response::from_parts(parts, Body::from_stream(stream))
}

pub(crate) fn global() -> &'static Mutex<Memory> {
    static MEMORY: OnceLock<Mutex<Memory>> = OnceLock::new();
    MEMORY.get_or_init(|| Mutex::new(Memory::default()))
}

pub(crate) fn lock(memory: &Mutex<Memory>) -> std::sync::MutexGuard<'_, Memory> {
    memory
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
