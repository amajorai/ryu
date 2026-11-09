//! The tap link on an `events.emit` notify hint.

use super::*;

#[test]
fn an_emit_hint_keeps_a_link_into_the_emitting_app() {
    assert_eq!(
        hint_link(
            "@ryu/example",
            Some("ryu://apps/@ryu/example/items/7?tab=a")
        ),
        Some("ryu://apps/@ryu/example/items/7?tab=a")
    );
    assert_eq!(hint_link("@ryu/example", None), None);
}

#[test]
fn an_emit_hint_drops_a_link_to_another_app_or_url() {
    for link in [
        "ryu://apps/@ryu/other/items/7",
        "https://example.com/",
        "/vault?tab=broker",
        "ryu://apps/@ryu/example/../other",
    ] {
        assert_eq!(hint_link("@ryu/example", Some(link)), None, "{link}");
    }
}

#[test]
fn an_emit_body_parses_the_hint_link() {
    let body: EventEmitBody = serde_json::from_value(serde_json::json!({
        "event": "@ryu/example#item.ready",
        "notify": { "title": "Ready", "link": "ryu://apps/@ryu/example/items/7" },
    }))
    .unwrap();
    assert_eq!(
        body.notify.and_then(|notify| notify.link).as_deref(),
        Some("ryu://apps/@ryu/example/items/7")
    );
}
