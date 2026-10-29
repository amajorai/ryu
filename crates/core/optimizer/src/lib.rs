//! Agent optimizer: measured, reversible configuration changes for an agent.
//!
//! The optimizer reads what an agent actually did in production and proposes
//! cheaper configurations that keep quality, in the spirit of Guild's Optimizer:
//!
//! - **Model**: the agent's recent single-turn requests are replayed through the
//!   Gateway eval runner against its current model and a few cheaper candidates.
//!   One fixed judge (the current model) scores every output against the reply the
//!   agent really gave, so the current model's own replay is the quality baseline.
//!   A candidate is recommended only when it stays within the quality tolerance of
//!   that baseline and costs measurably less.
//! - **Tools**: tools the agent is allowed to call but never called across its
//!   recent sessions are proposed for removal. This is usage evidence, not a
//!   replay, and the recommendation says so.
//!
//! This crate is deliberately network-free. Core gathers sessions, calls the
//! Gateway, and applies a chosen change through the normal agent update path (so
//! the agent's version history can undo it). Everything that decides *what* to
//! recommend lives here and is unit-tested with canned inputs.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Sessions an agent needs before the optimizer has enough history to judge.
pub const MIN_SESSIONS: usize = 10;
/// Upper bound on sessions read per analysis.
pub const MAX_SESSIONS: usize = 50;
/// Upper bound on replayed turns per analysis. Every case costs one provider
/// call per model plus one judge call, so this bounds the spend of one run.
pub const MAX_REPLAY_CASES: usize = 20;
/// Fewest replayable turns a model comparison is worth running on.
pub const MIN_REPLAY_CASES: usize = 5;
/// Most cheaper candidate models tried in one analysis.
pub const MAX_CANDIDATES: usize = 3;
/// A candidate may score at most this far below the current model's replay.
pub const DEFAULT_QUALITY_TOLERANCE: f64 = 0.05;
/// Savings below this fraction are not worth changing an agent for.
pub const MIN_SAVINGS: f64 = 0.10;
/// Share of failed replays that disqualifies a candidate.
const MAX_ERROR_RATE: f64 = 0.10;
/// Replay text caps keep one analysis inside the Gateway's per-case limits.
const MAX_PROMPT_CHARS: usize = 8_000;
const MAX_REFERENCE_CHARS: usize = 4_000;
/// Recommendations kept per agent (newest first).
const MAX_RECOMMENDATIONS_PER_AGENT: usize = 50;
/// Analyses kept per agent (newest first).
const MAX_ANALYSES_PER_AGENT: usize = 20;

/// Tool-list values that do not name a tool: `*` (every tool) and Core's
/// explicit "no capabilities" marker.
const ALL_TOOLS: &str = "*";
const NO_TOOLS: &str = "__ryu_none__";

// ── Production history ───────────────────────────────────────────────────────

/// One user request and the reply the agent gave to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Turn {
    pub prompt: String,
    pub reference: String,
    /// Tools the agent called while producing `reference`.
    pub tools: Vec<String>,
}

/// One conversation the agent took part in.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Session {
    pub id: String,
    pub turns: Vec<Turn>,
    /// Tool calls recorded for the session by the trace store, which also covers
    /// agents whose transcript parts do not carry tool rows.
    pub tool_calls: Vec<String>,
}

impl Session {
    fn tool_names(&self) -> impl Iterator<Item = &str> {
        self.turns
            .iter()
            .flat_map(|turn| turn.tools.iter())
            .chain(self.tool_calls.iter())
            .map(String::as_str)
    }
}

/// Tool names referenced by a stored message's AI SDK `parts` array: `tool-<name>`
/// parts and `dynamic-tool` parts carrying `toolName`.
pub fn tools_from_parts(parts: &Value) -> Vec<String> {
    let Some(items) = parts.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|part| {
            let kind = part.get("type")?.as_str()?;
            if kind == "dynamic-tool" {
                return part.get("toolName")?.as_str().map(str::to_owned);
            }
            kind.strip_prefix("tool-")
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
        })
        .collect()
}

/// Whether the agent has enough history to be analyzed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Readiness {
    pub sessions: usize,
    pub required: usize,
    pub ready: bool,
}

pub fn readiness(sessions: &[Session]) -> Readiness {
    let count = sessions
        .iter()
        .filter(|session| !session.turns.is_empty())
        .count();
    Readiness {
        sessions: count,
        required: MIN_SESSIONS,
        ready: count >= MIN_SESSIONS,
    }
}

// ── Model replay ─────────────────────────────────────────────────────────────

/// A production turn that can be replayed as a single text request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayCase {
    pub id: String,
    pub prompt: String,
    pub reference: String,
}

/// Pick up to `max` replayable turns, in the order sessions are given (callers
/// pass newest first). A turn that called tools is skipped: a text replay cannot
/// call them, so its reference would be unreachable for every model alike.
/// Identical prompts are replayed once.
pub fn replay_cases(sessions: &[Session], max: usize) -> Vec<ReplayCase> {
    let mut seen = BTreeSet::new();
    let mut cases = Vec::new();
    for session in sessions {
        for (index, turn) in session.turns.iter().enumerate() {
            if cases.len() >= max {
                return cases;
            }
            let prompt = turn.prompt.trim();
            let reference = turn.reference.trim();
            if prompt.is_empty() || reference.is_empty() || !turn.tools.is_empty() {
                continue;
            }
            if !seen.insert(prompt.to_owned()) {
                continue;
            }
            cases.push(ReplayCase {
                id: format!("{}#{index}", session.id),
                prompt: truncate_chars(prompt, MAX_PROMPT_CHARS),
                reference: truncate_chars(reference, MAX_REFERENCE_CHARS),
            });
        }
    }
    cases
}

fn judge_rubric(reference: &str) -> String {
    format!(
        "The output answers a request that this agent already handled in production. \
         Its production reply is the reference below. Score how well the output \
         accomplishes the same task: equally correct, complete, and useful scores 1; \
         missing or wrong substance scores lower. Wording and length differences do \
         not matter.\n\nReference reply:\n\"\"\"\n{reference}\n\"\"\""
    )
}

/// Body for Core's `POST /api/gateway/evals/run` (the Gateway's `/v1/evals/run`)
/// that replays `cases` on every model in `models` under one fixed judge.
pub fn eval_request(
    agent_id: &str,
    system_prompt: Option<&str>,
    cases: &[ReplayCase],
    models: &[String],
    judge_model: &str,
) -> Value {
    let dataset: Vec<Value> = cases
        .iter()
        .map(|case| {
            json!({
                "id": case.id,
                "prompt": case.prompt,
                "assertions": [{
                    "kind": "llm_judge",
                    "rubric": judge_rubric(&case.reference),
                }],
            })
        })
        .collect();
    let mut body = json!({
        "agent_id": agent_id,
        "model": models.first().cloned().unwrap_or_default(),
        "models": models,
        "judge_model": judge_model,
        "dataset": dataset,
        "max_concurrency": 4,
        "tags": { "source": "optimizer" },
    });
    if let Some(prompt) = system_prompt.map(str::trim).filter(|p| !p.is_empty()) {
        body["system_prompt"] = Value::String(prompt.to_owned());
    }
    body
}

/// One model's replay result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelScore {
    pub model: String,
    /// Mean judge score in `[0, 1]` over the cases the judge scored.
    pub quality: Option<f64>,
    /// Total replay cost; `None` when any case was unpriced.
    pub cost_micro_usd: Option<u64>,
    pub cases: usize,
    pub errors: usize,
    pub mean_latency_ms: Option<u64>,
}

impl ModelScore {
    fn error_rate(&self) -> f64 {
        if self.cases == 0 {
            1.0
        } else {
            self.errors as f64 / self.cases as f64
        }
    }
}

/// Read per-model results from a `/v1/evals/run` response. Both the multi-model
/// `models[]` breakdown and the single-model top-level shape are accepted.
pub fn model_scores(response: &Value) -> Vec<ModelScore> {
    if let Some(models) = response.get("models").and_then(Value::as_array) {
        return models
            .iter()
            .filter_map(|entry| {
                let model = entry.get("model")?.as_str()?.to_owned();
                Some(score_cases(model, entry))
            })
            .collect();
    }
    let model = response
        .get("cases")
        .and_then(Value::as_array)
        .and_then(|cases| cases.first())
        .and_then(|case| case.get("model"))
        .and_then(Value::as_str);
    match model {
        Some(model) => vec![score_cases(model.to_owned(), response)],
        None => Vec::new(),
    }
}

fn score_cases(model: String, entry: &Value) -> ModelScore {
    let cases: &[Value] = entry
        .get("cases")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice);
    let mut judged = Vec::new();
    let mut errors = 0;
    let mut latency_total = 0_u64;
    let mut cost_total = Some(0_u64);
    for case in cases {
        if case.get("error").is_some_and(|error| !error.is_null()) {
            errors += 1;
        }
        latency_total += case.get("latency_ms").and_then(Value::as_u64).unwrap_or(0);
        cost_total = match (
            cost_total,
            case.get("cost_micro_usd").and_then(Value::as_u64),
        ) {
            (Some(total), Some(cost)) => Some(total + cost),
            _ => None,
        };
        let executed = case
            .get("assertions")
            .and_then(Value::as_array)
            .is_some_and(|results| {
                results
                    .iter()
                    .any(|result| result.get("executed").and_then(Value::as_bool) == Some(true))
            });
        if executed {
            if let Some(score) = case.get("assertion_score").and_then(Value::as_f64) {
                judged.push(score.clamp(0.0, 1.0));
            }
        }
    }
    let count = cases.len();
    ModelScore {
        model,
        quality: (!judged.is_empty()).then(|| judged.iter().sum::<f64>() / judged.len() as f64),
        cost_micro_usd: if count == 0 { None } else { cost_total },
        cases: count,
        errors,
        mean_latency_ms: (count > 0).then(|| latency_total / count as u64),
    }
}

/// A model the node can route to, with its list price when known.
#[derive(Debug, Clone, PartialEq)]
pub struct PricedModel {
    pub id: String,
    /// USD per 1M input tokens.
    pub input_per_1m: Option<f64>,
    /// USD per 1M output tokens.
    pub output_per_1m: Option<f64>,
    /// Whether the model supports tool calls, when known.
    pub tool_call: Option<bool>,
}

impl PricedModel {
    /// Price of a typical agent turn, weighting input 3:1 over output.
    fn blended(&self) -> Option<f64> {
        Some(self.input_per_1m? * 0.75 + self.output_per_1m? * 0.25)
    }
}

/// Choose up to `max` cheaper models worth replaying. Candidates must have a
/// known price below the current model's; the closest-priced ones come first
/// because they are the likeliest to hold quality. When the agent uses tools, a
/// model known not to support tool calls is excluded.
pub fn pick_candidates(
    current: &PricedModel,
    available: &[PricedModel],
    needs_tools: bool,
    max: usize,
) -> Vec<String> {
    let Some(current_price) = current.blended() else {
        return Vec::new();
    };
    let mut cheaper: Vec<(f64, &PricedModel)> = available
        .iter()
        .filter(|model| model.id != current.id)
        .filter(|model| !(needs_tools && model.tool_call == Some(false)))
        .filter_map(|model| model.blended().map(|price| (price, model)))
        .filter(|(price, _)| *price < current_price)
        .collect();
    cheaper.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.id.cmp(&b.1.id)));
    let mut seen = BTreeSet::new();
    cheaper
        .into_iter()
        .filter(|(_, model)| seen.insert(model.id.clone()))
        .take(max)
        .map(|(_, model)| model.id.clone())
        .collect()
}

// ── Recommendations ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecommendationKind {
    Model,
    Tools,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecommendationStatus {
    Pending,
    Applied,
    Dismissed,
    /// A newer analysis replaced this pending recommendation.
    Superseded,
}

/// The configuration change a recommendation would make.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Change {
    SetModel {
        from: String,
        to: String,
    },
    RemoveTools {
        remove: Vec<String>,
        keep: Vec<String>,
    },
}

/// What the recommendation is based on.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub sessions: usize,
    /// Replayed turns (model recommendations only).
    #[serde(default)]
    pub cases: usize,
    /// True when the change was replayed and judged, false for usage evidence.
    pub verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_quality: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_quality: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_cost_micro_usd: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_cost_micro_usd: Option<u64>,
    /// Fractional cost reduction in `[0, 1]`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub savings: Option<f64>,
    /// Every model the analysis replayed, current model first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<ModelScore>,
    /// Calls per allowed tool across the sessions read.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tool_calls: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recommendation {
    pub id: String,
    pub agent_id: String,
    pub kind: RecommendationKind,
    pub status: RecommendationStatus,
    pub title: String,
    pub summary: String,
    pub change: Change,
    pub evidence: Evidence,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<String>,
}

fn new_id() -> String {
    format!("opt_{}", uuid::Uuid::new_v4().simple())
}

fn percent(value: f64) -> String {
    format!("{}%", (value * 100.0).round() as i64)
}

/// Recommend the cheapest candidate whose judged quality stays within
/// `tolerance` of the current model's own replay. `None` when the current model
/// has no usable baseline or no candidate clears the bar.
pub fn recommend_model(
    agent_id: &str,
    current_model: &str,
    scores: &[ModelScore],
    tolerance: f64,
    sessions: usize,
    now: &str,
) -> Option<Recommendation> {
    let baseline = scores.iter().find(|score| score.model == current_model)?;
    let baseline_quality = baseline.quality?;
    let baseline_cost = baseline.cost_micro_usd.filter(|cost| *cost > 0)?;
    if baseline.error_rate() > MAX_ERROR_RATE {
        return None;
    }
    let best = scores
        .iter()
        .filter(|score| score.model != current_model)
        .filter(|score| score.error_rate() <= MAX_ERROR_RATE)
        .filter_map(|score| Some((score, score.quality?, score.cost_micro_usd?)))
        .filter(|(_, quality, _)| *quality + tolerance >= baseline_quality)
        .filter(|(_, _, cost)| (*cost as f64) <= baseline_cost as f64 * (1.0 - MIN_SAVINGS))
        .min_by(|a, b| a.2.cmp(&b.2).then_with(|| b.1.total_cmp(&a.1)))?;
    let (candidate, candidate_quality, candidate_cost) = best;
    let savings = 1.0 - candidate_cost as f64 / baseline_cost as f64;
    let mut models: Vec<ModelScore> = vec![baseline.clone()];
    models.extend(
        scores
            .iter()
            .filter(|score| score.model != current_model)
            .cloned(),
    );
    Some(Recommendation {
        id: new_id(),
        agent_id: agent_id.to_owned(),
        kind: RecommendationKind::Model,
        status: RecommendationStatus::Pending,
        title: format!("Switch to {}", candidate.model),
        summary: format!(
            "Replaying {} recent requests, {} cost {} less than {} and scored {} against the agent's production replies (current model: {}).",
            baseline.cases,
            candidate.model,
            percent(savings),
            current_model,
            percent(candidate_quality),
            percent(baseline_quality),
        ),
        change: Change::SetModel {
            from: current_model.to_owned(),
            to: candidate.model.clone(),
        },
        evidence: Evidence {
            sessions,
            cases: baseline.cases,
            verified: true,
            baseline_quality: Some(baseline_quality),
            candidate_quality: Some(candidate_quality),
            baseline_cost_micro_usd: Some(baseline_cost),
            candidate_cost_micro_usd: Some(candidate_cost),
            savings: Some(savings),
            models,
            tool_calls: BTreeMap::new(),
        },
        created_at: now.to_owned(),
        decided_at: None,
    })
}

/// Normalize a tool id so `server.tool`, `server__tool`, `mcp__server__tool`, and
/// `server:tool` compare alike.
fn normalize_tool(name: &str) -> String {
    let lowered = name.trim().to_ascii_lowercase();
    let unified = lowered.replace("__", ".").replace([':', '/'], ".");
    unified
        .strip_prefix("mcp.")
        .map_or(unified.clone(), str::to_owned)
}

/// Whether an observed call is covered by an allow-list entry. An entry may name
/// one tool (`server.tool`) or a whole server (`server`).
fn entry_covers(entry: &str, observed: &str) -> bool {
    let entry = normalize_tool(entry);
    let observed = normalize_tool(observed);
    observed == entry
        || observed.starts_with(&format!("{entry}."))
        || observed.ends_with(&format!(".{entry}"))
}

/// Recommend removing allowed tools that no session called. Agents allowed every
/// tool (`*`, or the legacy empty list) or none are skipped: there is no finite
/// list to narrow.
pub fn recommend_tools(
    agent_id: &str,
    allowed: &[String],
    sessions: &[Session],
    now: &str,
) -> Option<Recommendation> {
    let entries: Vec<&String> = allowed
        .iter()
        .filter(|tool| !tool.trim().is_empty())
        .collect();
    if entries.is_empty()
        || entries
            .iter()
            .any(|tool| tool.as_str() == ALL_TOOLS || tool.as_str() == NO_TOOLS)
    {
        return None;
    }
    let observed: Vec<&str> = sessions.iter().flat_map(Session::tool_names).collect();
    let mut tool_calls = BTreeMap::new();
    for entry in &entries {
        let count = observed
            .iter()
            .filter(|name| entry_covers(entry, name))
            .count();
        tool_calls.insert((*entry).clone(), count);
    }
    let (remove, keep): (Vec<String>, Vec<String>) = entries
        .iter()
        .map(|entry| (*entry).clone())
        .partition(|entry| tool_calls.get(entry).copied().unwrap_or(0) == 0);
    if remove.is_empty() {
        return None;
    }
    let session_count = readiness(sessions).sessions;
    let title = if remove.len() == 1 {
        format!("Remove the unused tool {}", remove[0])
    } else {
        format!("Remove {} unused tools", remove.len())
    };
    Some(Recommendation {
        id: new_id(),
        agent_id: agent_id.to_owned(),
        kind: RecommendationKind::Tools,
        status: RecommendationStatus::Pending,
        title,
        summary: format!(
            "The agent never called {} in its last {session_count} sessions. Each allowed tool adds its description to every request, so removing unused ones cuts input tokens. This is based on usage, not a replay.",
            remove.join(", "),
        ),
        change: Change::RemoveTools { remove, keep },
        evidence: Evidence {
            sessions: session_count,
            verified: false,
            tool_calls,
            ..Evidence::default()
        },
        created_at: now.to_owned(),
        decided_at: None,
    })
}

// ── Durable store ────────────────────────────────────────────────────────────

/// One analysis pass and what it could not do.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub agent_id: String,
    pub at: String,
    pub sessions: usize,
    #[serde(default)]
    pub cases: usize,
    #[serde(default)]
    pub candidates: Vec<String>,
    /// Plain-language reasons a check was skipped or found nothing.
    #[serde(default)]
    pub notes: Vec<String>,
    #[serde(default)]
    pub recommendation_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreDoc {
    #[serde(default)]
    pub recommendations: Vec<Recommendation>,
    #[serde(default)]
    pub analyses: Vec<Analysis>,
}

/// An agent's optimizer state as the API returns it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOptimizations {
    pub recommendations: Vec<Recommendation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_analysis: Option<Analysis>,
}

/// Read one agent's recommendations (newest first) and its latest analysis.
pub fn load(path: &Path, agent_id: &str) -> Result<AgentOptimizations> {
    let doc: StoreDoc = ryu_json_store::read_or_default(path)?;
    Ok(project(&doc, agent_id))
}

fn project(doc: &StoreDoc, agent_id: &str) -> AgentOptimizations {
    AgentOptimizations {
        recommendations: doc
            .recommendations
            .iter()
            .filter(|rec| rec.agent_id == agent_id)
            .cloned()
            .collect(),
        last_analysis: doc
            .analyses
            .iter()
            .find(|analysis| analysis.agent_id == agent_id)
            .cloned(),
    }
}

/// Record an analysis. Its recommendations supersede the agent's pending ones
/// of the same kind, so the list only ever offers the latest evidence.
pub fn record_analysis(
    path: &Path,
    mut analysis: Analysis,
    recommendations: Vec<Recommendation>,
) -> Result<AgentOptimizations> {
    ryu_json_store::mutate(path, |doc: &mut StoreDoc| {
        let agent_id = analysis.agent_id.clone();
        let kinds: BTreeSet<_> = recommendations
            .iter()
            .map(|rec| kind_key(rec.kind))
            .collect();
        for rec in &mut doc.recommendations {
            if rec.agent_id == agent_id
                && rec.status == RecommendationStatus::Pending
                && kinds.contains(kind_key(rec.kind))
            {
                rec.status = RecommendationStatus::Superseded;
                rec.decided_at = Some(analysis.at.clone());
            }
        }
        analysis.recommendation_ids = recommendations.iter().map(|rec| rec.id.clone()).collect();
        let mut merged = recommendations;
        merged.append(&mut doc.recommendations);
        doc.recommendations = cap_per_agent(merged, MAX_RECOMMENDATIONS_PER_AGENT, |rec| {
            rec.agent_id.as_str()
        });
        let mut analyses = vec![analysis];
        analyses.append(&mut doc.analyses);
        doc.analyses = cap_per_agent(analyses, MAX_ANALYSES_PER_AGENT, |a| a.agent_id.as_str());
        Ok(project(doc, &agent_id))
    })
}

fn kind_key(kind: RecommendationKind) -> &'static str {
    match kind {
        RecommendationKind::Model => "model",
        RecommendationKind::Tools => "tools",
    }
}

fn cap_per_agent<T>(items: Vec<T>, cap: usize, agent: impl Fn(&T) -> &str) -> Vec<T> {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    items
        .into_iter()
        .filter(|item| {
            let count = counts.entry(agent(item).to_owned()).or_default();
            *count += 1;
            *count <= cap
        })
        .collect()
}

/// Read one pending recommendation for `agent_id`.
pub fn pending(path: &Path, agent_id: &str, id: &str) -> Result<Recommendation> {
    let doc: StoreDoc = ryu_json_store::read_or_default(path)?;
    let rec = doc
        .recommendations
        .into_iter()
        .find(|rec| rec.id == id && rec.agent_id == agent_id)
        .ok_or_else(|| anyhow!("recommendation not found"))?;
    if rec.status != RecommendationStatus::Pending {
        return Err(anyhow!("recommendation is no longer pending"));
    }
    Ok(rec)
}

/// Mark a pending recommendation applied or dismissed.
pub fn decide(
    path: &Path,
    agent_id: &str,
    id: &str,
    status: RecommendationStatus,
    now: &str,
) -> Result<Recommendation> {
    if !matches!(
        status,
        RecommendationStatus::Applied | RecommendationStatus::Dismissed
    ) {
        return Err(anyhow!("a decision must apply or dismiss"));
    }
    ryu_json_store::mutate(path, |doc: &mut StoreDoc| {
        let rec = doc
            .recommendations
            .iter_mut()
            .find(|rec| rec.id == id && rec.agent_id == agent_id)
            .ok_or_else(|| anyhow!("recommendation not found"))?;
        if rec.status != RecommendationStatus::Pending {
            return Err(anyhow!("recommendation is no longer pending"));
        }
        rec.status = status;
        rec.decided_at = Some(now.to_owned());
        Ok(rec.clone())
    })
}

/// Project an already committed agent operation into the legacy JSON history.
/// The caller supplies the exact recommendation retained in its durable receipt;
/// this function records historical application and never creates a pending action.
pub fn project_applied_receipt(
    path: &Path,
    receipt: &Recommendation,
    committed_at: &str,
) -> Result<Recommendation> {
    if receipt.status != RecommendationStatus::Pending
        || receipt.decided_at.is_some()
        || receipt.id.is_empty()
        || receipt.agent_id.is_empty()
        || committed_at.is_empty()
    {
        return Err(anyhow!("invalid committed recommendation receipt"));
    }
    ryu_json_store::mutate(path, |doc: &mut StoreDoc| {
        let mut applied = receipt.clone();
        applied.status = RecommendationStatus::Applied;
        applied.decided_at = Some(committed_at.to_owned());
        if let Some(existing) = doc
            .recommendations
            .iter_mut()
            .find(|rec| rec.id == receipt.id)
        {
            let mut authored = existing.clone();
            authored.status = RecommendationStatus::Pending;
            authored.decided_at = None;
            if authored != *receipt {
                return Err(anyhow!(
                    "committed recommendation receipt does not match stored evidence"
                ));
            }
            *existing = applied.clone();
        } else {
            // Retain normal bounded history. An old evicted receipt does not
            // push a newer analysis or pending action out of the window.
            doc.recommendations.push(applied.clone());
            doc.recommendations = cap_per_agent(
                std::mem::take(&mut doc.recommendations),
                MAX_RECOMMENDATIONS_PER_AGENT,
                |rec| rec.agent_id.as_str(),
            );
        }
        Ok(applied)
    })
}

fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-09-30T00:00:00Z";

    fn turn(prompt: &str, reference: &str, tools: &[&str]) -> Turn {
        Turn {
            prompt: prompt.to_owned(),
            reference: reference.to_owned(),
            tools: tools.iter().map(|tool| (*tool).to_owned()).collect(),
        }
    }

    fn session(id: &str, turns: Vec<Turn>) -> Session {
        Session {
            id: id.to_owned(),
            turns,
            tool_calls: Vec::new(),
        }
    }

    fn score(model: &str, quality: f64, cost: u64) -> ModelScore {
        ModelScore {
            model: model.to_owned(),
            quality: Some(quality),
            cost_micro_usd: Some(cost),
            cases: 10,
            errors: 0,
            mean_latency_ms: Some(900),
        }
    }

    fn priced(id: &str, input: f64, output: f64) -> PricedModel {
        PricedModel {
            id: id.to_owned(),
            input_per_1m: Some(input),
            output_per_1m: Some(output),
            tool_call: Some(true),
        }
    }

    #[test]
    fn receipt_projection_preserves_newer_pending_and_refuses_mismatched_evidence() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("legacy-optimizer.json");
        let receipt = Recommendation {
            id: "old-operation".into(),
            agent_id: "agent-1".into(),
            kind: RecommendationKind::Tools,
            status: RecommendationStatus::Pending,
            title: "Narrow unused tools".into(),
            summary: "Recorded usage evidence".into(),
            change: Change::RemoveTools {
                remove: vec!["slack.post".into()],
                keep: vec!["search.web".into()],
            },
            evidence: Evidence {
                sessions: 20,
                ..Default::default()
            },
            created_at: NOW.into(),
            decided_at: None,
        };
        for id in ["old-operation", "new-analysis"] {
            let mut rec = receipt.clone();
            rec.id = id.into();
            record_analysis(
                &path,
                Analysis {
                    agent_id: "agent-1".into(),
                    at: NOW.into(),
                    sessions: 20,
                    cases: 0,
                    candidates: Vec::new(),
                    notes: Vec::new(),
                    recommendation_ids: Vec::new(),
                },
                vec![rec],
            )
            .unwrap();
        }
        assert_eq!(
            load(&path, "agent-1").unwrap().recommendations[1].status,
            RecommendationStatus::Superseded
        );
        let applied = project_applied_receipt(&path, &receipt, NOW).unwrap();
        assert_eq!(applied.status, RecommendationStatus::Applied);
        let state = load(&path, "agent-1").unwrap();
        assert_eq!(state.recommendations[0].id, "new-analysis");
        assert_eq!(
            state.recommendations[0].status,
            RecommendationStatus::Pending
        );
        assert_eq!(state.recommendations[1], applied);
        let before = std::fs::read(&path).unwrap();
        assert_eq!(
            project_applied_receipt(&path, &receipt, NOW).unwrap(),
            applied
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let mut changed_evidence = receipt.clone();
        changed_evidence.evidence.sessions = 99;
        assert!(project_applied_receipt(&path, &changed_evidence, NOW).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let mut foreign_agent = receipt.clone();
        foreign_agent.agent_id = "other-agent".into();
        assert!(project_applied_receipt(&path, &foreign_agent, NOW).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn historical_receipt_projection_keeps_bounded_window_and_never_recreates_pending_actions() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("legacy-optimizer.json");
        let original = Recommendation {
            id: "old-operation".into(),
            agent_id: "agent-1".into(),
            kind: RecommendationKind::Model,
            status: RecommendationStatus::Pending,
            title: "Cheaper model".into(),
            summary: "Recorded replay evidence".into(),
            change: Change::SetModel {
                from: "big".into(),
                to: "small".into(),
            },
            evidence: Evidence::default(),
            created_at: NOW.into(),
            decided_at: None,
        };
        for index in 0..=MAX_RECOMMENDATIONS_PER_AGENT {
            let mut recommendation = original.clone();
            if index != 0 {
                recommendation.id = format!("new-analysis-{index}");
            }
            record_analysis(
                &path,
                Analysis {
                    agent_id: "agent-1".into(),
                    at: NOW.into(),
                    sessions: 20,
                    cases: 10,
                    candidates: Vec::new(),
                    notes: Vec::new(),
                    recommendation_ids: Vec::new(),
                },
                vec![recommendation],
            )
            .unwrap();
        }
        let before = load(&path, "agent-1").unwrap();
        assert_eq!(before.recommendations.len(), MAX_RECOMMENDATIONS_PER_AGENT);
        assert!(!before
            .recommendations
            .iter()
            .any(|rec| rec.id == original.id));
        let historical = project_applied_receipt(&path, &original, NOW).unwrap();
        assert_eq!(historical.status, RecommendationStatus::Applied);
        assert_eq!(load(&path, "agent-1").unwrap(), before);
        std::fs::write(&path, "{corrupt").unwrap();
        assert!(project_applied_receipt(&path, &original, NOW).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{corrupt");
    }

    #[test]
    fn tools_are_read_from_static_and_dynamic_parts() {
        let parts = json!([
            { "type": "text", "text": "hi" },
            { "type": "tool-search.web", "state": "output-available" },
            { "type": "dynamic-tool", "toolName": "github.create_issue" },
            { "type": "tool-" },
        ]);
        assert_eq!(
            tools_from_parts(&parts),
            vec!["search.web".to_owned(), "github.create_issue".to_owned()]
        );
        assert!(tools_from_parts(&Value::Null).is_empty());
    }

    #[test]
    fn readiness_counts_only_sessions_with_turns() {
        let mut sessions: Vec<Session> = (0..9)
            .map(|i| session(&format!("c{i}"), vec![turn("q", "a", &[])]))
            .collect();
        sessions.push(session("empty", Vec::new()));
        assert!(!readiness(&sessions).ready);
        sessions.push(session("c9", vec![turn("q", "a", &[])]));
        let state = readiness(&sessions);
        assert_eq!(state.sessions, 10);
        assert!(state.ready);
    }

    #[test]
    fn replay_skips_tool_turns_duplicates_and_blanks() {
        let sessions = vec![
            session(
                "c1",
                vec![
                    turn("summarize this", "a summary", &[]),
                    turn("look it up", "found it", &["search.web"]),
                    turn("  ", "orphan", &[]),
                ],
            ),
            session(
                "c2",
                vec![
                    turn("summarize this", "again", &[]),
                    turn("draft a reply", "a reply", &[]),
                ],
            ),
        ];
        let cases = replay_cases(&sessions, 10);
        let ids: Vec<_> = cases.iter().map(|case| case.id.as_str()).collect();
        assert_eq!(ids, vec!["c1#0", "c2#1"]);
        assert_eq!(replay_cases(&sessions, 1).len(), 1);
    }

    #[test]
    fn eval_request_uses_one_judge_and_embeds_the_reference() {
        let cases = vec![ReplayCase {
            id: "c1#0".into(),
            prompt: "summarize".into(),
            reference: "the production summary".into(),
        }];
        let models = vec!["big".to_owned(), "small".to_owned()];
        let body = eval_request("agent-1", Some("Be brief."), &cases, &models, "big");
        assert_eq!(body["models"], json!(["big", "small"]));
        assert_eq!(body["judge_model"], "big");
        assert_eq!(body["system_prompt"], "Be brief.");
        assert_eq!(body["dataset"][0]["assertions"][0]["kind"], "llm_judge");
        assert!(body["dataset"][0]["assertions"][0]["rubric"]
            .as_str()
            .unwrap()
            .contains("the production summary"));
        let bare = eval_request("agent-1", Some("  "), &cases, &models, "big");
        assert!(bare.get("system_prompt").is_none());
    }

    #[test]
    fn model_scores_read_the_multi_model_breakdown() {
        let judged = |score: f64, cost: Option<u64>, error: Option<&str>| {
            json!({
                "assertion_score": score,
                "assertions": [{ "kind": "llm_judge", "executed": true, "score": score }],
                "cost_micro_usd": cost,
                "latency_ms": 1000,
                "error": error,
            })
        };
        let response = json!({
            "models": [
                { "model": "big", "cases": [judged(0.9, Some(300), None), judged(0.7, Some(100), None)] },
                { "model": "small", "cases": [judged(0.8, Some(40), None), judged(0.0, None, Some("timeout"))] },
            ]
        });
        let scores = model_scores(&response);
        assert_eq!(scores.len(), 2);
        assert_eq!(scores[0].quality, Some(0.8));
        assert_eq!(scores[0].cost_micro_usd, Some(400));
        assert_eq!(scores[0].mean_latency_ms, Some(1000));
        assert_eq!(scores[1].errors, 1);
        assert_eq!(scores[1].cost_micro_usd, None);
    }

    #[test]
    fn unexecuted_judges_do_not_count_toward_quality() {
        let response = json!({
            "cases": [{
                "model": "big",
                "assertion_score": 0.0,
                "assertions": [{ "kind": "llm_judge", "executed": false }],
                "cost_micro_usd": 10,
                "latency_ms": 5,
            }]
        });
        let scores = model_scores(&response);
        assert_eq!(scores[0].model, "big");
        assert_eq!(scores[0].quality, None);
    }

    #[test]
    fn candidates_are_cheaper_closest_first_and_tool_capable() {
        let current = priced("big", 10.0, 30.0);
        let mut no_tools = priced("cheap-no-tools", 1.0, 2.0);
        no_tools.tool_call = Some(false);
        let available = vec![
            priced("big", 10.0, 30.0),
            priced("mid", 3.0, 15.0),
            priced("small", 0.5, 1.5),
            priced("pricier", 15.0, 60.0),
            no_tools,
            PricedModel {
                id: "unpriced".into(),
                input_per_1m: None,
                output_per_1m: None,
                tool_call: None,
            },
        ];
        assert_eq!(
            pick_candidates(&current, &available, true, 3),
            vec!["mid".to_owned(), "small".to_owned()]
        );
        assert_eq!(
            pick_candidates(&current, &available, false, 2),
            vec!["mid".to_owned(), "cheap-no-tools".to_owned()]
        );
        let unknown = PricedModel {
            id: "local".into(),
            input_per_1m: None,
            output_per_1m: None,
            tool_call: None,
        };
        assert!(pick_candidates(&unknown, &available, false, 3).is_empty());
    }

    #[test]
    fn model_recommendation_takes_the_cheapest_candidate_that_holds_quality() {
        let scores = vec![
            score("big", 0.86, 1_000),
            score("mid", 0.84, 450),
            score("small", 0.70, 100),
        ];
        let rec = recommend_model(
            "agent-1",
            "big",
            &scores,
            DEFAULT_QUALITY_TOLERANCE,
            12,
            NOW,
        )
        .expect("mid holds quality");
        assert_eq!(
            rec.change,
            Change::SetModel {
                from: "big".into(),
                to: "mid".into()
            }
        );
        assert!(rec.evidence.verified);
        assert_eq!(rec.evidence.models[0].model, "big");
        assert!((rec.evidence.savings.unwrap() - 0.55).abs() < 1e-9);
        assert!(rec.summary.contains("55%"));
    }

    #[test]
    fn model_recommendation_requires_a_baseline_and_real_savings() {
        let scores = vec![score("big", 0.9, 1_000), score("mid", 0.9, 950)];
        assert!(recommend_model("a", "big", &scores, 0.05, 12, NOW).is_none());
        assert!(recommend_model("a", "absent", &scores, 0.05, 12, NOW).is_none());
        let mut flaky = score("small", 0.95, 100);
        flaky.errors = 5;
        let scores = vec![score("big", 0.9, 1_000), flaky];
        assert!(recommend_model("a", "big", &scores, 0.05, 12, NOW).is_none());
    }

    #[test]
    fn tool_recommendation_lists_unused_tools_and_keeps_used_ones() {
        let mut first = session("c1", vec![turn("q", "a", &["mcp__github__create_issue"])]);
        first.tool_calls.push("search.web".into());
        let sessions = vec![first, session("c2", vec![turn("q", "a", &[])])];
        let allowed = vec![
            "github".to_owned(),
            "search.web".to_owned(),
            "slack.post_message".to_owned(),
        ];
        let rec = recommend_tools("agent-1", &allowed, &sessions, NOW).expect("slack unused");
        assert_eq!(
            rec.change,
            Change::RemoveTools {
                remove: vec!["slack.post_message".into()],
                keep: vec!["github".into(), "search.web".into()],
            }
        );
        assert!(!rec.evidence.verified);
        assert_eq!(rec.evidence.tool_calls["github"], 1);
        assert_eq!(rec.title, "Remove the unused tool slack.post_message");
    }

    #[test]
    fn tool_recommendation_skips_open_ended_or_fully_used_lists() {
        let sessions = vec![session("c1", vec![turn("q", "a", &["search.web"])])];
        for allowed in [
            vec![],
            vec!["*".to_owned()],
            vec!["__ryu_none__".to_owned()],
            vec!["search.web".to_owned()],
        ] {
            assert!(recommend_tools("a", &allowed, &sessions, NOW).is_none());
        }
    }

    #[test]
    fn store_supersedes_pending_and_records_decisions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("optimizer.json");
        let sessions = vec![session("c1", vec![turn("q", "a", &[])])];
        let allowed = vec!["slack.post".to_owned()];
        let analysis = |at: &str| Analysis {
            agent_id: "agent-1".into(),
            at: at.into(),
            sessions: 1,
            cases: 0,
            candidates: Vec::new(),
            notes: Vec::new(),
            recommendation_ids: Vec::new(),
        };

        let first = recommend_tools("agent-1", &allowed, &sessions, NOW).unwrap();
        let first_id = first.id.clone();
        record_analysis(&path, analysis("t1"), vec![first]).unwrap();
        let second = recommend_tools("agent-1", &allowed, &sessions, NOW).unwrap();
        let second_id = second.id.clone();
        let state = record_analysis(&path, analysis("t2"), vec![second]).unwrap();

        assert_eq!(state.recommendations[0].id, second_id);
        assert_eq!(
            state.recommendations[1].status,
            RecommendationStatus::Superseded
        );
        assert_eq!(state.last_analysis.unwrap().at, "t2");
        assert!(pending(&path, "agent-1", &first_id).is_err());
        assert!(pending(&path, "other", &second_id).is_err());

        let applied = decide(
            &path,
            "agent-1",
            &second_id,
            RecommendationStatus::Applied,
            "t3",
        )
        .unwrap();
        assert_eq!(applied.status, RecommendationStatus::Applied);
        assert!(decide(
            &path,
            "agent-1",
            &second_id,
            RecommendationStatus::Dismissed,
            "t4"
        )
        .is_err());
        assert!(load(&path, "other").unwrap().recommendations.is_empty());
    }
}
