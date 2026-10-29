//! Main-thread ownership tests: personal bot main threads per principal and
//! the one-time replacement of the shared bot main-thread index.

use super::store::*;
use super::*;

#[tokio::test]
async fn personal_bot_main_threads_isolate_principals_but_project_coordinator_stays_shared() {
    let store = ConversationStore::open_in_memory().unwrap();
    let owned = |user: &str| Tenancy::Owned {
        user_id: user.to_owned(),
        org_id: Some("org".to_owned()),
    };
    let ensure = |tenancy: Tenancy| {
        store.ensure_main_thread(
            None,
            OwnerKind::Agent,
            "scout",
            Some("scout"),
            None,
            tenancy,
        )
    };
    let alice = ensure(owned("alice")).await.unwrap();
    let bob = ensure(owned("bob")).await.unwrap();
    let operator = ensure(Tenancy::Unattributed).await.unwrap();
    assert_ne!(alice, bob);
    assert_ne!(alice, operator);
    assert_ne!(bob, operator);
    assert_eq!(ensure(owned("alice")).await.unwrap(), alice);
    assert_eq!(ensure(Tenancy::Unattributed).await.unwrap(), operator);
    for (tenancy, expected) in [
        (owned("alice"), &alice),
        (owned("bob"), &bob),
        (Tenancy::Unattributed, &operator),
    ] {
        assert_eq!(
            store
                .find_main_thread_for_tenancy(None, OwnerKind::Agent, "scout", &tenancy)
                .await
                .unwrap()
                .as_ref(),
            Some(expected)
        );
    }
    assert!(store
        .find_main_thread_for_tenancy(None, OwnerKind::Agent, "scout", &owned("carol"))
        .await
        .unwrap()
        .is_none());
    let project = |tenancy| {
        store.ensure_main_thread(
            Some("atlas"),
            OwnerKind::Project,
            "atlas",
            Some("scout"),
            None,
            tenancy,
        )
    };
    let shared = project(Tenancy::Unattributed).await.unwrap();
    assert_eq!(project(owned("bob")).await.unwrap(), shared);
    let project_bot = store
        .ensure_main_thread(
            Some("atlas"),
            OwnerKind::Agent,
            "scout",
            None,
            None,
            owned("alice"),
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .ensure_main_thread(
                Some("atlas"),
                OwnerKind::Agent,
                "scout",
                None,
                None,
                owned("bob")
            )
            .await
            .unwrap(),
        project_bot
    );
}

#[test]
fn shared_bot_main_index_is_replaced_once_and_keeps_existing_rows() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE conversations (id TEXT PRIMARY KEY, participants TEXT NOT NULL DEFAULT '[]',
             owner_user_id TEXT, org_id TEXT, project_id TEXT,
             thread_role TEXT NOT NULL DEFAULT 'session', owner_kind TEXT, owner_id TEXT,
             coordination TEXT, spawned_by_conversation_id TEXT, spawned_by_message_id TEXT);
         CREATE TABLE conversation_collaborators (conversation_id TEXT, user_id TEXT, role TEXT);
         CREATE UNIQUE INDEX idx_conversations_main_owner
             ON conversations(IFNULL(project_id, ''), owner_kind, owner_id)
             WHERE thread_role = 'main';
         INSERT INTO conversations (id, thread_role, owner_kind, owner_id)
             VALUES ('legacy-bot-main', 'main', 'agent', 'scout');",
    )
    .unwrap();
    let columns: std::collections::HashSet<String> = conn
        .prepare("PRAGMA table_info(conversations)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    for _ in 0..2 {
        migrate(&conn, &columns).unwrap();
    }
    assert_eq!(
        find_main_thread_locked(
            &conn,
            None,
            OwnerKind::Agent,
            "scout",
            Some(&Tenancy::Unattributed)
        )
        .unwrap()
        .as_deref(),
        Some("legacy-bot-main")
    );
    // A verified user now gets their own bot main thread next to the legacy one.
    conn.execute(
        "INSERT INTO conversations (id, thread_role, owner_kind, owner_id, owner_user_id)
         VALUES ('alice-bot-main', 'main', 'agent', 'scout', 'alice')",
        [],
    )
    .unwrap();
    assert!(conn
        .execute(
            "INSERT INTO conversations (id, thread_role, owner_kind, owner_id, owner_user_id)
             VALUES ('alice-duplicate', 'main', 'agent', 'scout', 'alice')",
            [],
        )
        .is_err());
    conn.execute(
        "INSERT INTO conversations (id, thread_role, owner_kind, owner_id, project_id)
         VALUES ('atlas-main', 'main', 'project', 'atlas', 'atlas')",
        [],
    )
    .unwrap();
    assert!(conn
        .execute(
            "INSERT INTO conversations (id, thread_role, owner_kind, owner_id, project_id, owner_user_id)
             VALUES ('atlas-duplicate', 'main', 'project', 'atlas', 'atlas', 'bob')",
            [],
        )
        .is_err());
}
