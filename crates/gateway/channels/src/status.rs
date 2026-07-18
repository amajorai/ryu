//! Channel liveness reporting.
//!
//! A running bot has no persisted "connected right now" flag, so each channel
//! loop pushes a heartbeat to the control plane (`POST /channels/gateway/status`)
//! on connect, on every successful poll, and on error. The control plane keeps
//! the latest heartbeat in memory and folds a stale one to `offline`, so the
//! desktop can paint a live dot next to the bound agent.
//!
//! Reporting is best-effort: a failed heartbeat is logged and swallowed so it
//! never disturbs the bot's message loop. Bots configured via env (rather than
//! the control-plane store) have no channel id and so get no reporter — they
//! simply show as `unknown` in the UI, which is honest.

use std::time::Duration;

use tracing::{debug, warn};

/// Timeout for a single heartbeat POST. Short so a slow control plane never
/// stalls the bot's poll loop.
const REPORT_TIMEOUT: Duration = Duration::from_secs(5);

/// How often the background ticker re-asserts `online` for transports that block
/// without a natural poll cadence (WhatsApp's webhook server, an idle Slack
/// socket). Comfortably inside the control plane's staleness window.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

/// Reports one channel's liveness to the control plane.
#[derive(Clone)]
pub struct StatusReporter {
    http: reqwest::Client,
    /// Fully-qualified `{base}/channels/gateway/status` URL.
    url: String,
    gateway_key: String,
    channel_id: String,
}

impl StatusReporter {
    /// Build a reporter when the control plane is configured (a gateway key and
    /// base URL) and the channel carries a store id. Returns `None` otherwise,
    /// in which case the channel simply does not report.
    ///
    /// Takes the control-plane `base_url` + `gateway_key` as primitives (the
    /// gateway config shell owns `ControlPlaneConfig`) so this crate carries no
    /// gateway-config dependency.
    pub fn new(
        http: reqwest::Client,
        base_url: &str,
        gateway_key: Option<String>,
        channel_id: Option<String>,
    ) -> Option<Self> {
        let channel_id = channel_id?;
        let gateway_key = gateway_key?;
        let base = base_url.trim_end_matches('/');
        if base.is_empty() {
            return None;
        }
        Some(Self {
            http,
            url: format!("{base}/channels/gateway/status"),
            gateway_key,
            channel_id,
        })
    }

    /// Post a heartbeat. Best-effort: any failure is logged, never propagated.
    async fn report(&self, state: &str, detail: Option<&str>) {
        let body = serde_json::json!({
            "id": self.channel_id,
            "state": state,
            "detail": detail,
        });
        match self
            .http
            .post(&self.url)
            .header("x-gateway-key", &self.gateway_key)
            .json(&body)
            .timeout(REPORT_TIMEOUT)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                debug!(channel_id = %self.channel_id, state, "reported channel status");
            }
            Ok(resp) => {
                warn!(
                    channel_id = %self.channel_id,
                    status = %resp.status(),
                    "channel status report returned non-2xx"
                );
            }
            Err(err) => {
                warn!(channel_id = %self.channel_id, %err, "channel status report failed");
            }
        }
    }

    /// The bot is registered and about to connect (shown as amber).
    pub async fn connecting(&self) {
        self.report("connecting", None).await;
    }

    /// The bot polled successfully — it is live (shown as green).
    pub async fn online(&self) {
        self.report("online", None).await;
    }

    /// The bot's transport errored (shown as amber with `detail`).
    pub async fn error(&self, detail: &str) {
        self.report("error", Some(detail)).await;
    }

    /// Spawn a task that re-asserts `online` every [`HEARTBEAT_INTERVAL`]. Used
    /// by transports that block without a natural poll cadence (WhatsApp's
    /// webhook server). The caller must `abort()` the returned handle when the
    /// transport stops so a dead channel goes stale (→ offline) as intended.
    pub fn spawn_heartbeat(self) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            loop {
                self.online().await;
                tokio::time::sleep(HEARTBEAT_INTERVAL).await;
            }
        })
    }
}
