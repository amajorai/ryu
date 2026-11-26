//! Regression: `POST /api/channels/run` takes a conversation id only inside
//! `is_safe_host_conversation_id` (1 to 128 ASCII letters, digits, `.`, `_`,
//! `-`). After that check landed (2891e68436) the channel senders kept sending
//! ids with colons, so every message to a store-backed bot was answered 400.
//!
//! The senders now map their keys into that grammar. These tests hold the two
//! sides together through the cases the senders' own tests read
//! (`crates/gateway/contracts/fixtures/channel-conversation-id-cases-v1.json`).
//! Core still refuses the old shapes, and it answers a turn under every id the
//! Gateway and the cloud-bot build.

use crate::server::*;
use crate::sidecar::adapters::acp::is_safe_host_conversation_id;
use crate::sidecar::control_plane::with_test_node_binding;
use crate::sidecar::node_binding::with_test_enrollment;

const CASES: &str = include_str!(
    "../../../../../crates/gateway/contracts/fixtures/channel-conversation-id-cases-v1.json"
);

/// How the refusal for an id outside the rule starts.
const ID_RULE_REFUSAL: &str = "conversation_id must be 1-128 ASCII letters";

fn cases() -> serde_json::Value {
    serde_json::from_str(CASES).expect("the shared cases parse")
}

/// Run `fut` as a personal node: not managed, no organization, not enrolled.
async fn personal_node<F: std::future::Future>(fut: F) -> F::Output {
    with_test_node_binding(false, None, with_test_enrollment(false, fut)).await
}

/// Post one turn to the handler and return its status and JSON body.
async fn post_turn(
    state: &ServerState,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let request: ChannelRunRequest = serde_json::from_value(body).expect("a channel run request");
    let response = personal_node(channel_run(
        State(state.clone()),
        axum::Extension(None),
        Json(request),
    ))
    .await;
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read the response body");
    let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, body)
}

#[tokio::test]
async fn channel_run_refuses_the_colon_ids_the_senders_used_to_build() {
    crate::crypto_host::install();
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());

    for (legacy, channel_id) in [
        // The Gateway, for every message to a store-backed bot.
        ("channel:bot-a:123456789", Some("bot-a")),
        // The Gateway, for a forum topic on a bot without a store id.
        ("-1001234567890:42", None),
        // The cloud-bot, for every message it routes to a node.
        ("telegram:123456789", None),
    ] {
        let (status, body) = post_turn(
            &state,
            json!({ "conversation_id": legacy, "channel_id": channel_id, "text": "ping" }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{legacy}: {body}");
        assert!(
            body["error"]
                .as_str()
                .is_some_and(|error| error.starts_with(ID_RULE_REFUSAL)),
            "{legacy}: {body}"
        );
        // Refused at the door: nothing was stored under the id.
        assert!(
            state
                .conversations
                .get_access_meta(legacy)
                .await
                .unwrap()
                .is_none(),
            "{legacy}"
        );
    }
}

#[test]
fn cores_rule_is_the_one_the_senders_mirror() {
    let cases = cases();
    let rule = cases["rule"].as_array().unwrap();
    assert!(rule.len() >= 10, "the shared cases went missing");
    for case in rule {
        let id = case["id"].as_str().unwrap();
        assert_eq!(
            is_safe_host_conversation_id(id),
            case["valid"].as_bool().unwrap(),
            "{id:?}"
        );
    }
}

#[tokio::test]
async fn channel_run_answers_a_turn_under_every_id_the_senders_build() {
    crate::crypto_host::install();
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let cases = cases();
    let ids = cases["ids"].as_array().unwrap();
    assert!(ids.len() > 20, "the shared cases went missing");

    for (index, case) in ids.iter().enumerate() {
        let name = case["name"].as_str().unwrap();
        let id = case["expected"].as_str().unwrap();
        let channel_id = case["channel_id"].as_str();
        // The same predicate guards the Pi route, tool access and the tool
        // broker, so an id it accepts keeps those for the bot's turn too.
        assert!(
            is_safe_host_conversation_id(id),
            "{name}: Core's rule refuses {id:?}"
        );

        // A delivery Core already completed under this id. The handler replays
        // it, so the whole route answers without a model.
        let key = format!("delivery-{index}");
        let reply = format!("pong {index}");
        let request_hash = ryu_tracing::hash_args(&json!({
            "conversation_id": id,
            "channel_id": channel_id,
            "agent_id": null,
            "team_id": null,
            "text": "ping",
            "author_name": null,
            "channel_action": null,
        }));
        let claim = state
            .conversations
            .claim_channel_turn(&key, id, &request_hash)
            .await
            .unwrap();
        assert_eq!(claim, ChannelTurnClaim::Claimed, "{name}");
        state
            .conversations
            .complete_channel_turn(
                &key,
                &ChannelTurnReplay {
                    reply: reply.clone(),
                    assistant_message_id: Some("assistant-1".to_owned()),
                    assistant_message_ids: vec!["assistant-1".to_owned()],
                    agent_id: None,
                    fallback_warning: None,
                    interactive_markup: None,
                },
            )
            .await
            .unwrap();

        let (status, body) = post_turn(
            &state,
            json!({
                "conversation_id": id,
                "channel_id": channel_id,
                "text": "ping",
                "idempotencyKey": key,
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{name}: {body}");
        assert_eq!(body["reply"], reply, "{name}");
        assert_eq!(body["assistantMessageId"], "assistant-1", "{name}");
    }
}
