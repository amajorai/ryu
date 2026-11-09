//! Parsing the profile turn's reply into the Markdown profile and sanitised
//! agent suggestions.

use super::*;

pub(super) fn single_line(value: &str, max_chars: usize) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_chars)
        .collect()
}

pub(super) fn bounded_prompt(value: &str) -> String {
    value.trim().chars().take(6000).collect()
}

pub(super) fn suggestion_id(name: &str, index: usize) -> String {
    let mut slug = String::new();
    let mut last_was_separator = false;
    for character in name.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            last_was_separator = false;
        } else if !last_was_separator && !slug.is_empty() {
            slug.push('-');
            last_was_separator = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        slug = format!("workflow-{}", index + 1);
    }
    format!("agent-suggestion-{slug}")
}

pub(super) fn normalize_agent_suggestions(raw: Vec<RawAgentSuggestion>) -> Vec<AgentSuggestion> {
    let mut seen_names = std::collections::HashSet::new();
    let mut suggestions = Vec::new();
    for (index, item) in raw.into_iter().enumerate() {
        let name = single_line(&item.name, 64);
        if name.len() < 2 || !seen_names.insert(name.to_ascii_lowercase()) {
            continue;
        }
        let system_prompt = bounded_prompt(&item.system_prompt);
        if system_prompt.is_empty() {
            continue;
        }

        let mut tools = Vec::new();
        for tool in item.tools {
            let tool = tool.trim();
            if RECOMMENDED_AGENT_TOOLS.contains(&tool)
                && !tools.iter().any(|existing| existing == tool)
            {
                tools.push(tool.to_owned());
            }
        }
        if tools.is_empty() {
            tools.push("search_conversations.search".to_owned());
        }

        suggestions.push(AgentSuggestion {
            description: {
                let description = single_line(&item.description, 240);
                if description.is_empty() {
                    "A focused helper for a repeated workflow.".to_owned()
                } else {
                    description
                }
            },
            id: suggestion_id(&name, index),
            name,
            reason: {
                let reason = single_line(&item.reason, 240);
                if reason.is_empty() {
                    "This workflow showed up repeatedly in your recent work.".to_owned()
                } else {
                    reason
                }
            },
            system_prompt,
            title: {
                let title = single_line(&item.title, 48);
                if title.is_empty() {
                    "Suggested agent".to_owned()
                } else {
                    title
                }
            },
            tools,
        });
        if suggestions.len() == MAX_AGENT_SUGGESTIONS {
            break;
        }
    }
    suggestions
}

pub(super) fn json_object_from_reply(reply: &str) -> Option<Value> {
    let trimmed = reply.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        if value.is_object() {
            return Some(value);
        }
    }
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    (start < end)
        .then(|| serde_json::from_str::<Value>(&trimmed[start..=end]).ok())
        .flatten()
        .filter(Value::is_object)
}

/// Split the human-readable profile from the model's optional machine block.
/// The marker is an HTML comment so it stays out of the rendered profile chat;
/// the strict JSON fallback keeps older/less obedient models useful without
/// exposing arbitrary generated tool ids to the client.
pub(super) fn parse_profile_reply(reply: &str) -> (String, Vec<AgentSuggestion>) {
    const MARKER: &str = "<!-- RYU_AGENT_SUGGESTIONS_JSON";
    if let Some(marker_start) = reply.find(MARKER) {
        let after_marker = &reply[marker_start + MARKER.len()..];
        if let (Some(json_start), Some(json_end)) =
            (after_marker.find('{'), after_marker.rfind('}'))
        {
            if json_start < json_end {
                if let Ok(value) = serde_json::from_str::<ProfileModelResponse>(
                    &after_marker[json_start..=json_end],
                ) {
                    return (
                        reply[..marker_start].trim().to_owned(),
                        normalize_agent_suggestions(value.agent_suggestions),
                    );
                }
            }
        }
        let profile = reply[..marker_start].trim();
        if !profile.is_empty() {
            return (profile.to_owned(), Vec::new());
        }
    }

    if let Some(value) = json_object_from_reply(reply) {
        if let Ok(parsed) = serde_json::from_value::<ProfileModelResponse>(value) {
            let profile = parsed.profile.trim();
            if !profile.is_empty() || !parsed.agent_suggestions.is_empty() {
                return (
                    if profile.is_empty() {
                        reply.trim().to_owned()
                    } else {
                        profile.to_owned()
                    },
                    normalize_agent_suggestions(parsed.agent_suggestions),
                );
            }
        }
    }

    (reply.trim().to_owned(), Vec::new())
}
