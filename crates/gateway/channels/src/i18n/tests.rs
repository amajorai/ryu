use std::cell::RefCell;
use std::collections::HashMap;

use super::*;
use crate::commands::ChannelCommand;

thread_local! {
    static OVERRIDES: RefCell<HashMap<(String, String), String>> = RefCell::new(HashMap::new());
}

/// Translations a test installed with [`with_translation`] (per thread, so a
/// `#[tokio::test]` on its current-thread runtime sees its own).
pub(super) fn override_lookup(locale: &str, source: &str) -> Option<String> {
    OVERRIDES.with(|map| {
        map.borrow()
            .get(&(locale.to_owned(), source.to_owned()))
            .cloned()
    })
}

/// Install a translation of `template` for the rest of this test thread.
pub(crate) fn with_translation(locale: &str, template: Template, translation: &str) {
    OVERRIDES.with(|map| {
        map.borrow_mut().insert(
            (locale.to_owned(), source(template)),
            translation.to_owned(),
        );
    });
}

/// Japanese for the three pairing sentences, as the catalog would carry them.
pub(crate) fn install_japanese_pairing() {
    with_translation(
        "ja",
        messages::PAIRING_PRIVATE_MESSAGE,
        "このアシスタントは非公開です。",
    );
    with_translation(
        "ja",
        messages::PAIRING_CODE_MESSAGE,
        "ペアリングコードは {code} です。",
    );
    with_translation(
        "ja",
        messages::PAIRING_APPROVE_MESSAGE,
        "オーナーに承認を依頼してください。",
    );
}

#[test]
fn templates_echo_their_icu_source() {
    assert_eq!(
        source(messages::PAIRING_CODE_MESSAGE),
        "Your pairing code is {code}."
    );
    assert_eq!(
        source(messages::TURN_ERROR_MESSAGE),
        "Sorry, something went wrong: {error}"
    );
}

#[test]
fn renders_english_and_fills_arguments_verbatim() {
    let text = render("en", messages::PAIRING_CODE_MESSAGE, &[("code", "{AB12}")]);
    assert_eq!(text, "Your pairing code is {AB12}.");
}

#[test]
fn icu_apostrophe_escapes_in_translations_are_unescaped() {
    with_translation(
        "fr",
        messages::TURN_ERROR_MESSAGE,
        "Désolé, l''exécution a échoué '{error}' : {error}",
    );
    assert_eq!(
        render("fr", messages::TURN_ERROR_MESSAGE, &[("error", "it's {x}")]),
        "Désolé, l'exécution a échoué {error} : it's {x}"
    );
    // A lone apostrophe before a letter is literal, as in ICU.
    with_translation(
        "it",
        messages::NO_RESPONSE_MESSAGE,
        "L'agente non ha risposto.",
    );
    assert_eq!(
        render("it", messages::NO_RESPONSE_MESSAGE, &[]),
        "L'agente non ha risposto."
    );
}

#[test]
fn pairing_prompt_is_translated_for_a_japanese_sender() {
    install_japanese_pairing();
    let prompt = pairing_prompt("ja-JP", "AB12");
    assert_eq!(
        prompt,
        "🔒 このアシスタントは非公開です。\n\nペアリングコードは *AB12* です。\n\nオーナーに承認を依頼してください。"
    );
}

#[test]
fn unknown_locales_fall_back_to_english() {
    install_japanese_pairing();
    let prompt = pairing_prompt("tlh", "AB12");
    assert!(prompt.starts_with("🔒 This assistant is private."));
    assert!(prompt.contains("Your pairing code is *AB12*."));
    // A translation without a catalog locale is never used.
    with_translation("tlh", messages::NO_RESPONSE_MESSAGE, "qay'");
    assert_eq!(
        render("tlh", messages::NO_RESPONSE_MESSAGE, &[]),
        "The agent sent no response."
    );
}

#[test]
fn resolves_platform_tags_like_core() {
    assert_eq!(resolve("ja"), "ja");
    assert_eq!(resolve("pt-br"), "pt-BR");
    assert_eq!(resolve("pt-PT"), "pt-BR");
    assert_eq!(resolve("zh_CN.UTF-8"), "zh-CN");
    assert_eq!(resolve("zh-SG"), "zh-CN");
    assert_eq!(resolve("zh-TW"), "en");
    assert_eq!(resolve("zh-Hant"), "en");
    assert_eq!(resolve("en-US"), "en");
    assert_eq!(resolve("xx"), "en");
    assert_eq!(stored(Some("  ")), None);
    assert_eq!(stored(Some("de-AT")), Some("de"));
}

#[test]
fn owner_preference_follows_cores_rule() {
    use super::owner::locale_from_preference;
    let fixed = r#"{"mode":"fixed","packId":"official/ja"}"#;
    assert_eq!(locale_from_preference(Some(fixed), Some("de_DE")), "ja");
    let english = r#"{"mode":"fixed","packId":null}"#;
    assert_eq!(locale_from_preference(Some(english), Some("de_DE")), "en");
    let auto = r#"{"mode":"auto","locale":"fr-FR"}"#;
    assert_eq!(locale_from_preference(Some(auto), Some("de_DE")), "fr");
    assert_eq!(locale_from_preference(None, Some("de_DE.UTF-8")), "de");
    assert_eq!(locale_from_preference(None, None), "en");
}

#[tokio::test]
async fn a_fixed_owner_locale_is_never_fetched() {
    let owner = OwnerLocale::fixed("ko");
    // An unroutable Core URL: a fetch would fail, but none is made.
    let http = reqwest::Client::new();
    assert_eq!(owner.get(&http, "http://127.0.0.1:9").await, "ko");
}

#[test]
fn command_help_is_localized_on_every_style() {
    with_translation(
        "de",
        messages::COMMANDS_HEADING_MESSAGE,
        "Verfügbare Befehle",
    );
    with_translation(
        "de",
        messages::NO_COMMANDS_MESSAGE,
        "Gerade sind keine Befehle verfügbar.",
    );
    let commands = [ChannelCommand {
        name: "goal".into(),
        description: "set a goal".into(),
        source: "builtin".into(),
    }];
    assert_eq!(
        command_help("de", &commands),
        "Verfügbare Befehle:\n/goal — set a goal"
    );
    assert!(whatsapp_command_help("de", &commands).starts_with("*Verfügbare Befehle*\n\n/goal"));
    assert_eq!(
        command_help("de", &[]),
        "Gerade sind keine Befehle verfügbar."
    );
    assert_eq!(
        whatsapp_command_help("xx", &[]),
        "No commands are available right now."
    );
}

#[tokio::test]
async fn the_owner_locale_is_read_from_core_once_per_ttl() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use axum::{routing::get, Json, Router};
    use serde_json::json;

    let reads = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&reads);
    let app = Router::new().route(
        "/api/preferences/ui-language",
        get(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            async {
                Json(json!({
                    "key": "ui-language",
                    "value": r#"{"mode":"fixed","packId":"official/ja"}"#,
                }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    let owner = OwnerLocale::from_core();
    let core_url = format!("http://{addr}/");
    assert_eq!(owner.get(&http, &core_url).await, "ja");
    assert_eq!(owner.get(&http, &core_url).await, "ja");
    assert_eq!(reads.load(Ordering::SeqCst), 1, "the second read is cached");
}

#[tokio::test]
async fn tests_default_to_an_english_owner_without_any_fetch() {
    let http = reqwest::Client::new();
    let owner = OwnerLocale::default();
    assert_eq!(owner.get(&http, "http://127.0.0.1:9").await, "en");
}
