use super::*;
use serde_json::{json, Value};

fn wire(outcome: &ImportOutcome) -> Value {
    serde_json::to_value(outcome).unwrap()
}

fn sources(outcome: &ImportOutcome) -> Vec<String> {
    wire(outcome)["detail_i18n"]
        .as_array()
        .unwrap()
        .iter()
        .map(|sentence| sentence["message"].as_str().unwrap().to_owned())
        .collect()
}

fn imported(created: usize) -> ExportCounts {
    ExportCounts {
        created,
        ..ExportCounts::default()
    }
}

#[test]
fn project_and_plain_titles_carry_their_messages() {
    let counts = imported(1);
    let project = export_outcome(
        "conversations/x#project",
        export_title("Claude", Some("Trip")),
        &counts,
        export_detail("Claude", &counts, None, &[]),
        None,
    );
    let wire_project = wire(&project);
    assert_eq!(wire_project["title"], json!("Project “Trip” from Claude"));
    assert_eq!(
        wire_project["title_i18n"],
        json!({
            "message": "Project “{name}” from {label}",
            "args": { "label": "Claude", "name": "Trip" }
        })
    );

    let plain = export_outcome(
        "conversations/x#chats",
        export_title("ChatGPT", None),
        &counts,
        export_detail("ChatGPT", &counts, None, &[]),
        None,
    );
    let wire_plain = wire(&plain);
    assert_eq!(wire_plain["status"], json!("imported"));
    assert_eq!(wire_plain["title"], json!("Chats from ChatGPT"));
    assert_eq!(
        wire_plain["title_i18n"],
        json!({ "message": "Chats from {label}", "args": { "label": "ChatGPT" } })
    );
}

#[test]
fn counts_are_numbers_and_the_english_detail_keeps_its_wording() {
    let counts = ExportCounts {
        created: 1,
        diverged: 1,
        ..ExportCounts::default()
    };
    let detail = export_detail("ChatGPT", &counts, None, &[]);
    let outcome = export_outcome("c", export_title("ChatGPT", None), &counts, detail, None);
    let english = outcome.detail.as_deref().unwrap();
    assert!(english.starts_with("1 new, 0 updated"), "{english}");
    assert!(
        english.contains("1 edited in ChatGPT since the last import was left as imported."),
        "{english}"
    );
    let wire = wire(&outcome);
    assert_eq!(
        wire["detail_i18n"][0]["message"],
        json!("{created} new, {updated} updated, {unchanged} already imported.")
    );
    assert_eq!(
        wire["detail_i18n"][0]["args"]["created"]["number"],
        json!(1.0)
    );
    assert_eq!(wire["detail_i18n"][1]["args"]["label"], json!("ChatGPT"));
}

#[test]
fn one_shortened_chat_is_singular_and_two_are_plural() {
    let one = ExportCounts {
        created: 1,
        shortened: 1,
        ..ExportCounts::default()
    };
    let rendered: Vec<String> = export_detail("Claude", &one, None, &[])
        .iter()
        .map(|sentence| sentence.render("en"))
        .collect();
    assert_eq!(
        rendered[1],
        "1 very long chat was kept to its first 5,000 messages."
    );

    let two = ExportCounts {
        created: 2,
        shortened: 2,
        ..ExportCounts::default()
    };
    let rendered: Vec<String> = export_detail("Claude", &two, None, &[])
        .iter()
        .map(|sentence| sentence.render("en"))
        .collect();
    assert_eq!(
        rendered[1],
        "2 very long chats were kept to their first 5,000 messages."
    );
}

#[test]
fn a_failed_group_carries_its_sentences() {
    let counts = ExportCounts {
        failed: 2,
        ..ExportCounts::default()
    };
    let outcome = export_outcome(
        "c",
        export_title("ChatGPT", None),
        &counts,
        export_detail("ChatGPT", &counts, None, &[]),
        None,
    );
    assert_eq!(outcome.status, "failed");
    assert_eq!(
        outcome.detail.as_deref(),
        Some("0 new, 0 updated, 0 already imported. 2 chats could not be imported.")
    );
    assert_eq!(
        sources(&outcome),
        vec![
            "{created} new, {updated} updated, {unchanged} already imported.",
            "{failed} chats could not be imported.",
        ]
    );
    let one = ExportCounts {
        failed: 1,
        ..ExportCounts::default()
    };
    let rendered = export_detail("ChatGPT", &one, None, &[])[1].render("en");
    assert_eq!(rendered, "1 chat could not be imported.");
}

#[test]
fn folder_and_kept_edits_are_sentences_with_verbatim_names() {
    let counts = imported(1);
    let detail = export_detail(
        "Claude",
        &counts,
        Some("/docs/Trip"),
        &["AGENTS.md".to_owned(), "notes.md".to_owned()],
    );
    let outcome = export_outcome(
        "c",
        export_title("Claude", Some("Trip")),
        &counts,
        detail,
        Some("/docs/Trip".to_owned()),
    );
    assert_eq!(outcome.folder_path.as_deref(), Some("/docs/Trip"));
    let wire = wire(&outcome);
    assert_eq!(
        wire["detail_i18n"][1]["args"]["folder"],
        json!("/docs/Trip")
    );
    assert_eq!(
        wire["detail_i18n"][2]["args"]["files"],
        json!("AGENTS.md, notes.md")
    );
    assert!(outcome.detail.as_deref().unwrap().ends_with(
        "The chats are filed in the project folder /docs/Trip. Your edits to AGENTS.md, notes.md were kept, not replaced from the export."
    ));
}

#[test]
fn unchanged_and_diverged_groups_keep_their_status() {
    let unchanged = ExportCounts {
        unchanged: 3,
        ..ExportCounts::default()
    };
    let outcome = export_outcome(
        "c",
        export_title("ChatGPT", None),
        &unchanged,
        export_detail("ChatGPT", &unchanged, None, &[]),
        None,
    );
    assert_eq!(outcome.status, "skipped");
    assert!(outcome.already_exists);
    assert_eq!(
        outcome.detail.as_deref(),
        Some("0 new, 0 updated, 3 already imported.")
    );

    let diverged = ExportCounts {
        diverged: 2,
        ..ExportCounts::default()
    };
    let outcome = export_outcome(
        "c",
        export_title("ChatGPT", None),
        &diverged,
        export_detail("ChatGPT", &diverged, None, &[]),
        None,
    );
    assert_eq!(outcome.status, "skipped");
    assert!(!outcome.already_exists);
    assert!(outcome
        .detail
        .as_deref()
        .unwrap()
        .contains("2 edited in ChatGPT since the last import were left as imported."));
}

#[test]
fn the_notification_body_is_a_whole_sentence_per_case() {
    assert_eq!(
        chats_imported_body("ChatGPT", None, 4, 1),
        "Imported ChatGPT chats: 4 new, 1 updated."
    );
    assert_eq!(
        chats_imported_body("Claude", Some("Trip"), 0, 2),
        "Imported Claude project “Trip”: 0 new, 2 updated."
    );
}
