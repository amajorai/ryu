use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use serde_json::{json, Value};
use tokio::net::TcpListener;

use super::*;
use crate::pairing::{AccessPolicy, DmPolicy, PairingStore};
use crate::{ChannelHost, CommonChannelConfig};

const TOKEN: &str = "0123456789abcdef0123456789abcdef";

type Seen = Arc<Mutex<Vec<Value>>>;

#[derive(Clone)]
struct MockCore {
    seen: Seen,
    answer: (StatusCode, Value),
}

async fn decide_route(
    State(core): State<MockCore>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    core.seen.lock().unwrap().push(body);
    (core.answer.0, Json(core.answer.1.clone()))
}

/// A Core stand-in that records every decide call and answers `answer`.
async fn mock_core(answer: (StatusCode, Value)) -> (String, Seen, tokio::task::JoinHandle<()>) {
    let seen = Seen::default();
    let app = Router::new()
        .route("/api/channels/approvals/decide", post(decide_route))
        .with_state(MockCore {
            seen: Arc::clone(&seen),
            answer,
        });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (url, seen, server)
}

struct TestChannel {
    runtime: ChannelRuntime,
    posted: Mutex<Vec<(String, ApprovalPrompt)>>,
}

#[async_trait]
impl Channel for TestChannel {
    fn name(&self) -> &'static str {
        "telegram"
    }

    fn runtime(&self) -> &ChannelRuntime {
        &self.runtime
    }

    async fn send_message(&self, _chat_id: &str, _text: &str) -> anyhow::Result<()> {
        Ok(())
    }

    async fn send_approval_prompt(
        &self,
        chat_id: &str,
        prompt: &ApprovalPrompt,
        _locale: &str,
    ) -> anyhow::Result<bool> {
        self.posted
            .lock()
            .unwrap()
            .push((chat_id.to_owned(), prompt.clone()));
        Ok(true)
    }

    async fn run(self: Arc<Self>, _host: Arc<dyn ChannelHost>) -> anyhow::Result<()> {
        Ok(())
    }
}

/// A store-backed channel (`chan_1`) with DM pairing, talking to `core_url`.
fn channel(core_url: &str) -> TestChannel {
    let cfg = CommonChannelConfig {
        core_url: core_url.to_owned(),
        channel_id: Some("chan_1".to_owned()),
        access: AccessPolicy {
            dm: DmPolicy::Pairing,
            ..Default::default()
        },
        ..Default::default()
    };
    TestChannel {
        runtime: ChannelRuntime::new(reqwest::Client::new(), cfg, PairingStore::ephemeral(), None),
        posted: Mutex::new(Vec::new()),
    }
}

fn press(sender: &str, approve: bool) -> ApprovalPress {
    ApprovalPress {
        token: TOKEN.to_owned(),
        approve,
        chat_id: "42".to_owned(),
        sender_id: sender.to_owned(),
        locale: None,
    }
}

fn prompt(token: &str) -> ApprovalPrompt {
    ApprovalPrompt {
        token: token.to_owned(),
        agent_name: Some("Scout".to_owned()),
        tool_name: "gmail.send_email".to_owned(),
        summary: "Send an email".to_owned(),
    }
}

#[test]
fn callback_data_round_trips_and_holds_only_the_choice_and_the_token() {
    let approve = encode_press(TOKEN, true).unwrap();
    let deny = encode_press(TOKEN, false).unwrap();
    assert_eq!(approve, format!("ryuapr:a:{TOKEN}"));
    assert_eq!(deny, format!("ryuapr:d:{TOKEN}"));
    assert!(approve.len() <= 64, "Telegram allows 64 bytes");
    assert_eq!(decode_press(&approve), Some((TOKEN.to_owned(), true)));
    assert_eq!(decode_press(&deny), Some((TOKEN.to_owned(), false)));
}

#[test]
fn anything_else_is_not_approval_callback_data() {
    let forged = [
        "",
        "ryuapr",
        "ryuapr:a",
        "ryuapr:x:0123456789abcdef0123456789abcdef",
        "ryuapr:a:short",
        "ryuapr:a:0123456789abcdef0123456789abcdef:extra",
        "ryuapr:a:0123456789abcdef/../0123456789abcdef",
        "other:a:0123456789abcdef0123456789abcdef",
        r#"{"a":"workflow.continue"}"#,
    ];
    for data in forged {
        assert_eq!(decode_press(data), None, "{data}");
    }
    assert_eq!(encode_press("short", true), None);
    assert_eq!(encode_press("has space 0123456789abcdef", true), None);
}

#[test]
fn the_prompt_names_the_agent_the_tool_and_the_summary() {
    assert_eq!(
        prompt_text("en", &prompt(TOKEN)),
        "The agent Scout wants to run gmail.send_email.\nSend an email"
    );
    let mut unnamed = prompt(TOKEN);
    unnamed.agent_name = Some("  ".to_owned());
    unnamed.summary = String::new();
    assert_eq!(
        prompt_text("en", &unnamed),
        "An agent wants to run gmail.send_email."
    );
    let mut long = prompt(TOKEN);
    long.summary = "x".repeat(PROMPT_MAX_CHARS * 2);
    let text = prompt_text("en", &long);
    assert_eq!(text.chars().count(), PROMPT_MAX_CHARS);
    assert!(text.ends_with('…'));
}

#[test]
fn untrusted_text_is_escaped_for_each_platform() {
    let hostile = "<b>x</b> & <@U1> [a](http://e.x) @everyone *_~`|>#";
    assert_eq!(
        escape_telegram_html(hostile),
        "&lt;b&gt;x&lt;/b&gt; &amp; &lt;@U1&gt; [a](http://e.x) @everyone *_~`|&gt;#"
    );
    let slack = escape_slack(hostile);
    assert!(!slack.contains('<') && !slack.contains('>'), "{slack}");
    assert!(slack.contains("&lt;@U1&gt;"));
    let discord = escape_discord(hostile);
    assert!(!discord.contains("@everyone"), "{discord}");
    for opener in ['<', '>', '[', ']', '(', ')', '*', '_', '~', '`', '|', '#'] {
        for (index, ch) in discord.char_indices() {
            if ch == opener {
                assert_eq!(&discord[index - 1..index], "\\", "{opener} in {discord}");
            }
        }
    }
}

#[test]
fn only_what_core_confirmed_is_shown_as_final() {
    use FinalState::{Approved, Cancelled, Denied, Expired, Gone};
    let cases = [
        ("decided", Some("approved"), PressOutcome::Final(Approved)),
        ("decided", Some("rejected"), PressOutcome::Final(Denied)),
        (
            "already_decided",
            Some("approved"),
            PressOutcome::Final(Approved),
        ),
        (
            "already_decided",
            Some("expired"),
            PressOutcome::Final(Expired),
        ),
        (
            "already_decided",
            Some("cancelled"),
            PressOutcome::Final(Cancelled),
        ),
        ("already_decided", None, PressOutcome::Final(Gone)),
        ("expired", None, PressOutcome::Final(Gone)),
        ("refused", None, PressOutcome::Notice(Notice::NotAllowed)),
        // A refusal never becomes a final state, whatever else Core sends.
        (
            "refused",
            Some("approved"),
            PressOutcome::Notice(Notice::NotAllowed),
        ),
        (
            "unavailable",
            None,
            PressOutcome::Notice(Notice::Unavailable),
        ),
        (
            "",
            Some("approved"),
            PressOutcome::Notice(Notice::Unavailable),
        ),
        (
            "something_new",
            Some("approved"),
            PressOutcome::Notice(Notice::Unavailable),
        ),
    ];
    for (outcome, status, expected) in cases {
        assert_eq!(
            outcome_from(outcome, status),
            expected,
            "{outcome} {status:?}"
        );
    }
}

#[tokio::test]
async fn a_presser_the_dm_gate_has_not_admitted_never_reaches_core() {
    let (url, seen, server) = mock_core((
        StatusCode::OK,
        json!({ "outcome": "decided", "status": "approved" }),
    ))
    .await;
    let channel = channel(&url);
    channel.runtime.pairing.approve("telegram", "111").await;
    channel.runtime.pairing.block("telegram", "666").await;

    // Unknown, blocked and empty senders are refused before any Core call.
    for sender in ["999", "666", "", "  "] {
        assert_eq!(
            decide_press(&channel, &press(sender, true)).await,
            PressOutcome::Notice(Notice::NotAllowed),
            "sender {sender:?}"
        );
    }
    assert!(seen.lock().unwrap().is_empty(), "Core must not be asked");

    // The paired sender is passed on, with who pressed, where and what.
    assert_eq!(
        decide_press(&channel, &press("111", true)).await,
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
            "conversationId": "channel__chan_5F1__42",
            "platform": "telegram",
            "senderId": "111",
        })
    );
    server.abort();
}

#[tokio::test]
async fn a_blocked_sender_is_refused_even_when_allowlisted() {
    let (url, seen, server) = mock_core((
        StatusCode::OK,
        json!({ "outcome": "decided", "status": "approved" }),
    ))
    .await;
    let mut channel = channel(&url);
    channel.runtime.cfg.access.dm_allowlist = vec!["666".to_owned()];
    assert!(presser_admitted(&channel.runtime, "telegram", "666").await);
    channel.runtime.pairing.block("telegram", "666").await;
    assert!(!presser_admitted(&channel.runtime, "telegram", "666").await);
    assert_eq!(
        decide_press(&channel, &press("666", true)).await,
        PressOutcome::Notice(Notice::NotAllowed)
    );
    assert!(seen.lock().unwrap().is_empty());
    server.abort();
}

#[tokio::test]
async fn a_core_refusal_or_failure_never_reads_as_a_decision() {
    let answers = [
        (
            (
                StatusCode::OK,
                json!({ "outcome": "refused", "reason": "not_linked" }),
            ),
            PressOutcome::Notice(Notice::NotAllowed),
        ),
        (
            (StatusCode::BAD_REQUEST, json!({ "error": "invalid_press" })),
            PressOutcome::Notice(Notice::Unavailable),
        ),
        (
            (StatusCode::SERVICE_UNAVAILABLE, json!({ "error": "retry" })),
            PressOutcome::Notice(Notice::Unavailable),
        ),
        (
            (StatusCode::OK, json!({ "status": "approved" })),
            PressOutcome::Notice(Notice::Unavailable),
        ),
    ];
    for (answer, expected) in answers {
        let (url, _seen, server) = mock_core(answer).await;
        let channel = channel(&url);
        channel.runtime.pairing.approve("telegram", "111").await;
        assert_eq!(decide_press(&channel, &press("111", true)).await, expected);
        server.abort();
    }

    // Core cannot be reached at all.
    let channel = channel("http://127.0.0.1:9");
    channel.runtime.pairing.approve("telegram", "111").await;
    assert_eq!(
        decide_press(&channel, &press("111", false)).await,
        PressOutcome::Notice(Notice::Unavailable)
    );
}

#[tokio::test]
async fn a_bot_that_does_not_route_through_core_decides_nothing() {
    let (url, seen, server) = mock_core((
        StatusCode::OK,
        json!({ "outcome": "decided", "status": "approved" }),
    ))
    .await;
    let mut channel = channel(&url);
    channel.runtime.cfg.channel_id = None;
    channel.runtime.pairing.approve("telegram", "111").await;
    assert_eq!(
        decide_press(&channel, &press("111", true)).await,
        PressOutcome::Notice(Notice::NotAllowed)
    );
    assert!(seen.lock().unwrap().is_empty());
    server.abort();
}

#[tokio::test]
async fn prompts_with_a_token_core_would_not_issue_are_not_posted() {
    let channel = channel("http://127.0.0.1:9");
    post_prompts(&channel, "42", &[prompt("bad token"), prompt(TOKEN)], "en").await;
    let posted = channel.posted.lock().unwrap();
    assert_eq!(posted.len(), 1);
    assert_eq!(posted[0].0, "42");
    assert_eq!(posted[0].1.token, TOKEN);
}

#[test]
fn every_state_and_notice_has_its_own_sentence() {
    use FinalState::{Approved, Cancelled, Denied, Expired, Gone};
    let finals: Vec<String> = [Approved, Denied, Expired, Cancelled, Gone]
        .into_iter()
        .map(|state| final_text("en", state))
        .collect();
    let notices = [
        notice_text("en", Notice::NotAllowed),
        notice_text("en", Notice::Unavailable),
    ];
    let mut all: Vec<&String> = finals.iter().chain(notices.iter()).collect();
    assert!(all
        .iter()
        .all(|text| !text.is_empty() && text.chars().count() <= 200));
    all.sort();
    all.dedup();
    assert_eq!(all.len(), 7);
    let (approve, deny) = button_labels("en");
    assert_eq!(
        (approve.as_str(), deny.as_str()),
        ("Approve request", "Deny request")
    );
}
