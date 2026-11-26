//! Entry names: which are refused, which are left out, and what each
//! accepted entry is.

use super::*;

/// What an entry of the zip is, by its path alone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum EntryKind {
    Manifest,
    Instructions {
        bot: String,
    },
    Memories {
        bot: String,
    },
    Skill {
        bot: String,
        skill: String,
    },
    File {
        bot: String,
        path: Vec<String>,
    },
    Conversation {
        bot: String,
        name: String,
    },
    /// Outside the layout: ignored.
    Unknown,
}

/// An entry name cut down for an error message: bounded, one line.
pub(super) fn display_name(raw: &str) -> String {
    let shown: String = raw
        .chars()
        .take(120)
        .map(|c| if c.is_control() { '?' } else { c })
        .collect();
    if raw.chars().count() > 120 {
        format!("{shown}...")
    } else {
        shown
    }
}

/// Split an entry name into its path segments.
///
/// `Err` is a name that refuses the whole archive: an absolute path, a `..`
/// segment, or a control character. `Ok(None)` is a name that is harmless
/// but cannot be written the same way on every platform (or is too long or
/// too deep); that entry is left out. A backslash counts as a separator, so
/// `..\..\x` is caught as traversal too.
pub(super) fn parse_entry_name(raw: &str) -> Result<Option<Vec<String>>, ArchiveError> {
    if raw.chars().any(char::is_control) {
        return Err(ArchiveError::UnsafeName(display_name(raw)));
    }
    let name = raw.replace('\\', "/");
    let bytes = name.as_bytes();
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if name.starts_with('/') || drive {
        return Err(ArchiveError::AbsolutePath(display_name(raw)));
    }
    let mut parts = Vec::new();
    let mut portable = true;
    for part in name.split('/') {
        match part {
            "" | "." => continue,
            ".." => return Err(ArchiveError::PathTraversal(display_name(raw))),
            _ => {}
        }
        portable &= is_portable_segment(part);
        parts.push(part.to_string());
    }
    if !portable
        || parts.is_empty()
        || name.len() > MAX_ENTRY_NAME_BYTES
        || parts.len() > MAX_ENTRY_DEPTH
    {
        return Ok(None);
    }
    Ok(Some(parts))
}

/// True when a path segment is a valid file name on Windows, macOS and Linux.
fn is_portable_segment(part: &str) -> bool {
    if part.ends_with(['.', ' ']) || part.starts_with(' ') {
        return false;
    }
    if part
        .chars()
        .any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return false;
    }
    let stem = part.split('.').next().unwrap_or(part).to_ascii_uppercase();
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit());
    !device
}

/// A bot key or skill name: ASCII letters, digits, `-` and `_`, 1 to 64 long.
pub(super) fn is_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && !value.starts_with(['-', '_'])
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// What the entry at `parts` is. Names are matched exactly; a bot key or a
/// skill name that is not a slug makes the entry unknown.
pub(super) fn classify(parts: &[String]) -> EntryKind {
    let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
    match parts.as_slice() {
        [MANIFEST_FILE] => EntryKind::Manifest,
        ["bots", bot, rest @ ..] if is_slug(bot) => {
            let bot = (*bot).to_string();
            match rest {
                ["instructions.md"] => EntryKind::Instructions { bot },
                ["memories.md"] => EntryKind::Memories { bot },
                ["skills", skill, "SKILL.md"] if is_slug(skill) => EntryKind::Skill {
                    bot,
                    skill: (*skill).to_string(),
                },
                ["files", path @ ..] if !path.is_empty() => EntryKind::File {
                    bot,
                    path: path.iter().map(|part| (*part).to_string()).collect(),
                },
                ["conversations", name] if is_conversation_name(name) => EntryKind::Conversation {
                    bot,
                    name: (*name).to_string(),
                },
                _ => EntryKind::Unknown,
            }
        }
        _ => EntryKind::Unknown,
    }
}

fn is_conversation_name(name: &str) -> bool {
    name.strip_suffix(".json").is_some_and(is_slug)
}

/// A file under `files/` that looks like a credential store. It is left out:
/// Ryu never copies sign-ins or keys during an import.
pub(super) fn is_secret_file(path: &[String]) -> bool {
    let Some(name) = path.last() else {
        return false;
    };
    let lower = name.to_ascii_lowercase();
    lower == ".env"
        || lower.starts_with(".env.")
        || lower.starts_with("id_rsa")
        || lower.starts_with("id_ed25519")
        || lower == "credentials.json"
        || lower == ".netrc"
        || [".pem", ".key", ".p12", ".pfx", ".keystore"]
            .iter()
            .any(|suffix| lower.ends_with(suffix))
}
