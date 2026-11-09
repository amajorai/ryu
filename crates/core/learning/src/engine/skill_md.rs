//! Skill artifacts: provenance, slugs, the `SKILL.md` renderer, and the JSON
//! object extractor for a synthesis model's answer.

use serde_json::Value;

use super::config::LEARNED_SKILL_PREFIX;

/// Provenance stamped into a synthesized skill's front-matter. An approved skill
/// becomes node-global active context for every user and agent, so the approver
/// (the `skill_md` rides in the approval request) and anyone auditing the library
/// later must be able to see where it came from. Extra front-matter keys are
/// ignored by `ryu_skills::parse_skill_md`, so these fields are audit metadata
/// only — they never change how the skill loads or runs.
#[derive(Debug, Clone, Default)]
pub struct SkillProvenance {
    /// The conversation the skill was distilled from.
    pub conversation_id: String,
    /// The agent that drove the source conversation, when its messages carry one.
    pub agent_id: Option<String>,
    /// Verified user who requested the synthesis, when the call site has an
    /// identity (Core's `/api/learn/synthesize`). `None` for the autonomous
    /// skills pass and the identity-less sidecar surface.
    pub requested_by: Option<String>,
    /// `true` for a deliberate `force` synth ("make a skill from this chat");
    /// `false` when the autonomous skills pass proposed it.
    pub user_requested: bool,
    /// RFC 3339 synthesis time.
    pub synthesized_at: String,
    /// The existing learned skill this one revises, when synthesis proposed an
    /// update rather than a new skill. The approver sees which skill an approval
    /// would replace.
    pub revises: Option<String>,
}

/// Turn a free-form title into a namespaced, filesystem-safe skill slug.
pub fn slugify(name: &str) -> String {
    let mut slug = String::from(LEARNED_SKILL_PREFIX);
    let mut prev_dash = false;
    for c in name.trim().to_ascii_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
            prev_dash = false;
        } else if !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }
    let slug = slug.trim_end_matches('-').to_string();
    // Cap length to keep directory names sane.
    slug.chars().take(60).collect()
}

/// Render a validated `SKILL.md` body from synthesized fields, with the skill's
/// [`SkillProvenance`] stamped into the front-matter (M17: a node-global skill
/// must record who/what originated it).
pub fn build_skill_md(
    name: &str,
    description: &str,
    instructions: &str,
    provenance: &SkillProvenance,
) -> String {
    let mut front = format!("---\nname: {name}\ndescription: {description}\n");
    front.push_str(&format!(
        "source-conversation: {}\n",
        provenance.conversation_id
    ));
    if let Some(agent) = &provenance.agent_id {
        front.push_str(&format!("source-agent: {agent}\n"));
    }
    if let Some(user) = &provenance.requested_by {
        front.push_str(&format!("requested-by: {user}\n"));
    }
    if let Some(previous) = &provenance.revises {
        front.push_str(&format!("revises: {previous}\n"));
    }
    let origin = if provenance.user_requested {
        "user-requested"
    } else {
        "auto"
    };
    front.push_str(&format!(
        "origin: {origin}\nsynthesized-at: {}\n---\n\n{instructions}\n",
        provenance.synthesized_at
    ));
    front
}

/// Extract the first balanced `{...}` that parses as JSON from a possibly-fenced
/// answer. Crucially, if the first balanced object fails to parse (e.g. the answer
/// opens with a prose brace like `{placeholders}`), keep scanning for the next
/// candidate rather than bailing — the real JSON may come later in the string.
/// (Structural chars are ASCII, so byte scanning is UTF-8 safe: continuation
/// bytes never collide with `{`/`}`/`"`/`\`.)
pub(super) fn extract_json_object(text: &str) -> Option<Value> {
    let bytes = text.as_bytes();
    let mut search_from = 0;
    while let Some(rel) = text[search_from..].find('{') {
        let start = search_from + rel;
        if let Some(end) = balanced_object_end(bytes, start) {
            if let Ok(v) = serde_json::from_str::<Value>(&text[start..=end]) {
                return Some(v);
            }
        }
        // No object here, or it didn't parse — advance past this `{` and retry.
        search_from = start + 1;
    }
    None
}

/// Index of the `}` that closes the object opened at `start`, respecting strings
/// and escapes. `None` if unbalanced to end-of-input.
fn balanced_object_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        let c = b as char;
        if in_str {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}
