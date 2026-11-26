//! Spaces document sync: stable ids, stale replays, concurrent edits.

use super::*;
use crate::server::sync::payloads::{apply_document_sync_payload, build_document_sync_payloads};

#[tokio::test]
async fn document_round_trip_preserves_stable_ids_and_rejects_stale_replay() {
    let source = crate::server::spaces::SpaceStore::open_in_memory().unwrap();
    let target = crate::server::spaces::SpaceStore::open_in_memory().unwrap();
    let owner = crate::server::spaces::DocOwner::unattributed();
    let space_id = source
        .create_space("Research", Some("Shared notes"), &owner)
        .await
        .unwrap();
    let document_id = source.create_page(&space_id, "Plan", &owner).await.unwrap();
    source
        .update_document(&document_id, "Plan", "# First draft")
        .await
        .unwrap();

    let payload = build_document_sync_payloads(&source)
        .await
        .unwrap()
        .into_iter()
        .find(|payload| payload.document_id == document_id)
        .expect("document payload");
    assert!(
        apply_document_sync_payload(&target, &payload, Tenancy::Unattributed)
            .await
            .unwrap()
    );
    let restored = target
        .get_document(&document_id)
        .await
        .unwrap()
        .expect("restored document");
    assert_eq!(restored.space_id, space_id);
    assert_eq!(restored.title, "Plan");
    assert_eq!(restored.source, "# First draft");

    let mut stale = payload.clone();
    stale.updated_at = payload.updated_at.saturating_sub(1);
    stale.title = "Stale".to_owned();
    stale.source = "old".to_owned();
    assert!(
        !apply_document_sync_payload(&target, &stale, Tenancy::Unattributed)
            .await
            .unwrap()
    );
    let unchanged = target
        .get_document(&document_id)
        .await
        .unwrap()
        .expect("unchanged document");
    assert_eq!(unchanged.title, "Plan");
    assert_eq!(unchanged.source, "# First draft");
}

#[tokio::test]
async fn concurrent_document_edit_on_two_devices_keeps_both_bodies() {
    let device_a = crate::server::spaces::SpaceStore::open_in_memory().unwrap();
    let device_b = crate::server::spaces::SpaceStore::open_in_memory().unwrap();
    let owner = crate::server::spaces::DocOwner::unattributed();
    let space_id = device_a
        .create_space("Research", None, &owner)
        .await
        .unwrap();
    let document_id = device_a
        .create_page(&space_id, "Plan", &owner)
        .await
        .unwrap();
    device_a
        .update_document(&document_id, "Plan", "# Shared start")
        .await
        .unwrap();
    let initial = build_document_sync_payloads(&device_a)
        .await
        .unwrap()
        .into_iter()
        .find(|payload| payload.document_id == document_id)
        .unwrap();
    assert!(
        apply_document_sync_payload(&device_b, &initial, Tenancy::Unattributed)
            .await
            .unwrap()
    );
    // Receiving a snapshot records it as B's sync base, so a plain relay with
    // no local edit is not a conflict.
    assert!(device_b
        .list_document_versions(&document_id)
        .await
        .unwrap()
        .iter()
        .all(|version| version.capture_type != ryu_spaces::SYNC_CONFLICT_CAPTURE_TYPE));

    // Both devices edit offline; A's edit is newer.
    device_b
        .update_document(&document_id, "Plan", "# B's offline edit")
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    device_a
        .update_document(&document_id, "Plan", "# A's newer edit")
        .await
        .unwrap();
    let newer = build_document_sync_payloads(&device_a)
        .await
        .unwrap()
        .into_iter()
        .find(|payload| payload.document_id == document_id)
        .unwrap();
    assert!(
        apply_document_sync_payload(&device_b, &newer, Tenancy::Unattributed)
            .await
            .unwrap()
    );

    // Newest wins the document body, and B's edit survives as a pinned
    // history version instead of being silently discarded.
    let shown = device_b.get_document(&document_id).await.unwrap().unwrap();
    assert_eq!(shown.source, "# A's newer edit");
    let kept = device_b
        .list_document_versions(&document_id)
        .await
        .unwrap()
        .into_iter()
        .find(|version| version.capture_type == ryu_spaces::SYNC_CONFLICT_CAPTURE_TYPE)
        .expect("B's concurrent edit is kept in history");
    let body = device_b
        .get_document_version(&kept.id)
        .await
        .unwrap()
        .expect("kept version is readable");
    assert_eq!(body.source, "# B's offline edit");
}
