// test-exempt: part of server/agent_sync.rs (spliced in with include!), moved verbatim; tests in agent_sync/tests/ and agent_sync_reconcile_test.rs.

fn hash_selected_item_with_budget(
    root: &Path,
    selection: &ImportSelection,
    budget: &mut HashBudget,
) -> Result<Option<String>> {
    // Chat-export items dedupe per conversation / per memory entry inside the
    // importer, and their source files can be far larger than the hash budget,
    // so they are tracked by a fingerprint of the export's file metadata.
    if is_chat_export_selection(selection) {
        return chat_export_fingerprint(root).map(Some);
    }
    let path = crate::import::resolve_item_path(root, &selection.id)?;
    Ok(Some(hash_path_with_budget(&path, budget)?))
}

/// A ChatGPT / Claude export item: a conversation group, or the saved context,
/// which is a `memory` item whose id ends with `#saved-context`.
///
/// The suffix alone does not make an item an export item. The id of an item of
/// another kind can end with the same text (an MCP server's id ends with its
/// name, and the name is a raw key of the scanned file), and such an item must
/// go through `resolve_item_path` like every other item of its kind, not
/// through the export fingerprint, which succeeds on any readable folder.
fn is_chat_export_selection(selection: &ImportSelection) -> bool {
    selection.kind == crate::import::kind::CONVERSATIONS
        || (selection.kind == crate::import::kind::MEMORY
            && selection
                .id
                .ends_with(&format!("#{}", crate::import::chat_exports::SAVED_CONTEXT)))
}

/// Names, sizes, and modification times of the files of a ChatGPT / Claude
/// export that the importer reads: its conversation, project and memory files
/// at the top level plus the records in `projects/` and `memories/`. A newer
/// export unzipped over the folder changes it, without reading any file.
fn chat_export_fingerprint(root: &Path) -> Result<String> {
    let mut hasher = Sha256::new();
    for folder in ["", "projects", "memories"] {
        let dir = root.join(folder);
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if !folder.is_empty() && error.kind() == std::io::ErrorKind::NotFound => {
                continue;
            }
            Err(error) => {
                return Err(error).with_context(|| format!("reading directory {}", dir.display()))
            }
        };
        // Only the files the importer reads count. An export of a heavy account
        // also holds a file for every image it handled, thousands of them;
        // counting those would put it past the entry limit, and an export that
        // cannot be fingerprinted is never imported and is parsed again on every
        // tick.
        let mut entries = entries
            .filter(|entry| {
                entry
                    .as_ref()
                    .map_or(true, |entry| reads_export_file(folder, &entry.file_name()))
            })
            .take(MAX_HASH_ENTRIES.saturating_add(1))
            .collect::<std::io::Result<Vec<_>>>()?;
        if entries.len() > MAX_HASH_ENTRIES {
            bail!("hash entry limit exceeded");
        }
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let metadata = fs::symlink_metadata(entry.path())?;
            if !metadata.is_file() {
                continue;
            }
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |since| since.as_nanos());
            hasher.update(folder.as_bytes());
            hasher.update([0]);
            hasher.update(entry.file_name().as_encoded_bytes());
            hasher.update([0]);
            hasher.update(metadata.len().to_le_bytes());
            hasher.update(modified.to_le_bytes());
        }
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Whether the importer reads this file of an export folder: the conversation,
/// project, memory and marker files at the top level, and the `.json` records in
/// `projects/` and `memories/`.
fn reads_export_file(folder: &str, name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    if folder.is_empty() {
        return crate::import::chat_exports::is_import_file(name);
    }
    Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
        == Some("json")
}

/// Why a scanned skill must not be imported because it is Ryu's own skill:
/// a directory inside Ryu's skills install dir (installing it would delete
/// the very directory it copies from), or a `SKILL.md` that `project_skills`
/// wrote for this profile and that nothing has changed since. Re-importing a
/// projection would replace the real skill (and its bundled resources) with
/// the one-file projection and re-activate a skill the user disabled.
async fn own_skill_skip_reason(
    store: &AgentSyncStore,
    profile_id: &str,
    root: &Path,
    selection: &ImportSelection,
) -> Option<&'static str> {
    if selection.kind != crate::import::kind::SKILL {
        return None;
    }
    let dir = crate::import::resolve_item_path(root, &selection.id).ok()?;
    if is_inside_skills_install_dir(&dir) {
        return Some("already a Ryu skill install");
    }
    let rel = selection
        .id
        .strip_prefix(crate::import::kind::SKILL)?
        .strip_prefix('/')?;
    let source_id = format!("{rel}/SKILL.md");
    let previous = store
        .item(profile_id, "skill", &source_id)
        .await
        .ok()
        .flatten()?;
    // Only a "projected" row's hash is Ryu's own output. An "external" row's
    // adopted hash is the agent's or user's edit that "keep external" chose
    // over Ryu's projection, so importing it must still go through.
    if previous.state != "projected" {
        return None;
    }
    let projected_hash = previous.generated_hash?;
    let current_hash = sha256_bytes(&fs::read(dir.join("SKILL.md")).ok()?);
    (current_hash == projected_hash).then_some("generated output")
}

/// True when `dir` is (inside) Ryu's skills install directory.
fn is_inside_skills_install_dir(dir: &Path) -> bool {
    let Ok(skills_dir) = fs::canonicalize(ryu_skills::SkillRegistry::skills_dir()) else {
        return false;
    };
    fs::canonicalize(dir).is_ok_and(|dir| dir.starts_with(&skills_dir))
}

fn selection_key(selection: &ImportSelection) -> String {
    format!("{}:{}", selection.kind, selection.id)
}

fn duplicate_selection_key(selections: &[ImportSelection]) -> Option<String> {
    let mut seen = HashSet::with_capacity(selections.len());
    selections
        .iter()
        .map(selection_key)
        .find(|key| !seen.insert(key.clone()))
}

fn hash_path(path: &Path) -> Result<String> {
    let mut budget = HashBudget::default();
    hash_path_with_budget(path, &mut budget)
}

#[derive(Default)]
struct HashBudget {
    entries: usize,
    bytes: u64,
}

impl HashBudget {
    fn visit(&mut self, metadata: &fs::Metadata) -> Result<()> {
        if self.entries >= MAX_HASH_ENTRIES {
            bail!("hash entry limit exceeded");
        }
        if metadata.is_file() {
            if metadata.len() > MAX_HASH_BYTES {
                bail!("file is too large to hash safely");
            }
            self.bytes = self
                .bytes
                .checked_add(metadata.len())
                .filter(|bytes| *bytes <= MAX_HASH_TOTAL_BYTES)
                .ok_or_else(|| anyhow::anyhow!("total hash byte limit exceeded"))?;
        }
        self.entries += 1;
        Ok(())
    }
}

fn hash_path_with_budget(path: &Path, budget: &mut HashBudget) -> Result<String> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("reading metadata for {}", path.display()))?;
    let mut hasher = Sha256::new();
    hash_path_inner(path, &metadata, &mut hasher, budget)?;
    Ok(hex::encode(hasher.finalize()))
}

fn hash_path_inner(
    path: &Path,
    metadata: &fs::Metadata,
    hasher: &mut Sha256,
    budget: &mut HashBudget,
) -> Result<()> {
    if metadata.file_type().is_symlink() {
        bail!("refusing to hash symlink {}", path.display());
    }
    budget.visit(metadata)?;
    hasher.update(
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(""),
    );
    hasher.update([0]);
    if metadata.is_file() {
        if metadata.len() > MAX_HASH_BYTES {
            bail!("file is too large to hash safely");
        }
        hasher.update(fs::read(path).with_context(|| format!("reading {}", path.display()))?);
        return Ok(());
    }
    if !metadata.is_dir() {
        bail!("unsupported item type {}", path.display());
    }
    let mut children = fs::read_dir(path)
        .with_context(|| format!("reading directory {}", path.display()))?
        .take(MAX_HASH_ENTRIES.saturating_add(1))
        .collect::<std::io::Result<Vec<_>>>()?;
    if children.len() > MAX_HASH_ENTRIES {
        bail!("hash entry limit exceeded");
    }
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        let child_path = child.path();
        let child_metadata = fs::symlink_metadata(&child_path)?;
        hash_path_inner(&child_path, &child_metadata, hasher, budget)?;
    }
    Ok(())
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn bundle_projection_hash(bundle: &Bundle) -> Result<String> {
    let projection = json!({
        "format": bundle.format,
        "version": bundle.version,
        "generatedBy": bundle.generated_by,
        "agents": &bundle.agents,
        "skills": &bundle.skills,
        "conversations": &bundle.conversations,
    });
    Ok(sha256_bytes(&serde_json::to_vec(&projection)?))
}

fn bundle_projection_hash_from_bytes(bytes: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let projection = json!({
        "format": value.get("format")?,
        "version": value.get("version")?,
        "generatedBy": value.get("generatedBy")?,
        "agents": value.get("agents")?,
        "skills": value.get("skills")?,
        "conversations": value.get("conversations")?,
    });
    Some(sha256_bytes(&serde_json::to_vec(&projection).ok()?))
}

/// Remove bundle temporaries a crashed export left in `dir` (older than an
/// hour, so a write in progress is never touched). Returns how many went.
fn sweep_orphaned_bundle_temporaries(dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let prefix = format!(".{BUNDLE_FILE_NAME}.");
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with(&prefix) && name.ends_with(".tmp")) {
            continue;
        }
        let stale = entry
            .metadata()
            .ok()
            .filter(fs::Metadata::is_file)
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > std::time::Duration::from_secs(3600));
        if stale && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("bundle has no parent directory")?;
    fs::create_dir_all(parent)?;
    sweep_orphaned_bundle_temporaries(parent);
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        BUNDLE_FILE_NAME,
        uuid::Uuid::new_v4()
    ));
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .with_context(|| format!("writing {}", temporary.display()))?;
        std::io::Write::write_all(&mut file, bytes)
            .and_then(|()| file.sync_all())
            .with_context(|| format!("writing {}", temporary.display()))?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error).with_context(|| format!("atomically replacing {}", path.display()));
    }
    Ok(())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn error_response(message: &str) -> Response {
    error_response_with(StatusCode::INTERNAL_SERVER_ERROR, message)
}

fn error_response_with(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}
