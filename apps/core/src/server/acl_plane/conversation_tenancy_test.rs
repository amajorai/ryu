//! `require_conversation_write_if_owned` (the `POST /api/channels/run` gate) and
//! the channel attach it guards, on bound and unbound nodes.

use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::server::conversations::{ChannelAttachRefused, Tenancy};
use crate::server::*;
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};

fn org_node() -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: "org1".to_owned(),
            name: "Org".to_owned(),
            slug: None,
        },
        node_id: "node-1".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    }
}

fn mallory() -> Option<VerifiedCaller> {
    Some(VerifiedCaller {
        user_id: "mallory".to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org1".to_owned()),
        role: OrgRole::Member,
        teams: Vec::new(),
    })
}

async fn gate(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    id: &str,
    owner_token: bool,
) -> Option<StatusCode> {
    crate::server::REQUEST_PRESENTS_OWNER_TOKEN
        .scope(owner_token, async {
            require_conversation_write_if_owned(state, caller, id)
                .await
                .err()
                .map(|response| response.status())
        })
        .await
}

/// Regression: on an org-bound node an orphaned (no owner, no org) human
/// conversation is denied to member, delegated and paired credentials, exactly as
/// the human ACL denies it, and cannot be re-stamped into a channel session.
#[tokio::test]
async fn bound_node_denies_untenanted_rows_to_non_owner_credentials() {
    crate::crypto_host::install();
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    state
        .conversations
        .ensure_conversation("orphan", None, None, Tenancy::Unattributed)
        .await
        .unwrap();
    with_test_node_binding(true, Some(org_node()), async {
        assert_eq!(
            gate(&state, &mallory(), "orphan", false).await,
            Some(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            gate(&state, &None, "orphan", false).await,
            Some(StatusCode::FORBIDDEN)
        );

        let error = state
            .conversations
            .ensure_channel_conversation("orphan", "x", None, Some("org1"))
            .await
            .expect_err("an untenanted row must not be re-stamped on a bound node");
        assert!(error.downcast_ref::<ChannelAttachRefused>().is_some());
        let meta = state
            .conversations
            .get_access_meta("orphan")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(meta.owner_user_id, None);
        assert_eq!(meta.org_id, None);
        assert!(!state
            .conversations
            .is_channel_conversation("orphan")
            .await
            .unwrap());
    })
    .await;
}

/// Gateway bot traffic keeps working: the owner token still writes legacy bot
/// rows, and a fresh channel id is admitted and created as a channel session.
#[tokio::test]
async fn bound_node_keeps_owner_token_bot_traffic_working() {
    crate::crypto_host::install();
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    state
        .conversations
        .ensure_conversation("legacy-bot", None, None, Tenancy::Unattributed)
        .await
        .unwrap();
    with_test_node_binding(true, Some(org_node()), async {
        assert_eq!(gate(&state, &None, "legacy-bot", true).await, None);
        assert_eq!(gate(&state, &None, "channel.bot.1", true).await, None);
        state
            .conversations
            .ensure_channel_conversation("channel.bot.1", "bot", None, Some("org1"))
            .await
            .unwrap();
        assert!(state
            .conversations
            .is_channel_conversation("channel.bot.1")
            .await
            .unwrap());
    })
    .await;
}

/// A personal node keeps every row untenanted, so the gate stays open there.
#[tokio::test]
async fn unbound_node_still_admits_untenanted_rows() {
    crate::crypto_host::install();
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    state
        .conversations
        .ensure_conversation("local", None, None, Tenancy::Unattributed)
        .await
        .unwrap();
    with_test_node_binding(false, None, async {
        assert_eq!(gate(&state, &None, "local", false).await, None);
        assert_eq!(gate(&state, &mallory(), "local", false).await, None);
    })
    .await;
}
