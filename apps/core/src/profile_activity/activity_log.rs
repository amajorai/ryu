//! Today's qualifying activity, shared with the background task.

use super::*;

// ── Today's activity log ────────────────────────────────────────────────────────

/// Distinct conversations with credited turns on one UTC day.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DaySessions {
    #[serde(default)]
    pub(super) unattributed: HashSet<String>,
    #[serde(default)]
    pub(super) by_author: HashMap<String, HashSet<String>>,
}

impl DaySessions {
    pub(super) fn insert(&mut self, author: Option<&str>, conversation_id: &str) {
        let sessions = match author {
            Some(author) => self.by_author.entry(author.to_owned()).or_default(),
            None => &mut self.unattributed,
        };
        if sessions.len() < MAX_SESSIONS_PER_DAY {
            sessions.insert(conversation_id.to_owned());
        }
    }

    /// Fold in conversations remembered before a restart, within the cap.
    pub(super) fn merge(&mut self, other: DaySessions) {
        for conversation_id in other.unattributed {
            self.insert(None, &conversation_id);
        }
        for (author, conversations) in other.by_author {
            for conversation_id in conversations {
                self.insert(Some(&author), &conversation_id);
            }
        }
    }

    /// Conversations credited to the signed-in account: unattributed ones plus
    /// those its own user id authored.
    pub(super) fn count_for(&self, user_id: Option<&str>) -> u64 {
        let own = user_id
            .and_then(|id| self.by_author.get(id))
            .map_or(0, |own| own.difference(&self.unattributed).count());
        (self.unattributed.len() + own) as u64
    }
}

/// Today's qualifying activity, shared with the background task. Reset on the
/// first turn of a new UTC day.
#[derive(Debug, Default)]
pub(super) struct ActivityLog {
    /// The latest UTC day with a qualifying turn.
    pub(super) day: Option<NaiveDate>,
    /// Monotonic turn counter; never reset, so baselines stay comparable.
    pub(super) counter: u64,
    /// `counter` at today's latest turn without a verified human author (0 = none).
    pub(super) last_unattributed_turn: u64,
    /// Verified human authors who ran a turn today.
    pub(super) authors: HashSet<String>,
    /// Conversations with a credited turn, for today and yesterday (kept for
    /// yesterday's final snapshot).
    pub(super) sessions: BTreeMap<NaiveDate, DaySessions>,
}

impl ActivityLog {
    /// Record one qualifying turn; returns whether the background task should
    /// be woken (first turn of the day, or a new author today).
    pub(super) fn record(
        &mut self,
        today: NaiveDate,
        author_user_id: Option<&str>,
        conversation_id: Option<&str>,
    ) -> bool {
        let mut wake = false;
        if self.day != Some(today) {
            prune_session_days(&mut self.sessions, today);
            self.day = Some(today);
            self.last_unattributed_turn = 0;
            self.authors.clear();
            wake = true;
        }
        self.counter += 1;
        let author = author_user_id.map(str::trim).filter(|id| !id.is_empty());
        match author {
            Some(author) => {
                if !self.authors.contains(author) {
                    self.authors.insert(author.to_owned());
                    wake = true;
                }
            }
            None => self.last_unattributed_turn = self.counter,
        }
        if let Some(conversation_id) = conversation_id.map(str::trim).filter(|id| !id.is_empty()) {
            self.sessions
                .entry(today)
                .or_default()
                .insert(author, conversation_id);
        }
        wake
    }

    /// Conversations credited to `user_id`'s account on `day`.
    pub(super) fn sessions_on(&self, day: NaiveDate, user_id: Option<&str>) -> u64 {
        self.sessions
            .get(&day)
            .map_or(0, |sessions| sessions.count_for(user_id))
    }

    /// Fold in the conversations carried over a restart.
    pub(super) fn restore_sessions(
        &mut self,
        carried: BTreeMap<NaiveDate, DaySessions>,
        today: NaiveDate,
    ) {
        for (day, sessions) in carried {
            self.sessions.entry(day).or_default().merge(sessions);
        }
        prune_session_days(&mut self.sessions, today);
    }
}

/// Keep only today's and yesterday's conversations.
pub(super) fn prune_session_days(
    sessions: &mut BTreeMap<NaiveDate, DaySessions>,
    today: NaiveDate,
) {
    let oldest = today.pred_opt().unwrap_or(today);
    sessions.retain(|day, _| *day >= oldest && *day <= today);
}

pub(super) fn activity_log() -> &'static Mutex<ActivityLog> {
    static LOG: OnceLock<Mutex<ActivityLog>> = OnceLock::new();
    LOG.get_or_init(|| Mutex::new(ActivityLog::default()))
}

pub(super) fn wake() -> &'static Notify {
    static WAKE: OnceLock<Notify> = OnceLock::new();
    WAKE.get_or_init(Notify::new)
}

/// Record that a turn was admitted with `attribution` (from
/// [`turn_attribution`]). Cheap and synchronous: no I/O, no network, and the
/// background task is woken only on the first qualifying turn of a day or a new
/// verified author. The attribution is remembered for `conversation_id` so the
/// turn's tool calls hand it to the sub-turns they start; `credit` is false for
/// a fan-out turn whose parent already recorded the activity. Whether a
/// verified author matches the signed-in account is decided by the task.
pub(crate) fn note_turn(
    attribution: &ActivityAttribution,
    conversation_id: Option<&str>,
    credit: bool,
) {
    let conversation_id = conversation_id.map(str::trim).filter(|id| !id.is_empty());
    if let Some(conversation_id) = conversation_id {
        remember_conversation(conversation_id, attribution);
    }
    if credit {
        credit_activity(attribution, conversation_id);
    }
}

/// Record activity that is not a chat turn (a live workflow run), under the
/// attribution of the turn that started it, if any.
pub(crate) fn note_activity() {
    let attribution = current_attribution().unwrap_or(ActivityAttribution::Unattributed);
    credit_activity(&attribution, None);
}

pub(super) fn credit_activity(attribution: &ActivityAttribution, conversation_id: Option<&str>) {
    let author = match attribution {
        ActivityAttribution::Excluded => return,
        ActivityAttribution::Author(author) => Some(author.as_str()),
        ActivityAttribution::Unattributed => None,
    };
    let today = utc_today();
    let Ok(mut log) = activity_log().lock() else {
        return;
    };
    if log.record(today, author, conversation_id) {
        wake().notify_one();
    }
}

/// `(active day, counter, last unattributed turn, user authored today)`.
pub(super) fn snapshot(user_id: Option<&str>) -> (Option<NaiveDate>, u64, u64, bool) {
    let Ok(log) = activity_log().lock() else {
        return (None, 0, 0, false);
    };
    let authored = user_id.is_some_and(|id| log.authors.contains(id));
    (log.day, log.counter, log.last_unattributed_turn, authored)
}

pub(super) fn sessions_on(day: NaiveDate, user_id: Option<&str>) -> u64 {
    activity_log()
        .lock()
        .map_or(0, |log| log.sessions_on(day, user_id))
}

pub(super) fn session_days() -> BTreeMap<NaiveDate, DaySessions> {
    activity_log()
        .lock()
        .map(|log| log.sessions.clone())
        .unwrap_or_default()
}

pub(super) fn restore_sessions(carried: BTreeMap<NaiveDate, DaySessions>) {
    if let Ok(mut log) = activity_log().lock() {
        log.restore_sessions(carried, utc_today());
    }
}
