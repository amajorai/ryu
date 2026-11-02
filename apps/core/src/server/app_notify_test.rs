//! Unit tests for `app_notify` (`notify.deliver` and `notify.fanout`).

use super::*;

fn member(user_id: &str) -> crate::sidecar::control_plane::NotifyTargetUser {
    crate::sidecar::control_plane::NotifyTargetUser {
        user_id: user_id.to_owned(),
        email: None,
        image: None,
        role: None,
        name: None,
    }
}

#[test]
fn a_fanned_out_alert_maps_onto_the_activity_feed_unchanged() {
    let item = activity_item_from_alert(&serde_json::json!({
        "title": "Site down",
        "message": "HTTP 503",
        "monitor_id": "m1",
        "monitor_name": "Shop",
        "kind": "uptime_down",
        "created_at": "2026-10-10T12:00:00Z",
    }));
    assert_eq!(
        (item.kind.as_str(), item.source.as_str()),
        ("monitor_alert", "monitors")
    );
    assert_eq!(item.title, "Site down");
    assert_eq!(item.body.as_deref(), Some("HTTP 503"));
    assert_eq!(item.level, ryu_activity::ActivityLevel::Warning);
    assert_eq!(item.metadata["monitor_name"], "Shop");
    assert_eq!(item.metadata["alert_kind"], "uptime_down");
    assert_eq!(item.created_at, 1_791_633_600);

    let info = activity_item_from_alert(&serde_json::json!({ "kind": "price_drop" }));
    assert_eq!(info.level, ryu_activity::ActivityLevel::Info);
}

#[test]
fn notification_membership_is_fail_closed() {
    let members = vec![member("alice")];
    assert!(target_is_org_member("alice", &members));
    assert!(!target_is_org_member("bob", &members));
    assert!(!target_is_org_member("alice", &[]));
}

#[test]
fn naming_another_member_requires_the_send_to_user_grant() {
    let none = std::collections::HashSet::new();
    let granted: std::collections::HashSet<String> =
        [SEND_TO_USER_GRANT.to_owned()].into_iter().collect();
    // No explicit target, or the node's own active user: always allowed.
    assert!(may_target_recipient(&none, None, Some("alice")));
    assert!(may_target_recipient(&none, Some("  "), Some("alice")));
    assert!(may_target_recipient(&none, Some("alice"), Some("alice")));
    // Any other member needs the reviewed grant.
    assert!(!may_target_recipient(&none, Some("bob"), Some("alice")));
    assert!(!may_target_recipient(&none, Some("bob"), None));
    assert!(may_target_recipient(&granted, Some("bob"), Some("alice")));
}

#[test]
fn notification_input_has_bounded_fields() {
    assert!(validate_notify_input("Title", "body", Some("alice")).is_ok());
    assert!(validate_notify_input("   ", "body", None).is_err());
    assert!(validate_notify_input(&"x".repeat(MAX_NOTIFY_TITLE_BYTES + 1), "", None).is_err());
    assert!(validate_notify_input("Title", &"x".repeat(MAX_NOTIFY_BODY_BYTES + 1), None).is_err());
    assert!(
        validate_notify_input("Title", "", Some(&"x".repeat(MAX_NOTIFY_TARGET_BYTES + 1))).is_err()
    );
}

#[test]
fn a_localizable_deliver_payload_renders_per_locale() {
    let body: DeliverBody = serde_json::from_value(serde_json::json!({
        "title": "Approval needed",
        "body": "On Saturday, March 14.",
        "i18n": {
            "title": { "message": "Approval needed", "args": {} },
            "body": [
                { "message": "On {date}.", "args": { "date": { "date": "2026-03-14" } } },
                { "message": "{count} saved.", "args": { "count": 1234 } }
            ],
            "join": "sentences"
        }
    }))
    .unwrap();
    let text = body
        .i18n
        .as_ref()
        .and_then(crate::i18n::AlertText::from_wire)
        .expect("a well-formed i18n payload parses");
    let (title, rendered) = text.render("de");
    assert_eq!(title, "Genehmigung erforderlich");
    // No translation yet for the body sources: the English sentence with the
    // arguments written the German way.
    assert_eq!(rendered, "On Samstag, 14. März. 1.234 saved.");
    assert_eq!(
        text.render("en"),
        (
            "Approval needed".to_owned(),
            "On Saturday, March 14. 1,234 saved.".to_owned()
        )
    );
}

#[test]
fn the_plain_deliver_payload_is_unchanged() {
    let body: DeliverBody = serde_json::from_value(serde_json::json!({
        "title": "Done",
        "body": "All good",
        "level": "success",
        "target_user_id": "alice"
    }))
    .unwrap();
    assert!(body.i18n.is_none());
    assert_eq!(body.title, "Done");
    assert_eq!(body.body.as_deref(), Some("All good"));
    // A malformed `i18n` is ignored, so the English text is delivered.
    let malformed: DeliverBody = serde_json::from_value(serde_json::json!({
        "title": "Done",
        "i18n": { "title": "not a message" }
    }))
    .unwrap();
    assert!(malformed
        .i18n
        .as_ref()
        .and_then(crate::i18n::AlertText::from_wire)
        .is_none());
    let bad_date = serde_json::json!({
        "title": { "message": "On {date}.", "args": { "date": { "date": "March 14" } } }
    });
    assert!(crate::i18n::AlertText::from_wire(&bad_date).is_none());
}

#[test]
fn rendered_text_is_clipped_on_a_char_boundary() {
    let (title, body) = clip_rendered("é".repeat(200), "x".repeat(10));
    assert!(title.len() <= MAX_NOTIFY_TITLE_BYTES);
    assert_eq!(title.chars().count(), MAX_NOTIFY_TITLE_BYTES / 2);
    assert_eq!(body, "x".repeat(10));
}

fn localizable_alert() -> serde_json::Value {
    serde_json::json!({
        "title": "Approval needed",
        "message": "HTTP 503",
        "monitor_id": "m1",
        "kind": "uptime_down",
        "i18n": {
            "title": { "message": "Approval needed", "args": {} },
            "body": [{ "message": "{count} saved.", "args": { "count": 1234 } }],
            "join": "sentences"
        }
    })
}

#[test]
fn a_fanned_out_alert_with_i18n_writes_its_inbox_copy_in_the_node_locale() {
    let alert = localizable_alert();
    assert_eq!(
        alert_inbox_text(&alert, "de"),
        (
            "Genehmigung erforderlich".to_owned(),
            "1.234 saved.".to_owned()
        )
    );
    // Without (or with a malformed) `i18n`, the English text is kept.
    let mut plain = alert.clone();
    plain["i18n"] = serde_json::json!({ "title": "not a message" });
    assert_eq!(
        alert_inbox_text(&plain, "de"),
        ("Approval needed".to_owned(), "HTTP 503".to_owned())
    );
}

#[tokio::test]
async fn the_inbox_copy_of_a_fanned_out_alert_is_a_row_and_toast_without_a_push() {
    let directory = tempfile::tempdir().unwrap();
    let store = crate::notify::NotifyStore::open(directory.path().join("notify.db")).unwrap();
    let alert = localizable_alert();
    let id = inbox_copy_of_alert(&store, "@ryu/monitors", "user-1", &alert, "warning")
        .await
        .unwrap();
    let row = store.get_notification(&id).await.unwrap().expect("row");
    let locale = crate::i18n::locale::node_locale().await;
    let (title, body) = alert_inbox_text(&alert, locale);
    assert_eq!(row.title, title);
    assert_eq!(row.body.as_deref(), Some(body.as_str()));
    assert_eq!(row.user_id.as_deref(), Some("user-1"));
    assert_eq!(row.source_app_id.as_deref(), Some("@ryu/monitors"));
    assert_eq!(row.level, "warning");
}

/// `notify_all` already pushes to every registered device, so the fan-out's
/// inbox copy must not push again: the active member gets one push per device.
#[test]
fn the_fanout_inbox_copy_never_pushes() {
    let source = include_str!("app_notify.rs");
    let start = source.find("async fn inbox_copy_of_alert").expect("helper");
    let end = start + source[start..].find("\n}\n").expect("end");
    let helper = &source[start..end];
    assert!(helper.contains("persist_and_toast"), "{helper}");
    for pushing in ["deliver_app_notification", "deliver_localized", "push_"] {
        assert!(!helper.contains(pushing), "{pushing} in {helper}");
    }
    let fanout = &source[source
        .find("pub(crate) async fn host_notify_fanout")
        .unwrap()..];
    let fanout = &fanout[..fanout.find("\n}\n").unwrap()];
    assert!(!fanout.contains("deliver_app_notification"), "{fanout}");
}

/// A real monitor alert wire (the `@ryu/monitors` sources) renders its inbox
/// copy in German, Japanese and Arabic; English keeps the source text.
#[test]
fn a_monitor_alert_inbox_copy_renders_in_de_ja_and_ar() {
    let alert = serde_json::json!({
        "title": "Site down",
        "message": "Unexpected HTTP 503.",
        "kind": "uptime_down",
        "i18n": {
            "title": { "message": "Site down", "args": {} },
            "body": [{ "message": "Unexpected HTTP {status}.", "args": { "status": 503 } }],
            "join": "sentences"
        }
    });
    let cases = [
        ("en", "Site down", "Unexpected HTTP 503."),
        (
            "de",
            "Website nicht erreichbar",
            "Unerwarteter HTTP-Status 503.",
        ),
        (
            "ja",
            "サイトがダウンしています",
            "予期しない HTTP 503 です。",
        ),
        ("ar", "الموقع متوقف", "استجابة HTTP 503 غير متوقعة."),
    ];
    for (locale, title, body) in cases {
        assert_eq!(
            alert_inbox_text(&alert, locale),
            (title.to_owned(), body.to_owned()),
            "{locale}"
        );
    }
}

/// The `i18n` a satellite's `NotifyHint::localized` sends on `events.emit`
/// parses as the `notify.deliver` text and renders per recipient locale, with
/// counts grouped and verbatim text kept as is; the English title and body the
/// hint also carries match the English rendering.
#[test]
fn an_event_notify_hint_renders_in_the_recipient_locale() {
    const TITLE_MESSAGE: ryu_app_events::NotifyTemplate = |_| "Site down".to_owned();
    const BODY_MESSAGE: ryu_app_events::NotifyTemplate =
        |arg| format!("Unexpected HTTP {status}.", status = arg("status"));
    let hint = ryu_app_events::NotifyHint::localized(
        ryu_app_events::NotifyMessage::new(TITLE_MESSAGE),
        vec![
            ryu_app_events::NotifyMessage::new(BODY_MESSAGE).count("status", 503),
            ryu_app_events::NotifyMessage::verbatim("edge-7"),
        ],
    );
    let text = crate::i18n::AlertText::from_wire(hint.i18n.as_ref().expect("localized"))
        .expect("the hint's i18n is the notify.deliver wire shape");
    assert_eq!(
        text.render("en"),
        (hint.title.clone(), hint.body.clone().unwrap_or_default())
    );
    let cases = [
        (
            "de",
            "Website nicht erreichbar",
            "Unerwarteter HTTP-Status 503. edge-7",
        ),
        (
            "ja",
            "サイトがダウンしています",
            "予期しない HTTP 503 です。edge-7",
        ),
        ("ar", "الموقع متوقف", "استجابة HTTP 503 غير متوقعة. edge-7"),
    ];
    for (locale, title, body) in cases {
        assert_eq!(
            text.render(locale),
            (title.to_owned(), body.to_owned()),
            "{locale}"
        );
    }

    // A count of four or more digits: the hint's plain English matches
    // Core's grouped English rendering.
    let grouped = ryu_app_events::NotifyHint::localized(
        ryu_app_events::NotifyMessage::new(TITLE_MESSAGE),
        vec![ryu_app_events::NotifyMessage::new(BODY_MESSAGE).count("status", 12_345)],
    );
    let grouped_text = crate::i18n::AlertText::from_wire(grouped.i18n.as_ref().unwrap()).unwrap();
    assert_eq!(
        grouped_text.render("en"),
        (
            grouped.title.clone(),
            grouped.body.clone().unwrap_or_default()
        )
    );
    assert_eq!(grouped.body.as_deref(), Some("Unexpected HTTP 12,345."));
}
