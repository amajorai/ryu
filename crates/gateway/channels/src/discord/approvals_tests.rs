use std::sync::Mutex;

use axum::{extract::State, routing::post, Json, Router};
use tokio::net::TcpListener;

use super::*;
use crate::approvals::Notice;
use crate::CommonChannelConfig;

const TOKEN: &str = "0123456789abcdef0123456789abcdef";
const SHOWN: &str = "The agent Scout wants to run gmail.send\\_email.\nSend an email";

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

/// A store-backed Discord bot (`chan_1`) with DM pairing, talking to `core_url`.
fn channel(core_url: &str) -> DiscordChannel {
    DiscordChannel::new(
        DiscordChannelConfig {
            token: "test-token".to_owned(),
            channel_ids: Vec::new(),
            thread_replies: false,
            common: CommonChannelConfig {
                model: "gpt-4o".to_owned(),
                core_url: core_url.to_owned(),
                channel_id: Some("chan_1".to_owned()),
                ..Default::default()
            },
            options: DiscordChannelOptions::default(),
        },
        reqwest::Client::new(),
        PairingStore::ephemeral(),
    )
    .unwrap()
}

fn prompt() -> ApprovalPrompt {
    ApprovalPrompt {
        token: TOKEN.to_owned(),
        agent_name: Some("@everyone Scout".to_owned()),
        tool_name: "gmail.send_email".to_owned(),
        summary: "Send [mail](https://evil.example) to <@123> **now**".to_owned(),
    }
}

/// A component interaction for one button press in a guild channel.
fn interaction(user: &str, custom_id: &str) -> Value {
    json!({
        "id": "9001",
        "application_id": "7001",
        "type": 3,
        "token": "interaction-token",
        "guild_id": "5001",
        "channel_id": "3001",
        "locale": "en-US",
        "member": { "user": { "id": user, "username": "Ada" }, "roles": [] },
        "message": { "id": "4001", "content": SHOWN },
        "data": { "component_type": 2, "custom_id": custom_id },
    })
}

fn approve(user: &str) -> Value {
    interaction(user, &format!("ryuapr:a:{TOKEN}"))
}

#[test]
fn the_prompt_is_escaped_with_no_mention_allowed_and_two_opaque_buttons() {
    let payload = prompt_payload(&prompt(), "en").unwrap();
    let content = payload["content"].as_str().unwrap();
    assert!(!content.contains("@everyone"), "{content}");
    assert!(content.contains("gmail.send\\_email"), "{content}");
    assert!(
        content.contains("\\[mail\\]\\(https://evil.example\\)"),
        "{content}"
    );
    assert!(content.contains("\\<@\u{200b}123\\>"), "{content}");
    assert!(content.contains("\\*\\*now\\*\\*"), "{content}");
    assert!(content.chars().count() <= 2000);
    assert_eq!(payload["allowed_mentions"], json!({ "parse": [] }));

    let rows = payload["components"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["type"], 1);
    let buttons = rows[0]["components"].as_array().unwrap();
    assert_eq!(buttons.len(), 2);
    assert_eq!(buttons[0]["type"], 2);
    assert_eq!(buttons[0]["label"], "Approve request");
    assert_eq!(buttons[0]["custom_id"], format!("ryuapr:a:{TOKEN}"));
    assert_eq!(buttons[1]["label"], "Deny request");
    assert_eq!(buttons[1]["custom_id"], format!("ryuapr:d:{TOKEN}"));
    for button in buttons {
        let custom_id = button["custom_id"].as_str().unwrap();
        assert!(custom_id.len() <= 100, "Discord allows 100 characters");
        assert!(!custom_id.contains("gmail") && !custom_id.contains("Scout"));
    }

    let mut unusable = prompt();
    unusable.token = "not a token".to_owned();
    assert!(prompt_payload(&unusable, "en").is_none());
}

#[test]
fn a_press_is_read_from_the_interaction_discord_delivered() {
    let press = parse_press(&approve("111")).unwrap();
    assert_eq!(
        press,
        DiscordPress {
            token: TOKEN.to_owned(),
            approve: true,
            interaction_id: "9001".to_owned(),
            interaction_token: "interaction-token".to_owned(),
            application_id: "7001".to_owned(),
            user: "111".to_owned(),
            channel_id: "3001".to_owned(),
            is_group: true,
            shown: SHOWN.to_owned(),
            locale: Some("en-US".to_owned()),
        }
    );

    // A direct message names the presser in `user`, not `member`.
    let mut direct = interaction("111", &format!("ryuapr:d:{TOKEN}"));
    let object = direct.as_object_mut().unwrap();
    object.remove("guild_id");
    object.remove("member");
    object.insert("user".to_owned(), json!({ "id": "222" }));
    let press = parse_press(&direct).unwrap();
    assert!(!press.approve && !press.is_group);
    assert_eq!(press.user, "222");
}

#[test]
fn anything_else_is_not_an_approval_press() {
    let good = format!("ryuapr:a:{TOKEN}");
    let mut slash_command = approve("111");
    slash_command["type"] = json!(2);
    let mut select_menu = approve("111");
    select_menu["data"]["component_type"] = json!(3);
    let mut nobody = approve("111");
    nobody["member"]["user"]["id"] = json!("  ");
    let mut no_token = approve("111");
    no_token.as_object_mut().unwrap().remove("token");
    let not_a_press = [
        interaction("111", "some_other_button"),
        interaction("111", &format!("{good}:extra")),
        interaction("111", r#"{"a":"workflow.continue"}"#),
        slash_command,
        select_menu,
        nobody,
        no_token,
        json!({ "type": 3 }),
    ];
    for value in not_a_press {
        assert_eq!(parse_press(&value), None, "{value}");
    }
    // A component press never falls through to the slash command path.
    assert!(is_component(&interaction("111", "some_other_button")));
    assert!(!is_component(&json!({ "type": 2 })));
}

#[test]
fn the_conversation_comes_from_the_channel_the_prompt_is_in() {
    let press = parse_press(&approve("111")).unwrap();
    // An ordinary channel, a thread under channel 2001, and a failed lookup.
    assert_eq!(press_chat_id(&press, Some(None)), Some("3001".to_owned()));
    assert_eq!(
        press_chat_id(&press, Some(Some("2001".to_owned()))),
        Some("2001:3001".to_owned())
    );
    assert_eq!(press_chat_id(&press, None), None);

    let mut direct = press.clone();
    direct.is_group = false;
    assert_eq!(press_chat_id(&direct, None), Some("3001".to_owned()));
}

#[test]
fn the_final_state_removes_the_buttons_and_a_refusal_is_ephemeral() {
    let press = parse_press(&approve("999")).unwrap();
    let (method, path, body) = outcome_call(&press, "en", PressOutcome::Final(FinalState::Denied));
    assert_eq!(method, reqwest::Method::PATCH);
    assert_eq!(path, "/messages/@original");
    assert_eq!(
        body["content"],
        format!("{SHOWN}\n\n**Denied. The action was not run.**")
    );
    assert_eq!(body["components"], json!([]));
    assert_eq!(body["allowed_mentions"], json!({ "parse": [] }));

    let bare = final_payload("  ", "en", FinalState::Approved);
    assert_eq!(bare["content"], "**Approved. The action is running.**");

    let (method, path, body) = outcome_call(&press, "en", PressOutcome::Notice(Notice::NotAllowed));
    assert_eq!(method, reqwest::Method::POST);
    assert_eq!(path, "");
    assert_eq!(body["content"], "You cannot decide this request here.");
    assert_eq!(body["flags"], 64);
    assert!(body.get("components").is_none());
}

#[tokio::test]
async fn a_press_by_a_paired_member_is_decided_for_the_thread_it_was_posted_in() {
    let (url, seen, server) =
        mock_core(json!({ "outcome": "decided", "status": "approved" })).await;
    let channel = channel(&url);
    channel.runtime.pairing.approve("discord", "111").await;
    let press = parse_press(&approve("111")).unwrap();
    let chat_id = press_chat_id(&press, Some(Some("2001".to_owned())));

    assert_eq!(
        channel.decide_approval_press(&press, chat_id).await,
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
            "conversationId": "channel__chan_5F1__2001_3A3001",
            "platform": "discord",
            "senderId": "111",
        })
    );
    server.abort();
}

#[tokio::test]
async fn a_press_by_someone_else_or_in_an_unknown_place_changes_nothing() {
    let (url, seen, server) =
        mock_core(json!({ "outcome": "decided", "status": "approved" })).await;
    let channel = channel(&url);
    channel.runtime.pairing.approve("discord", "111").await;
    channel.runtime.pairing.block("discord", "666").await;

    for user in ["999", "666"] {
        let press = parse_press(&approve(user)).unwrap();
        let chat_id = press_chat_id(&press, Some(None));
        assert_eq!(
            channel.decide_approval_press(&press, chat_id).await,
            PressOutcome::Notice(Notice::NotAllowed),
            "{user}"
        );
    }
    // The paired member, but the channel lookup failed: nothing is guessed.
    let press = parse_press(&approve("111")).unwrap();
    assert_eq!(
        channel.decide_approval_press(&press, None).await,
        PressOutcome::Notice(Notice::Unavailable)
    );
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
            json!({ "outcome": "already_decided", "status": "approved" }),
            PressOutcome::Final(FinalState::Approved),
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
        channel.runtime.pairing.approve("discord", "111").await;
        // The press says Deny; what is shown is what Core holds.
        let press = parse_press(&interaction("111", &format!("ryuapr:d:{TOKEN}"))).unwrap();
        let chat_id = press_chat_id(&press, Some(None));
        assert_eq!(
            channel.decide_approval_press(&press, chat_id).await,
            expected
        );
        server.abort();
    }
}
