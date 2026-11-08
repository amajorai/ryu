//! Self-host policy-alert delivery (the Core DELIVERER side).
//!
//! The Gateway DECIDES a budget/firewall policy alert fires and stamps a verdict
//! onto the HTTP response as the `x-ryu-policy-alert` header (base64(json)). Core
//! READS that stamp off the gateway-fronting response and DELIVERS it: dedupe,
//! then fan out over the node's configured alert channels (webhook / Telegram /
//! Expo push + BYO SMTP email) and mirror to SSE for the live desktop.
//!
//! Placement (AGENTS.md §1): the Gateway owns "what is allowed/measured" (it
//! stamps the verdict); Core owns "what runs" — opening the delivery sockets. The
//! Gateway never delivers and never stores; this module is the delivery leg.
//!
//! Best-effort throughout: a bad header is a silent no-op (never a 500), and a
//! failing sink logs and drops so one channel never blocks the others.

use serde::Deserialize;

use ryu_notify::NotifyTarget;

use crate::notify::{self, FanoutAlert, NotifyStore};

/// Re-export of the node-level alert delivery targets, which live in the shared
/// `ryu_notify` crate (persisted in the Core notify store's `alert_delivery`
/// table). Kept here so existing `crate::policy_alerts::AlertDeliveryTargets`
/// references (the desktop alert-delivery card handlers) resolve unchanged.
pub use ryu_notify::AlertDeliveryTargets;

/// The response header the Gateway stamps the policy verdict onto. Must match the
/// gateway writer byte-for-byte (`apps/gateway/src/policy_alert.rs`).
pub const POLICY_ALERT_HEADER: &str = "x-ryu-policy-alert";

/// How long a given `dedupe_key` is suppressed after it fires once. One chat turn
/// with a multi-iteration tool loop re-reads the same stamp on every iteration, so
/// this debounce (plus the atomic claim) is what stops N duplicate deliveries.
const DEDUPE_COOLDOWN_SECS: i64 = 300;

/// The alert tier the Gateway decided (mirror of the gateway `AlertTier`). `Ord`
/// so the semantics stay obvious; only `Warn`/`Fanout`/`Email` ever ride the wire
/// (the gateway builds a stamp only at `>= Warn`), but `Silent` is accepted so a
/// forward-compat gateway never trips the lenient decode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlertTier {
    Silent,
    Warn,
    Fanout,
    Email,
}

/// The wire shape stamped by the Gateway. A lean mirror of the gateway
/// `PolicyAlert` — Core only needs to READ it, so every field is owned + optional
/// defaults keep the decode lenient against a partial stamp.
#[derive(Debug, Clone, Deserialize)]
pub struct PolicyAlert {
    /// `budget` | `session_budget` | `wallet_empty` | `firewall`.
    #[serde(default)]
    pub source: String,
    /// `notify` | `downgrade` | `restrict` | `stop` | `block`.
    #[serde(default)]
    pub enforcement: String,
    pub alert_tier: AlertTier,
    /// `user` | `agent` | `session` | `request`.
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub subject_key: String,
    #[serde(default)]
    pub used: u64,
    #[serde(default)]
    pub limit: u64,
    #[serde(default)]
    pub dedupe_key: String,
    #[serde(default)]
    pub org_id: String,
}

mod text;

impl PolicyAlert {
    /// Build the transient [`FanoutAlert`] this policy alert fans out as. Nothing
    /// is persisted — it is a carrier for the notify fan-out only. `title` and
    /// `message` are the English rendering; `hook_event.i18n` carries the
    /// messages the notify kernel renders per recipient locale.
    fn to_fanout(&self) -> FanoutAlert {
        let kind = format!(
            "policy_{}",
            if self.source.is_empty() {
                "alert"
            } else {
                self.source.as_str()
            }
        );
        let text = self.text();
        let (title, message) = text.render("en");
        let hook_event = serde_json::json!({
            "monitor_id": format!("policy:{}", self.source),
            "monitor_name": title,
            "created_at": chrono::Utc::now().to_rfc3339(),
            "title": title,
            "message": message,
            "kind": kind,
            "i18n": text.to_wire(),
        });
        FanoutAlert {
            title,
            message,
            data: serde_json::json!({ "kind": kind }),
            hook_event,
        }
    }
}

/// Decode a `x-ryu-policy-alert` header value (base64(json)) into a [`PolicyAlert`].
/// Lenient: any decode/parse failure returns `None` so a malformed stamp is
/// skipped, never surfaced as an error.
pub fn from_header(raw: &str) -> Option<PolicyAlert> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .ok()?;
    serde_json::from_slice::<PolicyAlert>(&bytes).ok()
}

/// Read the stamp off a gateway-fronting response head and, when present and
/// parseable, fire-and-forget the delivery. Safe to call on EVERY response that
/// may have been fronted by the gateway (the success head AND the error/402 head):
/// a missing or bad header is a silent no-op, and delivery is spawned so it never
/// blocks the stream.
pub fn dispatch_from_headers(headers: &reqwest::header::HeaderMap) {
    let Some(raw) = headers
        .get(POLICY_ALERT_HEADER)
        .and_then(|v| v.to_str().ok())
    else {
        return;
    };
    let Some(alert) = from_header(raw) else {
        return;
    };
    // Dedupe/delivery need the kernel notify store (dedupe table + delivery
    // targets + the tiered fan-out that wires in BYO SMTP email + notification
    // hooks). Resolve it from the process-global set at startup.
    let Some(store) = crate::notify::global_store() else {
        tracing::warn!("policy_alerts: notify store not ready; dropping alert");
        return;
    };
    tokio::spawn(async move {
        let http = reqwest::Client::new();
        dispatch(alert, http, store).await;
    });
}

/// Deliver a decoded policy alert: dedupe, mirror to SSE, then fan out per tier.
/// Best-effort: sink failures are logged, never propagated.
///
/// Fan-out goes through the kernel [`notify::notify_all`], which wires in both the
/// BYO SMTP email send and the `notification` plugin-hook dispatch in every tier.
pub async fn dispatch(alert: PolicyAlert, http: reqwest::Client, store: NotifyStore) {
    // Atomic dedupe claim (Core-side F1): the same stamp is re-read on every
    // tool-loop iteration, so without an atomic claim a single turn double-delivers.
    if !alert.dedupe_key.is_empty() {
        match store
            .claim_policy_alert(&alert.dedupe_key, DEDUPE_COOLDOWN_SECS)
            .await
        {
            Ok(true) => {}
            // Still in cooldown — a duplicate of an alert we already delivered.
            Ok(false) => return,
            // On a claim error, skip rather than risk an unbounded duplicate storm.
            Err(e) => {
                tracing::warn!("policy_alerts: dedupe claim failed ({e}); skipping delivery");
                return;
            }
        }
    }

    let carrier = alert.to_fanout();

    // Always mirror to SSE for the live desktop (the in-app feed + OS toast).
    let level = match alert.enforcement.as_str() {
        "stop" | "block" => "error",
        "restrict" | "downgrade" => "warning",
        _ => "warning",
    };
    // The toast is drawn by this node's desktop, so it reads the node's language.
    let (toast_title, toast_body) = alert
        .text()
        .render(crate::i18n::locale::node_locale().await);
    crate::events::publish(crate::events::DesktopNotification {
        title: toast_title,
        body: Some(toast_body),
        level: level.to_string(),
        target_user_id: None,
        notification_id: None,
        source_app_id: None,
        link: None,
    });

    let targets = match store.get_alert_delivery().await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("policy_alerts: reading delivery targets failed ({e}); SSE-only");
            AlertDeliveryTargets::default()
        }
    };

    match alert.alert_tier {
        // Warn is the SSE-only tier — no external fan-out.
        AlertTier::Silent | AlertTier::Warn => {}
        // Fanout: webhook / Telegram / Expo push (no email).
        AlertTier::Fanout => {
            notify::notify_all(&http, &store, &targets.targets, &carrier).await;
        }
        // Email (the top tier): deliver to the node's configured alert recipients
        // over the shared BYO SMTP transport (resolved by the kernel notify layer).
        AlertTier::Email => {
            let email_targets: Vec<NotifyTarget> = targets
                .emails
                .iter()
                .map(|to| NotifyTarget::Email { to: to.clone() })
                .collect();
            notify::notify_all(&http, &store, &email_targets, &carrier).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    fn encode(json: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(json.as_bytes())
    }

    #[test]
    fn from_header_round_trips() {
        let json = r#"{
            "source": "budget",
            "enforcement": "stop",
            "alert_tier": "email",
            "scope": "user",
            "subject_key": "u_123",
            "used": 500,
            "limit": 500,
            "dedupe_key": "abc123",
            "org_id": "org_1"
        }"#;
        let alert = from_header(&encode(json)).expect("decodes");
        assert_eq!(alert.source, "budget");
        assert_eq!(alert.alert_tier, AlertTier::Email);
        assert_eq!(alert.used, 500);
        assert_eq!(alert.dedupe_key, "abc123");
    }

    #[test]
    fn from_header_is_lenient() {
        // Not base64.
        assert!(from_header("not base64!!!").is_none());
        // Base64 but not JSON.
        assert!(from_header(&encode("not json")).is_none());
        // Missing the required alert_tier field.
        assert!(from_header(&encode(r#"{"source":"budget"}"#)).is_none());
    }

    #[test]
    fn tier_ordering() {
        assert!(AlertTier::Email > AlertTier::Fanout);
        assert!(AlertTier::Fanout > AlertTier::Warn);
        assert!(AlertTier::Warn > AlertTier::Silent);
    }

    // ── extra coverage ───────────────────────────────────────────────────────

    fn alert(source: &str) -> PolicyAlert {
        // Decode a minimal stamp then override the source, so we exercise the real
        // Deserialize defaults for every unset field.
        let mut a = from_header(&encode(r#"{"alert_tier":"warn"}"#)).unwrap();
        a.source = source.to_string();
        a
    }

    fn title(alert: &PolicyAlert) -> String {
        alert.text().render("en").0
    }

    fn message(alert: &PolicyAlert) -> String {
        alert.text().render("en").1
    }

    #[test]
    fn title_maps_each_known_source() {
        assert_eq!(title(&alert("budget")), "Budget limit reached");
        assert_eq!(
            title(&alert("session_budget")),
            "Session budget limit reached"
        );
        assert_eq!(title(&alert("wallet_empty")), "Wallet balance depleted");
        assert_eq!(title(&alert("firewall")), "Firewall policy triggered");
        // Empty source → generic title; unknown source → labelled fallback.
        assert_eq!(title(&alert("")), "Policy alert");
        assert_eq!(title(&alert("mystery")), "Policy alert: mystery");
    }

    #[test]
    fn message_is_whole_sentences_per_scope_and_enforcement() {
        let mut a = alert("budget");
        a.scope = "user".into();
        a.subject_key = "u_9".into();
        a.enforcement = "stop".into();
        a.used = 5;
        a.limit = 10;
        assert_eq!(
            message(&a),
            "Used 5 of 10 for user u_9. Action: requests were stopped."
        );

        // Large numbers are grouped for the reader's locale.
        a.used = 12_500;
        a.limit = 10_000;
        a.enforcement = String::new();
        assert_eq!(message(&a), "Used 12,500 of 10,000 for user u_9.");
        let (_, de) = a.text().render("de");
        assert!(de.contains("12.500") && de.contains("10.000"), "{de}");

        // No limit → the "Triggered for" shape; no subject_key → the scope alone.
        let mut b = alert("firewall");
        b.scope = "request".into();
        b.limit = 0;
        assert_eq!(message(&b), "Triggered for this request.");

        // An unknown scope or enforcement is shown as the Gateway named it.
        b.scope = "tenant".into();
        b.subject_key = "t1".into();
        b.enforcement = "quarantine".into();
        assert_eq!(
            message(&b),
            "Triggered for tenant t1. Action taken: quarantine."
        );
        b.scope = String::new();
        b.subject_key = String::new();
        b.enforcement = String::new();
        assert_eq!(message(&b), "Policy triggered.");
    }

    #[test]
    fn localized_title_and_sentence_join_follow_the_locale() {
        let mut a = alert("budget");
        a.scope = "agent".into();
        a.enforcement = "block".into();
        a.used = 3;
        a.limit = 2;
        let (title, ja) = a.text().render("ja");
        let (_, en) = a.text().render("en");
        // Each sentence is its own message, joined per locale: translated
        // Japanese runs on without a space, English that is not translated
        // yet keeps one, so the body is never two sentences glued together.
        assert!(!ja.contains(".A"), "{ja}");
        assert!(!title.is_empty() && !en.is_empty());
    }

    #[test]
    fn to_fanout_derives_kind_and_carries_title_message() {
        let carrier = alert("budget").to_fanout();
        assert_eq!(carrier.title, "Budget limit reached");
        assert_eq!(carrier.hook_event["title"], "Budget limit reached");
        // The localizable form rides along for the notify kernel.
        let text =
            crate::i18n::AlertText::from_wire(&carrier.hook_event["i18n"]).expect("i18n parses");
        assert_eq!(text.render("en").0, carrier.title);
        assert_eq!(carrier.data["kind"], "policy_budget");
        assert_eq!(carrier.hook_event["kind"], "policy_budget");
        assert_eq!(carrier.hook_event["monitor_id"], "policy:budget");

        // Empty source → the generic "policy_alert" kind.
        let generic = alert("").to_fanout();
        assert_eq!(generic.data["kind"], "policy_alert");
    }

    #[test]
    fn from_header_defaults_numeric_and_optional_fields_to_zero() {
        // Only alert_tier is required; used/limit/org_id default.
        let a = from_header(&encode(r#"{"alert_tier":"fanout","source":"budget"}"#)).unwrap();
        assert_eq!(a.used, 0);
        assert_eq!(a.limit, 0);
        assert_eq!(a.enforcement, "");
        assert_eq!(a.dedupe_key, "");
        assert_eq!(a.alert_tier, AlertTier::Fanout);
    }

    #[test]
    fn alert_tier_snake_case_all_variants() {
        for (raw, want) in [
            ("silent", AlertTier::Silent),
            ("warn", AlertTier::Warn),
            ("fanout", AlertTier::Fanout),
            ("email", AlertTier::Email),
        ] {
            let json = format!(r#"{{"alert_tier":"{raw}"}}"#);
            assert_eq!(from_header(&encode(&json)).unwrap().alert_tier, want);
        }
        // An unknown tier fails the lenient decode (returns None), never panics.
        assert!(from_header(&encode(r#"{"alert_tier":"nuclear"}"#)).is_none());
    }
}
