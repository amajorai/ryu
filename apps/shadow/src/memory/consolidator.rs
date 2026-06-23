use anyhow::Result;
use sha2::{Digest, Sha256};

use super::semantic::{MemoryEntry, SemanticMemoryStore};
use crate::intelligence::context::EpisodeRecord;
use crate::llm::{orchestrator::LlmOrchestrator, LlmMessage, LlmRequest};
use crate::utils::wall_micros;

/// A fact extracted from episode history.
#[derive(Debug, Clone)]
pub struct ExtractedFact {
    pub id: String,
    pub category: String,
    pub content: String,
    pub confidence: f32,
}

/// Consolidates episodic memory into durable semantic facts.
pub struct SemanticConsolidator {
    last_consolidated_us: u64,
}

impl SemanticConsolidator {
    pub fn new() -> Self {
        Self {
            last_consolidated_us: 0,
        }
    }

    /// Extract facts from episodes using LLM (async, no store lock held).
    pub async fn extract_facts(
        &mut self,
        episodes: &[EpisodeRecord],
        orchestrator: &LlmOrchestrator,
    ) -> Vec<ExtractedFact> {
        if episodes.is_empty() {
            return vec![];
        }
        let newest_ep_ts = episodes.iter().map(|e| e.end_us).max().unwrap_or(0);
        if newest_ep_ts <= self.last_consolidated_us {
            return vec![];
        }
        self.last_consolidated_us = newest_ep_ts;
        extract_from_llm(episodes, orchestrator).await
    }

    /// Apply extracted facts to the store (sync, call after extract_facts).
    /// Returns number of facts upserted.
    pub fn apply_facts(
        &self,
        facts: &[ExtractedFact],
        store: &SemanticMemoryStore,
    ) -> Result<usize> {
        let mut upserted = 0;
        for fact in facts {
            let existing_conf = store
                .query(Some(&fact.category), &fact.content)
                .ok()
                .and_then(|mut v| v.drain(..).find(|e| e.id == fact.id))
                .map(|e| e.confidence);

            let final_confidence = match existing_conf {
                Some(prev) => (0.3 * prev + 0.7 * fact.confidence).min(1.0),
                None => fact.confidence,
            };

            let entry = MemoryEntry {
                id: fact.id.clone(),
                category: fact.category.clone(),
                content: fact.content.clone(),
                confidence: final_confidence,
                source_episode_id: None,
                access_count: 0,
                last_accessed: 0,
                created_at: wall_micros(),
            };
            store.upsert(&entry)?;
            upserted += 1;
        }
        Ok(upserted)
    }
}

impl Default for SemanticConsolidator {
    fn default() -> Self {
        Self::new()
    }
}

/// Deterministic ID from category + content (first 16 hex chars of sha256).
pub fn stable_id(category: &str, content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(category.as_bytes());
    hasher.update(b":");
    hasher.update(content.as_bytes());
    let result = hasher.finalize();
    format!("{:x}", result)[..16].to_string()
}

async fn extract_from_llm(
    episodes: &[EpisodeRecord],
    orchestrator: &LlmOrchestrator,
) -> Vec<ExtractedFact> {
    let summaries: Vec<String> = episodes
        .iter()
        .map(|e| format!("- {} ({}): {}", e.app_name, e.end_us / 1_000_000, e.summary))
        .collect();
    let input = summaries.join("\n");

    let prompt = format!(
        "Extract durable facts, preferences, and behavioral patterns from these activity episodes.\n\
         Return a JSON array: [{{\"category\": \"preference|habit|skill|contact|project\", \
         \"content\": \"...\", \"confidence\": 0.0-1.0}}]\n\
         Focus on patterns that persist beyond today. Ignore ephemeral details.\n\
         Episodes:\n{}\n\
         JSON:",
        input.chars().take(3000).collect::<String>()
    );

    let response = orchestrator
        .generate(LlmRequest {
            messages: vec![LlmMessage::user(prompt)],
            temperature: 0.2,
            max_tokens: 512,
            ..Default::default()
        })
        .await;

    match response {
        Ok(r) => parse_facts(&r.content.unwrap_or_default()),
        Err(_) => heuristic_extract(episodes),
    }
}

fn parse_facts(content: &str) -> Vec<ExtractedFact> {
    let start = content.find('[').unwrap_or(0);
    let end = content.rfind(']').map(|i| i + 1).unwrap_or(content.len());
    let json_str = &content[start..end];

    let parsed: Vec<serde_json::Value> = serde_json::from_str(json_str).unwrap_or_default();
    parsed
        .into_iter()
        .filter_map(|v| {
            let category = v["category"].as_str()?.to_string();
            let content = v["content"].as_str()?.to_string();
            if content.is_empty() {
                return None;
            }
            let confidence = v["confidence"].as_f64().unwrap_or(0.6) as f32;
            let id = stable_id(&category, &content);
            Some(ExtractedFact {
                id,
                category,
                content,
                confidence,
            })
        })
        .collect()
}

/// Simple heuristic extraction when LLM is unavailable.
fn heuristic_extract(episodes: &[EpisodeRecord]) -> Vec<ExtractedFact> {
    let mut app_counts: std::collections::HashMap<String, u32> = Default::default();
    for ep in episodes {
        *app_counts.entry(ep.app_name.clone()).or_insert(0) += 1;
    }

    app_counts
        .into_iter()
        .filter(|(_, count)| *count >= 3)
        .map(|(app, count)| {
            let content = format!("Frequently uses {}", app);
            let confidence = (count as f32 / 10.0).min(0.8);
            let id = stable_id("habit", &content);
            ExtractedFact {
                id,
                category: "habit".to_string(),
                content,
                confidence,
            }
        })
        .collect()
}
