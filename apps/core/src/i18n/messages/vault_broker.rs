//! English sources for Vault broker notifications: a credential use or an
//! agent proposal waiting for a human's approval.
//!
//! Same shape as the templates in [`super`]: each `*_MESSAGE` is a
//! [`Template`](crate::i18n::Template) built with `format!` and one named
//! argument per placeholder, written as a whole sentence. They are re-exported
//! from [`super`], so callers use `i18n::messages::NAME_MESSAGE`.
//!
//! Hosts, credential references, account and environment names are verbatim
//! text arguments. A count sentence has a `*_ONE_MESSAGE` form for a count of
//! 1, since the renderer has no ICU `plural` support.
#![allow(clippy::useless_format)]

use super::Template;

// ---- titles ---------------------------------------------------------------------

pub const VAULT_BROKER_CREDENTIAL_USE_TITLE_MESSAGE: Template =
    |_| format!("Credential use waiting for approval");
pub const VAULT_BROKER_PROPOSAL_TITLE_MESSAGE: Template =
    |_| format!("Agent proposal waiting for approval");

// ---- credential use, one sentence per consumer kind -------------------------------

pub const VAULT_BROKER_USE_BY_BROKER_SESSION_MESSAGE: Template = |arg| {
    format!(
        "A broker session minted by {minter} asks to use {reference} from the {account} account.",
        minter = arg("minter"),
        reference = arg("reference"),
        account = arg("account")
    )
};
pub const VAULT_BROKER_USE_BY_EXPLICIT_READ_MESSAGE: Template = |arg| {
    format!(
        "{principal} asks to use {reference} from the {account} account (explicit read).",
        principal = arg("principal"),
        reference = arg("reference"),
        account = arg("account")
    )
};
pub const VAULT_BROKER_USE_BY_RUNTIME_MESSAGE: Template = |arg| {
    format!(
        "MCP server or plugin {mcp} running for {owner} asks to use {reference} from the {account} account.",
        mcp = arg("mcp"),
        owner = arg("owner"),
        reference = arg("reference"),
        account = arg("account")
    )
};
pub const VAULT_BROKER_USE_BY_SUBJECT_MESSAGE: Template = |arg| {
    format!(
        "{subject} asks to use {reference} from the {account} account.",
        subject = arg("subject"),
        reference = arg("reference"),
        account = arg("account")
    )
};

// ---- agent proposals -------------------------------------------------------------

pub const VAULT_BROKER_SERVICES_ONE_MESSAGE: Template = |arg| {
    format!(
        "An agent asks for {count} service in {environment}: {hosts}.",
        count = arg("count"),
        environment = arg("environment"),
        hosts = arg("hosts")
    )
};
pub const VAULT_BROKER_SERVICES_MESSAGE: Template = |arg| {
    format!(
        "An agent asks for {count} services in {environment}: {hosts}.",
        count = arg("count"),
        environment = arg("environment"),
        hosts = arg("hosts")
    )
};
pub const VAULT_BROKER_CREDENTIALS_ONE_MESSAGE: Template = |arg| {
    format!(
        "An agent asks for {count} credential in {environment}: {references}.",
        count = arg("count"),
        environment = arg("environment"),
        references = arg("references")
    )
};
pub const VAULT_BROKER_CREDENTIALS_MESSAGE: Template = |arg| {
    format!(
        "An agent asks for {count} credentials in {environment}: {references}.",
        count = arg("count"),
        environment = arg("environment"),
        references = arg("references")
    )
};
pub const VAULT_BROKER_ALSO_CREDENTIALS_ONE_MESSAGE: Template = |arg| {
    format!(
        "It also asks for {count} credential: {references}.",
        count = arg("count"),
        references = arg("references")
    )
};
pub const VAULT_BROKER_ALSO_CREDENTIALS_MESSAGE: Template = |arg| {
    format!(
        "It also asks for {count} credentials: {references}.",
        count = arg("count"),
        references = arg("references")
    )
};
pub const VAULT_BROKER_BROKER_CHANGE_MESSAGE: Template = |arg| {
    format!(
        "An agent asks for a broker change in {environment}.",
        environment = arg("environment")
    )
};

/// Every template in this module, for the catalog round-trip test; add each
/// new `*_MESSAGE` here too.
#[cfg(test)]
pub(super) const ALL: &[Template] = &[
    VAULT_BROKER_CREDENTIAL_USE_TITLE_MESSAGE,
    VAULT_BROKER_PROPOSAL_TITLE_MESSAGE,
    VAULT_BROKER_USE_BY_BROKER_SESSION_MESSAGE,
    VAULT_BROKER_USE_BY_EXPLICIT_READ_MESSAGE,
    VAULT_BROKER_USE_BY_RUNTIME_MESSAGE,
    VAULT_BROKER_USE_BY_SUBJECT_MESSAGE,
    VAULT_BROKER_SERVICES_ONE_MESSAGE,
    VAULT_BROKER_SERVICES_MESSAGE,
    VAULT_BROKER_CREDENTIALS_ONE_MESSAGE,
    VAULT_BROKER_CREDENTIALS_MESSAGE,
    VAULT_BROKER_ALSO_CREDENTIALS_ONE_MESSAGE,
    VAULT_BROKER_ALSO_CREDENTIALS_MESSAGE,
    VAULT_BROKER_BROKER_CHANGE_MESSAGE,
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::Message;

    #[test]
    fn every_body_template_is_a_whole_english_sentence() {
        // The two titles are headings; every other template is a sentence.
        for template in &ALL[2..] {
            let source = Message::new(*template).source().to_owned();
            assert!(source.ends_with('.'), "{source}");
            assert!(!source.contains("{{"), "{source}");
        }
        let sentence = Message::new(VAULT_BROKER_SERVICES_MESSAGE)
            .number("count", 2.0, 0, 0)
            .text("environment", "prod")
            .text("hosts", "a.test, b.test")
            .render("en");
        assert_eq!(
            sentence,
            "An agent asks for 2 services in prod: a.test, b.test."
        );
    }
}
