use chrono::NaiveDate;

use super::*;

fn march_14_at_1405() -> NaiveDateTime {
    NaiveDate::from_ymd_opt(2026, 3, 14)
        .and_then(|day| day.and_hms_opt(14, 5, 0))
        .expect("valid date")
}

#[test]
fn workflow_texts_keep_their_markdown_in_english() {
    assert_eq!(
        workflow_paused_input_text("en", Some("Approve the draft?")),
        "**Workflow paused — waiting for input.**\n\nApprove the draft?"
    );
    assert_eq!(
        workflow_paused_input_text("en", Some("  ")),
        "**Workflow paused — waiting for input.**"
    );
    assert_eq!(
        workflow_paused_limit_text_at("en", Some(march_14_at_1405())),
        "**Workflow paused — a provider limit was reached.** It resumes on its own at 14:05 on Saturday, March 14."
    );
    assert_eq!(
        workflow_paused_limit_text("en", None),
        "**Workflow paused — a provider limit was reached.** It resumes on its own soon."
    );
    assert_eq!(
        workflow_paused_limit_text("en", Some("not a timestamp")),
        workflow_paused_limit_text("en", None)
    );
    assert_eq!(
        workflow_no_output_text("en"),
        "_(The workflow completed with no output.)_"
    );
}

#[test]
fn the_resume_time_is_a_locale_date_not_the_rfc3339_text() {
    let german = workflow_paused_limit_text_at("de", Some(march_14_at_1405()));
    assert!(german.contains("14:05"), "{german}");
    assert!(german.contains("Samstag, 14. März"), "{german}");
    let arabic = workflow_paused_limit_text_at("ar", Some(march_14_at_1405()));
    assert!(arabic.contains("السبت، 14 مارس"), "{arabic}");
    let japanese = workflow_paused_limit_text_at("ja", Some(march_14_at_1405()));
    assert!(japanese.contains("3月14日土曜日"), "{japanese}");
    assert!(japanese.contains("14:05"), "{japanese}");

    let parsed = workflow_paused_limit_text("de", Some("2026-03-14T14:05:00Z"));
    assert!(!parsed.contains("2026-03-14T14:05:00Z"), "{parsed}");
    assert!(!parsed.contains("2026-03-14"), "{parsed}");
}

#[test]
fn failures_show_a_generic_sentence_and_never_the_raw_error() {
    let failed = workflow_failed_text("en", "run_1", Some("token sk-secret leaked"));
    assert_eq!(failed, "_The workflow failed. Open the run for details._");

    let refused = workflow_start_failed_text("en", "wf_1", &"cycle detected at node x");
    assert_eq!(refused, "_The workflow could not start._");
    assert!(!refused.contains("cycle"));

    assert_eq!(
        workflow_executor_terminated_text("en"),
        "_The workflow could not start because its run stopped unexpectedly._"
    );

    let member = team_member_reply_text("en", "agent_a", Err::<String, _>("HTTP 500 from host"));
    assert_eq!(member, "_(This teammate could not reply.)_");
    let synthesis = team_synthesis_text("en", "lead", Err::<String, _>("timeout at 10.0.0.2"));
    assert_eq!(synthesis, "_(The synthesis failed.)_");
}

#[test]
fn team_replies_pass_text_through_and_normalise_empty_ones() {
    assert_eq!(
        team_member_reply_text("de", "a", Ok::<_, String>("Hallo".to_owned())),
        "Hallo"
    );
    assert_eq!(
        team_member_reply_text("en", "a", Ok::<_, String>("  \n".to_owned())),
        "_(No response.)_"
    );
    assert_eq!(
        team_synthesis_text("en", "lead", Ok::<_, String>(String::new())),
        "_(The lead returned no synthesis.)_"
    );
    assert_eq!(team_synthesis_label("en", "Ada"), "Synthesis by Ada");
    assert_eq!(team_routed_label("en", "Grace"), "Routed to Grace");
}

/// Needs the generated catalog to carry this module's sources (the i18n
/// catalog integration step regenerates it from `packages/i18n/locales`).
#[test]
fn chat_turn_text_is_translated_for_other_locales() {
    for locale in ["de", "ar", "ja"] {
        let synthesis = team_synthesis_label(locale, "Ada");
        assert!(synthesis.contains("Ada"), "{locale}: {synthesis}");
        assert_ne!(synthesis, team_synthesis_label("en", "Ada"), "{locale}");
        assert_ne!(
            workflow_paused_input_text(locale, None),
            workflow_paused_input_text("en", None),
            "{locale}"
        );
        assert_ne!(
            workflow_failed_text(locale, "run_1", None),
            workflow_failed_text("en", "run_1", None),
            "{locale}"
        );
        assert_ne!(
            team_member_reply_text(locale, "a", Ok::<_, String>(String::new())),
            team_member_reply_text("en", "a", Ok::<_, String>(String::new())),
            "{locale}"
        );
    }
}

/// Every chat-turn sentence has a translation (also needs the regenerated
/// catalog): none of them renders as the English source in de, ar or ja.
#[test]
fn every_chat_turn_template_is_translated() {
    let templates = [
        messages::WORKFLOW_PAUSED_INPUT_MESSAGE,
        messages::WORKFLOW_PAUSED_LIMIT_MESSAGE,
        messages::WORKFLOW_RESUMES_AT_MESSAGE,
        messages::WORKFLOW_RESUMES_SOON_MESSAGE,
        messages::WORKFLOW_FAILED_MESSAGE,
        messages::WORKFLOW_START_FAILED_MESSAGE,
        messages::WORKFLOW_EXECUTOR_TERMINATED_MESSAGE,
        messages::WORKFLOW_NO_OUTPUT_MESSAGE,
        messages::TEAM_NO_RESPONSE_MESSAGE,
        messages::TEAM_MEMBER_ERROR_MESSAGE,
        messages::TEAM_NO_SYNTHESIS_MESSAGE,
        messages::TEAM_SYNTHESIS_ERROR_MESSAGE,
        messages::TEAM_SYNTHESIS_LABEL_MESSAGE,
        messages::TEAM_ROUTED_LABEL_MESSAGE,
    ];
    let render = |template: crate::i18n::Template, locale: &str| {
        Message::new(template)
            .text("agent", "Ada")
            .text("time", "14:05")
            .date("date", march_14_at_1405().date())
            .render(locale)
    };
    for locale in ["de", "ar", "ja"] {
        for template in templates {
            let english = render(template, "en");
            assert_ne!(render(template, locale), english, "{locale}: {english}");
        }
    }
}
