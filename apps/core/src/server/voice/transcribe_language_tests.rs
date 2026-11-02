use super::is_language_hint;

#[test]
fn accepts_auto_and_bcp47_tags_only() {
    for hint in ["auto", "en", "pt-BR", "zh-Hant", "yue"] {
        assert!(is_language_hint(hint), "{hint}");
    }
    let long = "a".repeat(40);
    for hint in [
        "",
        "e",
        "english",
        "en_US",
        "en-",
        "fr&engine=x",
        long.as_str(),
    ] {
        assert!(!is_language_hint(hint), "{hint}");
    }
}
