use super::language::with_profile_language;

const PROMPT: &str = "Build a private profile of me. Use only these exact tool ids: web.search.";

#[test]
fn profile_prompt_names_a_non_english_ui_language() {
    let prompt = with_profile_language(PROMPT.to_owned(), "ja");
    assert!(prompt.starts_with(PROMPT));
    assert!(prompt.contains("Write every sentence meant for the user in Japanese."));
    assert!(prompt.contains("RYU_AGENT_SUGGESTIONS_JSON marker and the tool ids exactly as given"));
    let german = with_profile_language(PROMPT.to_owned(), "de");
    assert!(german.contains("Write every sentence meant for the user in German."));
    let arabic = with_profile_language(PROMPT.to_owned(), "ar-EG");
    assert!(arabic.contains("Write every sentence meant for the user in Arabic."));
}

#[test]
fn profile_prompt_is_unchanged_for_english() {
    assert_eq!(with_profile_language(PROMPT.to_owned(), "en"), PROMPT);
    assert_eq!(with_profile_language(PROMPT.to_owned(), "en-GB"), PROMPT);
}
