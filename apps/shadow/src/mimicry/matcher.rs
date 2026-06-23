use crate::mimicry::procedure::ProcedureStore;
use crate::mimicry::types::ProcedureTemplate;

/// Matches the current activity context against stored procedure templates.
pub struct ProcedureMatcher;

impl ProcedureMatcher {
    /// Find procedures that match the current context.
    ///
    /// Scores by: app name match (0.8), recent apps overlap (0.6),
    /// title/description keyword overlap (0.4).
    /// Returns up to 5 results sorted by score descending.
    pub fn match_context(
        app: &str,
        window_title: &str,
        recent_apps: &[String],
        store: &ProcedureStore,
    ) -> Vec<(ProcedureTemplate, f32)> {
        let procedures = match store.list() {
            Ok(p) => p,
            Err(_) => return vec![],
        };

        let app_lower = app.to_lowercase();
        let title_lower = window_title.to_lowercase();
        let title_words: Vec<&str> = title_lower
            .split_whitespace()
            .filter(|w| w.len() > 3)
            .collect();

        let mut scored: Vec<(ProcedureTemplate, f32)> = procedures
            .into_iter()
            .filter_map(|p| {
                let score = score_procedure(&p, &app_lower, &title_words, recent_apps);
                if score > 0.0 {
                    Some((p, score))
                } else {
                    None
                }
            })
            .collect();

        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(5);
        scored
    }

    /// Format matched procedures as a hint block for LLM prompt injection.
    pub fn format_for_prompt(matches: &[(ProcedureTemplate, f32)]) -> String {
        if matches.is_empty() {
            return String::new();
        }
        let lines: Vec<String> = matches
            .iter()
            .map(|(p, score)| {
                format!(
                    "- '{}' (app={}, score={:.2}): {}",
                    p.name, p.app_name, score, p.description
                )
            })
            .collect();
        format!("Relevant known procedures:\n{}", lines.join("\n"))
    }
}

fn score_procedure(
    p: &ProcedureTemplate,
    app_lower: &str,
    title_words: &[&str],
    recent_apps: &[String],
) -> f32 {
    let mut score = 0.0f32;

    // App name exact match
    if !p.app_name.is_empty() && p.app_name.to_lowercase() == app_lower {
        score += 0.8;
    } else if recent_apps
        .iter()
        .any(|a| a.to_lowercase() == p.app_name.to_lowercase())
    {
        score += 0.6;
    }

    // Title keyword overlap with procedure name/description
    let proc_text = format!("{} {}", p.name.to_lowercase(), p.description.to_lowercase());
    let matching_words = title_words
        .iter()
        .filter(|w| proc_text.contains(*w))
        .count();
    if !title_words.is_empty() {
        score += 0.4 * (matching_words as f32 / title_words.len() as f32);
    }

    // Boost by historical success
    if p.success_count > 0 {
        score += 0.1 * (p.success_count as f32).min(5.0) / 5.0;
    }

    score
}
