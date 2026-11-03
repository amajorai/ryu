//! The bridge's own replies (pairing prompt, empty and failed turns) are
//! written in the sender's platform locale, else the owner's, else English.

use std::sync::Mutex;

use super::*;
use crate::i18n::{self, messages, tests::install_japanese_pairing, tests::with_translation};
use crate::pairing::DmPolicy;

/// Records every message the shared path sends.
struct RecordingChannel {
    runtime: ChannelRuntime,
    sent: Mutex<Vec<String>>,
}

#[async_trait]
impl Channel for RecordingChannel {
    fn name(&self) -> &'static str {
        "telegram"
    }

    fn runtime(&self) -> &ChannelRuntime {
        &self.runtime
    }

    async fn send_message(&self, _chat_id: &str, text: &str) -> anyhow::Result<()> {
        self.sent.lock().unwrap().push(text.to_owned());
        Ok(())
    }

    async fn run(self: Arc<Self>, _host: Arc<dyn ChannelHost>) -> anyhow::Result<()> {
        anyhow::bail!("recording channel has no transport")
    }
}

/// The legacy pipeline seam: answers with `reply`, or fails.
struct PipelineHost(Option<Value>);

#[async_trait]
impl ChannelHost for PipelineHost {
    async fn run_pipeline(&self, _channel: &str, _body: Value) -> anyhow::Result<Value> {
        self.0
            .clone()
            .ok_or_else(|| anyhow::anyhow!("upstream refused the request"))
    }
}

fn channel(dm: DmPolicy, owner: &str) -> Arc<RecordingChannel> {
    let mut runtime = ChannelRuntime::new(
        reqwest::Client::new(),
        CommonChannelConfig {
            access: AccessPolicy {
                dm,
                ..Default::default()
            },
            typing_indicator: false,
            lifecycle_reactions: false,
            ..Default::default()
        },
        PairingStore::ephemeral(),
        None,
    );
    runtime.owner_locale = i18n::OwnerLocale::fixed(owner);
    Arc::new(RecordingChannel {
        runtime,
        sent: Mutex::new(Vec::new()),
    })
}

fn message(locale: Option<&str>) -> InboundMessage {
    let mut message = InboundMessage::text("chat-1", "hello");
    message.sender_id = Some("stranger".into());
    message.locale = locale.map(str::to_owned);
    message
}

async fn reply(
    channel: &Arc<RecordingChannel>,
    host: PipelineHost,
    locale: Option<&str>,
) -> String {
    handle_turn(Arc::clone(channel), Arc::new(host), message(locale)).await;
    channel
        .sent
        .lock()
        .unwrap()
        .pop()
        .expect("a reply was sent")
}

#[tokio::test]
async fn a_japanese_sender_gets_the_pairing_prompt_in_japanese() {
    install_japanese_pairing();
    let bot = channel(DmPolicy::Pairing, "en");
    let prompt = reply(&bot, PipelineHost(None), Some("ja")).await;
    assert!(
        prompt.starts_with("🔒 このアシスタントは非公開です。"),
        "{prompt}"
    );
    assert!(prompt.contains("ペアリングコードは *"), "{prompt}");
}

#[tokio::test]
async fn an_unknown_sender_locale_falls_back_to_english_not_the_owner() {
    install_japanese_pairing();
    let bot = channel(DmPolicy::Pairing, "ja");
    let prompt = reply(&bot, PipelineHost(None), Some("tlh")).await;
    assert!(
        prompt.starts_with("🔒 This assistant is private."),
        "{prompt}"
    );
}

#[tokio::test]
async fn a_sender_without_a_locale_gets_the_owners_language() {
    install_japanese_pairing();
    let bot = channel(DmPolicy::Pairing, "ja");
    let prompt = reply(&bot, PipelineHost(None), None).await;
    assert!(
        prompt.starts_with("🔒 このアシスタントは非公開です。"),
        "{prompt}"
    );
}

#[tokio::test]
async fn failed_and_empty_turns_are_answered_in_the_senders_language() {
    with_translation(
        "de",
        messages::TURN_FAILED_MESSAGE,
        "Leider ist etwas schiefgelaufen.",
    );
    with_translation(
        "de",
        messages::NO_RESPONSE_MESSAGE,
        "Der Agent hat nicht geantwortet.",
    );
    let bot = channel(DmPolicy::Open, "en");
    let failed = reply(&bot, PipelineHost(None), Some("de-AT")).await;
    // The Gateway's English error text never reaches the chat.
    assert_eq!(failed, "Leider ist etwas schiefgelaufen.");
    assert!(!failed.contains("upstream refused the request"));
    let empty = reply(
        &bot,
        PipelineHost(Some(json!({ "choices": [] }))),
        Some("de"),
    )
    .await;
    assert_eq!(empty, "Der Agent hat nicht geantwortet.");
    let english = reply(&bot, PipelineHost(Some(json!({}))), None).await;
    assert_eq!(english, "The agent sent no response.");
}

#[tokio::test]
async fn an_actionable_pipeline_failure_gets_its_own_localized_sentence() {
    struct BudgetHost;
    #[async_trait]
    impl ChannelHost for BudgetHost {
        async fn run_pipeline(&self, _channel: &str, _body: Value) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("Budget exceeded"))
        }
    }
    with_translation(
        "de",
        messages::TURN_BUDGET_EXCEEDED_MESSAGE,
        "Dieser Assistent hat sein Ausgabenlimit erreicht.",
    );
    let bot = channel(DmPolicy::Open, "en");
    handle_turn(Arc::clone(&bot), Arc::new(BudgetHost), message(Some("de"))).await;
    let reply = bot.sent.lock().unwrap().pop().expect("a reply was sent");
    assert_eq!(reply, "Dieser Assistent hat sein Ausgabenlimit erreicht.");
}
