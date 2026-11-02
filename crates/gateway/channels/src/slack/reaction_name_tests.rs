use super::slack_reaction_name;

#[test]
fn unicode_reactions_become_slack_shortcodes() {
    // Slack's `reactions.add` takes names only; sending "👀" as a name was
    // refused with `invalid_name`, so the working marker never appeared.
    assert_eq!(slack_reaction_name("👀").as_deref(), Some("eyes"));
    assert_eq!(slack_reaction_name("👍").as_deref(), Some("+1"));
    assert_eq!(slack_reaction_name("❤️").as_deref(), Some("heart"));
    assert_eq!(slack_reaction_name("❌").as_deref(), Some("x"));
}

#[test]
fn shortcodes_pass_through_and_unknown_emoji_are_skipped() {
    assert_eq!(
        slack_reaction_name(":white_check_mark:").as_deref(),
        Some("white_check_mark")
    );
    assert_eq!(slack_reaction_name("+1").as_deref(), Some("+1"));
    assert_eq!(slack_reaction_name("🦀"), None);
    assert_eq!(slack_reaction_name("  "), None);
}
