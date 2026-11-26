//! Check a zip and unpack it into a staging folder.

use std::collections::BTreeSet;
use std::io::{self, Read, Seek, Write};
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};

use super::*;

/// Size and count caps for one archive. `Default` is what the product
/// enforces; tests pass smaller ones.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub archive_bytes: u64,
    pub entries: usize,
    pub text_entry_bytes: u64,
    pub conversation_entry_bytes: u64,
    pub file_entry_bytes: u64,
    pub total_bytes: u64,
    pub skills_per_bot: usize,
    pub files_per_bot: usize,
    pub conversations_per_bot: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            archive_bytes: MAX_ARCHIVE_BYTES,
            entries: MAX_ENTRIES,
            text_entry_bytes: MAX_TEXT_ENTRY_BYTES,
            conversation_entry_bytes: MAX_CONVERSATION_ENTRY_BYTES,
            file_entry_bytes: MAX_FILE_ENTRY_BYTES,
            total_bytes: MAX_TOTAL_BYTES,
            skills_per_bot: MAX_SKILLS_PER_BOT,
            files_per_bot: MAX_FILES_PER_BOT,
            conversations_per_bot: MAX_CONVERSATIONS_PER_BOT,
        }
    }
}

/// An archive that passed every check and was unpacked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedArchive {
    /// The staging folder, ready for the setup scan.
    pub root: PathBuf,
    pub summary: ArchiveSummary,
}

/// `<data dir>/tmp/import-staging`, the folder that holds staged archives.
pub fn staging_base() -> PathBuf {
    crate::paths::tmp_dir_for(STAGING_OWNER)
}

/// Check the zip at `zip_path` and unpack it into
/// `<staging_base>/<first 16 hex digits of its SHA-256>/`. The same zip
/// staged twice lands in the same folder, which is replaced.
pub fn stage_archive(zip_path: &Path, staging_base: &Path) -> Result<StagedArchive, ArchiveError> {
    stage_archive_with(zip_path, staging_base, &Limits::default())
}

/// [`stage_archive`] with explicit caps.
pub fn stage_archive_with(
    zip_path: &Path,
    staging_base: &Path,
    limits: &Limits,
) -> Result<StagedArchive, ArchiveError> {
    let size = fs::metadata(zip_path).map_err(io_error)?.len();
    if size > limits.archive_bytes {
        return Err(ArchiveError::ArchiveTooLarge);
    }
    let digest = file_digest(zip_path).map_err(io_error)?;
    let file = fs::File::open(zip_path).map_err(io_error)?;
    let mut zip = zip::ZipArchive::new(file).map_err(not_a_zip)?;
    let plan = plan_entries(&mut zip, limits)?;
    let manifest = read_entry(
        &mut zip,
        plan.manifest,
        limits.text_entry_bytes,
        MANIFEST_FILE,
    )?;
    let mut summary = parse_manifest(&manifest)?;
    summary.ignored_entries = plan.ignored;
    summary.left_out_entries = plan.left_out;

    fs::create_dir_all(staging_base).map_err(io_error)?;
    let partial = staging_base.join(format!("{digest}.partial-{}", std::process::id()));
    let _ = fs::remove_dir_all(&partial);
    let root = staging_base.join(&digest);
    let staged = unpack(&mut zip, &plan, &mut summary, &partial, limits)
        .and_then(|()| write_summary(&partial, &summary))
        .and_then(|()| {
            let _ = fs::remove_dir_all(&root);
            fs::rename(&partial, &root).map_err(io_error)
        });
    if let Err(error) = staged {
        let _ = fs::remove_dir_all(&partial);
        return Err(error);
    }
    Ok(StagedArchive { root, summary })
}

/// Remove the staging folder `root`. Only a direct child of `staging_base`
/// that holds a staged manifest is removed; anything else is left alone and
/// `false` is returned.
pub fn discard_staged(staging_base: &Path, root: &Path) -> bool {
    let (Ok(base), Ok(root)) = (staging_base.canonicalize(), root.canonicalize()) else {
        return false;
    };
    if root.parent() != Some(base.as_path()) || !is_staged_root(&root) {
        return false;
    }
    fs::remove_dir_all(&root).is_ok()
}

/// Remove what has sat in `staging_base` untouched for `max_age`: staging
/// folders, and the upload and unpack leftovers of a run that was
/// interrupted. Returns how many entries were removed.
pub fn sweep_stale(staging_base: &Path, max_age: Duration) -> usize {
    let Ok(entries) = fs::read_dir(staging_base) else {
        return 0;
    };
    let now = SystemTime::now();
    let mut removed = 0;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let age = meta
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .unwrap_or_default();
        if age < max_age {
            continue;
        }
        let gone = if meta.is_dir() {
            fs::remove_dir_all(entry.path())
        } else {
            fs::remove_file(entry.path())
        };
        if gone.is_ok() {
            removed += 1;
        }
    }
    removed
}

fn io_error(error: io::Error) -> ArchiveError {
    ArchiveError::Io(clean_line(&error.to_string(), 200))
}

fn not_a_zip(error: zip::result::ZipError) -> ArchiveError {
    ArchiveError::NotAZip(clean_line(&error.to_string(), 200))
}

fn file_digest(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    io::copy(&mut file, &mut hasher)?;
    Ok(hex::encode(&hasher.finalize()[..8]))
}

/// An entry of the layout that will be unpacked.
struct Planned {
    index: usize,
    kind: EntryKind,
    /// The entry's path, for messages.
    name: String,
}

struct Plan {
    manifest: usize,
    entries: Vec<Planned>,
    ignored: usize,
    left_out: usize,
}

/// Read every entry header, without unpacking anything. A name or entry type
/// that is unsafe refuses the archive here, whatever the entry is.
fn plan_entries<R: Read + Seek>(
    zip: &mut zip::ZipArchive<R>,
    limits: &Limits,
) -> Result<Plan, ArchiveError> {
    if zip.len() > limits.entries {
        return Err(ArchiveError::TooManyEntries(zip.len()));
    }
    let mut plan = Plan {
        manifest: usize::MAX,
        entries: Vec::new(),
        ignored: 0,
        left_out: 0,
    };
    let mut seen = BTreeSet::new();
    for index in 0..zip.len() {
        let entry = zip.by_index_raw(index).map_err(not_a_zip)?;
        let (name, decoded) = match entry.name() {
            Ok(name) => (name.into_owned(), true),
            Err(_) => (
                String::from_utf8_lossy(entry.name_raw()).into_owned(),
                false,
            ),
        };
        let parts = parse_entry_name(&name)?;
        if entry.encrypted() {
            return Err(ArchiveError::Encrypted(display_name(&name)));
        }
        if entry.is_symlink() {
            return Err(ArchiveError::Symlink(display_name(&name)));
        }
        if entry.is_dir() {
            continue;
        }
        let Some(parts) = parts.filter(|_| decoded) else {
            plan.left_out += 1;
            continue;
        };
        match classify(&parts) {
            EntryKind::Unknown => plan.ignored += 1,
            // Two entries that would land on one file (the same name, or
            // names that differ only in case): the first one wins.
            _ if !seen.insert(parts.join("/").to_ascii_lowercase()) => plan.left_out += 1,
            EntryKind::Manifest => plan.manifest = index,
            kind => plan.entries.push(Planned {
                index,
                kind,
                name: display_name(&name),
            }),
        }
    }
    if plan.manifest == usize::MAX {
        return Err(ArchiveError::MissingManifest);
    }
    Ok(plan)
}

/// Unpack entry `index` into memory. More than `limit` bytes refuses the
/// archive; the size is measured while reading.
fn read_entry<R: Read + Seek>(
    zip: &mut zip::ZipArchive<R>,
    index: usize,
    limit: u64,
    name: &str,
) -> Result<Vec<u8>, ArchiveError> {
    let entry = zip.by_index(index).map_err(not_a_zip)?;
    let mut bytes = Vec::new();
    entry
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| ArchiveError::NotAZip(clean_line(&error.to_string(), 200)))?;
    if bytes.len() as u64 > limit {
        return Err(ArchiveError::EntryTooLarge {
            name: name.to_string(),
            limit,
        });
    }
    Ok(bytes)
}

/// Unpack entry `index` straight to `target`, in pieces, so a large file is
/// never held in memory. Returns the bytes written.
fn copy_entry<R: Read + Seek>(
    zip: &mut zip::ZipArchive<R>,
    index: usize,
    limit: u64,
    name: &str,
    target: &Path,
) -> Result<u64, ArchiveError> {
    let mut entry = zip.by_index(index).map_err(not_a_zip)?.take(limit + 1);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let mut out = fs::File::create(target).map_err(io_error)?;
    let mut buffer = vec![0u8; 64 * 1024];
    let mut written = 0u64;
    loop {
        let read = entry
            .read(&mut buffer)
            .map_err(|error| ArchiveError::NotAZip(clean_line(&error.to_string(), 200)))?;
        if read == 0 {
            break;
        }
        written += read as u64;
        if written > limit {
            return Err(ArchiveError::EntryTooLarge {
                name: name.to_string(),
                limit,
            });
        }
        out.write_all(&buffer[..read]).map_err(io_error)?;
    }
    Ok(written)
}

fn write_file(target: &Path, bytes: &[u8]) -> Result<(), ArchiveError> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    fs::write(target, bytes).map_err(io_error)
}

/// False when `target` cannot be written without replacing something: it
/// exists already, or a folder on the way to it is a file (`files/a` and
/// `files/a/b` in one zip).
fn is_free(bot_dir: &Path, target: &Path) -> bool {
    if target.exists() {
        return false;
    }
    target
        .ancestors()
        .skip(1)
        .take_while(|dir| dir.starts_with(bot_dir))
        .all(|dir| !dir.exists() || dir.is_dir())
}

fn bot_of(kind: &EntryKind) -> &str {
    match kind {
        EntryKind::Instructions { bot }
        | EntryKind::Memories { bot }
        | EntryKind::Skill { bot, .. }
        | EntryKind::File { bot, .. }
        | EntryKind::Conversation { bot, .. } => bot,
        EntryKind::Manifest | EntryKind::Unknown => "",
    }
}

/// How many memory entries the importer will read from a `memories.md`.
fn memory_entry_count(text: &str) -> usize {
    let (_, body) = crate::import::split_front_matter(text);
    crate::import::frameworks::split_memory_text(&body)
        .len()
        .min(crate::import::frameworks::MAX_MEMORY_ENTRIES_PER_FILE)
}

fn unpack<R: Read + Seek>(
    zip: &mut zip::ZipArchive<R>,
    plan: &Plan,
    summary: &mut ArchiveSummary,
    dest: &Path,
    limits: &Limits,
) -> Result<(), ArchiveError> {
    let mut total = 0u64;
    let mut spend = |bytes: u64| -> Result<(), ArchiveError> {
        total += bytes;
        if total > limits.total_bytes {
            return Err(ArchiveError::TotalTooLarge);
        }
        Ok(())
    };
    for planned in &plan.entries {
        // An entry for a bot the manifest does not list is outside the layout.
        let Some(slot) = summary
            .bots
            .iter()
            .position(|bot| bot.key == bot_of(&planned.kind))
        else {
            summary.ignored_entries += 1;
            continue;
        };
        let bot_dir = dest.join("bots").join(&summary.bots[slot].key);
        let text_limit = limits.text_entry_bytes;
        let mut left_out = false;
        match &planned.kind {
            EntryKind::Instructions { .. } => {
                let bytes = read_entry(zip, planned.index, text_limit, &planned.name)?;
                spend(bytes.len() as u64)?;
                let text = String::from_utf8_lossy(&bytes);
                if text.trim().is_empty() {
                    left_out = true;
                } else {
                    write_file(&bot_dir.join("SOUL.md"), text.as_bytes())?;
                    summary.bots[slot].has_instructions = true;
                }
            }
            EntryKind::Memories { .. } => {
                let bytes = read_entry(zip, planned.index, text_limit, &planned.name)?;
                spend(bytes.len() as u64)?;
                let text = String::from_utf8_lossy(&bytes);
                let count = memory_entry_count(&text);
                if count == 0 {
                    left_out = true;
                } else {
                    write_file(&bot_dir.join("MEMORY.md"), text.as_bytes())?;
                    summary.bots[slot].memories = count;
                }
            }
            EntryKind::Skill { skill, .. } => {
                if summary.bots[slot].skills >= limits.skills_per_bot {
                    left_out = true;
                } else {
                    let bytes = read_entry(zip, planned.index, text_limit, &planned.name)?;
                    spend(bytes.len() as u64)?;
                    let text = String::from_utf8_lossy(&bytes);
                    if text.trim().is_empty() {
                        left_out = true;
                    } else {
                        let target = bot_dir.join("skills").join(skill).join("SKILL.md");
                        write_file(&target, text.as_bytes())?;
                        summary.bots[slot].skills += 1;
                    }
                }
            }
            EntryKind::File { path, .. } => {
                let mut target = bot_dir.join(PAYLOAD_DIR).join("files");
                target.extend(path);
                if is_secret_file(path)
                    || summary.bots[slot].files >= limits.files_per_bot
                    || !is_free(&bot_dir, &target)
                {
                    left_out = true;
                } else {
                    let limit = limits.file_entry_bytes;
                    spend(copy_entry(
                        zip,
                        planned.index,
                        limit,
                        &planned.name,
                        &target,
                    )?)?;
                    summary.bots[slot].files += 1;
                }
            }
            EntryKind::Conversation { name, .. } => {
                if summary.bots[slot].conversations >= limits.conversations_per_bot {
                    left_out = true;
                } else {
                    let limit = limits.conversation_entry_bytes;
                    let bytes = read_entry(zip, planned.index, limit, &planned.name)?;
                    spend(bytes.len() as u64)?;
                    if parse_conversation(&bytes).is_none() {
                        left_out = true;
                    } else {
                        let target = bot_dir.join(PAYLOAD_DIR).join("conversations").join(name);
                        write_file(&target, &bytes)?;
                        summary.bots[slot].conversations += 1;
                    }
                }
            }
            EntryKind::Manifest | EntryKind::Unknown => {}
        }
        if left_out {
            summary.left_out_entries += 1;
        }
    }
    Ok(())
}

fn write_summary(dest: &Path, summary: &ArchiveSummary) -> Result<(), ArchiveError> {
    let bytes = serde_json::to_vec_pretty(summary)
        .map_err(|error| ArchiveError::Io(clean_line(&error.to_string(), 200)))?;
    write_file(&dest.join(MANIFEST_FILE), &bytes)
}
