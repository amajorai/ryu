//! The project folder an imported Claude project writes its docs into.

use super::*;

/// Marker recording which export project a folder was created for, so a
/// re-import reuses it and never writes into an unrelated folder. It also
/// records a hash of each file the import wrote, so a re-import can tell a
/// file the user has edited from one it may refresh.
pub(super) const MARKER: &str = ".ryu-import.json";

/// A project folder an import created or reused.
#[derive(Debug, Clone)]
pub struct ProjectFolder {
    pub path: PathBuf,
    /// Files (relative to `path`) the user edited after an earlier import,
    /// left as they are instead of being replaced with the export's version.
    pub kept: Vec<String>,
}

pub(super) fn safe_file_name(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim_matches(['.', ' ', '-']).to_string();
    if cleaned.is_empty() {
        "Imported project".to_string()
    } else {
        cleaned.chars().take(80).collect()
    }
}

/// Create (or reuse) `<base>/<project name>` for an imported project, writing
/// its instructions to `AGENTS.md` (Ryu applies it to every chat in the
/// folder) and its knowledge docs as files. A re-import refreshes those files
/// only where the user has not edited them since the last import.
pub fn ensure_project_folder(
    base: &Path,
    source: ExportSource,
    project: &ExportProject,
) -> Result<ProjectFolder> {
    fs::create_dir_all(base)?;
    let owner = |files: &serde_json::Map<String, Value>| serde_json::json!({ "source": source.id(), "projectId": project.id, "files": files });
    let name = safe_file_name(&project.name);
    let mut folder = base.join(&name);
    let mut attempt = 1;
    let mut previous = serde_json::Map::new();
    loop {
        let marker_path = folder.join(MARKER);
        if !folder.exists() {
            fs::create_dir_all(&folder)?;
            break;
        }
        let existing = fs::read_to_string(&marker_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
        let owned = existing.as_ref().is_some_and(|existing| {
            existing.get("source").and_then(Value::as_str) == Some(source.id())
                && existing.get("projectId").and_then(Value::as_str) == Some(project.id.as_str())
        });
        if owned {
            if let Some(files) = existing
                .as_ref()
                .and_then(|existing| existing.get("files"))
                .and_then(Value::as_object)
            {
                previous = files.clone();
            }
            break;
        }
        attempt += 1;
        folder = base.join(format!("{name} ({} {attempt})", source.label()));
        if attempt > 50 {
            bail!(
                "could not find a free folder name for project {:?}",
                project.name
            );
        }
    }
    // Claim the folder before writing into it.
    write_new(
        &folder.join(MARKER),
        &serde_json::to_vec_pretty(&owner(&previous))?,
    )?;
    let mut written = serde_json::Map::new();
    let mut kept = Vec::new();
    let mut agents = format!(
        "# {}\n\nImported from {}.\n",
        project.name.trim(),
        source.label()
    );
    if !project.description.is_empty() {
        agents.push_str(&format!("\n{}\n", project.description));
    }
    if !project.instructions.is_empty() {
        agents.push_str(&format!(
            "\n## Project instructions\n\n{}\n",
            project.instructions
        ));
    }
    if !project.memory.is_empty() {
        agents.push_str(&format!("\n## Project memory\n\n{}\n", project.memory));
    }
    if !project.docs.is_empty() {
        agents.push_str("\n## Knowledge files\n\n");
        for (name, _) in &project.docs {
            agents.push_str(&format!("- `knowledge/{}`\n", safe_file_name(name)));
        }
    }
    let mut managed = |relative: String, bytes: &[u8]| -> Result<()> {
        let recorded = previous.get(&relative).and_then(Value::as_str);
        match write_managed(&folder, &relative, bytes, recorded)? {
            Managed::Written(hash) => {
                written.insert(relative, Value::String(hash));
            }
            Managed::Kept => {
                if let Some(hash) = recorded {
                    written.insert(relative.clone(), Value::String(hash.to_string()));
                }
                kept.push(relative);
            }
        }
        Ok(())
    };
    managed("AGENTS.md".to_string(), agents.as_bytes())?;
    if !project.docs.is_empty() {
        fs::create_dir_all(folder.join("knowledge"))?;
        for (name, content) in &project.docs {
            let mut bytes = content.as_bytes();
            if bytes.len() > MAX_DOC_BYTES {
                bytes = &bytes[..MAX_DOC_BYTES];
            }
            managed(format!("knowledge/{}", safe_file_name(name)), bytes)?;
        }
    }
    write_new(
        &folder.join(MARKER),
        &serde_json::to_vec_pretty(&owner(&written))?,
    )?;
    Ok(ProjectFolder { path: folder, kept })
}

pub(super) enum Managed {
    /// The file now holds the import's content, whose hash is recorded.
    Written(String),
    /// The user changed the file after the last import; it was left alone.
    Kept,
}

/// Write one import-managed file unless the user has changed it: a file is
/// replaced only when it is missing, already identical, or still exactly what
/// the last import wrote (`recorded` hash). An existing file with no recorded
/// hash is treated as the user's and kept.
pub(super) fn write_managed(
    folder: &Path,
    relative: &str,
    bytes: &[u8],
    recorded: Option<&str>,
) -> Result<Managed> {
    let path = folder.join(relative);
    let hash = bytes_sha256(bytes);
    match fs::read(&path) {
        Ok(current) => {
            let current = bytes_sha256(&current);
            if current == hash {
                return Ok(Managed::Written(hash));
            }
            if recorded != Some(current.as_str()) {
                return Ok(Managed::Kept);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).with_context(|| format!("reading {}", path.display()));
        }
    }
    write_new(&path, bytes)?;
    Ok(Managed::Written(hash))
}

pub(super) fn bytes_sha256(bytes: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(bytes))
}

/// Atomic write: temp file in the same folder, then rename.
pub(super) fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Default parent folder for imported projects: `~/Documents/Ryu`.
pub fn default_projects_base() -> Option<PathBuf> {
    dirs::document_dir().map(|docs| docs.join("Ryu"))
}
