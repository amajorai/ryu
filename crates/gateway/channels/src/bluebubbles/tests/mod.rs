use super::*;

use crate::commands::ChannelCommand;

use crate::CommonChannelConfig;

mod part1;
mod part2;

fn sample_config() -> BlueBubblesChannelConfig {
    BlueBubblesChannelConfig {
        server_url: "http://192.168.1.10:1234".to_string(),
        password: "hunter2".to_string(),
        webhook_bind: "127.0.0.1:8765".to_string(),
        webhook_path: "/webhooks/bluebubbles".to_string(),
        private_api: false,
        mention_patterns: Vec::new(),
        home_channel: None,
        common: CommonChannelConfig::default(),
    }
}

fn channel(cfg: BlueBubblesChannelConfig) -> BlueBubblesChannel {
    BlueBubblesChannel::new(cfg, reqwest::Client::new(), PairingStore::ephemeral())
        .expect("config should be valid")
}

fn new_message(text: &str, is_from_me: bool, style: i64) -> Value {
    json!({
        "type": "new-message",
        "data": {
            "guid": "msg-guid-1",
            "text": text,
            "isFromMe": is_from_me,
            "handle": { "address": "+15551234567", "service": "iMessage" },
            "chats": [ { "guid": "iMessage;-;+15551234567", "style": style } ]
        }
    })
}

/// A BlueBubbles Server stand-in that records every `message/text` it is
/// asked to send, so a test can see exactly what reached the iMessage user.
async fn recording_bluebubbles_server() -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
    let sent = Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorder = Arc::clone(&sent);
    let app = Router::new().route(
        "/api/v1/message/text",
        post(move |axum::Json(body): axum::Json<Value>| {
            let recorder = Arc::clone(&recorder);
            async move {
                recorder
                    .lock()
                    .expect("recorder")
                    .push(body["message"].as_str().unwrap_or_default().to_owned());
                axum::Json(json!({ "status": 200, "message": "Success" }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}"), sent)
}

/// Counts model turns; none of the denied cases may reach one.
struct CountingHost(std::sync::atomic::AtomicUsize);

#[async_trait]
impl ChannelHost for CountingHost {
    async fn run_pipeline(&self, _channel_name: &str, _body: Value) -> anyhow::Result<Value> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        anyhow::bail!("this test never expects a model turn")
    }
}

/// Dispatch one `/help` from `+15551234567` (in a group when `is_group`)
/// under `access`, returning every text sent back and the model-turn count.
async fn dispatch_help(
    access: crate::pairing::AccessPolicy,
    is_group: bool,
) -> (Vec<String>, usize) {
    dispatch_help_with_store(access, is_group, PairingStore::ephemeral(), "en").await
}

/// [`dispatch_help`] against a pairing store the caller has pre-seeded
/// (for example with a blocked or pending sender), for an owner whose UI
/// language is `owner_locale` (iMessage reports no sender language).
async fn dispatch_help_with_store(
    access: crate::pairing::AccessPolicy,
    is_group: bool,
    pairing: PairingStore,
    owner_locale: &str,
) -> (Vec<String>, usize) {
    let (server_url, sent) = recording_bluebubbles_server().await;
    let mut cfg = sample_config();
    cfg.server_url = server_url;
    cfg.common.access = access;
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    let mut channel = BlueBubblesChannel::new(cfg, http, pairing).unwrap();
    channel.runtime.owner_locale = crate::i18n::OwnerLocale::fixed(owner_locale);
    let channel = Arc::new(channel);
    let host = Arc::new(CountingHost(std::sync::atomic::AtomicUsize::new(0)));
    let style = if is_group { CHAT_STYLE_GROUP } else { 45 };
    let message = parse_inbound(&new_message("/help", false, style)).expect("parses");
    dispatch(channel, host.clone(), message, "message:msg-guid-1").await;
    let texts = sent.lock().expect("recorder").clone();
    (texts, host.0.load(std::sync::atomic::Ordering::SeqCst))
}
