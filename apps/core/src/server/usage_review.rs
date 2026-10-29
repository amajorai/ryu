//! Period-based, on-demand usage reviews built from existing local stores.
//!
//! This module deliberately does not record events. It reads the conversation and
//! activity stores when a caller asks for a review, applies the persisted privacy
//! exclusions, and returns bounded structured input suitable for a later narrative
//! pass by an LLM.

use axum::{extract::Query, extract::State, http::StatusCode, response::IntoResponse, Json};
use chrono::{DateTime, Utc};
use ryu_activity::ActivityItem;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use super::conversations::{ConversationSummary, StoredMessage};
use super::ServerState;

const SETTINGS_KEY: &str = "usage-review.settings";
const DEFAULT_PERIOD_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const MAX_PERIOD_MS: i64 = 90 * 24 * 60 * 60 * 1000;
const MAX_ACTIVITY_ITEMS: u32 = 50_000;
const MAX_EXCLUDED_CONVERSATIONS: usize = 1_000;
const MAX_EXCLUDED_ACTIVITY_VALUES: usize = 100;
const MAX_LABEL_CHARS: usize = 96;
const MAX_EXCERPT_CHARS: usize = 240;

/// Persisted controls for the on-demand review. The feature is opt-in and no
/// setting here causes telemetry to be collected or sent off-node.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UsageReviewSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub excluded_conversation_ids: Vec<String>,
    #[serde(default)]
    pub excluded_activity_kinds: Vec<String>,
    #[serde(default)]
    pub excluded_activity_sources: Vec<String>,
    /// Include short user-message excerpts in the local LLM input. Off by default.
    #[serde(default)]
    pub include_message_excerpts: bool,
}

impl Default for UsageReviewSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            excluded_conversation_ids: Vec::new(),
            excluded_activity_kinds: Vec::new(),
            excluded_activity_sources: Vec::new(),
            include_message_excerpts: false,
        }
    }
}

impl UsageReviewSettings {
    fn normalized(mut self) -> Self {
        self.excluded_conversation_ids =
            normalize_values(self.excluded_conversation_ids, MAX_EXCLUDED_CONVERSATIONS);
        self.excluded_activity_kinds =
            normalize_values(self.excluded_activity_kinds, MAX_EXCLUDED_ACTIVITY_VALUES);
        self.excluded_activity_sources =
            normalize_values(self.excluded_activity_sources, MAX_EXCLUDED_ACTIVITY_VALUES);
        self
    }
}

fn normalize_values(values: Vec<String>, max: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .take(max)
        .collect()
}

/// Read the settings from the existing preferences KV store. Missing or malformed
/// values fail closed to the privacy-preserving default.
pub async fn load_settings(
    preferences: &crate::server::preferences::PreferencesStore,
) -> UsageReviewSettings {
    match preferences.get(SETTINGS_KEY).await {
        Ok(Some(raw)) => serde_json::from_str::<UsageReviewSettings>(&raw)
            .map(UsageReviewSettings::normalized)
            .unwrap_or_default(),
        _ => UsageReviewSettings::default(),
    }
}

async fn save_settings(
    preferences: &crate::server::preferences::PreferencesStore,
    settings: &UsageReviewSettings,
) -> anyhow::Result<()> {
    preferences
        .set(SETTINGS_KEY, &serde_json::to_string(settings)?)
        .await
}

#[derive(Debug, Deserialize)]
pub struct UpdateSettingsBody {
    enabled: Option<bool>,
    excluded_conversation_ids: Option<Vec<String>>,
    excluded_activity_kinds: Option<Vec<String>>,
    excluded_activity_sources: Option<Vec<String>>,
    include_message_excerpts: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct ReviewQuery {
    /// Inclusive Unix epoch milliseconds. Defaults to seven days before `to`.
    from: Option<i64>,
    /// Exclusive Unix epoch milliseconds. Defaults to now.
    to: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReviewPeriod {
    pub from: i64,
    pub to: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ReviewMetrics {
    pub conversation_count: usize,
    pub message_count: usize,
    pub user_message_count: usize,
    pub assistant_message_count: usize,
    pub active_days: usize,
    pub activity_count: usize,
    pub activity_by_kind: Vec<CountSummary>,
    pub activity_by_source: Vec<CountSummary>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CountSummary {
    pub label: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct DailySummary {
    pub day: String,
    pub conversations: usize,
    pub messages: usize,
    pub activities: usize,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct TopicSummary {
    pub label: String,
    pub conversation_count: usize,
    pub message_count: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub excerpts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct WorkflowSummary {
    pub label: String,
    pub conversation_count: usize,
    pub message_count: usize,
    pub activity_count: usize,
    pub agents: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiFluencyObservation {
    pub id: String,
    pub title: String,
    pub evidence_count: usize,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct NarrativeInput {
    pub instruction: &'static str,
    pub period: ReviewPeriod,
    pub metrics: ReviewMetrics,
    pub daily: Vec<DailySummary>,
    pub topics: Vec<TopicSummary>,
    pub workflows: Vec<WorkflowSummary>,
    pub ai_fluency_observations: Vec<AiFluencyObservation>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageReview {
    pub period: ReviewPeriod,
    pub settings: UsageReviewSettings,
    pub metrics: ReviewMetrics,
    pub daily: Vec<DailySummary>,
    pub topics: Vec<TopicSummary>,
    pub workflows: Vec<WorkflowSummary>,
    pub ai_fluency_observations: Vec<AiFluencyObservation>,
    pub narrative_input: NarrativeInput,
}

#[derive(Debug)]
struct ConversationInput {
    id: String,
    title: Option<String>,
    agent_id: Option<String>,
    folder_path: Option<String>,
    branch: Option<String>,
    messages: Vec<StoredMessage>,
}

/// A validated half-open `[from, to)` window in Unix epoch milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Period {
    pub(crate) from: i64,
    pub(crate) to: i64,
}

impl Period {
    /// The window of `length_ms` ending (exclusively) at `to`, clamped at epoch 0.
    pub(crate) fn ending_at(to: i64, length_ms: i64) -> Self {
        Self {
            from: to.saturating_sub(length_ms).max(0),
            to,
        }
    }

    fn parse(query: ReviewQuery, now: i64) -> Result<Self, String> {
        let to = query.to.unwrap_or(now);
        let from = query.from.unwrap_or(to.saturating_sub(DEFAULT_PERIOD_MS));
        if from < 0 || to <= from {
            return Err("from must be before to and both must be non-negative".to_owned());
        }
        if to - from > MAX_PERIOD_MS {
            return Err("review periods may not exceed 90 days".to_owned());
        }
        Ok(Self { from, to })
    }

    fn public(self) -> ReviewPeriod {
        ReviewPeriod {
            from: self.from,
            to: self.to,
        }
    }
}

/// `GET /api/usage-review/settings` — read the local review privacy controls.
#[utoipa::path(
    get,
    path = "/api/usage-review/settings",
    tag = "Usage Review",
    summary = "Read usage review privacy settings",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_settings(State(state): State<ServerState>) -> Json<UsageReviewSettings> {
    Json(load_settings(&state.preferences).await)
}

/// `PUT /api/usage-review/settings` — update review privacy controls. Omitted
/// fields retain their current values, which makes this safe for incremental clients.
#[utoipa::path(
    put,
    path = "/api/usage-review/settings",
    tag = "Usage Review",
    summary = "Update usage review privacy settings",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn put_settings(
    State(state): State<ServerState>,
    Json(body): Json<UpdateSettingsBody>,
) -> axum::response::Response {
    let mut settings = load_settings(&state.preferences).await;
    if let Some(enabled) = body.enabled {
        settings.enabled = enabled;
    }
    if let Some(ids) = body.excluded_conversation_ids {
        settings.excluded_conversation_ids = ids;
    }
    if let Some(kinds) = body.excluded_activity_kinds {
        settings.excluded_activity_kinds = kinds;
    }
    if let Some(sources) = body.excluded_activity_sources {
        settings.excluded_activity_sources = sources;
    }
    if let Some(include) = body.include_message_excerpts {
        settings.include_message_excerpts = include;
    }
    settings = settings.normalized();
    match save_settings(&state.preferences, &settings).await {
        Ok(()) => Json(settings).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

/// `GET /api/usage-review?from=…&to=…` — aggregate existing conversations and
/// activity for a bounded period. The narrative input is structured and local;
/// this endpoint does not call a model.
#[utoipa::path(
    get,
    path = "/api/usage-review",
    tag = "Usage Review",
    summary = "Aggregate a period into LLM-ready usage review input",
    params(
        ("from" = Option<i64>, Query, description = "Inclusive Unix epoch milliseconds"),
        ("to" = Option<i64>, Query, description = "Exclusive Unix epoch milliseconds")
    ),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_review(
    State(state): State<ServerState>,
    Query(query): Query<ReviewQuery>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    let settings = load_settings(&state.preferences).await;
    if !settings.enabled {
        return disabled_response();
    }
    let now = Utc::now().timestamp_millis();
    let period = match Period::parse(query, now) {
        Ok(period) => period,
        Err(message) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response();
        }
    };

    match collect_review(&state, &caller, settings, period).await {
        Ok(review) => Json(review).into_response(),
        Err(error) => internal_error(error),
    }
}

/// The `usage_review_disabled` refusal shared by every surface that projects
/// usage-review data (this route and the Memory Reflect dashboard).
pub(crate) fn disabled_response() -> axum::response::Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({
            "error": "usage_review_disabled",
            "message": "Enable usage review in /api/usage-review/settings first"
        })),
    )
        .into_response()
}

/// Read the caller-visible conversations and the included activity for
/// `period`, applying the persisted privacy exclusions, and aggregate them.
///
/// This is the single data path for usage reviews: the Memory Reflect dashboard
/// projects from the same output so the two surfaces can never disagree.
pub(crate) async fn collect_review(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    settings: UsageReviewSettings,
    period: Period,
) -> anyhow::Result<UsageReview> {
    let (user_id, org_id, team_ids_json, node_bound) = super::tenancy_filter_args(caller);
    let summaries = state
        .conversations
        .list_conversations_visible_for_teams(
            user_id.as_deref(),
            org_id.as_deref(),
            node_bound,
            team_ids_json.as_deref(),
        )
        .await?;
    let excluded: HashSet<&str> = settings
        .excluded_conversation_ids
        .iter()
        .map(String::as_str)
        .collect();
    let mut conversations = Vec::new();
    for summary in summaries {
        if excluded.contains(summary.id.as_str()) {
            continue;
        }
        let messages: Vec<StoredMessage> = state
            .conversations
            .get_active_messages(&summary.id)
            .await?
            .into_iter()
            .filter(|message| message.created_at >= period.from && message.created_at < period.to)
            .collect();
        if !messages.is_empty() {
            conversations.push(ConversationInput::from_summary(summary, messages));
        }
    }

    let activity_start = period.from / 1000;
    let activity_end = period.to.saturating_add(999) / 1000;
    let activities = state
        .activity
        .list_between(activity_start, activity_end, MAX_ACTIVITY_ITEMS)
        .await?
        .into_iter()
        .filter(|item| activity_is_included(item, period, &settings))
        .collect();

    Ok(build_review(period, settings, conversations, activities))
}

fn internal_error(error: anyhow::Error) -> axum::response::Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": error.to_string() })),
    )
        .into_response()
}

fn activity_is_included(
    item: &ActivityItem,
    period: Period,
    settings: &UsageReviewSettings,
) -> bool {
    let at = item.created_at.saturating_mul(1000);
    at >= period.from
        && at < period.to
        && !settings
            .excluded_activity_kinds
            .iter()
            .any(|kind| kind == &item.kind)
        && !settings
            .excluded_activity_sources
            .iter()
            .any(|source| source == &item.source)
}

impl ConversationInput {
    fn from_summary(summary: ConversationSummary, messages: Vec<StoredMessage>) -> Self {
        Self {
            id: summary.id,
            title: summary.title,
            agent_id: summary.agent_id,
            folder_path: summary.folder_path,
            branch: summary.branch,
            messages,
        }
    }
}

fn build_review(
    period: Period,
    settings: UsageReviewSettings,
    conversations: Vec<ConversationInput>,
    activities: Vec<ActivityItem>,
) -> UsageReview {
    let mut metrics = ReviewMetrics {
        conversation_count: conversations.len(),
        ..ReviewMetrics::default()
    };
    let mut daily: BTreeMap<String, DailySummary> = BTreeMap::new();
    let mut topics: BTreeMap<String, TopicSummary> = BTreeMap::new();
    let mut workflows: BTreeMap<String, WorkflowSummary> = BTreeMap::new();
    let mut activity_by_session: HashMap<String, usize> = HashMap::new();
    let mut all_agents = BTreeSet::new();
    let mut follow_ups = 0;
    let mut tool_turns = 0;
    let mut workflow_keys = Vec::new();

    for activity in &activities {
        metrics.activity_count += 1;
        increment_daily(&mut daily, activity_day(activity.created_at));
        daily
            .entry(activity_day(activity.created_at))
            .or_default()
            .activities += 1;
        *activity_by_session
            .entry(activity.session_id.clone().unwrap_or_default())
            .or_default() += 1;
    }

    for conversation in conversations {
        let topic = conversation_topic(&conversation);
        let workflow = conversation_workflow(&conversation);
        workflow_keys.push(workflow.clone());
        let topic_entry = topics.entry(topic.clone()).or_insert_with(|| TopicSummary {
            label: topic,
            ..TopicSummary::default()
        });
        topic_entry.conversation_count += 1;
        let workflow_entry = workflows
            .entry(workflow.clone())
            .or_insert_with(|| WorkflowSummary {
                label: workflow.clone(),
                ..WorkflowSummary::default()
            });
        workflow_entry.conversation_count += 1;
        if let Some(agent) = conversation.agent_id.as_deref() {
            workflow_entry.agents.push(agent.to_owned());
            all_agents.insert(agent.to_owned());
        }
        workflow_entry.activity_count += activity_by_session
            .get(&conversation.id)
            .copied()
            .unwrap_or(0);

        let mut user_messages: usize = 0;
        for message in &conversation.messages {
            metrics.message_count += 1;
            match message.role.as_str() {
                "user" => {
                    metrics.user_message_count += 1;
                    user_messages += 1;
                }
                "assistant" => metrics.assistant_message_count += 1,
                _ => {}
            }
            if message.agent_id.is_some() {
                all_agents.extend(message.agent_id.iter().cloned());
            }
            let day = message_day(message.created_at);
            increment_daily(&mut daily, day.clone());
            daily.entry(day).or_default().messages += 1;
            topic_entry.message_count += 1;
            workflow_entry.message_count += 1;
            if message
                .parts
                .as_ref()
                .is_some_and(|parts| count_tool_parts(parts) > 0)
            {
                tool_turns += 1;
            }
        }
        follow_ups += user_messages.saturating_sub(1);
        if settings.include_message_excerpts {
            if let Some(excerpt) = conversation
                .messages
                .iter()
                .find(|message| message.role == "user")
            {
                if let Some(entry) = topics.get_mut(&conversation_topic(&conversation)) {
                    entry.excerpts.push(truncate(
                        &normalize_text(&excerpt.content),
                        MAX_EXCERPT_CHARS,
                    ));
                }
            }
        }
    }

    for topic in topics.values_mut() {
        topic.excerpts.sort();
        topic.excerpts.dedup();
        topic.excerpts.truncate(3);
    }
    for workflow in workflows.values_mut() {
        workflow.agents.sort();
        workflow.agents.dedup();
    }
    metrics.active_days = daily.len();
    metrics.activity_by_kind = count_values(activities.iter().map(|item| item.kind.clone()));
    metrics.activity_by_source = count_values(activities.iter().map(|item| item.source.clone()));

    let mut observations = Vec::new();
    if follow_ups > 0 {
        observations.push(AiFluencyObservation {
            id: "iterative-refinement".to_owned(),
            title: "Iterative refinement".to_owned(),
            evidence_count: follow_ups,
            detail: "Follow-up user turns show the user refining or extending work within a conversation.".to_owned(),
        });
    }
    if tool_turns > 0 {
        observations.push(AiFluencyObservation {
            id: "tool-orchestration".to_owned(),
            title: "Tool orchestration".to_owned(),
            evidence_count: tool_turns,
            detail: "Assistant turns include structured tool parts, indicating use of the agent beyond plain text replies.".to_owned(),
        });
    }
    let repeated_workflows = workflow_keys
        .len()
        .saturating_sub(workflow_keys.iter().collect::<BTreeSet<_>>().len());
    if repeated_workflows > 0 {
        observations.push(AiFluencyObservation {
            id: "workflow-continuity".to_owned(),
            title: "Workflow continuity".to_owned(),
            evidence_count: repeated_workflows,
            detail: "Multiple conversations share a workspace, branch, or agent workflow label."
                .to_owned(),
        });
    }
    if all_agents.len() > 1 {
        observations.push(AiFluencyObservation {
            id: "multi-agent-collaboration".to_owned(),
            title: "Multi-agent collaboration".to_owned(),
            evidence_count: all_agents.len(),
            detail: "More than one agent contributed to the reviewed conversations.".to_owned(),
        });
    }

    let period_public = period.public();
    let daily = daily.into_values().collect::<Vec<_>>();
    let topics = topics.into_values().collect::<Vec<_>>();
    let workflows = workflows.into_values().collect::<Vec<_>>();
    let narrative_input = NarrativeInput {
        instruction: "Write a grounded, non-judgmental usage reflection from these aggregates. Do not infer identity, emotion, productivity, or facts not supported by the evidence.",
        period: period_public.clone(),
        metrics: metrics.clone(),
        daily: daily.clone(),
        topics: topics.clone(),
        workflows: workflows.clone(),
        ai_fluency_observations: observations.clone(),
    };
    UsageReview {
        period: period_public,
        settings,
        metrics,
        daily,
        topics,
        workflows,
        ai_fluency_observations: observations,
        narrative_input,
    }
}

fn count_values(values: impl Iterator<Item = String>) -> Vec<CountSummary> {
    let mut counts = BTreeMap::<String, usize>::new();
    for value in values {
        *counts.entry(value).or_default() += 1;
    }
    let mut values = counts
        .into_iter()
        .map(|(label, count)| CountSummary { label, count })
        .collect::<Vec<_>>();
    values.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.label.cmp(&right.label))
    });
    values
}

fn conversation_topic(conversation: &ConversationInput) -> String {
    conversation
        .title
        .as_deref()
        .map(normalize_text)
        .filter(|title| {
            !title.is_empty() && !matches!(title.as_str(), "New conversation" | "Untitled")
        })
        .or_else(|| {
            conversation
                .messages
                .iter()
                .find(|message| message.role == "user")
                .map(|message| normalize_text(&message.content))
                .filter(|content| !content.is_empty())
        })
        .map(|label| truncate(&label, MAX_LABEL_CHARS))
        .unwrap_or_else(|| "Untitled conversation".to_owned())
}

fn conversation_workflow(conversation: &ConversationInput) -> String {
    conversation
        .folder_path
        .as_deref()
        .and_then(|path| path.rsplit('/').next())
        .filter(|name| !name.is_empty())
        .map(|name| format!("workspace:{name}"))
        .or_else(|| {
            conversation
                .branch
                .as_deref()
                .map(|branch| format!("branch:{branch}"))
        })
        .or_else(|| {
            conversation
                .agent_id
                .as_deref()
                .map(|agent| format!("agent:{agent}"))
        })
        .unwrap_or_else(|| "unassigned".to_owned())
}

fn count_tool_parts(value: &serde_json::Value) -> usize {
    match value {
        serde_json::Value::Array(values) => values.iter().map(count_tool_parts).sum(),
        serde_json::Value::Object(values) => {
            let is_tool = values
                .get("type")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|kind| kind.contains("tool"));
            usize::from(is_tool) + values.values().map(count_tool_parts).sum::<usize>()
        }
        _ => 0,
    }
}

fn normalize_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn increment_daily(daily: &mut BTreeMap<String, DailySummary>, day: String) {
    daily.entry(day.clone()).or_insert_with(|| DailySummary {
        day,
        ..DailySummary::default()
    });
}

fn message_day(timestamp_ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(timestamp_ms)
        .map(|value| value.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "unknown".to_owned())
}

fn activity_day(timestamp_seconds: i64) -> String {
    message_day(timestamp_seconds.saturating_mul(1000))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str, role: &str, content: &str, created_at: i64) -> StoredMessage {
        StoredMessage {
            id: id.to_owned(),
            role: role.to_owned(),
            content: content.to_owned(),
            agent_id: (role == "assistant").then(|| "claude".to_owned()),
            author_user_id: None,
            author_name: None,
            source: None,
            widget_instance_id: None,
            origin_server: None,
            parts: None,
            metadata: None,
            parent_message_id: None,
            interrupted: false,
            sibling_index: 0,
            sibling_count: 1,
            sibling_ids: Vec::new(),
            created_at,
        }
    }

    fn conversation(
        id: &str,
        title: &str,
        folder_path: &str,
        messages: Vec<StoredMessage>,
    ) -> ConversationInput {
        ConversationInput {
            id: id.to_owned(),
            title: Some(title.to_owned()),
            agent_id: Some("claude".to_owned()),
            folder_path: Some(folder_path.to_owned()),
            branch: None,
            messages,
        }
    }

    #[test]
    fn settings_normalize_and_deduplicate_exclusions() {
        let settings = UsageReviewSettings {
            enabled: true,
            excluded_conversation_ids: vec![" c1 ".into(), "c1".into(), "".into()],
            excluded_activity_kinds: vec!["run".into(), "run".into()],
            excluded_activity_sources: vec![" meetings ".into()],
            include_message_excerpts: true,
        }
        .normalized();
        assert_eq!(settings.excluded_conversation_ids, vec!["c1"]);
        assert_eq!(settings.excluded_activity_kinds, vec!["run"]);
        assert_eq!(settings.excluded_activity_sources, vec!["meetings"]);
    }

    #[test]
    fn build_review_aggregates_period_data_and_privacy_exclusions() {
        let period = Period {
            from: 0,
            to: 86_400_000,
        };
        let settings = UsageReviewSettings {
            enabled: true,
            excluded_activity_kinds: vec!["meeting".into()],
            include_message_excerpts: true,
            ..UsageReviewSettings::default()
        };
        let mut first = conversation(
            "c1",
            "Ship the release",
            "/work/ryu",
            vec![
                message("u1", "user", "Plan the release", 1_000),
                message("a1", "assistant", "I will inspect the repo", 2_000),
                message("u2", "user", "Now update the notes", 3_000),
            ],
        );
        first.messages[1].parts = Some(json!([{ "type": "tool-call" }]));
        let second = conversation(
            "c2",
            "Review the release",
            "/work/ryu",
            vec![message("u3", "user", "Check the release", 4_000)],
        );
        let activity = vec![
            ActivityItem::new("run", "runs", "release").with_created_at(2),
            ActivityItem::new("meeting", "meetings", "private meeting").with_created_at(3),
        ];

        let activity = activity
            .into_iter()
            .filter(|item| activity_is_included(item, period, &settings))
            .collect();
        let review = build_review(period, settings, vec![first, second], activity);
        assert_eq!(review.metrics.conversation_count, 2);
        assert_eq!(review.metrics.message_count, 4);
        assert_eq!(review.metrics.activity_count, 1);
        assert_eq!(
            review
                .topics
                .iter()
                .find(|topic| topic.label == "Ship the release")
                .unwrap()
                .excerpts,
            vec!["Plan the release"]
        );
        assert!(review
            .ai_fluency_observations
            .iter()
            .any(|item| item.id == "iterative-refinement"));
        assert!(review
            .ai_fluency_observations
            .iter()
            .any(|item| item.id == "tool-orchestration"));
        assert!(review
            .ai_fluency_observations
            .iter()
            .any(|item| item.id == "workflow-continuity"));
    }

    #[test]
    fn period_rejects_inverted_or_oversized_ranges() {
        assert!(Period::parse(
            ReviewQuery {
                from: Some(10),
                to: Some(10),
            },
            100,
        )
        .is_err());
        assert!(Period::parse(
            ReviewQuery {
                from: Some(0),
                to: Some(MAX_PERIOD_MS + 1),
            },
            100,
        )
        .is_err());
    }
}
