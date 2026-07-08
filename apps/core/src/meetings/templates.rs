//! Meeting-notes templates — named prompt presets over the **fixed**
//! [`super::notes::MeetingNotes`] schema.
//!
//! A template only steers *what the model emphasizes* (a standup vs. a sales call
//! vs. an interview want different notes); it does **not** change the output shape.
//! Every template still produces the same four fields (summary / key_points /
//! action_items / decisions), so the Space markdown renderer and the desktop notes
//! card never have to know which template ran. That keeps templates a pure prompt
//! concern instead of a schema change that would ripple through the whole stack.
//!
//! The prompt handed to the model is `BASE_INSTRUCTION` (the invariant JSON
//! contract) + the template's `guidance`. A user's fully custom prompt
//! (`meeting-notes-prompt`) still overrides everything, for full control.

/// The invariant part of the system prompt: the JSON contract every template
/// shares. Templates append focus guidance after this.
pub const BASE_INSTRUCTION: &str = "You are an expert meeting-notes assistant. \
You are given a raw, possibly imperfect speech-to-text transcript of a meeting \
(or ordered partial summaries of a long one). Respond with ONLY a single JSON \
object, no prose, no markdown fences, with exactly these keys: \
\"summary\" (a short paragraph), \
\"key_points\" (array of strings), \
\"action_items\" (array of strings, each ideally naming an owner if one is clear), \
\"decisions\" (array of strings). \
Use empty arrays when a section has nothing. Do not invent content that is not \
supported by the transcript.";

/// One notes template.
pub struct NotesTemplate {
    pub id: &'static str,
    pub name: &'static str,
    /// Focus guidance appended to [`BASE_INSTRUCTION`].
    pub guidance: &'static str,
}

/// The built-in templates. `default` is first and is the fallback.
pub const TEMPLATES: &[NotesTemplate] = &[
    NotesTemplate {
        id: "default",
        name: "General meeting",
        guidance: "Write concise, useful general-purpose notes that a participant \
would want the day after.",
    },
    NotesTemplate {
        id: "standup",
        name: "Daily standup",
        guidance: "This is a team standup. For key_points, capture per-person \
progress (what shipped / what's in flight). For action_items, capture today's \
commitments and anyone's stated blockers (prefix blockers with 'BLOCKER:'). Keep \
the summary to two sentences.",
    },
    NotesTemplate {
        id: "sales",
        name: "Sales call",
        guidance: "This is a sales/customer call. Emphasize the prospect's pain \
points, budget/authority/need/timeline signals, objections raised, and \
competitors mentioned in key_points. action_items are the seller's follow-ups \
(demos, proposals, intros) with due timing when stated. decisions are any \
commitments the prospect made.",
    },
    NotesTemplate {
        id: "one_on_one",
        name: "1:1",
        guidance: "This is a manager/report 1:1. Keep it discreet and factual. \
key_points cover topics discussed (growth, feedback, workload, morale). \
action_items are follow-ups for either person. decisions are anything agreed \
(scope changes, goals, next-step timing).",
    },
    NotesTemplate {
        id: "interview",
        name: "Interview",
        guidance: "This is a candidate interview. key_points summarize the \
candidate's relevant experience, strengths, and any concerns surfaced. \
action_items are next steps in the process. decisions capture any stated \
lean (advance / hold / reject) without inventing a verdict that wasn't voiced.",
    },
];

/// Look up a template by id (case-insensitive), or `None`.
pub fn by_id(id: &str) -> Option<&'static NotesTemplate> {
    let id = id.trim().to_lowercase();
    TEMPLATES.iter().find(|t| t.id == id)
}

/// The default template (always the first entry).
pub fn default_template() -> &'static NotesTemplate {
    &TEMPLATES[0]
}

/// Build the full system prompt for a template id, falling back to the default
/// when the id is unknown/empty.
pub fn prompt_for(id: &str) -> String {
    let t = by_id(id).unwrap_or_else(|| default_template());
    format!("{BASE_INSTRUCTION} {}", t.guidance)
}

/// A lightweight JSON view of the templates for the API/UI picker.
pub fn catalog_json() -> serde_json::Value {
    serde_json::json!({
        "templates": TEMPLATES
            .iter()
            .map(|t| serde_json::json!({ "id": t.id, "name": t.name }))
            .collect::<Vec<_>>()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_first_and_resolvable() {
        assert_eq!(default_template().id, "default");
        assert!(prompt_for("default").starts_with("You are an expert"));
    }

    #[test]
    fn unknown_id_falls_back_to_default() {
        assert!(by_id("nope").is_none());
        assert_eq!(prompt_for("nope"), prompt_for("default"));
    }

    #[test]
    fn known_templates_include_guidance() {
        let p = prompt_for("sales");
        assert!(p.contains("sales/customer call"));
        assert!(p.contains(BASE_INSTRUCTION));
    }

    #[test]
    fn lookup_is_case_insensitive() {
        assert_eq!(by_id("StandUp").map(|t| t.id), Some("standup"));
    }
}
