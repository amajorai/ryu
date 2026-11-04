//! Tests for the update apply path (`apply.rs`).

use super::*;

#[test]
fn update_mutations_require_node_management_before_side_effects() {
    let source = crate::server::tests::source_text::server_source();
    for (handler, mutation) in [
        (
            "async fn update_apply(",
            "crate::update::apply::apply_update(",
        ),
        (
            "async fn schedule_update(",
            "crate::update::schedule::set_pending(",
        ),
        (
            "async fn cancel_update_schedule(",
            "crate::update::schedule::clear_pending(",
        ),
    ] {
        let body = source
            .split_once(handler)
            .unwrap()
            .1
            .split_once("\n}\n")
            .unwrap()
            .0;
        let permission = body
            .find("crate::identity_verify::permissions::NODES_MANAGE")
            .unwrap();
        assert!(body.contains("if let Err(status) = enforce_permission("));
        assert!(permission < body.find(mutation).unwrap(), "{handler}");
    }
}

#[test]
fn apply_outcomes_carry_a_stable_id_values_and_an_english_sentence() {
    let result = ApplyResult::rendered(
        false,
        "/tmp/staged".into(),
        &ApplyOutcome::RunInstaller { kind: "dmg".into() },
        false,
        "en",
    );
    assert_eq!(result.message_id, "update.run_installer");
    assert_eq!(
        result.message,
        "Update downloaded. Run the dmg installer to complete the update."
    );
    assert_eq!(
        result.message_values.get("kind").map(String::as_str),
        Some("dmg")
    );
    let wire = serde_json::to_value(&result).unwrap();
    assert_eq!(wire["message_id"], "update.run_installer");
    assert_eq!(wire["message_values"]["kind"], "dmg");
    assert!(wire.get("gateway_left_behind").is_none());

    let left_behind = ApplyOutcome::GatewayLeftBehind {
        detail: "disk full".into(),
    };
    let result = ApplyResult::rendered(true, String::new(), &left_behind, true, "en");
    assert_eq!(result.message_id, "update.gateway_left_behind");
    assert!(result.message.contains("(disk full)"), "{}", result.message);
    assert_eq!(
        result.message_values.get("detail").map(String::as_str),
        Some("disk full")
    );
}

#[test]
fn apply_outcome_messages_are_rendered_through_the_catalog_locale() {
    // An unsupported tag falls back to the English source with values filled in.
    let message = ApplyOutcome::ReplaceBinary.message();
    assert_eq!(
        message.render("xx"),
        "Update downloaded. Extract and replace the binary to complete the update."
    );
    for outcome in [
        ApplyOutcome::InstalledWithGateway,
        ApplyOutcome::Installed,
        ApplyOutcome::ReplaceBinary,
    ] {
        assert!(outcome.values().is_empty());
        assert!(!outcome.message().render("de").contains('{'));
    }
}

#[test]
fn every_swap_re_hashes_the_staged_bytes_against_the_trusted_digest_first() {
    let source = include_str!("apply.rs").replace("\r\n", "\n");
    for (function, swap) in [
        ("pub async fn apply_update(", "replace_current_exe(&staged)"),
        (
            "async fn update_gateway_alongside(",
            "replace_exe_at(&gateway, &staged)",
        ),
    ] {
        let body = source
            .split_once(function)
            .unwrap()
            .1
            .split_once("\n}\n")
            .unwrap()
            .0;
        let trusted = body.find(".digest_for(").expect(function);
        let rehashed = body
            .find("ensure_staged_digest(&staged, &digest)")
            .expect(function);
        let swapped = body.find(swap).expect(function);
        assert!(trusted < rehashed && rehashed < swapped, "{function}");
    }
}
