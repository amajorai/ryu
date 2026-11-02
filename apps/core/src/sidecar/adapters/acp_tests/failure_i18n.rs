//! Every failed-turn card carries Core messages (`i18n`) whose English render
//! is exactly the card's English title (and message, when Core wrote it), so a
//! reader in another locale gets the same copy translated.

use super::*;
use crate::i18n::AlertText;
use agent_client_protocol::schema::v1::McpServerStdio;

fn i18n(failure: &AcpFailure) -> &AlertText {
    failure
        .i18n
        .as_ref()
        .unwrap_or_else(|| panic!("{} has no i18n", failure.code))
}

/// A failure whose title and body are both Core messages.
fn assert_localized(failure: &AcpFailure) {
    let (title, message) = i18n(failure).render("en");
    assert_eq!(title, failure.title, "{}", failure.code);
    assert_eq!(message, failure.message, "{}", failure.code);
    let wire = AlertText::from_wire(&failure.i18n_wire().unwrap()).expect("wire parses");
    assert_eq!(&wire, i18n(failure));
}

/// A failure whose body relays a raw error the card shows as-is.
fn assert_relayed(failure: &AcpFailure, message: &str) {
    let text = i18n(failure);
    assert_eq!(text.title.render("en"), failure.title, "{}", failure.code);
    assert!(text.body.is_empty(), "{}", failure.code);
    assert_eq!(failure.message, message);
}

#[test]
fn provider_failures_carry_their_messages() {
    for (provider, detail, code, title) in [
        (
            Some("anthropic"),
            "Third-party apps now draw from your extra usage",
            "provider_usage_unavailable",
            "Claude usage unavailable",
        ),
        (
            Some(crate::pi_config::MANAGED_OPENROUTER_ID),
            "HTTP 402 (insufficient_credits)",
            "insufficient_credits",
            "Ryu credits exhausted",
        ),
        (
            Some("openrouter"),
            "HTTP 402 (provider_payment_required)",
            "provider_payment_required",
            "OpenRouter credits exhausted",
        ),
        (None, "connection refused", "agent_error", "Request failed"),
    ] {
        let failure = classify_prompt_failure(provider, detail);
        assert_eq!(failure.code, code);
        assert_eq!(failure.title, title);
        assert_localized(&failure);
    }
    let failure = classify_prompt_failure(None, "connection refused");
    assert_eq!(
        failure.message,
        "The agent could not complete the turn because its model provider is unavailable or misconfigured. Check Engines in Settings, then retry. (details: connection refused)"
    );
}

#[test]
fn start_and_connection_failures_carry_their_messages() {
    let login = auth_required_failure();
    assert_eq!(login.title, "Agent login expired");
    assert_localized(&login);

    let start = agent_start_failure("spawn ENOENT");
    assert_eq!(
        start.message,
        "The agent could not start, so the message was not sent. Send it again to retry. (details: spawn ENOENT)"
    );
    assert_localized(&start);

    let (gateway, _) = instance_start_failure(&anyhow::Error::new(GatewayStartupPending));
    assert_eq!(gateway.code, "gateway_starting");
    assert_eq!(gateway.message, GatewayStartupPending.to_string());
    assert_localized(&gateway);

    let paused = execution_paused_failure(crate::execution_control::PAUSED_MESSAGE);
    assert_eq!(paused.message, crate::execution_control::PAUSED_MESSAGE);
    assert_localized(&paused);
    assert_relayed(
        &execution_paused_failure("Paused by policy"),
        "Paused by policy",
    );

    assert_relayed(&pi_account_failure("refresh revoked"), "refresh revoked");
}

#[test]
fn sandbox_refusal_keeps_its_english_and_carries_both_sentences() {
    use crate::agent_access::AccountConfinement;
    let providers = account_sandbox_failure("no bwrap", AccountConfinement::CoreStateAndProviders);
    assert!(providers.message.contains(
        "(no bwrap), so it did not start the agent. Ryu's own engine can still run it here"
    ));
    assert_eq!(i18n(&providers).body.len(), 2);
    assert_localized(&providers);
    let other = account_sandbox_failure("no bwrap", AccountConfinement::CoreState);
    assert!(other.message.ends_with("without its shell and file tools."));
    assert_localized(&other);
}

#[test]
fn untrusted_launch_refusal_is_a_core_message_and_other_text_is_relayed() {
    let launch =
        McpServerStdio::new("agent", "/usr/local/bin/npx").args(vec!["-y".into(), "pi-acp".into()]);
    let refusal = untrusted_launch_refusal(&launch).expect("package runner is refused");
    assert!(refusal.starts_with("Ryu did not start this agent: its launch (npx) goes through"));
    let failure = untrusted_launch_failure(&refusal);
    assert_eq!(failure.message, refusal);
    assert_eq!(failure.title, "Agent not started in an untrusted folder");
    assert_localized(&failure);

    assert_relayed(&untrusted_launch_failure("refused"), "refused");
}

#[test]
fn every_acp_message_renders_its_english_source() {
    // The card's i18n wire names the same sources the extractor catalogs.
    let failure = auth_required_failure();
    let wire = failure.i18n_wire().unwrap();
    assert_eq!(wire["title"]["message"], "Agent login expired");
    assert_eq!(
        wire["body"][0]["message"],
        "Your agent login expired. Log in again, then re-send your message."
    );
    assert_eq!(wire["join"], "sentences");
}
