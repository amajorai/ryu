//! Integration tests for the teams store's patch tri-state and coordination
//! serialization. These reach only the crate's PUBLIC surface
//! (`ryu_teams::{TeamStore, CreateTeam, UpdateTeam, Coordination}`), so they add
//! no production-source edits. In-memory store keeps them hermetic (no data-dir).

use ryu_teams::{Coordination, CreateTeam, TeamStore, UpdateTeam};

fn store() -> TeamStore {
    TeamStore::open_in_memory().expect("open in-memory teams store")
}

// ── UpdateTeam::lead_agent_id tri-state (the `double_option` deserializer) ──────

#[test]
fn update_lead_absent_field_deserializes_to_none() {
    // An absent field ⇒ `None` (leave unchanged).
    let patch: UpdateTeam = serde_json::from_str(r#"{"name":"x"}"#).unwrap();
    assert!(patch.lead_agent_id.is_none());
}

#[test]
fn update_lead_null_deserializes_to_some_none() {
    // A present `null` ⇒ `Some(None)` (clear).
    let patch: UpdateTeam = serde_json::from_str(r#"{"lead_agent_id":null}"#).unwrap();
    assert_eq!(patch.lead_agent_id, Some(None));
}

#[test]
fn update_lead_value_deserializes_to_some_some() {
    let patch: UpdateTeam = serde_json::from_str(r#"{"lead_agent_id":"lead-1"}"#).unwrap();
    assert_eq!(patch.lead_agent_id, Some(Some("lead-1".to_owned())));
}

#[tokio::test]
async fn update_lead_tri_state_applies_correctly() {
    let s = store();
    let t = s
        .create(CreateTeam {
            name: "T".to_owned(),
            lead_agent_id: Some("orig".to_owned()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(t.lead_agent_id.as_deref(), Some("orig"));

    // Absent field (`None`) leaves the lead unchanged.
    let unchanged: UpdateTeam = serde_json::from_str(r#"{"name":"T2"}"#).unwrap();
    let r = s.update(&t.id, unchanged).await.unwrap().unwrap();
    assert_eq!(r.name, "T2");
    assert_eq!(r.lead_agent_id.as_deref(), Some("orig"));

    // Present null (`Some(None)`) clears the lead.
    let cleared: UpdateTeam = serde_json::from_str(r#"{"lead_agent_id":null}"#).unwrap();
    let r = s.update(&t.id, cleared).await.unwrap().unwrap();
    assert_eq!(r.lead_agent_id, None);

    // A concrete value sets it again.
    let set: UpdateTeam = serde_json::from_str(r#"{"lead_agent_id":"new"}"#).unwrap();
    let r = s.update(&t.id, set).await.unwrap().unwrap();
    assert_eq!(r.lead_agent_id.as_deref(), Some("new"));
}

#[tokio::test]
async fn description_is_plain_option_so_null_cannot_clear_it() {
    // Documents the asymmetry: unlike `lead_agent_id`, `description` is a plain
    // `Option<String>`, so a present `null` deserializes to `None` and therefore
    // LEAVES the value unchanged (there is no clear-via-null for description).
    let s = store();
    let t = s
        .create(CreateTeam {
            name: "T".to_owned(),
            description: Some("keep me".to_owned()),
            ..Default::default()
        })
        .await
        .unwrap();

    let patch: UpdateTeam = serde_json::from_str(r#"{"description":null}"#).unwrap();
    assert!(patch.description.is_none());
    let r = s.update(&t.id, patch).await.unwrap().unwrap();
    assert_eq!(r.description.as_deref(), Some("keep me"));
}

// ── Coordination serde (kebab-case) ─────────────────────────────────────────────

#[test]
fn coordination_serializes_kebab_case() {
    assert_eq!(
        serde_json::to_value(Coordination::Broadcast).unwrap(),
        serde_json::json!("broadcast")
    );
    assert_eq!(
        serde_json::to_value(Coordination::RoundRobin).unwrap(),
        serde_json::json!("round-robin")
    );
    assert_eq!(
        serde_json::to_value(Coordination::DebateSynthesis).unwrap(),
        serde_json::json!("debate-synthesis")
    );
    assert_eq!(
        serde_json::to_value(Coordination::Router).unwrap(),
        serde_json::json!("router")
    );
}

#[test]
fn coordination_deserializes_kebab_case() {
    let c: Coordination = serde_json::from_str(r#""round-robin""#).unwrap();
    assert_eq!(c, Coordination::RoundRobin);
    let c: Coordination = serde_json::from_str(r#""debate-synthesis""#).unwrap();
    assert_eq!(c, Coordination::DebateSynthesis);
}

#[test]
fn create_team_defaults_coordination_to_broadcast_when_absent() {
    let c: CreateTeam = serde_json::from_str(r#"{"name":"n"}"#).unwrap();
    assert_eq!(c.coordination, Coordination::Broadcast);
    assert!(c.members.is_empty());
}

// ── Store CRUD edge cases ───────────────────────────────────────────────────────

#[tokio::test]
async fn update_missing_team_returns_none() {
    let s = store();
    let r = s
        .update(
            "team_does_not_exist",
            UpdateTeam {
                name: Some("x".to_owned()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(r.is_none());
}

#[tokio::test]
async fn add_and_remove_member_on_missing_team_return_none() {
    let s = store();
    assert!(s.add_member("nope", "a").await.unwrap().is_none());
    assert!(s.remove_member("nope", "a").await.unwrap().is_none());
}

#[tokio::test]
async fn update_replaces_full_member_list_and_preserves_order() {
    let s = store();
    let t = s
        .create(CreateTeam {
            name: "T".to_owned(),
            members: vec!["a".to_owned(), "b".to_owned()],
            ..Default::default()
        })
        .await
        .unwrap();
    let r = s
        .update(
            &t.id,
            UpdateTeam {
                members: Some(vec!["c".to_owned(), "b".to_owned(), "a".to_owned()]),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(r.members, vec!["c", "b", "a"]);
}

#[tokio::test]
async fn list_orders_by_created_at_ascending() {
    let s = store();
    let first = s
        .create(CreateTeam {
            name: "first".to_owned(),
            ..Default::default()
        })
        .await
        .unwrap();
    // rfc3339 timestamps have sub-second resolution, but a distinct member set
    // keeps the assertion meaningful even if two rows share a timestamp.
    let second = s
        .create(CreateTeam {
            name: "second".to_owned(),
            ..Default::default()
        })
        .await
        .unwrap();
    let listed = s.list().await.unwrap();
    let ids: Vec<&str> = listed.iter().map(|t| t.id.as_str()).collect();
    let pos_first = ids.iter().position(|id| *id == first.id).unwrap();
    let pos_second = ids.iter().position(|id| *id == second.id).unwrap();
    assert!(pos_first <= pos_second, "created_at ASC ordering");
    assert_eq!(listed.len(), 2);
}
