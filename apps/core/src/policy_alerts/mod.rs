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

use crate::monitors::notify::{self, NotifyTarget};
use crate::monitors::store::MonitorStore;
use crate::monitors::Alert;

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

impl PolicyAlert {
    /// A human-readable alert title for the notification surfaces.
    fn title(&self) -> String {
        match self.source.as_str() {
            "budget" => "Budget limit reached".to_string(),
            "session_budget" => "Session budget limit reached".to_string(),
            "wallet_empty" => "Wallet balance depleted".to_string(),
            "firewall" => "Firewall policy triggered".to_string(),
            other if other.is_empty() => "Policy alert".to_string(),
            other => format!("Policy alert: {other}"),
        }
    }

    /// A human-readable alert body.
    fn message(&self) -> String {
        let scope = if self.subject_key.is_empty() {
            self.scope.clone()
        } else {
            format!("{} {}", self.scope, self.subject_key)
        };
        let enforcement = if self.enforcement.is_empty() {
            String::new()
        } else {
            format!(" Enforcement: {}.", self.enforcement)
        };
        if self.limit > 0 {
            format!(
                "Used {} of {} ({}).{}",
                self.used,
                self.limit,
                scope.trim(),
                enforcement
            )
        } else {
            format!("Triggered for {}.{}", scope.trim(), enforcement)
        }
    }

    /// Build the in-memory monitors [`Alert`] this policy alert fans out as. This
    /// alert is NEVER persisted to the monitors table — it is a transient carrier
    /// for the notify fan-out only.
    fn to_alert(&self) -> Alert {
        Alert {
            id: 0,
            monitor_id: format!("policy:{}", self.source),
            monitor_name: self.title(),
            created_at: chrono::Utc::now().to_rfc3339(),
            title: self.title(),
            message: self.message(),
            kind: format!(
                "policy_{}",
                if self.source.is_empty() {
                    "alert"
                } else {
                    self.source.as_str()
                }
            ),
            acknowledged: false,
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
    // Dedupe/delivery need the monitors store (dedupe table + delivery targets).
    // Resolve it from the process-global engine set unconditionally at startup.
    let Some(engine) = crate::monitors::global_engine() else {
        tracing::warn!("policy_alerts: monitor engine not ready; dropping alert");
        return;
    };
    let store = engine.store.clone();
    tokio::spawn(async move {
        let http = reqwest::Client::new();
        dispatch(alert, http, store).await;
    });
}

/// Deliver a decoded policy alert: dedupe, mirror to SSE, then fan out per tier.
/// Best-effort: sink failures are logged, never propagated.
pub async fn dispatch(alert: PolicyAlert, http: reqwest::Client, store: MonitorStore) {
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

    let carrier = alert.to_alert();

    // Always mirror to SSE for the live desktop (the in-app feed + OS toast).
    let level = match alert.enforcement.as_str() {
        "stop" | "block" => "error",
        "restrict" | "downgrade" => "warning",
        _ => "warning",
    };
    crate::events::publish(crate::events::DesktopNotification {
        title: carrier.title.clone(),
        body: Some(carrier.message.clone()),
        level: level.to_string(),
        target_user_id: None,
        notification_id: None,
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
            notify::notify_all(&http, &store, &targets.targets, &carrier, None).await;
        }
        // Email (the top tier): deliver to the node's configured alert recipients
        // over the shared BYO SMTP transport, resolved once here.
        AlertTier::Email => {
            let email_targets: Vec<NotifyTarget> = targets
                .emails
                .iter()
                .map(|to| NotifyTarget::Email { to: to.clone() })
                .collect();
            let cfg = crate::email::resolve_transport();
            notify::notify_all(&http, &store, &email_targets, &carrier, cfg.as_ref()).await;
        }
    }
}

/// Node-level alert delivery targets (self-host). Read by [`dispatch`]; written by
/// the desktop alert-delivery card via the store accessor. Emails are the
/// email-tier recipients; `targets` are the fan-out (webhook / Telegram / Expo)
/// channels.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct AlertDeliveryTargets {
    #[serde(default)]
    pub targets: Vec<NotifyTarget>,
    #[serde(default)]
    pub emails: Vec<String>,
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
}
