use axum::{extract::State, routing::post, Json, Router};
use tokio::net::TcpListener;

use super::*;
use crate::approvals::Notice;
use crate::CommonChannelConfig;

const TOKEN: &str = "0123456789abcdef0123456789abcdef";
const PROMPT_TEXT: &str = "The agent Scout wants to run gmail.send_email.\nSend an email";

type Seen = Arc<Mutex<Vec<Value>>>;

async fn record(
    State((seen, answer)): State<(Seen, Value)>,
    Json(body): Json<Value>,
) -> Json<Value> {
    seen.lock().unwrap().push(body);
    Json(answer)
}

/// A Core stand-in that records every decide call and answers `answer`.
async fn mock_core(answer: Value) -> (String, Seen, tokio::task::JoinHandle<()>) {
    let seen = Seen::default();
    let app = Router::new()
        .route("/api/channels/approvals/decide", post(record))
        .with_state((Arc::clone(&seen), answer));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (url, seen, server)
}

/// A store-backed Slack bot (`chan_1`) with DM pairing, talking to `core_url`.
fn channel(core_url: &str) -> SlackChannel {
    SlackChannel::new(
        SlackChannelConfig {
            app_token: "xapp-test".to_owned(),
            bot_token: "xoxb-test".to_owned(),
            common: CommonChannelConfig {
                model: "gpt-4o".to_owned(),
                core_url: core_url.to_owned(),
                channel_id: Some("chan_1".to_owned()),
                ..Default::default()
            },
            options: SlackChannelOptions::default(),
        },
        reqwest::Client::new(),
        PairingStore::ephemeral(),
    )
    .unwrap()
}

fn prompt() -> ApprovalPrompt {
    ApprovalPrompt {
        token: TOKEN.to_owned(),
        agent_name: Some("<!channel> Scout".to_owned()),
        tool_name: "gmail.send_email".to_owned(),
        summary: "Send <https://evil.example|mail> & *more*".to_owned(),
    }
}

/// A Socket Mode frame for one button press on the prompt message.
fn frame(user: &str, action_id: &str, value: &str, thread_ts: Option<&str>) -> String {
    json!({
        "envelope_id": "env-1",
        "type": "interactive",
        "payload": {
            "type": "block_actions",
            "user": { "id": user },
            "container": {
                "type": "message",
                "channel_id": "C1",
                "message_ts": "1700000002.000200",
                "thread_ts": thread_ts,
            },
            "channel": { "id": "C1" },
            "message": { "ts": "1700000002.000200", "text": PROMPT_TEXT },
            "actions": [{ "type": "button", "action_id": action_id, "value": value }],
        },
    })
    .to_string()
}

fn approve_frame(user: &str, thread_ts: Option<&str>) -> String {
    frame(
        user,
        APPROVE_ACTION_ID,
        &format!("ryuapr:a:{TOKEN}"),
        thread_ts,
    )
}

#[test]
fn the_prompt_is_escaped_plain_text_with_two_opaque_buttons() {
    let payload = prompt_payload("C1:1700000001.000100", true, &prompt(), "en").unwrap();
    assert_eq!(payload["channel"], "C1");
    assert_eq!(payload["thread_ts"], "1700000001.000100");
    assert_eq!(payload["mrkdwn"], false);
    assert_eq!(payload["unfurl_links"], false);

    let section = &payload["blocks"][0];
    assert_eq!(section["type"], "section");
    assert_eq!(section["text"]["type"], "plain_text");
    let text = section["text"]["text"].as_str().unwrap();
    assert!(!text.contains('<') && !text.contains('>'), "{text}");
    assert!(text.contains("&lt;!channel&gt; Scout wants to run gmail.send_email."));
    assert!(text.contains("Send &lt;https://evil.example|mail&gt; &amp; *more*"));
    assert_eq!(payload["text"], section["text"]["text"]);

    let buttons = payload["blocks"][1]["elements"].as_array().unwrap();
    assert_eq!(payload["blocks"][1]["type"], "actions");
    assert_eq!(buttons.len(), 2);
    assert_eq!(buttons[0]["action_id"], APPROVE_ACTION_ID);
    assert_eq!(buttons[0]["text"]["text"], "Approve request");
    assert_eq!(buttons[0]["value"], format!("ryuapr:a:{TOKEN}"));
    assert_eq!(buttons[1]["action_id"], DENY_ACTION_ID);
    assert_eq!(buttons[1]["text"]["text"], "Deny request");
    assert_eq!(buttons[1]["value"], format!("ryuapr:d:{TOKEN}"));
    for button in buttons {
        let value = button["value"].as_str().unwrap();
        assert!(!value.contains("gmail") && !value.contains("Scout"));
    }

    // Not threaded: the prompt goes to the channel itself.
    let top_level = prompt_payload("C1:1700000001.000100", false, &prompt(), "en").unwrap();
    assert!(top_level.get("thread_ts").is_none());
    let mut unusable = prompt();
    unusable.token = "not a token".to_owned();
    assert!(prompt_payload("C1", true, &unusable, "en").is_none());
}

#[test]
fn a_press_is_read_from_the_payload_slack_delivered() {
    let press = parse_press(&approve_frame("U111", Some("1700000001.000100"))).unwrap();
    assert_eq!(
        press,
        SlackPress {
            token: TOKEN.to_owned(),
            approve: true,
            user: "U111".to_owned(),
            channel: "C1".to_owned(),
            message_ts: "1700000002.000200".to_owned(),
            thread_ts: Some("1700000001.000100".to_owned()),
            shown: PROMPT_TEXT.to_owned(),
        }
    );
    assert_eq!(press_chat_id(&press, true), "C1:1700000001.000100");
    assert_eq!(press_chat_id(&press, false), "C1");

    let deny = parse_press(&frame(
        "U111",
        DENY_ACTION_ID,
        &format!("ryuapr:d:{TOKEN}"),
        None,
    ))
    .unwrap();
    assert!(!deny.approve);
    assert_eq!(deny.thread_ts, None);
    assert_eq!(press_chat_id(&deny, true), "C1");
}

#[test]
fn anything_else_is_not_an_approval_press() {
    let good = format!("ryuapr:a:{TOKEN}");
    let not_a_press = [
        // The feedback buttons and other apps' buttons.
        frame("U111", "ryu_feedback_helpful", "helpful", None),
        frame("U111", APPROVE_ACTION_ID, "helpful", None),
        frame("U111", "ryu_feedback_helpful", &good, None),
        // The button and its value disagree.
        frame("U111", DENY_ACTION_ID, &good, None),
        // Nobody to attribute the press to.
        frame("", APPROVE_ACTION_ID, &good, None),
        frame("  ", APPROVE_ACTION_ID, &good, None),
        // Other frame kinds.
        json!({ "type": "events_api", "payload": { "type": "block_actions" } }).to_string(),
        json!({ "type": "interactive", "payload": { "type": "view_submission" } }).to_string(),
        "not json".to_owned(),
    ];
    for raw in not_a_press {
        assert_eq!(parse_press(&raw), None, "{raw}");
    }
}

#[test]
fn the_final_state_has_no_buttons_and_escapes_the_prompt_once() {
    let mut press = parse_press(&approve_frame("U111", None)).unwrap();
    // Slack hands the text back with its control characters still escaped.
    press.shown = "Run &lt;tool&gt; &amp; go <!here>".to_owned();
    let payload = final_payload(&press, "en", FinalState::Denied);
    assert_eq!(payload["channel"], "C1");
    assert_eq!(payload["ts"], "1700000002.000200");
    let blocks = payload["blocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 2);
    assert!(blocks.iter().all(|block| block["type"] == "section"));
    assert_eq!(
        blocks[0]["text"]["text"],
        "Run &lt;tool&gt; &amp; go &lt;!here&gt;"
    );
    assert_eq!(blocks[1]["text"]["text"], "Denied. The action was not run.");
    assert!(blocks
        .iter()
        .all(|block| block["text"]["type"] == "plain_text"));

    press.shown = "  ".to_owned();
    let bare = final_payload(&press, "en", FinalState::Approved);
    assert_eq!(bare["blocks"].as_array().unwrap().len(), 1);
    assert_eq!(bare["text"], "Approved. The action is running.");
}

#[test]
fn a_settled_press_updates_the_message_and_a_refusal_tells_only_the_presser() {
    let press = parse_press(&approve_frame("U999", Some("1700000001.000100"))).unwrap();
    let (method, payload) = outcome_call(&press, "en", PressOutcome::Final(FinalState::Approved));
    assert_eq!(method, "chat.update");
    assert_eq!(payload["ts"], "1700000002.000200");

    let (method, payload) = outcome_call(&press, "en", PressOutcome::Notice(Notice::NotAllowed));
    assert_eq!(method, "chat.postEphemeral");
    assert_eq!(payload["channel"], "C1");
    assert_eq!(payload["user"], "U999");
    assert_eq!(payload["thread_ts"], "1700000001.000100");
    assert_eq!(payload["text"], "You cannot decide this request here.");
    assert!(payload.get("blocks").is_none() && payload.get("ts").is_none());
}

#[tokio::test]
async fn a_press_by_a_paired_member_is_decided_for_the_thread_it_was_posted_in() {
    let (url, seen, server) =
        mock_core(json!({ "outcome": "decided", "status": "approved" })).await;
    let channel = channel(&url);
    channel.runtime.pairing.approve("slack", "U111").await;
    let press = parse_press(&approve_frame("U111", Some("1700000001.000100"))).unwrap();

    assert_eq!(
        channel.decide_approval_press(&press).await,
        PressOutcome::Final(FinalState::Approved)
    );
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        seen[0],
        json!({
            "token": TOKEN,
            "approve": true,
            "connection": "chan_1",
            "conversationId": "channel__chan_5F1__C1_3A1700000001.000100",
            "platform": "slack",
            "senderId": "U111",
        })
    );
    server.abort();
}

#[tokio::test]
async fn a_press_by_someone_else_in_the_channel_changes_nothing() {
    let (url, seen, server) =
        mock_core(json!({ "outcome": "decided", "status": "approved" })).await;
    let channel = channel(&url);
    channel.runtime.pairing.approve("slack", "U111").await;
    channel.runtime.pairing.block("slack", "U666").await;

    for user in ["U999", "U666"] {
        let press = parse_press(&approve_frame(user, None)).unwrap();
        let outcome = channel.decide_approval_press(&press).await;
        assert_eq!(outcome, PressOutcome::Notice(Notice::NotAllowed), "{user}");
        let (method, _) = outcome_call(&press, "en", outcome);
        assert_eq!(method, "chat.postEphemeral", "the prompt is left as it is");
    }
    assert!(seen.lock().unwrap().is_empty(), "Core is not asked");
    server.abort();
}

#[tokio::test]
async fn what_core_reports_is_what_is_shown() {
    let cases = [
        (
            json!({ "outcome": "refused", "reason": "not_linked" }),
            PressOutcome::Notice(Notice::NotAllowed),
        ),
        (
            json!({ "outcome": "refused", "reason": "setting_off", "status": "approved" }),
            PressOutcome::Notice(Notice::NotAllowed),
        ),
        (
            json!({ "outcome": "already_decided", "status": "rejected" }),
            PressOutcome::Final(FinalState::Denied),
        ),
        (
            json!({ "outcome": "already_decided", "status": "expired" }),
            PressOutcome::Final(FinalState::Expired),
        ),
        (
            json!({ "outcome": "expired" }),
            PressOutcome::Final(FinalState::Gone),
        ),
    ];
    for (answer, expected) in cases {
        let (url, _seen, server) = mock_core(answer).await;
        let channel = channel(&url);
        channel.runtime.pairing.approve("slack", "U111").await;
        // The press says Approve; what is shown is what Core holds.
        let press = parse_press(&approve_frame("U111", None)).unwrap();
        assert_eq!(channel.decide_approval_press(&press).await, expected);
        server.abort();
    }
}
