use super::language::{feed_cache_key, recommendation_system};

#[test]
fn recommendation_system_names_a_non_english_ui_language() {
    let japanese = recommendation_system("ja");
    assert!(japanese.starts_with("You are Ryu's Marketplace recommendation adapter."));
    assert!(japanese.contains("Write every sentence meant for the user in Japanese."));
    assert!(japanese.contains("JSON keys"));
    assert!(recommendation_system("de-DE").contains("for the user in German."));
    assert!(recommendation_system("ar").contains("for the user in Arabic."));
}

#[test]
fn recommendation_system_is_unchanged_for_english() {
    let english = recommendation_system("en");
    assert!(!english.contains("Write every sentence"));
    assert_eq!(english, recommendation_system("en-US"));
}

#[test]
fn feed_cache_key_differs_by_ui_language() {
    let key = |locale| feed_cache_key("gw", "scope", "rev", "profile", "settings", locale);
    assert_ne!(key("ja"), key("en"));
    assert_eq!(key("ja"), key("ja-JP"));
    assert_eq!(key("en"), key("en-GB"));
    assert_ne!(key("ar"), key("de"));
}
