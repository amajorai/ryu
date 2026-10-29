//! Open Knowledge Format (OKF) v0.1 — in-memory model, parser, and serializer.
//!
//! An OKF *bundle* is a git-shippable directory of markdown files. Every
//! non-reserved `.md` file is a *concept*: YAML frontmatter (between leading
//! `---` fences) followed by a markdown body. The only required frontmatter
//! field is `type`. Two filenames are reserved: `index.md` (bundle-level
//! listing / progressive disclosure, may carry the bundle `okf` version) and
//! `log.md` (chronological changelog with `## YYYY-MM-DD` headings).
//!
//! This crate is the OKF primitive: the format's in-memory model, parser, and
//! serializer. Its consumers live in `apps/core` — the retrieval ingest layer,
//! the knowledge catalog source, and the HTTP export handler — which reference
//! these types unconditionally.
//! Consumption is **permissive by contract**: missing optional fields, unknown
//! `type` values, broken links, and extra frontmatter keys never hard-fail a
//! bundle. A non-reserved file with a missing/empty `type` is skipped with a
//! warning rather than aborting the whole load.
//!
//! ## Public API
//! - [`Concept`] / [`Concept::parse`] / [`Concept::to_markdown`]
//! - [`Bundle`] / [`Bundle::from_dir`] / [`Bundle::from_git`] / [`Bundle::write`]
//! - [`IndexDoc`], [`LogDoc`], [`LogEntry`], [`Link`]
//! - [`OKF_VERSION`]

// Some format fields/helpers in the public surface are exercised by only a
// subset of consumers; keep the historical allow so partial adoption never
// trips a lint on an unused-but-public accessor.
#![allow(dead_code)]

mod win_process;

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::LazyLock,
};

use anyhow::{Context, Result};
use noyalib::compat::serde_yaml::Value as YamlValue;
use regex::Regex;
use serde::{Deserialize, Serialize};

/// The OKF specification version this module targets.
pub const OKF_VERSION: &str = "0.1";

/// Reserved filename: bundle listing / progressive disclosure.
pub const RESERVED_INDEX: &str = "index.md";
/// Reserved filename: chronological changelog (newest first).
pub const RESERVED_LOG: &str = "log.md";

/// Matches a markdown inline link: `[text](target)`.
static LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[([^\]]*)\]\(([^)\s]+)\)").expect("valid link regex"));

/// Matches a log section heading: `## 2026-06-29` (ISO date), capturing the date.
static LOG_HEADING_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^##\s+(\d{4}-\d{2}-\d{2})\b").expect("valid log regex"));

// ── Link ─────────────────────────────────────────────────────────────────────

/// A markdown cross-link extracted from a concept body. Relationships are
/// untyped: only the target, display text, and whether the target is relative
/// (vs. bundle-absolute, i.e. starting with `/`) are recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Link {
    /// Link target as written (e.g. `/path/to/concept.md` or `./x.md`).
    pub target: String,
    /// Display text of the link.
    pub text: String,
    /// `true` when the target is not bundle-absolute (does not start with `/`).
    pub relative: bool,
}

/// Extract every markdown inline link from a body.
fn extract_links(body: &str) -> Vec<Link> {
    LINK_RE
        .captures_iter(body)
        .map(|cap| {
            let text = cap.get(1).map_or("", |m| m.as_str()).to_owned();
            let target = cap.get(2).map_or("", |m| m.as_str()).to_owned();
            let relative = !target.starts_with('/');
            Link {
                target,
                text,
                relative,
            }
        })
        .collect()
}

// ── Frontmatter splitting ──────────────────────────────────────────────────────

/// Split leading `---` fenced YAML frontmatter from the markdown body.
///
/// Returns `(Some(yaml), body)` when the content starts with a `---` fence and a
/// closing `---` line is found; otherwise `(None, full_content)`. Never errors —
/// malformed frontmatter is surfaced later when the YAML is parsed.
fn split_frontmatter(content: &str) -> (Option<String>, String) {
    // Tolerate a leading UTF-8 BOM.
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let trimmed_start = content.trim_start_matches([' ', '\t']);
    let after_open = match trimmed_start.strip_prefix("---") {
        // The opening fence must be followed by a newline.
        Some(rest) if rest.starts_with('\n') => &rest[1..],
        Some(rest) if rest.starts_with("\r\n") => &rest[2..],
        _ => return (None, content.to_owned()),
    };

    // Find a closing `---` line.
    let mut offset = 0usize;
    for line in after_open.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\n', '\r']);
        if bare.trim() == "---" {
            let yaml = after_open[..offset].to_owned();
            let body = after_open[offset + line.len()..].to_owned();
            return (Some(yaml), body);
        }
        offset += line.len();
    }
    // No closing fence: treat the whole thing as body (permissive).
    (None, content.to_owned())
}

// ── YAML field helpers ─────────────────────────────────────────────────────────

/// Coerce a scalar YAML value to a string. Numbers and bools (e.g. an unquoted
/// `okf: 0.1`) are rendered to their textual form; non-scalars yield `None`.
fn scalar_to_string(value: YamlValue) -> Option<String> {
    match value {
        YamlValue::String(s) => Some(s),
        YamlValue::Number(n) => Some(n.to_string()),
        YamlValue::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// Pull a scalar-valued key out of a mapping, removing it. Non-scalar values are
/// dropped (treated as absent) so malformed optional fields are tolerated.
fn take_string(map: &mut noyalib::compat::serde_yaml::Mapping, key: &str) -> Option<String> {
    map.remove(key).and_then(scalar_to_string)
}

/// Pull a `tags` list out of a mapping. Accepts a sequence of strings, or a
/// single string (coerced to a one-element list). Non-string entries are skipped.
fn take_tags(map: &mut noyalib::compat::serde_yaml::Mapping) -> Vec<String> {
    match map.remove("tags") {
        Some(YamlValue::Sequence(seq)) => seq
            .into_iter()
            .filter_map(|v| match v {
                YamlValue::String(s) => Some(s),
                _ => None,
            })
            .collect(),
        Some(YamlValue::String(s)) => vec![s],
        _ => Vec::new(),
    }
}

/// Parse a YAML frontmatter block into a mapping. An empty/null block yields an
/// empty mapping. Returns `Err` only when the YAML is syntactically invalid.
fn parse_mapping(yaml: &str) -> Result<noyalib::compat::serde_yaml::Mapping, String> {
    if yaml.trim().is_empty() {
        return Ok(noyalib::compat::serde_yaml::Mapping::new());
    }
    match noyalib::compat::serde_yaml::from_str::<YamlValue>(yaml) {
        Ok(YamlValue::Mapping(m)) => Ok(m),
        Ok(YamlValue::Null) => Ok(noyalib::compat::serde_yaml::Mapping::new()),
        Ok(_) => Err("frontmatter is not a YAML mapping".to_owned()),
        Err(e) => Err(format!("invalid YAML frontmatter: {e}")),
    }
}

// ── Concept ────────────────────────────────────────────────────────────────────

/// A single OKF concept: typed frontmatter plus a markdown body.
///
/// Unknown frontmatter keys are preserved verbatim in [`extra`](Self::extra) so
/// a parse → serialize round-trip is lossless for producer-defined metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Concept {
    /// Bundle-relative path of the source file (forward-slash separated).
    pub file_path: String,
    /// Required `type` frontmatter field (e.g. "BigQuery Table", "Metric").
    #[serde(rename = "type")]
    pub type_: String,
    /// Optional human-readable title.
    pub title: Option<String>,
    /// Optional short description.
    pub description: Option<String>,
    /// Optional canonical resource URI.
    pub resource: Option<String>,
    /// Optional ISO-8601 timestamp.
    pub timestamp: Option<String>,
    /// Free-form tags.
    pub tags: Vec<String>,
    /// All frontmatter keys not otherwise modelled, preserved for round-trip.
    pub extra: BTreeMap<String, YamlValue>,
    /// Markdown body (everything after the frontmatter fence).
    pub body: String,
    /// Cross-links extracted from the body.
    pub links: Vec<Link>,
}

impl Concept {
    /// Parse a single concept file.
    ///
    /// `file_path` is the bundle-relative path recorded on the concept; it does
    /// not need to exist on disk (callers parsing in-memory strings may pass a
    /// synthetic path). Returns `Err(reason)` when the frontmatter is missing,
    /// invalid, or carries no non-empty `type` — callers turn this into a bundle
    /// warning rather than a hard failure.
    pub fn parse(file_path: impl Into<String>, content: &str) -> Result<Self, String> {
        let file_path = file_path.into();
        let (yaml, body) = split_frontmatter(content);
        let yaml = yaml.ok_or_else(|| "missing YAML frontmatter".to_owned())?;
        let mut map = parse_mapping(&yaml)?;

        let type_ = take_string(&mut map, "type")
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "missing or empty required 'type' field".to_owned())?;

        let title = take_string(&mut map, "title");
        let description = take_string(&mut map, "description");
        let resource = take_string(&mut map, "resource");
        let tags = take_tags(&mut map);
        let timestamp = take_string(&mut map, "timestamp");

        // Everything left over is preserved as `extra`.
        let mut extra = BTreeMap::new();
        for (key, v) in map {
            extra.insert(key, v);
        }

        let links = extract_links(&body);

        Ok(Self {
            file_path,
            type_,
            title,
            description,
            resource,
            timestamp,
            tags,
            extra,
            body,
            links,
        })
    }

    /// Serialize back to `---\n<yaml>\n---\n<body>` with stable key ordering:
    /// `type`, `title`, `description`, `resource`, `tags`, `timestamp`, then
    /// `extra` keys (sorted). Optional fields that are `None`/empty are omitted.
    pub fn to_markdown(&self) -> String {
        let mut map = noyalib::compat::serde_yaml::Mapping::new();
        map.insert("type".to_owned(), YamlValue::String(self.type_.clone()));
        insert_opt(&mut map, "title", self.title.as_deref());
        insert_opt(&mut map, "description", self.description.as_deref());
        insert_opt(&mut map, "resource", self.resource.as_deref());
        if !self.tags.is_empty() {
            let seq = self
                .tags
                .iter()
                .map(|t| YamlValue::String(t.clone()))
                .collect();
            map.insert("tags".to_owned(), YamlValue::Sequence(seq));
        }
        insert_opt(&mut map, "timestamp", self.timestamp.as_deref());
        for (k, v) in &self.extra {
            map.insert(k.clone(), v.clone());
        }

        format!("---\n{}---\n{}", yaml_block(map), self.body)
    }
}

/// Render a frontmatter mapping as YAML that always ends with a newline, so the
/// closing `---` fence starts its own line (noyalib's serde_yaml shim omits the final one).
fn yaml_block(map: noyalib::compat::serde_yaml::Mapping) -> String {
    let mut yaml =
        noyalib::compat::serde_yaml::to_string(&YamlValue::Mapping(map)).unwrap_or_default();
    if !yaml.ends_with('\n') {
        yaml.push('\n');
    }
    yaml
}

/// Insert an optional string key into a mapping when present and non-empty.
fn insert_opt(map: &mut noyalib::compat::serde_yaml::Mapping, key: &str, value: Option<&str>) {
    if let Some(v) = value {
        if !v.is_empty() {
            map.insert(key.to_owned(), YamlValue::String(v.to_owned()));
        }
    }
}

// ── IndexDoc ───────────────────────────────────────────────────────────────────

/// Parsed reserved `index.md`: bundle-level frontmatter plus a markdown body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IndexDoc {
    /// OKF version declared in the bundle frontmatter (`okf` or `okf_version`).
    pub okf_version: Option<String>,
    /// Optional bundle title.
    pub title: Option<String>,
    /// Optional bundle description.
    pub description: Option<String>,
    /// All other frontmatter keys, preserved.
    pub extra: BTreeMap<String, YamlValue>,
    /// Markdown body.
    pub body: String,
}

impl IndexDoc {
    /// Parse `index.md`. Frontmatter is optional; a bare body is valid.
    pub fn parse(content: &str) -> Self {
        let (yaml, body) = split_frontmatter(content);
        let mut map = yaml
            .as_deref()
            .map(|y| parse_mapping(y).unwrap_or_default())
            .unwrap_or_default();

        let okf_version =
            take_string(&mut map, "okf").or_else(|| take_string(&mut map, "okf_version"));
        let title = take_string(&mut map, "title");
        let description = take_string(&mut map, "description");

        let mut extra = BTreeMap::new();
        for (key, v) in map {
            extra.insert(key, v);
        }

        Self {
            okf_version,
            title,
            description,
            extra,
            body,
        }
    }

    /// Serialize back to `index.md` markdown.
    pub fn to_markdown(&self) -> String {
        let mut map = noyalib::compat::serde_yaml::Mapping::new();
        let version = self.okf_version.as_deref().unwrap_or(OKF_VERSION);
        map.insert("okf".to_owned(), YamlValue::String(version.to_owned()));
        insert_opt(&mut map, "title", self.title.as_deref());
        insert_opt(&mut map, "description", self.description.as_deref());
        for (k, v) in &self.extra {
            map.insert(k.clone(), v.clone());
        }
        format!("---\n{}---\n{}", yaml_block(map), self.body)
    }
}

// ── LogDoc ─────────────────────────────────────────────────────────────────────

/// One dated entry in a `log.md` changelog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry {
    /// `YYYY-MM-DD` date from the `## ` heading.
    pub date: String,
    /// Markdown content under the heading (trimmed).
    pub content: String,
}

/// Parsed reserved `log.md`: a chronological changelog, newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogDoc {
    /// Parsed dated entries (in document order).
    pub entries: Vec<LogEntry>,
    /// Full raw markdown, preserved for lossless round-trip.
    pub body: String,
}

impl LogDoc {
    /// Parse `log.md`, extracting `## YYYY-MM-DD` sections. The raw body is
    /// retained so [`to_markdown`](Self::to_markdown) round-trips exactly.
    pub fn parse(content: &str) -> Self {
        let mut entries = Vec::new();
        let headings: Vec<_> = LOG_HEADING_RE.captures_iter(content).collect();
        for (i, cap) in headings.iter().enumerate() {
            let date = cap[1].to_owned();
            let whole = cap.get(0).expect("heading match");
            let start = whole.end();
            let end = headings
                .get(i + 1)
                .and_then(|c| c.get(0))
                .map_or(content.len(), |m| m.start());
            let body_slice = content.get(start..end).unwrap_or("").trim();
            entries.push(LogEntry {
                date,
                content: body_slice.to_owned(),
            });
        }
        Self {
            entries,
            body: content.to_owned(),
        }
    }

    /// Serialize back to `log.md` markdown (the preserved raw body).
    pub fn to_markdown(&self) -> String {
        self.body.clone()
    }
}

// ── Bundle ─────────────────────────────────────────────────────────────────────

/// A loaded OKF knowledge bundle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Bundle {
    /// Filesystem root the bundle was loaded from.
    pub root: PathBuf,
    /// All successfully parsed concepts.
    pub concepts: Vec<Concept>,
    /// Parsed `index.md`, if present.
    pub index: Option<IndexDoc>,
    /// Parsed `log.md`, if present.
    pub log: Option<LogDoc>,
    /// Declared OKF version (from `index.md` frontmatter), if any.
    pub okf_version: Option<String>,
    /// Non-fatal issues encountered while loading (skipped files, etc.).
    pub warnings: Vec<String>,
}

impl Bundle {
    /// Load a bundle from a directory. Walks recursively for `.md` files,
    /// special-casing reserved `index.md` and `log.md` at the root. Files that
    /// fail to parse as concepts are skipped and recorded in
    /// [`warnings`](Self::warnings) rather than failing the load.
    pub fn from_dir(path: impl AsRef<Path>) -> Result<Self> {
        let root = path.as_ref().to_path_buf();
        if !root.is_dir() {
            anyhow::bail!("not a directory: {}", root.display());
        }

        let mut warnings = Vec::new();
        let mut concepts = Vec::new();
        let mut index = None;
        let mut log = None;

        let index_path = root.join(RESERVED_INDEX);
        if index_path.is_file() {
            match std::fs::read_to_string(&index_path) {
                Ok(content) => index = Some(IndexDoc::parse(&content)),
                Err(e) => warnings.push(format!("failed to read {RESERVED_INDEX}: {e}")),
            }
        }
        let log_path = root.join(RESERVED_LOG);
        if log_path.is_file() {
            match std::fs::read_to_string(&log_path) {
                Ok(content) => log = Some(LogDoc::parse(&content)),
                Err(e) => warnings.push(format!("failed to read {RESERVED_LOG}: {e}")),
            }
        }

        let mut md_files = Vec::new();
        collect_md_files(&root, &mut md_files, &mut warnings)?;
        md_files.sort();

        for abs in md_files {
            let rel = relative_path(&root, &abs);
            // Skip reserved files at the bundle root.
            if rel == RESERVED_INDEX || rel == RESERVED_LOG {
                continue;
            }
            let content = match std::fs::read_to_string(&abs) {
                Ok(c) => c,
                Err(e) => {
                    warnings.push(format!("failed to read {rel}: {e}"));
                    continue;
                }
            };
            match Concept::parse(rel.clone(), &content) {
                Ok(concept) => concepts.push(concept),
                Err(reason) => warnings.push(format!("skipped {rel}: {reason}")),
            }
        }

        let okf_version = index.as_ref().and_then(|i| i.okf_version.clone());

        Ok(Self {
            root,
            concepts,
            index,
            log,
            okf_version,
            warnings,
        })
    }

    /// Clone a git repository (optionally at `git_ref`) into a temporary
    /// directory and load it as a bundle via [`from_dir`](Self::from_dir).
    ///
    /// Uses the `git` CLI with a shallow clone. Credential prompts are disabled
    /// so the clone fails closed rather than hanging. The temp dir is kept alive
    /// for the duration of the load and removed afterward; the returned bundle's
    /// `root` therefore points at a path that no longer exists, so callers that
    /// need the files on disk should clone themselves and call `from_dir`.
    pub async fn from_git(url: &str, git_ref: Option<&str>) -> Result<Self> {
        let _ = (url, git_ref);
        anyhow::bail!(
            "remote knowledge git clones are disabled until Core can provide pinned, redirect-safe egress and a trusted artifact binding"
        )
    }

    /// Write the bundle to a directory: every concept at its `file_path`, plus
    /// `index.md` and `log.md` when present. Parent directories are created.
    pub fn write(&self, dir: impl AsRef<Path>) -> Result<()> {
        let dir = dir.as_ref();
        std::fs::create_dir_all(dir)
            .with_context(|| format!("failed to create {}", dir.display()))?;

        for concept in &self.concepts {
            let target = dir.join(&concept.file_path);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("failed to create {}", parent.display()))?;
            }
            std::fs::write(&target, concept.to_markdown())
                .with_context(|| format!("failed to write {}", target.display()))?;
        }

        if let Some(index) = &self.index {
            std::fs::write(dir.join(RESERVED_INDEX), index.to_markdown())
                .context("failed to write index.md")?;
        }
        if let Some(log) = &self.log {
            std::fs::write(dir.join(RESERVED_LOG), log.to_markdown())
                .context("failed to write log.md")?;
        }
        Ok(())
    }
}

/// Recursively collect `.md` files under `root`. Symlinks and unreadable
/// directories are skipped with a warning (permissive).
fn collect_md_files(dir: &Path, out: &mut Vec<PathBuf>, warnings: &mut Vec<String>) -> Result<()> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            warnings.push(format!("failed to read dir {}: {e}", dir.display()));
            return Ok(());
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            // Skip hidden dirs like `.git`.
            let is_hidden = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with('.'));
            if !is_hidden {
                collect_md_files(&path, out, warnings)?;
            }
        } else if file_type.is_file()
            && path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("md"))
        {
            out.push(path);
        }
    }
    Ok(())
}

/// Compute a forward-slash bundle-relative path of `abs` under `root`.
fn relative_path(root: &Path, abs: &Path) -> String {
    let rel = abs.strip_prefix(root).unwrap_or(abs);
    rel.components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    const BIGQUERY_CONCEPT: &str = "---\n\
type: BigQuery Table\n\
title: Orders\n\
description: Customer orders fact table\n\
resource: bigquery://project.dataset.orders\n\
tags:\n\
- sales\n\
- fact\n\
timestamp: 2026-06-29T00:00:00Z\n\
owner: data-team\n\
---\n\
# Schema\n\
\n\
See the related [Customers](/tables/customers.md) table and [local notes](./notes.md).\n";

    #[test]
    fn parses_spec_concept() {
        let c = Concept::parse("tables/orders.md", BIGQUERY_CONCEPT).expect("parse");
        assert_eq!(c.type_, "BigQuery Table");
        assert_eq!(c.title.as_deref(), Some("Orders"));
        assert_eq!(
            c.resource.as_deref(),
            Some("bigquery://project.dataset.orders")
        );
        assert_eq!(c.tags, vec!["sales", "fact"]);
        assert_eq!(c.timestamp.as_deref(), Some("2026-06-29T00:00:00Z"));
        // Unknown key preserved.
        assert!(c.extra.contains_key("owner"));
        // Links extracted: one bundle-absolute, one relative.
        assert_eq!(c.links.len(), 2);
        let abs = &c.links[0];
        assert_eq!(abs.target, "/tables/customers.md");
        assert!(!abs.relative);
        let rel = &c.links[1];
        assert_eq!(rel.target, "./notes.md");
        assert!(rel.relative);
    }

    #[test]
    fn missing_type_is_rejected() {
        let content = "---\ntitle: No Type\n---\nbody\n";
        let err = Concept::parse("x.md", content).expect_err("should reject");
        assert!(err.contains("type"));
    }

    #[test]
    fn empty_type_is_rejected() {
        let content = "---\ntype: \"   \"\n---\nbody\n";
        assert!(Concept::parse("x.md", content).is_err());
    }

    #[test]
    fn no_frontmatter_is_rejected() {
        assert!(Concept::parse("x.md", "# Just a body\n").is_err());
    }

    #[test]
    fn round_trip_preserves_logical_content() {
        let original = Concept::parse("tables/orders.md", BIGQUERY_CONCEPT).expect("parse");
        let serialized = original.to_markdown();
        let reparsed = Concept::parse("tables/orders.md", &serialized).expect("reparse");
        assert_eq!(original, reparsed);
    }

    #[test]
    fn round_trip_minimal_concept() {
        let content = "---\ntype: Metric\n---\nbody text\n";
        let c = Concept::parse("m.md", content).expect("parse");
        let out = c.to_markdown();
        let c2 = Concept::parse("m.md", &out).expect("reparse");
        assert_eq!(c, c2);
        assert!(out.starts_with("---\ntype: Metric\n"));
    }

    #[test]
    fn index_parses_okf_version() {
        let content = "---\nokf: 0.1\ntitle: My Bundle\ncustom: yes\n---\n# Contents\n";
        let idx = IndexDoc::parse(content);
        assert_eq!(idx.okf_version.as_deref(), Some("0.1"));
        assert_eq!(idx.title.as_deref(), Some("My Bundle"));
        assert!(idx.extra.contains_key("custom"));
    }

    #[test]
    fn log_parses_dated_entries() {
        let content = "# Changelog\n\n## 2026-06-29\n\nAdded orders table.\n\n## 2026-06-01\n\nInitial import.\n";
        let log = LogDoc::parse(content);
        assert_eq!(log.entries.len(), 2);
        assert_eq!(log.entries[0].date, "2026-06-29");
        assert!(log.entries[0].content.contains("Added orders"));
        assert_eq!(log.entries[1].date, "2026-06-01");
        // Round-trips exactly.
        assert_eq!(log.to_markdown(), content);
    }

    #[test]
    fn bundle_from_dir_tolerates_malformed_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();

        std::fs::write(root.join("index.md"), "---\nokf: 0.1\n---\n# Index\n").unwrap();
        std::fs::write(root.join("log.md"), "## 2026-06-29\n\nFirst entry.\n").unwrap();
        std::fs::create_dir_all(root.join("tables")).unwrap();
        std::fs::write(root.join("tables/orders.md"), BIGQUERY_CONCEPT).unwrap();
        // Malformed: no type. Must be tolerated (skipped + warning).
        std::fs::write(
            root.join("broken.md"),
            "---\ntitle: oops\n---\nno type here\n",
        )
        .unwrap();
        // Malformed: not even frontmatter.
        std::fs::write(root.join("plain.md"), "just text, no frontmatter\n").unwrap();

        let bundle = Bundle::from_dir(root).expect("load bundle");
        assert_eq!(bundle.okf_version.as_deref(), Some("0.1"));
        assert!(bundle.index.is_some());
        assert!(bundle.log.is_some());
        // Only the one valid concept loaded.
        assert_eq!(bundle.concepts.len(), 1);
        assert_eq!(bundle.concepts[0].type_, "BigQuery Table");
        // Two malformed files produced warnings; the load did not fail.
        assert_eq!(bundle.warnings.len(), 2);
    }

    #[test]
    fn bundle_write_round_trips() {
        let src = tempfile::tempdir().expect("tempdir");
        let root = src.path();
        std::fs::write(
            root.join("index.md"),
            "---\nokf: 0.1\ntitle: B\n---\n# Index\n",
        )
        .unwrap();
        std::fs::write(root.join("log.md"), "## 2026-06-29\n\nEntry.\n").unwrap();
        std::fs::create_dir_all(root.join("tables")).unwrap();
        std::fs::write(root.join("tables/orders.md"), BIGQUERY_CONCEPT).unwrap();

        let bundle = Bundle::from_dir(root).expect("load");

        let out = tempfile::tempdir().expect("out tempdir");
        bundle.write(out.path()).expect("write");

        let reloaded = Bundle::from_dir(out.path()).expect("reload");
        assert_eq!(reloaded.concepts.len(), 1);
        assert_eq!(reloaded.concepts[0], bundle.concepts[0]);
        assert_eq!(reloaded.okf_version.as_deref(), Some("0.1"));
        assert!(reloaded.log.is_some());
    }
}
