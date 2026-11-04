//! The view-only listing masks the Webhook node URL (it can carry a bearer
//! token in its path or query), while the editor view keeps it and a save that
//! echoes the placeholder restores the stored URL.

use super::tests::credential_workflow;
use super::*;

fn webhook_url(workflow: &Workflow) -> &str {
    match &workflow.nodes[1].kind {
        NodeKind::Webhook { url, .. } => url,
        other => panic!("expected the Webhook node, got {other:?}"),
    }
}

#[test]
fn listing_view_masks_the_webhook_node_url() {
    let view = redact_for_listing(credential_workflow());
    let text = serde_json::to_string(&view).unwrap();
    assert!(!text.contains("node-url-secret"));
    assert_eq!(webhook_url(&view), redact::REDACTED);
}

#[test]
fn editor_view_keeps_the_webhook_node_url() {
    let editor = redact_for_client(credential_workflow());
    assert_eq!(
        webhook_url(&editor),
        "https://api.example.test/hook?token=node-url-secret"
    );
}

#[test]
fn a_save_echoing_the_listing_placeholder_restores_the_stored_url() {
    let stored = credential_workflow();
    let mut echoed = redact_for_listing(stored.clone());
    restore_redacted(&mut echoed, Some(&stored)).unwrap();
    assert_eq!(webhook_url(&echoed), webhook_url(&stored));

    let mut orphan = redact_for_listing(credential_workflow());
    assert!(restore_redacted(&mut orphan, None).is_err());
}
