use crate::server::update_check_fail_open_body;

/// The fail-open arm must answer with the SAME keys a successful verdict does,
/// plus `error`. A client that reads a new field would otherwise see it simply
/// missing when GitHub is unreachable — and for `restricted_by_cutoff` that
/// silence is indistinguishable from "your updates window lapsed".
#[test]
fn update_check_fail_open_matches_the_verdict_shape() {
    let verdict = crate::update::UpdateCheck {
        current: "1.0.0".to_string(),
        latest: "1.0.0".to_string(),
        channel: "stable".to_string(),
        update_available: false,
        notes: None,
        html_url: None,
        asset: None,
        tag: None,
        published_at: None,
        latest_unrestricted: "1.0.0".to_string(),
        restricted_by_cutoff: false,
        cutoff_waived_for_security: false,
        cutoff_unresolved: false,
    };
    let mut expected: Vec<String> = serde_json::to_value(&verdict)
        .unwrap()
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    expected.push("error".to_string());
    expected.sort();

    let body = update_check_fail_open_body("1.0.0", "stable", "boom");
    let mut actual: Vec<String> = body.as_object().unwrap().keys().cloned().collect();
    actual.sort();

    assert_eq!(actual, expected);
}

/// A network failure is NOT a lapsed updates window: both cutoff flags stay
/// false here so the desktop never shows an "updates expired" state because
/// GitHub was down.
#[test]
fn update_check_fail_open_never_reports_a_cutoff() {
    let body = update_check_fail_open_body("1.0.0", "stable", "boom");
    assert_eq!(body["restricted_by_cutoff"], serde_json::Value::Bool(false));
    assert_eq!(body["cutoff_unresolved"], serde_json::Value::Bool(false));
    assert_eq!(
        body["cutoff_waived_for_security"],
        serde_json::Value::Bool(false)
    );
    assert_eq!(body["latest_unrestricted"], body["current"]);
}
