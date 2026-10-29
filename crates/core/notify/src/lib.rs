//! Shared notification-delivery wire types + send primitives.
//!
//! This crate is the narrow surface that both **Core** (the kernel notification
//! store + fan-out orchestration in `apps/core/src/notify`) and the
//! out-of-process **monitors** engine (`apps-store/monitors/backend`) need in
//! common: the channel-target enum and the dep-light HTTP send functions. It has
//! ZERO dependency on `apps/core`.
//!
//! Placement (Core vs Gateway): a notification decides *what runs* (open a
//! delivery socket) → Core-side. Nothing here is policy. The store,
//! `deliver_user_notification`, dedupe, and the tiered `notify_all` fan-out that
//! wires in the desktop event bus / plugin hooks / BYO SMTP live in Core; only the
//! shared types + primitives live here.
//!
//! The set of targets is an extensible enum — the "nothing hardcoded, everything
//! swappable" rule applied to channels: a webhook covers Slack/Discord/any HTTP
//! endpoint, Telegram is a direct Bot-API send, Expo handles mobile, and Email
//! carries only the recipient (the SMTP transport is a shared node resource
//! resolved once at the Core call site, never stored per-target).
//!
//! Every send is best-effort unless its name ends in `_text`: those return
//! `Ok(())` only on a 2xx so a workflow node can surface a failed delivery.

use serde::{Deserialize, Serialize};
use serde_json::json;

const EXPO_PUSH_URL: &str = "https://exp.host/--/api/v2/push/send";
const MAX_WEBHOOK_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;

async fn guarded_webhook_post(url: &str, body: Vec<u8>) -> Result<u16, String> {
    let response = ryu_egress::guarded_request(
        ryu_egress::GuardedRequest {
            method: "POST".to_owned(),
            url: url.to_owned(),
            headers: vec![("content-type".to_owned(), "application/json".to_owned())],
            body: Some(body),
        },
        ryu_egress::GuardedFetchPolicy {
            allow_http: false,
            max_body_bytes: MAX_WEBHOOK_RESPONSE_BYTES,
            max_redirect_hops: 0,
            timeout: std::time::Duration::from_secs(15),
        },
    )
    .await?;
    Ok(response.status)
}

/// The part of a webhook URL that is safe to log: scheme and host. A Slack or
/// Discord incoming-webhook URL carries its credential in the path, so the path
/// and query are never logged.
pub fn url_for_log(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(parsed) => format!(
            "{}://{}/…",
            parsed.scheme(),
            parsed.host_str().unwrap_or("<no host>")
        ),
        Err(_) => "<invalid url>".to_owned(),
    }
}

/// A notification destination (per-monitor or node-level policy-alert channel).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NotifyTarget {
    /// Generic JSON POST. Works with Slack/Discord *incoming webhooks* and any
    /// HTTP endpoint. We send both a Slack/Discord-friendly `text`/`content`
    /// field and the structured alert so one URL fits most services.
    Webhook { url: String },
    /// Direct Telegram Bot API send (`sendMessage`).
    Telegram { bot_token: String, chat_id: String },
    /// A specific Expo push token (in addition to globally-registered devices).
    ExpoPush { token: String },
    /// A single email recipient. Unlike the self-contained Webhook/Telegram
    /// targets, this carries the recipient ONLY: the SMTP transport is a shared
    /// node resource resolved once at the Core call site (`ryu_email_send`), not
    /// stored per-target, so the plaintext-secret surface is not multiplied.
    Email { to: String },
}

/// Node-level alert delivery targets (self-host): the fan-out channels
/// (webhook / Telegram / Expo push) + email recipients that policy alerts
/// deliver to. Distinct from per-monitor targets, which are scoped to one
/// watched site. Persisted in the Core notify store (`alert_delivery` table).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AlertDeliveryTargets {
    #[serde(default)]
    pub targets: Vec<NotifyTarget>,
    #[serde(default)]
    pub emails: Vec<String>,
}

// ---- 2xx-gated primitives (workflow ChannelSend surfaces failures) ---------

/// Post a plain-text message to a Slack/Discord/generic incoming webhook. Sends
/// both `text` (Slack) and `content` (Discord) so one URL fits either service.
/// Returns `Ok(())` only on a 2xx response.
pub async fn send_webhook_text(
    _http: &reqwest::Client,
    url: &str,
    text: &str,
) -> Result<(), String> {
    let body = json!({ "text": text, "content": text });
    let status = guarded_webhook_post(url, serde_json::to_vec(&body).map_err(|e| e.to_string())?)
        .await
        .map_err(|e| format!("webhook send failed: {e}"))?;
    if (200..300).contains(&status) {
        Ok(())
    } else {
        Err(format!("webhook returned HTTP {status}"))
    }
}

/// Send a plain-text message via the Telegram Bot API (`sendMessage`). Returns
/// `Ok(())` only on a 2xx so a workflow node can surface a failed send.
///
/// The Bot API URL carries the bot token in its path, so transport errors are
/// stripped of their URL (`without_url`) before formatting: the returned string
/// becomes a workflow node error and a Gateway exec-audit row.
pub async fn send_telegram_text(
    http: &reqwest::Client,
    bot_token: &str,
    chat_id: &str,
    text: &str,
) -> Result<(), String> {
    let api = format!("https://api.telegram.org/bot{bot_token}/sendMessage");
    let resp = http
        .post(&api)
        .json(&json!({ "chat_id": chat_id, "text": text }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        // `without_url`: the request URL embeds the bot token.
        .map_err(|e| format!("telegram send failed: {}", e.without_url()))?;
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("telegram returned HTTP {status}"))
    }
}

// ---- best-effort alert sends (fan-out; errors are logged, never propagated) --

/// Best-effort webhook alert send: `{text, content, alert}` so both Slack/Discord
/// framing and the structured payload ride one URL. `alert` is the full JSON
/// carrier (embedded under `"alert"`).
pub async fn send_webhook_alert(
    _http: &reqwest::Client,
    url: &str,
    title: &str,
    message: &str,
    alert: &serde_json::Value,
) {
    let body = json!({
        "text": format!("{title}\n{message}"),
        "content": format!("{title}\n{message}"),
        "alert": alert,
    });
    // An incoming-webhook URL is itself a bearer credential; log its origin only.
    let target = webhook_log_origin(url);
    match guarded_webhook_post(url, serde_json::to_vec(&body).unwrap_or_default()).await {
        Ok(status) if (200..300).contains(&status) => {}
        Ok(status) => tracing::warn!("notify: webhook to {target} returned HTTP {status}"),
        Err(error) => tracing::warn!("notify: webhook to {target} failed: {error}"),
    }
}

/// `scheme://host` of a webhook URL, safe to log without its secret path.
fn webhook_log_origin(url: &str) -> String {
    reqwest::Url::parse(url.trim())
        .ok()
        .and_then(|parsed| {
            parsed
                .host_str()
                .map(|host| format!("{}://{host}", parsed.scheme()))
        })
        .unwrap_or_else(|| "<invalid url>".to_owned())
}

/// Best-effort Telegram alert send (with a bell emoji prefix).
pub async fn send_telegram_alert(
    http: &reqwest::Client,
    bot_token: &str,
    chat_id: &str,
    title: &str,
    message: &str,
) {
    let api = format!("https://api.telegram.org/bot{bot_token}/sendMessage");
    let text = format!("\u{1f514} {title}\n{message}");
    let result = http
        .post(&api)
        .json(&json!({ "chat_id": chat_id, "text": text }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;
    if let Err(e) = result {
        // `without_url`: the request URL carries the bot token.
        tracing::warn!("notify: telegram alert failed: {}", e.without_url());
    }
}

/// Presentation extras for [`push_expo_rich_message`].
#[derive(Debug, Clone, Default)]
pub struct ExpoRichContent<'a> {
    /// Android notification channel the device created for this kind of alert.
    pub channel_id: Option<&'a str>,
    /// Picture for the notification: Android shows it as the large icon; iOS
    /// needs the app's notification service extension, which is why
    /// `mutableContent` is set whenever an image is present.
    pub image_url: Option<&'a str>,
    /// Groups related notifications (iOS `threadId`, Android tag grouping).
    pub thread_id: Option<&'a str>,
}

/// Build one Expo push message. Split out so the wire shape is unit-tested.
pub fn expo_rich_message(
    token: &str,
    title: &str,
    body: &str,
    data: &serde_json::Value,
    rich: &ExpoRichContent<'_>,
) -> serde_json::Value {
    let mut message = json!({
        "to": token,
        "title": title,
        "body": body,
        "sound": "default",
        "data": data,
    });
    if let Some(object) = message.as_object_mut() {
        if let Some(channel_id) = rich.channel_id {
            object.insert("channelId".into(), json!(channel_id));
        }
        if let Some(thread_id) = rich.thread_id {
            object.insert("threadId".into(), json!(thread_id));
        }
        if let Some(image_url) = rich.image_url {
            object.insert("richContent".into(), json!({ "image": image_url }));
            object.insert("mutableContent".into(), json!(true));
        }
    }
    message
}

/// Like [`push_expo_message`], with an image, channel and thread. Best-effort:
/// a failure is logged, never propagated.
pub async fn push_expo_rich_message(
    http: &reqwest::Client,
    tokens: &[String],
    title: &str,
    body: &str,
    data: serde_json::Value,
    rich: ExpoRichContent<'_>,
) {
    if tokens.is_empty() {
        return;
    }
    let messages: Vec<_> = tokens
        .iter()
        .map(|token| expo_rich_message(token, title, body, &data, &rich))
        .collect();
    let result = http
        .post(EXPO_PUSH_URL)
        .json(&messages)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;
    if let Err(e) = result {
        tracing::warn!("notify: expo push message failed: {e}");
    }
}

/// Send a plain title/body push to a set of Expo tokens. Best-effort: a failure
/// is logged, never propagated. `data` rides through to the device payload.
pub async fn push_expo_message(
    http: &reqwest::Client,
    tokens: &[String],
    title: &str,
    body: &str,
    data: serde_json::Value,
) {
    if tokens.is_empty() {
        return;
    }
    let messages: Vec<_> = tokens
        .iter()
        .map(|t| {
            json!({
                "to": t,
                "title": title,
                "body": body,
                "sound": "default",
                "data": data,
            })
        })
        .collect();
    let result = http
        .post(EXPO_PUSH_URL)
        .json(&messages)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;
    if let Err(e) = result {
        tracing::warn!("notify: expo push message failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Bytes, extract::State, http::StatusCode, http::Uri, Router};
    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex};

    #[test]
    fn webhook_urls_are_logged_without_their_credential_path() {
        assert_eq!(
            url_for_log("https://hooks.slack.com/services/T000/B000/secret-part?x=1"),
            "https://hooks.slack.com/…"
        );
        assert_eq!(url_for_log("not a url"), "<invalid url>");
    }

    #[tokio::test]
    async fn telegram_send_errors_never_carry_the_bot_token() {
        // An unroutable proxy forces a transport error whose Display would
        // otherwise include the request URL (and so the token).
        let http = reqwest::Client::builder()
            .proxy(reqwest::Proxy::all("http://127.0.0.1:9").unwrap())
            .build()
            .unwrap();
        let error = send_telegram_text(&http, "123456:token-must-not-leak", "1", "hi")
            .await
            .unwrap_err();
        assert!(!error.contains("token-must-not-leak"), "{error}");
    }

    // ---- serde: wire shape of the target enum -----------------------------

    #[test]
    fn notify_target_tag_is_snake_case_kind() {
        // The `#[serde(tag = "kind", rename_all = "snake_case")]` contract is
        // what the Core store + monitors engine persist and exchange; a silent
        // rename would break every stored channel target.
        let cases = [
            (
                NotifyTarget::Webhook {
                    url: "https://hooks.example/x".into(),
                },
                "webhook",
            ),
            (
                NotifyTarget::Telegram {
                    bot_token: "abc".into(),
                    chat_id: "42".into(),
                },
                "telegram",
            ),
            (
                NotifyTarget::ExpoPush {
                    token: "ExponentPushToken[y]".into(),
                },
                "expo_push",
            ),
            (
                NotifyTarget::Email {
                    to: "a@b.co".into(),
                },
                "email",
            ),
        ];
        for (target, expected_kind) in cases {
            let v = serde_json::to_value(&target).unwrap();
            assert_eq!(
                v.get("kind").and_then(|k| k.as_str()),
                Some(expected_kind),
                "wrong kind tag for {target:?}"
            );
            // Round-trips back to an identical value.
            let back: NotifyTarget = serde_json::from_value(v).unwrap();
            assert_eq!(back, target);
        }
    }

    #[test]
    fn notify_target_deserializes_from_tagged_json() {
        let t: NotifyTarget =
            serde_json::from_str(r#"{"kind":"telegram","bot_token":"T","chat_id":"C"}"#).unwrap();
        assert_eq!(
            t,
            NotifyTarget::Telegram {
                bot_token: "T".into(),
                chat_id: "C".into(),
            }
        );
    }

    #[test]
    fn notify_target_unknown_kind_is_rejected() {
        let r: Result<NotifyTarget, _> = serde_json::from_str(r#"{"kind":"carrier_pigeon"}"#);
        assert!(r.is_err(), "unknown channel kind must not deserialize");
    }

    #[test]
    fn alert_delivery_targets_default_is_empty() {
        let d = AlertDeliveryTargets::default();
        assert!(d.targets.is_empty());
        assert!(d.emails.is_empty());
    }

    #[test]
    fn alert_delivery_targets_fills_missing_fields() {
        // Both fields are `#[serde(default)]`: an empty object and a partial
        // object must both parse, so an older stored row without one field
        // still loads.
        let empty: AlertDeliveryTargets = serde_json::from_str("{}").unwrap();
        assert!(empty.targets.is_empty() && empty.emails.is_empty());

        let partial: AlertDeliveryTargets =
            serde_json::from_str(r#"{"emails":["ops@x.io"]}"#).unwrap();
        assert!(partial.targets.is_empty());
        assert_eq!(partial.emails, vec!["ops@x.io".to_string()]);

        let full: AlertDeliveryTargets = serde_json::from_str(
            r#"{"targets":[{"kind":"webhook","url":"https://h/x"}],"emails":["a@b.co"]}"#,
        )
        .unwrap();
        assert_eq!(full.targets.len(), 1);
        assert_eq!(
            full.targets[0],
            NotifyTarget::Webhook {
                url: "https://h/x".into()
            }
        );
    }

    // ---- HTTP test harness -------------------------------------------------

    #[derive(Clone)]
    struct Recorded {
        path: String,
        body: serde_json::Value,
    }

    #[derive(Clone)]
    struct AppState {
        recorded: Arc<Mutex<Vec<Recorded>>>,
        status: StatusCode,
    }

    async fn record_handler(State(st): State<AppState>, uri: Uri, body: Bytes) -> StatusCode {
        let json = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
        st.recorded.lock().unwrap().push(Recorded {
            path: uri.path().to_string(),
            body: json,
        });
        st.status
    }

    /// Spawn a loopback server on an ephemeral port that records every request
    /// and answers with `status`. Mirrors `crates/core/downloads`'s test idiom.
    async fn spawn_server(status: StatusCode) -> (SocketAddr, Arc<Mutex<Vec<Recorded>>>) {
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let state = AppState {
            recorded: recorded.clone(),
            status,
        };
        let app = Router::new().fallback(record_handler).with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (addr, recorded)
    }

    /// A bound-then-freed local address: connecting to it yields an immediate
    /// connection-refused (no network, no DNS), which drives the send-failure
    /// error branches deterministically.
    fn dead_addr() -> SocketAddr {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let a = l.local_addr().unwrap();
        drop(l);
        a
    }

    // ---- send_webhook_text: local destinations are denied before dispatch --

    #[tokio::test]
    async fn webhook_text_rejects_local_destination_before_dispatch() {
        let (addr, recorded) = spawn_server(StatusCode::OK).await;
        let http = reqwest::Client::new();
        let url = format!("http://{addr}/hook");
        let out = send_webhook_text(&http, &url, "hello world").await;
        assert!(out.is_err(), "local webhook destinations must be denied");

        let rec = recorded.lock().unwrap();
        assert!(
            rec.is_empty(),
            "denied destinations must not receive a request"
        );
    }

    #[tokio::test]
    async fn webhook_text_err_on_local_destination_before_status_check() {
        let (addr, _rec) = spawn_server(StatusCode::INTERNAL_SERVER_ERROR).await;
        let http = reqwest::Client::new();
        let url = format!("http://{addr}/hook");
        let err = send_webhook_text(&http, &url, "x").await.unwrap_err();
        assert!(
            err.contains("webhook send failed"),
            "unexpected error: {err}"
        );
    }

    #[tokio::test]
    async fn webhook_text_err_on_connection_refused() {
        let http = reqwest::Client::new();
        let url = format!("http://{}/hook", dead_addr());
        let err = send_webhook_text(&http, &url, "x").await.unwrap_err();
        assert!(
            err.contains("webhook send failed"),
            "unexpected error: {err}"
        );
    }

    // ---- send_telegram_text: error branch (https URL is hardcoded) ---------

    #[tokio::test]
    async fn telegram_text_err_on_connection_refused() {
        // Disable ambient proxies so the DNS override actually keeps this
        // request on loopback instead of reaching a proxy's Telegram upstream.
        // (The 2xx/else status branch
        // needs a real TLS response — see the crate-level test notes.)
        let http = reqwest::Client::builder()
            .no_proxy()
            .resolve("api.telegram.org", dead_addr())
            .build()
            .unwrap();
        let err = send_telegram_text(&http, "SECRETBOTTOKEN", "CHAT", "hi")
            .await
            .unwrap_err();
        assert!(
            err.contains("telegram send failed"),
            "unexpected error: {err}"
        );
        assert!(
            !err.contains("SECRETBOTTOKEN"),
            "bot token leaked into error: {err}"
        );
    }

    #[test]
    fn webhook_log_origin_drops_the_secret_path() {
        assert_eq!(
            webhook_log_origin("https://hooks.slack.com/services/T000/B000/SECRET"),
            "https://hooks.slack.com"
        );
        assert_eq!(webhook_log_origin("not a url"), "<invalid url>");
    }

    #[tokio::test]
    async fn telegram_text_error_does_not_leak_bot_token() {
        // The bot token rides in the Bot API URL path, and reqwest's transport
        // errors print "for url (...)". The returned string becomes a workflow
        // node error and a Gateway exec-audit row, so it must not carry the
        // token or the token-bearing URL.
        let http = reqwest::Client::builder()
            .no_proxy()
            .resolve("api.telegram.org", dead_addr())
            .build()
            .unwrap();
        let token = "123456:AAsecret-bot-token";
        let err = send_telegram_text(&http, token, "CHAT", "hi")
            .await
            .unwrap_err();
        assert!(
            err.contains("telegram send failed"),
            "unexpected error: {err}"
        );
        assert!(!err.contains(token), "bot token leaked into error: {err}");
        assert!(
            !err.contains("api.telegram.org/bot"),
            "token-bearing URL leaked into error: {err}"
        );
    }

    // ---- best-effort alert sends: shape + non-panic on failure ------------

    #[tokio::test]
    async fn webhook_alert_rejects_local_destination() {
        let (addr, recorded) = spawn_server(StatusCode::OK).await;
        let http = reqwest::Client::new();
        let url = format!("http://{addr}/hook");
        let alert = json!({ "severity": "high", "id": 7 });
        send_webhook_alert(&http, &url, "Down!", "site is 500ing", &alert).await;

        let rec = recorded.lock().unwrap();
        assert_eq!(rec.len(), 0);
        assert!(
            rec.is_empty(),
            "denied destinations must not receive a request"
        );
    }

    #[tokio::test]
    async fn webhook_alert_is_best_effort_on_failure() {
        // Non-2xx and connection-refused must both be swallowed (no panic, no
        // return value) — fan-out never fails a caller.
        let (addr, _rec) = spawn_server(StatusCode::BAD_GATEWAY).await;
        let http = reqwest::Client::new();
        send_webhook_alert(&http, &format!("http://{addr}/hook"), "t", "m", &json!({})).await;
        send_webhook_alert(
            &http,
            &format!("http://{}/hook", dead_addr()),
            "t",
            "m",
            &json!({}),
        )
        .await;
    }

    #[tokio::test]
    async fn telegram_alert_is_best_effort_on_failure() {
        let http = reqwest::Client::builder()
            .no_proxy()
            .resolve("api.telegram.org", dead_addr())
            .build()
            .unwrap();
        // Must not panic even though the send fails.
        send_telegram_alert(&http, "BOT", "CHAT", "Title", "body").await;
    }

    // ---- expo_rich_message: wire shape ---------------------------------------
    #[test]
    fn rich_message_adds_image_channel_and_mutable_content() {
        let message = expo_rich_message(
            "tok",
            "Nova",
            "Finished",
            &json!({ "kind": "agent-done" }),
            &ExpoRichContent {
                channel_id: Some("agent-done"),
                image_url: Some("https://example.com/a.png"),
                thread_id: Some("conv-1"),
            },
        );
        assert_eq!(message["richContent"]["image"], "https://example.com/a.png");
        assert_eq!(message["mutableContent"], true);
        assert_eq!(message["channelId"], "agent-done");
        assert_eq!(message["threadId"], "conv-1");
        assert_eq!(message["data"]["kind"], "agent-done");

        let plain = expo_rich_message("tok", "t", "b", &json!({}), &ExpoRichContent::default());
        assert!(plain.get("richContent").is_none());
        assert!(plain.get("mutableContent").is_none());
        assert!(plain.get("channelId").is_none());
    }

    // ---- push_expo_message: empty short-circuit + failure path -------------

    #[tokio::test]
    async fn expo_push_empty_tokens_makes_no_request() {
        let (addr, recorded) = spawn_server(StatusCode::OK).await;
        // Pin exp.host at the recording server so a stray request WOULD be
        // recorded; the empty-token early return means it never is.
        let http = reqwest::Client::builder()
            .no_proxy()
            .resolve("exp.host", addr)
            .build()
            .unwrap();
        push_expo_message(&http, &[], "t", "b", json!({})).await;
        assert!(
            recorded.lock().unwrap().is_empty(),
            "empty token list must short-circuit before any request"
        );
    }

    #[tokio::test]
    async fn expo_push_non_empty_is_best_effort_on_failure() {
        let http = reqwest::Client::builder()
            .no_proxy()
            .resolve("exp.host", dead_addr())
            .build()
            .unwrap();
        // Non-empty tokens build the message batch and POST; a refused
        // connection is swallowed (best-effort), no panic.
        push_expo_message(
            &http,
            &["ExponentPushToken[abc]".to_string()],
            "Title",
            "Body",
            json!({ "url": "/x" }),
        )
        .await;
    }
}
