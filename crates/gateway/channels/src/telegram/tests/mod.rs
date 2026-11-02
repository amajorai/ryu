use super::*;

use crate::CommonChannelConfig;

use ryu_channel_contracts::ChannelActionEvent;

mod part1;
mod part2;
mod part3;

struct TestHost;

#[async_trait]
impl ChannelHost for TestHost {
    async fn run_pipeline(&self, _channel_name: &str, _body: Value) -> anyhow::Result<Value> {
        Ok(Value::Null)
    }
}

fn make_cfg(token: &str) -> TelegramChannelConfig {
    TelegramChannelConfig {
        token: token.to_string(),
        common: CommonChannelConfig {
            model: "gpt-4o".to_string(),
            ..Default::default()
        },
        options: crate::TelegramChannelOptions::default(),
    }
}

fn group_message(text: &str, first_name: &str) -> Message {
    Message {
        chat: Chat {
            id: 42,
            chat_type: "supergroup".to_string(),
        },
        text: Some(text.to_string()),
        from: Some(TgUser {
            id: 7,
            first_name: first_name.to_string(),
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn me() -> BotIdentity {
    BotIdentity {
        id: 999,
        username: Some("ryubot".to_string()),
        ..Default::default()
    }
}

fn flood_envelope(retry_after: u64) -> ApiEnvelope {
    serde_json::from_value(json!({
        "ok": false,
        "error_code": 429,
        "description": format!("Too Many Requests: retry after {retry_after}"),
        "parameters": { "retry_after": retry_after }
    }))
    .unwrap()
}

type BotApiCalls = Arc<std::sync::Mutex<Vec<(String, Value)>>>;

type BotApiResponder = Arc<dyn Fn(&str, usize) -> (StatusCode, Value) + Send + Sync>;

#[derive(Clone)]
struct MockBotApi {
    calls: BotApiCalls,
    responder: BotApiResponder,
}

async fn mock_bot_api_method(
    axum::extract::Path((_token, method)): axum::extract::Path<(String, String)>,
    State(api): State<MockBotApi>,
    axum::Json(body): axum::Json<Value>,
) -> (StatusCode, axum::Json<Value>) {
    let earlier_calls = {
        let mut calls = api.calls.lock().unwrap();
        let earlier = calls.iter().filter(|(name, _)| name == &method).count();
        calls.push((method.clone(), body));
        earlier
    };
    let (status, reply) = (api.responder)(&method, earlier_calls);
    (status, axum::Json(reply))
}

/// A Bot API stand-in whose `responder` gets the method name and how many
/// earlier calls that method has seen. Returns the channel and the call log.
async fn channel_with_mock_bot_api(
    responder: BotApiResponder,
) -> (TelegramChannel, BotApiCalls, tokio::task::JoinHandle<()>) {
    let calls = BotApiCalls::default();
    let app = Router::new()
        .route("/:token/:method", post(mock_bot_api_method))
        .with_state(MockBotApi {
            calls: Arc::clone(&calls),
            responder,
        });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/bot-test", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut config = make_cfg("test-token");
    config.options.base_url = Some(base);
    let channel =
        TelegramChannel::new(config, reqwest::Client::new(), PairingStore::ephemeral()).unwrap();
    (channel, calls, server)
}

fn sent(message_id: i64) -> (StatusCode, Value) {
    (
        StatusCode::OK,
        json!({ "ok": true, "result": { "message_id": message_id } }),
    )
}

fn flood_control() -> (StatusCode, Value) {
    (
        StatusCode::TOO_MANY_REQUESTS,
        json!({
            "ok": false,
            "error_code": 429,
            "description": "Too Many Requests: retry after 0",
            "parameters": { "retry_after": 0 }
        }),
    )
}
