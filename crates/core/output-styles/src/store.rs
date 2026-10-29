//! Authoring for **user-root** output styles: create, update, delete, and fork.
//!
//! There is exactly one write target — `<claude-dir>/output-styles/<id>.md`
//! ([`crate::user_output_styles_dir`]) — and every function here resolves against it.
//! That is not a simplification, it is the rule design §6 states: a plugin style lives
//! in a signed package (which, for a built-in, is not even on the user's machine), a
//! managed style belongs to an administrator, and a project style belongs to the repo.
//! "Editing" any of those means **forking** a copy into the user root, where the
//! higher User rank ([`crate::OutputStyleSource::rank`]) makes the copy win under the
//! same id. So this module never writes outside the user root, and there is no code
//! path that could.
//!
//! Project styles are writable in principle (design §3's table says so) but not
//! through here: a second write target would need a second "which project root?"
//! question at every call site, and nothing asks for it yet.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::{user_output_styles_dir, OutputStyleSource};

// ── Path safety ─────────────────────────────────────────────────────────────────

/// Validate a style id as a single safe path segment (no separators, no `..`), so a
/// crafted id cannot escape the user root. Fail-closed: anything questionable is
/// rejected rather than sanitized, because a *silently rewritten* id would write one
/// file and report another.
pub fn validate_id(id: &str) -> std::io::Result<()> {
    let bad = id.is_empty()
        || id == "."
        || id == ".."
        || id.contains('/')
        || id.contains('\\')
        || id.contains(':')
        || id.contains('\0');
    if bad {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("invalid output style id '{id}'"),
        ));
    }
    Ok(())
}

/// Sanitize a display name into one safe path segment. Keeps alphanumerics, `-`, `_`,
/// `.`; collapses everything else to a dash; trims leading/trailing dashes and dots.
/// Returns `None` when nothing safe remains — mirrors `ryu_skills::store::sanitize_slug`
/// so an id derived from a name means the same thing in both libraries.
pub fn sanitize_slug(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(['-', '.']).to_string();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return None;
    }
    Some(trimmed.to_lowercase())
}

/// The path a user-root style with this id occupies (whether or not it exists).
pub fn user_style_path(id: &str) -> std::io::Result<PathBuf> {
    validate_id(id)?;
    Ok(user_output_styles_dir().join(format!("{id}.md")))
}

/// Read the raw `.md` of a user-root style, or `None` when the user root has no file
/// for that id. Deliberately narrower than [`crate::OutputStyleRegistry::source_of`],
/// which answers "what is the effective source for this id, from any tier": the
/// writers below must know whether *their own* file exists, since that is what decides
/// create-vs-update and preserve-vs-fork.
pub fn read_user_style_source(id: &str) -> std::io::Result<Option<String>> {
    let path = user_style_path(id)?;
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

// ── Editable draft ──────────────────────────────────────────────────────────────

/// The subset of an output style the editor exposes as form fields.
///
/// On save these patch the *known* frontmatter keys; every other key already in the
/// file (`force-for-plugin`, anything a newer schema added, anything another tool
/// wrote) is preserved verbatim, so editing the body never silently drops a field the
/// editor does not render.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OutputStyleDraft {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Design §2's replace-vs-append switch. Persisted as the kebab-case
    /// `keep-coding-instructions` key so the file stays byte-compatible with an
    /// upstream Claude Code style.
    #[serde(default)]
    pub keep_coding_instructions: bool,
    /// The prose body (everything below the frontmatter).
    #[serde(default)]
    pub body: String,
}

/// Reconstruct a full style `.md` from a draft, patching only the editor-exposed
/// frontmatter keys onto any pre-existing frontmatter (`existing`). Unknown keys
/// survive; a cleared optional (empty description) removes that key rather than
/// writing an empty string. `existing` is `None` for a brand-new style.
pub fn build_output_style_md(
    existing: Option<&str>,
    draft: &OutputStyleDraft,
) -> Result<String, String> {
    use noyalib::compat::serde_yaml::{Mapping, Value};

    let mut map: Mapping = match existing {
        Some(src) => {
            let (front_raw, _body) = crate::split_front_matter(src)?;
            if front_raw.trim().is_empty() {
                Mapping::new()
            } else {
                noyalib::compat::serde_yaml::from_str(&front_raw).unwrap_or_default()
            }
        }
        None => Mapping::new(),
    };

    let name = draft.name.trim();
    if name.is_empty() {
        return Err("output style name is required".to_owned());
    }
    map.insert("name".to_owned(), Value::from(name));

    match draft.description.as_deref().map(str::trim) {
        Some(d) if !d.is_empty() => {
            map.insert("description".to_owned(), Value::from(d));
        }
        _ => {
            map.remove("description");
        }
    }

    // `false` is the documented default, so the key is dropped rather than written —
    // a hand-edited style should stay as small as the one in design §1.
    if draft.keep_coding_instructions {
        map.insert("keep-coding-instructions".to_owned(), Value::from(true));
    } else {
        map.remove("keep-coding-instructions");
    }

    let mut yaml = noyalib::compat::serde_yaml::to_string(&Value::Mapping(map))
        .map_err(|e| format!("failed to render frontmatter: {e}"))?;
    // noyalib's serde_yaml shim omits the trailing newline the closing `---` fence needs.
    if !yaml.ends_with('\n') {
        yaml.push('\n');
    }

    Ok(format!("---\n{yaml}---\n\n{}\n", draft.body.trim()))
}

// ── Writing ─────────────────────────────────────────────────────────────────────

/// Outcome of a create/update/fork: the on-disk id, the file path, and the exact
/// canonical bytes written (so the caller can echo them back to the editor as the
/// diff baseline without a re-read).
pub struct WriteResult {
    pub id: String,
    pub path: PathBuf,
    pub source: String,
}

/// Error from a write.
pub enum CreateError {
    /// A user-root style with this id already exists. Only [`create_style`] and
    /// [`fork_style`] can hit it — [`update_style`] overwrites by definition.
    Conflict(String),
    /// The draft is malformed (missing name, unusable slug, or the rendered file does
    /// not round-trip through the parser).
    Invalid(String),
    Io(std::io::Error),
}

/// Atomically write `source` as `<user root>/<id>.md` (tmp + rename), creating the
/// root as needed. Returns the destination path.
fn write_style_md(id: &str, source: &str) -> std::io::Result<PathBuf> {
    let dest = user_style_path(id)?;
    let root = user_output_styles_dir();
    std::fs::create_dir_all(&root)?;
    let tmp = root.join(format!("{id}.md.tmp"));
    std::fs::write(&tmp, source.as_bytes())?;
    std::fs::rename(&tmp, &dest)?;
    Ok(dest)
}

/// Fail closed: never persist a file the loader cannot read back.
fn assert_round_trips(id: &str, source: &str) -> Result<(), CreateError> {
    crate::parse_output_style_md(id, source)
        .map(|_| ())
        .map_err(|e| CreateError::Invalid(format!("output style did not round-trip: {e}")))
}

/// Create a brand-new user style from a draft. The id is derived from the name;
/// creation fails with [`CreateError::Conflict`] rather than clobbering an existing
/// file of the same slug. The caller reloads the registry so the style is live.
pub fn create_style(draft: &OutputStyleDraft) -> Result<WriteResult, CreateError> {
    let slug = sanitize_slug(&draft.name).ok_or_else(|| {
        CreateError::Invalid(format!("could not derive an id from '{}'", draft.name))
    })?;

    let path = user_style_path(&slug).map_err(CreateError::Io)?;
    if path.exists() {
        return Err(CreateError::Conflict(slug));
    }

    let source = build_output_style_md(None, draft).map_err(CreateError::Invalid)?;
    assert_round_trips(&slug, &source)?;
    let path = write_style_md(&slug, &source).map_err(CreateError::Io)?;
    Ok(WriteResult {
        id: slug,
        path,
        source,
    })
}

/// Update a style from a draft, writing to the user root.
///
/// When `id` names a user style this is an in-place edit that preserves the file's
/// unmanaged frontmatter keys. When it names a plugin / project / managed style, the
/// write still lands in the user root — i.e. **this is the fork** (design §6), and the
/// caller should tell the user so. Pass the effective source (from
/// [`crate::OutputStyleRegistry::source_of`]) as `inherit_from` in that case so the
/// forked copy keeps the original's unmanaged keys instead of silently dropping them.
pub fn update_style(
    id: &str,
    draft: &OutputStyleDraft,
    inherit_from: Option<&str>,
) -> Result<WriteResult, CreateError> {
    validate_id(id).map_err(CreateError::Io)?;
    let existing = read_user_style_source(id).map_err(CreateError::Io)?;
    let base = existing.as_deref().or(inherit_from);
    let source = build_output_style_md(base, draft).map_err(CreateError::Invalid)?;
    assert_round_trips(id, &source)?;
    let path = write_style_md(id, &source).map_err(CreateError::Io)?;
    Ok(WriteResult {
        id: id.to_owned(),
        path,
        source,
    })
}

/// Copy a style verbatim into the user root under the **same id** (design §6).
///
/// Keeping the id is what makes the fork take effect: User outranks Plugin, so the
/// copy shadows the original everywhere — the picker, the selection, the injection —
/// without the user having to re-select anything. It follows that a second fork of the
/// same id is [`CreateError::Conflict`]: the fork already exists and already wins, and
/// the honest action is to edit it.
pub fn fork_style(id: &str, source: &str) -> Result<WriteResult, CreateError> {
    validate_id(id).map_err(CreateError::Io)?;
    let path = user_style_path(id).map_err(CreateError::Io)?;
    if path.exists() {
        return Err(CreateError::Conflict(id.to_owned()));
    }
    assert_round_trips(id, source)?;
    let path = write_style_md(id, source).map_err(CreateError::Io)?;
    Ok(WriteResult {
        id: id.to_owned(),
        path,
        source: source.to_owned(),
    })
}

/// Delete a user-root style. Returns `false` when there was no such file.
///
/// Only the user root is touched, so deleting a *forked* style un-shadows the plugin
/// original rather than removing it — which is the desired "revert to the shipped
/// version" behaviour and the reason a delete never needs a separate revert action.
/// A style whose id lives in some other tier is therefore a no-op here, and reported
/// as one instead of as success.
pub fn delete_style(id: &str) -> std::io::Result<bool> {
    let path = user_style_path(id)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// Whether a write to `source`'s tier would be an in-place edit (`true`) or a fork
/// into the user root (`false`). Exposed so the HTTP layer can say which one happened
/// without re-deriving the rule.
pub fn edits_in_place(source: OutputStyleSource) -> bool {
    source.is_writable()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_and_separators() {
        assert!(validate_id("../escape").is_err());
        assert!(validate_id("a/b").is_err());
        assert!(validate_id("a\\b").is_err());
        assert!(validate_id("c:evil").is_err());
        assert!(validate_id("..").is_err());
        assert!(validate_id(".").is_err());
        assert!(validate_id("").is_err());
        assert!(validate_id("eli5").is_ok());
        assert!(validate_id("i-have-adhd").is_ok());
    }

    #[test]
    fn slug_collapses_unsafe_characters() {
        assert_eq!(sanitize_slug("I have ADHD").as_deref(), Some("i-have-adhd"));
        assert_eq!(sanitize_slug("../../etc").as_deref(), Some("etc"));
        assert_eq!(sanitize_slug("   "), None);
        assert_eq!(sanitize_slug("//"), None);
    }

    #[test]
    fn build_preserves_unknown_keys_and_clears_emptied_ones() {
        let existing =
            "---\nname: Old\nforce-for-plugin: true\ndescription: had one\nkeep-coding-instructions: true\n---\nold body";
        let draft = OutputStyleDraft {
            name: "New".to_owned(),
            description: None,
            keep_coding_instructions: false,
            body: "new body".to_owned(),
        };
        let out = build_output_style_md(Some(existing), &draft).expect("build");
        assert!(out.contains("name: New"));
        assert!(!out.contains("description:"));
        assert!(!out.contains("keep-coding-instructions"));
        // Unmanaged keys survive an edit.
        assert!(out.contains("force-for-plugin: true"));
        assert!(out.trim_end().ends_with("new body"));

        let rec = crate::parse_output_style_md("x", &out).expect("round-trip");
        assert_eq!(rec.name, "New");
        assert_eq!(rec.body, "new body");
        assert!(!rec.keep_coding_instructions);
    }

    #[test]
    fn build_writes_the_kebab_case_key() {
        let draft = OutputStyleDraft {
            name: "ELI5".to_owned(),
            description: Some("simple".to_owned()),
            keep_coding_instructions: true,
            body: "small words".to_owned(),
        };
        let out = build_output_style_md(None, &draft).expect("build");
        assert!(out.contains("keep-coding-instructions: true"));
        assert!(
            crate::parse_output_style_md("eli5", &out)
                .expect("round-trip")
                .keep_coding_instructions
        );
    }

    #[test]
    fn build_requires_a_name() {
        let draft = OutputStyleDraft {
            name: "  ".to_owned(),
            ..Default::default()
        };
        assert!(build_output_style_md(None, &draft).is_err());
    }
}

#[cfg(test)]
#[path = "store_disk_tests.rs"]
mod disk_tests;
