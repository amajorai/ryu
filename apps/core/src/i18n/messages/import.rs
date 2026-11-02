//! English sources for the setup-import scan (`crate::import`): the item
//! titles and details and the "set these up again" warnings the desktop shows
//! in onboarding migration and the import dialog.
//!
//! Same shape as the templates in [`super`]. Core sends each one with its
//! values (`title_i18n`, `detail_i18n`, `warning_notices[].i18n`) next to the
//! English text, and the desktop renders it in the reader's language. Core's
//! renderer has no plural forms, so a counted noun has one template for one
//! and one for more. `{source}` is a product or framework name (`ChatGPT`,
//! `Claude`, `OpenClaw`, …); `{name}`, `{file}`, `{path}` and `{names}` are
//! names from the scanned folder, inserted verbatim.
#![allow(clippy::useless_format)]

use super::Template;

// ---- item titles ---------------------------------------------------------------

pub const IMPORT_INSTRUCTIONS_TITLE_MESSAGE: Template =
    |arg| format!("Project instructions ({file})", file = arg("file"));
pub const IMPORT_MCP_SERVER_TITLE_MESSAGE: Template =
    |arg| format!("MCP server '{name}'", name = arg("name"));
pub const IMPORT_PLUGIN_TITLE_MESSAGE: Template =
    |arg| format!("Plugin bundle '{name}'", name = arg("name"));
pub const IMPORT_SKILL_TITLE_MESSAGE: Template =
    |arg| format!("Agent skill '{name}'", name = arg("name"));
pub const IMPORT_MEMORY_TITLE_MESSAGE: Template =
    |arg| format!("Claude Code memory {name}", name = arg("name"));
pub const IMPORT_AGENT_TITLE_MESSAGE: Template =
    |arg| format!("Codex agent '{name}'", name = arg("name"));
pub const IMPORT_SLASH_COMMAND_TITLE_MESSAGE: Template =
    |arg| format!("Slash command '/{name}'", name = arg("name"));
pub const IMPORT_SOURCE_AGENT_TITLE_MESSAGE: Template = |arg| {
    format!(
        "Agent '{name}' from {source}",
        source = arg("source"),
        name = arg("name")
    )
};
pub const IMPORT_SOURCE_MEMORY_ONE_TITLE_MESSAGE: Template = |arg| {
    format!(
        "Memory {name} from {source} (1 entry)",
        source = arg("source"),
        name = arg("name")
    )
};
pub const IMPORT_SOURCE_MEMORY_TITLE_MESSAGE: Template = |arg| {
    format!(
        "Memory {name} from {source} ({count} entries)",
        source = arg("source"),
        name = arg("name"),
        count = arg("count")
    )
};
pub const IMPORT_EXPORT_CHATS_TITLE_MESSAGE: Template = |arg| {
    format!(
        "Chats from {source} ({count})",
        source = arg("source"),
        count = arg("count")
    )
};
pub const IMPORT_EXPORT_PROJECT_TITLE_MESSAGE: Template = |arg| {
    format!(
        "Project '{name}' from {source}",
        source = arg("source"),
        name = arg("name")
    )
};
pub const IMPORT_EXPORT_PROJECT_ONE_CHAT_TITLE_MESSAGE: Template = |arg| {
    format!(
        "Project '{name}' from {source} (1 chat)",
        source = arg("source"),
        name = arg("name")
    )
};
pub const IMPORT_EXPORT_PROJECT_CHATS_TITLE_MESSAGE: Template = |arg| {
    format!(
        "Project '{name}' from {source} ({count} chats)",
        source = arg("source"),
        name = arg("name"),
        count = arg("count")
    )
};
pub const IMPORT_CHATGPT_INSTRUCTIONS_TITLE_MESSAGE: Template =
    |_| format!("ChatGPT custom instructions");
pub const IMPORT_CLAUDE_MEMORY_TITLE_MESSAGE: Template = |_| format!("Claude memory");

// ---- export project details (whole sentences, joined with a space) ---------

pub const IMPORT_LATEST_CHAT_DETAIL_MESSAGE: Template =
    |arg| format!("Latest chat: “{title}”.", title = arg("title"));
pub const IMPORT_PROJECT_FOLDER_DETAIL_MESSAGE: Template = |_| format!("Becomes a project folder.");
pub const IMPORT_PROJECT_FOLDER_INSTRUCTIONS_DETAIL_MESSAGE: Template =
    |_| format!("Becomes a project folder with its instructions.");
pub const IMPORT_PROJECT_FOLDER_MEMORY_DETAIL_MESSAGE: Template =
    |_| format!("Becomes a project folder with its memory.");
pub const IMPORT_PROJECT_FOLDER_INSTRUCTIONS_MEMORY_DETAIL_MESSAGE: Template =
    |_| format!("Becomes a project folder with its instructions and memory.");
pub const IMPORT_PROJECT_ONE_FILE_DETAIL_MESSAGE: Template = |_| format!("Adds 1 knowledge file.");
pub const IMPORT_PROJECT_FILES_DETAIL_MESSAGE: Template =
    |arg| format!("Adds {count} knowledge files.", count = arg("count"));

// ---- scan warnings: generic ------------------------------------------------------

pub const IMPORT_TOO_LARGE_WARNING_MESSAGE: Template = |arg| {
    format!(
        "Skipped {path} because it is too large to scan.",
        path = arg("path")
    )
};

// ---- scan warnings: ChatGPT and Claude exports -----------------------------------

pub const IMPORT_EXPORT_UNREADABLE_WARNING_MESSAGE: Template = |arg| {
    format!(
        "Could not read the {source} export: {error}",
        source = arg("source"),
        error = arg("error")
    )
};
pub const IMPORT_CHATGPT_NO_PROJECTS_WARNING_MESSAGE: Template = |_| {
    format!("ChatGPT does not export project names, files, or saved memories. Imported projects get placeholder names; rename them in Ryu and add their files to the project folder.")
};
pub const IMPORT_CLAUDE_NO_MEMORIES_WARNING_MESSAGE: Template = |_| {
    format!(
        "This Claude export has no memories file; saved memory was not included in the download."
    )
};
pub const IMPORT_CLAUDE_PROJECT_CHATS_WARNING_MESSAGE: Template = |_| {
    format!("Claude exports do not record which project a chat belongs to, so project chats are imported with your other Claude chats. Each project still becomes a folder with its instructions, knowledge files, and memory.")
};
pub const IMPORT_EXPORT_PLACEHOLDERS_WARNING_MESSAGE: Template = |arg| {
    format!(
        "Images, uploaded files, and tool results in {source} chats are imported as text placeholders.",
        source = arg("source")
    )
};

// ---- scan warnings: OpenClaw, Hermes, Muse ----------------------------------------

pub const IMPORT_OPENCLAW_CONFIG_UNREADABLE_WARNING_MESSAGE: Template = |_| {
    format!("OpenClaw config could not be parsed; MCP servers and the default model were not read.")
};
pub const IMPORT_OPENCLAW_WORKSPACE_OUTSIDE_WARNING_MESSAGE: Template = |arg| {
    format!(
        "OpenClaw workspace {path} is outside the scanned folder; scan it separately to import its persona and memory.",
        path = arg("path")
    )
};
pub const IMPORT_OPENCLAW_CHANNELS_WARNING_MESSAGE: Template = |arg| {
    format!(
        "Channels configured in OpenClaw ({names}) are not imported; reconnect them in Ryu Channels. Bot tokens are never copied by a scan.",
        names = arg("names")
    )
};
pub const IMPORT_OPENCLAW_PROVIDERS_WARNING_MESSAGE: Template = |_| {
    format!("OpenClaw custom model providers are not imported; add them in Ryu Providers (keys go to the Secret Vault).")
};
pub const IMPORT_OPENCLAW_CRON_WARNING_MESSAGE: Template =
    |_| format!("OpenClaw cron jobs are not imported; recreate them as Ryu schedules.");
pub const IMPORT_HERMES_CRON_WARNING_MESSAGE: Template =
    |_| format!("Hermes cron jobs are not imported; recreate them as Ryu schedules.");
pub const IMPORT_HERMES_AUTH_WARNING_MESSAGE: Template =
    |_| format!("Hermes OAuth provider sign-ins are not copied; sign in again in Ryu Providers.");
pub const IMPORT_HERMES_SESSIONS_WARNING_MESSAGE: Template =
    |_| format!("Hermes gateway sessions are runtime state and are not imported.");
pub const IMPORT_MUSE_DREAMS_WARNING_MESSAGE: Template = |_| {
    format!("Muse dream reviews (dreams/) are archived reflections, not memories; they are not imported.")
};
pub const IMPORT_MUSE_ALIGNMENT_WARNING_MESSAGE: Template = |arg| {
    format!(
        "Muse {file} is not imported automatically; review it and add standing guidance to the agent if you want it.",
        file = arg("file")
    )
};
pub const IMPORT_HEARTBEAT_WARNING_MESSAGE: Template = |arg| {
    format!(
        "The file {path} is not imported; recreate the heartbeat as a Ryu schedule.",
        path = arg("path")
    )
};
pub const IMPORT_BOOTSTRAP_WARNING_MESSAGE: Template = |arg| {
    format!(
        "The file {path} is a first-run script and is not imported.",
        path = arg("path")
    )
};
pub const IMPORT_ENV_ONE_CREDENTIAL_WARNING_MESSAGE: Template = |arg| {
    format!(
        "The {source} .env file holds 1 credential ({names}). Credentials are never imported by a scan; move it into the Secret Vault with {migrateCommand} or {importCommand}.",
        source = arg("source"),
        names = arg("names"),
        migrateCommand = arg("migrateCommand"),
        importCommand = arg("importCommand")
    )
};
pub const IMPORT_ENV_CREDENTIALS_WARNING_MESSAGE: Template = |arg| {
    format!(
        "The {source} .env file holds {count} credentials ({names}). Credentials are never imported by a scan; move them into the Secret Vault with {migrateCommand} or {importCommand}.",
        source = arg("source"),
        count = arg("count"),
        names = arg("names"),
        migrateCommand = arg("migrateCommand"),
        importCommand = arg("importCommand")
    )
};

// ---- scan warnings: code-defined agents (Mastra, LangChain) -----------------------

pub const IMPORT_RUNTIME_AGENT_ONE_WARNING_MESSAGE: Template = |arg| {
    format!(
        "One agent whose instructions are built at runtime was not imported ({names}); copy its prompt into a Ryu agent manually.",
        names = arg("names")
    )
};
pub const IMPORT_RUNTIME_AGENTS_WARNING_MESSAGE: Template = |arg| {
    format!(
        "{count} agents whose instructions are built at runtime were not imported ({names}); copy their prompts into a Ryu agent manually.",
        count = arg("count"),
        names = arg("names")
    )
};
pub const IMPORT_CODE_NOT_CONVERTED_WARNING_MESSAGE: Template = |arg| {
    format!(
        "Tools, workflows, and graphs in {source} code are not converted. Expose existing tools to Ryu through an MCP server, or point the project's model client at Ryu Gateway's OpenAI-compatible endpoint to keep running it unchanged.",
        source = arg("source")
    )
};

pub(super) const ALL: &[Template] = &[
    IMPORT_INSTRUCTIONS_TITLE_MESSAGE,
    IMPORT_MCP_SERVER_TITLE_MESSAGE,
    IMPORT_PLUGIN_TITLE_MESSAGE,
    IMPORT_SKILL_TITLE_MESSAGE,
    IMPORT_MEMORY_TITLE_MESSAGE,
    IMPORT_AGENT_TITLE_MESSAGE,
    IMPORT_SLASH_COMMAND_TITLE_MESSAGE,
    IMPORT_SOURCE_AGENT_TITLE_MESSAGE,
    IMPORT_SOURCE_MEMORY_ONE_TITLE_MESSAGE,
    IMPORT_SOURCE_MEMORY_TITLE_MESSAGE,
    IMPORT_EXPORT_CHATS_TITLE_MESSAGE,
    IMPORT_EXPORT_PROJECT_TITLE_MESSAGE,
    IMPORT_EXPORT_PROJECT_ONE_CHAT_TITLE_MESSAGE,
    IMPORT_EXPORT_PROJECT_CHATS_TITLE_MESSAGE,
    IMPORT_CHATGPT_INSTRUCTIONS_TITLE_MESSAGE,
    IMPORT_CLAUDE_MEMORY_TITLE_MESSAGE,
    IMPORT_LATEST_CHAT_DETAIL_MESSAGE,
    IMPORT_PROJECT_FOLDER_DETAIL_MESSAGE,
    IMPORT_PROJECT_FOLDER_INSTRUCTIONS_DETAIL_MESSAGE,
    IMPORT_PROJECT_FOLDER_MEMORY_DETAIL_MESSAGE,
    IMPORT_PROJECT_FOLDER_INSTRUCTIONS_MEMORY_DETAIL_MESSAGE,
    IMPORT_PROJECT_ONE_FILE_DETAIL_MESSAGE,
    IMPORT_PROJECT_FILES_DETAIL_MESSAGE,
    IMPORT_TOO_LARGE_WARNING_MESSAGE,
    IMPORT_EXPORT_UNREADABLE_WARNING_MESSAGE,
    IMPORT_CHATGPT_NO_PROJECTS_WARNING_MESSAGE,
    IMPORT_CLAUDE_NO_MEMORIES_WARNING_MESSAGE,
    IMPORT_CLAUDE_PROJECT_CHATS_WARNING_MESSAGE,
    IMPORT_EXPORT_PLACEHOLDERS_WARNING_MESSAGE,
    IMPORT_OPENCLAW_CONFIG_UNREADABLE_WARNING_MESSAGE,
    IMPORT_OPENCLAW_WORKSPACE_OUTSIDE_WARNING_MESSAGE,
    IMPORT_OPENCLAW_CHANNELS_WARNING_MESSAGE,
    IMPORT_OPENCLAW_PROVIDERS_WARNING_MESSAGE,
    IMPORT_OPENCLAW_CRON_WARNING_MESSAGE,
    IMPORT_HERMES_CRON_WARNING_MESSAGE,
    IMPORT_HERMES_AUTH_WARNING_MESSAGE,
    IMPORT_HERMES_SESSIONS_WARNING_MESSAGE,
    IMPORT_MUSE_DREAMS_WARNING_MESSAGE,
    IMPORT_MUSE_ALIGNMENT_WARNING_MESSAGE,
    IMPORT_HEARTBEAT_WARNING_MESSAGE,
    IMPORT_BOOTSTRAP_WARNING_MESSAGE,
    IMPORT_ENV_ONE_CREDENTIAL_WARNING_MESSAGE,
    IMPORT_ENV_CREDENTIALS_WARNING_MESSAGE,
    IMPORT_RUNTIME_AGENT_ONE_WARNING_MESSAGE,
    IMPORT_RUNTIME_AGENTS_WARNING_MESSAGE,
    IMPORT_CODE_NOT_CONVERTED_WARNING_MESSAGE,
];
