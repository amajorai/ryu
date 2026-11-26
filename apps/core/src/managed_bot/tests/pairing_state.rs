//! The pending-pairing state machine.

use super::*;
use crate::managed_bot::pending_store::{effective_expiry_ms, PendingStore};

// ── Pending store state machine ──────────────────────────────────────────

#[test]
fn poll_throttles_then_asks_the_manager() {
    let nonce = "throttle0123456789abcdef01234567";
    let now = 1_000_000;
    let store = PendingStore::default();
    store
        .remember(
            &session(nonce, "2026-08-06T12:00:00Z"),
            ChannelIntent::default(),
            now,
        )
        .unwrap();

    // First poll always reaches the manager.
    assert!(matches!(
        store.begin_poll(nonce, now),
        PollDecision::AskManager { .. }
    ));
    // Immediately again: answered locally.
    assert!(matches!(
        store.begin_poll(nonce, now + 10),
        PollDecision::Throttled
    ));
    // After the floor: upstream again.
    assert!(matches!(
        store.begin_poll(nonce, now + MIN_POLL_INTERVAL_MS),
        PollDecision::AskManager { .. }
    ));
}

#[test]
fn an_expired_pairing_is_dropped_and_unusable_not_merely_hidden() {
    let nonce = "expiry00123456789abcdef012345678";
    let now = 1_000_000;
    let store = PendingStore::default();
    store
        .remember(
            &session(nonce, "2026-08-06T12:00:00Z"),
            ChannelIntent::default(),
            now,
        )
        .unwrap();

    // The local ceiling bounds the entry even if the manager's expiry is far off.
    assert!(matches!(
        store.begin_poll(nonce, now + PAIRING_MAX_TTL_MS + 1),
        PollDecision::Unknown
    ));
    // And the row is GONE, so a later in-window poll cannot resurrect it.
    assert!(matches!(
        store.begin_poll(nonce, now + 1),
        PollDecision::Unknown
    ));
}

#[test]
fn a_manager_expiry_inside_the_ceiling_wins() {
    let now = 1_700_000_000_000;
    // 2033 — far beyond the ceiling, so the ceiling applies.
    assert_eq!(
        effective_expiry_ms("2033-01-01T00:00:00Z", now),
        now + PAIRING_MAX_TTL_MS
    );
    // An unparseable expiry also falls back to the ceiling rather than
    // rejecting the pairing.
    assert_eq!(
        effective_expiry_ms("not a date", now),
        now + PAIRING_MAX_TTL_MS
    );
    // A short manager expiry is honoured verbatim.
    let soon = chrono::DateTime::from_timestamp_millis(now + 60_000)
        .expect("timestamp")
        .to_rfc3339();
    assert_eq!(effective_expiry_ms(&soon, now), now + 60_000);
}

#[test]
fn re_claim_is_idempotent_once_the_token_has_landed() {
    let nonce = "landed00123456789abcdef012345678";
    let now = 2_000_000;
    let store = PendingStore::default();
    store
        .remember(
            &session(nonce, "2026-08-06T12:00:00Z"),
            ChannelIntent::default(),
            now,
        )
        .unwrap();
    store.mark_landed(nonce, "chan-1", 999, "helper_bot");

    // Every later poll answers from local state: no second claim, no second
    // write, and no "expired" once the manager's one-shot token is spent.
    for step in [0, 1, MIN_POLL_INTERVAL_MS * 10] {
        match store.begin_poll(nonce, now + step) {
            PollDecision::Landed {
                channel_id,
                bot_id,
                bot_username,
            } => {
                assert_eq!(channel_id, "chan-1");
                assert_eq!(bot_id, 999);
                assert_eq!(bot_username, "helper_bot");
            }
            other => panic!("expected landed, got {other:?}"),
        }
    }
    // A landed pairing survives its own expiry window: the desktop may poll
    // after the pairing TTL and must still be told it succeeded.
    assert!(matches!(
        store.begin_poll(nonce, now + PAIRING_MAX_TTL_MS + 1),
        PollDecision::Landed { .. }
    ));
}

#[test]
fn a_failed_write_retries_through_refresh_not_a_spent_claim() {
    let nonce = "unland00123456789abcdef012345678";
    let now = 3_000_000;
    let store = PendingStore::default();
    store
        .remember(
            &session(nonce, "2026-08-06T12:00:00Z"),
            ChannelIntent {
                name: Some("My bot".into()),
                channel_id: Some("chan-9".into()),
                ..ChannelIntent::default()
            },
            now,
        )
        .unwrap();
    store.mark_unlanded(nonce);

    match store.begin_poll(nonce, now + MIN_POLL_INTERVAL_MS) {
        PollDecision::AskManager {
            use_refresh,
            claim_secret,
        } => {
            assert!(use_refresh, "a spent claim must retry via refresh");
            assert_eq!(claim_secret.expose(), "s3cr3t-claim-secret-0123456789ab");
        }
        other => panic!("expected AskManager, got {other:?}"),
    }

    // And the form the user filled in is still there for the write that follows.
    store.hold_for_confirmation(
        nonce,
        ManagedBot {
            token: Secret::new("555555:AA-refreshed"),
            bot_id: 555,
            bot_username: "helper_bot".into(),
            owner_telegram_user_id: None,
        },
    );
    let (_, _, intent) = store.take_confirmed(nonce).expect("confirmed");
    assert_eq!(intent.name.as_deref(), Some("My bot"));
    assert_eq!(intent.channel_id.as_deref(), Some("chan-9"));
}

/// The hijack guard, as a state-machine assertion: a claimed token does not
/// become a channel config on its own. Whoever opens the public deep link first
/// binds the pairing, so without this hop a stranger who read the nonce off a
/// screen share could have this node adopt a bot THEY own.
#[test]
fn a_claimed_token_waits_for_a_human_before_it_lands() {
    let nonce = "confirm0123456789abcdef012345678";
    let now = 4_000_000;
    let store = PendingStore::default();
    store
        .remember(
            &session(nonce, "2026-08-06T12:00:00Z"),
            ChannelIntent {
                name: Some("Support bot".into()),
                agent_id: Some("triage".into()),
                ..ChannelIntent::default()
            },
            now,
        )
        .unwrap();

    let view = store
        .hold_for_confirmation(
            nonce,
            ManagedBot {
                token: Secret::new("555555:AA-fresh"),
                bot_id: 555,
                bot_username: "made_bot".into(),
                owner_telegram_user_id: Some(4242),
            },
        )
        .expect("held for confirmation");
    assert_eq!(view.bot_id, 555);
    // The field the human decides on: an owner that is not them means the
    // pairing was taken by someone else.
    assert_eq!(view.owner_telegram_user_id, Some(4242));

    // Every later poll answers from local state — no second claim, no write —
    // and the decision does NOT time out: the bot already exists, and Telegram
    // gives its owner no way to delete it.
    for step in [0, MIN_POLL_INTERVAL_MS * 10, PAIRING_MAX_TTL_MS + 1] {
        match store.begin_poll(nonce, now + step) {
            PollDecision::NeedsConfirmation(view) => {
                assert_eq!(view.bot_username, "made_bot");
            }
            other => panic!("expected NeedsConfirmation, got {other:?}"),
        }
    }

    // The yes hands back the token AND the form the user filled in.
    let (bot, secret, intent) = store.take_confirmed(nonce).expect("confirmed");
    assert_eq!(bot.token.expose(), "555555:AA-fresh");
    assert_eq!(intent.name.as_deref(), Some("Support bot"));
    assert_eq!(intent.agent_id.as_deref(), Some("triage"));
    assert_eq!(secret.expose(), "s3cr3t-claim-secret-0123456789ab");
}

#[test]
fn a_refused_bot_is_dropped_and_hands_back_the_secret_that_revokes_it() {
    let nonce = "refused0123456789abcdef012345678";
    let now = 5_000_000;
    let store = PendingStore::default();
    store
        .remember(
            &session(nonce, "2026-08-06T12:00:00Z"),
            ChannelIntent::default(),
            now,
        )
        .unwrap();
    store.hold_for_confirmation(
        nonce,
        ManagedBot {
            token: Secret::new("555555:AA-not-mine"),
            bot_id: 555,
            bot_username: "stranger_bot".into(),
            owner_telegram_user_id: Some(9),
        },
    );

    // The secret comes back because the caller needs it to tell the manager to
    // forget — and revoke — the bot; the token itself never goes anywhere.
    let secret = store.take_for_cancel(nonce).expect("claim secret");
    assert_eq!(secret.expose(), "s3cr3t-claim-secret-0123456789ab");
    assert!(store.take_confirmed(nonce).is_none());
    assert!(matches!(
        store.begin_poll(nonce, now),
        PollDecision::Unknown
    ));
    // Nothing left to cancel twice.
    assert!(store.take_for_cancel(nonce).is_none());
}

/// A landed pairing must NOT be cancellable: cancelling revokes the token on the
/// manager, and by then that token is sealed in a channel config the gateway is
/// running — revoking it leaves a channel that 401s forever.
#[test]
fn a_landed_pairing_cannot_be_cancelled_into_a_dead_channel() {
    let nonce = "landcxl0123456789abcdef012345678";
    let now = 6_000_000;
    let store = PendingStore::default();
    store
        .remember(
            &session(nonce, "2026-08-06T12:00:00Z"),
            ChannelIntent::default(),
            now,
        )
        .unwrap();
    store.mark_landed(nonce, "chan-1", 555, "made_bot");

    // A confirm whose response was lost looks exactly like an unfinished pairing
    // to the client that retried it, so this arrives without anyone being confused.
    assert!(store.take_for_cancel(nonce).is_none());
    assert!(matches!(
        store.begin_poll(nonce, now),
        PollDecision::Landed { .. }
    ));
}

#[test]
fn a_manager_with_bot_management_off_is_a_typed_unavailable() {
    // The distinction the UI depends on: "flip a switch in @BotFather" must not
    // arrive as the same generic failure as "the manager had a bad minute", or
    // the desktop shows a Try-again button for something retrying cannot fix.
    let err = anyhow::Error::new(ManagerUnavailable { status: 501 })
        .context("POST /managed-bot/pair on the managed-bot manager");
    assert!(is_manager_unavailable(&err));
    assert!(!is_manager_unavailable(&anyhow!("connection reset")));
}

#[test]
fn an_unknown_nonce_is_unknown_and_a_malformed_one_is_never_stored() {
    let store = PendingStore::default();
    assert!(matches!(
        store.begin_poll("nosuchnonce0123456789abcdef01234", now_ms()),
        PollDecision::Unknown
    ));
    let bad = session("../etc/passwd", "2026-08-06T12:00:00Z");
    assert!(store
        .remember(&bad, ChannelIntent::default(), now_ms())
        .is_err());
    assert!(matches!(
        store.begin_poll("../etc/passwd", now_ms()),
        PollDecision::Unknown
    ));
}
