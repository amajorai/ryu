//! Linux backend tests. The pure ones run on every Linux CI host; the live one
//! needs an AT-SPI bus and skips at runtime when none is reachable.

use ::atspi::{State, StateSet};

use super::actions_state::{
    already_set, pick_verb, plan, write_verdict, Expect, Rung, CHECK, CHECK_ONLY, COLLAPSE,
    EXPAND_ONLY, PRESS, SHOW_MENU, TOGGLE,
};
use super::at_spi::{element_state, format_number, value_source, ValueSource};
use super::conn::{fault_of_name, verdict, Fault, Verdict};
use super::*;
use crate::contract::{Delivery, ErrorCode};

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_string()).collect()
}

fn states(list: &[State]) -> StateSet {
    let mut set = StateSet::empty();
    for s in list {
        set.insert(*s);
    }
    set
}

// ─── verb selection ───────────────────────────────────────────────────────────

#[test]
fn verb_follows_table_order_not_element_order() {
    let exposed = names(&["activate", "Click"]);
    let (index, verb) = pick_verb(&exposed, PRESS).expect("a press verb");
    assert_eq!(verb.name, "click");
    assert_eq!(verb.method, "atspi.action:click");
    assert_eq!(index, 1, "index is the element's own action index");
}

#[test]
fn verb_match_is_case_insensitive_and_exact() {
    assert_eq!(
        pick_verb(&names(&["SHOWMENU"]), SHOW_MENU).map(|v| v.0),
        Some(0)
    );
    assert!(pick_verb(&names(&["clicked", "doubleclick"]), PRESS).is_none());
    assert!(pick_verb(&[], PRESS).is_none());
}

#[test]
fn check_prefers_absolute_verb_over_relative_ones() {
    let exposed = names(&["click", "toggle", "check"]);
    let (index, verb) = pick_verb(&exposed, CHECK).expect("check verb");
    assert_eq!((index, verb.name), (2, "check"));
    let (_, verb) = pick_verb(&names(&["click"]), CHECK).expect("falls back to click");
    assert_eq!(verb.name, "click");
}

#[test]
fn gtk4_expander_verb_comes_first() {
    let exposed = names(&["activate", "listitem.toggle-expand"]);
    let (_, verb) = pick_verb(&exposed, COLLAPSE).expect("collapse verb");
    assert_eq!(verb.name, "listitem.toggle-expand");
}

// ─── fault table ──────────────────────────────────────────────────────────────

#[test]
fn fault_names_map_per_table() {
    let cases = [
        ("org.a11y.atspi.Error.NoSuchAction", Fault::Unsupported),
        (
            "org.freedesktop.DBus.Error.NotSupported",
            Fault::Unsupported,
        ),
        (
            "org.freedesktop.DBus.Error.UnknownProperty",
            Fault::Unsupported,
        ),
        (
            "org.freedesktop.DBus.Error.UnknownMethod",
            Fault::Unsupported,
        ),
        ("org.freedesktop.DBus.Error.InvalidArgs", Fault::InvalidArgs),
        (
            "org.freedesktop.DBus.Error.AccessDenied",
            Fault::AccessDenied,
        ),
        ("org.freedesktop.DBus.Error.NoReply", Fault::TimedOut),
        ("org.freedesktop.DBus.Error.Timeout", Fault::TimedOut),
        (
            "org.freedesktop.DBus.Error.UnknownObject",
            Fault::UnknownObject,
        ),
        ("org.freedesktop.DBus.Error.ServiceUnknown", Fault::AppGone),
        ("org.freedesktop.DBus.Error.Failed", Fault::Other),
        (
            "org.gtk.GDBus.UnmappedGError.Quark._g_2dio_2derror_2dquark.Code13",
            Fault::Unsupported,
        ),
    ];
    for (name, fault) in cases {
        assert_eq!(fault_of_name(name), fault, "{name}");
    }
}

fn failed(v: Verdict) -> GhostError {
    match v {
        Verdict::Fail(e) => e,
        other => panic!("expected a failure, got {other:?}"),
    }
}

#[test]
fn fault_verdicts_carry_code_and_delivery() {
    assert_eq!(verdict(Fault::Unsupported, "m"), Verdict::FallThrough);
    assert_eq!(verdict(Fault::UnknownObject, "m"), Verdict::Confirm);
    let e = failed(verdict(Fault::InvalidArgs, "m"));
    assert_eq!(
        (e.code, e.delivery),
        (ErrorCode::InvalidArgs, Delivery::NotDelivered)
    );
    let e = failed(verdict(Fault::AccessDenied, "m"));
    assert_eq!(e.code, ErrorCode::PermDenied);
    let e = failed(verdict(Fault::TimedOut, "m"));
    assert_eq!(
        (e.code, e.delivery),
        (ErrorCode::Timeout, Delivery::DeliveryUncertain)
    );
    let e = failed(verdict(Fault::AppGone, "m"));
    assert_eq!(e.code, ErrorCode::StaleRef);
    let e = failed(verdict(Fault::Other, "m"));
    assert_eq!(
        (e.code, e.delivery),
        (ErrorCode::ActionFailed, Delivery::DeliveryUncertain)
    );
}

// ─── SetValue decision ────────────────────────────────────────────────────────

fn editable() -> StateSet {
    states(&[State::Editable, State::Enabled])
}

fn with_value(v: &str) -> ElementState {
    ElementState {
        value: Some(v.to_string()),
        ..ElementState::default()
    }
}

#[test]
fn set_value_equal_to_before_is_satisfied() {
    let action = ElementAction::SetValue("hello".into());
    let rungs = plan(
        &action,
        "textfield",
        &with_value("hello"),
        editable(),
        false,
    )
    .unwrap();
    assert_eq!(rungs, vec![Rung::Already]);
    // Numeric-aware for sliders.
    let action = ElementAction::SetValue("5.0".into());
    let rungs = plan(
        &action,
        "slider",
        &with_value("5"),
        StateSet::empty(),
        false,
    )
    .unwrap();
    assert_eq!(rungs, vec![Rung::Already]);
}

#[test]
fn set_value_never_short_circuits_on_secure_fields() {
    assert!(!already_set("textfield", "x", Some("x"), true));
    let action = ElementAction::SetValue("pw".into());
    let rungs = plan(
        &action,
        "textfield",
        &ElementState::default(),
        editable(),
        true,
    )
    .unwrap();
    assert_eq!(rungs, vec![Rung::SetText, Rung::SetNumber]);
}

#[test]
fn set_value_refuses_read_only_and_non_editable() {
    let action = ElementAction::SetValue("x".into());
    let ro = states(&[State::Editable, State::ReadOnly]);
    let err = plan(&action, "textfield", &with_value(""), ro, false).unwrap_err();
    assert_eq!(
        (err.code, err.delivery),
        (ErrorCode::ActionNotSupported, Delivery::NotDelivered)
    );
    let err = plan(
        &action,
        "textfield",
        &with_value(""),
        StateSet::empty(),
        false,
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::ActionNotSupported);
    // A slider is not Editable but takes Value writes first.
    let action = ElementAction::SetValue("3".into());
    let rungs = plan(
        &action,
        "slider",
        &with_value("1"),
        StateSet::empty(),
        false,
    )
    .unwrap();
    assert_eq!(rungs, vec![Rung::SetNumber, Rung::SetText]);
}

#[test]
fn write_verdict_reads_back() {
    use StepOutcome::*;
    let tf = "textfield";
    assert_eq!(
        write_verdict(tf, "new", Some("old"), Some("new")),
        DeliveredVerified
    );
    assert_eq!(
        write_verdict(tf, "new", Some("old"), Some("old")),
        DeliveredWithoutEffect,
        "an ignored write"
    );
    assert_eq!(
        write_verdict(tf, "new", Some("old"), Some("ne")),
        DeliveredUnverified
    );
    assert_eq!(
        write_verdict(tf, "new", Some("old"), None),
        DeliveredUnverified
    );
    assert_eq!(
        write_verdict(tf, "new", None, Some("x")),
        DeliveredUnverified
    );
    assert_eq!(
        write_verdict("spinbutton", "2", Some("1"), Some("2.0")),
        DeliveredVerified
    );
}

// ─── other plans ──────────────────────────────────────────────────────────────

fn checked(on: Option<bool>) -> ElementState {
    ElementState {
        checked: on,
        ..ElementState::default()
    }
}

fn plan_for(action: ElementAction, role: &str, before: &ElementState) -> Vec<Rung> {
    plan(&action, role, before, StateSet::empty(), false).expect("a plan")
}

#[test]
fn toggle_refuses_unknown_or_mixed_state() {
    let none = StateSet::empty();
    let err = plan(
        &ElementAction::Toggle,
        "checkbox",
        &checked(None),
        none,
        false,
    )
    .unwrap_err();
    assert_eq!(
        (err.code, err.delivery),
        (ErrorCode::ActionNotSupported, Delivery::NotDelivered)
    );
    let mixed = states(&[State::Indeterminate]);
    assert!(plan(
        &ElementAction::Toggle,
        "checkbox",
        &checked(Some(true)),
        mixed,
        false
    )
    .is_err());
    assert_eq!(
        plan_for(ElementAction::Toggle, "checkbox", &checked(Some(true))),
        vec![Rung::Verb {
            verbs: TOGGLE,
            expect: Expect::Checked(false)
        }]
    );
}

#[test]
fn check_uses_relative_verbs_only_from_known_state() {
    assert_eq!(
        plan_for(ElementAction::Check, "checkbox", &checked(None)),
        vec![Rung::Verb {
            verbs: CHECK_ONLY,
            expect: Expect::Checked(true)
        }]
    );
    assert_eq!(
        plan_for(ElementAction::Check, "checkbox", &checked(Some(false))),
        vec![Rung::Verb {
            verbs: CHECK,
            expect: Expect::Checked(true)
        }]
    );
    assert_eq!(
        plan_for(ElementAction::Check, "checkbox", &checked(Some(true))),
        vec![Rung::Already]
    );
    let none = StateSet::empty();
    let radio = plan(
        &ElementAction::Uncheck,
        "radiobutton",
        &checked(Some(true)),
        none,
        false,
    );
    assert!(radio.is_err());
}

#[test]
fn expand_select_press_and_scroll_plans() {
    let unknown = ElementState::default();
    assert_eq!(
        plan_for(ElementAction::Expand, "treeitem", &unknown),
        vec![Rung::Verb {
            verbs: EXPAND_ONLY,
            expect: Expect::Expanded(true)
        }]
    );
    let open = ElementState {
        expanded: Some(true),
        ..ElementState::default()
    };
    assert_eq!(
        plan_for(ElementAction::Expand, "treeitem", &open),
        vec![Rung::Already]
    );
    let select = plan_for(ElementAction::Select, "listitem", &unknown);
    assert_eq!(select[0], Rung::SelectChild { stateful: true });
    let press = plan_for(ElementAction::Press, "tab", &unknown);
    assert_eq!(press.last(), Some(&Rung::SelectChild { stateful: false }));
    assert_eq!(
        plan_for(ElementAction::ScrollIntoView, "button", &unknown),
        vec![Rung::ScrollTo]
    );
}

// ─── walk decisions ───────────────────────────────────────────────────────────

#[test]
fn passive_walks_skip_value_reads() {
    assert_eq!(value_source("textfield", false, false), ValueSource::None);
    assert_eq!(value_source("slider", false, false), ValueSource::None);
    assert_eq!(value_source("textfield", false, true), ValueSource::Text);
    assert_eq!(value_source("combobox", false, true), ValueSource::Text);
    assert_eq!(
        value_source("spinbutton", false, true),
        ValueSource::Numeric
    );
    assert_eq!(value_source("button", false, true), ValueSource::None);
    assert_eq!(
        value_source("textfield", true, true),
        ValueSource::None,
        "secure never reads"
    );
    assert!(!WalkLimits::passive().read_values);
    assert!(WalkLimits::platform_default().read_values);
}

#[test]
fn element_state_maps_atspi_states() {
    let set = states(&[State::Checkable, State::Checked, State::Focusable]);
    let s = element_state(set, "checkbox", None, false);
    assert_eq!(
        (s.checked, s.focused, s.expanded),
        (Some(true), Some(false), None)
    );
    let set = states(&[State::Indeterminate, State::Checked]);
    assert_eq!(element_state(set, "checkbox", None, false).checked, None);
    let set = states(&[State::Pressed]);
    assert_eq!(
        element_state(set, "togglebutton", None, false).checked,
        Some(true)
    );
    let set = states(&[State::Expandable, State::Selectable, State::Selected]);
    let s = element_state(set, "treeitem", None, false);
    assert_eq!((s.expanded, s.selected), (Some(false), Some(true)));
    let s = element_state(StateSet::empty(), "textfield", Some("secret".into()), true);
    assert_eq!((s.value, s.secure), (None, true));
}

#[test]
fn numbers_format_like_their_text() {
    assert_eq!(format_number(5.0).as_deref(), Some("5"));
    assert_eq!(format_number(-2.5).as_deref(), Some("-2.5"));
    assert_eq!(format_number(f64::NAN), None);
}

#[test]
fn bus_unavailable_is_perm_denied_with_a_suggestion() {
    let err = conn::bus_unavailable();
    assert_eq!(err.code, ErrorCode::PermDenied);
    assert_eq!(err.message, "AT-SPI accessibility bus unavailable");
    assert!(err.suggestion.is_some());
}

// ─── live (skipped at runtime without an AT-SPI bus) ──────────────────────────

#[test]
fn live_snapshot_reports_consistent_completeness() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    if rt.block_on(conn::connect()).is_err() {
        eprintln!("skipping: no AT-SPI accessibility bus");
        return;
    }
    match rt.block_on(LinuxAXTree.snapshot(SnapshotOptions::default())) {
        Ok(snap) => assert_eq!(snap.complete, snap.stats.complete()),
        Err(e) => assert!(
            matches!(e.code, ErrorCode::AppNotFound | ErrorCode::PermDenied),
            "unexpected {e}"
        ),
    }
}
