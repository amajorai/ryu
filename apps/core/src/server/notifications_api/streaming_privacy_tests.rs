use super::project_streaming_private_notifications;
use crate::notify::store::NotificationRow;

fn notification(source_app_id: Option<&str>) -> NotificationRow {
    NotificationRow {
        id: "ntf_connect_sensitive-event".to_owned(),
        user_id: Some("user-1".to_owned()),
        title: "Password reset requested".to_owned(),
        body: Some("Code 683474 is valid for 30 minutes".to_owned()),
        level: "info".to_owned(),
        workflow_run_id: Some("run-sensitive".to_owned()),
        node_id: Some("private-node".to_owned()),
        ack_required: false,
        acked: false,
        read_at: None,
        created_at: "2026-09-29T00:00:00Z".to_owned(),
        source_app_id: source_app_id.map(str::to_owned),
        archived_at: None,
    }
}

#[test]
fn streaming_masks_queued_connect_details_and_run_references() {
    let projected = project_streaming_private_notifications(
        vec![notification(Some(
            crate::notify::ISLAND_CONNECT_SUGGESTION_SOURCE,
        ))],
        true,
        "en",
    );
    let projected = &projected[0];
    assert_eq!(
        projected.title,
        crate::notify::CONNECT_SUGGESTION_PRIVACY_TITLE
    );
    assert_eq!(
        projected.body.as_deref(),
        Some(crate::notify::CONNECT_SUGGESTION_PRIVACY_BODY)
    );
    assert_eq!(projected.workflow_run_id, None);
    assert_eq!(projected.node_id, None);
}

#[test]
fn streaming_leaves_other_notifications_and_inactive_suggestions_unchanged() {
    let connect = notification(Some(crate::notify::ISLAND_CONNECT_SUGGESTION_SOURCE));
    let other = notification(Some("@ryu/approvals"));
    let projected =
        project_streaming_private_notifications(vec![connect.clone(), other.clone()], true, "en");
    assert_eq!(projected[1].title, other.title);
    assert_eq!(projected[1].body, other.body);
    assert_eq!(
        project_streaming_private_notifications(vec![connect.clone()], false, "en")[0].title,
        connect.title
    );
}

#[test]
fn streaming_placeholder_follows_the_node_locale() {
    let (title, body) = crate::notify::privacy_placeholder("de");
    let projected = project_streaming_private_notifications(
        vec![notification(Some(
            crate::notify::ISLAND_CONNECT_SUGGESTION_SOURCE,
        ))],
        true,
        "de",
    );
    assert_eq!(projected[0].title, title);
    assert_eq!(projected[0].body.as_deref(), Some(body.as_str()));

    // A row persisted with the English placeholder reads in the node locale
    // after Streaming ends too.
    let mut persisted = notification(Some(crate::notify::ISLAND_CONNECT_SUGGESTION_SOURCE));
    persisted.title = crate::notify::CONNECT_SUGGESTION_PRIVACY_TITLE.to_owned();
    persisted.body = Some(crate::notify::CONNECT_SUGGESTION_PRIVACY_BODY.to_owned());
    let projected = project_streaming_private_notifications(vec![persisted], false, "de");
    assert_eq!(projected[0].title, title);
    assert_eq!(projected[0].body.as_deref(), Some(body.as_str()));
}
