use super::*;

/// The shared knobs are `#[serde(flatten)]`-ed, so an EXISTING `gateway.toml`
/// — which spells `model`/`agent_id`/`core_url` directly under the channel
/// table — must still parse, and every key it does not mention must land on
/// the documented default. This is the whole backwards-compatibility contract
/// for the config file.
#[test]
fn legacy_channel_table_still_parses_with_defaults() {
    let cfg: TelegramChannelConfig = toml::from_str(
        r#"
            token = "123:ABC"
            model = "gpt-4o-mini"
            agent_id = "acp:pi"
            core_url = "http://127.0.0.1:9999"
            group_reply_mode = "all"
            "#,
    )
    .expect("a pre-existing telegram table must still parse");

    assert_eq!(cfg.token, "123:ABC");
    assert_eq!(cfg.common.model, "gpt-4o-mini");
    assert_eq!(cfg.common.agent_id.as_deref(), Some("acp:pi"));
    assert_eq!(cfg.common.core_url, "http://127.0.0.1:9999");
    assert_eq!(cfg.common.group_reply_mode, GroupReplyMode::All);

    // Unmentioned knobs default: nothing is silently switched off, and the
    // access policy stays unset so the legacy env allowlist keeps deciding.
    assert!(cfg.common.typing_indicator);
    assert!(cfg.common.publish_commands);
    assert!(cfg.common.rich_text);
    assert!(!cfg.common.streaming);
    assert_eq!(cfg.common.voice_reply, VoiceReplyMode::Never);
    assert!(cfg.common.dm_policy.is_none());
    assert!(cfg.common.group_policy.is_none());
    assert!(cfg.common.dm_allowlist.is_empty());
    assert!(cfg.common.profile_name.is_none());
}

/// The new knobs are read from the same flat namespace as the old ones.
#[test]
fn new_channel_knobs_parse_from_the_channel_table() {
    let cfg: DiscordChannelConfig = toml::from_str(
        r#"
            token = "bot-token"
            channel_ids = ["c1", "c2"]
            thread_replies = true
            dm_policy = "open"
            group_policy = "disabled"
            dm_allowlist = ["u1"]
            typing_indicator = false
            publish_commands = false
            rich_text = false
            streaming = true
            voice_reply = "always"
            profile_name = "Ryu"
            profile_short_bio = "your agent"
            "#,
    )
    .expect("the new knobs must parse");

    assert!(cfg.thread_replies);
    assert_eq!(cfg.common.dm_policy, Some(DmPolicy::Open));
    assert_eq!(cfg.common.group_policy, Some(GroupPolicy::Disabled));
    assert_eq!(cfg.common.dm_allowlist, vec!["u1".to_string()]);
    assert!(!cfg.common.typing_indicator);
    assert!(!cfg.common.publish_commands);
    assert!(!cfg.common.rich_text);
    assert!(cfg.common.streaming);
    assert_eq!(cfg.common.voice_reply, VoiceReplyMode::Always);
    assert_eq!(cfg.common.profile_name.as_deref(), Some("Ryu"));
}

/// BlueBubbles needs only the bridge's URL + password; the rest defaults, and
/// the Private-API-only verbs stay off until the operator says the helper is
/// installed.
#[test]
fn bluebubbles_defaults_are_conservative() {
    let cfg: BlueBubblesChannelConfig = toml::from_str(
        r#"
            server_url = "http://192.168.1.10:1234"
            password = "hunter2"
            "#,
    )
    .expect("minimal bluebubbles table must parse");

    assert_eq!(cfg.webhook_bind, default_bluebubbles_bind());
    assert_eq!(cfg.webhook_path, "/webhooks/bluebubbles");
    assert!(!cfg.private_api);
    assert!(!cfg.send_read_receipts);
    assert_eq!(cfg.common.model, default_channel_model());
}

/// WhatsApp's own read receipts default ON — the bot is about to reply, so
/// withholding the blue tick only makes it look unresponsive.
#[test]
fn whatsapp_read_receipts_default_on() {
    let cfg: WhatsAppChannelConfig = toml::from_str(
        r#"
            access_token = "tok"
            phone_number_id = "123"
            verify_token = "verify"
            "#,
    )
    .expect("minimal whatsapp table must parse");
    assert!(cfg.send_read_receipts);
    assert_eq!(cfg.graph_version, default_whatsapp_graph_version());
}

/// A populated channel table must survive `save()` → `load()`. Flattened
/// structs are the shape TOML is fussiest about (a nested table after a
/// value is a hard error), so this is the guard that the flatten is safe.
#[test]
fn populated_channels_survive_a_toml_roundtrip() {
    let mut cfg = GatewayConfig::default();
    cfg.channels.telegram = Some(TelegramChannelConfig {
        token: "123:ABC".to_string(),
        common: CommonChannelFileConfig {
            agent_id: Some("acp:pi".to_string()),
            system_prompt: Some("be terse".to_string()),
            dm_policy: Some(DmPolicy::Allowlist),
            dm_allowlist: vec!["u1".to_string()],
            streaming: true,
            voice_reply: VoiceReplyMode::Mirror,
            profile_name: Some("Ryu".to_string()),
            ..CommonChannelFileConfig::default()
        },
        options: TelegramChannelOptionsFileConfig::default(),
    });
    cfg.channels.bluebubbles = Some(BlueBubblesChannelConfig {
        server_url: "http://mac:1234".to_string(),
        password: "pw".to_string(),
        webhook_bind: default_bluebubbles_bind(),
        webhook_path: default_bluebubbles_path(),
        private_api: true,
        send_read_receipts: true,
        mention_patterns: Vec::new(),
        home_channel: None,
        common: CommonChannelFileConfig::default(),
    });

    let text = toml::to_string_pretty(&cfg).expect("serialize channels");
    let back: GatewayConfig = toml::from_str(&text).expect("re-parse channels");

    let telegram = back.channels.telegram.expect("telegram survives");
    assert_eq!(telegram.token, "123:ABC");
    assert_eq!(telegram.common.agent_id.as_deref(), Some("acp:pi"));
    assert_eq!(telegram.common.dm_policy, Some(DmPolicy::Allowlist));
    assert_eq!(telegram.common.dm_allowlist, vec!["u1".to_string()]);
    assert!(telegram.common.streaming);
    assert_eq!(telegram.common.voice_reply, VoiceReplyMode::Mirror);
    assert_eq!(telegram.common.profile_name.as_deref(), Some("Ryu"));

    let bb = back.channels.bluebubbles.expect("bluebubbles survives");
    assert_eq!(bb.server_url, "http://mac:1234");
    assert!(bb.private_api);
}

/// Env parsing of the new knobs. One sequential test because it mutates
/// process-global env; parallel sub-tests would race.
#[test]
fn channel_env_reads_the_new_knobs() {
    for key in [
        "TESTCHAN_DM_POLICY",
        "TESTCHAN_GROUP_POLICY",
        "TESTCHAN_VOICE_REPLY",
        "TESTCHAN_TYPING_INDICATOR",
        "TESTCHAN_STREAMING",
        "TESTCHAN_DM_ALLOWLIST",
        "TESTCHAN_BOT_NAME",
        "TESTCHAN_MODEL",
        "TESTCHAN_PROACTIVE_OPENING",
        "TESTCHAN_PROACTIVE_TARGET",
    ] {
        std::env::remove_var(key);
    }

    // Nothing set ⇒ the config-file values (here, the defaults) survive.
    let bare = common_channel_from_env("TESTCHAN", None);
    assert_eq!(bare.model, default_channel_model());
    assert!(bare.dm_policy.is_none());
    assert!(bare.typing_indicator);
    assert_eq!(bare.voice_reply, VoiceReplyMode::Never);

    std::env::set_var("TESTCHAN_DM_POLICY", "OPEN");
    std::env::set_var("TESTCHAN_GROUP_POLICY", "open");
    std::env::set_var("TESTCHAN_VOICE_REPLY", "mirror");
    std::env::set_var("TESTCHAN_TYPING_INDICATOR", "false");
    std::env::set_var("TESTCHAN_STREAMING", "1");
    std::env::set_var("TESTCHAN_DM_ALLOWLIST", "u1, u2 ,");
    std::env::set_var("TESTCHAN_BOT_NAME", "Ryu");
    std::env::set_var("TESTCHAN_PROACTIVE_OPENING", "true");
    std::env::set_var("TESTCHAN_PROACTIVE_TARGET", "chat-1");
    // Blank is treated as unset, not as an empty model.
    std::env::set_var("TESTCHAN_MODEL", "   ");

    let loaded = common_channel_from_env("TESTCHAN", None);
    assert_eq!(loaded.dm_policy, Some(DmPolicy::Open));
    assert_eq!(loaded.group_policy, Some(GroupPolicy::Open));
    assert_eq!(loaded.voice_reply, VoiceReplyMode::Mirror);
    assert!(!loaded.typing_indicator);
    assert!(loaded.streaming);
    assert_eq!(
        loaded.dm_allowlist,
        vec!["u1".to_string(), "u2".to_string()]
    );
    assert_eq!(loaded.profile_name.as_deref(), Some("Ryu"));
    assert_eq!(loaded.model, default_channel_model());
    assert!(loaded.proactive_opening);
    assert_eq!(loaded.proactive_target.as_deref(), Some("chat-1"));

    // An unrecognised value is ignored rather than guessed at, so the
    // config-file value keeps winning.
    std::env::set_var("TESTCHAN_DM_POLICY", "sometimes");
    let existing = CommonChannelFileConfig {
        dm_policy: Some(DmPolicy::Disabled),
        ..CommonChannelFileConfig::default()
    };
    let layered = common_channel_from_env("TESTCHAN", Some(&existing));
    assert_eq!(layered.dm_policy, Some(DmPolicy::Disabled));

    for key in [
        "TESTCHAN_DM_POLICY",
        "TESTCHAN_GROUP_POLICY",
        "TESTCHAN_VOICE_REPLY",
        "TESTCHAN_TYPING_INDICATOR",
        "TESTCHAN_STREAMING",
        "TESTCHAN_DM_ALLOWLIST",
        "TESTCHAN_BOT_NAME",
        "TESTCHAN_MODEL",
        "TESTCHAN_PROACTIVE_OPENING",
        "TESTCHAN_PROACTIVE_TARGET",
    ] {
        std::env::remove_var(key);
    }
}
