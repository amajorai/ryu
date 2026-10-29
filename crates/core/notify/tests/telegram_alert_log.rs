//! `send_telegram_alert` logs a failed send. The Bot API URL carries the bot
//! token in its path, so that log line must not include the URL.
//!
//! This lives in its own test binary because it installs a `tracing`
//! subscriber: callsite interest is cached process-wide, and a concurrent unit
//! test hitting the same `warn!` without a subscriber could disable it here.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Metadata, Subscriber};

/// Records the fields of every event emitted by this crate.
struct CaptureLogs(Arc<Mutex<Vec<String>>>);

struct FieldText<'a>(&'a mut String);

impl Visit for FieldText<'_> {
    fn record_debug(&mut self, _field: &Field, value: &dyn std::fmt::Debug) {
        use std::fmt::Write;
        let _ = write!(self.0, "{value:?}");
    }
}

impl Subscriber for CaptureLogs {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.target().starts_with("ryu_notify")
    }
    fn new_span(&self, _attributes: &Attributes<'_>) -> Id {
        Id::from_u64(1)
    }
    fn record(&self, _span: &Id, _values: &Record<'_>) {}
    fn record_follows_from(&self, _span: &Id, _follows: &Id) {}
    fn event(&self, event: &Event<'_>) {
        let mut line = String::new();
        event.record(&mut FieldText(&mut line));
        self.0.lock().unwrap().push(line);
    }
    fn enter(&self, _span: &Id) {}
    fn exit(&self, _span: &Id) {}
}

/// A bound-then-freed local address: connecting to it is refused at once.
fn dead_addr() -> SocketAddr {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    addr
}

#[tokio::test]
async fn telegram_alert_failure_log_does_not_leak_bot_token() {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let _guard = tracing::subscriber::set_default(CaptureLogs(lines.clone()));

    let http = reqwest::Client::builder()
        .no_proxy()
        .resolve("api.telegram.org", dead_addr())
        .build()
        .unwrap();
    let token = "123456:AAsecret-bot-token";
    ryu_notify::send_telegram_alert(&http, token, "CHAT", "Title", "body").await;

    let lines = lines.lock().unwrap();
    assert!(
        lines
            .iter()
            .any(|line| line.contains("telegram alert failed")),
        "expected a failure log line, got {lines:?}"
    );
    for line in lines.iter() {
        assert!(!line.contains(token), "bot token leaked into log: {line}");
        assert!(
            !line.contains("api.telegram.org/bot"),
            "token-bearing URL leaked into log: {line}"
        );
    }
}
