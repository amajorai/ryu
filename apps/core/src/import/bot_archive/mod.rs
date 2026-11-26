//! A bot export archive (`ryu-bot-export`, version 1): one zip that a
//! migrator prompt builds inside a hosted bot product that has no export of
//! its own (today xAI's Grok Bot). The user downloads the zip and uploads it
//! to their node. This module validates it and unpacks it into a Ryu-owned
//! staging folder, in a layout the setup scan already reads, so the existing
//! scan and run steps import it.
//!
//! The zip:
//!
//! ```text
//! ryu-export.json                        manifest: format, version, source, bots
//! bots/<key>/instructions.md             the bot's job and rules
//! bots/<key>/memories.md                 one remembered fact per bullet
//! bots/<key>/skills/<skill>/SKILL.md     a reusable skill
//! bots/<key>/files/<path>                the bot's own files
//! bots/<key>/conversations/<name>.json   { title, messages: [{ role, text, at? }] }
//! ```
//!
//! The staging folder (`<data dir>/tmp/import-staging/<sha16>/`):
//!
//! ```text
//! ryu-export.json                        the checked manifest with real counts
//! bots/<key>/SOUL.md                     instructions, read as a persona
//! bots/<key>/MEMORY.md                   memories, read as Markdown memory
//! bots/<key>/skills/<skill>/SKILL.md     found by the shared skill walk
//! bots/<key>/.ryu-payload/files/...      never walked by the scan
//! bots/<key>/.ryu-payload/conversations/<name>.json
//! ```
//!
//! The archive is untrusted. A model inside another product wrote it, from
//! text that product's user and third parties supplied. So: sizes are capped
//! per entry and in total and measured while reading, never taken from the
//! zip's own headers; an absolute path, a `..` segment, a symlink or an
//! encrypted entry refuses the whole archive; entries outside the layout are
//! ignored; nothing is executed or fetched; and every string from the
//! manifest is cut to a bounded single line before it is shown.

use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

mod manifest;
mod names;
mod payload;
mod stage;

pub use manifest::*;
use names::*;
pub use payload::*;
pub use stage::*;

/// The manifest at the root of the zip and of a staging folder.
pub const MANIFEST_FILE: &str = "ryu-export.json";
/// The manifest's `format`.
pub const FORMAT: &str = "ryu-bot-export";
/// The only manifest `version` this build reads.
pub const VERSION: u64 = 1;
/// Folder inside a staged bot that holds its files and conversations. The
/// setup scan never descends into it (`is_skipped_dir`), so nothing a user
/// file contains is offered as a skill, a plugin or a memory store.
pub const PAYLOAD_DIR: &str = ".ryu-payload";
/// `tmp/<owner>` folder that holds staged archives.
pub const STAGING_OWNER: &str = "import-staging";
/// A staging folder older than this is removed by the next upload.
pub const STAGING_MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60;

/// Largest zip accepted.
pub const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
/// Most entries in the zip, of any kind.
pub const MAX_ENTRIES: usize = 5_000;
/// Largest manifest, instructions, memories or `SKILL.md` entry.
pub const MAX_TEXT_ENTRY_BYTES: u64 = 1024 * 1024;
/// Largest conversation transcript entry.
pub const MAX_CONVERSATION_ENTRY_BYTES: u64 = 8 * 1024 * 1024;
/// Largest entry under `files/`.
pub const MAX_FILE_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
/// Largest total of everything unpacked from one zip.
pub const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
/// Most bots read from one manifest.
pub const MAX_BOTS: usize = 50;
/// Most skills, files and conversations kept per bot; more are left out.
pub const MAX_SKILLS_PER_BOT: usize = 32;
pub const MAX_FILES_PER_BOT: usize = 2_000;
pub const MAX_CONVERSATIONS_PER_BOT: usize = 500;
/// Most routines listed per bot.
pub const MAX_ROUTINES_PER_BOT: usize = 64;
/// Longest entry path, in bytes, and its most path segments.
pub const MAX_ENTRY_NAME_BYTES: usize = 240;
pub const MAX_ENTRY_DEPTH: usize = 12;

/// Why an archive was refused. Each case refuses the whole archive: nothing
/// is staged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArchiveError {
    /// The zip itself is larger than [`MAX_ARCHIVE_BYTES`].
    ArchiveTooLarge,
    /// Not a zip, or a zip this build cannot read.
    NotAZip(String),
    /// More than [`MAX_ENTRIES`] entries.
    TooManyEntries(usize),
    /// An entry with an absolute path (`/x`, `\x`, `C:\x`).
    AbsolutePath(String),
    /// An entry with a `..` path segment.
    PathTraversal(String),
    /// An entry whose name holds a control character.
    UnsafeName(String),
    /// An entry that is a symbolic link.
    Symlink(String),
    /// An encrypted entry.
    Encrypted(String),
    /// An entry in the layout that unpacks to more than its cap.
    EntryTooLarge { name: String, limit: u64 },
    /// The entries together unpack to more than [`MAX_TOTAL_BYTES`].
    TotalTooLarge,
    /// No `ryu-export.json` at the root.
    MissingManifest,
    /// The manifest is not JSON, not this format, or not a version this
    /// build reads.
    BadManifest(String),
    /// The manifest lists no bot.
    NoBots,
    /// The staging folder could not be written.
    Io(String),
    /// The upload stopped before the whole zip arrived.
    Upload(String),
}

const MIB: u64 = 1024 * 1024;

impl fmt::Display for ArchiveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ArchiveTooLarge => write!(
                f,
                "the zip is larger than the {} MB import limit",
                MAX_ARCHIVE_BYTES / MIB
            ),
            Self::NotAZip(reason) => write!(f, "the file is not a zip Ryu can read: {reason}"),
            Self::TooManyEntries(count) => write!(
                f,
                "the zip holds {count} entries, more than the {MAX_ENTRIES} import limit"
            ),
            Self::AbsolutePath(name) => {
                write!(f, "the zip holds an entry with an absolute path: {name}")
            }
            Self::PathTraversal(name) => write!(
                f,
                "the zip holds an entry that points outside the archive: {name}"
            ),
            Self::UnsafeName(name) => {
                write!(f, "the zip holds an entry with an unsafe name: {name}")
            }
            Self::Symlink(name) => write!(f, "the zip holds a symbolic link: {name}"),
            Self::Encrypted(name) => write!(f, "the zip holds an encrypted entry: {name}"),
            Self::EntryTooLarge { name, limit } => write!(
                f,
                "{name} is larger than the {} MB limit for that kind of entry",
                limit / MIB
            ),
            Self::TotalTooLarge => write!(
                f,
                "the zip unpacks to more than the {} MB import limit",
                MAX_TOTAL_BYTES / MIB
            ),
            Self::MissingManifest => write!(
                f,
                "the zip has no {MANIFEST_FILE} at its top level, so it is not a Ryu bot export"
            ),
            Self::BadManifest(reason) => write!(f, "{MANIFEST_FILE} cannot be read: {reason}"),
            Self::NoBots => write!(f, "{MANIFEST_FILE} lists no bot"),
            Self::Io(reason) => write!(f, "could not unpack the zip: {reason}"),
            Self::Upload(reason) => write!(f, "the upload did not finish: {reason}"),
        }
    }
}

impl std::error::Error for ArchiveError {}

/// True when `root` is a staging folder this module wrote.
pub fn is_staged_root(root: &Path) -> bool {
    read_staged_summary(root).is_some()
}

#[cfg(test)]
mod rejection_tests;
#[cfg(test)]
mod tests;
