use super::*;
use crate::pairing::Decision;
use crate::CommonChannelConfig;

fn make_cfg(token: &str, channel_ids: Vec<String>) -> DiscordChannelConfig {
    DiscordChannelConfig {
        token: token.to_string(),
        channel_ids,
        thread_replies: false,
        options: DiscordChannelOptions::default(),
        common: CommonChannelConfig {
            model: "gpt-4o".to_string(),
            ..Default::default()
        },
    }
}

fn build(cfg: DiscordChannelConfig) -> anyhow::Result<DiscordChannel> {
    DiscordChannel::new(cfg, reqwest::Client::new(), PairingStore::ephemeral())
}

fn msg(content: &str, mentions: Vec<&str>) -> DiscordMessage {
    DiscordMessage {
        id: "1".to_string(),
        channel_id: "chan".to_string(),
        guild_id: Some("guild".to_string()),
        content: content.to_string(),
        author: DiscordUser {
            id: "user-1".to_string(),
            username: "Ada".to_string(),
            bot: Some(false),
        },
        mentions: mentions
            .into_iter()
            .map(|id| DiscordUser {
                id: id.to_string(),
                username: String::new(),
                bot: None,
            })
            .collect(),
        member: None,
        attachments: Vec::new(),
    }
}

const BOT_ID: &str = "999";

#[test]
fn ignores_bot_authored_messages() {
    let mut message = msg("hi", vec![]);
    message.author.bot = Some(true);
    assert!(decide_reply(&message, BOT_ID, GroupReplyMode::All).is_none());
}

#[test]
fn mentions_mode_ignores_unaddressed_message() {
    let message = msg("just chatting", vec![]);
    assert!(decide_reply(&message, BOT_ID, GroupReplyMode::Mentions).is_none());
}

#[test]
fn mentions_mode_replies_when_mentioned_and_strips_mention() {
    let message = msg("<@999> what is 2+2", vec![BOT_ID]);
    let routed = decide_reply(&message, BOT_ID, GroupReplyMode::Mentions);
    // The speaker is no longer prefixed into the text — it travels as
    // `author_name` on the inbound message instead.
    assert_eq!(routed.as_deref(), Some("what is 2+2"));
}

#[test]
fn mentions_mode_detects_nickname_mention_form() {
    // `<@!id>` is the nickname mention form; both must be recognised/stripped.
    let message = msg("<@!999> hello", vec![]);
    let routed = decide_reply(&message, BOT_ID, GroupReplyMode::Mentions);
    assert_eq!(routed.as_deref(), Some("hello"));
}

#[test]
fn all_mode_replies_to_every_message() {
    let message = msg("just chatting", vec![]);
    let routed = decide_reply(&message, BOT_ID, GroupReplyMode::All);
    assert_eq!(routed.as_deref(), Some("just chatting"));
}

#[test]
fn role_allowlist_filters_guild_messages() {
    let mut message = msg("role gated", vec![]);
    message.member = Some(DiscordMember {
        roles: vec!["role-allowed".to_string()],
    });
    let options = DiscordChannelOptions {
        allowed_roles: vec!["role-allowed".to_string()],
        ..Default::default()
    };
    assert_eq!(
        decide_reply_with_options(&message, BOT_ID, GroupReplyMode::All, false, &options)
            .as_deref(),
        Some("role gated")
    );
    message.member = Some(DiscordMember {
        roles: vec!["role-other".to_string()],
    });
    assert!(
        decide_reply_with_options(&message, BOT_ID, GroupReplyMode::All, false, &options).is_none()
    );
}

#[test]
fn empty_bot_id_disables_mention_detection() {
    let message = msg("<@999> hi", vec!["999"]);
    assert!(decide_reply(&message, "", GroupReplyMode::Mentions).is_none());
    // All mode still routes (mention detection irrelevant).
    assert_eq!(
        decide_reply(&message, "", GroupReplyMode::All).as_deref(),
        Some("<@999> hi")
    );
}

#[test]
fn media_only_message_is_routed_with_empty_text() {
    // A voice note has no content; dropping it here would make transcription
    // unreachable, so it must survive with empty text.
    let mut message = msg("", vec![]);
    message.attachments.push(DiscordAttachment {
        url: "https://cdn.discordapp.com/a/voice.ogg".to_string(),
        filename: "voice-message.ogg".to_string(),
        content_type: Some("audio/ogg".to_string()),
        size: Some(1024),
        duration_secs: Some(3.5),
    });
    assert_eq!(
        decide_reply(&message, BOT_ID, GroupReplyMode::All).as_deref(),
        Some("")
    );
    // With neither text nor media there is nothing to route.
    let empty = msg("   ", vec![]);
    assert!(decide_reply(&empty, BOT_ID, GroupReplyMode::All).is_none());
}

#[test]
fn new_rejects_empty_token() {
    assert!(build(make_cfg("  ", vec!["123".to_string()])).is_err());
}

#[test]
fn new_rejects_missing_channels() {
    assert!(build(make_cfg("abc", vec![])).is_ok());
}

#[test]
fn builds_auth_header_and_metadata() {
    let mut cfg = make_cfg("secret", vec!["123".to_string()]);
    cfg.common.system_prompt = Some("be nice".to_string());
    let channel = build(cfg).unwrap();
    assert_eq!(channel.auth_header(), "Bot secret");
    assert_eq!(channel.name(), "discord");
    assert_eq!(channel.model(), "gpt-4o");
    assert_eq!(channel.system_prompt(), Some("be nice"));
}

#[test]
fn new_stores_agent_id_and_core_url() {
    let mut cfg = make_cfg("tok:1", vec!["chan1".to_string()]);
    cfg.common.agent_id = Some("acp:pi".to_string());
    let channel = build(cfg).unwrap();
    assert_eq!(channel.runtime.cfg.agent_id.as_deref(), Some("acp:pi"));
    assert_eq!(channel.runtime.cfg.core_url, "http://127.0.0.1:7980");
    assert!(channel.runtime.routes_via_core());
}

/// Configuring a channel to poll IS the operator consent the group allowlist
/// asks for. Without this the default policy (allowlist, empty) would deny
/// every message in the very channels the bot was told to watch.
#[test]
fn watched_channels_are_admitted_by_the_group_gate() {
    let channel = build(make_cfg("t", vec!["chan1".to_string()])).unwrap();
    let access = &channel.runtime.cfg.access;
    assert_eq!(access.decide_group("chan1"), Decision::Allow);
    // An unwatched channel is still refused.
    assert_eq!(access.decide_group("chan2"), Decision::Deny);
}

#[test]
fn caps_declare_only_what_the_poll_transport_can_do() {
    let channel = build(make_cfg("t", vec!["c".to_string()])).unwrap();
    let caps = channel.caps();
    assert!(caps.typing && caps.threads && caps.voice && caps.attachments && caps.reactions);
    // Discord content already renders our markdown; there is no separate rich
    // surface to claim.
    assert!(!caps.rich_text);
    // Slash commands need an interactions endpoint or a Gateway socket.
    assert!(caps.command_menu);
    assert!(!caps.streaming);
    // The indicator lasts 10s, so it must be re-asserted under that.
    assert!(channel.typing_interval() < Duration::from_secs(10));
}

/// A thread IS a channel, so every outbound verb must address the thread when
/// the conversation key carries one — using the parent would silently defeat
/// threaded replies.
#[test]
fn conversation_key_resolves_to_the_thread() {
    let packed = pack_thread("111", Some("222"));
    assert_eq!(packed, "111:222");
    assert_eq!(target_channel(&packed), "222");
    // An unthreaded key addresses the channel itself.
    assert_eq!(target_channel("111"), "111");
}

#[test]
fn existing_thread_inbound_key_keeps_parent_before_thread() {
    let packed = inbound_chat_id("thread-222", Some("channel-111"));
    assert_eq!(packed, "channel-111:thread-222");
    assert_eq!(target_channel(&packed), "thread-222");
    assert_eq!(inbound_chat_id("channel-111", None), "channel-111");
}

#[test]
fn thread_names_are_sanitised_and_clipped() {
    assert_eq!(thread_name("  hello   world\n", "en"), "hello world");
    // Control characters never reach Discord.
    assert_eq!(thread_name("a\u{7}b", "en"), "ab");
    // Long prompts are clipped to a readable single line.
    let long = thread_name(&"x".repeat(200), "en");
    assert_eq!(long.chars().count(), THREAD_NAME_CHARS);
    const {
        assert!(THREAD_NAME_CHARS <= 100, "Discord caps thread names at 100");
    }
    // An uncaptioned image must still yield a nameable thread.
    assert_eq!(thread_name("   ", "en"), "Ryu reply");
    assert_eq!(thread_name("", "xx"), "Ryu reply");
    // ...named in the reader's language.
    crate::i18n::tests::with_translation(
        "ja",
        i18n::messages::DISCORD_THREAD_FALLBACK_MESSAGE,
        "Ryu の返信",
    );
    assert_eq!(thread_name("", "ja"), "Ryu の返信");
}

#[test]
fn interactions_carry_the_users_locale() {
    assert_eq!(
        interaction_locale(&json!({ "locale": "ja" })).as_deref(),
        Some("ja")
    );
    assert_eq!(interaction_locale(&json!({ "locale": "" })), None);
    assert_eq!(interaction_locale(&json!({})), None);
}

#[test]
fn emoji_encoding_keeps_the_custom_emoji_separator() {
    // A multi-byte unicode emoji is fully percent-encoded.
    assert_eq!(encode_emoji("👍"), "%F0%9F%91%8D");
    // A custom emoji is `name:id`; encoding the colon would 400.
    assert_eq!(encode_emoji("ryu:12345"), "ryu:12345");
    assert_eq!(encode_emoji("a b"), "a%20b");
}

#[test]
fn long_replies_split_on_line_boundaries() {
    let text = format!("{}\n{}", "a".repeat(1500), "b".repeat(900));
    let chunks = split_message(&text, MAX_MESSAGE_CHARS);
    assert_eq!(
        chunks.len(),
        2,
        "the two lines must not be merged over 2000"
    );
    assert!(chunks
        .iter()
        .all(|c| c.chars().count() <= MAX_MESSAGE_CHARS));
    assert!(chunks[0].starts_with('a') && chunks[1].starts_with('b'));

    // A single overlong line has no boundary to split on, so it is hard-split.
    let one_line = "z".repeat(4100);
    let hard = split_message(&one_line, MAX_MESSAGE_CHARS);
    assert_eq!(hard.len(), 3);
    assert_eq!(hard.iter().map(|c| c.chars().count()).sum::<usize>(), 4100);

    // Short text is one chunk; blank text produces no request at all.
    assert_eq!(
        split_message("hi", MAX_MESSAGE_CHARS),
        vec!["hi".to_string()]
    );
    assert!(split_message("   \n\n", MAX_MESSAGE_CHARS).is_empty());
}

#[test]
fn voice_payload_maps_the_file_part_to_an_attachment() {
    let payload = voice_payload(VOICE_FILENAME);
    assert_eq!(payload["attachments"][0]["id"], 0);
    assert_eq!(payload["attachments"][0]["filename"], VOICE_FILENAME);
}

/// Reply text is model output a member (or injected content) can steer, so no
/// message create may let Discord parse `@everyone`, `@here` or role mentions
/// out of it with the bot's permissions. User mentions stay pingable.
#[test]
fn message_creates_never_parse_everyone_here_or_role_mentions() {
    let content = "@everyone @here <@&123> verify at https://evil.example <@456>";
    let text = message_payload(content);
    assert_eq!(text["content"], content);
    for payload in [text, voice_payload(VOICE_FILENAME)] {
        let parse = payload["allowed_mentions"]["parse"]
            .as_array()
            .expect("every message create must carry allowed_mentions.parse");
        assert_eq!(parse, &vec![json!("users")]);
        assert!(payload["allowed_mentions"].get("roles").is_none());
    }
}

#[test]
fn parses_messages_response() {
    let raw = json!([
        {
            "id": "555",
            "content": "hello bot",
            "author": { "bot": false }
        },
        {
            "id": "556",
            "content": "i am a bot",
            "author": { "bot": true }
        }
    ]);
    let parsed: Vec<DiscordMessage> = serde_json::from_value(raw).unwrap();
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].id, "555");
    assert_eq!(parsed[0].content, "hello bot");
    assert_eq!(parsed[0].author.bot, Some(false));
    assert_eq!(parsed[1].author.bot, Some(true));
    assert!(parsed[0].attachments.is_empty());
}

#[test]
fn parses_attachments_into_kernel_shape() {
    let raw = json!({
        "id": "1",
        "content": "",
        "author": { "id": "u1", "username": "Ada", "bot": false },
        "attachments": [
            {
                "url": "https://cdn.discordapp.com/a/voice-message.ogg",
                "filename": "voice-message.ogg",
                "content_type": "audio/ogg",
                "size": 4096,
                "duration_secs": 2.25
            },
            {
                "url": "https://cdn.discordapp.com/a/cat.png",
                "filename": "cat.png",
                "content_type": "image/png",
                "size": 9001
            }
        ]
    });
    let message: DiscordMessage = serde_json::from_value(raw).unwrap();
    let parsed = parse_attachments(&message);
    assert_eq!(parsed.len(), 2);

    // `duration_secs` marks a true voice message, which is what gets transcribed.
    assert_eq!(parsed[0].resolved_kind(), AttachmentKind::Voice);
    assert!(parsed[0].resolved_kind().is_speech());
    assert_eq!(parsed[0].safe_filename(), "voice-message.ogg");
    assert_eq!(parsed[0].size, Some(4096));
    assert!(
        parsed[0].file_id.is_none(),
        "discord serves a direct CDN url"
    );

    // Everything else is classified from its MIME type and never transcribed.
    assert_eq!(parsed[1].resolved_kind(), AttachmentKind::Image);
    assert!(!parsed[1].resolved_kind().is_speech());
}

fn channel_ref(raw: Value) -> DiscordChannelRef {
    serde_json::from_value(raw).unwrap()
}

#[test]
fn a_category_parent_is_not_a_thread_parent() {
    let text_channel = channel_ref(json!({ "id": "c1", "type": 0, "parent_id": "category-1" }));
    assert_eq!(thread_parent(&text_channel), None);
    let untyped = channel_ref(json!({ "id": "c1", "parent_id": "category-1" }));
    assert_eq!(thread_parent(&untyped), None);
}

#[test]
fn thread_types_resolve_to_their_parent_channel() {
    for kind in [10, 11, 12] {
        let thread = channel_ref(json!({ "id": "t1", "type": kind, "parent_id": "c1" }));
        assert_eq!(thread_parent(&thread).as_deref(), Some("c1"), "type {kind}");
    }
    let orphan = channel_ref(json!({ "id": "t1", "type": 11 }));
    assert_eq!(thread_parent(&orphan), None);
}

#[test]
fn ordinary_channels_are_cached_so_they_are_looked_up_once() {
    let mut cache = ThreadParents::new();
    remember_thread_parent(&mut cache, "c1", None);
    remember_thread_parent(&mut cache, "t1", Some("c1".to_owned()));
    // `Some(None)` is a cached "not a thread", distinct from "never asked".
    assert_eq!(cache.get("c1"), Some(&None));
    assert_eq!(cache.get("t1"), Some(&Some("c1".to_owned())));
    assert_eq!(cache.get("c2"), None);

    for index in 0..THREAD_PARENT_CACHE_MAX {
        remember_thread_parent(&mut cache, &format!("x{index}"), None);
    }
    assert!(cache.len() <= THREAD_PARENT_CACHE_MAX);
    // Updating a known channel never evicts the rest.
    let before = cache.len();
    let known = cache.keys().next().cloned().unwrap();
    remember_thread_parent(&mut cache, &known, None);
    assert_eq!(cache.len(), before);
}
