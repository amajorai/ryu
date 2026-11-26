//! URLs, request bodies, secret hygiene and claim status mapping.

use super::*;
use crate::managed_bot::landing::channel_name;
use crate::managed_bot::manager::ManagerClient;
use crate::managed_bot::urls::{
    action_body, action_url, claim_status_from_body, claim_url, pair_url,
};

// ── URL / body construction ──────────────────────────────────────────────

#[test]
fn manager_urls_hang_off_the_base_without_doubling_slashes() {
    assert_eq!(
        pair_url("https://bot.ryuhq.com/"),
        "https://bot.ryuhq.com/managed-bot/pair"
    );
    assert_eq!(
        claim_url("https://bot.ryuhq.com", NONCE),
        format!("https://bot.ryuhq.com/managed-bot/claim/{NONCE}")
    );
    assert_eq!(
        action_url("http://127.0.0.1:4001/", "rotate"),
        "http://127.0.0.1:4001/managed-bot/rotate"
    );
    assert_eq!(action_body(NONCE), json!({ "nonce": NONCE }));
}

#[test]
fn manager_base_defaults_to_the_hosted_service() {
    // The env var is process-global and other tests must not see it set, so
    // assert the default shape rather than mutating the environment.
    assert_eq!(DEFAULT_MANAGER_BASE, "https://bot.ryuhq.com");
    assert!(!manager_base().ends_with('/'));
}

#[test]
fn client_trims_a_trailing_slash_from_the_configured_base() {
    let client = ManagerClient::with_base("https://bot.example.com/");
    assert_eq!(client.base(), "https://bot.example.com");
}

#[test]
fn nonce_charset_is_enforced_so_a_poll_cannot_walk_the_claim_path() {
    assert!(validate_nonce(NONCE).is_ok());
    assert!(validate_nonce("short").is_err());
    // Path traversal, a nested path, and a query splice all rejected.
    assert!(validate_nonce("../../managed-bot/pair/aaaaaaaaaaaaaaaa").is_err());
    assert!(validate_nonce("abcdefghijklmnop/../secret").is_err());
    assert!(validate_nonce("abcdefghijklmnop?x=1").is_err());
    assert!(validate_nonce(&"a".repeat(NONCE_MAX_LEN + 1)).is_err());
}

#[test]
fn create_body_lands_the_token_where_the_adapter_reads_it_and_enables_the_bot() {
    let intent = ChannelIntent {
        agent_id: Some("ryu".into()),
        ..ChannelIntent::default()
    };
    let body = create_channel_body("My bot", "123:ABC", "claim", NONCE, &intent);
    assert_eq!(body["channelType"], "telegram");
    assert_eq!(body["name"], "My bot");
    // Without this the token is stored and nothing ever spawns the adapter.
    assert_eq!(body["enabled"], true);
    assert_eq!(body["secrets"]["bot_token"], "123:ABC");
    assert_eq!(body["secrets"]["managed_bot_secret"], "claim");
    assert_eq!(body["secrets"]["managed_bot_nonce"], NONCE);
    assert_eq!(body["agentId"], "ryu");

    // A blank agent id is omitted rather than sent as "".
    let blank = ChannelIntent {
        agent_id: Some("  ".into()),
        ..ChannelIntent::default()
    };
    let body = create_channel_body("My bot", "123:ABC", "claim", NONCE, &blank);
    assert!(body.get("agentId").is_none());
}

/// Every field the add-channel form can set has to survive the pairing, because
/// the config is written minutes later by a poll. Each of these was silently
/// dropped once: the bot came out named after its handle, bound to no agent,
/// with the default reply mode, and enabled against the user's choice.
#[test]
fn the_create_body_carries_the_whole_form_not_just_the_token() {
    let intent = ChannelIntent {
        name: Some("Support bot".into()),
        channel_id: None,
        agent_id: None,
        team_id: Some("team-7".into()),
        model: Some("sonnet".into()),
        system_prompt: Some("Be brief.".into()),
        group_reply_mode: Some("mentions".into()),
        proactive_opening: true,
        proactive_target: Some("123456".into()),
        enabled: false,
        reaction_learning: Some(json!({
            "enabled": true,
            "positiveEmoji": ["👍", "❤️"],
            "negativeEmoji": ["👎", "💀"],
            "allowGroup": true,
        })),
    };
    let body = create_channel_body("Support bot", "123:ABC", "claim", NONCE, &intent);
    assert_eq!(body["teamId"], "team-7");
    assert_eq!(body["model"], "sonnet");
    assert_eq!(body["systemPrompt"], "Be brief.");
    assert_eq!(body["groupReplyMode"], "mentions");
    assert_eq!(body["proactiveOpening"], true);
    assert_eq!(body["proactiveTarget"], "123456");
    assert_eq!(body["reactionLearning"]["positiveEmoji"][0], "👍");
    assert_eq!(body["reactionLearning"]["allowGroup"], true);
    // The user's own switch, not a forced `true`: the control plane reads
    // `body.enabled === true`, so this field must always be present.
    assert_eq!(body["enabled"], false);
    // An unset binding is absent rather than null, so the control plane applies
    // its own default instead of storing an empty string.
    assert!(body.get("agentId").is_none());
}

#[test]
fn patch_body_carries_only_secrets_so_it_cannot_clobber_the_users_settings() {
    let body = patch_channel_body("123:ABC", "claim", NONCE);
    let obj = body.as_object().expect("object body");
    assert_eq!(obj.len(), 1, "PATCH must send secrets and nothing else");
    assert_eq!(body["secrets"]["bot_token"], "123:ABC");
    // Notably absent: `enabled`. The user's own choice on an existing config
    // must survive a token rotation.
    assert!(body["secrets"].get("enabled").is_none());
}

#[test]
fn channel_name_falls_back_to_the_bot_handle_then_its_id() {
    assert_eq!(channel_name(Some("Helper"), "helper_bot", 7), "Helper");
    assert_eq!(channel_name(Some("  "), "helper_bot", 7), "@helper_bot");
    assert_eq!(channel_name(None, "@helper_bot", 7), "@helper_bot");
    assert_eq!(channel_name(None, "  ", 7), "Telegram bot 7");
}

// ── Secret hygiene ───────────────────────────────────────────────────────

#[test]
fn secrets_are_redacted_in_debug_and_never_reach_a_serialized_body() {
    let s = session(NONCE, "2026-08-06T12:00:00Z");
    let dumped = format!("{s:?}");
    assert!(
        !dumped.contains("s3cr3t-claim-secret"),
        "Debug leaked the claim_secret: {dumped}"
    );
    assert!(dumped.contains("[redacted]"), "expected a placeholder");
    // The nonce and deep link ARE public and must still be debuggable.
    assert!(dumped.contains(NONCE));

    let bot = ManagedBot {
        token: Secret::new("123456:AA-live-bot-token"),
        bot_id: 999,
        bot_username: "helper_bot".into(),
        owner_telegram_user_id: Some(111),
    };
    let dumped = format!("{bot:?}");
    assert!(
        !dumped.contains("live-bot-token"),
        "Debug leaked the bot token: {dumped}"
    );
    assert!(dumped.contains("999"), "public ids stay loggable");

    // `Secret` implements neither Serialize nor Display, so the only route out
    // is `expose()`. Guard the property the response path depends on: the
    // client-facing pairing view carries no secret material.
    let store = PendingStore::default();
    store
        .remember(&s, ChannelIntent::default(), now_ms())
        .expect("remember");
    let (deep_link, expires_at) = store.public_view(NONCE).expect("view");
    let view = json!({ "nonce": NONCE, "deep_link": deep_link, "expires_at": expires_at });
    let encoded = serde_json::to_string(&view).expect("serialize");
    assert!(!encoded.contains("s3cr3t-claim-secret"));
}

// ── Claim status mapping ─────────────────────────────────────────────────

#[test]
fn claim_status_maps_pending_ready_and_unknown() {
    assert!(matches!(
        claim_status_from_body(&json!({ "status": "pending" })).unwrap(),
        ClaimStatus::Pending
    ));

    let ready = claim_status_from_body(&json!({
        "status": "ready",
        "token": "123456:AA",
        "bot_id": 999,
        "bot_username": "helper_bot",
        "owner_telegram_user_id": 111,
    }))
    .unwrap();
    match ready {
        ClaimStatus::Ready(bot) => {
            assert_eq!(bot.bot_id, 999);
            assert_eq!(bot.bot_username, "helper_bot");
            assert_eq!(bot.token.expose(), "123456:AA");
            assert_eq!(bot.owner_telegram_user_id, Some(111));
        }
        other => panic!("expected ready, got {other:?}"),
    }

    // `claimed` is the manager's third answer and the one a lost claim response
    // produces on retry. It is NOT an expiry: the record survives, so the token
    // is still reachable through `refresh`.
    assert!(matches!(
        claim_status_from_body(&json!({ "status": "claimed" })).unwrap(),
        ClaimStatus::AlreadyClaimed
    ));

    // The vocabularies are identical on both sides on purpose: the manager
    // signals an unknown/expired pairing with a 404, never a 200 body, so
    // `expired`/`gone` are not statuses this client accepts.
    assert!(claim_status_from_body(&json!({ "status": "expired" })).is_err());

    // A ready with no token is a protocol bug, not a pairing to celebrate.
    assert!(claim_status_from_body(&json!({ "status": "ready", "bot_id": 1 })).is_err());
    // An unknown status must NOT degrade to "pending" — that is an infinite poll.
    assert!(claim_status_from_body(&json!({ "status": "banana" })).is_err());
    assert!(claim_status_from_body(&json!({})).is_err());
}
