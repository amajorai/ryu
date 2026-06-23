use crate::llm::LlmMessage;

/// Which tier of LLM model is being used.
#[derive(Debug, Clone, Copy)]
pub enum ModelTier {
    Cloud,
    LocalLarge,
    LocalSmall,
}

/// Specialized role for an agent sub-task.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentRole {
    /// Read and report screen state.
    Observer,
    /// Perform UI actions.
    Executor,
    /// Retrieve from memory stores.
    MemoryManager,
    /// Record and synthesize procedures.
    LearningEngine,
    /// Assess risk before execution.
    SafetyMonitor,
    /// Full context, no specialization.
    General,
}

/// Token budget allocations per tier.
#[derive(Debug, Clone, Copy)]
pub struct Budget {
    pub total: usize,
    pub system: usize,
    pub memory: usize,
    pub max_per_turn: usize,
}

impl Budget {
    fn for_tier(tier: ModelTier) -> Self {
        match tier {
            ModelTier::Cloud => Budget {
                total: 128_000,
                system: 2_000,
                memory: 4_000,
                max_per_turn: 32_000,
            },
            ModelTier::LocalLarge => Budget {
                total: 32_000,
                system: 1_500,
                memory: 2_000,
                max_per_turn: 8_000,
            },
            ModelTier::LocalSmall => Budget {
                total: 16_000,
                system: 1_000,
                memory: 1_000,
                max_per_turn: 4_000,
            },
        }
    }
}

pub struct ContextBudgetManager;

impl ContextBudgetManager {
    /// Trim `history` to fit within the `max_per_turn` budget and prepend
    /// the appropriate system prompt and memory context.
    ///
    /// Always preserves the system message and the most recent user message.
    pub fn build_context(
        role: AgentRole,
        tier: ModelTier,
        history: &[LlmMessage],
        memory_context: &str,
    ) -> Vec<LlmMessage> {
        let budget = Budget::for_tier(tier);
        let system_text = Self::system_prompt_for_role(role);
        let memory_text = &memory_context[..memory_context.len().min(budget.memory * 4)]; // 4 chars/token

        let system_msg = if memory_text.is_empty() {
            LlmMessage::system(system_text)
        } else {
            LlmMessage::system(format!("{}\n\nContext:\n{}", system_text, memory_text))
        };

        // Trim history to fit max_per_turn
        let char_budget = budget.max_per_turn * 4; // conservative 4 chars/token
        let mut trimmed: Vec<LlmMessage> = Vec::new();
        let mut used = estimate_tokens(system_msg.content.as_str()) * 4;

        // Walk history newest-first, include until budget exhausted
        for msg in history.iter().rev() {
            let cost = estimate_tokens(msg.content.as_str()) * 4;
            if used + cost > char_budget {
                break;
            }
            used += cost;
            trimmed.push(msg.clone());
        }
        trimmed.reverse();

        let mut result = vec![system_msg];
        result.extend(trimmed);
        result
    }

    /// Focused system prompt for each agent role.
    pub fn system_prompt_for_role(role: AgentRole) -> &'static str {
        match role {
            AgentRole::Observer => {
                "You are an observer agent. Your sole task is to read and describe the current \
                 screen state using ax_tree_query and capture_live_screenshot. Report exactly \
                 what you see: UI elements, text, application state. Be factual and concise."
            }
            AgentRole::Executor => {
                "You are an executor agent. Your sole task is to perform UI actions precisely \
                 as instructed. Use ax_click, ax_type, ax_hotkey, ax_scroll, ax_focus_app, and \
                 ax_wait. After each action, verify the result. Abort if safety is uncertain."
            }
            AgentRole::MemoryManager => {
                "You are a memory manager agent. Retrieve information from memory stores using \
                 get_knowledge, search_hybrid, get_directives, and search_summaries. Synthesize \
                 the most relevant results for the given question."
            }
            AgentRole::LearningEngine => {
                "You are a learning engine agent. Your task is to observe user actions and \
                 synthesize them into reusable procedures. Identify parameterizable patterns \
                 and generalize specific values into placeholders."
            }
            AgentRole::SafetyMonitor => {
                "You are a safety monitor agent. Evaluate proposed actions for risk. Flag \
                 anything that could cause data loss, send messages, make purchases, or \
                 modify system settings. Provide a risk assessment: safe / needs_approval / blocked."
            }
            AgentRole::General => {
                "You are Shadow, a personal intelligence engine. You have continuous access \
                 to the user's screen, audio, and activity data. Help with questions about \
                 their work history, controlling their computer, managing memory, and \
                 automating tasks."
            }
        }
    }
}

/// Conservative token estimate: 4 characters per token.
pub fn estimate_tokens(text: &str) -> usize {
    (text.len() + 3) / 4
}
