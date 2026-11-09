//! Unit tests for [`super::NotifyHint`] and [`super::NotifyMessage`].

use super::*;

const MOVED_MESSAGE: NotifyTemplate =
    |arg| format!("A deal moved to {stage}", stage = arg("stage"));
const COUNT_MESSAGE: NotifyTemplate = |arg| format!("Stories: {count}", count = arg("count"));
const QUOTED_MESSAGE: NotifyTemplate = |_| "It''s '{literal}'".to_owned();

#[test]
fn a_localized_hint_carries_english_text_and_the_wire_messages() {
    let hint = NotifyHint::localized(
        NotifyMessage::new(MOVED_MESSAGE).text("stage", "Won"),
        vec![
            NotifyMessage::new(COUNT_MESSAGE).count("count", 1234),
            NotifyMessage::verbatim("HTTP 503 {raw}"),
        ],
    )
    .with_level("success");
    assert_eq!(hint.title, "A deal moved to Won");
    assert_eq!(hint.body.as_deref(), Some("Stories: 1,234 HTTP 503 {raw}"));

    let wire = serde_json::to_value(&hint).unwrap();
    assert_eq!(wire["level"], "success");
    let i18n = &wire["i18n"];
    assert_eq!(i18n["title"]["message"], "A deal moved to {stage}");
    assert_eq!(i18n["title"]["args"]["stage"], "Won");
    assert_eq!(i18n["body"][0]["message"], "Stories: {count}");
    assert_eq!(i18n["body"][0]["args"]["count"]["number"], 1234);
    assert_eq!(i18n["body"][0]["args"]["count"]["max_fraction"], 0);
    assert_eq!(i18n["body"][1]["message"], "{text}");
    assert_eq!(i18n["body"][1]["args"]["text"], "HTTP 503 {raw}");
    assert_eq!(i18n["join"], "sentences");
}

#[test]
fn a_title_only_hint_has_no_body() {
    let hint = NotifyHint::localized(
        NotifyMessage::new(MOVED_MESSAGE).text("stage", "Lost"),
        vec![],
    );
    assert!(hint.body.is_none());
    let wire = serde_json::to_value(&hint).unwrap();
    assert!(wire.get("body").is_none());
    assert_eq!(wire["i18n"]["body"], serde_json::json!([]));
}

#[test]
fn english_rendering_honours_icu_quoting() {
    assert_eq!(
        NotifyMessage::new(QUOTED_MESSAGE).english(),
        "It's {literal}"
    );
    assert_eq!(
        NotifyMessage::new(MOVED_MESSAGE).source(),
        "A deal moved to {stage}"
    );
}

#[test]
fn an_english_only_hint_round_trips_without_i18n() {
    let hint = NotifyHint::info("Post published", None).with_level("success");
    let wire = serde_json::to_value(&hint).unwrap();
    assert!(wire.get("i18n").is_none() && wire.get("body").is_none());

    // A hint written by an older producer (no `i18n`) still reads back.
    let parsed: NotifyHint =
        serde_json::from_value(serde_json::json!({ "title": "Post published" })).unwrap();
    assert_eq!(parsed.title, "Post published");
    assert!(parsed.i18n.is_none() && parsed.level.is_none());

    let localized = NotifyHint::localized(
        NotifyMessage::new(MOVED_MESSAGE).text("stage", "Won"),
        vec![],
    );
    let back: NotifyHint =
        serde_json::from_value(serde_json::to_value(&localized).unwrap()).unwrap();
    assert_eq!(back.i18n, localized.i18n);
    assert_eq!(back.title, localized.title);
}

#[test]
fn english_counts_are_grouped_like_cores_english_rendering() {
    let english = |value| {
        NotifyMessage::new(COUNT_MESSAGE)
            .count("count", value)
            .english()
    };
    assert_eq!(english(7), "Stories: 7");
    assert_eq!(english(999), "Stories: 999");
    assert_eq!(english(1000), "Stories: 1,000");
    assert_eq!(english(1_234_567), "Stories: 1,234,567");
    assert_eq!(english(-4321), "Stories: -4,321");
}

#[test]
fn a_relayed_message_is_verbatim_text_marked_for_catalog_lookup() {
    let hint = NotifyHint::localized(
        NotifyMessage::new(MOVED_MESSAGE).text("stage", "Won"),
        vec![
            NotifyMessage::relayed("dataset has no samples"),
            NotifyMessage::verbatim("my own words"),
        ],
    );
    // The English rendering is the relayed text itself.
    assert_eq!(
        hint.body.as_deref(),
        Some("dataset has no samples my own words")
    );
    let wire = serde_json::to_value(&hint).unwrap();
    let relayed = &wire["i18n"]["body"][0];
    assert_eq!(relayed["message"], "{text}");
    assert_eq!(relayed["args"]["text"], "dataset has no samples");
    assert_eq!(relayed["relay"], true);
    // Verbatim text and templates carry no relay flag, so an older Core sees
    // exactly the wire shape it always did.
    assert!(wire["i18n"]["body"][1].get("relay").is_none());
    assert!(wire["i18n"]["title"].get("relay").is_none());
}

#[test]
fn a_link_serializes_only_when_set_and_round_trips() {
    let plain = serde_json::to_value(NotifyHint::info("Ready", None)).unwrap();
    assert!(
        plain.get("link").is_none(),
        "an unset link is not serialized"
    );

    let hint = NotifyHint::info("Ready", None)
        .for_user("user-1")
        .with_link("ryu://apps/@ryu/meetings/recaps/r1");
    let wire = serde_json::to_value(&hint).unwrap();
    assert_eq!(wire["link"], "ryu://apps/@ryu/meetings/recaps/r1");
    assert_eq!(wire["target_user_id"], "user-1");
    let back: NotifyHint = serde_json::from_value(wire).unwrap();
    assert_eq!(
        back.link.as_deref(),
        Some("ryu://apps/@ryu/meetings/recaps/r1")
    );

    // A hint from an emitter that predates links still parses.
    let old: NotifyHint = serde_json::from_value(serde_json::json!({ "title": "x" })).unwrap();
    assert_eq!(old.link, None);
}

#[test]
fn an_app_link_must_stay_inside_the_emitting_app() {
    let app = "@ryu/meetings";
    for valid in [
        "ryu://apps/@ryu/meetings",
        "ryu://apps/@ryu/meetings/recaps",
        "ryu://apps/@ryu/meetings/recaps/0b8e-1f?tab=notes&day=2026-11-09",
        "ryu://apps/@ryu/meetings/a%20b",
        "ryu://apps/@ryu/meetings?view=list",
        // Other escapes stay valid, and the query is not routed as a path.
        "ryu://apps/@ryu/meetings/a%41b",
        "ryu://apps/@ryu/meetings/recaps?q=%2e%2e%2F",
    ] {
        assert!(NotifyHint::link_is_valid_for(app, valid), "{valid}");
    }
    let too_long = format!(
        "ryu://apps/@ryu/meetings/{}",
        "a".repeat(MAX_NOTIFY_LINK_BYTES)
    );
    for invalid in [
        "",
        "https://evil.example/recaps",
        "javascript:alert(1)",
        "/vault?tab=broker",
        "ryu://apps/@ryu/crm/deals/1",
        "ryu://apps/@ryu/meetingsx/recaps",
        "ryu://apps/@ryu/meetings/",
        "ryu://apps/@ryu/meetings//recaps",
        "ryu://apps/@ryu/meetings/../crm",
        "ryu://apps/@ryu/meetings/./x",
        "ryu://apps/@ryu/meetings/x#frag",
        "ryu://apps/@ryu/meetings/a b",
        "ryu://apps/@ryu/meetings/a\\b",
        "ryu://apps/@ryu/meetings/%zz",
        "ryu://apps/@ryu/meetings/%4",
        "ryu://apps/@ryu/meetings/caf\u{e9}",
        // Escaped path syntax a decoding client would resolve outside the app.
        "ryu://apps/@ryu/meetings/%2e%2e/%2e%2e/vault",
        "ryu://apps/@ryu/meetings/%2E%2E/crm",
        "ryu://apps/@ryu/meetings/.%2e/crm",
        "ryu://apps/@ryu/meetings/%2e",
        "ryu://apps/@ryu/meetings/recaps%2F..%2F..",
        "ryu://apps/@ryu/meetings/recaps%2f..",
        "ryu://apps/@ryu/meetings/a%5cb",
        "ryu://apps/@ryu/meetings/a%5Cb",
        "ryu://apps/@ryu/meetings/%252e%252e/crm",
        "ryu://nodes/connect?url=http://x",
        too_long.as_str(),
    ] {
        assert!(!NotifyHint::link_is_valid_for(app, invalid), "{invalid}");
    }
    assert!(!NotifyHint::link_is_valid_for("", "ryu://apps/"));
}
