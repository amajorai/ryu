use super::localize;

fn english(title: &str, body: &str) -> (String, String) {
    localize(title, body)
        .unwrap_or_else(|| panic!("{title}: {body} is not recognized"))
        .render("en")
}

#[test]
fn every_call_site_sentence_renders_back_to_its_english() {
    let cases = [
        ("App updated", "Ryu Browser 1.2.0 is updated and ready."),
        (
            "App installed",
            "Ryu Browser 1.2.0 is installed and ready to enable.",
        ),
        ("App installed", "Notes is installed and ready to enable."),
        (
            "Thread import updated",
            "Plan the trip synced 12 new messages from codex.",
        ),
        (
            "Import complete",
            "3 imported, 2 already present, 0 failed from ChatGPT export.",
        ),
        ("Other agents finished", "2 of 3 delegated tasks completed."),
        (
            "Other agents finished with issues",
            "0 of 2 delegated tasks completed.",
        ),
    ];
    for (title, body) in cases {
        assert_eq!(english(title, body), (title.to_owned(), body.to_owned()));
    }
}

#[test]
fn reworded_sentences_keep_their_arguments() {
    assert_eq!(
        english(
            "Thread imported",
            "Plan the trip is ready from claude-code."
        )
        .1,
        "Plan the trip was imported from claude-code and is ready."
    );
    assert_eq!(
        english("Chats imported", "ChatGPT chats: 4 new, 1 updated.").1,
        "Imported ChatGPT chats: 4 new, 1 updated."
    );
}

#[test]
fn a_count_of_one_uses_the_singular_sentence() {
    assert_eq!(
        english(
            "Thread import updated",
            "Plan synced 1 new messages from codex."
        )
        .1,
        "Plan synced 1 new message from codex."
    );
    assert_eq!(
        english("Other agents finished", "1 of 1 delegated tasks completed.").1,
        "1 of 1 delegated task completed."
    );
    assert_eq!(
        english("Other agents finished", "0 of 1 delegated tasks completed.").1,
        "0 of 1 delegated task completed."
    );
    assert_eq!(
        english(
            "Other agents finished with issues",
            "1 of 2 delegated tasks completed."
        )
        .1,
        "1 of 2 delegated tasks completed."
    );
}

#[test]
fn names_keep_their_spaces_and_counts_are_formatted() {
    let text = localize("App updated", "My Big App 2.0.1 is updated and ready.").unwrap();
    let args = text.body[0].to_wire()["args"].clone();
    assert_eq!(args["app"], "My Big App");
    assert_eq!(args["version"], "2.0.1");

    let (_, body) = localize(
        "Import complete",
        "1234 imported, 0 already present, 0 failed from 7 imported, 1 failed.",
    )
    .unwrap()
    .render("de");
    // The source name may itself look like the sentence; counts stay digits.
    assert!(body.contains("7 imported, 1 failed"), "{body}");
    // German groups thousands with a period; the translation may put the
    // source first, so only the formatted count is asserted, not its position.
    assert!(body.contains("1.234"), "{body}");
    assert!(!body.contains("1234"), "{body}");
}

#[test]
fn a_spaced_name_without_a_version_is_not_split() {
    let text = localize(
        "App installed",
        "My Big App is installed and ready to enable.",
    )
    .unwrap();
    let args = text.body[0].to_wire()["args"].clone();
    assert_eq!(args["app"], "My Big App");
    assert!(args.get("version").is_none(), "{args}");

    let text = localize(
        "App installed",
        "Ryu Browser v1.2.0 is installed and ready to enable.",
    );
    let args = text.unwrap().body[0].to_wire()["args"].clone();
    assert_eq!(args["app"], "Ryu Browser");
    assert_eq!(args["version"], "v1.2.0");
}

#[test]
fn unknown_text_is_left_alone() {
    assert!(localize("Something else", "Notes is installed and ready to enable.").is_none());
    assert!(localize("App installed", "Notes was installed.").is_none());
    assert!(localize("Chats imported", "Work: many new, 1 updated.").is_none());
}
