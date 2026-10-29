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

/// What [`SkillsRegistry::inject`] wrote into a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Injection {
    /// The combined skills block.
    pub header: String,
    /// Set when the block was prepended to a non-empty caller system message.
    pub merge: Option<Merge>,
}

/// A skills block prepended to the caller's system message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Merge {
    /// The caller's system text before the merge.
    pub existing: String,
    /// The system text written in its place, as the provider receives it.
    pub merged: String,
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
    ///
    /// Returns what was written, or `None` when nothing was injected, so the
    /// pipeline can screen the text it added and the merged system prompt the
    /// provider receives.
    pub fn inject(&self, body: &mut Value) -> Option<Injection> {
        let active: Vec<&Skill> = self.skills.iter().filter(|s| s.enabled).collect();
        if active.is_empty() {
            return None;
        }

        let header = active
            .iter()
            .map(|s| format!("## {}\n{}", s.name, s.system_prompt_snippet))
            .collect::<Vec<_>>()
            .join("\n\n");

        debug!(count = active.len(), "injecting skills into system prompt");

        let messages = body["messages"].as_array_mut()?;

        let mut merge = None;
        // Find an existing system message to prepend to
        if let Some(system_msg) = messages.iter_mut().find(|m| m["role"] == "system") {
            // Content parts are prepended as a new part, never flattened: the
            // client's parts keep their text and any `cache_control`
            // breakpoints, so its cached system prefix still matches.
            if let Some(parts) = system_msg["content"].as_array_mut() {
                parts.insert(0, json!({ "type": "text", "text": header.clone() }));
                return Some(Injection {
                    header,
                    merge: None,
                });
            }
            let existing = system_msg["content"].as_str().unwrap_or("").to_string();
            let merged = if existing.is_empty() {
                header.clone()
            } else {
                let merged = format!("{header}\n\n---\n\n{existing}");
                merge = Some(Merge {
                    existing,
                    merged: merged.clone(),
                });
                merged
            };
            system_msg["content"] = Value::String(merged);
        } else {
            // No system message — insert one at the front
            messages.insert(
                0,
                json!({
                    "role": "system",
                    "content": header.clone(),
                }),
            );
        }
        Some(Injection { header, merge })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> SkillsRegistry {
        SkillsRegistry::new(vec![Skill {
            name: "style".into(),
            description: String::new(),
            system_prompt_snippet: "Be brief.".into(),
            enabled: true,
        }])
    }

    #[test]
    fn prepends_to_a_string_system_prompt() {
        let mut body = json!({ "messages": [{ "role": "system", "content": "Base." }] });
        registry().inject(&mut body);
        assert_eq!(
            body["messages"][0]["content"],
            "## style\nBe brief.\n\n---\n\nBase."
        );
    }

    #[test]
    fn keeps_system_content_parts_and_their_cache_breakpoints() {
        let base = json!({
            "type": "text",
            "text": "Base.",
            "cache_control": { "type": "ephemeral" }
        });
        let mut body = json!({ "messages": [{ "role": "system", "content": [base] }] });
        registry().inject(&mut body);
        assert_eq!(
            body["messages"][0]["content"],
            json!([{ "type": "text", "text": "## style\nBe brief." }, base])
        );
    }
}
