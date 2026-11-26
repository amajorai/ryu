//! The manifest: what the zip declares, cut down to bounded plain text, and
//! the summary a staging folder keeps.

use super::*;

/// A routine the source bot had. Routines are listed for review, never
/// imported: Ryu does not create schedules during an import.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Routine {
    pub name: String,
    pub schedule: String,
    pub instruction: String,
}

/// One bot of an archive, with the counts of what was really unpacked.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BotSummary {
    pub key: String,
    pub name: String,
    pub description: String,
    pub has_instructions: bool,
    /// Memory entries (facts), not files.
    pub memories: usize,
    pub skills: usize,
    pub files: usize,
    pub conversations: usize,
    pub routines: Vec<Routine>,
    /// Parts the migrator said it could not read, in its own words.
    pub not_exported: Vec<String>,
}

/// What an archive holds. Written to the staging folder as
/// [`MANIFEST_FILE`] and returned to the client for the preview.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchiveSummary {
    pub format: String,
    pub version: u64,
    /// The product the export came from, as the manifest names it.
    pub source_app: String,
    pub exported_at: String,
    pub bots: Vec<BotSummary>,
    /// Entries outside the layout, which were ignored.
    pub ignored_entries: usize,
    /// Entries in the layout that were not unpacked: a name that cannot be
    /// written on every platform, a credential file, or one past a per-bot cap.
    pub left_out_entries: usize,
}

/// One line of display text: control characters and line breaks become
/// spaces, runs of whitespace collapse, and the result is cut to `max`
/// characters.
pub(super) fn clean_line(raw: &str, max: usize) -> String {
    raw.split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

fn text(value: &Value, key: &str, max: usize) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(|raw| clean_line(raw, max))
        .unwrap_or_default()
}

fn routines(bot: &Value) -> Vec<Routine> {
    bot.get("routines")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|routine| routine.is_object())
                .take(MAX_ROUTINES_PER_BOT)
                .map(|routine| Routine {
                    name: text(routine, "name", 120),
                    schedule: text(routine, "schedule", 200),
                    instruction: text(routine, "instruction", 2000),
                })
                .filter(|routine| !routine.name.is_empty() || !routine.instruction.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn not_exported(bot: &Value) -> Vec<String> {
    bot.get("not_exported")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(|note| clean_line(note, 300))
                .filter(|note| !note.is_empty())
                .take(20)
                .collect()
        })
        .unwrap_or_default()
}

/// Read the zip's manifest. Unknown fields are ignored. The counts in the
/// result are zero: they are filled from the entries that are unpacked,
/// never from what the manifest claims.
pub(super) fn parse_manifest(bytes: &[u8]) -> Result<ArchiveSummary, ArchiveError> {
    let bad = |reason: &str| ArchiveError::BadManifest(reason.to_string());
    let manifest: Value = serde_json::from_slice(bytes).map_err(|_| bad("it is not valid JSON"))?;
    if manifest.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err(bad("its format is not ryu-bot-export"));
    }
    if manifest.get("version").and_then(Value::as_u64) != Some(VERSION) {
        return Err(bad("this version of Ryu reads version 1 only"));
    }
    let list = manifest
        .get("bots")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("it has no bots list"))?;
    if list.len() > MAX_BOTS {
        return Err(bad("it lists more bots than one import allows"));
    }
    let mut bots: Vec<BotSummary> = Vec::new();
    for bot in list {
        let Some(key) = bot
            .get("key")
            .and_then(Value::as_str)
            .filter(|k| is_slug(k))
        else {
            return Err(bad("a bot has no valid key"));
        };
        if bots.iter().any(|seen| seen.key.eq_ignore_ascii_case(key)) {
            return Err(bad("two bots share one key"));
        }
        let name = text(bot, "name", 80);
        bots.push(BotSummary {
            key: key.to_string(),
            name: if name.is_empty() {
                key.to_string()
            } else {
                name
            },
            description: text(bot, "description", 500),
            routines: routines(bot),
            not_exported: not_exported(bot),
            ..BotSummary::default()
        });
    }
    if bots.is_empty() {
        return Err(ArchiveError::NoBots);
    }
    let source = manifest.get("source").cloned().unwrap_or(Value::Null);
    Ok(ArchiveSummary {
        format: FORMAT.to_string(),
        version: VERSION,
        source_app: text(&source, "app", 40),
        exported_at: text(&source, "exported_at", 40),
        bots,
        ignored_entries: 0,
        left_out_entries: 0,
    })
}

/// The summary of a staging folder, or `None` when `root` is not one.
pub fn read_staged_summary(root: &Path) -> Option<ArchiveSummary> {
    let path = root.join(MANIFEST_FILE);
    let meta = fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_TEXT_ENTRY_BYTES {
        return None;
    }
    let summary: ArchiveSummary = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
    (summary.format == FORMAT && summary.version == VERSION).then_some(summary)
}
