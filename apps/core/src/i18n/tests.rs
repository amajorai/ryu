use super::locale::{
    fixed_locale_from_preference, from_accept_language, locale_from_preference, resolve,
    sentence_separator, stored, text_direction,
};
use super::render::substitute;
use super::*;

#[test]
fn templates_reproduce_their_icu_source() {
    let message = Message::new(messages::POLICY_USED_USER_MESSAGE);
    assert_eq!(
        message.source(),
        "Used {used} of {limit} for user {subject}."
    );
    assert_eq!(
        Message::new(messages::APPROVAL_NEEDED_TITLE_MESSAGE).source(),
        "Approval needed"
    );
}

#[test]
fn every_core_template_is_in_the_generated_catalog() {
    for template in messages::all() {
        let source = Message::new(*template).source().to_owned();
        assert!(
            catalog::lookup("__none__", &source).is_none(),
            "a locale that does not exist never matches"
        );
        // English renders the source itself when no arguments are needed.
        if !source.contains('{') {
            assert_eq!(Message::new(*template).render("en"), source);
        }
    }
}

#[test]
fn renders_translations_from_the_catalog_and_falls_back_to_english() {
    let title = Message::new(messages::APPROVAL_NEEDED_TITLE_MESSAGE);
    assert_eq!(title.render("en"), "Approval needed");
    // The catalog is generated from packages/i18n/locales, which translates
    // this title; an unsupported locale gets English.
    assert_ne!(title.render("ja"), "Approval needed");
    assert_eq!(title.render("ja-JP"), title.render("ja"));
    assert_eq!(title.render("xx"), "Approval needed");
}

#[test]
fn numbers_follow_the_locale() {
    let message = Message::new(messages::POLICY_USED_MESSAGE)
        .number("used", 1_234_567.5, 0, 2)
        .number("limit", 2_000_000.0, 0, 2);
    assert_eq!(message.render("en"), "Used 1,234,567.5 of 2,000,000.");
    let de = Message::new(messages::POLICY_USED_MESSAGE)
        .number("used", 1234.5, 0, 2)
        .number("limit", 1234.0, 0, 0);
    let rendered = de.render("de");
    assert!(rendered.contains("1.234,5"), "{rendered}");
}

#[test]
fn number_formatting_matches_intl() {
    use super::number::format;
    assert_eq!(format("en", 1234.5, 0, 2), "1,234.5");
    assert_eq!(format("de", 12_345_678.25, 0, 2), "12.345.678,25");
    assert_eq!(format("es", 1234.5, 0, 2), "1234,5");
    assert_eq!(format("es", 1_234_567.0, 0, 0), "1.234.567");
    assert_eq!(format("fr", 1234.5, 0, 2), "1\u{202f}234,5");
    assert_eq!(format("ru", 1234.0, 0, 0), "1\u{a0}234");
    assert_eq!(format("hi", 12_345_678.25, 0, 2), "1,23,45,678.25");
    assert_eq!(format("ar", -1234.5, 0, 2), "\u{200e}-1,234.5");
    assert_eq!(format("ja", 0.5, 1, 1), "0.5");
    assert_eq!(format("en", 12.0, 2, 2), "12.00");
    assert_eq!(format("en", -0.001, 0, 2), "0");
}

#[test]
fn substitute_honours_icu_quotes_and_rejects_what_it_cannot_format() {
    let args = vec![("name".to_owned(), Arg::Text("Ada".to_owned()))];
    assert_eq!(
        substitute("It''s {name}", "en", &args).as_deref(),
        Some("It's Ada")
    );
    assert_eq!(
        substitute("'{name}' is {name}", "en", &args).as_deref(),
        Some("{name} is Ada")
    );
    assert_eq!(
        substitute("l'alerte {name}", "fr", &args).as_deref(),
        Some("l'alerte Ada")
    );
    assert!(substitute("{count, plural, one {x} other {y}}", "en", &args).is_none());
    assert!(substitute("{missing}", "en", &args).is_none());
    assert!(substitute("broken }", "en", &args).is_none());
}

#[test]
fn locales_resolve_by_tag_then_language() {
    assert_eq!(resolve("ja"), "ja");
    assert_eq!(resolve("pt-br"), "pt-BR");
    assert_eq!(resolve("pt_PT"), "pt-BR");
    assert_eq!(resolve("zh_CN.UTF-8"), "zh-CN");
    assert_eq!(resolve("en-US"), "en");
    assert_eq!(resolve(""), "en");
    assert_eq!(resolve("tlh"), "en");
    assert_eq!(stored(Some("  ")), None);
    assert_eq!(stored(Some("de-AT")), Some("de"));
    assert_eq!(sentence_separator("ja"), "");
    assert_eq!(sentence_separator("fr"), " ");
}

#[test]
fn locales_resolve_by_script_like_the_typescript_surfaces() {
    // Traditional Chinese has no catalog (officialCatalogLocale("zh-TW") is
    // null), so it is English rather than Simplified Chinese.
    for tag in [
        "zh-TW",
        "zh-HK",
        "zh-MO",
        "zh-Hant",
        "zh-Hant-HK",
        "zh_TW.UTF-8",
        "zh-US",
    ] {
        assert_eq!(resolve(tag), "en", "{tag}");
    }
    for tag in [
        "zh",
        "zh-SG",
        "zh-Hans",
        "zh-Hans-TW",
        "zh-Hans-CN",
        "zh_CN",
    ] {
        assert_eq!(resolve(tag), "zh-CN", "{tag}");
    }
    assert_eq!(resolve("hi-Latn"), "en");
    assert_eq!(resolve("ja-JP"), "ja");
    assert_eq!(resolve("sr-Cyrl"), "en");
    assert_eq!(stored(Some("zh-Hant-TW")), Some("en"));
    assert_eq!(locale_from_preference(None, Some("zh_TW.UTF-8")), "en");
}

#[test]
fn accept_language_picks_the_most_preferred_tag() {
    assert_eq!(from_accept_language("ja,en;q=0.5"), Some("ja"));
    assert_eq!(from_accept_language("en;q=0.4, de-AT;q=0.8"), Some("de"));
    // Tags without a catalog are skipped, like `localeFromAcceptLanguage`.
    assert_eq!(
        from_accept_language("zh-TW,zh;q=0.9,en;q=0.8"),
        Some("zh-CN")
    );
    assert_eq!(from_accept_language("nl-NL,nl;q=0.9,de;q=0.8"), Some("de"));
    assert_eq!(from_accept_language("zh-TW,en;q=0.9,ja;q=0.8"), Some("en"));
    assert_eq!(from_accept_language("nl,sv;q=0.5"), Some("en"));
    assert_eq!(from_accept_language("de;q=0.5,fr;q=0.5"), Some("de"));
    assert_eq!(from_accept_language("fr;q=0, it"), Some("it"));
    assert_eq!(from_accept_language("*"), None);
    assert_eq!(from_accept_language(""), None);
    assert_eq!(text_direction("ar-EG"), "rtl");
    assert_eq!(text_direction("ja"), "ltr");
}

#[test]
fn only_a_fixed_ui_language_overrides_the_request_language() {
    assert_eq!(
        fixed_locale_from_preference(Some(r#"{"mode":"fixed","packId":"official/ja"}"#)),
        Some("ja")
    );
    assert_eq!(
        fixed_locale_from_preference(Some(r#"{"mode":"fixed","packId":null}"#)),
        Some("en")
    );
    assert_eq!(
        fixed_locale_from_preference(Some(r#"{"mode":"auto","locale":"de"}"#)),
        None
    );
    assert_eq!(fixed_locale_from_preference(Some("not json")), None);
    assert_eq!(fixed_locale_from_preference(None), None);
}

#[test]
fn node_locale_reads_the_ui_language_preference() {
    let fixed = |pack: &str| format!(r#"{{"mode":"fixed","packId":{pack}}}"#);
    assert_eq!(
        locale_from_preference(Some(&fixed("\"official/ja\"")), None),
        "ja"
    );
    assert_eq!(
        locale_from_preference(Some(&fixed("\"official/pt-br\"")), None),
        "pt-BR"
    );
    assert_eq!(
        locale_from_preference(Some(&fixed("null")), Some("de_DE.UTF-8")),
        "en"
    );
    assert_eq!(
        locale_from_preference(
            Some(r#"{"mode":"auto","packId":null}"#),
            Some("fr_FR.UTF-8")
        ),
        "fr"
    );
    // Desktop's auto mode names the locale it shows; it beats the OS probe.
    assert_eq!(
        locale_from_preference(
            Some(r#"{"mode":"auto","packId":null,"locale":"de"}"#),
            Some("nl_NL")
        ),
        "de"
    );
    assert_eq!(
        locale_from_preference(
            Some(r#"{"mode":"auto","packId":null,"locale":""}"#),
            Some("fr_FR")
        ),
        "fr"
    );
    assert_eq!(locale_from_preference(None, Some("ko_KR")), "ko");
    assert_eq!(locale_from_preference(Some("not json"), None), "en");
}

#[test]
fn alert_text_round_trips_the_wire_form_and_joins_per_locale() {
    let text = AlertText::new(
        Message::new(messages::POLICY_BUDGET_TITLE_MESSAGE),
        vec![
            Message::new(messages::POLICY_USED_MESSAGE)
                .number("used", 950.0, 0, 0)
                .number("limit", 1000.0, 0, 0),
            Message::new(messages::POLICY_ACTION_BLOCK_MESSAGE),
        ],
        Join::Sentences,
    );
    let parsed = AlertText::from_wire(&text.to_wire()).expect("wire form parses");
    assert_eq!(parsed, text);
    let (title, body) = text.render("en");
    assert_eq!(title, "Budget limit reached");
    assert_eq!(body, "Used 950 of 1,000. Action: the request was blocked.");
}

#[test]
fn wire_messages_from_an_app_render_and_bad_input_is_rejected() {
    let wire = serde_json::json!({
        "title": { "message": "Site down", "args": {} },
        "body": [{
            "message": "Now {price} (below {threshold}).",
            "args": {
                "price": { "number": 1234.5, "min_fraction": 2, "max_fraction": 2 },
                "threshold": { "number": 1300, "min_fraction": 0, "max_fraction": 2 }
            }
        }],
        "join": "lines"
    });
    let text = AlertText::from_wire(&wire).expect("parses");
    let (_, body) = text.render("de");
    assert!(
        body.contains("1.234,50") && body.contains("1.300"),
        "{body}"
    );
    assert!(AlertText::from_wire(&serde_json::json!({ "title": "x" })).is_none());
    assert!(AlertText::from_wire(&serde_json::json!({
        "title": { "message": "x", "args": { "a": [1] } }
    }))
    .is_none());
}

#[test]
fn pushes_render_in_japanese_arabic_and_german() {
    let body = Message::new(messages::RUN_FINISHED_BODY_MESSAGE);
    let english = body.render("en");
    assert_eq!(english, "Finished replying. Tap to read it.");
    for locale in ["ja", "ar", "de"] {
        let rendered = body.render(locale);
        assert_ne!(rendered, english, "{locale} has a translation");
        assert!(!rendered.is_empty());
    }
    assert!(body.render("ja").chars().any(|c| !c.is_ascii()));
}

#[test]
fn an_untranslated_sentence_keeps_its_space_in_japanese() {
    // The run-finished body is translated into Japanese (ends with "。"); the
    // policy action sentence may not be yet and must not run into it.
    let text = AlertText::new(
        Message::new(messages::POLICY_GENERIC_TITLE_MESSAGE),
        vec![
            Message::new(messages::RUN_FINISHED_BODY_MESSAGE),
            Message::new(messages::RUN_FINISHED_BODY_MESSAGE),
        ],
        Join::Sentences,
    );
    let sentence = Message::new(messages::RUN_FINISHED_BODY_MESSAGE).render("ja");
    let (_, joined) = text.render("ja");
    assert_eq!(joined, format!("{sentence}{sentence}"));

    let english_pair = AlertText::new(
        Message::new(messages::POLICY_GENERIC_TITLE_MESSAGE),
        vec![
            Message::new(messages::POLICY_TRIGGERED_MESSAGE),
            Message::new(messages::POLICY_ACTION_BLOCK_MESSAGE),
        ],
        Join::Sentences,
    );
    let first = Message::new(messages::POLICY_TRIGGERED_MESSAGE).render("ja");
    let second = Message::new(messages::POLICY_ACTION_BLOCK_MESSAGE).render("ja");
    let (_, joined) = english_pair.render("ja");
    if first.ends_with(|c: char| c.is_ascii()) {
        assert_eq!(joined, format!("{first} {second}"));
    } else {
        assert_eq!(joined, format!("{first}{second}"));
    }
}
