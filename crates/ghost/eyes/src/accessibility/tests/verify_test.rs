use super::super::verify::{postcondition, value_matches, verify_typed};
use super::super::{ElementAction, ElementState};

#[test]
fn value_matches_exact_crlf_and_numeric() {
    assert!(value_matches("textfield", "a\nb", "a\r\nb"));
    assert!(!value_matches("textfield", "1", "1.0"));
    assert!(value_matches("slider", "1", "1.0000001"));
    assert!(value_matches("spinbutton", "-3", "-3.0"));
    assert!(!value_matches("slider", "1", "1.01"));
    assert!(!value_matches("slider", "NaN", "nan"));
    assert!(!value_matches("slider", "inf", "inf "));
    assert!(!value_matches("progressbar", "1e300", "1e300 "));
    assert!(value_matches("scrollbar", "0.5", " 0.5 "));
}

fn state() -> ElementState {
    ElementState::default()
}

#[test]
fn postconditions_per_action() {
    let checked = ElementState {
        checked: Some(true),
        ..state()
    };
    let unchecked = ElementState {
        checked: Some(false),
        ..state()
    };
    let r = "checkbox";
    assert_eq!(
        postcondition(&ElementAction::Check, r, None, &checked),
        Some(true)
    );
    assert_eq!(
        postcondition(&ElementAction::Check, r, None, &unchecked),
        Some(false)
    );
    assert_eq!(
        postcondition(&ElementAction::Uncheck, r, None, &unchecked),
        Some(true)
    );
    assert_eq!(
        postcondition(&ElementAction::Toggle, r, Some(&unchecked), &checked),
        Some(true)
    );
    assert_eq!(
        postcondition(&ElementAction::Toggle, r, Some(&checked), &checked),
        Some(false)
    );
    assert_eq!(
        postcondition(&ElementAction::Toggle, r, None, &checked),
        None
    );

    let expanded = ElementState {
        expanded: Some(true),
        ..state()
    };
    assert_eq!(
        postcondition(&ElementAction::Expand, "disclosure", None, &expanded),
        Some(true)
    );
    assert_eq!(
        postcondition(&ElementAction::Collapse, "disclosure", None, &expanded),
        Some(false)
    );
    let selected = ElementState {
        selected: Some(true),
        ..state()
    };
    assert_eq!(
        postcondition(&ElementAction::Select, "tab", None, &selected),
        Some(true)
    );
    let focused = ElementState {
        focused: Some(true),
        ..state()
    };
    assert_eq!(
        postcondition(&ElementAction::Focus, "textfield", None, &focused),
        Some(true)
    );
    assert_eq!(
        postcondition(&ElementAction::Focus, "textfield", None, &state()),
        None
    );

    let val = ElementState {
        value: Some("42.0".to_string()),
        ..state()
    };
    let set = ElementAction::SetValue("42".to_string());
    assert_eq!(postcondition(&set, "slider", None, &val), Some(true));
    assert_eq!(postcondition(&set, "textfield", None, &val), Some(false));
    let secure = ElementState {
        secure: true,
        ..state()
    };
    assert_eq!(postcondition(&set, "textfield", None, &secure), None);

    for a in [
        ElementAction::Press,
        ElementAction::ScrollIntoView,
        ElementAction::ShowMenu,
    ] {
        assert_eq!(postcondition(&a, "button", None, &checked), None);
    }
}

#[test]
fn verify_typed_rules() {
    // clear => exact (whitespace-normalized) match.
    assert_eq!(
        verify_typed(Some("old"), "new", true, Some("new")),
        Some(true)
    );
    assert_eq!(
        verify_typed(Some("old"), "new", true, Some("oldnew")),
        Some(false)
    );
    // empty before => exact match.
    assert_eq!(
        verify_typed(None, "hi  there", false, Some("hi there")),
        Some(true)
    );
    assert_eq!(verify_typed(Some(""), "hi", false, Some("hi")), Some(true));
    // non-empty before without clear => insufficient evidence.
    assert_eq!(
        verify_typed(Some("abc"), "def", false, Some("abcdef")),
        None
    );
    // Text already present before typing is not a false pass.
    assert_eq!(
        verify_typed(Some("hello"), "hello", false, Some("hello")),
        None
    );
    // after unknown => None.
    assert_eq!(verify_typed(None, "x", true, None), None);
}
