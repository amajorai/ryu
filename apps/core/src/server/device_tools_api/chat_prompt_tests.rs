//! Device prompts on `POST /api/chat/permission`: only the options Core offered,
//! only for their owner, and on-device prompts can only be declined here.

use super::chat::resolve_device_prompt;
use super::tests::{lane_state, owner_auth, status_and_json};
use crate::device_tools::prompts::{self, PromptAnswer};
use crate::server::*;

const OWNER: &str = "owner:local";

fn owner() -> ResolvedAuthorization {
    owner_auth().expect("owner auth").0
}

#[tokio::test]
async fn device_prompts_resolve_only_offered_options_for_their_owner() {
    let (_directory, state) = lane_state(true).await;
    let conversation_id = uuid::Uuid::new_v4().to_string();
    state
        .conversations
        .ensure_conversation(
            &conversation_id,
            None,
            None,
            crate::server::conversations::Tenancy::Unattributed,
        )
        .await
        .unwrap();
    let resolve = |request_id: String, option: Option<&'static str>| {
        let state = state.clone();
        let auth = owner();
        async move {
            status_and_json(
                resolve_device_prompt(&state, Some(&auth), None, &request_id, option).await,
            )
            .await
        }
    };

    let (status, body) = resolve("perm-dev-unknown".into(), Some("allow_once")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "resolved": false }));

    let (id, mut answer) = prompts::register(&conversation_id, OWNER, false, false);
    let (status, body) = resolve(id.clone(), Some("allow_once")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({ "resolved": true, "decision": "allow_once" }));
    assert_eq!(answer.try_recv().ok(), Some(PromptAnswer::AllowOnce));

    let (id, mut answer) = prompts::register(&conversation_id, OWNER, false, false);
    let (_, body) = resolve(id, Some("allow_always")).await;
    assert_eq!(
        body["decision"], "deny",
        "an option Core did not offer is a deny"
    );
    assert_eq!(answer.try_recv().ok(), Some(PromptAnswer::Deny));

    let (id, _answer) = prompts::register(&conversation_id, "user:someone-else", true, false);
    let (status, _) = resolve(id.clone(), Some("allow_once")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        prompts::peek_conversation(&id).as_deref(),
        Some(conversation_id.as_str()),
        "another principal cannot consume the prompt"
    );

    let (id, mut answer) = prompts::register(&conversation_id, OWNER, false, true);
    let (status, body) = resolve(id.clone(), Some("allow_once")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "approval_required");
    let (_, body) = resolve(id, None).await;
    assert_eq!(
        body["decision"], "deny",
        "an on-device prompt can still be declined"
    );
    assert_eq!(answer.try_recv().ok(), Some(PromptAnswer::Deny));

    let missing = uuid::Uuid::new_v4().to_string();
    let (id, _answer) = prompts::register(&missing, OWNER, false, false);
    let (status, _) = resolve(id, Some("allow_once")).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "the conversation must exist");
}
