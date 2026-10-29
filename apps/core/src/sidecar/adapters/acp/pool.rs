use super::*;

/// Per-chat pool of live ACP instances: conversation id -> that chat's turn queue.
/// See [`spawn_acp_task`] for the reuse / auto-restore / idle-TTL lifecycle.
#[allow(clippy::type_complexity)]
pub(super) struct AcpPoolEntry {
    pub(super) turns: mpsc::UnboundedSender<AcpTurn>,
    pub(super) capability_session_id: Option<Uuid>,
    /// The instance's inference credential. The instance task owns the grant,
    /// so it is revoked when the instance exits; a retired instance may still
    /// finish the turn it is running.
    pub(super) inference_grant_id: Option<Uuid>,
    pub(super) activity: Arc<AcpInstanceActivity>,
}

/// What admission needs to know about a pooled instance to evict it safely.
/// Starts busy and unadmitted: an instance still waiting for a permit, or still
/// starting its subprocess, is never an eviction candidate.
pub(crate) struct AcpInstanceActivity {
    pub(super) admitted: std::sync::atomic::AtomicBool,
    pub(super) busy: std::sync::atomic::AtomicBool,
    pub(super) idle_since_ms: std::sync::atomic::AtomicU64,
    /// Shared with the instance's admission permit, which ends the eviction
    /// when it returns the slot.
    pub(super) evicted: crate::acp_runtime::EvictionFlag,
}

/// Why a turn spawned a new ACP instance instead of reusing its chat's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AcpSpawnReason {
    /// No instance for this chat and agent, under any key.
    NewConversation,
    /// The chat's instance was evicted for another chat or by the low-memory check.
    Evicted,
    /// The chat's instance ended on its own: idle TTL, crash, or teardown.
    Exited,
    /// The chat's instance was keyed by a different command, workspace,
    /// environment or security context.
    KeyChanged,
    /// The instance's tool capability could not be renewed for this caller.
    StaleToolCapability,
    /// The instance's inference grant is revoked or near its end.
    StaleInferenceGrant,
}

impl AcpSpawnReason {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::NewConversation => "new_conversation",
            Self::Evicted => "evicted",
            Self::Exited => "exited",
            Self::KeyChanged => "key_changed",
            Self::StaleToolCapability => "stale_tool_capability",
            Self::StaleInferenceGrant => "stale_inference_grant",
        }
    }
}

impl AcpInstanceActivity {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self {
            admitted: std::sync::atomic::AtomicBool::new(false),
            busy: std::sync::atomic::AtomicBool::new(true),
            idle_since_ms: std::sync::atomic::AtomicU64::new(0),
            evicted: crate::acp_runtime::EvictionFlag::default(),
        })
    }

    pub(super) fn mark_admitted(&self) {
        self.admitted
            .store(true, std::sync::atomic::Ordering::Release);
    }

    pub(super) fn mark_busy(&self) {
        self.busy.store(true, std::sync::atomic::Ordering::Release);
    }

    pub(super) fn mark_idle(&self) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as u64);
        self.idle_since_ms
            .store(now, std::sync::atomic::Ordering::Release);
        self.busy.store(false, std::sync::atomic::Ordering::Release);
        // A queued chat may be waiting for a slot this instance now makes evictable.
        crate::acp_runtime::instance_idle();
    }

    /// `Some(idle_since)` when this instance holds a permit and is waiting for
    /// its next turn.
    pub(crate) fn idle_since(&self) -> Option<u64> {
        use std::sync::atomic::Ordering;
        (self.admitted.load(Ordering::Acquire) && !self.busy.load(Ordering::Acquire))
            .then(|| self.idle_since_ms.load(Ordering::Acquire))
    }
}

/// Pick the pool key of the least-recently-used instance that is admitted and
/// has been idle since at or before `idle_before_ms` (Unix ms). Pure so the
/// selection rule is testable without a subprocess.
pub(super) fn lru_idle_pool_key<'a>(
    entries: impl Iterator<Item = (&'a String, &'a AcpPoolEntry)>,
    idle_before_ms: u64,
) -> Option<String> {
    entries
        .filter(|(_, entry)| !entry.turns.is_closed())
        .filter_map(|(key, entry)| entry.activity.idle_since().map(|since| (since, key)))
        .filter(|(since, _)| *since <= idle_before_ms)
        .min_by_key(|(since, _)| *since)
        .map(|(_, key)| key.clone())
}

/// Close the least-recently-used pooled instance that has been idle at least
/// `min_idle`, so a waiting chat can take its admission slot. Dropping the
/// pool's sender ends that instance's turn loop after any already-queued turn,
/// and its chat's next message respawns and reloads the session exactly as
/// after an idle-TTL reap.
pub(super) fn evict_idle_acp_instance(min_idle: std::time::Duration) -> bool {
    let Ok(mut pool) = acp_pool().lock() else {
        return false;
    };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64);
    let idle_before_ms = now_ms.saturating_sub(min_idle.as_millis() as u64);
    let Some(key) = lru_idle_pool_key(pool.iter(), idle_before_ms) else {
        return false;
    };
    let Some(entry) = pool.remove(&key) else {
        return false;
    };
    // Counted before the sender drops, so the instance's finish cannot race
    // ahead. An instance whose slot is already back frees nothing more.
    let started = crate::acp_runtime::start_eviction(&entry.activity.evicted);
    remember_recent_eviction(&key);
    revoke_evicted_credentials(&entry);
    let idle_ms = entry
        .activity
        .idle_since()
        .map_or(0, |since| now_ms.saturating_sub(since));
    drop(entry);
    tracing::info!(idle_ms, "ACP evicted the least-recently-used idle instance");
    started
}

/// Pool keys whose instance was evicted recently, so the chat's next spawn can
/// say why. Bounded: the oldest are dropped first.
fn recent_evictions() -> &'static Mutex<std::collections::VecDeque<String>> {
    static RECENT: OnceLock<Mutex<std::collections::VecDeque<String>>> = OnceLock::new();
    RECENT.get_or_init(|| Mutex::new(std::collections::VecDeque::new()))
}

pub(super) const RECENT_EVICTIONS_KEPT: usize = 256;

fn remember_recent_eviction(key: &str) {
    if let Ok(mut recent) = recent_evictions().lock() {
        record_eviction(&mut recent, key);
    }
}

pub(super) fn take_recent_eviction(key: &str) -> bool {
    recent_evictions()
        .lock()
        .is_ok_and(|mut recent| take_eviction(&mut recent, key))
}

pub(super) fn record_eviction(recent: &mut std::collections::VecDeque<String>, key: &str) {
    recent.retain(|kept| kept != key);
    if recent.len() >= RECENT_EVICTIONS_KEPT {
        recent.pop_front();
    }
    recent.push_back(key.to_owned());
}

pub(super) fn take_eviction(recent: &mut std::collections::VecDeque<String>, key: &str) -> bool {
    let before = recent.len();
    recent.retain(|kept| kept != key);
    recent.len() != before
}

/// Revoke an evicted instance's tool capability and inference credential at
/// once. Only idle instances are evicted, so no turn loses its model calls.
pub(super) fn revoke_evicted_credentials(entry: &AcpPoolEntry) {
    if let Some(session_id) = entry.capability_session_id {
        crate::server::acp_tool_broker::revoke_session(session_id);
    }
    if let Some(grant_id) = entry.inference_grant_id {
        crate::server::acp_inference_proxy::revoke(grant_id);
    }
}

/// Close every pooled ACP instance of one conversation now instead of letting
/// it idle out. For one-shot conversations (a delegated subagent's
/// `delegate-<uuid>` chat) that will never receive another turn: dropping the
/// pool's sender lets the instance finish any queued turn and then exit, and
/// its process tree is reaped with it. Returns how many instances were closed.
pub fn close_conversation_instances(conversation_id: &str) -> usize {
    if conversation_id.is_empty() {
        return 0;
    }
    let prefix = format!("{conversation_id}\u{1}");
    close_pooled_instances(|key| key.starts_with(&prefix))
}

/// [`close_conversation_instances`] for every conversation whose id starts with
/// `conversation_prefix`, such as all of one workflow run's `wfrun-<run>-<node>`
/// chats once the run has ended.
pub fn close_conversation_instances_with_prefix(conversation_prefix: &str) -> usize {
    if conversation_prefix.is_empty() {
        return 0;
    }
    close_pooled_instances(|key| key.starts_with(conversation_prefix))
}

fn close_pooled_instances(matches: impl Fn(&str) -> bool) -> usize {
    let Ok(mut pool) = acp_pool().lock() else {
        return 0;
    };
    let keys: Vec<String> = pool.keys().filter(|key| matches(key)).cloned().collect();
    for key in &keys {
        if let Some(entry) = pool.remove(key) {
            if let Some(session_id) = entry.capability_session_id {
                crate::server::acp_tool_broker::revoke_session(session_id);
            }
        }
    }
    keys.len()
}

/// Drop a pooled instance that can no longer be reused and revoke its tool
/// capability. An admitted instance is counted like an eviction, so its permit
/// release is tracked and the caller can wait for that slot rather than evict
/// another chat's idle agent. Returns whether such a slot is on its way back.
pub(super) fn retire_pooled_instance(entry: AcpPoolEntry) -> bool {
    let admitted = entry
        .activity
        .admitted
        .load(std::sync::atomic::Ordering::Acquire);
    // Counted before the sender drops, so the instance's finish cannot race
    // ahead. An instance that already returned its slot hands nothing over.
    let released_slot = admitted && crate::acp_runtime::start_eviction(&entry.activity.evicted);
    if let Some(session_id) = entry.capability_session_id {
        crate::server::acp_tool_broker::revoke_session(session_id);
    }
    released_slot
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct SupersededInstances {
    pub(super) retired: usize,
    pub(super) released_slot: bool,
    /// Names of the pool-key components that differ from the retired keys.
    pub(super) changed: Vec<&'static str>,
}

/// Names the components of two pool keys that differ, never their values
/// (which can carry paths and environment).
pub(super) fn changed_pool_key_components(old: &str, new: &str) -> Vec<&'static str> {
    const NAMES: [&str; 9] = [
        "conversation",
        "agent",
        "spawn_cmd",
        "cwd",
        "workspace",
        "environment",
        "security",
        "conversation_generation",
        "workspace_trust",
    ];
    let old: Vec<&str> = old.split('\u{1}').collect();
    let new: Vec<&str> = new.split('\u{1}').collect();
    if old.len() != new.len() {
        return vec!["shape"];
    }
    old.iter()
        .zip(&new)
        .enumerate()
        .filter(|(_, (left, right))| left != right)
        .map(|(index, _)| NAMES.get(index).copied().unwrap_or("other"))
        .collect()
}

/// Remove every other pooled instance of `conversation` and `agent_key` before
/// `key` is spawned. A new key for the same chat and agent means its security
/// context (bearer, tools, workspace, environment) changed; the older instance
/// can never be reused, so it must not idle to the TTL holding an admission
/// permit. Operates on the already-locked pool.
pub(super) fn retire_superseded_instances(
    pool: &mut std::collections::HashMap<String, AcpPoolEntry>,
    conversation: &str,
    agent_key: &str,
    key: &str,
) -> SupersededInstances {
    let mut outcome = SupersededInstances::default();
    // The separator is not allowed inside either component, so the prefix names
    // exactly one (conversation, agent) pair.
    if conversation.is_empty() || conversation.contains('\u{1}') || agent_key.contains('\u{1}') {
        return outcome;
    }
    let prefix = format!("{conversation}\u{1}{agent_key}\u{1}");
    let superseded: Vec<String> = pool
        .keys()
        .filter(|candidate| candidate.as_str() != key && candidate.starts_with(&prefix))
        .cloned()
        .collect();
    for candidate in &superseded {
        if let Some(entry) = pool.remove(candidate) {
            outcome.retired += 1;
            outcome.released_slot |= retire_pooled_instance(entry);
            for name in changed_pool_key_components(candidate, key) {
                if !outcome.changed.contains(&name) {
                    outcome.changed.push(name);
                }
            }
        }
    }
    outcome
}

pub(super) fn acp_pool() -> &'static Mutex<std::collections::HashMap<String, AcpPoolEntry>> {
    static POOL: OnceLock<Mutex<std::collections::HashMap<String, AcpPoolEntry>>> = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}
