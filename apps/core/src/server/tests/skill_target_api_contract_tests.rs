use crate::server::{
    reload_before_optional_preference_write, should_distribute_after_install, SkillDistributeBody,
    SkillInstallBody, SkillTargetPreferencesBody,
};
use crate::skills_catalog::distribution::{SkillInstallPreferencesV1, SkillTargetSelectionInput};

#[tokio::test]
async fn generic_preferences_cannot_replace_install_targets() {
    use axum::response::IntoResponse;
    use axum::{body::Body, extract::Path, http::Request, routing::put, Router};
    use tower::ServiceExt;
    let writes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = writes.clone();
    let router = Router::new().route(
        "/api/preferences/:key",
        put(move |Path(key): Path<String>| {
            let counter = counter.clone();
            async move {
                if let Some(response) = crate::server::generic_preference_write_denial(&key) {
                    return response;
                }
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                axum::http::StatusCode::OK.into_response()
            }
        }),
    );
    for key in ["skills.install-targets.v1", "skills%2Einstall-targets%2Ev1"] {
        for body in [
            r#"{"value":"{\"version\":1,\"configured\":true,\"targetIds\":[\"codex\"]}"}"#,
            r#"{"value":"{\"version\":1,\"configured\":false,\"targetIds\":[]}"}"#,
            r#"{"value":""}"#,
        ] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .method("PUT")
                        .uri(format!("/api/preferences/{key}"))
                        .header("content-type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);
        }
    }
    assert_eq!(writes.load(std::sync::atomic::Ordering::SeqCst), 0);
    let response = router
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/preferences/theme")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert_eq!(writes.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[test]
fn legacy_skill_install_body_keeps_target_prompting_disabled() {
    let body: SkillInstallBody =
        serde_json::from_str(r#"{"id":"owner/repo/demo"}"#).expect("body parses");

    assert_eq!(body.id, "owner/repo/demo");
    assert!(!body.prompt_for_targets);
    assert!(body.target_ids.is_none());
    assert!(!body.remember_target_ids);
}

#[test]
fn skill_install_body_accepts_camel_case_target_selection_fields() {
    let body: SkillInstallBody = serde_json::from_str(
        r#"{"id":"owner/repo/demo","promptForTargets":true,"targetIds":["codex"],"rememberTargetIds":true}"#,
    )
    .expect("body parses");

    assert!(body.prompt_for_targets);
    assert_eq!(
        body.target_ids.as_deref(),
        Some(["codex".to_owned()].as_slice())
    );
    assert!(body.remember_target_ids);
}

#[test]
fn target_preference_body_accepts_target_ids_only() {
    let body: SkillTargetPreferencesBody =
        serde_json::from_str(r#"{"targetIds":["codex","claude-code"]}"#).expect("body parses");

    assert_eq!(body.target_ids, ["codex", "claude-code"]);
}

#[test]
fn manual_distribution_body_defaults_remember_to_false() {
    let body: SkillDistributeBody =
        serde_json::from_str(r#"{"targetIds":[]}"#).expect("body parses");

    assert!(body.target_ids.is_empty());
    assert!(!body.remember_target_ids);
}

#[test]
fn legacy_unconfigured_install_skips_distribution() {
    assert!(!should_distribute_after_install(
        &SkillInstallPreferencesV1::default(),
        &SkillTargetSelectionInput::default(),
    ));
}

#[test]
fn configured_empty_default_still_requests_a_distribution_result() {
    let preferences = SkillInstallPreferencesV1 {
        version: 1,
        configured: true,
        target_ids: Vec::new(),
    };

    assert!(should_distribute_after_install(
        &preferences,
        &SkillTargetSelectionInput::default(),
    ));
}

#[test]
fn explicit_empty_selection_still_requests_a_distribution_result() {
    let input = SkillTargetSelectionInput {
        target_ids: Some(Vec::new()),
        ..Default::default()
    };

    assert!(should_distribute_after_install(
        &SkillInstallPreferencesV1::default(),
        &input,
    ));
}

#[tokio::test]
async fn canonical_reload_precedes_a_failing_remember_write() {
    let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let reload_calls = calls.clone();
    let write_calls = calls.clone();

    let result = reload_before_optional_preference_write(
        move || reload_calls.lock().expect("calls lock").push("reload"),
        true,
        async move {
            write_calls.lock().expect("calls lock").push("remember");
            Err::<(), _>(anyhow::anyhow!("preference write failed"))
        },
    )
    .await;

    assert!(result.is_err());
    assert_eq!(
        calls.lock().expect("calls lock").as_slice(),
        ["reload", "remember"]
    );
}
