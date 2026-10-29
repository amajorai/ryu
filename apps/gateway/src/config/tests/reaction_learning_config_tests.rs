use super::{CommonChannelFileConfig, TelegramChannelConfig, TelegramChannelOptionsFileConfig};

#[test]
fn telegram_channel_toml_round_trip_preserves_reaction_learning() {
    let mut common = CommonChannelFileConfig::default();
    common.reaction_learning.enabled = true;
    common.reaction_learning.positive_emojis = vec!["👍".to_owned(), "❤️".to_owned()];
    common.reaction_learning.negative_emojis = vec!["👎".to_owned(), "💀".to_owned()];
    common.reaction_learning.allow_group = true;

    let authored = TelegramChannelConfig {
        token: "[REDACTED_SECRET]".to_owned(),
        common,
        options: TelegramChannelOptionsFileConfig::default(),
    };
    let text = toml::to_string(&authored).expect("reaction config should serialize");
    let parsed: TelegramChannelConfig =
        toml::from_str(&text).expect("reaction config should parse after serialization");

    assert!(parsed.common.reaction_learning.enabled);
    assert_eq!(
        parsed.common.reaction_learning.positive_emojis,
        vec!["👍", "❤️"]
    );
    assert_eq!(
        parsed.common.reaction_learning.negative_emojis,
        vec!["👎", "💀"]
    );
    assert!(parsed.common.reaction_learning.allow_group);
}

#[test]
fn telegram_channel_toml_accepts_issue_style_reaction_keys() {
    let parsed: TelegramChannelConfig = toml::from_str(
        r#"
token = "[REDACTED_SECRET]"

[reaction_learning]
enabled = true
positive_emoji = ["👍", "🎉"]
negative_emoji = ["👎", "😴"]
allow_group = false
"#,
    )
    .expect("issue-style reaction settings should parse");

    assert!(parsed.common.reaction_learning.enabled);
    assert_eq!(
        parsed.common.reaction_learning.positive_emojis,
        vec!["👍", "🎉"]
    );
    assert_eq!(
        parsed.common.reaction_learning.negative_emojis,
        vec!["👎", "😴"]
    );
    assert!(!parsed.common.reaction_learning.allow_group);
}
