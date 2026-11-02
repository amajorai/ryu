use super::*;

struct TestDeliveryChannel {
    runtime: ChannelRuntime,
}

#[async_trait::async_trait]
impl Channel for TestDeliveryChannel {
    fn name(&self) -> &'static str {
        "test"
    }

    fn runtime(&self) -> &ChannelRuntime {
        &self.runtime
    }

    async fn send_message(&self, _chat_id: &str, _text: &str) -> anyhow::Result<()> {
        Ok(())
    }

    async fn run(self: Arc<Self>, _host: Arc<dyn ChannelHost>) -> anyhow::Result<()> {
        anyhow::bail!("test channel does not run a transport")
    }
}

#[test]
fn build_request_body_includes_user_message() {
    let body = build_request_body("gpt-4o", None, "hello");
    assert_eq!(body["model"], "gpt-4o");
    assert_eq!(body["stream"], false);
    let messages = body["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["content"], "hello");
}

#[test]
fn build_request_body_prepends_system_prompt() {
    let body = build_request_body("gpt-4o", Some("be terse"), "hi");
    let messages = body["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["role"], "system");
    assert_eq!(messages[0]["content"], "be terse");
    assert_eq!(messages[1]["role"], "user");
}

#[test]
fn extract_reply_reads_first_choice() {
    let response = json!({
        "choices": [
            { "message": { "role": "assistant", "content": "the answer" } }
        ]
    });
    assert_eq!(extract_reply(&response).as_deref(), Some("the answer"));
}

#[test]
fn extract_reply_none_when_missing() {
    let response = json!({ "choices": [] });
    assert!(extract_reply(&response).is_none());
}

#[tokio::test]
async fn claimed_delivery_retries_and_completes_after_a_transient_failure() {
    let channel = Arc::new(TestDeliveryChannel {
        runtime: ChannelRuntime::new(
            reqwest::Client::new(),
            CommonChannelConfig::default(),
            PairingStore::ephemeral(),
            None,
        ),
    });
    let (delivery_id, claim) = claim_inbound_delivery(&*channel, "message-1")
        .await
        .unwrap();
    assert_eq!(claim, DeliveryClaim::Claimed);

    let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let work_attempts = Arc::clone(&attempts);
    run_claimed_delivery(channel, delivery_id, move || {
        let attempt = work_attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        async move {
            if attempt == 0 {
                ChannelTurnOutcome::Failed
            } else {
                ChannelTurnOutcome::Completed
            }
        }
    })
    .await;

    assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
}

#[tokio::test]
async fn delivery_backpressure_is_bounded_and_releases_after_completion() {
    let runtime = ChannelRuntime::new(
        reqwest::Client::new(),
        CommonChannelConfig::default(),
        PairingStore::ephemeral(),
        None,
    );
    let permits = (0..MAX_ACTIVE_DELIVERIES)
        .map(|_| runtime.try_reserve_delivery())
        .collect::<Option<Vec<_>>>()
        .expect("the configured delivery capacity should be available");
    assert!(
        runtime.try_reserve_delivery().is_none(),
        "a full webhook queue must reject before spawning another task"
    );
    drop(permits);
    assert!(runtime.try_reserve_delivery().is_some());
}

#[test]
fn thread_packing_round_trips() {
    let packed = pack_thread("C123", Some("111.222"));
    assert_eq!(packed, "C123:111.222");
    assert_eq!(unpack_thread(&packed), ("C123", Some("111.222")));

    // No thread ⇒ the chat id is unchanged and unpacks to itself.
    let bare = pack_thread("C123", None);
    assert_eq!(bare, "C123");
    assert_eq!(unpack_thread(&bare), ("C123", None));

    // An empty thread id must not produce a trailing separator.
    assert_eq!(pack_thread("C123", Some("")), "C123");
}

#[test]
fn unpack_thread_splits_on_the_last_separator() {
    // A chat id containing a colon still survives the round trip.
    let packed = pack_thread("a:b", Some("t1"));
    assert_eq!(unpack_thread(&packed), ("a:b", Some("t1")));
}

#[test]
fn env_policy_maps_the_three_legacy_states() {
    // An allowlist locks both DMs and groups to it.
    let listed = policy_from(Some(vec!["123".into()]), false);
    assert_eq!(listed.dm, DmPolicy::Allowlist);
    assert_eq!(listed.group, GroupPolicy::Allowlist);
    assert_eq!(listed.dm_allowlist, vec!["123".to_string()]);

    // ALLOW_ALL with no list opens both.
    let open = policy_from(None, true);
    assert_eq!(open.dm, DmPolicy::Open);
    assert_eq!(open.group, GroupPolicy::Open);

    // Nothing configured ⇒ DMs pair, groups stay closed (empty allowlist).
    let bare = policy_from(None, false);
    assert_eq!(bare.dm, DmPolicy::Pairing);
    assert_eq!(bare.group, GroupPolicy::Allowlist);
    assert_eq!(bare.decide_group("anything"), Decision::Deny);
}

#[test]
fn allow_all_only_accepts_explicit_enable_tokens() {
    assert!(!channel_allow_all_from(None));
    for v in ["0", "false", "off", "no", ""] {
        assert!(
            !channel_allow_all_from(Some(v)),
            "{v:?} must not open the channel"
        );
    }
    for v in ["1", "true", "yes", "on", " 1 ", "TRUE"] {
        assert!(
            channel_allow_all_from(Some(v)),
            "{v:?} should opt into open mode"
        );
    }
}

#[test]
fn reaction_learning_defaults_to_safe_opt_in_and_thumb_labels() {
    let config = ReactionLearningConfig::default();

    assert!(!config.enabled);
    assert_eq!(config.positive_emojis, vec!["👍"]);
    assert_eq!(config.negative_emojis, vec!["👎"]);
    assert!(!config.allow_group);
    assert_eq!(config.classify("👍"), Some("up"));
    assert_eq!(config.classify("👎"), Some("down"));
    assert_eq!(config.classify("❤️"), None);
}

#[test]
fn reaction_learning_accepts_configured_emoji_aliases_and_serializes_wire_names() {
    let config: ReactionLearningConfig = serde_json::from_value(json!({
        "enabled": true,
        "positive_emoji": ["❤️", "✅"],
        "negative_emojis": ["💀"],
        "group_reactions": true,
    }))
    .expect("reaction config should accept the issue's singular keys and aliases");

    assert!(config.enabled);
    assert!(config.allow_group);
    assert_eq!(config.classify("✅"), Some("up"));
    assert_eq!(config.classify("💀"), Some("down"));
    assert_eq!(config.classify("🤔"), None);

    let wire = serde_json::to_value(&config).expect("reaction config should serialize");
    assert_eq!(wire["positive_emoji"], json!(["❤️", "✅"]));
    assert_eq!(wire["negative_emoji"], json!(["💀"]));
    assert!(wire.get("positive_emojis").is_none());
}

#[test]
fn core_path_segments_escape_channel_and_provider_separators() {
    assert_eq!(
        encode_path_segment("channel:bot/chat"),
        "channel%3Abot%2Fchat"
    );
    assert_eq!(encode_path_segment("message_42"), "message_42");
}

/// Build a runtime with a given access policy, for the admission tests.
fn runtime_with(access: AccessPolicy) -> ChannelRuntime {
    ChannelRuntime::new(
        reqwest::Client::new(),
        CommonChannelConfig {
            access,
            ..Default::default()
        },
        PairingStore::ephemeral(),
        None,
    )
}

fn dm_from(sender: &str) -> InboundMessage {
    let mut m = InboundMessage::text("chat-1", "hi");
    m.sender_id = Some(sender.to_string());
    m
}

/// The read-only gate must never mint a pairing code — that is the whole
/// reason it exists rather than reusing `decide_dm`.
#[tokio::test]
async fn already_admitted_does_not_mint_a_code() {
    let runtime = runtime_with(AccessPolicy {
        dm: DmPolicy::Pairing,
        ..Default::default()
    });
    let message = dm_from("stranger");

    assert!(!runtime.already_admitted("telegram", &message).await);
    assert!(
        runtime.pairing.get("telegram", "stranger").await.is_none(),
        "the read-only check must not create pairing state"
    );

    // Once the operator approves them, the same check admits them.
    runtime.pairing.approve("telegram", "stranger").await;
    assert!(runtime.already_admitted("telegram", &message).await);
}

#[tokio::test]
async fn already_admitted_matches_the_policy_for_each_dm_mode() {
    let open = runtime_with(AccessPolicy {
        dm: DmPolicy::Open,
        ..Default::default()
    });
    assert!(open.already_admitted("t", &dm_from("anyone")).await);

    let off = runtime_with(AccessPolicy {
        dm: DmPolicy::Disabled,
        ..Default::default()
    });
    assert!(!off.already_admitted("t", &dm_from("anyone")).await);

    // A listed sender is admitted whatever the mode, exactly as the real gate.
    let listed = runtime_with(AccessPolicy {
        dm: DmPolicy::Pairing,
        dm_allowlist: vec!["vip".into()],
        ..Default::default()
    });
    assert!(listed.already_admitted("t", &dm_from("vip")).await);
    assert!(!listed.already_admitted("t", &dm_from("other")).await);
}

#[tokio::test]
async fn already_admitted_uses_the_group_rules_for_group_messages() {
    let runtime = runtime_with(AccessPolicy {
        group: GroupPolicy::Allowlist,
        group_allowlist: vec!["room-1".into()],
        // A wide-open DM policy must not leak into the group decision.
        dm: DmPolicy::Open,
        ..Default::default()
    });

    let mut allowed = InboundMessage::text("room-1", "hi");
    allowed.is_group = true;
    assert!(runtime.already_admitted("t", &allowed).await);

    let mut denied = InboundMessage::text("room-2", "hi");
    denied.is_group = true;
    assert!(
        !runtime.already_admitted("t", &denied).await,
        "an unlisted room must not inherit the open DM policy"
    );
}

#[tokio::test]
async fn reaction_feedback_ignores_unbound_provider_messages() {
    let runtime = ChannelRuntime::new(
        reqwest::Client::new(),
        CommonChannelConfig {
            channel_id: Some("telegram-bot".to_owned()),
            reaction_learning: ReactionLearningConfig {
                enabled: true,
                ..Default::default()
            },
            ..Default::default()
        },
        PairingStore::ephemeral(),
        None,
    );

    assert!(!runtime
        .record_reaction_feedback("telegram", "123", "unlinked-provider-message", "👍")
        .await
        .expect("unlinked reactions should be ignored without a Core request"));
}

#[tokio::test]
async fn disabled_reaction_learning_does_not_persist_reply_links() {
    let runtime = ChannelRuntime::new(
        reqwest::Client::new(),
        CommonChannelConfig {
            channel_id: Some("telegram-bot".to_owned()),
            reaction_learning: ReactionLearningConfig {
                enabled: false,
                ..Default::default()
            },
            ..Default::default()
        },
        PairingStore::ephemeral(),
        None,
    );

    runtime
        .bind_sent_messages(
            "telegram",
            "123",
            &["provider-42".to_owned()],
            &["assistant-98".to_owned()],
        )
        .await;

    assert_eq!(
        runtime
            .pairing
            .reply_message("telegram", "channel:telegram-bot:123", "provider-42")
            .await,
        None
    );
}

#[test]
fn inbound_identity_prefers_the_sender_id() {
    let mut m = InboundMessage::text("chat-1", "hi");
    assert_eq!(m.identity(), "chat-1");
    m.sender_id = Some("user-9".into());
    assert_eq!(m.identity(), "user-9");
}

#[test]
fn bot_profile_clips_to_platform_limits() {
    let profile = BotProfile {
        name: Some("n".repeat(100)),
        short_bio: Some("s".repeat(300)),
        description: Some("d".repeat(900)),
    };
    let clipped = profile.clipped();
    assert_eq!(clipped.name.unwrap().chars().count(), 64);
    assert_eq!(clipped.short_bio.unwrap().chars().count(), 120);
    assert_eq!(clipped.description.unwrap().chars().count(), 512);
    assert!(BotProfile::default().is_empty());
}

#[test]
fn core_turn_request_outlives_the_shared_client_timeout() {
    let shared_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap();
    let runtime = ChannelRuntime::new(
        shared_client,
        CommonChannelConfig {
            channel_id: Some("bot-a".to_owned()),
            ..Default::default()
        },
        PairingStore::ephemeral(),
        None,
    );
    let request = runtime
        .core_run_request(&json!({ "conversation_id": "chat-1" }))
        .build()
        .unwrap();
    assert_eq!(request.url().path(), "/api/channels/run");
    assert_eq!(
        request.timeout(),
        Some(&CORE_TURN_TIMEOUT),
        "a slow agent turn must not be cut at the shared client's 60 s timeout"
    );
}

#[test]
fn store_backed_channel_sessions_are_namespaced_per_bot() {
    let runtime = ChannelRuntime::new(
        reqwest::Client::new(),
        CommonChannelConfig {
            channel_id: Some("bot-a".to_owned()),
            ..Default::default()
        },
        PairingStore::ephemeral(),
        None,
    );
    assert_eq!(
        runtime.core_conversation_id("discord:guild-1:channel-1"),
        "channel:bot-a:discord:guild-1:channel-1"
    );
    assert!(runtime.routes_via_core());

    let legacy = ChannelRuntime::new(
        reqwest::Client::new(),
        CommonChannelConfig::default(),
        PairingStore::ephemeral(),
        None,
    );
    assert_eq!(legacy.core_conversation_id("chat-1"), "chat-1");
}

/// Channel allowlist env reading. Run as ONE sequential test because it
/// mutates process-global env; parallel sub-tests would race.
#[test]
fn channel_allowlist_reads_env() {
    std::env::remove_var("RYU_CHANNEL_ALLOWED_USERS");
    std::env::remove_var("RYU_CHANNEL_ALLOWED_USERS_TELEGRAM");

    assert!(channel_allowlist("telegram").is_none());

    std::env::set_var("RYU_CHANNEL_ALLOWED_USERS_TELEGRAM", "123, 456");
    assert_eq!(
        channel_allowlist("telegram"),
        Some(vec!["123".to_string(), "456".to_string()])
    );
    // A different platform with no list of its own sees nothing.
    assert!(channel_allowlist("slack").is_none());

    // Global applies when per-platform is unset.
    std::env::remove_var("RYU_CHANNEL_ALLOWED_USERS_TELEGRAM");
    std::env::set_var("RYU_CHANNEL_ALLOWED_USERS", "777");
    assert_eq!(channel_allowlist("telegram"), Some(vec!["777".to_string()]));

    // Per-platform OVERRIDES global.
    std::env::set_var("RYU_CHANNEL_ALLOWED_USERS_TELEGRAM", "123");
    assert_eq!(channel_allowlist("telegram"), Some(vec!["123".to_string()]));

    std::env::remove_var("RYU_CHANNEL_ALLOWED_USERS");
    std::env::remove_var("RYU_CHANNEL_ALLOWED_USERS_TELEGRAM");
}
