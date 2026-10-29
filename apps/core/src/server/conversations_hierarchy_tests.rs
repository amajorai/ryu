//! Unit tests for the hierarchy primitives (`conversations_hierarchy.rs`).

use super::defaults::*;
use super::*;

fn level(provider: &str, model: &str, effort: &str) -> Option<ScopeDefault> {
    Some(ScopeDefault {
        provider: provider.to_owned(),
        model: model.to_owned(),
        effort: effort.to_owned(),
        ..ScopeDefault::default()
    })
}

fn coordinator(model: &str, effort: &str) -> ScopeDefault {
    ScopeDefault {
        coordinator_provider: "anthropic".into(),
        coordinator_model: model.to_owned(),
        coordinator_effort: effort.to_owned(),
        ..ScopeDefault::default()
    }
}

#[test]
fn sessions_ignore_coordinator_values() {
    let levels = CascadeLevels {
        project: Some(ScopeDefault {
            model: "thread-model".into(),
            ..coordinator("coord-model", "high")
        }),
        ..CascadeLevels::default()
    }
    .for_role(DefaultsRole::Thread);
    let resolved = resolve_cascade(&levels);
    assert_eq!(resolved.model, "thread-model");
    assert_eq!(resolved.effort, "");
}

#[test]
fn a_coordinator_value_anywhere_beats_thread_values_for_main_threads() {
    // The project sets only a thread model; Settings › Models sets a
    // coordinator model. Main threads coordinate on the Settings model, and
    // their effort still falls back to the project's thread effort.
    let levels = CascadeLevels {
        project: level("openai", "thread-model", "low"),
        settings: Some(coordinator("coord-model", "")),
        ..CascadeLevels::default()
    }
    .for_role(DefaultsRole::Coordinator);
    let resolved = resolve_cascade(&levels);
    assert_eq!(resolved.provider, "anthropic");
    assert_eq!(resolved.model, "coord-model");
    assert_eq!(resolved.model_source, Some(DefaultSource::Settings));
    assert_eq!(resolved.effort, "low");
    assert_eq!(resolved.effort_source, Some(DefaultSource::Project));
}

#[test]
fn coordinator_values_keep_the_level_order_and_the_agent_binding() {
    let levels = CascadeLevels {
        agent: Some(coordinator("bot-coord", "")),
        project: Some(coordinator("project-coord", "")),
        settings: Some(coordinator("settings-coord", "")),
        ..CascadeLevels::default()
    }
    .for_role(DefaultsRole::Coordinator);
    assert_eq!(resolve_cascade(&levels).model, "bot-coord");
    let bound = CascadeLevels {
        agent_binding_model: Some("bound".into()),
        settings: Some(coordinator("settings-coord", "")),
        ..CascadeLevels::default()
    }
    .for_role(DefaultsRole::Coordinator);
    assert_eq!(resolve_cascade(&bound).model, "bound");
}

#[test]
fn main_threads_use_thread_values_when_no_coordinator_is_set() {
    let levels = CascadeLevels {
        project: level("openai", "thread-model", "medium"),
        ..CascadeLevels::default()
    }
    .for_role(DefaultsRole::Coordinator);
    let resolved = resolve_cascade(&levels);
    assert_eq!(resolved.model, "thread-model");
    assert_eq!(resolved.effort, "medium");
}

#[test]
fn scope_default_writes_keep_omitted_coordinator_values() {
    let stored = ScopeDefault {
        model: "old-thread".into(),
        ..coordinator("coord-model", "high")
    };
    // An older client sends only the thread pair.
    let legacy: ScopeDefaultInput =
        serde_json::from_str(r#"{"provider":"openai","model":"new-thread"}"#).unwrap();
    let merged = legacy.merged_over(stored.clone());
    assert_eq!(merged.model, "new-thread");
    assert_eq!(merged.coordinator_model, "coord-model");
    assert_eq!(merged.coordinator_effort, "high");
    // An explicit empty value clears; both spellings are accepted.
    let reset: ScopeDefaultInput =
        serde_json::from_str(r#"{"coordinatorModel":"","coordinator_effort":"low"}"#).unwrap();
    let merged = reset.merged_over(stored);
    assert_eq!(merged.coordinator_model, "");
    assert_eq!(merged.coordinator_provider, "anthropic");
    assert_eq!(merged.coordinator_effort, "low");
}

#[test]
fn coordinator_fields_serialize_in_camel_case() {
    let value = serde_json::to_value(coordinator("coord-model", "high")).unwrap();
    assert_eq!(value["coordinatorModel"], "coord-model");
    assert_eq!(value["coordinatorProvider"], "anthropic");
    assert_eq!(value["coordinatorEffort"], "high");
    assert!(value.get("coordinator_model").is_none());
}

#[test]
fn settings_sit_between_project_and_lane() {
    let resolved = resolve_cascade(&CascadeLevels {
        settings: level("anthropic", "settings-model", ""),
        global: level("openai", "lane-model", "low"),
        ..CascadeLevels::default()
    });
    assert_eq!(resolved.model, "settings-model");
    assert_eq!(resolved.model_source, Some(DefaultSource::Settings));
    assert_eq!(resolved.effort_source, Some(DefaultSource::Global));
}

#[test]
fn cascade_picks_the_most_specific_model_as_a_pair() {
    let resolved = resolve_cascade(&CascadeLevels {
        session: None,
        project_agent: level("", "", "high"),
        agent: None,
        agent_binding_model: None,
        project: level("anthropic", "claude-x", "low"),
        settings: None,
        global: level("openai", "gpt-x", "medium"),
    });
    assert_eq!(resolved.provider, "anthropic");
    assert_eq!(resolved.model, "claude-x");
    assert_eq!(resolved.model_source, Some(DefaultSource::Project));
    // Effort falls through independently: the bot-in-project level set only it.
    assert_eq!(resolved.effort, "high");
    assert_eq!(resolved.effort_source, Some(DefaultSource::ProjectAgent));
}

#[test]
fn a_provider_without_a_model_never_pairs_with_another_levels_model() {
    let resolved = resolve_cascade(&CascadeLevels {
        project_agent: level("anthropic", "", ""),
        global: level("openai", "gpt-x", ""),
        ..CascadeLevels::default()
    });
    assert_eq!(resolved.provider, "openai");
    assert_eq!(resolved.model, "gpt-x");
    assert_eq!(resolved.model_source, Some(DefaultSource::Global));
}

#[test]
fn session_override_beats_everything_and_binding_beats_project() {
    let all = CascadeLevels {
        session: level("p", "session-model", ""),
        project_agent: level("p", "pa-model", ""),
        agent: level("p", "agent-model", ""),
        agent_binding_model: Some("bound-model".into()),
        project: level("p", "project-model", ""),
        settings: level("p", "settings-model", ""),
        global: level("p", "global-model", ""),
    };
    assert_eq!(resolve_cascade(&all).model, "session-model");
    let no_overrides = CascadeLevels {
        session: None,
        project_agent: None,
        agent: None,
        ..all
    };
    let resolved = resolve_cascade(&no_overrides);
    assert_eq!(resolved.model, "bound-model");
    assert_eq!(resolved.model_source, Some(DefaultSource::AgentBinding));
}

#[test]
fn nothing_set_resolves_empty() {
    let resolved = resolve_cascade(&CascadeLevels::default());
    assert!(resolved.model.is_empty());
    assert_eq!(resolved.model_source, None);
    assert_eq!(resolved.effort_source, None);
}

#[test]
fn scope_shapes_validate() {
    assert!(is_valid_scope("project:atlas"));
    assert!(is_valid_scope("agent:ryu"));
    assert!(is_valid_scope("project:atlas/agent:ryu"));
    assert!(is_valid_scope("global"));
    assert!(!is_valid_scope("project:"));
    assert!(!is_valid_scope("project:a/b"));
    assert!(!is_valid_scope("team:x"));
    assert!(!is_valid_scope("project:atlas/agent:"));
}

#[tokio::test]
async fn one_main_thread_per_project_owner_scope() {
    let store = ConversationStore::open_in_memory().unwrap();
    let global = store
        .ensure_main_thread(
            None,
            OwnerKind::Agent,
            "scout",
            Some("scout"),
            Some("Scout"),
            Tenancy::Unattributed,
        )
        .await
        .unwrap();
    let again = store
        .ensure_main_thread(
            None,
            OwnerKind::Agent,
            "scout",
            None,
            None,
            Tenancy::Unattributed,
        )
        .await
        .unwrap();
    assert_eq!(global, again);
    let in_project = store
        .ensure_main_thread(
            Some("atlas"),
            OwnerKind::Agent,
            "scout",
            None,
            None,
            Tenancy::Unattributed,
        )
        .await
        .unwrap();
    assert_ne!(
        global, in_project,
        "a bot's project thread is separate from its global thread"
    );
    let group = store
        .ensure_main_thread(
            Some("atlas"),
            OwnerKind::Group,
            "reviewers",
            None,
            None,
            Tenancy::Unattributed,
        )
        .await
        .unwrap();
    let hierarchy = store.thread_hierarchy(&group).await.unwrap().unwrap();
    assert!(hierarchy.is_main());
    assert_eq!(hierarchy.project_id.as_deref(), Some("atlas"));
    assert_eq!(hierarchy.owner_kind.as_deref(), Some("group"));
    assert_eq!(
        store
            .find_main_thread(Some("atlas"), OwnerKind::Group, "reviewers")
            .await
            .unwrap(),
        Some(group)
    );
    assert!(store
        .find_main_thread(None, OwnerKind::Group, "reviewers")
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn lineage_is_write_once_and_inherits_the_project() {
    let store = ConversationStore::open_in_memory().unwrap();
    let main = store
        .ensure_main_thread(
            Some("atlas"),
            OwnerKind::Project,
            "atlas",
            None,
            None,
            Tenancy::Unattributed,
        )
        .await
        .unwrap();
    store
        .ensure_conversation("worker", None, None, Tenancy::Unattributed)
        .await
        .unwrap();
    store
        .mark_spawned_by("worker", &main, Some("m1"))
        .await
        .unwrap();
    store
        .ensure_conversation("other", None, None, Tenancy::Unattributed)
        .await
        .unwrap();
    store
        .mark_spawned_by("worker", "other", None)
        .await
        .unwrap();
    let worker = store.thread_hierarchy("worker").await.unwrap().unwrap();
    assert_eq!(
        worker.spawned_by_conversation_id.as_deref(),
        Some(main.as_str())
    );
    assert_eq!(worker.spawned_by_message_id.as_deref(), Some("m1"));
    assert_eq!(worker.project_id.as_deref(), Some("atlas"));
    let sessions = store.list_spawned_sessions(&main).await.unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id, "worker");
    assert_eq!(sessions[0].hierarchy.thread_role, THREAD_ROLE_SESSION);
    let project = store.list_project_threads("atlas").await.unwrap();
    assert_eq!(project.len(), 2);
    // A main thread is never re-parented as somebody's session.
    store.mark_spawned_by(&main, "other", None).await.unwrap();
    let main_row = store.thread_hierarchy(&main).await.unwrap().unwrap();
    assert!(main_row.spawned_by_conversation_id.is_none());
}

#[tokio::test]
async fn scope_defaults_round_trip_and_clear() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .set_scope_default(
            &project_scope("atlas"),
            ScopeDefault {
                provider: "anthropic".into(),
                model: "claude-x".into(),
                ..ScopeDefault::default()
            },
        )
        .await
        .unwrap();
    store
        .set_scope_default(
            &project_agent_scope("atlas", "scout"),
            ScopeDefault {
                effort: "high".into(),
                coordinator_model: "coord-x".into(),
                ..ScopeDefault::default()
            },
        )
        .await
        .unwrap();
    let levels = store
        .stored_cascade_levels(Some("atlas"), Some("scout"), DefaultsRole::Thread)
        .await
        .unwrap();
    assert_eq!(levels.project.as_ref().unwrap().model, "claude-x");
    assert_eq!(levels.project_agent.as_ref().unwrap().effort, "high");
    assert!(levels.agent.is_none());
    assert!(levels.settings.is_none());
    // The coordinator column round-trips and only main threads read it.
    let main = store
        .stored_cascade_levels(Some("atlas"), Some("scout"), DefaultsRole::Coordinator)
        .await
        .unwrap();
    assert_eq!(main.project_agent.as_ref().unwrap().model, "coord-x");
    assert!(main.project.is_none());
    store
        .set_scope_default(
            GLOBAL_SCOPE,
            ScopeDefault {
                model: "everywhere".into(),
                ..ScopeDefault::default()
            },
        )
        .await
        .unwrap();
    let with_settings = store
        .stored_cascade_levels(None, None, DefaultsRole::Thread)
        .await
        .unwrap();
    assert_eq!(with_settings.settings.unwrap().model, "everywhere");
    store
        .set_scope_default(GLOBAL_SCOPE, ScopeDefault::default())
        .await
        .unwrap();
    store
        .set_scope_default(&project_scope("atlas"), ScopeDefault::default())
        .await
        .unwrap();
    assert!(store
        .scope_default(&project_scope("atlas"))
        .await
        .unwrap()
        .is_none());
    assert_eq!(store.list_scope_defaults().await.unwrap().len(), 1);
}

#[tokio::test]
async fn group_promotion_and_coordination() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .ensure_conversation("council", None, None, Tenancy::Unattributed)
        .await
        .unwrap();
    assert!(!store
        .set_group_coordination("council", Some("router"))
        .await
        .unwrap());
    store
        .add_participant("council", "a", Tenancy::Unattributed)
        .await
        .unwrap();
    store
        .add_participant("council", "b", Tenancy::Unattributed)
        .await
        .unwrap();
    assert!(store.promote_to_group_main("council").await.unwrap());
    assert!(!store.promote_to_group_main("council").await.unwrap());
    assert!(store
        .set_group_coordination("council", Some("router"))
        .await
        .unwrap());
    assert!(store
        .set_group_coordination("council", Some("vote"))
        .await
        .is_err());
    let summary = store.get_summary("council").await.unwrap().unwrap();
    assert_eq!(summary.hierarchy.owner_kind.as_deref(), Some("group"));
    assert_eq!(summary.hierarchy.owner_id.as_deref(), Some("council"));
    assert_eq!(summary.hierarchy.coordination.as_deref(), Some("router"));
    let wire = serde_json::to_value(&summary).unwrap();
    assert_eq!(wire["thread_role"], "main");
}

#[test]
fn existing_multi_agent_chats_backfill_as_group_main_threads() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        // init_schema adds the tenancy columns before the hierarchy migration runs.
        "CREATE TABLE conversations (id TEXT PRIMARY KEY, participants TEXT NOT NULL DEFAULT '[]', owner_user_id TEXT, org_id TEXT);
         CREATE TABLE conversation_collaborators (conversation_id TEXT, user_id TEXT, role TEXT);
         INSERT INTO conversations (id, participants) VALUES ('dm', '[\"ryu\"]'), ('council', '[\"a\",\"b\"]'), ('shared', '[]');
         INSERT INTO conversation_collaborators VALUES ('shared', 'bob', 'participant');",
    )
    .unwrap();
    let columns = ["id", "participants", "owner_user_id", "org_id"]
        .into_iter()
        .map(String::from)
        .collect();
    migrate(&conn, &columns).unwrap();
    let role = |id: &str| -> String {
        conn.query_row(
            "SELECT thread_role FROM conversations WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(role("dm"), "session");
    assert_eq!(role("council"), "main");
    assert_eq!(role("shared"), "main");
}

#[test]
fn coordination_values_validate() {
    assert!(validate_coordination(None).is_ok());
    assert!(validate_coordination(Some("debate-synthesis")).is_ok());
    assert!(validate_coordination(Some("council")).is_err());
}
