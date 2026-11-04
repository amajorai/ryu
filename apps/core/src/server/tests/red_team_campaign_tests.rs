use crate::server::{red_team_case_protected, red_team_cases, selected_red_team_specs};

#[test]
fn selects_the_default_campaign_and_deduplicates_requested_strategies() {
    let defaults = selected_red_team_specs(&[]).expect("default strategies");
    assert_eq!(defaults.len(), 10);
    assert_eq!(defaults[0].0, "prompt_injection");

    let requested = selected_red_team_specs(&[
        "tool_misuse".to_owned(),
        "tool_misuse".to_owned(),
        "prompt_injection".to_owned(),
    ])
    .expect("known strategies");
    assert_eq!(
        requested.iter().map(|spec| spec.0).collect::<Vec<_>>(),
        ["tool_misuse", "prompt_injection",]
    );
    let cases = red_team_cases(&requested);
    assert_eq!(cases[0]["id"], "red-team-tool_misuse");
    assert_eq!(cases[1]["id"], "red-team-prompt_injection");
}

#[test]
fn refuses_unknown_strategy_ids() {
    let error = selected_red_team_specs(&["arbitrary_prompt".to_owned()])
        .expect_err("unknown probes must be rejected");
    assert!(error.contains("unknown red-team strategy"));
}

#[test]
fn security_polarity_marks_detected_and_clean_outputs_correctly() {
    let blocked_input = serde_json::json!({
        "policy_pass": true,
        "evaluators": [{ "id": "prompt_injection", "pass": false }]
    });
    assert!(red_team_case_protected("prompt_injection", &blocked_input));

    let clean_output = serde_json::json!({
        "policy_pass": true,
        "evaluators": [{ "id": "pii_leakage", "pass": true }]
    });
    assert!(red_team_case_protected("pii_exfiltration", &clean_output));

    let unsafe_output = serde_json::json!({
        "policy_pass": true,
        "evaluators": [{ "id": "toxicity", "pass": false }]
    });
    assert!(!red_team_case_protected("toxic_output", &unsafe_output));

    let blocked_code = serde_json::json!({
        "policy_pass": true,
        "evaluators": [{ "id": "code_injection", "pass": false }]
    });
    assert!(red_team_case_protected("sql_injection", &blocked_code));
}
