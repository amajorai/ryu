use std::sync::Arc;

use serde_json::json;

use super::identity::DevicePrincipal;
use super::offer::DeviceOffer;
use super::taint::{agent_egress_hold, agent_kind_can_egress, private_read_source};
use super::turn_context::{
    device_listing_allowed, live_offer_for_conversation, register_turn_context, turn_context_for,
};

fn offer(conversation: &str, history_read: Option<&str>) -> Arc<DeviceOffer> {
    let decl = serde_json::from_value(json!({
        "device_id": uuid::Uuid::new_v4().to_string(), "app": "ryu-bot", "platform": "ios",
        "foreground": true, "catalog_version": 1, "tools": [{ "app": "location", "permission": "granted" }],
    }))
    .unwrap();
    Arc::new(
        DeviceOffer::new(
            conversation.to_owned(),
            DevicePrincipal::LocalOwner,
            decl,
            crate::approvals::policy::ApprovalMode::Smart,
        )
        .with_history(false, history_read.map(str::to_owned)),
    )
}

fn conversation() -> String {
    format!("conv-ctx-{}", uuid::Uuid::new_v4().simple())
}

#[test]
fn only_the_registering_instance_and_agent_get_the_offer() {
    let conversation = conversation();
    let (instance, _rx) = tokio::sync::mpsc::unbounded_channel();
    let (other, _other_rx) = tokio::sync::mpsc::unbounded_channel();
    assert!(!device_listing_allowed(&conversation, "ryu"));
    let guard = register_turn_context(offer(&conversation, None), &instance, "ryu");
    assert!(device_listing_allowed(&conversation, "ryu"));
    assert!(!device_listing_allowed(&conversation, "delegate"));
    assert!(turn_context_for(&conversation, &instance, "ryu").is_some());
    assert!(turn_context_for(&conversation, &other, "ryu").is_none());
    assert!(turn_context_for(&conversation, &instance, "delegate").is_none());
    drop(guard);
    assert!(turn_context_for(&conversation, &instance, "ryu").is_none());
    assert!(live_offer_for_conversation(&conversation).is_none());
}

#[test]
fn a_device_read_in_history_starts_the_acp_turn_private() {
    let conversation = conversation();
    let (instance, _rx) = tokio::sync::mpsc::unbounded_channel();
    let turn = offer(&conversation, Some("device.location.current"));
    assert!(
        private_read_source(&turn).is_none(),
        "not before an ACP turn registers it"
    );
    let _guard = register_turn_context(turn.clone(), &instance, "ryu");
    assert_eq!(
        private_read_source(&turn).as_deref(),
        Some("device.location.current")
    );
}

#[test]
fn agent_egress_is_held_only_after_a_device_read_on_the_live_turn() {
    let conversation = conversation();
    let (instance, _rx) = tokio::sync::mpsc::unbounded_channel();
    assert!(
        agent_egress_hold(&conversation, "fetch").is_none(),
        "no live turn"
    );
    let turn = offer(&conversation, None);
    let _guard = register_turn_context(turn.clone(), &instance, "ryu");
    assert!(
        agent_egress_hold(&conversation, "fetch").is_none(),
        "nothing read yet"
    );
    super::taint::mark_device_read(&turn, "device.location.current");
    for kind in ["fetch", "execute", "edit", "search", "other"] {
        assert!(agent_kind_can_egress(kind));
        assert_eq!(
            agent_egress_hold(&conversation, kind).as_deref(),
            Some("device.location.current"),
            "{kind}"
        );
    }
    assert!(agent_egress_hold(&conversation, "read").is_none());
    assert!(agent_egress_hold(&conversation, "think").is_none());
}
