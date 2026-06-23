use crate::llm::{orchestrator::LlmOrchestrator, LlmMessage, LlmRequest};

/// Classification of user intent for routing agent paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Intent {
    /// Simple factual question about history or events.
    SimpleQuestion,
    /// Search across memories, transcripts, or activity.
    MemorySearch,
    /// Replay a previously learned procedure.
    ProcedureReplay,
    /// Record a new procedure by observing user actions.
    ProcedureLearning,
    /// Analysis, comparison, or multi-step reasoning.
    ComplexReasoning,
    /// Create a directive, reminder, or behavioral rule.
    DirectiveCreation,
    /// Direct UI interaction or computer automation.
    UiAction,
    /// Cannot be confidently classified.
    Ambiguous,
}

impl Intent {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SimpleQuestion => "simple_question",
            Self::MemorySearch => "memory_search",
            Self::ProcedureReplay => "procedure_replay",
            Self::ProcedureLearning => "procedure_learning",
            Self::ComplexReasoning => "complex_reasoning",
            Self::DirectiveCreation => "directive_creation",
            Self::UiAction => "ui_action",
            Self::Ambiguous => "ambiguous",
        }
    }
}

pub struct IntentClassifier;

impl IntentClassifier {
    /// Classify user intent using LLM (fast model) with heuristic fallback.
    /// Target latency: <200ms via a compact prompt.
    pub async fn classify(query: &str, orchestrator: &LlmOrchestrator) -> Intent {
        // Try the local fast model first; fall back to heuristic if unavailable
        let provider = orchestrator.local();
        if provider.is_none() {
            return Self::classify_heuristic(query);
        }

        let prompt = format!(
            "Classify this user request into exactly one of these intents:\n\
             simple_question | memory_search | procedure_replay | procedure_learning | \
             complex_reasoning | directive_creation | ui_action | ambiguous\n\n\
             Rules:\n\
             - ui_action: open/click/type/press/navigate/automate/do something on screen\n\
             - memory_search: search/find/when/what did I do/recall\n\
             - procedure_replay: replay/run/execute a procedure/workflow\n\
             - procedure_learning: record/learn/watch/remember how to\n\
             - directive_creation: remember/remind/note/rule/directive\n\
             - complex_reasoning: analyze/compare/summarize/explain/synthesize\n\
             - simple_question: short factual query about recent activity\n\
             - ambiguous: unclear or mixed intent\n\n\
             Request: {}\n\
             Respond with only the intent label, nothing else.",
            query
        );

        let resp = orchestrator
            .generate(LlmRequest {
                messages: vec![LlmMessage::user(prompt)],
                temperature: 0.0,
                max_tokens: 10,
                ..Default::default()
            })
            .await;

        match resp {
            Ok(r) => {
                let label = r.content.as_deref().unwrap_or("").trim().to_lowercase();
                parse_intent_str(&label).unwrap_or_else(|| Self::classify_heuristic(query))
            }
            Err(_) => Self::classify_heuristic(query),
        }
    }

    /// Keyword-based instant fallback (zero latency).
    pub fn classify_heuristic(query: &str) -> Intent {
        let q = query.to_lowercase();

        // UI action keywords
        if contains_any(
            &q,
            &[
                "open ",
                "click",
                "type ",
                "press ",
                "navigate to",
                "go to ",
                "close ",
                "minimize",
                "maximize",
                "drag",
                "scroll",
                "automate",
                "do ",
                "run on screen",
            ],
        ) {
            return Intent::UiAction;
        }
        // Procedure learning
        if contains_any(
            &q,
            &[
                "record",
                "watch me",
                "learn how",
                "learn to",
                "remember how",
                "teach",
            ],
        ) {
            return Intent::ProcedureLearning;
        }
        // Procedure replay
        if contains_any(
            &q,
            &[
                "replay",
                "run the procedure",
                "execute procedure",
                "run the workflow",
                "redo the steps",
            ],
        ) {
            return Intent::ProcedureReplay;
        }
        // Directive creation
        if contains_any(
            &q,
            &[
                "remember that",
                "remind me",
                "note that",
                "directive",
                "rule:",
                "always ",
                "never ",
                "whenever",
            ],
        ) {
            return Intent::DirectiveCreation;
        }
        // Memory search
        if contains_any(
            &q,
            &[
                "search",
                "find",
                "when did",
                "what did",
                "show me",
                "history",
                "transcript",
                "recall",
                "look up",
            ],
        ) {
            return Intent::MemorySearch;
        }
        // Complex reasoning
        if contains_any(
            &q,
            &[
                "analyze",
                "compare",
                "summarize",
                "explain",
                "synthesize",
                "what patterns",
                "why did",
            ],
        ) {
            return Intent::ComplexReasoning;
        }
        // Simple question heuristic
        if q.starts_with("what")
            || q.starts_with("when")
            || q.starts_with("who")
            || q.starts_with("how many")
            || q.ends_with('?')
        {
            return Intent::SimpleQuestion;
        }

        Intent::Ambiguous
    }
}

fn contains_any(s: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| s.contains(n))
}

fn parse_intent_str(s: &str) -> Option<Intent> {
    match s {
        "simple_question" => Some(Intent::SimpleQuestion),
        "memory_search" => Some(Intent::MemorySearch),
        "procedure_replay" => Some(Intent::ProcedureReplay),
        "procedure_learning" => Some(Intent::ProcedureLearning),
        "complex_reasoning" => Some(Intent::ComplexReasoning),
        "directive_creation" => Some(Intent::DirectiveCreation),
        "ui_action" => Some(Intent::UiAction),
        "ambiguous" => Some(Intent::Ambiguous),
        _ => None,
    }
}
