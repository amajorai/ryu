//! `skills.author` inputs: the slug sanitizer, the `SKILL.md` renderer, and
//! required-argument reads.

use super::*;

/// Sanitize a raw slug (or a name to derive one from) into a single safe path
/// segment. Keeps alphanumerics, `-`, `_`, `.`; collapses everything else to a
/// dash; trims leading/trailing dashes and dots. Returns `None` when nothing safe
/// remains (empty, `.`, `..`), so a call can never escape the skills directory via
/// `..`, an absolute path, or a drive/UNC prefix (`:` and separators are neutered).
///
/// Mirrors `skills_catalog::from_source::sanitize_name` but fails closed instead of
/// falling back to a default id, so an unusable slug is a caller error.
pub(super) fn sanitize_slug(raw: &str) -> Option<String> {
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
    Some(trimmed)
}

/// Render a structured `SKILL.md`: quoted-safe YAML front-matter (name, optional
/// description, optional allowed-tools) followed by the four `##` body sections.
///
/// The front-matter is serialized with `noyalib::compat::serde_yaml` (the same crate `parse_skill_md`
/// reads back), so a `name`/`description` containing quotes, colons, newlines, or a
/// `---` sequence is escaped correctly instead of breaking the block.
pub(super) fn render_skill_md(
    name: &str,
    description: Option<&str>,
    allowed_tools: &[String],
    purpose: &str,
    procedure: &str,
    failure_modes: &str,
    verification: &str,
) -> Result<String> {
    let mut front = serde_json::Map::new();
    front.insert("name".to_owned(), json!(name));
    if let Some(d) = description {
        front.insert("description".to_owned(), json!(d));
    }
    if !allowed_tools.is_empty() {
        front.insert("allowed-tools".to_owned(), json!(allowed_tools));
    }
    let mut yaml = noyalib::compat::serde_yaml::to_string(&Value::Object(front))
        .map_err(|e| anyhow::anyhow!("failed to render skill front-matter: {e}"))?;
    // noyalib's serde_yaml shim omits the trailing newline the closing `---` fence needs.
    if !yaml.ends_with('\n') {
        yaml.push('\n');
    }

    Ok(format!(
        "---\n{yaml}---\n\n## Purpose\n\n{purpose}\n\n## Procedure\n\n{procedure}\n\n## Failure modes\n\n{failure_modes}\n\n## Verification\n\n{verification}\n",
        yaml = yaml,
        purpose = purpose.trim(),
        procedure = procedure.trim(),
        failure_modes = failure_modes.trim(),
        verification = verification.trim(),
    ))
}

/// Read a required non-empty string argument, or `Err` (a malformed call — same
/// contract as `do_load`'s missing-`id` behavior).
pub(super) fn required_str<'a>(arguments: &'a Value, key: &str) -> Result<&'a str> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("missing required string argument '{key}'"))
}
