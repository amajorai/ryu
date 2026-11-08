//! English sources for the failure lines of a setup or chat-history import
//! run (`crate::server::session_imports`): the per-item titles and reasons the
//! desktop Import dialog lists under "failed".
//!
//! Same shape as the templates in [`super`]. Core sends each one as
//! `title_i18n` / `detail_i18n` next to the English `title` / `detail` on an
//! `ImportOutcome`, and the desktop renders it in the reader's language. A
//! relayed error (`{error}`) stays as Core wrote it. `{name}`, `{url}` and
//! `{kind}` come from the scanned folder or the request, inserted verbatim.
#![allow(clippy::useless_format)]

use super::Template;

// ---- item titles ---------------------------------------------------------------

// MCP servers, plugins and slash commands reuse their scan titles in `import`.
pub const IMPORT_OUTCOME_AGENT_TITLE_MESSAGE: Template =
    |arg| format!("Agent definition '{name}'", name = arg("name"));

// ---- failure reasons -------------------------------------------------------------

pub const IMPORT_OUTCOME_UNREADABLE_AGENT_MESSAGE: Template =
    |_| format!("The file is not a readable agent definition.");
pub const IMPORT_OUTCOME_UNREADABLE_CODEX_COMMAND_MESSAGE: Template =
    |_| format!("The file is not a readable Codex prompt.");
pub const IMPORT_OUTCOME_NO_MANIFEST_MESSAGE: Template =
    |_| format!("No plugin manifest was found in this folder.");
pub const IMPORT_OUTCOME_INVALID_MCP_NAME_MESSAGE: Template = |arg| {
    format!(
        "The name “{name}” is not a valid MCP server name.",
        name = arg("name")
    )
};
pub const IMPORT_OUTCOME_MCP_TRANSPORT_MESSAGE: Template = |_| {
    format!("The MCP server must declare either a command (stdio) or a URL (remote), not both.")
};
pub const IMPORT_OUTCOME_UNSAFE_URL_MESSAGE: Template = |arg| {
    format!(
        "The URL “{url}” is not safe to connect to: {error}",
        url = arg("url"),
        error = arg("error")
    )
};
pub const IMPORT_OUTCOME_UNREADABLE_MEMORY_MESSAGE: Template =
    |_| format!("The file is not a readable memory file.");
pub const IMPORT_OUTCOME_SENSITIVE_MEMORY_MESSAGE: Template =
    |_| format!("Sensitive topics are turned off in Settings → Memory.");
pub const IMPORT_OUTCOME_EMPTY_MEMORY_MESSAGE: Template = |_| format!("The memory has no content.");
pub const IMPORT_OUTCOME_NOT_CHAT_EXPORT_MESSAGE: Template =
    |_| format!("The folder is not a ChatGPT or Claude export.");
pub const IMPORT_OUTCOME_INVALID_CONVERSATIONS_MESSAGE: Template =
    |_| format!("The selected conversations are not part of this export.");
pub const IMPORT_OUTCOME_MEMBER_REQUIRED_MESSAGE: Template =
    |_| format!("Importing chat history requires a signed-in member of this node.");
pub const IMPORT_OUTCOME_UNKNOWN_KIND_MESSAGE: Template = |arg| {
    format!(
        "Items of kind “{kind}” cannot be imported.",
        kind = arg("kind")
    )
};

pub(super) const ALL: &[Template] = &[
    IMPORT_OUTCOME_AGENT_TITLE_MESSAGE,
    IMPORT_OUTCOME_UNREADABLE_AGENT_MESSAGE,
    IMPORT_OUTCOME_UNREADABLE_CODEX_COMMAND_MESSAGE,
    IMPORT_OUTCOME_NO_MANIFEST_MESSAGE,
    IMPORT_OUTCOME_INVALID_MCP_NAME_MESSAGE,
    IMPORT_OUTCOME_MCP_TRANSPORT_MESSAGE,
    IMPORT_OUTCOME_UNSAFE_URL_MESSAGE,
    IMPORT_OUTCOME_UNREADABLE_MEMORY_MESSAGE,
    IMPORT_OUTCOME_SENSITIVE_MEMORY_MESSAGE,
    IMPORT_OUTCOME_EMPTY_MEMORY_MESSAGE,
    IMPORT_OUTCOME_NOT_CHAT_EXPORT_MESSAGE,
    IMPORT_OUTCOME_INVALID_CONVERSATIONS_MESSAGE,
    IMPORT_OUTCOME_MEMBER_REQUIRED_MESSAGE,
    IMPORT_OUTCOME_UNKNOWN_KIND_MESSAGE,
];

#[cfg(test)]
mod tests {
    use super::*;

    fn arg(name: &'static str) -> String {
        format!("<{name}>")
    }

    #[test]
    fn templates_insert_their_named_arguments_verbatim() {
        assert_eq!(
            IMPORT_OUTCOME_AGENT_TITLE_MESSAGE(&arg),
            "Agent definition '<name>'"
        );
        assert_eq!(
            IMPORT_OUTCOME_UNSAFE_URL_MESSAGE(&arg),
            "The URL “<url>” is not safe to connect to: <error>"
        );
        assert_eq!(
            IMPORT_OUTCOME_UNKNOWN_KIND_MESSAGE(&arg),
            "Items of kind “<kind>” cannot be imported."
        );
    }

    #[test]
    fn every_template_is_registered_and_renders_text() {
        assert_eq!(ALL.len(), 14);
        for template in ALL {
            assert!(!template(&arg).trim().is_empty());
        }
    }
}
