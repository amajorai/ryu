use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Response,
    Extension, Json,
};
use serde_json::{json, Value};

use super::{automatic, candidates, prompt, routes, sources, wire};
use crate::server::conversations::Tenancy;
use crate::server::ServerState;

fn state(directory: &std::path::Path) -> ServerState {
    crate::server::isolated_plugin_hook_test_state(directory)
}

async fn body_json(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn patch_settings(state: &ServerState, patch: Value) -> (StatusCode, Value) {
    let patch: routes::DreamSettingsPatch = serde_json::from_value(patch).unwrap();
    body_json(
        routes::update_dream_settings(State(state.clone()), Extension(None), Json(patch)).await,
    )
    .await
}

#[test]
fn parses_json_after_model_prose() {
    let output = prompt::parse_model_output(
        "Here is the result: {\"summary\":\"one fact\",\"memories\":[{\"content\":\"Likes concise answers\",\"source_message_ids\":[\"m1\"]}]}",
    )
    .unwrap();
    assert_eq!(output.memories.len(), 1);
    assert_eq!(output.memories[0].source_message_ids, ["m1"]);
}

#[test]
fn ignores_unknown_mode() {
    assert_eq!(wire::requested_mode(Some("future")), "manual");
    assert_eq!(wire::requested_mode(Some("automatic")), "automatic");
}

#[test]
fn quiet_hours_support_ranges_that_cross_midnight() {
    assert!(automatic::is_quiet_hour(23, 22, 8));
    assert!(automatic::is_quiet_hour(3, 22, 8));
    assert!(!automatic::is_quiet_hour(12, 22, 8));
    assert!(!automatic::is_quiet_hour(8, 8, 8));
    assert!(automatic::is_quiet_hour(9, 9, 17));
    assert!(!automatic::is_quiet_hour(17, 9, 17));
}

#[test]
fn stored_automatic_flag_accepts_common_truthy_spellings() {
    for value in ["true", " TRUE ", "1", "on", "yes"] {
        assert!(automatic::parse_bool(value), "{value}");
    }
    for value in ["false", "0", "off", "", "maybe"] {
        assert!(!automatic::parse_bool(value), "{value}");
    }
}

#[test]
fn candidate_text_is_trimmed_bounded_and_keyed_case_insensitively() {
    assert_eq!(candidates::bounded_text("   ", 10), None);
    assert_eq!(
        candidates::bounded_text("  héllo world  ", 5).as_deref(),
        Some("héllo")
    );
    assert_eq!(
        candidates::normalize_key("  Likes\tConcise\n answers "),
        "likes concise answers"
    );
}

#[test]
fn prompt_lists_each_source_with_its_citable_message_id() {
    let source = sources::DreamSource {
        conversation_id: Some("c1".to_owned()),
        conversation_title: "Trip planning".to_owned(),
        message_id: "m-42".to_owned(),
        role: "user".to_owned(),
        content: "I prefer window seats.".to_owned(),
        created_at: 1,
    };
    let (system, user) = prompt::dream_prompt(&[source], &[]);
    assert!(system.starts_with("You are Dream, Ryu's private chat-to-memory decomposer."));
    assert!(system.contains("source_message_ids"));
    assert!(user.ends_with(
        r#"[{"message_id":"m-42","conversation":"Trip planning","role":"user","content":"I prefer window seats."}]"#
    ));
}

#[test]
fn review_body_reports_mode_summary_proposals_and_last_run() {
    let body = wire::review_body("automatic", &[], Some("nothing new"), Some(1_700));
    assert_eq!(body["review"]["mode"], "automatic");
    assert_eq!(body["review"]["summary"], "nothing new");
    assert_eq!(body["review"]["proposals"], json!([]));
    assert_eq!(body["review"]["generated_at"], 1_700);
    // Never run: no timestamp, so clients show "not run yet" instead of now.
    let never = wire::review_body("manual", &[], None, None);
    assert!(never["review"].get("generated_at").is_none());
}

#[test]
fn review_request_mode_is_optional() {
    let body: routes::DreamReviewBody = serde_json::from_value(json!({})).unwrap();
    assert_eq!(wire::requested_mode(body.mode.as_deref()), "manual");
}

#[tokio::test]
async fn settings_patch_validates_hours_and_round_trips() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());

    let (status, body) = patch_settings(&state, json!({ "quiet_hours_start": 24 })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    let (status, body) =
        patch_settings(&state, json!({ "automatic": true, "quiet_hours_end": 6 })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let expected = json!({ "automatic": true, "quiet_hours_start": 22, "quiet_hours_end": 6 });
    assert_eq!(body["settings"], expected);

    let (status, body) =
        body_json(routes::get_dream_settings(State(state.clone()), Extension(None)).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["settings"], expected);
    assert_eq!(automatic::read_settings(&state).await.unwrap(), expected);
}

#[tokio::test]
async fn reviewing_an_unknown_proposal_is_not_found() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    let (status, _) = body_json(
        routes::accept_dream_proposal(
            State(state.clone()),
            Extension(None),
            Path("missing".to_owned()),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = body_json(
        routes::reject_dream_proposal(State(state), Extension(None), Path("missing".to_owned()))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn review_requires_chat_memory_and_needs_sources_before_calling_a_model() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());

    state
        .conversations
        .set_chat_memory_enabled(false)
        .await
        .unwrap();
    let (status, message) = candidates::run_dream_review_inner(&state, &None, "manual")
        .await
        .unwrap_err();
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(message.contains("Remember chats"), "{message}");

    state
        .conversations
        .set_chat_memory_enabled(true)
        .await
        .unwrap();
    let body = candidates::run_dream_review_inner(&state, &None, "manual")
        .await
        .unwrap();
    assert_eq!(body["review"]["proposals"], json!([]));
    assert_eq!(
        body["review"]["summary"],
        "No recent chat sources are available to decompose."
    );
}

#[tokio::test]
async fn sources_keep_only_non_empty_user_and_assistant_messages() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    for (role, content) in [
        ("user", "I prefer window seats."),
        ("assistant", "Noted: window seats."),
        ("system", "internal setup"),
        ("user", "   "),
    ] {
        state
            .conversations
            .append_message_as("c1", role, content, None, None, None, Tenancy::Unattributed)
            .await
            .unwrap();
    }

    let loaded = sources::load_sources(&state, &None, false).await.unwrap();
    let mut seen: Vec<(String, String)> = loaded
        .iter()
        .map(|source| (source.role.clone(), source.content.clone()))
        .collect();
    seen.sort();
    assert_eq!(
        seen,
        [
            ("assistant".to_owned(), "Noted: window seats.".to_owned()),
            ("user".to_owned(), "I prefer window seats.".to_owned()),
        ]
    );
    assert!(loaded
        .iter()
        .all(|source| source.conversation_id.as_deref() == Some("c1")));
    assert!(loaded.iter().all(|source| !source.message_id.is_empty()));
}
