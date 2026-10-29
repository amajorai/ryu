//! OKF ingest types and chunk-header helpers.

use super::*;

/// Maximum characters per OKF body chunk before splitting on word boundaries.
/// Mirrors the Space chunk size so the embedder sees comparably sized units.
pub(crate) const OKF_CHUNK_CHAR_SIZE: usize = 1_000;

/// Outcome of [`RetrievalStore::ingest_okf_bundle`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OkfIngestSummary {
    /// The bundle id the concepts were indexed under.
    pub bundle_id: String,
    /// Number of concepts ingested.
    pub concepts: usize,
    /// Number of chunks written (concepts may split into multiple chunks).
    pub chunks: usize,
}

/// A preserved cross-link edge: a concept points at a link target. Relationships
/// are untyped (OKF v0.1), so only source and target are recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OkfEdge {
    /// Bundle-relative path of the concept that contains the link.
    pub concept_path: String,
    /// Link target as written (bundle-absolute `/x.md` or relative `./x.md`).
    pub target: String,
}

/// One materialized chunk row, embedded and ready to commit. Internal to the
/// ingest path so embedding (async, lock-free) and DB writes (locked) stay split.
/// Content, vector and metadata are already sealed for `chunk_id`.
pub(crate) struct OkfRow {
    pub(crate) chunk_id: String,
    pub(crate) content: String,
    pub(crate) blob: Vec<u8>,
    pub(crate) concept_path: String,
    pub(crate) concept_path_bi: String,
    pub(crate) okf_type: String,
    pub(crate) tags_json: String,
    pub(crate) resource: Option<String>,
    pub(crate) links_json: String,
    pub(crate) chunk_index: i64,
    pub(crate) metadata_json: String,
    /// The verbatim concept body, stored on chunk 0 only when a non-default
    /// strategy cut the body (overlap or breadcrumbs make the chunks lossy to
    /// rejoin), so export can restore it exactly.
    pub(crate) concept_body: Option<String>,
}

/// One row read back during export: a single indexed chunk plus the concept
/// metadata the `okf_chunks` sidecar carries. Internal to
/// [`RetrievalStore::reconstruct_okf_concepts`].
pub(crate) struct OkfExportRow {
    pub(crate) concept_path: String,
    pub(crate) chunk_index: i64,
    pub(crate) okf_type: String,
    pub(crate) tags_json: String,
    pub(crate) resource: Option<String>,
    pub(crate) links_json: String,
    pub(crate) content: String,
    pub(crate) created_at: i64,
    pub(crate) concept_body: Option<String>,
}

/// Reassemble one [`ryu_knowledge::Concept`] from its ordered chunk rows.
///
/// `rows` must be non-empty and all share a `concept_path`. The first chunk's
/// header yields `title`/`description`; bodies are stripped of their headers and
/// rejoined with blank lines.
pub(crate) fn concept_from_export_rows(rows: &[OkfExportRow]) -> ryu_knowledge::Concept {
    let first = &rows[0];
    let okf_type = first.okf_type.clone();
    let tags: Vec<String> = serde_json::from_str(&first.tags_json).unwrap_or_default();
    let link_targets: Vec<String> = serde_json::from_str(&first.links_json).unwrap_or_default();

    let mut title: Option<String> = None;
    let mut description: Option<String> = None;
    let mut body_parts: Vec<String> = Vec::new();
    for (idx, row) in rows.iter().enumerate() {
        let (header, body_chunk) = split_chunk_header(&row.content);
        if idx == 0 {
            let (t, d) = parse_chunk_header(header, &okf_type);
            title = t;
            description = d;
        }
        let body_chunk = body_chunk.trim();
        if !body_chunk.is_empty() {
            body_parts.push(body_chunk.to_owned());
        }
    }
    let body = match &first.concept_body {
        Some(verbatim) => verbatim.trim().to_owned(),
        None => body_parts.join("\n\n"),
    };

    let timestamp =
        chrono::DateTime::from_timestamp_millis(first.created_at).map(|dt| dt.to_rfc3339());

    let links = link_targets
        .into_iter()
        .map(|target| {
            let relative = !target.starts_with('/');
            ryu_knowledge::Link {
                text: target.clone(),
                target,
                relative,
            }
        })
        .collect();

    ryu_knowledge::Concept {
        file_path: first.concept_path.clone(),
        type_: okf_type,
        title,
        description,
        resource: first.resource.clone(),
        timestamp,
        tags,
        extra: std::collections::BTreeMap::new(),
        body,
        links,
    }
}

/// Split a stored chunk into its leading header line and the body remainder.
/// Ingest always prepends a non-empty header followed by `\n`, so a present
/// newline marks the boundary; without one the whole content is the header
/// (an empty-body concept).
pub(crate) fn split_chunk_header(content: &str) -> (&str, &str) {
    content.split_once('\n').unwrap_or((content, ""))
}

/// Recover `(title, description)` from a chunk header of the form
/// `{title} [{type}] {description}`. The bracketed type acts as the delimiter;
/// either side may be empty. If the marker is absent, the whole header is taken
/// as the title.
pub(crate) fn parse_chunk_header(header: &str, okf_type: &str) -> (Option<String>, Option<String>) {
    let marker = format!("[{okf_type}]");
    if let Some(pos) = header.find(&marker) {
        let before = header[..pos].trim();
        let after = header[pos + marker.len()..].trim();
        let title = (!before.is_empty()).then(|| before.to_owned());
        let description = (!after.is_empty()).then(|| after.to_owned());
        (title, description)
    } else {
        let header = header.trim();
        ((!header.is_empty()).then(|| header.to_owned()), None)
    }
}

/// Build a short context header for a concept's chunks so each chunk is
/// retrievable on its own (title + bracketed type + description).
pub(crate) fn okf_chunk_header(concept: &ryu_knowledge::Concept) -> String {
    let mut parts = Vec::new();
    if let Some(title) = concept.title.as_deref().filter(|s| !s.is_empty()) {
        parts.push(title.to_owned());
    }
    parts.push(format!("[{}]", concept.type_));
    if let Some(desc) = concept.description.as_deref().filter(|s| !s.is_empty()) {
        parts.push(desc.to_owned());
    }
    parts.join(" ")
}

/// Split a concept body into chunks of at most [`OKF_CHUNK_CHAR_SIZE`] chars,
/// breaking on paragraph then word boundaries. An empty body yields no chunks so
/// the header alone still carries the concept (handled by the caller).
pub(crate) fn chunk_okf_body(body: &str) -> Vec<String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return vec![String::new()];
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    for paragraph in trimmed.split("\n\n") {
        for word in paragraph.split_whitespace() {
            if current.chars().count() + word.chars().count() + 1 > OKF_CHUNK_CHAR_SIZE
                && !current.is_empty()
            {
                chunks.push(std::mem::take(&mut current));
            }
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(word);
        }
        if !current.is_empty() {
            chunks.push(std::mem::take(&mut current));
        }
    }
    if chunks.is_empty() {
        chunks.push(trimmed.to_owned());
    }
    chunks
}
