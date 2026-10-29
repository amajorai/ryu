//! Memory app Reflect dashboard: a period projection of the usage review.
//!
//! Reflect does not record anything of its own. The dashboard is a reshaped view
//! of [`usage_review::collect_review`] over a fixed seven-, thirty- or ninety-day
//! window, so it shares that route's opt-in privacy gate, conversation
//! visibility filter, and exclusion lists. Trends compare the selected window
//! with the immediately preceding window of the same length.
//!
//! The Reflect settings (break nudges and quiet hours) are persisted in the
//! preferences KV store. Quiet hours also hold back the automatic Dream review
//! (see [`reflect_quiet_hours_active`]); nothing in Core emits break nudges yet,
//! so that preference is stored for clients but has no server-side consumer.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Extension, Json, Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::usage_review::{self, Period, UsageReview};
use super::ServerState;

const REFLECT_BREAK_NUDGES_PREF: &str = "memory-reflect-break-nudges";
const REFLECT_QUIET_ENABLED_PREF: &str = "memory-reflect-quiet-enabled";
const REFLECT_QUIET_START_PREF: &str = "memory-reflect-quiet-start";
const REFLECT_QUIET_END_PREF: &str = "memory-reflect-quiet-end";

const DEFAULT_BREAK_NUDGES: bool = false;
const DEFAULT_QUIET_ENABLED: bool = true;
const DEFAULT_QUIET_START: u8 = 22;
const DEFAULT_QUIET_END: u8 = 8;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const MAX_TOPICS: usize = 12;

/// The dashboard windows the desktop offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
pub(crate) enum ReflectPeriod {
    #[default]
    #[serde(rename = "7d")]
    Week,
    #[serde(rename = "30d")]
    Month,
    #[serde(rename = "90d")]
    Quarter,
}

impl ReflectPeriod {
    fn days(self) -> i64 {
        match self {
            Self::Week => 7,
            Self::Month => 30,
            Self::Quarter => 90,
        }
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct ReflectQuery {
    #[serde(default)]
    period: Option<ReflectPeriod>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct ReflectActivity {
    label: &'static str,
    count: usize,
    /// Whole-percent change versus the preceding window, or `None` when the
    /// preceding window had no data to compare against.
    trend: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct ReflectTopic {
    name: String,
    count: usize,
    summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct ReflectInsight {
    id: String,
    title: String,
    body: String,
    tone: &'static str,
    evidence_count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct ReflectDashboard {
    period: ReflectPeriod,
    generated_at: i64,
    activity: Vec<ReflectActivity>,
    topics: Vec<ReflectTopic>,
    insights: Vec<ReflectInsight>,
}

/// Persisted Reflect preferences, in wire form.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub(crate) struct ReflectSettings {
    break_nudges: bool,
    quiet_hours_enabled: bool,
    quiet_hours_start: u8,
    quiet_hours_end: u8,
}

impl Default for ReflectSettings {
    fn default() -> Self {
        Self {
            break_nudges: DEFAULT_BREAK_NUDGES,
            quiet_hours_enabled: DEFAULT_QUIET_ENABLED,
            quiet_hours_start: DEFAULT_QUIET_START,
            quiet_hours_end: DEFAULT_QUIET_END,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct ReflectSettingsPatch {
    #[serde(default)]
    break_nudges: Option<bool>,
    #[serde(default)]
    quiet_hours_enabled: Option<bool>,
    #[serde(default)]
    quiet_hours_start: Option<u8>,
    #[serde(default)]
    quiet_hours_end: Option<u8>,
}

impl ReflectSettings {
    fn apply(self, patch: &ReflectSettingsPatch) -> Result<Self, String> {
        for hour in [patch.quiet_hours_start, patch.quiet_hours_end]
            .into_iter()
            .flatten()
        {
            if hour > 23 {
                return Err("Reflect quiet hours must be between 0 and 23".to_owned());
            }
        }
        Ok(Self {
            break_nudges: patch.break_nudges.unwrap_or(self.break_nudges),
            quiet_hours_enabled: patch
                .quiet_hours_enabled
                .unwrap_or(self.quiet_hours_enabled),
            quiet_hours_start: patch.quiet_hours_start.unwrap_or(self.quiet_hours_start),
            quiet_hours_end: patch.quiet_hours_end.unwrap_or(self.quiet_hours_end),
        })
    }

    /// Whether `hour` (local, 0-23) falls inside an enabled quiet-hours window.
    fn is_quiet(self, hour: u8) -> bool {
        self.quiet_hours_enabled
            && super::memory_dream::is_quiet_hour(
                hour,
                self.quiet_hours_start,
                self.quiet_hours_end,
            )
    }
}

/// Build the Reflect routes. The parent memory router applies the Memory App
/// gate to this whole subtree.
pub(super) fn routes() -> Router<ServerState> {
    Router::new()
        .route("/api/memory/reflect", get(get_reflect_dashboard))
        .route(
            "/api/memory/reflect/settings",
            get(get_reflect_settings).patch(update_reflect_settings),
        )
}

/// Whether the Reflect quiet-hours window currently covers `hour`. Background
/// Memory work (the automatic Dream review) consults this so the dashboard's
/// "won't interrupt you" promise is enforced server-side.
pub(super) async fn reflect_quiet_hours_active(state: &ServerState, hour: u8) -> bool {
    match read_settings(state).await {
        Ok(settings) => settings.is_quiet(hour),
        Err(error) => {
            tracing::warn!("Reflect quiet hours could not be read: {error:#}");
            false
        }
    }
}

#[utoipa::path(
    get,
    path = "/api/memory/reflect",
    tag = "Memory",
    summary = "Project the usage review into the Reflect dashboard",
    params(("period" = Option<String>, Query, description = "One of 7d, 30d or 90d (default 7d)")),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "Usage review is disabled or the caller lacks memory read permission")
    )
)]
pub(super) async fn get_reflect_dashboard(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Query(query): Query<ReflectQuery>,
) -> Response {
    if let Err(response) = super::require_memory_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_READ,
    )
    .await
    {
        return response;
    }
    let settings = usage_review::load_settings(&state.preferences).await;
    if !settings.enabled {
        return usage_review::disabled_response();
    }
    let period = query.period.unwrap_or_default();
    let now = Utc::now().timestamp_millis();
    let length = period.days() * DAY_MS;
    let current_window = Period::ending_at(now, length);
    let previous_window = Period::ending_at(current_window.from, length);

    let current =
        match usage_review::collect_review(&state, &caller, settings.clone(), current_window).await
        {
            Ok(review) => review,
            Err(error) => {
                return super::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
            }
        };
    // An empty preceding window (e.g. a node younger than the period) simply
    // yields no trend; it is not worth a second scan.
    let previous = if previous_window.to > previous_window.from {
        match usage_review::collect_review(&state, &caller, settings, previous_window).await {
            Ok(review) => Some(review),
            Err(error) => {
                return super::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
            }
        }
    } else {
        None
    };
    Json(project_dashboard(period, now, &current, previous.as_ref())).into_response()
}

#[utoipa::path(
    get,
    path = "/api/memory/reflect/settings",
    tag = "Memory",
    summary = "Read Reflect break-nudge and quiet-hours settings",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(super) async fn get_reflect_settings(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    if let Err(response) = super::require_memory_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_READ,
    )
    .await
    {
        return response;
    }
    match read_settings(&state).await {
        Ok(settings) => Json(json!({ "settings": settings })).into_response(),
        Err(error) => super::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[utoipa::path(
    patch,
    path = "/api/memory/reflect/settings",
    tag = "Memory",
    summary = "Update Reflect break-nudge and quiet-hours settings",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 400, description = "A quiet-hours value is outside 0-23")
    )
)]
pub(super) async fn update_reflect_settings(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(patch): Json<ReflectSettingsPatch>,
) -> Response {
    if let Err(response) = super::require_memory_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_WRITE,
    )
    .await
    {
        return response;
    }
    let current = match read_settings(&state).await {
        Ok(settings) => settings,
        Err(error) => {
            return super::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    let next = match current.apply(&patch) {
        Ok(next) => next,
        Err(message) => return super::json_error(StatusCode::BAD_REQUEST, message),
    };
    // Only the fields the patch names are written, in one transaction, so a
    // concurrent PATCH of another field is not overwritten with a stale value
    // and a failure never leaves a half-applied patch.
    if let Err(error) = state.preferences.set_many(&patch_writes(&patch)).await {
        return super::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    Json(json!({ "settings": next })).into_response()
}

/// Preference rows for the fields present in `patch` (already validated).
fn patch_writes(patch: &ReflectSettingsPatch) -> Vec<(&'static str, String)> {
    [
        (
            REFLECT_BREAK_NUDGES_PREF,
            patch.break_nudges.map(|value| value.to_string()),
        ),
        (
            REFLECT_QUIET_ENABLED_PREF,
            patch.quiet_hours_enabled.map(|value| value.to_string()),
        ),
        (
            REFLECT_QUIET_START_PREF,
            patch.quiet_hours_start.map(|value| value.to_string()),
        ),
        (
            REFLECT_QUIET_END_PREF,
            patch.quiet_hours_end.map(|value| value.to_string()),
        ),
    ]
    .into_iter()
    .filter_map(|(key, value)| value.map(|value| (key, value)))
    .collect()
}

async fn read_settings(state: &ServerState) -> anyhow::Result<ReflectSettings> {
    let preferences = &state.preferences;
    let break_nudges = preferences.get(REFLECT_BREAK_NUDGES_PREF).await?;
    let quiet_enabled = preferences.get(REFLECT_QUIET_ENABLED_PREF).await?;
    let quiet_start = preferences.get(REFLECT_QUIET_START_PREF).await?;
    let quiet_end = preferences.get(REFLECT_QUIET_END_PREF).await?;
    Ok(settings_from_raw(
        break_nudges.as_deref(),
        quiet_enabled.as_deref(),
        quiet_start.as_deref(),
        quiet_end.as_deref(),
    ))
}

/// Decode stored preference strings; anything missing or malformed falls back
/// to the default for that field.
fn settings_from_raw(
    break_nudges: Option<&str>,
    quiet_enabled: Option<&str>,
    quiet_start: Option<&str>,
    quiet_end: Option<&str>,
) -> ReflectSettings {
    let defaults = ReflectSettings::default();
    let hour = |raw: Option<&str>, fallback: u8| {
        raw.and_then(|value| value.trim().parse::<u8>().ok())
            .filter(|hour| *hour <= 23)
            .unwrap_or(fallback)
    };
    ReflectSettings {
        break_nudges: break_nudges
            .and_then(parse_bool)
            .unwrap_or(defaults.break_nudges),
        quiet_hours_enabled: quiet_enabled
            .and_then(parse_bool)
            .unwrap_or(defaults.quiet_hours_enabled),
        quiet_hours_start: hour(quiet_start, defaults.quiet_hours_start),
        quiet_hours_end: hour(quiet_end, defaults.quiet_hours_end),
    }
}

fn parse_bool(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "on" | "yes" => Some(true),
        "false" | "0" | "off" | "no" => Some(false),
        _ => None,
    }
}

/// Reshape a usage review (and optionally the preceding window's review) into
/// the dashboard wire. Every number comes straight from the review aggregates.
fn project_dashboard(
    period: ReflectPeriod,
    generated_at: i64,
    current: &UsageReview,
    previous: Option<&UsageReview>,
) -> ReflectDashboard {
    let metric = |review: &UsageReview, label: &str| -> usize {
        let metrics = &review.metrics;
        match label {
            "Conversations" => metrics.conversation_count,
            "Messages" => metrics.message_count,
            "Active days" => metrics.active_days,
            _ => metrics.activity_count,
        }
    };
    let activity = [
        "Conversations",
        "Messages",
        "Active days",
        "Activity events",
    ]
    .into_iter()
    .map(|label| {
        let count = metric(current, label);
        ReflectActivity {
            label,
            count,
            trend: previous.and_then(|previous| trend(count, metric(previous, label))),
        }
    })
    .collect();

    let mut topics = current.topics.clone();
    topics.sort_by(|left, right| {
        right
            .conversation_count
            .cmp(&left.conversation_count)
            .then_with(|| right.message_count.cmp(&left.message_count))
            .then_with(|| left.label.cmp(&right.label))
    });
    let topics = topics
        .into_iter()
        .take(MAX_TOPICS)
        .map(|topic| ReflectTopic {
            summary: topic_summary(topic.message_count),
            count: topic.conversation_count,
            name: topic.label,
        })
        .collect();

    let insights = current
        .ai_fluency_observations
        .iter()
        .map(|observation| ReflectInsight {
            id: observation.id.clone(),
            title: observation.title.clone(),
            body: observation.detail.clone(),
            tone: "neutral",
            evidence_count: observation.evidence_count,
        })
        .collect();

    ReflectDashboard {
        period,
        generated_at,
        activity,
        topics,
        insights,
    }
}

fn topic_summary(message_count: usize) -> Option<String> {
    match message_count {
        0 => None,
        1 => Some("1 message".to_owned()),
        count => Some(format!("{count} messages")),
    }
}

/// Whole-percent change from `previous` to `current`, rounded half away from
/// zero. There is no meaningful percentage against an empty baseline.
fn trend(current: usize, previous: usize) -> Option<i64> {
    if previous == 0 {
        return None;
    }
    let current = i64::try_from(current).ok()?;
    let previous = i64::try_from(previous).ok()?;
    let delta = current.checked_sub(previous)?.checked_mul(100)?;
    let half = previous / 2;
    let rounded = if delta >= 0 {
        (delta + half) / previous
    } else {
        (delta - half) / previous
    };
    Some(rounded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::usage_review::{
        AiFluencyObservation, NarrativeInput, ReviewMetrics, ReviewPeriod, TopicSummary,
        UsageReviewSettings,
    };

    fn review(
        conversations: usize,
        messages: usize,
        topics: Vec<TopicSummary>,
        observations: Vec<AiFluencyObservation>,
    ) -> UsageReview {
        let period = ReviewPeriod { from: 0, to: 1 };
        let metrics = ReviewMetrics {
            conversation_count: conversations,
            message_count: messages,
            active_days: 2,
            activity_count: 0,
            ..ReviewMetrics::default()
        };
        UsageReview {
            period: period.clone(),
            settings: UsageReviewSettings::default(),
            metrics: metrics.clone(),
            daily: Vec::new(),
            topics: topics.clone(),
            workflows: Vec::new(),
            ai_fluency_observations: observations.clone(),
            narrative_input: NarrativeInput {
                instruction: "",
                period,
                metrics,
                daily: Vec::new(),
                topics,
                workflows: Vec::new(),
                ai_fluency_observations: observations,
            },
        }
    }

    fn topic(label: &str, conversations: usize, messages: usize) -> TopicSummary {
        TopicSummary {
            label: label.to_owned(),
            conversation_count: conversations,
            message_count: messages,
            excerpts: vec!["private excerpt".to_owned()],
        }
    }

    #[test]
    fn period_parses_wire_values_and_defaults_to_week() {
        let parse = |raw: &str| serde_json::from_str::<ReflectPeriod>(raw).ok();
        assert_eq!(parse("\"7d\""), Some(ReflectPeriod::Week));
        assert_eq!(parse("\"30d\""), Some(ReflectPeriod::Month));
        assert_eq!(parse("\"90d\""), Some(ReflectPeriod::Quarter));
        assert_eq!(parse("\"365d\""), None);
        assert_eq!(ReflectPeriod::default().days(), 7);
        assert_eq!(ReflectPeriod::Quarter.days(), 90);
    }

    #[test]
    fn trend_is_rounded_percent_and_absent_without_baseline() {
        assert_eq!(trend(15, 10), Some(50));
        assert_eq!(trend(5, 10), Some(-50));
        assert_eq!(trend(10, 10), Some(0));
        assert_eq!(trend(2, 3), Some(-33));
        assert_eq!(trend(5, 3), Some(67));
        assert_eq!(trend(4, 0), None);
    }

    #[test]
    fn dashboard_projects_review_aggregates_without_excerpts() {
        let observation = AiFluencyObservation {
            id: "iterative-refinement".to_owned(),
            title: "Iterative refinement".to_owned(),
            evidence_count: 3,
            detail: "Follow-up turns.".to_owned(),
        };
        let current = review(
            3,
            12,
            vec![
                topic("Docs", 1, 1),
                topic("Release", 2, 9),
                topic("Alpha", 1, 2),
            ],
            vec![observation],
        );
        let previous = review(2, 0, Vec::new(), Vec::new());
        let dashboard = project_dashboard(ReflectPeriod::Month, 42, &current, Some(&previous));

        assert_eq!(dashboard.period, ReflectPeriod::Month);
        assert_eq!(dashboard.generated_at, 42);
        let conversations = &dashboard.activity[0];
        assert_eq!(conversations.label, "Conversations");
        assert_eq!(conversations.count, 3);
        assert_eq!(conversations.trend, Some(50));
        // Previous window had no messages: no trend rather than an invented one.
        assert_eq!(dashboard.activity[1].trend, None);
        assert_eq!(dashboard.activity[2].trend, Some(0));

        let names: Vec<&str> = dashboard.topics.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["Release", "Alpha", "Docs"]);
        assert_eq!(dashboard.topics[0].summary.as_deref(), Some("9 messages"));
        assert_eq!(dashboard.topics[2].summary.as_deref(), Some("1 message"));

        assert_eq!(dashboard.insights.len(), 1);
        assert_eq!(dashboard.insights[0].body, "Follow-up turns.");
        assert_eq!(dashboard.insights[0].evidence_count, 3);

        let wire = serde_json::to_string(&dashboard).unwrap();
        assert!(wire.contains("\"period\":\"30d\""));
        assert!(!wire.contains("private excerpt"));
    }

    #[test]
    fn dashboard_without_previous_window_has_no_trends() {
        let dashboard = project_dashboard(
            ReflectPeriod::Week,
            0,
            &review(1, 1, Vec::new(), Vec::new()),
            None,
        );
        assert!(dashboard.activity.iter().all(|item| item.trend.is_none()));
    }

    #[test]
    fn settings_decode_with_per_field_fallbacks() {
        assert_eq!(
            settings_from_raw(None, None, None, None),
            ReflectSettings::default()
        );
        let settings = settings_from_raw(Some("true"), Some("off"), Some("21"), Some("99"));
        assert!(settings.break_nudges);
        assert!(!settings.quiet_hours_enabled);
        assert_eq!(settings.quiet_hours_start, 21);
        assert_eq!(settings.quiet_hours_end, DEFAULT_QUIET_END);
        assert!(!settings_from_raw(Some("maybe"), None, None, None).break_nudges);
    }

    #[test]
    fn settings_patch_merges_and_rejects_invalid_hours() {
        let patched = ReflectSettings::default()
            .apply(&ReflectSettingsPatch {
                break_nudges: Some(true),
                quiet_hours_start: Some(20),
                ..ReflectSettingsPatch::default()
            })
            .unwrap();
        assert!(patched.break_nudges);
        assert!(patched.quiet_hours_enabled);
        assert_eq!(patched.quiet_hours_start, 20);
        assert_eq!(patched.quiet_hours_end, DEFAULT_QUIET_END);
        assert!(ReflectSettings::default()
            .apply(&ReflectSettingsPatch {
                quiet_hours_end: Some(24),
                ..ReflectSettingsPatch::default()
            })
            .is_err());
    }

    #[test]
    fn settings_patch_writes_only_the_fields_it_names() {
        let writes = patch_writes(&ReflectSettingsPatch {
            quiet_hours_start: Some(21),
            ..ReflectSettingsPatch::default()
        });
        assert_eq!(writes, [(REFLECT_QUIET_START_PREF, "21".to_owned())]);
        assert!(patch_writes(&ReflectSettingsPatch::default()).is_empty());
    }

    #[test]
    fn quiet_window_only_applies_when_enabled() {
        let settings = ReflectSettings::default();
        assert!(settings.is_quiet(23));
        assert!(settings.is_quiet(3));
        assert!(!settings.is_quiet(12));
        let disabled = ReflectSettings {
            quiet_hours_enabled: false,
            ..settings
        };
        assert!(!disabled.is_quiet(23));
    }
}
