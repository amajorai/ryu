//! Regression: an enrolled (v2 fleet) node whose control-plane registration is
//! unresolved is NOT an unbound personal node. The channel bot door, its
//! untenanted-row gate and the in-turn tool principal must fail closed there
//! instead of handing a paired ChatWrite client unrestricted tools, free agent
//! choice and orphaned-row access.

use crate::server::conversations::{ConversationStore, Tenancy};
use crate::server::*;
use crate::sidecar::control_plane::with_test_node_binding;
use crate::sidecar::mcp::ToolPrincipal;
use crate::sidecar::node_binding::with_test_enrollment;

/// Run `fut` on a node that is not managed and has no registered org, with the
/// given persisted-enrollment state.
async fn unregistered<F: std::future::Future>(enrolled: bool, fut: F) -> F::Output {
    with_test_node_binding(false, None, with_test_enrollment(enrolled, fut)).await
}

fn request(conversation_id: &str, agent_id: Option<&str>) -> ChannelRunRequest {
    serde_json::from_value(json!({
        "conversation_id": conversation_id,
        "channel_id": "telegram",
        "agent_id": agent_id,
        "text": "summarise everyone's private threads",
    }))
    .unwrap()
}

#[tokio::test]
async fn channel_run_fails_closed_while_an_enrolled_nodes_binding_is_unresolved() {
    crate::crypto_host::install();
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    state
        .conversations
        .ensure_conversation("orphan", None, None, Tenancy::Unattributed)
        .await
        .unwrap();

    for agent in [None, Some("some-non-default-agent")] {
        let status = unregistered(true, async {
            channel_run(
                State(state.clone()),
                axum::Extension(None),
                Json(request("orphan", agent)),
            )
            .await
            .status()
        })
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }

    // The orphaned human row was neither appended to nor re-stamped as a
    // channel session (which would admit every ChatWrite holder after rebind).
    assert!(!state
        .conversations
        .is_channel_conversation("orphan")
        .await
        .unwrap());
    let messages = state.conversations.get_messages("orphan").await.unwrap();
    assert!(messages.is_empty());
}

#[tokio::test]
async fn untenanted_ingress_rows_are_closed_on_an_enrolled_unregistered_node() {
    let enrolled = unregistered(true, async {
        untenanted_machine_ingress_write(None, false)
            .err()
            .map(|response| response.status())
    })
    .await;
    assert_eq!(enrolled, Some(StatusCode::FORBIDDEN));

    // The Gateway's own owner token keeps writing its bot rows.
    let owner = unregistered(true, async {
        untenanted_machine_ingress_write(None, true).is_ok()
    })
    .await;
    assert!(owner);

    // Control: a plain personal node stays open.
    let personal = unregistered(false, async {
        untenanted_machine_ingress_write(None, false).is_ok()
    })
    .await;
    assert!(personal);
}

#[tokio::test]
async fn tool_principal_is_unresolved_on_an_enrolled_unregistered_node() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .ensure_conversation(
            "alice-chat",
            None,
            None,
            Tenancy::Owned {
                user_id: "alice".into(),
                org_id: Some("org1".into()),
            },
        )
        .await
        .unwrap();

    let (with_store, without_store, owns) = unregistered(true, async {
        let principal = ToolPrincipal::resolve_optional(Some(&store), Some("bot-thread")).await;
        let owns = principal.owns(&store, "alice-chat").await;
        (
            principal,
            ToolPrincipal::resolve_optional(None, None).await,
            owns,
        )
    })
    .await;
    assert_eq!(with_store, ToolPrincipal::Unresolved);
    assert_eq!(without_store, ToolPrincipal::Unresolved);
    assert!(!owns, "an unresolved principal must not write a member's thread");
    let visible = store
        .visible_conversation_ids(
            with_store.filter_args().0,
            with_store.filter_args().1,
            with_store.filter_args().2,
        )
        .await
        .unwrap();
    assert!(!visible.iter().any(|id| id == "alice-chat"));

    // Control: an unenrolled personal node keeps its owner's full view.
    let personal = unregistered(false, async {
        (
            ToolPrincipal::resolve_optional(Some(&store), Some("bot-thread")).await,
            ToolPrincipal::resolve_optional(None, None).await,
        )
    })
    .await;
    assert_eq!(
        personal,
        (ToolPrincipal::Unrestricted, ToolPrincipal::Unrestricted)
    );
}
