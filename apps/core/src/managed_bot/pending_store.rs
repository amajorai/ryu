//! The in-memory store of pairings in flight.

use super::*;

// ── Pending-pairing store ────────────────────────────────────────────────────

/// Where a pairing has got to. The claimed states exist so a second poll is
/// idempotent: the manager hands the token over exactly once, so re-claiming would
/// 404 and a naive handler would report a successful pairing as expired.
#[derive(Debug, Clone)]
pub(super) enum PairingState {
    /// The user has not finished creating the bot.
    Waiting,
    /// The manager handed the token over and the node is holding it, unwritten,
    /// until a human confirms the bot is the one THEY just created.
    ///
    /// This state exists because the nonce is public by design: it rides a QR the
    /// user may hold up to a camera, so whoever opens the deep link FIRST binds the
    /// pairing. Without a confirmation step, someone who reads the nonce off a
    /// screen share can create a bot they own and have this node adopt it —
    /// handing them a live credential inside the user's chats. Only the person at
    /// the desktop can tell "@the_bot_I_just_made" from a stranger's, so the token
    /// waits here for them to say so.
    AwaitingConfirmation { bot: Box<ManagedBot> },
    /// Token claimed AND written. Terminal success; later polls answer from here
    /// and make no network call and no second write.
    Landed {
        channel_id: String,
        bot_id: i64,
        bot_username: String,
    },
    /// The one-shot claim is spent but the token is not in a channel config yet —
    /// the local write failed, or the claim's HTTP response was lost in flight and
    /// the manager answered `claimed` on the retry. Either way the recovery is
    /// `refresh`, never a second claim. Carries nothing: the refresh answer names
    /// the bot, so remembering a stale copy here would only invite reading it.
    Unlanded,
}

#[derive(Debug, Clone)]
pub(super) struct Pending {
    claim_secret: Secret,
    /// The add-channel form, held until the poll can write it (see
    /// [`ChannelIntent`]).
    intent: ChannelIntent,
    /// Local expiry: `min(manager expires_at, now + PAIRING_MAX_TTL_MS)`.
    expires_at_ms: i64,
    /// RFC3339 string echoed to clients.
    expires_at: String,
    deep_link: String,
    last_polled_ms: i64,
    state: PairingState,
}

/// Pending pairings, keyed by nonce.
///
/// A value rather than a bare static so the map is not process-global state every
/// caller shares: [`PendingStore::remember`] evicts expired entries, and with one
/// global map any caller working from a different clock base evicts the others'
/// rows. In production every caller passes [`now_ms`], so that could only ever bite
/// tests — which it did, three of them, but only under the parallel runner, which is
/// the worst possible way to learn it. The node keeps exactly one instance
/// ([`pending`]); a test owns its own.
#[derive(Default)]
pub struct PendingStore {
    map: Mutex<HashMap<String, Pending>>,
}

/// The node's single store.
///
/// Process-local on purpose. The claim_secret must never leave the node, and a
/// pairing is a 10-minute interaction, so persisting it would add a secret at rest
/// to protect a window shorter than most restarts. The cost is explicit: a Core
/// restart mid-pairing loses the claim_secret and the user re-pairs. Once the claim
/// SUCCEEDS the secret is re-persisted into the channel config's sealed `secrets`
/// map, so rotation — the part that must outlive a restart — does.
pub(super) static PENDING: OnceLock<PendingStore> = OnceLock::new();

pub(super) fn pending() -> &'static PendingStore {
    PENDING.get_or_init(PendingStore::default)
}

/// Current wall clock in Unix milliseconds.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Parse the manager's RFC3339 expiry and clamp it to the local ceiling. An
/// unparseable expiry falls back to the ceiling rather than rejecting the pairing:
/// the ceiling is what makes an entry unusable, and the string is only cosmetic.
pub(super) fn effective_expiry_ms(expires_at: &str, now_ms: i64) -> i64 {
    let ceiling = now_ms.saturating_add(PAIRING_MAX_TTL_MS);
    match chrono::DateTime::parse_from_rfc3339(expires_at.trim()) {
        Ok(dt) => dt.timestamp_millis().min(ceiling),
        Err(_) => ceiling,
    }
}

/// Record a freshly-minted pairing on the node's store.
pub fn remember(session: &PairSession, intent: ChannelIntent, now: i64) -> Result<()> {
    pending().remember(session, intent, now)
}

/// What the poll handler should do next.
#[derive(Debug)]
pub enum PollDecision {
    /// No such pairing, or it expired and was dropped. Expiry is enforced here on
    /// every read, so an expired row is unusable rather than merely un-listed.
    Unknown,
    /// Polled too recently — answer `waiting` without touching the manager.
    Throttled,
    /// Ask the manager. `use_refresh` is true when a previous claim already spent
    /// the one-shot token and the local write is what failed.
    ///
    /// No [`ChannelIntent`] rides along: the form is not needed until a human
    /// confirms the bot, and [`PendingStore::take_confirmed`] hands it over then.
    AskManager {
        claim_secret: Secret,
        use_refresh: bool,
    },
    /// The token is in hand but unwritten: a human must confirm this is the bot
    /// they created before it becomes their assistant's identity. Answered from
    /// local state, so re-polling neither re-claims nor lands anything.
    NeedsConfirmation(ConfirmationView),
    /// Already confirmed AND landed. Terminal — the idempotent re-claim answer.
    Landed {
        channel_id: String,
        bot_id: i64,
        bot_username: String,
    },
}

/// Decide what a poll for `nonce` should do on the node's store.
pub fn begin_poll(nonce: &str, now: i64) -> PollDecision {
    pending().begin_poll(nonce, now)
}

/// Hold a claimed token for the human's yes/no. Returns what the desktop must show
/// them, or `None` if the pairing vanished under us.
pub fn hold_for_confirmation(nonce: &str, bot: ManagedBot) -> Option<ConfirmationView> {
    pending().hold_for_confirmation(nonce, bot)
}

/// The human said yes: hand back everything needed to write the config.
pub fn take_confirmed(nonce: &str) -> Option<(ManagedBot, Secret, ChannelIntent)> {
    pending().take_confirmed(nonce)
}

/// The human said no (or cancelled): drop the pairing and hand back the secret so
/// the caller can tell the manager to forget — and revoke — the bot too.
///
/// `None` for a pairing that already LANDED, which is not a cancel but a stale one:
/// forgetting a landed record on the manager revokes the token now sealed in the
/// channel config, and the config would be permanently dead.
pub fn take_for_cancel(nonce: &str) -> Option<Secret> {
    pending().take_for_cancel(nonce)
}

/// Terminal success: the token is in the channel config.
pub fn mark_landed(nonce: &str, channel_id: &str, bot_id: i64, bot_username: &str) {
    pending().mark_landed(nonce, channel_id, bot_id, bot_username);
}

/// The one-shot claim is spent and the token has not landed. Route the next poll
/// through `refresh` rather than re-claiming a token the manager will not resend.
pub fn mark_unlanded(nonce: &str) {
    pending().mark_unlanded(nonce);
}

/// Drop a pairing (the manager says it is gone, or the user cancelled).
pub fn forget(nonce: &str) {
    pending().forget(nonce);
}

/// The client-safe view of a pending pairing: nonce, deep link, expiry — never the
/// claim_secret.
pub fn public_view(nonce: &str) -> Option<(String, String)> {
    pending().public_view(nonce)
}

impl PendingStore {
    /// Record a freshly-minted pairing. Also drops every already-expired entry, so
    /// the map cannot grow with dead secrets on a node that pairs repeatedly.
    pub fn remember(&self, session: &PairSession, intent: ChannelIntent, now: i64) -> Result<()> {
        validate_nonce(&session.nonce)?;
        let entry = Pending {
            claim_secret: session.claim_secret.clone(),
            intent,
            expires_at_ms: effective_expiry_ms(&session.expires_at, now),
            expires_at: session.expires_at.clone(),
            deep_link: session.deep_link.clone(),
            // Zero, not `now`: the desktop polls immediately after begin and that
            // first poll must reach the manager.
            last_polled_ms: 0,
            state: PairingState::Waiting,
        };
        let mut map = self
            .map
            .lock()
            .map_err(|_| anyhow!("managed-bot pending map poisoned"))?;
        map.retain(|_, p| p.expires_at_ms > now || matches!(p.state, PairingState::Landed { .. }));
        map.insert(session.nonce.clone(), entry);
        Ok(())
    }

    /// Decide what a poll for `nonce` should do, stamping the throttle clock.
    ///
    /// A `Landed` pairing is answered without stamping: it never calls out again,
    /// and keeping the clock untouched means a client that polls a finished pairing
    /// forever still reads the same terminal answer.
    pub fn begin_poll(&self, nonce: &str, now: i64) -> PollDecision {
        let Ok(mut map) = self.map.lock() else {
            return PollDecision::Unknown;
        };
        let Some(entry) = map.get_mut(nonce) else {
            return PollDecision::Unknown;
        };
        if let PairingState::Landed {
            channel_id,
            bot_id,
            bot_username,
        } = &entry.state
        {
            return PollDecision::Landed {
                channel_id: channel_id.clone(),
                bot_id: *bot_id,
                bot_username: bot_username.clone(),
            };
        }
        // Held for confirmation: no expiry check and no throttle stamp. The bot
        // EXISTS by now, so timing the user out here would leave them owning a bot
        // Telegram gives them no way to delete — the decision has to stay open.
        if let PairingState::AwaitingConfirmation { bot } = &entry.state {
            return PollDecision::NeedsConfirmation(ConfirmationView::of(bot));
        }
        if entry.expires_at_ms <= now {
            map.remove(nonce);
            return PollDecision::Unknown;
        }
        if now.saturating_sub(entry.last_polled_ms) < MIN_POLL_INTERVAL_MS {
            return PollDecision::Throttled;
        }
        entry.last_polled_ms = now;
        PollDecision::AskManager {
            claim_secret: entry.claim_secret.clone(),
            use_refresh: matches!(entry.state, PairingState::Unlanded),
        }
    }

    /// Park a claimed token in [`PairingState::AwaitingConfirmation`].
    pub fn hold_for_confirmation(&self, nonce: &str, bot: ManagedBot) -> Option<ConfirmationView> {
        let mut map = self.map.lock().ok()?;
        let entry = map.get_mut(nonce)?;
        let view = ConfirmationView::of(&bot);
        entry.state = PairingState::AwaitingConfirmation { bot: Box::new(bot) };
        Some(view)
    }

    /// Take a confirmed token out for writing. Leaves the entry in place (still
    /// `AwaitingConfirmation`) so a failed write can be retried by confirming
    /// again; `mark_landed` is what makes the success terminal.
    pub fn take_confirmed(&self, nonce: &str) -> Option<(ManagedBot, Secret, ChannelIntent)> {
        let map = self.map.lock().ok()?;
        let entry = map.get(nonce)?;
        let PairingState::AwaitingConfirmation { bot } = &entry.state else {
            return None;
        };
        Some((
            (**bot).clone(),
            entry.claim_secret.clone(),
            entry.intent.clone(),
        ))
    }

    /// Drop the pairing and return its claim_secret, so the caller can tell the
    /// manager to forget the record. A user may cancel before the bot exists and may
    /// refuse one that already does — but NOT one that already landed.
    ///
    /// That exclusion is the whole reason this is a state-aware take. Cancelling on
    /// the manager revokes the bot's token, and once a pairing has landed that token
    /// is sealed in a channel config the gateway is running: revoking it leaves a
    /// channel that 401s forever with no refresh path. It is reachable by accident,
    /// not just by a confused user — a confirm whose response is lost looks exactly
    /// like an unfinished pairing to the client that retried it.
    pub fn take_for_cancel(&self, nonce: &str) -> Option<Secret> {
        let mut map = self.map.lock().ok()?;
        if matches!(map.get(nonce)?.state, PairingState::Landed { .. }) {
            return None;
        }
        let entry = map.remove(nonce)?;
        Some(entry.claim_secret)
    }

    pub fn mark_landed(&self, nonce: &str, channel_id: &str, bot_id: i64, bot_username: &str) {
        if let Ok(mut map) = self.map.lock() {
            if let Some(entry) = map.get_mut(nonce) {
                entry.state = PairingState::Landed {
                    channel_id: channel_id.to_string(),
                    bot_id,
                    bot_username: bot_username.to_string(),
                };
            }
        }
    }

    pub fn mark_unlanded(&self, nonce: &str) {
        if let Ok(mut map) = self.map.lock() {
            if let Some(entry) = map.get_mut(nonce) {
                entry.state = PairingState::Unlanded;
            }
        }
    }

    pub fn forget(&self, nonce: &str) {
        if let Ok(mut map) = self.map.lock() {
            map.remove(nonce);
        }
    }

    pub fn public_view(&self, nonce: &str) -> Option<(String, String)> {
        let map = self.map.lock().ok()?;
        let entry = map.get(nonce)?;
        Some((entry.deep_link.clone(), entry.expires_at.clone()))
    }
}
