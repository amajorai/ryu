//! Website monitoring (price / content / stock / keyword / uptime).
//!
//! A **monitor** watches a URL on a schedule and alerts when something changes:
//! the site goes down, a keyword appears/disappears, the page content changes, a
//! price crosses a threshold, or an item comes in/out of stock. Each check
//! fetches the page (plain HTTP or the Spider crawler), extracts the watched
//! signal, and compares it against the **latest snapshot** — the cross-run state
//! that makes a monitor more than a one-shot fetch.
//!
//! Architecture (Core vs Gateway): a monitor decides *what runs and when*, so it
//! is Core. It reuses the existing scheduler ([`crate::scheduler`]) for timing —
//! each monitor is backed by a `JobTarget::Monitor` scheduled job — and the MCP
//! registry for the Spider fetch backend. Nothing is hardcoded: the check type
//! and the fetch backend are both extensible enums routed through one engine.
//!
//! Notifications fan out via [`notify`]: every alert is stored + broadcast over
//! SSE (desktop in-app + OS toast), pushed to registered mobile devices (Expo),
//! and sent to any per-monitor webhook / Telegram targets.

pub mod notify;
pub mod store;

use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::sidecar::mcp::McpRegistry;
use notify::NotifyTarget;
use store::MonitorStore;

fn default_true() -> bool {
    true
}

/// Process-global monitor engine, set once at startup from `main.rs`.
///
/// The scheduler ([`crate::scheduler`]) runs as a state-free background loop and
/// the workflow executor is a free function — neither holds a `ServerState`. A
/// monitor check needs the store + the MCP registry, so the engine is published
/// here once and read by `JobTarget::Monitor` when a scheduled job fires.
static ENGINE: std::sync::OnceLock<MonitorEngine> = std::sync::OnceLock::new();

/// Publish the global engine. Idempotent: a second call is ignored.
pub fn set_global_engine(engine: MonitorEngine) {
    let _ = ENGINE.set(engine);
}

/// The global engine, if it has been published.
pub fn global_engine() -> Option<&'static MonitorEngine> {
    ENGINE.get()
}

/// Where a monitor fetches the page from.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum FetchBackend {
    /// A plain HTTP GET via reqwest (fast; no JS rendering).
    #[default]
    Http,
    /// The Spider crawler (`spider__crawl`), for sites that need a real crawl.
    Spider,
    /// AI browser (JS rendering). Not yet integrated — returns a clear error so
    /// the surface exists without pretending to work.
    Agentbrowser,
}

/// How a numeric (price/quantity) value is compared against the baseline.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum NumComparator {
    /// Alert on any change in the value.
    #[default]
    Changed,
    /// Alert when the value drops below `threshold`.
    LessThan,
    /// Alert when the value rises above `threshold`.
    GreaterThan,
    /// Alert when the value drops by at least `threshold` percent.
    DropsByPct,
    /// Alert when the value rises by at least `threshold` percent.
    RisesByPct,
}

/// The kind of check a monitor runs, plus its configuration. This enum is the
/// extensible check-type registry — adding a type is a new variant + a match arm.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CheckType {
    /// Is the site reachable? `expect_status` (empty = any 2xx/3xx is "up")
    /// constrains which HTTP codes count as healthy.
    Uptime {
        #[serde(default)]
        expect_status: Vec<u16>,
    },
    /// Does a keyword / regex appear (or not) in the page text?
    Keyword {
        pattern: String,
        #[serde(default)]
        is_regex: bool,
        #[serde(default)]
        case_sensitive: bool,
        /// Alert when the keyword becomes present (true) or absent (false).
        #[serde(default = "default_true")]
        alert_when_present: bool,
    },
    /// Alert on any change to the (optionally scoped) page content.
    ContentDiff {
        /// Optional regex (capture group 1) scoping the watched region; without
        /// it the whole normalized page text is hashed.
        #[serde(default)]
        region_regex: Option<String>,
    },
    /// Extract a numeric value (regex capture group 1) and compare it.
    Price {
        /// Regex whose first capture group is the number (e.g. `\$([0-9.,]+)`).
        extract_regex: String,
        #[serde(default)]
        comparator: NumComparator,
        #[serde(default)]
        threshold: Option<f64>,
    },
    /// Stock / inventory by availability phrase (e.g. "Add to cart", "In stock").
    Stock {
        /// Pattern that indicates the item is in stock.
        in_stock_pattern: String,
        #[serde(default)]
        is_regex: bool,
        /// Alert when it becomes in-stock (true) or out-of-stock (false).
        #[serde(default = "default_true")]
        alert_when_in_stock: bool,
    },
}

/// The outcome status persisted on each snapshot.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    /// Checked successfully, no alert condition met.
    Ok,
    /// An alert condition was met this check.
    Triggered,
    /// The check could not complete (fetch/extract failure).
    Error,
}

/// A watched-site definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Monitor {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub backend: FetchBackend,
    pub check: CheckType,
    /// Interval (e.g. `5m`, `1h`) or cron expression — mirrors the scheduler.
    pub interval: String,
    /// When false the backing scheduled job is disabled (kept, not removed).
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Per-monitor notification targets (webhook / Telegram / Expo push).
    #[serde(default)]
    pub notify: Vec<NotifyTarget>,
    pub created_at: String,
    pub updated_at: String,
    // ---- rollup (updated after each check) ----
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_check_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_status: Option<CheckStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_value: Option<String>,
}

/// One recorded check (the comparison baseline for the next run).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub id: i64,
    pub monitor_id: String,
    pub checked_at: String,
    pub status: CheckStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    /// The extracted/derived signal: `up`/`down`, `present`/`absent`, a number, …
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// A change event surfaced to the user and fanned out to channels.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Alert {
    pub id: i64,
    pub monitor_id: String,
    pub monitor_name: String,
    pub created_at: String,
    pub title: String,
    pub message: String,
    /// `uptime_down` | `uptime_up` | `keyword` | `content_change` | `price` | `stock`.
    pub kind: String,
    #[serde(default)]
    pub acknowledged: bool,
}

/// What a single check produced, before persistence.
struct CheckOutcome {
    status: CheckStatus,
    http_status: Option<u16>,
    latency_ms: Option<u64>,
    value: Option<String>,
    content_hash: Option<String>,
    note: Option<String>,
    alert: Option<PendingAlert>,
}

struct PendingAlert {
    title: String,
    message: String,
    kind: &'static str,
}

/// Result of a fetch attempt.
struct Fetched {
    http_status: Option<u16>,
    latency_ms: u64,
    body: String,
}

/// The monitor runtime: holds the store, the MCP registry (for the Spider
/// backend), and an HTTP client. Cheap to clone. Shared by the HTTP API
/// (run-now) and the scheduler (via a process-global handle).
#[derive(Clone)]
pub struct MonitorEngine {
    pub store: MonitorStore,
    mcp: Arc<McpRegistry>,
    http: reqwest::Client,
}

impl MonitorEngine {
    pub fn new(store: MonitorStore, mcp: Arc<McpRegistry>, http: reqwest::Client) -> Self {
        Self { store, mcp, http }
    }

    /// Deliver a user-targeted notification across all three surfaces: the app
    /// inbox (persisted row), the desktop OS toast (user-scoped SSE event), and
    /// the member's mobile devices (Expo push). Returns the inbox row id.
    ///
    /// `ack_required` marks a HITL notification whose acknowledgement resumes a
    /// suspended workflow run (`workflow_run_id` + `node_id` identify the gate).
    /// Every channel is best-effort: a push failure never blocks the inbox write.
    #[allow(clippy::too_many_arguments)]
    pub async fn deliver_user_notification(
        &self,
        user_id: &str,
        title: &str,
        body: &str,
        level: &str,
        workflow_run_id: Option<&str>,
        node_id: Option<&str>,
        ack_required: bool,
    ) -> Result<String, String> {
        let id = format!("ntf_{}", uuid::Uuid::new_v4().simple());
        let row = store::NotificationRow {
            id: id.clone(),
            user_id: Some(user_id.to_owned()),
            title: title.to_owned(),
            body: (!body.is_empty()).then(|| body.to_owned()),
            level: level.to_owned(),
            workflow_run_id: workflow_run_id.map(|s| s.to_owned()),
            node_id: node_id.map(|s| s.to_owned()),
            ack_required,
            acked: false,
            read_at: None,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        // 1. App inbox (persisted — the one channel that must succeed).
        self.store
            .insert_notification(&row)
            .await
            .map_err(|e| format!("failed to persist notification: {e}"))?;

        // 2. Desktop OS toast, scoped to the target member.
        crate::events::publish(crate::events::DesktopNotification {
            title: title.to_owned(),
            body: (!body.is_empty()).then(|| body.to_owned()),
            level: level.to_owned(),
            target_user_id: Some(user_id.to_owned()),
            notification_id: Some(id.clone()),
        });

        // 3. Mobile push to the member's registered devices.
        match self.store.push_tokens_for_user(user_id).await {
            Ok(tokens) => {
                notify::push_expo_message(
                    &self.http,
                    &tokens,
                    title,
                    body,
                    serde_json::json!({
                        "notification_id": id,
                        "workflow_run_id": workflow_run_id,
                        "ack_required": ack_required,
                    }),
                )
                .await;
            }
            Err(e) => tracing::warn!("notify: failed to read push tokens for {user_id}: {e}"),
        }
        Ok(id)
    }

    /// Run one check for `monitor_id`: fetch, evaluate against the latest
    /// snapshot, persist a new snapshot, update the rollup, and fire any alert.
    /// Returns the resulting status.
    pub async fn run_monitor(&self, monitor_id: &str) -> Result<CheckStatus, String> {
        let mut monitor = self
            .store
            .get_monitor(monitor_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("monitor '{monitor_id}' not found"))?;

        let prev = self.store.latest_snapshot(monitor_id).await.ok().flatten();

        let outcome = self.evaluate(&monitor, prev.as_ref()).await;
        let now = chrono::Utc::now().to_rfc3339();

        let snapshot = Snapshot {
            id: 0,
            monitor_id: monitor.id.clone(),
            checked_at: now.clone(),
            status: outcome.status,
            http_status: outcome.http_status,
            latency_ms: outcome.latency_ms,
            value: outcome.value.clone(),
            content_hash: outcome.content_hash.clone(),
            note: outcome.note.clone(),
        };
        if let Err(e) = self.store.insert_snapshot(&snapshot).await {
            tracing::warn!("monitors: failed to persist snapshot for {monitor_id}: {e}");
        }

        monitor.last_check_at = Some(now.clone());
        monitor.last_status = Some(outcome.status);
        monitor.last_value = outcome.value.clone();
        monitor.updated_at = now.clone();
        if let Err(e) = self.store.upsert_monitor(&monitor).await {
            tracing::warn!("monitors: failed to update rollup for {monitor_id}: {e}");
        }

        if let Some(pending) = outcome.alert {
            let alert = Alert {
                id: 0,
                monitor_id: monitor.id.clone(),
                monitor_name: monitor.name.clone(),
                created_at: now,
                title: pending.title,
                message: pending.message,
                kind: pending.kind.to_string(),
                acknowledged: false,
            };
            match self.store.insert_alert(&alert).await {
                Ok(stored) => {
                    // Resolve the shared BYO SMTP transport once per check so an
                    // email notify target (if any) can send; `None` = email
                    // disabled, in which case an email target is skipped.
                    let email_cfg = crate::email::resolve_transport();
                    notify::notify_all(
                        &self.http,
                        &self.store,
                        &monitor.notify,
                        &stored,
                        email_cfg.as_ref(),
                    )
                    .await;
                }
                Err(e) => tracing::warn!("monitors: failed to store alert for {monitor_id}: {e}"),
            }
        }

        Ok(outcome.status)
    }

    /// Fetch the page via the monitor's configured backend.
    async fn fetch(&self, monitor: &Monitor) -> Result<Fetched, String> {
        match monitor.backend {
            FetchBackend::Http => {
                let start = Instant::now();
                let resp = self
                    .http
                    .get(&monitor.url)
                    .timeout(std::time::Duration::from_secs(30))
                    .send()
                    .await
                    .map_err(|e| format!("request failed: {e}"))?;
                let status = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                Ok(Fetched {
                    http_status: Some(status),
                    latency_ms: start.elapsed().as_millis() as u64,
                    body,
                })
            }
            FetchBackend::Spider => {
                let start = Instant::now();
                let args = serde_json::json!({ "url": monitor.url, "depth": 0, "limit": 1 });
                let result = self
                    .mcp
                    .call_tool("spider__crawl", args, None)
                    .await
                    .map_err(|e| format!("spider crawl failed: {e}"))?;
                if result.get("available").and_then(serde_json::Value::as_bool) == Some(false) {
                    let reason = result
                        .get("reason")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("spider unavailable");
                    return Err(reason.to_string());
                }
                let body = spider_body_text(&result);
                Ok(Fetched {
                    http_status: None,
                    latency_ms: start.elapsed().as_millis() as u64,
                    body,
                })
            }
            FetchBackend::Agentbrowser => Err(
                "the agentbrowser backend is not yet integrated; use the http or spider backend"
                    .to_string(),
            ),
        }
    }

    /// Run the check logic against a freshly-fetched page (or a fetch failure).
    async fn evaluate(&self, monitor: &Monitor, prev: Option<&Snapshot>) -> CheckOutcome {
        // Uptime is special: a fetch failure *is* the signal ("down"), so it
        // handles the error itself rather than short-circuiting.
        if let CheckType::Uptime { expect_status } = &monitor.check {
            return eval_uptime(self.fetch(monitor).await, expect_status, prev);
        }

        let fetched = match self.fetch(monitor).await {
            Ok(f) => f,
            Err(e) => {
                return CheckOutcome {
                    status: CheckStatus::Error,
                    http_status: None,
                    latency_ms: None,
                    value: None,
                    content_hash: None,
                    note: Some(e),
                    alert: None,
                }
            }
        };

        match &monitor.check {
            CheckType::Uptime { .. } => unreachable!("handled above"),
            CheckType::Keyword {
                pattern,
                is_regex,
                case_sensitive,
                alert_when_present,
            } => eval_keyword(
                &fetched,
                pattern,
                *is_regex,
                *case_sensitive,
                *alert_when_present,
                prev,
            ),
            CheckType::ContentDiff { region_regex } => {
                eval_content_diff(&fetched, region_regex.as_deref(), prev)
            }
            CheckType::Price {
                extract_regex,
                comparator,
                threshold,
            } => eval_price(&fetched, extract_regex, *comparator, *threshold, prev),
            CheckType::Stock {
                in_stock_pattern,
                is_regex,
                alert_when_in_stock,
            } => eval_stock(
                &fetched,
                in_stock_pattern,
                *is_regex,
                *alert_when_in_stock,
                prev,
            ),
        }
    }
}

// ---- per-type evaluation helpers ------------------------------------------

fn eval_uptime(
    fetched: Result<Fetched, String>,
    expect_status: &[u16],
    prev: Option<&Snapshot>,
) -> CheckOutcome {
    let was_up = prev
        .map(|s| s.value.as_deref() == Some("up"))
        .unwrap_or(true);
    match fetched {
        Ok(f) => {
            let code = f.http_status.unwrap_or(0);
            let up = if expect_status.is_empty() {
                (200..400).contains(&code)
            } else {
                expect_status.contains(&code)
            };
            let alert = if up && !was_up {
                Some(PendingAlert {
                    title: "Site back up".to_string(),
                    message: format!("Recovered (HTTP {code}), {} ms.", f.latency_ms),
                    kind: "uptime_up",
                })
            } else if !up && was_up {
                Some(PendingAlert {
                    title: "Site down".to_string(),
                    message: format!("Unexpected HTTP {code}."),
                    kind: "uptime_down",
                })
            } else {
                None
            };
            CheckOutcome {
                status: if alert.is_some() {
                    CheckStatus::Triggered
                } else {
                    CheckStatus::Ok
                },
                http_status: f.http_status,
                latency_ms: Some(f.latency_ms),
                value: Some(if up { "up" } else { "down" }.to_string()),
                content_hash: None,
                note: None,
                alert,
            }
        }
        Err(e) => {
            let alert = if was_up {
                Some(PendingAlert {
                    title: "Site down".to_string(),
                    message: format!("Request failed: {e}"),
                    kind: "uptime_down",
                })
            } else {
                None
            };
            CheckOutcome {
                status: CheckStatus::Triggered,
                http_status: None,
                latency_ms: None,
                value: Some("down".to_string()),
                content_hash: None,
                note: Some(e),
                alert,
            }
        }
    }
}

fn eval_keyword(
    fetched: &Fetched,
    pattern: &str,
    is_regex: bool,
    case_sensitive: bool,
    alert_when_present: bool,
    prev: Option<&Snapshot>,
) -> CheckOutcome {
    let present = pattern_matches(&fetched.body, pattern, is_regex, case_sensitive);
    let was = prev.map(|s| s.value.as_deref() == Some("present"));
    // Alert on transition *into* the configured alert state.
    let in_alert_state = present == alert_when_present;
    let was_in_alert_state = was.map(|w| w == alert_when_present);
    let alert = if in_alert_state && was_in_alert_state != Some(true) {
        Some(PendingAlert {
            title: format!(
                "Keyword {} \"{}\"",
                if present { "appeared" } else { "disappeared" },
                pattern
            ),
            message: format!("On {}", fetched_label(fetched)),
            kind: "keyword",
        })
    } else {
        None
    };
    CheckOutcome {
        status: alert_status(&alert),
        http_status: fetched.http_status,
        latency_ms: Some(fetched.latency_ms),
        value: Some(if present { "present" } else { "absent" }.to_string()),
        content_hash: None,
        note: None,
        alert,
    }
}

fn eval_content_diff(
    fetched: &Fetched,
    region_regex: Option<&str>,
    prev: Option<&Snapshot>,
) -> CheckOutcome {
    let region = match region_regex {
        Some(re) => first_capture(&fetched.body, re).unwrap_or_default(),
        None => fetched.body.clone(),
    };
    let normalized = normalize_text(&region);
    let hash = sha256_hex(&normalized);
    let prev_hash = prev.and_then(|s| s.content_hash.clone());
    let alert = match prev_hash {
        Some(ph) if ph != hash => Some(PendingAlert {
            title: "Content changed".to_string(),
            message: format!("The watched content on {} changed.", fetched_label(fetched)),
            kind: "content_change",
        }),
        _ => None,
    };
    CheckOutcome {
        status: alert_status(&alert),
        http_status: fetched.http_status,
        latency_ms: Some(fetched.latency_ms),
        value: Some(format!("{} chars", normalized.len())),
        content_hash: Some(hash),
        note: None,
        alert,
    }
}

fn eval_price(
    fetched: &Fetched,
    extract_regex: &str,
    comparator: NumComparator,
    threshold: Option<f64>,
    prev: Option<&Snapshot>,
) -> CheckOutcome {
    let Some(raw) = first_capture(&fetched.body, extract_regex) else {
        return CheckOutcome {
            status: CheckStatus::Error,
            http_status: fetched.http_status,
            latency_ms: Some(fetched.latency_ms),
            value: None,
            content_hash: None,
            note: Some(format!("price regex '{extract_regex}' did not match")),
            alert: None,
        };
    };
    let Some(value) = parse_number(&raw) else {
        return CheckOutcome {
            status: CheckStatus::Error,
            http_status: fetched.http_status,
            latency_ms: Some(fetched.latency_ms),
            value: Some(raw),
            content_hash: None,
            note: Some("could not parse a number from the match".to_string()),
            alert: None,
        };
    };
    let prev_value = prev.and_then(|s| s.value.as_deref()).and_then(parse_number);
    let alert = price_alert(comparator, threshold, value, prev_value).map(|msg| PendingAlert {
        title: "Price change".to_string(),
        message: msg,
        kind: "price",
    });
    CheckOutcome {
        status: alert_status(&alert),
        http_status: fetched.http_status,
        latency_ms: Some(fetched.latency_ms),
        value: Some(format_number(value)),
        content_hash: None,
        note: None,
        alert,
    }
}

fn price_alert(
    comparator: NumComparator,
    threshold: Option<f64>,
    value: f64,
    prev: Option<f64>,
) -> Option<String> {
    match comparator {
        NumComparator::Changed => match prev {
            Some(p) if (p - value).abs() > f64::EPSILON => Some(format!(
                "Changed from {} to {}.",
                format_number(p),
                format_number(value)
            )),
            _ => None,
        },
        NumComparator::LessThan => {
            let t = threshold?;
            let crossed = value < t && prev.map(|p| p >= t).unwrap_or(true);
            crossed.then(|| format!("Now {} (below {}).", format_number(value), format_number(t)))
        }
        NumComparator::GreaterThan => {
            let t = threshold?;
            let crossed = value > t && prev.map(|p| p <= t).unwrap_or(true);
            crossed.then(|| format!("Now {} (above {}).", format_number(value), format_number(t)))
        }
        NumComparator::DropsByPct => {
            let t = threshold?;
            let p = prev?;
            let drop_pct = if p > 0.0 {
                (p - value) / p * 100.0
            } else {
                0.0
            };
            (drop_pct >= t).then(|| {
                format!(
                    "Dropped {:.1}% (from {} to {}).",
                    drop_pct,
                    format_number(p),
                    format_number(value)
                )
            })
        }
        NumComparator::RisesByPct => {
            let t = threshold?;
            let p = prev?;
            let rise_pct = if p > 0.0 {
                (value - p) / p * 100.0
            } else {
                0.0
            };
            (rise_pct >= t).then(|| {
                format!(
                    "Rose {:.1}% (from {} to {}).",
                    rise_pct,
                    format_number(p),
                    format_number(value)
                )
            })
        }
    }
}

fn eval_stock(
    fetched: &Fetched,
    in_stock_pattern: &str,
    is_regex: bool,
    alert_when_in_stock: bool,
    prev: Option<&Snapshot>,
) -> CheckOutcome {
    let in_stock = pattern_matches(&fetched.body, in_stock_pattern, is_regex, false);
    let was = prev.map(|s| s.value.as_deref() == Some("in_stock"));
    let in_alert_state = in_stock == alert_when_in_stock;
    let was_in_alert_state = was.map(|w| w == alert_when_in_stock);
    let alert = if in_alert_state && was_in_alert_state != Some(true) {
        Some(PendingAlert {
            title: format!("Now {}", if in_stock { "in stock" } else { "out of stock" }),
            message: format!("On {}", fetched_label(fetched)),
            kind: "stock",
        })
    } else {
        None
    };
    CheckOutcome {
        status: alert_status(&alert),
        http_status: fetched.http_status,
        latency_ms: Some(fetched.latency_ms),
        value: Some(if in_stock { "in_stock" } else { "out_of_stock" }.to_string()),
        content_hash: None,
        note: None,
        alert,
    }
}

// ---- small utilities -------------------------------------------------------

fn alert_status(alert: &Option<PendingAlert>) -> CheckStatus {
    if alert.is_some() {
        CheckStatus::Triggered
    } else {
        CheckStatus::Ok
    }
}

fn fetched_label(fetched: &Fetched) -> String {
    match fetched.http_status {
        Some(code) => format!("HTTP {code}"),
        None => "fetched page".to_string(),
    }
}

fn pattern_matches(body: &str, pattern: &str, is_regex: bool, case_sensitive: bool) -> bool {
    if is_regex {
        let built = if case_sensitive {
            regex::Regex::new(pattern)
        } else {
            regex::Regex::new(&format!("(?i){pattern}"))
        };
        built.map(|re| re.is_match(body)).unwrap_or(false)
    } else if case_sensitive {
        body.contains(pattern)
    } else {
        body.to_lowercase().contains(&pattern.to_lowercase())
    }
}

fn first_capture(body: &str, pattern: &str) -> Option<String> {
    let re = regex::Regex::new(pattern).ok()?;
    let caps = re.captures(body)?;
    // Prefer capture group 1; fall back to the whole match.
    caps.get(1)
        .or_else(|| caps.get(0))
        .map(|m| m.as_str().to_string())
}

fn parse_number(raw: &str) -> Option<f64> {
    // Keep digits, dot, and minus; drop currency symbols, thousands separators, etc.
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
        .collect();
    cleaned.parse::<f64>().ok()
}

fn format_number(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        format!("{n:.2}")
    }
}

fn normalize_text(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn sha256_hex(s: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Best-effort extraction of page text from a Spider crawl result.
fn spider_body_text(result: &serde_json::Value) -> String {
    if let Some(s) = result.get("content").and_then(serde_json::Value::as_str) {
        return s.to_string();
    }
    // Spider may return an array of crawled pages; concatenate their text.
    if let Some(arr) = result.as_array() {
        let mut out = String::new();
        for page in arr {
            for key in ["content", "text", "markdown", "html"] {
                if let Some(s) = page.get(key).and_then(serde_json::Value::as_str) {
                    out.push_str(s);
                    out.push('\n');
                    break;
                }
            }
        }
        if !out.is_empty() {
            return out;
        }
    }
    // Fall back to the raw JSON so keyword/diff checks still have something.
    result.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(value: &str, hash: Option<&str>) -> Snapshot {
        Snapshot {
            id: 1,
            monitor_id: "m".into(),
            checked_at: "now".into(),
            status: CheckStatus::Ok,
            http_status: Some(200),
            latency_ms: Some(1),
            value: Some(value.into()),
            content_hash: hash.map(str::to_string),
            note: None,
        }
    }

    #[test]
    fn uptime_alerts_on_down_transition() {
        let out = eval_uptime(
            Ok(Fetched {
                http_status: Some(500),
                latency_ms: 5,
                body: String::new(),
            }),
            &[],
            Some(&snap("up", None)),
        );
        assert_eq!(out.status, CheckStatus::Triggered);
        assert_eq!(out.alert.unwrap().kind, "uptime_down");
    }

    #[test]
    fn uptime_no_alert_when_still_up() {
        let out = eval_uptime(
            Ok(Fetched {
                http_status: Some(200),
                latency_ms: 5,
                body: String::new(),
            }),
            &[],
            Some(&snap("up", None)),
        );
        assert_eq!(out.status, CheckStatus::Ok);
        assert!(out.alert.is_none());
    }

    #[test]
    fn keyword_alerts_on_appearance() {
        let fetched = Fetched {
            http_status: Some(200),
            latency_ms: 1,
            body: "Tickets are now ON SALE".into(),
        };
        let out = eval_keyword(
            &fetched,
            "on sale",
            false,
            false,
            true,
            Some(&snap("absent", None)),
        );
        assert_eq!(out.status, CheckStatus::Triggered);
        assert_eq!(out.value.as_deref(), Some("present"));
    }

    #[test]
    fn keyword_no_repeat_when_already_present() {
        let fetched = Fetched {
            http_status: Some(200),
            latency_ms: 1,
            body: "ON SALE".into(),
        };
        let out = eval_keyword(
            &fetched,
            "on sale",
            false,
            false,
            true,
            Some(&snap("present", None)),
        );
        assert!(out.alert.is_none());
    }

    #[test]
    fn content_diff_alerts_on_hash_change() {
        let fetched = Fetched {
            http_status: Some(200),
            latency_ms: 1,
            body: "new body".into(),
        };
        let out = eval_content_diff(&fetched, None, Some(&snap("x", Some("deadbeef"))));
        assert_eq!(out.status, CheckStatus::Triggered);
        assert_eq!(out.alert.unwrap().kind, "content_change");
    }

    #[test]
    fn price_drop_below_threshold() {
        let fetched = Fetched {
            http_status: Some(200),
            latency_ms: 1,
            body: "Price: $42.50".into(),
        };
        let out = eval_price(
            &fetched,
            r"\$([0-9.,]+)",
            NumComparator::LessThan,
            Some(50.0),
            Some(&snap("60", None)),
        );
        assert_eq!(out.status, CheckStatus::Triggered);
        assert_eq!(out.value.as_deref(), Some("42.50"));
    }

    #[test]
    fn price_pct_drop() {
        let fetched = Fetched {
            http_status: Some(200),
            latency_ms: 1,
            body: "80".into(),
        };
        let out = eval_price(
            &fetched,
            r"([0-9.]+)",
            NumComparator::DropsByPct,
            Some(10.0),
            Some(&snap("100", None)),
        );
        assert_eq!(out.status, CheckStatus::Triggered);
    }

    #[test]
    fn stock_alerts_when_back_in_stock() {
        let fetched = Fetched {
            http_status: Some(200),
            latency_ms: 1,
            body: "Add to cart".into(),
        };
        let out = eval_stock(
            &fetched,
            "add to cart",
            false,
            true,
            Some(&snap("out_of_stock", None)),
        );
        assert_eq!(out.status, CheckStatus::Triggered);
        assert_eq!(out.value.as_deref(), Some("in_stock"));
    }

    #[test]
    fn parse_number_strips_currency() {
        // Currency symbols and thousands separators are stripped; a `.` is the
        // decimal point (European comma-decimal is not handled in v1).
        assert_eq!(parse_number("$1,299.00"), Some(1299.00));
        assert_eq!(parse_number("Price 42"), Some(42.0));
    }
}
