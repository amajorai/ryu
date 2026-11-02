use super::telegram_reaction;

#[test]
fn bot_reactions_pass_through_and_drop_variation_selectors() {
    assert_eq!(telegram_reaction("👍"), Some("👍"));
    assert_eq!(telegram_reaction(" 👀 "), Some("👀"));
    assert_eq!(telegram_reaction("❤️"), Some("❤"));
    assert_eq!(telegram_reaction("❤️‍🔥"), Some("❤\u{200d}🔥"));
}

#[test]
fn common_emoji_outside_the_bot_set_map_to_the_nearest_allowed_one() {
    // `setMessageReaction` rejects these outright, which is why the old ✅
    // completion marker never landed and left 👀 on every message.
    assert_eq!(telegram_reaction("✅"), Some("👌"));
    assert_eq!(telegram_reaction("❌"), Some("👎"));
    assert_eq!(telegram_reaction("😂"), Some("🤣"));
    assert_eq!(telegram_reaction("🥳"), Some("🎉"));
}

#[test]
fn unknown_emoji_are_skipped_rather_than_sent() {
    assert_eq!(telegram_reaction("🦀"), None);
    assert_eq!(telegram_reaction(""), None);
}
