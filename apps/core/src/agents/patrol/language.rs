//! The language Patrol writes its reports and alerts in.
//!
//! Patrol's hourly summaries, daily 24-hour report and `notify` alerts are
//! model-written text the user reads next to the translated UI, so each
//! scheduled run's prompt names the node's UI language
//! ([`crate::i18n::locale::node_locale`]). The line is added at dispatch, not
//! to the seeded schedule instructions, so a language change applies to the
//! next run and the user's own edits to a schedule are never rewritten. The
//! saved Patrol state (memory markers, JSON keys, severity and status
//! keywords) stays English so later runs can compare it.

use crate::i18n::reply_language::reply_language_instruction;

/// `prompt` for `locale`: unchanged for English, or with the reply-language
/// line appended otherwise.
pub fn with_report_language(prompt: &str, locale: &str) -> String {
    match reply_language_instruction(locale) {
        Some(instruction) => format!(
            "{}\n\n{instruction} This includes the run summary, the report and every notify \
             alert; keep the memory markers, saved state keys, and severity and status \
             keywords exactly as given.",
            prompt.trim_end()
        ),
        None => prompt.to_owned(),
    }
}

/// The prompt a scheduled run of `agent_id` is sent: Patrol's runs name the
/// node's UI language; every other agent's prompt is unchanged.
pub async fn scheduled_prompt(agent_id: &str, prompt: String) -> String {
    if !super::is_patrol(agent_id) {
        return prompt;
    }
    with_report_language(&prompt, crate::i18n::locale::node_locale().await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_keeps_the_schedule_prompt() {
        assert_eq!(
            with_report_language(super::super::HOURLY_INSTRUCTIONS, "en"),
            super::super::HOURLY_INSTRUCTIONS
        );
    }

    #[test]
    fn other_locales_append_the_report_language() {
        let prompt = with_report_language(super::super::DAILY_INSTRUCTIONS, "de");
        assert!(prompt.starts_with(super::super::DAILY_INSTRUCTIONS));
        assert!(prompt.contains("in German"), "{prompt}");
        assert!(prompt.contains("notify alert"));
        assert!(with_report_language("Hourly", "ja-JP").contains("in Japanese"));
        assert!(with_report_language("Hourly", "ar").contains("in Arabic"));
    }

    #[test]
    fn seeded_schedules_stay_untranslated() {
        let seeded: Vec<String> = super::super::schedules()
            .into_iter()
            .map(|template| template.instructions)
            .collect();
        assert_eq!(
            seeded,
            [
                super::super::HOURLY_INSTRUCTIONS,
                super::super::DAILY_INSTRUCTIONS
            ]
        );
    }

    #[tokio::test]
    async fn other_agents_are_left_alone() {
        assert_eq!(
            scheduled_prompt("ryu", "Summarize my day".to_owned()).await,
            "Summarize my day"
        );
    }
}
