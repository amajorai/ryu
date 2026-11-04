//! Conversation store tests: imports and links.

use super::*;

#[test]
fn pull_request_urls_normalize_to_canonical_github_links() {
    assert_eq!(
        normalize_pull_request_url(" https://github.com/acme/app/pull/42/files?x=1 "),
        Some("https://github.com/acme/app/pull/42".to_owned())
    );
    assert_eq!(
        normalize_pull_request_url("https://github.com/acme/app/pulls/7"),
        Some("https://github.com/acme/app/pull/7".to_owned())
    );
    // Shared with the desktop's `parsePullRequestUrl` parity test
    // (apps/desktop/src/lib/api/pull-request-feedback.test.ts).
    assert_eq!(
        normalize_pull_request_url("https://github.com/acme/app/pull/42#discussion"),
        Some("https://github.com/acme/app/pull/42".to_owned())
    );
    assert_eq!(
        normalize_pull_request_url("https://github.com/acme/app/pull/007"),
        Some("https://github.com/acme/app/pull/7".to_owned())
    );
    for rejected in [
        "http://github.com/acme/app/pull/1",
        "https://github.com/acme/app/issues/1",
        "https://github.com/acme/app/pull/0",
        "https://github.com/acme/../pull/1",
        "https://evil.example/acme/app/pull/1",
        "https://github.com/acme/./pull/1",
        "https://github.com//app/pull/1",
        "https://github.com/acme/app/pull/",
        "https://github.com/acme/app/pull/42abc",
        "https://github.com/acme/app/pull/-1",
        "https://github.com.evil.example/acme/app/pull/1",
    ] {
        assert_eq!(normalize_pull_request_url(rejected), None, "{rejected}");
    }
}

#[tokio::test]
async fn linked_pull_requests_round_trip_through_listing() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .ensure_conversation("chat", Some("claude"), None, Tenancy::Unattributed)
        .await
        .unwrap();
    let first = "https://github.com/acme/app/pull/1";
    let second = "https://github.com/acme/api/pull/2";
    store
        .set_pull_request_linked("chat", first, true)
        .await
        .unwrap();
    store
        .set_pull_request_linked("chat", second, true)
        .await
        .unwrap();
    // Re-linking is idempotent and moves nothing but order.
    let linked = store
        .set_pull_request_linked("chat", first, true)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(linked, vec![second.to_owned(), first.to_owned()]);
    let listed = store.list_conversations().await.unwrap();
    assert_eq!(listed[0].linked_pull_requests, linked);
    let unlinked = store
        .set_pull_request_linked("chat", second, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unlinked, vec![first.to_owned()]);
    assert!(store
        .set_pull_request_linked("missing", first, true)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn linked_pull_requests_are_capped_per_conversation() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .ensure_conversation("chat", Some("claude"), None, Tenancy::Unattributed)
        .await
        .unwrap();
    for number in 1..=MAX_LINKED_PULL_REQUESTS {
        store
            .set_pull_request_linked(
                "chat",
                &format!("https://github.com/acme/app/pull/{number}"),
                true,
            )
            .await
            .unwrap();
    }
    let over = format!(
        "https://github.com/acme/app/pull/{}",
        MAX_LINKED_PULL_REQUESTS + 1
    );
    assert!(store
        .set_pull_request_linked("chat", &over, true)
        .await
        .is_err());
    // Re-linking an existing URL at the cap only reorders it.
    let relinked = store
        .set_pull_request_linked("chat", "https://github.com/acme/app/pull/1", true)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(relinked.len(), MAX_LINKED_PULL_REQUESTS);
    assert_eq!(
        relinked.last().map(String::as_str),
        Some("https://github.com/acme/app/pull/1")
    );
}

#[tokio::test]
async fn imported_messages_cannot_cross_a_recreated_conversation_generation() {
    let store = ConversationStore::open_in_memory().unwrap();
    let old = store
        .ensure_conversation_with_generation("chat", Some("claude"), None, Tenancy::Unattributed)
        .await
        .unwrap();
    store
        .set_import_source("chat", "import:claude", Some("native-old"))
        .await
        .unwrap();
    let identity = store
        .find_imported_conversation_with_generation(
            "import:claude",
            "native-old",
            &Tenancy::Unattributed,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(identity, ("chat".to_owned(), old.clone()));
    store
        .append_imported_message_at(
            "chat",
            &old,
            "user",
            "legitimate import",
            Some("claude"),
            Tenancy::Unattributed,
            Some(1),
        )
        .await
        .unwrap();
    store
        .conn
        .lock()
        .await
        .execute("DELETE FROM conversations WHERE id = 'chat'", [])
        .unwrap();
    let new = store
        .ensure_conversation_with_generation("chat", Some("claude"), None, Tenancy::Unattributed)
        .await
        .unwrap();
    assert_ne!(old, new);
    let before = store.get_messages("chat").await.unwrap().len();
    assert!(store
        .append_imported_message_at(
            "chat",
            &old,
            "user",
            "prior native transcript",
            Some("claude"),
            Tenancy::Unattributed,
            Some(1)
        )
        .await
        .is_err());
    assert_eq!(store.get_messages("chat").await.unwrap().len(), before);
    store
        .append_imported_message_at(
            "chat",
            &new,
            "user",
            "current import",
            Some("claude"),
            Tenancy::Unattributed,
            Some(1),
        )
        .await
        .unwrap();
    assert_eq!(store.get_messages("chat").await.unwrap().len(), before + 1);
}

#[tokio::test]
async fn channel_sessions_are_org_shared_and_machine_marked() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .ensure_channel_conversation(
            "channel:bot-1:chat-1",
            "bot-1",
            Some("agent-1"),
            Some("org-1"),
        )
        .await
        .unwrap();

    assert!(store
        .is_channel_conversation("channel:bot-1:chat-1")
        .await
        .unwrap());
    let meta = store
        .get_access_meta("channel:bot-1:chat-1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(meta.owner_user_id, None);
    assert_eq!(meta.org_id.as_deref(), Some("org-1"));
    assert_eq!(meta.visibility, "org");
}

#[tokio::test]
async fn imported_conversation_dedup_is_scoped_to_creation_tenancy() {
    let store = ConversationStore::open_in_memory().unwrap();
    let origin = "import:claude";
    let native_id = "native-session-1";

    store
        .ensure_conversation(
            "alice-import",
            Some("agent-claude"),
            Some("Alice"),
            Tenancy::Owned {
                user_id: "alice".to_owned(),
                org_id: Some("org1".to_owned()),
            },
        )
        .await
        .unwrap();
    store
        .set_import_source("alice-import", origin, Some(native_id))
        .await
        .unwrap();

    store
        .ensure_conversation(
            "shared-import",
            Some("agent-claude"),
            Some("Shared"),
            Tenancy::SharedOrg {
                org_id: "org1".to_owned(),
            },
        )
        .await
        .unwrap();
    store
        .set_import_source("shared-import", origin, Some(native_id))
        .await
        .unwrap();

    let alice = Tenancy::Owned {
        user_id: "alice".to_owned(),
        org_id: Some("org1".to_owned()),
    };
    let bob = Tenancy::Owned {
        user_id: "bob".to_owned(),
        org_id: Some("org1".to_owned()),
    };
    let shared = Tenancy::SharedOrg {
        org_id: "org1".to_owned(),
    };

    assert_eq!(
        store
            .find_imported_conversation(origin, native_id, &alice)
            .await
            .unwrap(),
        Some("alice-import".to_owned())
    );
    assert_eq!(
        store
            .find_imported_conversation(origin, native_id, &bob)
            .await
            .unwrap(),
        None,
        "Bob must never deduplicate into Alice's private import"
    );
    assert_eq!(
        store
            .find_imported_conversation(origin, native_id, &shared)
            .await
            .unwrap(),
        Some("shared-import".to_owned())
    );
    assert_eq!(
        store
            .find_imported_conversation(origin, native_id, &Tenancy::Unattributed)
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn private_import_access_is_checked_before_reuse() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .ensure_conversation(
            "alice-private-import",
            Some("agent-claude"),
            Some("Alice"),
            Tenancy::Owned {
                user_id: "alice".to_owned(),
                org_id: Some("org1".to_owned()),
            },
        )
        .await
        .unwrap();
    store
        .set_import_source(
            "alice-private-import",
            "import:claude",
            Some("native-session-2"),
        )
        .await
        .unwrap();

    let bob = crate::identity_verify::VerifiedCaller {
        user_id: "bob".to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org1".to_owned()),
        role: crate::identity_verify::OrgRole::Member,
        teams: Vec::new(),
    };
    let bob_tenancy = Tenancy::Owned {
        user_id: bob.user_id.clone(),
        org_id: bob.org_id.clone(),
    };

    assert_eq!(
        store
            .find_imported_conversation("import:claude", "native-session-2", &bob_tenancy)
            .await
            .unwrap(),
        None,
        "a different caller cannot reuse the private import key"
    );
    assert!(
        crate::server::require_resource_write(
            store.get_access_meta("alice-private-import").await,
            Some(&bob),
            "conversation not found",
        )
        .is_err(),
        "the canonical conversation gate must deny Bob before message access"
    );
}

#[tokio::test]
async fn agent_control_is_conversation_scoped_and_consumed_once() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .ensure_conversation(
            "control-conversation",
            Some("caller-agent"),
            None,
            Tenancy::Unattributed,
        )
        .await
        .unwrap();

    let pending = crate::agent_control::PendingAgentControl {
        patch: crate::agent_control::AgentControlPatch {
            agent_id: Some("better-agent".to_owned()),
            clear_agent_id: false,
            model: Some("strong-model".to_owned()),
            clear_model: false,
            effort: Some("high".to_owned()),
            clear_effort: false,
        },
        requested_by: "caller-agent".to_owned(),
        requested_at: 123,
    };
    store
        .set_pending_agent_control("control-conversation", &pending)
        .await
        .unwrap();

    assert!(store
        .is_conversation_agent("control-conversation", "caller-agent")
        .await
        .unwrap());
    assert!(!store
        .is_conversation_agent("control-conversation", "other-agent")
        .await
        .unwrap());
    assert_eq!(
        store
            .take_pending_agent_control("control-conversation")
            .await
            .unwrap(),
        Some(pending)
    );
    assert!(store
        .take_pending_agent_control("control-conversation")
        .await
        .unwrap()
        .is_none());

    let clear_pending = crate::agent_control::PendingAgentControl {
        patch: crate::agent_control::AgentControlPatch {
            agent_id: None,
            clear_agent_id: false,
            model: None,
            clear_model: true,
            effort: None,
            clear_effort: true,
        },
        requested_by: "caller-agent".to_owned(),
        requested_at: 456,
    };
    store
        .set_pending_agent_control("control-conversation", &clear_pending)
        .await
        .unwrap();
    assert_eq!(
        store
            .take_pending_agent_control("control-conversation")
            .await
            .unwrap(),
        Some(clear_pending)
    );
}

#[tokio::test]
async fn verified_widget_provenance_survives_message_reload() {
    let store = ConversationStore::open_in_memory().unwrap();
    let provenance = MessageProvenance {
        source: "widget".to_owned(),
        widget_instance_id: "wgt_server_minted".to_owned(),
        origin_server: "com.example.weather".to_owned(),
    };

    store
        .append_message_as_with_provenance(
            "widget-conversation",
            "user",
            "What is the weather?",
            None,
            None,
            None,
            Tenancy::Unattributed,
            Some(&provenance),
        )
        .await
        .unwrap();

    // The normal conversation read is the reload/render path. The
    // attribution must come from the persisted server columns, remain bound
    // to this conversation row, and never appear in another thread.
    let reloaded = store
        .get_conversation_detail("widget-conversation")
        .await
        .unwrap()
        .unwrap();
    let message = &reloaded.messages[0];
    assert_eq!(reloaded.id, "widget-conversation");
    assert_eq!(message.source.as_deref(), Some("widget"));
    assert_eq!(
        message.widget_instance_id.as_deref(),
        Some("wgt_server_minted")
    );
    assert_eq!(
        message.origin_server.as_deref(),
        Some("com.example.weather")
    );
    assert!(store
        .get_messages("different-conversation")
        .await
        .unwrap()
        .is_empty());
}
