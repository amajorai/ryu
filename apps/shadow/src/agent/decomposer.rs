use super::context_budget::AgentRole;
use super::intent_classifier::Intent;
use crate::llm::{orchestrator::LlmOrchestrator, LlmMessage, LlmRequest};

/// A single sub-task produced by decomposition.
#[derive(Debug, Clone)]
pub struct SubTask {
    pub role: AgentRole,
    pub instruction: String,
    pub parallelizable: bool,
    pub timeout_s: u64,
    pub dependencies: Vec<String>,
}

/// Result of decomposing a complex user task.
#[derive(Debug, Clone)]
pub struct DecompositionResult {
    pub sub_tasks: Vec<SubTask>,
    pub intent: Intent,
    pub estimated_timeout_s: u64,
}

pub struct TaskDecomposer;

impl TaskDecomposer {
    /// Decompose `task` into ordered sub-tasks based on `intent`.
    ///
    /// For well-known intent types, returns a template decomposition instantly.
    /// For Ambiguous or complex tasks, falls back to the heuristic decomposition.
    pub fn decompose(task: &str, intent: Intent) -> DecompositionResult {
        let sub_tasks = match intent {
            Intent::UiAction => vec![SubTask {
                role: AgentRole::Executor,
                instruction: task.to_string(),
                parallelizable: false,
                timeout_s: 60,
                dependencies: vec![],
            }],

            Intent::MemorySearch => vec![
                SubTask {
                    role: AgentRole::MemoryManager,
                    instruction: format!("Search memory stores for: {}", task),
                    parallelizable: false,
                    timeout_s: 15,
                    dependencies: vec![],
                },
                SubTask {
                    role: AgentRole::General,
                    instruction: format!("Synthesize memory results to answer: {}", task),
                    parallelizable: false,
                    timeout_s: 15,
                    dependencies: vec!["memory_search".to_string()],
                },
            ],

            Intent::ProcedureLearning => vec![
                SubTask {
                    role: AgentRole::Observer,
                    instruction: format!("Observe and record user actions for: {}", task),
                    parallelizable: false,
                    timeout_s: 300,
                    dependencies: vec![],
                },
                SubTask {
                    role: AgentRole::LearningEngine,
                    instruction: "Synthesize recorded actions into a reusable procedure"
                        .to_string(),
                    parallelizable: false,
                    timeout_s: 30,
                    dependencies: vec!["observe".to_string()],
                },
            ],

            Intent::ProcedureReplay => vec![SubTask {
                role: AgentRole::Executor,
                instruction: format!("Replay procedure: {}", task),
                parallelizable: false,
                timeout_s: 120,
                dependencies: vec![],
            }],

            Intent::DirectiveCreation => vec![SubTask {
                role: AgentRole::MemoryManager,
                instruction: format!("Create directive: {}", task),
                parallelizable: false,
                timeout_s: 5,
                dependencies: vec![],
            }],

            Intent::ComplexReasoning => vec![
                SubTask {
                    role: AgentRole::MemoryManager,
                    instruction: format!("Gather relevant information for: {}", task),
                    parallelizable: false,
                    timeout_s: 20,
                    dependencies: vec![],
                },
                SubTask {
                    role: AgentRole::General,
                    instruction: format!("Analyze and respond to: {}", task),
                    parallelizable: false,
                    timeout_s: 30,
                    dependencies: vec!["gather".to_string()],
                },
            ],

            Intent::SimpleQuestion => vec![SubTask {
                role: AgentRole::General,
                instruction: task.to_string(),
                parallelizable: false,
                timeout_s: 15,
                dependencies: vec![],
            }],

            Intent::Ambiguous => {
                // Single general-purpose task; let the agent figure it out
                vec![SubTask {
                    role: AgentRole::General,
                    instruction: task.to_string(),
                    parallelizable: false,
                    timeout_s: 60,
                    dependencies: vec![],
                }]
            }
        };

        let estimated_timeout_s = sub_tasks.iter().map(|t| t.timeout_s).sum();

        DecompositionResult {
            sub_tasks,
            intent,
            estimated_timeout_s,
        }
    }

    /// Group sub-tasks into parallel execution phases based on dependencies.
    pub fn group_into_phases(tasks: &[SubTask]) -> Vec<Vec<&SubTask>> {
        // Simple greedy phase assignment:
        // tasks with no dependencies → phase 0;
        // tasks whose dependencies are all in earlier phases → next phase.
        // Since dependencies are just string labels, we track by index.
        let mut phases: Vec<Vec<&SubTask>> = vec![];
        let mut assigned: Vec<bool> = vec![false; tasks.len()];

        loop {
            let mut phase: Vec<&SubTask> = vec![];
            let mut any = false;

            for (i, task) in tasks.iter().enumerate() {
                if assigned[i] {
                    continue;
                }
                // Check all dependencies are in earlier phases
                let deps_met = task.dependencies.iter().all(|dep| {
                    tasks.iter().enumerate().any(|(j, t)| {
                        assigned[j] && t.instruction.to_lowercase().contains(&dep.to_lowercase())
                    })
                });
                let no_deps = task.dependencies.is_empty();

                if no_deps || deps_met {
                    phase.push(task);
                    assigned[i] = true;
                    any = true;
                }
            }

            if phase.is_empty() {
                break;
            }
            phases.push(phase);

            if !any {
                break;
            }
        }

        // Append any remaining unassigned tasks as a final phase
        let remaining: Vec<&SubTask> = tasks
            .iter()
            .enumerate()
            .filter(|(i, _)| !assigned[*i])
            .map(|(_, t)| t)
            .collect();
        if !remaining.is_empty() {
            phases.push(remaining);
        }

        phases
    }
}
