use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::debug;

/// A skill is a named snippet of context that gets prepended to the system
/// prompt for every request routed through the gateway.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// The text injected into the system prompt when this skill is active.
    pub system_prompt_snippet: String,
    /// When `true` the skill is active. Defaults to `true`.
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

pub struct SkillsRegistry {
    skills: Vec<Skill>,
}

impl SkillsRegistry {
    pub fn new(skills: Vec<Skill>) -> Self {
        Self { skills }
    }

    pub fn is_empty(&self) -> bool {
        self.skills.iter().all(|s| !s.enabled)
    }

    /// Inject all active skills into `body`'s messages array.
    ///
    /// Skills are combined into a single block and prepended to the first
    /// system message. If no system message exists, one is inserted at the
    /// start of the messages array.
    pub fn inject(&self, body: &mut Value) {
        let active: Vec<&Skill> = self.skills.iter().filter(|s| s.enabled).collect();
        if active.is_empty() {
            return;
        }

        let header = active
            .iter()
            .map(|s| format!("## {}\n{}", s.name, s.system_prompt_snippet))
            .collect::<Vec<_>>()
            .join("\n\n");

        debug!(count = active.len(), "injecting skills into system prompt");

        let messages = match body["messages"].as_array_mut() {
            Some(m) => m,
            None => return,
        };

        // Find an existing system message to prepend to
        if let Some(system_msg) = messages.iter_mut().find(|m| m["role"] == "system") {
            let existing = system_msg["content"].as_str().unwrap_or("").to_string();
            let merged = if existing.is_empty() {
                header
            } else {
                format!("{header}\n\n---\n\n{existing}")
            };
            system_msg["content"] = Value::String(merged);
        } else {
            // No system message — insert one at the front
            messages.insert(
                0,
                json!({
                    "role": "system",
                    "content": header,
                }),
            );
        }
    }
}
