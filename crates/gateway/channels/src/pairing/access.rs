//! Pairing decisions: the per-sender pair state, the access policy that gates
//! DMs and groups, and pairing-code minting.

use super::*;

impl PairingStore {
    /// Look up one sender's state.
    pub async fn get(&self, platform: &str, sender_id: &str) -> Option<PairState> {
        let key = entry_key(platform, sender_id);
        self.inner.read().await.entries.get(&key).cloned()
    }

    /// Every entry, for the operator-facing "pending approvals" list.
    pub async fn list(&self) -> Vec<(String, PairState)> {
        self.inner
            .read()
            .await
            .entries
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// Issue (or re-issue) a pairing code for a sender and return it.
    ///
    /// An unexpired pending code is returned as-is: a sender who messages three
    /// times gets one code, not three, so the operator is not asked to choose
    /// between codes that mean the same thing.
    pub async fn challenge(&self, platform: &str, sender_id: &str) -> Decision {
        let key = entry_key(platform, sender_id);
        let now = unix_now();
        {
            let map = self.inner.read().await;
            match map.entries.get(&key) {
                Some(PairState::Paired { .. }) => return Decision::Allow,
                Some(PairState::Blocked) => return Decision::Deny,
                Some(PairState::Pending { code, issued_at })
                    if now.saturating_sub(*issued_at) < CODE_TTL.as_secs() =>
                {
                    return Decision::Pending(code.clone());
                }
                _ => {}
            }
        }
        let code = generate_code(platform, sender_id, now);
        {
            let mut map = self.inner.write().await;
            // Expired codes can never be approved; dropping them here keeps the
            // store bounded by live codes rather than by every sender ever seen.
            map.entries.retain(|_, state| match state {
                PairState::Pending { issued_at, .. } => {
                    now.saturating_sub(*issued_at) < CODE_TTL.as_secs()
                }
                PairState::Paired { .. } | PairState::Blocked => true,
            });
            // Another message may have decided this sender while the lock was
            // released; answer from that decision instead of minting a new code.
            match map.entries.get(&key) {
                Some(PairState::Paired { .. }) => return Decision::Allow,
                Some(PairState::Blocked) => return Decision::Deny,
                Some(PairState::Pending { code, .. }) => return Decision::Pending(code.clone()),
                None => {}
            }
            let pending = map
                .entries
                .values()
                .filter(|state| matches!(state, PairState::Pending { .. }))
                .count();
            if pending >= MAX_PENDING_PAIRINGS {
                warn!(
                    platform,
                    "channel pairing queue is full; dropping unknown DM sender"
                );
                return Decision::Deny;
            }
            map.version = 1;
            map.entries.insert(
                key,
                PairState::Pending {
                    code: code.clone(),
                    issued_at: now,
                },
            );
        }
        self.persist().await;
        // The code admits the sender once approved: never log it.
        info!(platform, "issued channel pairing code");
        Decision::Challenge(code)
    }

    /// Approve whichever sender holds `code`. Returns the paired entry key, or
    /// `None` when no live entry carries that code (wrong, stale, or already used).
    pub async fn approve_code(&self, code: &str) -> Option<String> {
        let wanted = code.trim().to_ascii_uppercase();
        let now = unix_now();
        let mut approved = None;
        {
            let mut map = self.inner.write().await;
            for (key, state) in map.entries.iter_mut() {
                if let PairState::Pending { code, issued_at } = state {
                    if *code == wanted && now.saturating_sub(*issued_at) < CODE_TTL.as_secs() {
                        approved = Some(key.clone());
                        break;
                    }
                }
            }
            if let Some(key) = &approved {
                map.entries
                    .insert(key.clone(), PairState::Paired { paired_at: now });
            }
        }
        if approved.is_some() {
            self.persist().await;
        }
        approved
    }

    /// Approve a sender directly (operator clicked "allow" on a pending row rather
    /// than typing the code).
    pub async fn approve(&self, platform: &str, sender_id: &str) {
        {
            let mut map = self.inner.write().await;
            map.entries.insert(
                entry_key(platform, sender_id),
                PairState::Paired {
                    paired_at: unix_now(),
                },
            );
        }
        self.persist().await;
    }

    /// Block a sender. Idempotent, and permanent until explicitly removed — a
    /// blocked sender never receives another pairing code.
    pub async fn block(&self, platform: &str, sender_id: &str) {
        {
            let mut map = self.inner.write().await;
            map.entries
                .insert(entry_key(platform, sender_id), PairState::Blocked);
        }
        self.persist().await;
    }

    /// Forget a sender entirely, returning them to "unknown" (so they can pair
    /// again). Used to undo an accidental block.
    pub async fn forget(&self, platform: &str, sender_id: &str) {
        {
            let mut map = self.inner.write().await;
            map.entries.remove(&entry_key(platform, sender_id));
        }
        self.persist().await;
    }
}

/// The access policy for one channel: DM and group rules plus the static
/// allowlists they consult.
#[derive(Debug, Clone, Default)]
pub struct AccessPolicy {
    pub dm: DmPolicy,
    pub group: GroupPolicy,
    /// Sender ids admitted without pairing (`DmPolicy::Allowlist`, and a fast path
    /// under `Pairing`). Empty means "nobody is pre-admitted".
    pub dm_allowlist: Vec<String>,
    /// Group/chat ids admitted under `GroupPolicy::Allowlist`.
    pub group_allowlist: Vec<String>,
    /// Sender ids admitted in an allowlisted group. This is the platform-neutral
    /// equivalent of Hermes' `allow_from` user rule: a known person can address
    /// the bot in a room without opening every room with the same name.
    pub group_sender_allowlist: Vec<String>,
}

impl AccessPolicy {
    /// Decide a **group** message with no store lookup — group rules are static.
    pub fn decide_group(&self, chat_id: &str) -> Decision {
        match self.group {
            GroupPolicy::Disabled => Decision::Deny,
            GroupPolicy::Open => Decision::Allow,
            GroupPolicy::Allowlist => {
                if self.group_allowlist.iter().any(|id| id == chat_id) {
                    Decision::Allow
                } else {
                    Decision::Deny
                }
            }
        }
    }

    /// Decide a group message with both the room and the sender available.
    ///
    /// Sender admission is intentionally an additive fast path: an explicitly
    /// allowed sender may talk in a room even when the room itself is not listed,
    /// but an empty sender allowlist preserves the existing room-only behavior.
    pub fn decide_group_for_sender(&self, chat_id: &str, sender_id: Option<&str>) -> Decision {
        if sender_id.is_some_and(|id| {
            self.group_sender_allowlist
                .iter()
                .any(|allowed| allowed == id)
        }) {
            return Decision::Allow;
        }
        self.decide_group(chat_id)
    }

    /// Decide a **direct message**. `sender_id` is the platform's stable per-user
    /// id where available, falling back to the chat id for platforms where a DM
    /// chat id *is* the user (WhatsApp phone numbers, iMessage handles).
    pub async fn decide_dm(
        &self,
        store: &PairingStore,
        platform: &str,
        sender_id: &str,
    ) -> Decision {
        if self.dm_allowlist.iter().any(|id| id == sender_id) {
            return Decision::Allow;
        }
        match self.dm {
            DmPolicy::Disabled => Decision::Deny,
            DmPolicy::Open => Decision::Allow,
            DmPolicy::Allowlist => Decision::Deny,
            DmPolicy::Pairing => match store.get(platform, sender_id).await {
                Some(PairState::Paired { .. }) => Decision::Allow,
                Some(PairState::Blocked) => Decision::Deny,
                _ => store.challenge(platform, sender_id).await,
            },
        }
    }
}

/// `"<platform>:<sender_id>"` — the store's key shape.
pub(super) fn entry_key(platform: &str, sender_id: &str) -> String {
    format!("{platform}:{sender_id}")
}

/// Seconds since the Unix epoch, saturating to 0 if the clock is before it.
pub(super) fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Nanoseconds used only for unique temporary filenames during atomic writes.
pub(super) fn unix_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Derive a pairing code from the sender identity plus the issue time.
///
/// A hash rather than a random draw so the crate needs no RNG dependency. The
/// input includes the nanosecond clock, so re-challenging the same sender yields a
/// different code; the code is not a secret to be guessed but a short token the
/// operator retypes, and it is only ever valid alongside the sender it was issued
/// to (approval looks up the entry, so guessing a code cannot admit a *different*
/// sender than the one who holds it).
pub(super) fn generate_code(platform: &str, sender_id: &str, now: u64) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(platform.as_bytes());
    hasher.update(b"\0");
    hasher.update(sender_id.as_bytes());
    hasher.update(now.to_le_bytes());
    hasher.update(nanos.to_le_bytes());
    let digest = hasher.finalize();
    digest
        .iter()
        .take(CODE_LEN)
        .map(|b| CODE_ALPHABET[(*b as usize) % CODE_ALPHABET.len()] as char)
        .collect()
}
