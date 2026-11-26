use super::*;

use crate::CommonChannelConfig;

const TOKEN: &str = "0123456789abcdef0123456789abcdef";
const PROMPT_TEXT: &str = "The agent Scout wants to run gmail.send_email.\nSend an email";

type Calls = Arc<std::sync::Mutex<Vec<(String, Value)>>>;

struct TestHost;

#[async_trait]
impl ChannelHost for TestHost {
    async fn run_pipeline(&self, _channel_name: &str, _body: Value) -> anyhow::Result<Value> {
        anyhow::bail!("an approval press must never become a turn")
    }
}

/// A Telegram channel wired to a Core and a Bot API that only record calls.
struct Rig {
    channel: Arc<TelegramChannel>,
    /// `(route, body)` of every request Core received.
    core: Calls,
    /// `(method, body)` of every Bot API call.
    bot: Calls,
    servers: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for Rig {
    fn drop(&mut self) {
        for server in &self.servers {
            server.abort();
        }
    }
}

async fn record_core(
    State((calls, answer)): State<(Calls, Value)>,
    uri: axum::http::Uri,
    axum::Json(body): axum::Json<Value>,
) -> axum::Json<Value> {
    calls.lock().unwrap().push((uri.path().to_owned(), body));
    axum::Json(answer)
}

async fn record_bot(
    axum::extract::Path((_token, method)): axum::extract::Path<(String, String)>,
    State(calls): State<Calls>,
    axum::Json(body): axum::Json<Value>,
) -> axum::Json<Value> {
    calls.lock().unwrap().push((method, body));
    axum::Json(json!({ "ok": true, "result": true }))
}

async fn serve(app: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (url, server)
}

/// Core answers every request with `core_answer`. Telegram account `111` is
/// paired; nobody else is.
async fn rig(core_answer: Value) -> Rig {
    let core = Calls::default();
    let bot = Calls::default();
    let (core_url, core_server) = serve(
        Router::new()
            .fallback(record_core)
            .with_state((Arc::clone(&core), core_answer)),
    )
    .await;
    let (bot_url, bot_server) = serve(
        Router::new()
            .route("/:token/:method", post(record_bot))
            .with_state(Arc::clone(&bot)),
    )
    .await;
    let mut config = TelegramChannelConfig {
        token: "test-token".to_owned(),
        common: CommonChannelConfig {
            model: "gpt-4o".to_owned(),
            core_url,
            channel_id: Some("chan_1".to_owned()),
            ..Default::default()
        },
        options: crate::TelegramChannelOptions::default(),
    };
    config.options.base_url = Some(format!("{bot_url}/bot-test"));
    let pairing = PairingStore::ephemeral();
    pairing.approve("telegram", "111").await;
    let channel = Arc::new(TelegramChannel::new(config, reqwest::Client::new(), pairing).unwrap());
    Rig {
        channel,
        core,
        bot,
        servers: vec![core_server, bot_server],
    }
}

fn callback(from: i64, chat: i64, chat_type: &str, data: &str) -> CallbackQuery {
    CallbackQuery {
        id: "cb-1".to_owned(),
        from: TgUser {
            id: from,
            first_name: "Ada".to_owned(),
            ..Default::default()
        },
        message: Some(Message {
            chat: Chat {
                id: chat,
                chat_type: chat_type.to_owned(),
            },
            message_id: 88,
            text: Some(PROMPT_TEXT.to_owned()),
            ..Default::default()
        }),
        data: Some(data.to_owned()),
    }
}

fn calls_of(calls: &Calls, name: &str) -> Vec<Value> {
    calls
        .lock()
        .unwrap()
        .iter()
        .filter(|(called, _)| called == name)
        .map(|(_, body)| body.clone())
        .collect()
}

fn prompt() -> ApprovalPrompt {
    ApprovalPrompt {
        token: TOKEN.to_owned(),
        agent_name: Some("<a href=\"tg://user?id=1\">Scout</a>".to_owned()),
        tool_name: "gmail.send_email".to_owned(),
        summary: "Send <b>mail</b> & more".to_owned(),
    }
}

#[test]
fn the_prompt_is_escaped_html_with_two_opaque_buttons() {
    let payload = prompt_payload(42, Some("t7"), &prompt(), "en").unwrap();
    assert_eq!(payload["chat_id"], 42);
    assert_eq!(payload["message_thread_id"], 7);
    assert_eq!(payload["parse_mode"], "HTML");
    assert_eq!(payload["link_preview_options"]["is_disabled"], true);
    let text = payload["text"].as_str().unwrap();
    assert!(!text.contains('<') && !text.contains('>'), "{text}");
    assert!(text.contains("&lt;a href=\"tg://user?id=1\"&gt;Scout&lt;/a&gt;"));
    assert!(text.contains("Send &lt;b&gt;mail&lt;/b&gt; &amp; more"));

    let row = payload["reply_markup"]["inline_keyboard"][0]
        .as_array()
        .unwrap();
    assert_eq!(row.len(), 2);
    assert_eq!(row[0]["text"], "Approve request");
    assert_eq!(row[0]["callback_data"], format!("ryuapr:a:{TOKEN}"));
    assert_eq!(row[1]["text"], "Deny request");
    assert_eq!(row[1]["callback_data"], format!("ryuapr:d:{TOKEN}"));
    for button in row {
        let data = button["callback_data"].as_str().unwrap();
        assert!(data.len() <= 64);
        assert!(!data.contains("gmail") && !data.contains("Scout"));
    }

    let mut unusable = prompt();
    unusable.token = "not a token".to_owned();
    assert!(prompt_payload(42, None, &unusable, "en").is_none());
}

#[test]
fn the_final_state_replaces_the_buttons_and_escapes_the_prompt_again() {
    let payload = final_payload(42, 88, "Run <tool> & go", "en", FinalState::Denied);
    assert_eq!(payload["chat_id"], 42);
    assert_eq!(payload["message_id"], 88);
    assert_eq!(
        payload["text"],
        "Run &lt;tool&gt; &amp; go\n\n<b>Denied. The action was not run.</b>"
    );
    assert_eq!(payload["reply_markup"]["inline_keyboard"], json!([]));
    let bare = final_payload(42, 88, "  ", "en", FinalState::Approved);
    assert_eq!(bare["text"], "<b>Approved. The action is running.</b>");
}

#[tokio::test]
async fn an_approve_press_by_a_paired_account_decides_and_rewrites_the_prompt() {
    let rig = rig(json!({ "outcome": "decided", "status": "approved" })).await;
    rig.channel
        .handle_approval_press(
            callback(111, 111, "private", &format!("ryuapr:a:{TOKEN}")),
            TOKEN.to_owned(),
            true,
        )
        .await;

    let core = rig.core.lock().unwrap().clone();
    assert_eq!(core.len(), 1);
    assert_eq!(core[0].0, "/api/channels/approvals/decide");
    assert_eq!(
        core[0].1,
        json!({
            "token": TOKEN,
            "approve": true,
            "connection": "chan_1",
            "conversationId": "channel__chan_5F1__111",
            "platform": "telegram",
            "senderId": "111",
        })
    );
    let edits = calls_of(&rig.bot, "editMessageText");
    assert_eq!(edits.len(), 1);
    assert_eq!(edits[0]["chat_id"], 111);
    assert_eq!(edits[0]["message_id"], 88);
    assert_eq!(
        edits[0]["text"],
        format!("{PROMPT_TEXT}\n\n<b>Approved. The action is running.</b>")
    );
    assert_eq!(edits[0]["reply_markup"]["inline_keyboard"], json!([]));
    let acks = calls_of(&rig.bot, "answerCallbackQuery");
    assert_eq!(acks.len(), 1);
    assert_eq!(acks[0]["callback_query_id"], "cb-1");
    assert_eq!(acks[0]["text"], "Approved. The action is running.");
    assert_eq!(acks[0]["show_alert"], false);
}

#[tokio::test]
async fn a_deny_press_in_a_forum_topic_is_decided_for_that_topic() {
    let rig = rig(json!({ "outcome": "decided", "status": "rejected" })).await;
    let mut press = callback(111, -100, "supergroup", &format!("ryuapr:d:{TOKEN}"));
    press.message.as_mut().unwrap().message_thread_id = Some(7);
    rig.channel
        .handle_approval_press(press, TOKEN.to_owned(), false)
        .await;

    let core = rig.core.lock().unwrap().clone();
    assert_eq!(core.len(), 1);
    assert_eq!(core[0].1["approve"], false);
    assert_eq!(core[0].1["conversationId"], "channel__chan_5F1__-100_3At7");
    assert_eq!(core[0].1["senderId"], "111");
    let edits = calls_of(&rig.bot, "editMessageText");
    assert_eq!(edits.len(), 1);
    assert!(edits[0]["text"]
        .as_str()
        .unwrap()
        .ends_with("<b>Denied. The action was not run.</b>"));
}

#[tokio::test]
async fn a_press_by_someone_else_in_a_group_changes_nothing() {
    let rig = rig(json!({ "outcome": "decided", "status": "approved" })).await;
    rig.channel
        .handle_approval_press(
            callback(999, -100, "supergroup", &format!("ryuapr:a:{TOKEN}")),
            TOKEN.to_owned(),
            true,
        )
        .await;

    assert!(rig.core.lock().unwrap().is_empty(), "Core is not asked");
    assert!(calls_of(&rig.bot, "editMessageText").is_empty());
    let acks = calls_of(&rig.bot, "answerCallbackQuery");
    assert_eq!(acks.len(), 1);
    assert_eq!(acks[0]["text"], "You cannot decide this request here.");
    assert_eq!(acks[0]["show_alert"], true);
    assert_eq!(rig.bot.lock().unwrap().len(), 1, "one private notice only");
}

#[tokio::test]
async fn a_paired_account_core_refuses_gets_a_private_notice_and_the_buttons_stay() {
    for answer in [
        json!({ "outcome": "refused", "reason": "not_linked" }),
        json!({ "outcome": "refused", "reason": "setting_off", "status": "approved" }),
    ] {
        let rig = rig(answer).await;
        rig.channel
            .handle_approval_press(
                callback(111, -100, "group", &format!("ryuapr:a:{TOKEN}")),
                TOKEN.to_owned(),
                true,
            )
            .await;
        assert_eq!(rig.core.lock().unwrap().len(), 1);
        assert!(calls_of(&rig.bot, "editMessageText").is_empty());
        let acks = calls_of(&rig.bot, "answerCallbackQuery");
        assert_eq!(acks[0]["text"], "You cannot decide this request here.");
        assert_eq!(acks[0]["show_alert"], true);
    }
}

#[tokio::test]
async fn a_repeated_or_late_press_shows_the_final_state_core_reports() {
    let cases = [
        (
            json!({ "outcome": "already_decided", "status": "rejected" }),
            "Denied. The action was not run.",
        ),
        (
            json!({ "outcome": "already_decided", "status": "expired" }),
            "This request expired. The action was not run.",
        ),
        (
            json!({ "outcome": "expired" }),
            "These buttons no longer work. Open Ryu to decide this request.",
        ),
    ];
    for (answer, verdict) in cases {
        let rig = rig(answer).await;
        // The press says Approve; what is shown is what Core holds.
        rig.channel
            .handle_approval_press(
                callback(111, 111, "private", &format!("ryuapr:a:{TOKEN}")),
                TOKEN.to_owned(),
                true,
            )
            .await;
        let edits = calls_of(&rig.bot, "editMessageText");
        assert_eq!(edits.len(), 1, "{verdict}");
        assert_eq!(
            edits[0]["text"],
            format!("{PROMPT_TEXT}\n\n<b>{verdict}</b>")
        );
        assert_eq!(edits[0]["reply_markup"]["inline_keyboard"], json!([]));
        assert_eq!(
            calls_of(&rig.bot, "answerCallbackQuery")[0]["text"],
            verdict
        );
    }
}

#[tokio::test]
async fn an_update_with_an_approval_press_is_decided_and_never_run_as_a_turn() {
    let rig = rig(json!({ "outcome": "decided", "status": "approved" })).await;
    rig.channel.dispatch_update(
        Arc::new(TestHost),
        Update {
            update_id: 7,
            callback_query: Some(callback(111, 111, "private", &format!("ryuapr:a:{TOKEN}"))),
            ..Default::default()
        },
        &BotIdentity::default(),
        None,
    );
    for _ in 0..60 {
        if !calls_of(&rig.bot, "answerCallbackQuery").is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // Let anything a wrongly started turn would send arrive.
    tokio::time::sleep(Duration::from_millis(200)).await;

    let routes: Vec<String> = rig
        .core
        .lock()
        .unwrap()
        .iter()
        .map(|(route, _)| route.clone())
        .collect();
    assert_eq!(routes, vec!["/api/channels/approvals/decide"]);
    let methods: Vec<String> = rig
        .bot
        .lock()
        .unwrap()
        .iter()
        .map(|(method, _)| method.clone())
        .collect();
    assert_eq!(methods, vec!["editMessageText", "answerCallbackQuery"]);
}

#[tokio::test]
async fn a_webhook_press_without_the_secret_token_is_dropped_before_any_check() {
    let rig = rig(json!({ "outcome": "decided", "status": "approved" })).await;
    let (tx, mut rx) = mpsc::channel(2);
    let state = TelegramWebhookState {
        tx,
        secret: "secret".to_owned(),
        channel: Arc::downgrade(&rig.channel),
    };
    let body = Bytes::from(
        json!({
            "update_id": 9,
            "callback_query": {
                "id": "cb-9",
                "from": { "id": 111, "first_name": "Ada" },
                "message": {
                    "chat": { "id": 111, "type": "private" },
                    "message_id": 88,
                    "text": PROMPT_TEXT
                },
                "data": format!("ryuapr:a:{TOKEN}")
            }
        })
        .to_string(),
    );

    let mut forged = HeaderMap::new();
    forged.insert("x-telegram-bot-api-secret-token", "guess".parse().unwrap());
    for headers in [HeaderMap::new(), forged] {
        assert_eq!(
            telegram_webhook(State(state.clone()), headers, body.clone()).await,
            StatusCode::UNAUTHORIZED
        );
    }
    assert!(rx.try_recv().is_err(), "a forged press is never queued");
    assert!(rig.core.lock().unwrap().is_empty());
    assert!(rig.bot.lock().unwrap().is_empty());

    // The same press with Telegram's secret token is accepted and queued.
    let mut proved = HeaderMap::new();
    proved.insert("x-telegram-bot-api-secret-token", "secret".parse().unwrap());
    assert_eq!(
        telegram_webhook(State(state), proved, body).await,
        StatusCode::OK
    );
    let queued = rx.try_recv().expect("the proved press is queued");
    let press = queued.update.callback_query.expect("callback");
    assert_eq!(press.from.id, 111);
    assert_eq!(
        press.data.as_deref().and_then(approvals::decode_press),
        Some((TOKEN.to_owned(), true))
    );
}
