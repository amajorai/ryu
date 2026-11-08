//! English sources for the refusals Core gives when an agent whose model
//! providers are limited would launch an engine that calls a provider itself
//! (`agent_access::self_called_provider_permitted`).
//!
//! Same shape as the templates in [`super`]. The refusal is the launch check's
//! `reason` (`POST /api/agents/launch-check`) and the first turn's chat error,
//! so it stays plain English text on the wire; clients translate it by
//! matching these catalogued templates. `{engineLabel}` is the engine's name:
//! one of the two generic labels below (themselves catalogued, so a client
//! swaps in their translation) or the engine registry's brand name, which is
//! not translated. `{provider}` is a vendor's brand name (`Anthropic`).
#![allow(clippy::useless_format)]

use super::Template;

// ---- engine labels -------------------------------------------------------------

/// The engine label of an `acp-exec:` custom agent.
pub const AGENT_LAUNCH_CUSTOM_AGENT_LABEL_MESSAGE: Template = |_| format!("This custom agent");
/// The engine label of an SDK app.
pub const AGENT_LAUNCH_SDK_APP_LABEL_MESSAGE: Template = |_| format!("This SDK app");

// ---- refusals ------------------------------------------------------------------

/// The engine signs in to a vendor the agent's account access does not allow.
pub const AGENT_LAUNCH_VENDOR_REFUSAL_MESSAGE: Template = |arg| {
    format!(
        "{engineLabel} calls {provider} itself, using your own sign-in or key, and this agent's account access doesn't allow {provider}. Allow {provider} under Model providers in the agent's account access (an agent with only its own identity can't use your sign-ins, so choose Acts as you or Both first), or choose an engine that runs through Ryu's Gateway.",
        engineLabel = arg("engineLabel"),
        provider = arg("provider")
    )
};

/// The engine calls its provider itself because its Gateway routing is off.
pub const AGENT_LAUNCH_ROUTING_OFF_REFUSAL_MESSAGE: Template = |arg| {
    format!(
        "{engineLabel} calls its model provider itself while its Gateway routing is off, so Ryu can't limit which of your providers it uses. Turn Gateway routing on for this agent, or remove the model provider limit from its account access.",
        engineLabel = arg("engineLabel")
    )
};

/// The engine always calls its provider itself.
pub const AGENT_LAUNCH_SELF_CALLED_REFUSAL_MESSAGE: Template = |arg| {
    format!(
        "{engineLabel} calls its model provider itself, so Ryu can't limit which of your providers it uses, and an agent with limited model providers can't run it. Choose an engine that runs through Ryu's Gateway, or remove the model provider limit from its account access.",
        engineLabel = arg("engineLabel")
    )
};

/// A refusal template rendered in English, as the launch check's `reason`.
/// `provider` is ignored by the two templates that do not name one.
pub fn agent_launch_refusal(template: Template, engine_label: &str, provider: &str) -> String {
    template(&|name| match name {
        "engineLabel" => engine_label.to_owned(),
        "provider" => provider.to_owned(),
        _ => String::new(),
    })
}

/// An engine label template in English.
pub fn agent_launch_label(template: Template) -> String {
    template(&|_| String::new())
}

#[cfg(test)]
pub(super) const ALL: &[Template] = &[
    AGENT_LAUNCH_CUSTOM_AGENT_LABEL_MESSAGE,
    AGENT_LAUNCH_SDK_APP_LABEL_MESSAGE,
    AGENT_LAUNCH_VENDOR_REFUSAL_MESSAGE,
    AGENT_LAUNCH_ROUTING_OFF_REFUSAL_MESSAGE,
    AGENT_LAUNCH_SELF_CALLED_REFUSAL_MESSAGE,
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::Message;

    #[test]
    fn labels_are_whole_catalog_messages() {
        assert_eq!(
            agent_launch_label(AGENT_LAUNCH_CUSTOM_AGENT_LABEL_MESSAGE),
            "This custom agent"
        );
        assert_eq!(
            agent_launch_label(AGENT_LAUNCH_SDK_APP_LABEL_MESSAGE),
            "This SDK app"
        );
    }

    #[test]
    fn refusals_render_the_same_text_as_their_catalog_message() {
        for template in [
            AGENT_LAUNCH_VENDOR_REFUSAL_MESSAGE,
            AGENT_LAUNCH_ROUTING_OFF_REFUSAL_MESSAGE,
            AGENT_LAUNCH_SELF_CALLED_REFUSAL_MESSAGE,
        ] {
            let source = Message::new(template).source().to_owned();
            assert!(source.starts_with("{engineLabel} calls "), "{source}");
            let english = agent_launch_refusal(template, "Claude Code", "Anthropic");
            let message = Message::new(template)
                .text("engineLabel", "Claude Code")
                .text("provider", "Anthropic");
            assert_eq!(message.render("en"), english);
            assert!(english.starts_with("Claude Code calls "), "{english}");
            assert!(!english.contains('{'), "{english}");
        }
    }

    #[test]
    fn the_vendor_refusal_names_the_provider_each_time() {
        let english = agent_launch_refusal(
            AGENT_LAUNCH_VENDOR_REFUSAL_MESSAGE,
            &agent_launch_label(AGENT_LAUNCH_CUSTOM_AGENT_LABEL_MESSAGE),
            "OpenAI",
        );
        assert!(english.starts_with("This custom agent calls OpenAI itself,"));
        assert_eq!(english.matches("OpenAI").count(), 3);
    }
}
