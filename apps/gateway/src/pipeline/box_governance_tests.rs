use super::*;

fn budget(body: serde_json::Value) -> BoxOrgBudget {
    serde_json::from_value(body).expect("budget view parses")
}

#[test]
fn a_view_without_governance_yields_none() {
    let view = budget(serde_json::json!({"managedInference": true}));
    assert!(box_governance("org-1", &view, std::time::Instant::now()).is_none());
}

#[test]
fn governance_maps_policy_limits_ceiling_and_teams() {
    let view = budget(serde_json::json!({
        "managedInference": true,
        "remainingBudgetMicroUsd": 7,
        "governance": {
            "policy": {"rules": {"approvedModels": ["cheap"], "deniedTools": null}},
            "limits": {"org": {"rpm": 100}},
            "planRateCeiling": {"rpm": 10, "tpm": 1000},
            "teamIds": ["t2", " ", "t1", "t2"],
            "policyVersion": "v1-abc",
            "standing": {"state": "active", "refuses": "none"}
        }
    }));
    let governance = box_governance("org-1", &view, std::time::Instant::now()).unwrap();
    let resolved = &governance.resolved;
    assert_eq!(resolved.org_id, "org-1");
    assert!(resolved.policy.available);
    assert!(!resolved.policy.allows_model("expensive"));
    assert_eq!(resolved.remaining_budget_micro_usd, Some(7));
    assert_eq!(resolved.policy_version.as_deref(), Some("v1-abc"));
    // The plan ceiling narrows the billed view only.
    assert_eq!(resolved.limits.org.as_ref().unwrap().rpm, Some(100));
    assert_eq!(resolved.billed_limits.org.as_ref().unwrap().rpm, Some(10));
    assert_eq!(governance.team_ids, vec!["t1".to_owned(), "t2".to_owned()]);
    assert!(resolved.standing.serves_everything());
}

#[test]
fn a_missing_or_refusing_standing_never_loads_a_permissive_policy() {
    for standing in [
        serde_json::Value::Null,
        serde_json::json!({"state": "org_suspended", "refuses": "all"}),
    ] {
        let view = budget(serde_json::json!({
            "governance": {"policy": {"rules": {}}, "standing": standing}
        }));
        let governance = box_governance("org-1", &view, std::time::Instant::now()).unwrap();
        assert!(!governance.resolved.policy.available);
        assert!(!governance.resolved.policy.allows_model("any"));
        assert!(governance
            .resolved
            .standing
            .refusal(crate::custody::GatewayCustody::SelfHosted)
            .is_some());
    }
}

#[test]
fn an_org_scope_ladder_entry_travels_into_the_resolved_standing() {
    let view = budget(serde_json::json!({
        "governance": {
            "policy": {"rules": {}},
            "standing": {
                "state": "active",
                "refuses": "none",
                "ladder": [{"scope": "org", "level": 2, "reasonClass": "platform_abuse"}]
            }
        }
    }));
    let governance = box_governance("org-1", &view, std::time::Instant::now()).unwrap();
    let ladder = &governance.resolved.standing.ladder;
    assert_eq!(ladder.len(), 1);
    assert_eq!(ladder[0].level, 2);
    assert!(governance.resolved.policy.available);
}
