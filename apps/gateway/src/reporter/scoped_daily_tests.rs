use super::super::tests::{base_entry, test_state};
use super::*;

fn org_row(project: Option<&str>, agent: Option<&str>, key: Option<&str>) -> AuditEntry {
    let mut entry = base_entry();
    entry.org_id = Some("org1".to_owned());
    entry.project_id = project.map(str::to_owned);
    entry.agent_id = agent.map(str::to_owned);
    entry.key_id = key.map(str::to_owned);
    entry.provider_cost_micro_usd = Some(5);
    entry
}

#[test]
fn project_daily_counts_only_org_rows_in_the_team_daily_shape() {
    let state = test_state();
    let mut unscoped = base_entry();
    unscoped.project_id = Some("proj_x".to_owned());
    let rows = build_project_daily(
        &state,
        &[
            org_row(Some("proj_1"), None, None),
            unscoped,
            org_row(None, None, None),
        ],
    );
    assert_eq!(
        rows.len(),
        1,
        "unattributed and project-less rows are skipped"
    );
    assert_eq!(rows[0]["projectId"], "proj_1");
    assert_eq!(rows[0]["costMicroUsd"], 5);
    assert_eq!(rows[0]["day"], "2026-07-23");
    assert!(rows[0]["rollupId"].as_str().is_some());
    let mut team_row = org_row(None, None, None);
    team_row.team_id = Some("team_1".to_owned());
    let teams = super::super::build_team_daily(&state, &[team_row]);
    let fields = |row: &Value, id: &str| {
        let mut keys: Vec<String> = row
            .as_object()
            .unwrap()
            .keys()
            .filter(|key| *key != id)
            .cloned()
            .collect();
        keys.sort();
        keys
    };
    assert_eq!(fields(&rows[0], "projectId"), fields(&teams[0], "teamId"));
}

#[test]
fn bot_daily_buckets_per_serving_key_and_skips_unattributed_agents() {
    let state = test_state();
    let mut anonymous = base_entry();
    // An unattributed row's agent id is caller input: never a bot.
    anonymous.agent_id = Some("spoofed".to_owned());
    let mut second = org_row(None, Some("bot_a"), Some("cred_2"));
    second.id = 2;
    let mut rows = build_bot_daily(
        &state,
        &[
            org_row(None, Some("bot_a"), Some("cred_1")),
            second,
            org_row(None, Some("bot_b"), None),
            anonymous,
        ],
    );
    rows.sort_by_key(|row| (row["botId"].to_string(), row["keyId"].to_string()));
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["botId"], "bot_a");
    assert_eq!(rows[0]["keyId"], "cred_1");
    assert_eq!(rows[1]["keyId"], "cred_2");
    assert_ne!(rows[0]["rollupId"], rows[1]["rollupId"]);
    assert_eq!(rows[2]["botId"], "bot_b");
    assert!(rows[2].get("keyId").is_none(), "a static key has no key id");
    assert!(rows.iter().all(|row| row["botId"] != "spoofed"));
}
