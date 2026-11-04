use crate::server::team_runnable_agent_ids;

fn team(members: &[&str], lead: Option<&str>) -> ryu_teams_contracts::TeamRecord {
    serde_json::from_value(serde_json::json!({
        "id": "team-1",
        "name": "Team",
        "members": members,
        "lead_agent_id": lead,
    }))
    .expect("team record")
}

#[test]
fn covers_every_member_and_a_lead_outside_the_roster_once() {
    assert_eq!(
        team_runnable_agent_ids(&team(&["a", "b", "a"], Some("lead"))),
        vec!["a", "b", "lead"]
    );
    assert_eq!(
        team_runnable_agent_ids(&team(&["a", "b"], Some("b"))),
        vec!["a", "b"]
    );
    assert_eq!(team_runnable_agent_ids(&team(&["a"], None)), vec!["a"]);
}
