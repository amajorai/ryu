//! Mounted Core preference reads against the canonical privacy resolver.
//!
//! The process-isolated worker avoids changing environment variables in the
//! concurrently running Rust test process. These tests expose any difference
//! between Core's effective privacy value and the value Desktop can read.
use super::*;
use axum::{body::Body, http::Request};
use serde_json::{json, Value};
use std::process::Command;
use tower::ServiceExt;

const PRIVACY_ENV_KEYS: [&str; 6] = [
    "RYU_PRODUCT_ANALYTICS_ENABLED",
    "RYU_COMMUNITY_STATS_ENABLED",
    "RYU_PROFILE_ACTIVITY_ENABLED",
    "RYU_CRASH_REPORTS_ENABLED",
    "RYU_DIAGNOSTICS_EXPORT_ENABLED",
    "RYU_SUPPORT_ACCESS_LOCAL_ENABLED",
];

struct Harness {
    directory: tempfile::TempDir,
    preferences_path: std::path::PathBuf,
    state: ServerState,
    router: Router,
}

impl Harness {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let preferences_path = directory.path().join("preferences.db");
        let state = isolated_plugin_hook_test_state(directory.path());
        let router = Router::new()
            .route("/api/preferences/:key", get(get_preference))
            .layer(axum::Extension(
                None::<crate::identity_verify::VerifiedCaller>,
            ))
            .with_state(state.clone());
        Self {
            directory,
            preferences_path,
            state,
            router,
        }
    }

    async fn get(&self, key: &str) -> (StatusCode, Value) {
        let response = self
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/preferences/{key}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }
}

const fn privacy_keys() -> [&'static str; 6] {
    [
        crate::privacy::PRODUCT_ANALYTICS_ENABLED_PREF_KEY,
        crate::privacy::COMMUNITY_STATS_ENABLED_PREF_KEY,
        crate::privacy::PROFILE_ACTIVITY_ENABLED_PREF_KEY,
        crate::privacy::CRASH_REPORTS_ENABLED_PREF_KEY,
        crate::privacy::DIAGNOSTICS_EXPORT_ENABLED_PREF_KEY,
        crate::privacy::SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY,
    ]
}

async fn effective_value(
    key: &str,
    preferences: &crate::server::preferences::PreferencesStore,
) -> bool {
    match key {
        crate::privacy::PRODUCT_ANALYTICS_ENABLED_PREF_KEY => {
            crate::privacy::product_analytics_enabled(preferences).await
        }
        crate::privacy::COMMUNITY_STATS_ENABLED_PREF_KEY => {
            crate::privacy::community_stats_enabled(preferences).await
        }
        crate::privacy::PROFILE_ACTIVITY_ENABLED_PREF_KEY => {
            crate::privacy::profile_activity_enabled(preferences).await
        }
        crate::privacy::CRASH_REPORTS_ENABLED_PREF_KEY => {
            crate::privacy::crash_reports_enabled(preferences).await
        }
        crate::privacy::DIAGNOSTICS_EXPORT_ENABLED_PREF_KEY => {
            crate::privacy::diagnostics_export_enabled(preferences).await
        }
        crate::privacy::SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY => {
            crate::privacy::support_access_local(preferences)
                .await
                .enabled
        }
        _ => unreachable!("only canonical privacy keys are tested"),
    }
}

#[tokio::test]
async fn privacy_get_matches_effective_core_value_without_mutating_unset_preferences() {
    if std::env::var_os("RYU_PRIVACY_GET_WORKER").is_some() {
        run_privacy_get_worker().await;
        return;
    }

    let scratch = tempfile::tempdir().unwrap();
    let executable = std::env::current_exe().unwrap();
    let mut failures = Vec::new();
    for scenario in ["environment", "defaults"] {
        let data_dir = scratch.path().join(scenario);
        std::fs::create_dir_all(&data_dir).unwrap();
        let mut command = Command::new(&executable);
        command
            .arg("privacy_preferences_runtime_test::privacy_get_matches_effective_core_value_without_mutating_unset_preferences")
            .arg("--nocapture")
            .env("RYU_PRIVACY_GET_WORKER", scenario)
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", &data_dir)
            .env_remove("RYU_MASTER_KEY");
        for key in PRIVACY_ENV_KEYS {
            command.env_remove(key);
        }
        if scenario == "environment" {
            command
                .env("RYU_PRODUCT_ANALYTICS_ENABLED", "false")
                .env("RYU_COMMUNITY_STATS_ENABLED", "false")
                .env("RYU_PROFILE_ACTIVITY_ENABLED", "false")
                .env("RYU_CRASH_REPORTS_ENABLED", "false")
                .env("RYU_DIAGNOSTICS_EXPORT_ENABLED", "true")
                .env("RYU_SUPPORT_ACCESS_LOCAL_ENABLED", "true");
        }
        let output = command.output().unwrap();
        if !output.status.success() {
            failures.push(format!(
                "{scenario} scenario exited {:?}:\n{}\n{}",
                output.status.code(),
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

async fn run_privacy_get_worker() {
    let scenario = std::env::var("RYU_PRIVACY_GET_WORKER").unwrap();
    let harness = Harness::new();
    assert!(harness.directory.path().exists());

    let mut mismatches = Vec::new();
    for key in privacy_keys() {
        assert_eq!(harness.state.preferences.get(key).await.unwrap(), None);
        let effective = effective_value(key, &harness.state.preferences).await;
        let expected = match scenario.as_str() {
            "environment" => {
                key == crate::privacy::DIAGNOSTICS_EXPORT_ENABLED_PREF_KEY
                    || key == crate::privacy::SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY
            }
            "defaults" => {
                key != crate::privacy::DIAGNOSTICS_EXPORT_ENABLED_PREF_KEY
                    && key != crate::privacy::SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY
            }
            _ => unreachable!("parent only starts known scenarios"),
        };
        assert_eq!(effective, expected, "privacy resolver for {key}");
        let (status, body) = harness.get(key).await;
        if status != StatusCode::OK || body["value"] != json!(effective.to_string()) {
            mismatches.push(format!(
                "scenario={scenario} key={key}: status={status}, effective={effective}, returned={}",
                body["value"]
            ));
        }
        assert_eq!(harness.state.preferences.get(key).await.unwrap(), None);
    }

    let (status, optional) = harness.get("ordinary-optional-preference").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        optional,
        json!({"key":"ordinary-optional-preference","value":null})
    );

    if scenario == "environment" {
        let stored_values = [
            (crate::privacy::PRODUCT_ANALYTICS_ENABLED_PREF_KEY, "true"),
            (crate::privacy::COMMUNITY_STATS_ENABLED_PREF_KEY, "true"),
            (crate::privacy::PROFILE_ACTIVITY_ENABLED_PREF_KEY, "true"),
            (crate::privacy::CRASH_REPORTS_ENABLED_PREF_KEY, "true"),
            (crate::privacy::DIAGNOSTICS_EXPORT_ENABLED_PREF_KEY, "false"),
            (
                crate::privacy::SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY,
                "false",
            ),
        ];
        for (key, value) in stored_values {
            harness.state.preferences.set(key, value).await.unwrap();
            assert_eq!(
                effective_value(key, &harness.state.preferences).await,
                value == "true",
                "stored value takes precedence over the environment for {key}"
            );
            let (status, body) = harness.get(key).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(body, json!({"key":key,"value":value}));
            assert_eq!(
                harness.state.preferences.get(key).await.unwrap().as_deref(),
                Some(value)
            );
        }

        let tolerant_values = [
            (
                crate::privacy::PRODUCT_ANALYTICS_ENABLED_PREF_KEY,
                " YES ",
                true,
            ),
            (
                crate::privacy::COMMUNITY_STATS_ENABLED_PREF_KEY,
                "off",
                false,
            ),
            (
                crate::privacy::PROFILE_ACTIVITY_ENABLED_PREF_KEY,
                "garbage",
                true,
            ),
            (
                crate::privacy::CRASH_REPORTS_ENABLED_PREF_KEY,
                "invalid",
                true,
            ),
            (
                crate::privacy::DIAGNOSTICS_EXPORT_ENABLED_PREF_KEY,
                "",
                false,
            ),
            (
                crate::privacy::SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY,
                "no",
                false,
            ),
        ];
        for (key, value, expected) in tolerant_values {
            harness.state.preferences.set(key, value).await.unwrap();
            assert_eq!(
                effective_value(key, &harness.state.preferences).await,
                expected,
                "privacy resolver parsing for {key}"
            );
            let (status, body) = harness.get(key).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(body, json!({"key":key,"value":expected.to_string()}));
            assert_eq!(
                harness.state.preferences.get(key).await.unwrap().as_deref(),
                Some(value),
                "GET must not normalize or rewrite the persisted value for {key}"
            );
        }
    }

    let connection = rusqlite::Connection::open(&harness.preferences_path).unwrap();
    connection.execute_batch("DROP TABLE preferences;").unwrap();
    let (status, body) = harness.get("ordinary-optional-preference").await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert!(body["error"].as_str().is_some());
    let (status, body) = harness
        .get(crate::privacy::SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY)
        .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert!(body["error"].as_str().is_some());

    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}
