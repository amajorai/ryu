//! Review notes for what a framework home holds but Ryu does not import.

use super::*;

pub(super) fn collect_openclaw_notes(root: &Path, c: &mut Collector) {
    let Some(config) = read_openclaw_config(root) else {
        if OPENCLAW_CONFIG_FILES.iter().any(|f| root.join(f).is_file()) {
            c.warn(Message::new(
                messages::IMPORT_OPENCLAW_CONFIG_UNREADABLE_WARNING_MESSAGE,
            ));
        }
        note_persona_leftovers(root, c);
        return;
    };
    if let Some(workspace) = config
        .pointer("/agents/defaults/workspace")
        .and_then(Value::as_str)
    {
        let resolved = expand_home(workspace);
        if resolved
            .canonicalize()
            .ok()
            .is_some_and(|p| !p.starts_with(root))
        {
            c.warn(
                Message::new(messages::IMPORT_OPENCLAW_WORKSPACE_OUTSIDE_WARNING_MESSAGE)
                    .text("path", workspace),
            );
        }
    }
    if let Some(channels) = config.get("channels").and_then(Value::as_object) {
        let names: Vec<&str> = channels.keys().map(String::as_str).collect();
        if !names.is_empty() {
            c.warn(
                Message::new(messages::IMPORT_OPENCLAW_CHANNELS_WARNING_MESSAGE)
                    .text("names", names.join(", ")),
            );
        }
    }
    if config.pointer("/models/providers").is_some() {
        c.warn(Message::new(
            messages::IMPORT_OPENCLAW_PROVIDERS_WARNING_MESSAGE,
        ));
    }
    note_persona_leftovers(root, c);
    if root.join("cron").is_dir() {
        c.warn(Message::new(messages::IMPORT_OPENCLAW_CRON_WARNING_MESSAGE));
    }
}

pub(super) fn collect_hermes_notes(root: &Path, c: &mut Collector) {
    note_persona_leftovers(root, c);
    if root.join("cron").is_dir() {
        c.warn(Message::new(messages::IMPORT_HERMES_CRON_WARNING_MESSAGE));
    }
    if root.join("auth.json").is_file() {
        c.warn(Message::new(messages::IMPORT_HERMES_AUTH_WARNING_MESSAGE));
    }
    if root.join("sessions").is_dir() {
        c.warn(Message::new(
            messages::IMPORT_HERMES_SESSIONS_WARNING_MESSAGE,
        ));
    }
}

pub(super) fn collect_muse_notes(root: &Path, c: &mut Collector) {
    note_persona_leftovers(root, c);
    if root.join("dreams").is_dir() {
        c.warn(Message::new(messages::IMPORT_MUSE_DREAMS_WARNING_MESSAGE));
    }
    if root.join("ALIGNMENT_SYNTHESIS.md").is_file() {
        c.warn(
            Message::new(messages::IMPORT_MUSE_ALIGNMENT_WARNING_MESSAGE)
                .text("file", "ALIGNMENT_SYNTHESIS.md"),
        );
    }
}

/// Persona-adjacent files with no direct Ryu equivalent.
pub(super) fn note_persona_leftovers(root: &Path, c: &mut Collector) {
    let mut dirs = vec![root.to_path_buf()];
    dirs.extend(persona_workspaces(root, Framework::OpenClaw));
    dirs.dedup();
    for dir in dirs {
        if dir.join("HEARTBEAT.md").is_file() {
            c.warn(
                Message::new(messages::IMPORT_HEARTBEAT_WARNING_MESSAGE)
                    .text("path", dir.join("HEARTBEAT.md").to_string_lossy()),
            );
        }
        if dir.join("BOOTSTRAP.md").is_file() {
            c.warn(
                Message::new(messages::IMPORT_BOOTSTRAP_WARNING_MESSAGE)
                    .text("path", dir.join("BOOTSTRAP.md").to_string_lossy()),
            );
        }
    }
}

/// Report credential-looking variable NAMES found in the source's `.env` so a
/// user can move them into the Secret Vault deliberately. Values are never read
/// into the scan result.
pub(super) fn collect_env_credential_names(root: &Path, framework: Framework, c: &mut Collector) {
    let path = root.join(".env");
    let Some(raw) = read_bounded(&path, MAX_FRAMEWORK_FILE_BYTES) else {
        return;
    };
    let names = credential_names(&raw);
    if names.is_empty() {
        return;
    }
    let folder = path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let message = if names.len() == 1 {
        Message::new(messages::IMPORT_ENV_ONE_CREDENTIAL_WARNING_MESSAGE)
    } else {
        counted(
            Message::new(messages::IMPORT_ENV_CREDENTIALS_WARNING_MESSAGE),
            names.len(),
        )
    };
    c.warn(
        message
            .text("source", framework.label())
            .text("names", names.join(", "))
            .text(
                "migrateCommand",
                format!("`ryu migrate {folder} --secrets`"),
            )
            .text("importCommand", "`ryu secrets import`"),
    );
}

/// Names of credential-looking `KEY=value` lines in a dotenv file.
pub fn credential_names(dotenv: &str) -> Vec<String> {
    let mut names: Vec<String> = dotenv
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let line = line.strip_prefix("export ").unwrap_or(line);
            if line.starts_with('#') {
                return None;
            }
            let (key, value) = line.split_once('=')?;
            let key = key.trim();
            let value = value.trim().trim_matches(['"', '\'']);
            (is_credential_name(key) && !value.is_empty()).then(|| key.to_string())
        })
        .collect();
    names.sort();
    names.dedup();
    names
}

/// `UPPER_SNAKE` names ending in a credential suffix.
pub fn is_credential_name(key: &str) -> bool {
    !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && ["_KEY", "_TOKEN", "_SECRET", "_PASSWORD"]
            .iter()
            .any(|suffix| key.ends_with(suffix))
}

// ---------------------------------------------------------------------------
// Code-defined agents (Mastra / LangChain)
// ---------------------------------------------------------------------------
