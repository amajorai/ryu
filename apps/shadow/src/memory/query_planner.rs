use anyhow::Result;

use crate::intelligence::context::{EpisodeRecord, EpisodeStore};
use crate::llm::{orchestrator::LlmOrchestrator, LlmMessage, LlmRequest};
use crate::memory::directive::DirectiveMemoryStore;
use crate::memory::semantic::{MemoryEntry, SemanticMemoryStore};
use crate::mimicry::procedure::ProcedureStore;
use crate::mimicry::types::ProcedureTemplate;

/// Which memory sources to query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemorySource {
    SemanticKnowledge,
    Directives,
    Episodes,
    Procedures,
}

/// A plan for a multi-source memory query.
pub struct QueryPlan {
    pub sources: Vec<MemorySource>,
    pub query: String,
    pub max_chars: usize,
}

/// A normalized result from any memory source.
#[derive(Debug, Clone)]
pub struct MemoryResult {
    pub source: MemorySource,
    pub content: String,
    pub confidence: f32,
}

pub struct MemoryQueryPlanner;

impl MemoryQueryPlanner {
    /// Decide which sources to query for the given question.
    /// Uses the LLM when available; falls back to keyword heuristics.
    pub async fn plan(question: &str, orchestrator: &LlmOrchestrator) -> QueryPlan {
        // Try LLM planning with the local/fast provider
        if orchestrator.local().is_some() {
            if let Some(plan) = llm_plan(question, orchestrator).await {
                return plan;
            }
        }
        heuristic_plan(question)
    }

    /// Execute the plan against the given stores.
    pub fn execute(
        plan: &QueryPlan,
        semantic: Option<&SemanticMemoryStore>,
        directive: Option<&DirectiveMemoryStore>,
        episodes: Option<&EpisodeStore>,
        procedures: Option<&ProcedureStore>,
    ) -> Vec<MemoryResult> {
        let mut results = Vec::new();

        for source in &plan.sources {
            match source {
                MemorySource::SemanticKnowledge => {
                    if let Some(store) = semantic {
                        if let Ok(entries) = store.query(None, &plan.query) {
                            for e in entries.iter().take(5) {
                                results.push(MemoryResult {
                                    source: MemorySource::SemanticKnowledge,
                                    content: format!("[{}] {}", e.category, e.content),
                                    confidence: e.confidence,
                                });
                            }
                        }
                    }
                }
                MemorySource::Directives => {
                    if let Some(store) = directive {
                        if let Ok(dirs) = store.list_active(None) {
                            for d in dirs.iter().take(5) {
                                results.push(MemoryResult {
                                    source: MemorySource::Directives,
                                    content: format!("[{}] {}", d.directive_type, d.content),
                                    confidence: 1.0,
                                });
                            }
                        }
                    }
                }
                MemorySource::Episodes => {
                    if let Some(store) = episodes {
                        if let Ok(eps) = store.load_recent(5) {
                            for ep in eps {
                                results.push(MemoryResult {
                                    source: MemorySource::Episodes,
                                    content: format!("{}: {}", ep.app_name, ep.summary),
                                    confidence: 0.8,
                                });
                            }
                        }
                    }
                }
                MemorySource::Procedures => {
                    if let Some(store) = procedures {
                        if let Ok(procs) = store.find_similar(&plan.query, 5) {
                            for p in procs {
                                results.push(MemoryResult {
                                    source: MemorySource::Procedures,
                                    content: format!("[procedure] {}: {}", p.name, p.description),
                                    confidence: 0.9,
                                });
                            }
                        }
                    }
                }
            }
        }

        results
    }

    /// Format results as a text block for agent prompt injection.
    /// Bounded by `max_chars`.
    pub fn format_for_context(results: &[MemoryResult], max_chars: usize) -> String {
        if results.is_empty() {
            return String::new();
        }
        let mut out = String::new();
        for r in results {
            let line = format!("• {}\n", r.content);
            if out.len() + line.len() > max_chars {
                break;
            }
            out.push_str(&line);
        }
        out
    }
}

// ── helpers ───────────────────────────────────────────────────────────────────

async fn llm_plan(question: &str, orchestrator: &LlmOrchestrator) -> Option<QueryPlan> {
    let prompt = format!(
        "Which memory stores should be queried to answer this question?\n\
         Available stores: semantic_knowledge | directives | episodes | procedures\n\
         Respond with a comma-separated list of store names, nothing else.\n\
         Question: {}",
        question
    );
    let resp = orchestrator
        .generate(LlmRequest {
            messages: vec![LlmMessage::user(prompt)],
            temperature: 0.0,
            max_tokens: 20,
            ..Default::default()
        })
        .await
        .ok()?;

    let text = resp.content?;
    let sources: Vec<MemorySource> = text
        .split(',')
        .filter_map(|s| match s.trim().to_lowercase().as_str() {
            "semantic_knowledge" => Some(MemorySource::SemanticKnowledge),
            "directives" => Some(MemorySource::Directives),
            "episodes" => Some(MemorySource::Episodes),
            "procedures" => Some(MemorySource::Procedures),
            _ => None,
        })
        .collect();

    if sources.is_empty() {
        return None;
    }
    Some(QueryPlan {
        sources,
        query: question.to_string(),
        max_chars: 4000,
    })
}

fn heuristic_plan(question: &str) -> QueryPlan {
    let q = question.to_lowercase();
    let mut sources = Vec::new();

    if q.contains("remind") || q.contains("directive") || q.contains("rule") || q.contains("always")
    {
        sources.push(MemorySource::Directives);
    }
    if q.contains("procedure")
        || q.contains("replay")
        || q.contains("workflow")
        || q.contains("how to")
    {
        sources.push(MemorySource::Procedures);
    }
    if q.contains("remember")
        || q.contains("history")
        || q.contains("transcript")
        || q.contains("did i")
    {
        sources.push(MemorySource::Episodes);
        sources.push(MemorySource::SemanticKnowledge);
    }
    if sources.is_empty() {
        // Default: search all
        sources = vec![
            MemorySource::SemanticKnowledge,
            MemorySource::Directives,
            MemorySource::Episodes,
            MemorySource::Procedures,
        ];
    }

    QueryPlan {
        sources,
        query: question.to_string(),
        max_chars: 4000,
    }
}
