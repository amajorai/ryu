use super::super::{pick_window_title, window_pick_error, TitlePick};
use crate::contract::ErrorCode;

#[test]
fn strict_pick_refuses_a_substring_match() {
    // "Notes" closed; "Notes Archive" must not stand in for it.
    let titles = [Some("Notes Archive"), Some("Inbox")];
    assert_eq!(
        pick_window_title(&titles, "Notes", true),
        TitlePick::Miss(2)
    );
    let titles = [Some("data - Notepad"), Some("a - Notepad")];
    assert_eq!(
        pick_window_title(&titles, "a - Notepad", true),
        TitlePick::Found(1)
    );
}

#[test]
fn strict_pick_reports_duplicate_titles_as_ambiguous() {
    let titles = [Some("Untitled"), Some("Untitled"), Some("Other")];
    let pick = pick_window_title(&titles, "Untitled", true);
    assert_eq!(pick, TitlePick::Ambiguous(2));
    let err = window_pick_error(pick, 42);
    assert_eq!(err.code, ErrorCode::StaleRef);
    assert_eq!(err.details.as_ref().unwrap()["reason"], "window_ambiguous");
}

#[test]
fn strict_pick_falls_back_to_a_single_window() {
    let pick = pick_window_title(&[Some("Renamed")], "Old", true).or_single_window();
    assert_eq!(pick, TitlePick::Found(0));
    let pick = pick_window_title(&[], "Old", true).or_single_window();
    assert_eq!(pick, TitlePick::Miss(0));
    let pick = pick_window_title(&[Some("A"), Some("B")], "Old", true).or_single_window();
    assert_eq!(
        window_pick_error(pick, 1).details.unwrap()["reason"],
        "window_changed"
    );
}

#[test]
fn strict_pick_ignores_surrounding_whitespace() {
    assert_eq!(
        pick_window_title(&[None, Some(" Draft ")], "Draft", true),
        TitlePick::Found(1)
    );
}

#[test]
fn user_title_prefers_exact_then_substring() {
    let titles = [Some("Notes — Draft"), None, Some("Draft")];
    assert_eq!(
        pick_window_title(&titles, "Draft", false),
        TitlePick::Found(2)
    );
    assert_eq!(
        pick_window_title(&titles, "notes", false),
        TitlePick::Found(0)
    );
    assert_eq!(
        pick_window_title(&titles, "missing", false),
        TitlePick::Miss(3)
    );
    let dupes = [Some("Untitled"), Some("Untitled")];
    assert_eq!(
        pick_window_title(&dupes, "Untitled", false),
        TitlePick::Found(0)
    );
}
