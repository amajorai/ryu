use super::language::with_dream_language;

fn base_system() -> String {
    super::dream_prompt(&[]).0
}

#[test]
fn dream_summary_and_reason_follow_a_non_english_ui_language() {
    let system = with_dream_language(base_system(), "ja");
    assert!(system.starts_with("You are Dream, Ryu's private chat-to-memory decomposer."));
    assert!(system.contains("Write \"summary\" and every \"reason\" in Japanese."));
    assert!(system.contains("in the original language of its source messages"));
    assert!(system.contains("\"category\" values exactly as given, in English"));
    let arabic = with_dream_language(base_system(), "ar");
    assert!(arabic.contains("Write \"summary\" and every \"reason\" in Arabic."));
    let german = with_dream_language(base_system(), "de_DE.UTF-8");
    assert!(german.contains("Write \"summary\" and every \"reason\" in German."));
}

#[test]
fn dream_prompt_is_unchanged_for_english() {
    let base = base_system();
    assert_eq!(with_dream_language(base.clone(), "en"), base);
    assert_eq!(with_dream_language(base.clone(), "en-US"), base);
}
