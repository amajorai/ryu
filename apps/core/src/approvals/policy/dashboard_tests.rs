//! The dashboard builder's write tools are gated like routine creation
//! (security finding CE-7).

use super::*;

const WRITES: [&str; 2] = [
    "dashboard_builder.create_dashboard",
    "dashboard_builder.configure_dashboard",
];

#[test]
fn dashboard_builder_writes_gate_in_the_default_mode() {
    for tool in WRITES {
        // The unset preference resolves to `smart`, the mode of a default install.
        let tags = should_require_approval_local(&[], tool, ApprovalMode::Smart, None)
            .unwrap_or_else(|| panic!("{tool} must ask in the default mode"));
        assert!(tags.iter().any(|tag| tag == "dashboard-mutation"), "{tool}");
        assert!(
            should_require_approval_local(&[], tool, ApprovalMode::Smart, Some("smart")).is_some(),
            "{tool}"
        );
        assert!(
            should_require_approval_local(&[], tool, ApprovalMode::Manual, Some("manual"))
                .is_some(),
            "{tool}"
        );
    }
}

#[test]
fn the_legacy_id_spelling_gates_too() {
    for tool in [
        "dashboard_builder__create_dashboard",
        "dashboard_builder__configure_dashboard",
    ] {
        assert!(
            should_require_approval_local(&[], tool, ApprovalMode::Smart, None).is_some(),
            "{tool}"
        );
    }
}

#[test]
fn only_an_explicit_off_skips_the_dashboard_gate() {
    for tool in WRITES {
        assert!(
            should_require_approval_local(&[], tool, ApprovalMode::Off, Some("off")).is_none(),
            "{tool}"
        );
        // An unset preference is not an opt-out, whatever mode the caller resolved.
        assert!(
            should_require_approval_local(&[], tool, ApprovalMode::Off, None).is_some(),
            "{tool}"
        );
    }
}

#[test]
fn reading_a_dashboard_stays_ungated_in_smart_mode() {
    assert!(should_require_approval_local(
        &[],
        "dashboard_builder.get_dashboard",
        ApprovalMode::Smart,
        None
    )
    .is_none());
}
