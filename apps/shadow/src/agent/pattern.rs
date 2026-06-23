use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::llm::{orchestrator::LlmOrchestrator, LlmMessage, LlmRequest};
use crate::utils::{extract_json, wall_micros};

// ── Types ────────────────────────────────────────────────────────────────────

/// A single generalized step inside an AgentPattern.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatternStep {
    pub tool_name: String,
    pub purpose: String,
    pub key_arguments: Vec<String>,
    pub expected_outcome: String,
}

/// A generalized agent interaction pattern extracted from successful runs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentPattern {
    pub id: String,
    pub task_description: String,
    pub target_app: Option<String>,
    pub url_pattern: Option<String>,
    pub steps: Vec<PatternStep>,
    pub notes: String,
    pub success_count: u32,
    pub failure_count: u32,
    pub created_at: u64,
    pub last_used: u64,
}

// ── PatternStore ─────────────────────────────────────────────────────────────

/// Persists patterns as JSON files under `~/.shadow/data/patterns/`.
pub struct PatternStore {
    dir: PathBuf,
    cache: Option<Vec<AgentPattern>>,
}

impl PatternStore {
    pub fn new(dir: &Path) -> Self {
        std::fs::create_dir_all(dir).ok();
        Self {
            dir: dir.to_path_buf(),
            cache: None,
        }
    }

    /// Save a pattern to disk, overwriting if the ID already exists.
    pub fn save(&mut self, pattern: &AgentPattern) {
        let path = self.dir.join(format!("{}.json", pattern.id));
        if let Ok(json) = serde_json::to_string_pretty(pattern) {
            let _ = std::fs::write(path, json);
        }
        self.cache = None; // invalidate cache
    }

    /// Load all patterns from disk (lazy-cached).
    pub fn load_all(&mut self) -> &[AgentPattern] {
        if self.cache.is_none() {
            let mut patterns = Vec::new();
            if let Ok(dir) = std::fs::read_dir(&self.dir) {
                for entry in dir.flatten() {
                    if entry.path().extension().and_then(|e| e.to_str()) == Some("json") {
                        if let Ok(text) = std::fs::read_to_string(entry.path()) {
                            if let Ok(p) = serde_json::from_str::<AgentPattern>(&text) {
                                // Skip archived patterns (failure_count > success_count*2 + 2)
                                if p.failure_count <= p.success_count * 2 + 2 {
                                    patterns.push(p);
                                }
                            }
                        }
                    }
                }
            }
            self.cache = Some(patterns);
        }
        self.cache.as_deref().unwrap_or(&[])
    }

    /// Find patterns relevant to the current context.
    /// Scores by keyword overlap, app match, and recency.
    pub fn find_relevant(
        &mut self,
        query: &str,
        app: &str,
        limit: usize,
    ) -> Vec<(AgentPattern, f32)> {
        let patterns = self.load_all().to_vec();
        let query_lower = query.to_lowercase();
        let query_words: Vec<&str> = query_lower
            .split_whitespace()
            .filter(|w| w.len() > 2)
            .collect();
        let app_lower = app.to_lowercase();
        let now = wall_micros();

        let mut scored: Vec<(AgentPattern, f32)> = patterns
            .into_iter()
            .filter_map(|p| {
                let score = score_pattern(&p, &query_words, &app_lower, now);
                if score > 0.0 {
                    Some((p, score))
                } else {
                    None
                }
            })
            .collect();

        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);
        scored
    }

    /// Increment success or failure count and persist.
    pub fn record_outcome(&mut self, id: &str, success: bool) {
        let path = self.dir.join(format!("{}.json", id));
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(mut p) = serde_json::from_str::<AgentPattern>(&text) {
                if success {
                    p.success_count += 1;
                } else {
                    p.failure_count += 1;
                }
                p.last_used = wall_micros();
                if let Ok(json) = serde_json::to_string_pretty(&p) {
                    let _ = std::fs::write(&path, json);
                }
                self.cache = None;
            }
        }
    }

    /// Format the top-N relevant patterns as a prompt injection block.
    pub fn format_for_prompt(&mut self, query: &str, app: &str) -> String {
        let relevant = self.find_relevant(query, app, 3);
        if relevant.is_empty() {
            return String::new();
        }
        let lines: Vec<String> = relevant
            .iter()
            .map(|(p, _)| {
                let steps_summary: Vec<String> = p
                    .steps
                    .iter()
                    .map(|s| format!("{}: {}", s.tool_name, s.purpose))
                    .collect();
                format!(
                    "Pattern: {}\nApp: {}\nSteps: {}\nNotes: {}",
                    p.task_description,
                    p.target_app.as_deref().unwrap_or("any"),
                    steps_summary.join(" → "),
                    p.notes,
                )
            })
            .collect();
        format!("Relevant past patterns:\n{}", lines.join("\n---\n"))
    }
}

fn score_pattern(p: &AgentPattern, query_words: &[&str], app_lower: &str, now_us: u64) -> f32 {
    let mut score = 0.0f32;
    let desc_lower = p.task_description.to_lowercase();

    // Keyword overlap
    let matched = query_words
        .iter()
        .filter(|w| desc_lower.contains(**w))
        .count();
    if !query_words.is_empty() {
        score += 0.5 * matched as f32 / query_words.len() as f32;
    }

    // App match
    if let Some(app) = &p.target_app {
        if app.to_lowercase() == app_lower {
            score += 0.3;
        }
    }

    // Recency bonus: +0.1 if used within last 24 hours
    const ONE_DAY_US: u64 = 24 * 60 * 60 * 1_000_000;
    if p.last_used > 0 && now_us.saturating_sub(p.last_used) < ONE_DAY_US {
        score += 0.1;
    }

    // Success weighting
    if p.success_count > 0 {
        score *= 1.0 + 0.1 * (p.success_count as f32).min(5.0) / 5.0;
    }

    score
}

// ── PatternExtractor ─────────────────────────────────────────────────────────

/// Extracts a generalized `AgentPattern` from a completed agent run.
pub struct PatternExtractor;

impl PatternExtractor {
    /// Extract a pattern from the run description and tool sequence.
    /// Returns `None` if the run is ineligible (< 3 AX tool calls).
    pub async fn extract(
        run_description: &str,
        tools_used: &[String],
        orchestrator: &LlmOrchestrator,
    ) -> Option<AgentPattern> {
        const MIN_AX_CALLS: usize = 3;

        let ax_count = tools_used.iter().filter(|t| t.starts_with("ax_")).count();

        if ax_count < MIN_AX_CALLS {
            return None;
        }

        let tool_sequence = tools_used.join(", ");

        let prompt = format!(
            "Generalize this agent run into a reusable pattern.\n\
             Replace specific values (names, queries, paths) with {{{{PLACEHOLDER}}}} parameters.\n\
             Respond with JSON only:\n\
             {{\"task_description\":\"...\",\"target_app\":\"...\",\"steps\":[\
             {{\"tool_name\":\"...\",\"purpose\":\"...\",\"key_arguments\":[\"...\"],\
             \"expected_outcome\":\"...\"}}],\"notes\":\"...\"}}\n\n\
             Run description: {}\nTools used: {}",
            run_description, tool_sequence
        );

        let resp = orchestrator
            .generate(LlmRequest {
                messages: vec![LlmMessage::user(prompt)],
                temperature: 0.2,
                max_tokens: 512,
                ..Default::default()
            })
            .await
            .ok()?;

        let text = resp.content?;
        let json_str = extract_json(&text)?;
        let v: serde_json::Value = serde_json::from_str(&json_str).ok()?;

        let steps: Vec<PatternStep> = v["steps"]
            .as_array()?
            .iter()
            .filter_map(|s| {
                Some(PatternStep {
                    tool_name: s["tool_name"].as_str()?.to_string(),
                    purpose: s["purpose"].as_str().unwrap_or("").to_string(),
                    key_arguments: s["key_arguments"]
                        .as_array()
                        .unwrap_or(&vec![])
                        .iter()
                        .filter_map(|a| a.as_str().map(str::to_string))
                        .collect(),
                    expected_outcome: s["expected_outcome"].as_str().unwrap_or("").to_string(),
                })
            })
            .collect();

        if steps.is_empty() {
            return None;
        }

        let now = wall_micros();
        Some(AgentPattern {
            id: uuid::Uuid::new_v4().to_string(),
            task_description: v["task_description"].as_str()?.to_string(),
            target_app: v["target_app"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            url_pattern: None,
            steps,
            notes: v["notes"].as_str().unwrap_or("").to_string(),
            success_count: 1,
            failure_count: 0,
            created_at: now,
            last_used: now,
        })
    }

    /// Heuristic fallback: build a pattern directly from the tool sequence.
    pub fn extract_heuristic(run_description: &str, tools_used: &[String]) -> Option<AgentPattern> {
        if tools_used.len() < 3 {
            return None;
        }
        let steps = tools_used
            .iter()
            .map(|t| PatternStep {
                tool_name: t.clone(),
                purpose: format!("Step: {}", t),
                key_arguments: vec![],
                expected_outcome: String::new(),
            })
            .collect();
        let now = wall_micros();
        Some(AgentPattern {
            id: uuid::Uuid::new_v4().to_string(),
            task_description: run_description.to_string(),
            target_app: None,
            url_pattern: None,
            steps,
            notes: String::new(),
            success_count: 1,
            failure_count: 0,
            created_at: now,
            last_used: now,
        })
    }
}

// ── PatternMatcher ────────────────────────────────────────────────────────────

pub struct PatternMatcher;

impl PatternMatcher {
    /// Find relevant patterns and format them for prompt injection.
    pub fn find_and_format(query: &str, app: &str, store: &mut PatternStore) -> String {
        store.format_for_prompt(query, app)
    }

    /// Record run outcome against a pattern.
    pub fn record_outcome(id: &str, success: bool, store: &mut PatternStore) {
        store.record_outcome(id, success);
    }
}
