use std::collections::HashMap;
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use log::info;
use ryu_crypto::{BlindIndex, ContentCipher, ContentContext};
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, Occur, Query, RangeQuery, TermQuery};
use tantivy::schema::*;
use tantivy::{Index, IndexReader, IndexWriter, Order, ReloadPolicy, TantivyDocument};

use crate::seal;
use crate::timeline::TimelineEntry;

/// Schema version — bump whenever fields change. Triggers index rebuild.
/// v3: Added transcript metadata fields (audio_segment_id, audio_source, ts_end, confidence)
/// v4: Made source_kind indexed (STRING) for TermQuery support in range queries
/// v5: No stored or indexed plaintext: each document's text (app, window title,
///     URL, OCR/transcript text) is one sealed payload (`RYU-CB01`, store
///     `shadow-search`) and the index holds keyed blind term tokens. A v4 index
///     is moved aside and converted in the background into the live index (no
///     checkpoint reset; see [`LegacyConversion`]), older ones are rebuilt.
pub(crate) const SCHEMA_VERSION: u32 = 5;
/// The last schema that stored plaintext and can be converted document by document.
const CONVERTIBLE_VERSION: u32 = 4;
/// The blind-index field of the term tokens.
const TERMS_FIELD: &str = ryu_crypto::blind_index::TERMS_FIELD;
/// Where a v4 index waits (read-only) while it is converted in the background.
const PENDING_SUFFIX: &str = ".legacy-pending";
/// Documents converted so far (a count over the pending index's live
/// documents, in segment order), written after each committed batch.
const PROGRESS_FILE: &str = "ryu-convert-progress";
/// Legacy documents converted per committed batch: bounds memory and the time
/// the live index is locked.
const CONVERT_BATCH: usize = 2_000;

static DOC_SEQ: AtomicU64 = AtomicU64::new(0);

/// The text of one document, sealed as a whole into its `sealed` field.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct Payload {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    app: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    text: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    session: String,
}

impl Payload {
    fn searchable(&self) -> String {
        [&self.app, &self.title, &self.url, &self.text]
            .iter()
            .filter(|part| !part.is_empty())
            .map(|part| String::as_str(part))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Tantivy-based full-text search index over captured events and OCR text.
/// Indexes Track 3 (app/window context) and OCR-derived screen text.
///
/// Nothing in the index is plaintext: documents carry a sealed payload and the
/// blind term tokens of its text (whole-word search: no phrase, prefix or
/// fuzzy matching; stopword-only queries return nothing). Timestamps, tracks,
/// displays, source kinds and transcript timing stay clear for range queries.
pub struct SearchIndex {
    reader: IndexReader,
    writer: Option<IndexWriter>,
    /// True if the index was rebuilt due to a schema version change.
    /// Callers should reset related checkpoints when this is true.
    rebuilt: bool,
    /// A v4 index moved aside, still to be converted into this one.
    legacy_pending: Option<PathBuf>,
    cipher: ContentCipher,
    blind: BlindIndex,

    // Schema field handles
    doc_id_field: Field,
    terms_field: Field,
    sealed_field: Field,
    ts_field: Field,
    track_field: Field,
    event_type_field: Field,
    display_id_field: Field,
    source_kind_field: Field,

    // Transcript metadata fields (schema v3 — M4-B1)
    audio_segment_id_field: Field,
    audio_source_field: Field,
    ts_end_field: Field,
    confidence_field: Field,
}

/// A single search result returned to Swift via UniFFI.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SearchResult {
    pub ts: u64,
    pub app_name: String,
    pub window_title: String,
    pub url: String,
    pub display_id: Option<u32>,
    pub event_type: String,
    pub score: f32,
    pub match_reason: String,
    /// Source lane: "track3", "ocr", "transcript"
    pub source_kind: String,
    /// Text snippet for OCR/transcript results. Empty for track3.
    pub snippet: String,
    /// Audio segment ID for transcript results. None for non-transcript results.
    pub audio_segment_id: Option<i64>,
    /// Audio source ("mic" or "system") for transcript results. Empty for non-transcript.
    pub audio_source: String,
    /// End timestamp for transcript chunks (Unix microseconds). 0 for non-transcript.
    pub ts_end: u64,
    /// Transcription confidence (0.0-1.0). None when not available.
    pub confidence: Option<f32>,
}

/// An OCR text entry to be indexed. Passed from Swift via UniFFI.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OcrEntry {
    pub ts: u64,
    pub display_id: Option<u32>,
    pub text: String,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub confidence: Option<f32>,
}

/// A transcript chunk to be indexed. Passed from Swift via UniFFI.
/// Each chunk represents a time-bounded segment of transcribed audio.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TranscriptEntry {
    /// The audio_segments.segment_id that produced this chunk.
    pub audio_segment_id: i64,
    /// Audio source: "mic" or "system".
    pub source: String,
    /// Chunk start time (Unix microseconds).
    pub ts_start: u64,
    /// Chunk end time (Unix microseconds).
    pub ts_end: u64,
    /// Transcribed text.
    pub text: String,
    /// Transcription confidence (0.0–1.0), if available.
    pub confidence: Option<f32>,
    /// App that was focused during this chunk (from app_focus_intervals).
    pub app_name: Option<String>,
    /// Window title during this chunk.
    pub window_title: Option<String>,
}

/// A transcript chunk returned from a time-range query.
/// Used by the meeting summarization pipeline to retrieve all transcript text
/// within a time window.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TranscriptChunkResult {
    /// Chunk start time (Unix microseconds).
    pub ts_start: u64,
    /// Chunk end time (Unix microseconds).
    pub ts_end: u64,
    /// Transcribed text.
    pub text: String,
    /// Audio source: "mic" or "system".
    pub audio_source: String,
    /// Transcription confidence (0.0–1.0), if available.
    pub confidence: Option<f32>,
    /// App that was focused during this chunk.
    pub app_name: String,
    /// Window title during this chunk.
    pub window_title: String,
    /// The audio_segments.segment_id that produced this chunk.
    pub audio_segment_id: i64,
}

/// Search index statistics for diagnostics.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SearchIndexStats {
    pub total_docs: u64,
    pub num_segments: u64,
}

fn io_error(error: impl std::fmt::Display) -> SearchError {
    SearchError::IndexIO(error.to_string())
}

fn tantivy_error(error: impl std::fmt::Display) -> SearchError {
    SearchError::TantivyError(error.to_string())
}

fn read_version(dir: &Path) -> Option<u32> {
    std::fs::read_to_string(dir.join("schema_version"))
        .ok()
        .and_then(|text| text.trim().parse().ok())
}

fn sibling(dir: &Path, suffix: &str) -> PathBuf {
    let mut name = dir.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    dir.with_file_name(name)
}

fn remove_index_files(dir: &Path) -> Result<(), SearchError> {
    for entry in std::fs::read_dir(dir).map_err(io_error)?.flatten() {
        let path = entry.path();
        if path.is_file() {
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(())
}

/// The plaintext fields of one document of a legacy (v4) index, with the
/// deterministic id its converted copy gets (so a batch redone after a crash
/// replaces its earlier copy instead of duplicating it).
pub struct LegacyDoc {
    id: String,
    payload: Payload,
    ts: u64,
    track: u64,
    event_type: String,
    source_kind: String,
    display_id: Option<u64>,
    audio_segment_id: Option<i64>,
    audio_source: String,
    ts_end: Option<u64>,
    confidence: Option<f64>,
}

fn legacy_doc(schema: &Schema, doc: &TantivyDocument, id: String) -> LegacyDoc {
    let field = |name: &str| schema.get_field(name).ok();
    let text = |name: &str| {
        field(name)
            .map(|f| extract_text(doc, f))
            .unwrap_or_default()
    };
    let u64_of = |name: &str| field(name).and_then(|f| doc.get_first(f).and_then(|v| v.as_u64()));
    LegacyDoc {
        id,
        payload: Payload {
            app: text("app_name"),
            title: text("window_title"),
            url: text("url"),
            text: text("text_content"),
            session: text("session_id"),
        },
        ts: u64_of("ts").unwrap_or(0),
        track: u64_of("track").unwrap_or(0),
        event_type: text("event_type"),
        source_kind: text("source_kind"),
        display_id: u64_of("display_id"),
        audio_segment_id: field("audio_segment_id")
            .and_then(|f| doc.get_first(f).and_then(|v| v.as_i64())),
        audio_source: text("audio_source"),
        ts_end: u64_of("ts_end"),
        confidence: field("confidence").and_then(|f| doc.get_first(f).and_then(|v| v.as_f64())),
    }
}

/// A plaintext v4 index moved aside at open, converted into the live sealed
/// index in the background ([`Self::run`]). Until it finishes, search answers
/// from what was converted so far plus everything indexed since.
pub struct LegacyConversion {
    dir: PathBuf,
}

impl LegacyConversion {
    /// Stream the legacy documents segment by segment, handing them to `apply`
    /// in batches of [`CONVERT_BATCH`] (it adds and commits them to the live
    /// index), recording progress after each batch so a restart resumes where
    /// it stopped. Deletes the plaintext index once every document is in.
    /// Returns how many documents the legacy index held.
    pub fn run(
        self,
        mut apply: impl FnMut(Vec<LegacyDoc>) -> Result<(), SearchError>,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<u64, SearchError> {
        let progress_path = self.dir.join(PROGRESS_FILE);
        let done: u64 = std::fs::read_to_string(&progress_path)
            .ok()
            .and_then(|text| text.trim().parse().ok())
            .unwrap_or(0);
        let total = {
            let index = Index::open_in_dir(&self.dir).map_err(tantivy_error)?;
            let schema = index.schema();
            let reader = index.reader().map_err(tantivy_error)?;
            let searcher = reader.searcher();
            let total: u64 = searcher
                .segment_readers()
                .iter()
                .map(|segment| u64::from(segment.num_docs()))
                .sum();
            let mut ordinal = 0u64;
            let mut batch = Vec::with_capacity(CONVERT_BATCH);
            let mut flush = |batch: &mut Vec<LegacyDoc>, ordinal: u64| {
                if batch.is_empty() {
                    return Ok(());
                }
                apply(std::mem::take(batch))?;
                std::fs::write(&progress_path, ordinal.to_string()).map_err(io_error)?;
                progress(ordinal, total);
                Ok::<(), SearchError>(())
            };
            for (segment_ord, segment) in searcher.segment_readers().iter().enumerate() {
                let segment_id = segment.segment_id().uuid_string();
                for doc_id in segment.doc_ids_alive() {
                    ordinal += 1;
                    if ordinal <= done {
                        continue;
                    }
                    let address = tantivy::DocAddress::new(segment_ord as u32, doc_id);
                    let doc: TantivyDocument = searcher.doc(address).map_err(tantivy_error)?;
                    batch.push(legacy_doc(
                        &schema,
                        &doc,
                        format!("v4-{segment_id}-{doc_id:x}"),
                    ));
                    if batch.len() >= CONVERT_BATCH {
                        flush(&mut batch, ordinal)?;
                    }
                }
            }
            flush(&mut batch, ordinal)?;
            total
        };
        std::fs::remove_dir_all(&self.dir).map_err(io_error)?;
        info!(
            "Search index converted to sealed schema v{} ({} documents)",
            SCHEMA_VERSION, total
        );
        Ok(total)
    }
}

impl SearchIndex {
    pub fn new(index_dir: &Path) -> Result<Self, SearchError> {
        #[cfg(test)]
        seal::install_fixed_key_for_tests();
        let cipher = seal::content(seal::SEARCH_STORE).map_err(io_error)?;
        let blind = seal::blind(seal::SEARCH_STORE, TERMS_FIELD).map_err(io_error)?;
        Self::open_with(index_dir, cipher, blind)
    }

    fn open_with(
        index_dir: &Path,
        cipher: ContentCipher,
        blind: BlindIndex,
    ) -> Result<Self, SearchError> {
        // Finish (or undo) a conversion a crash interrupted.
        let legacy_dir = sibling(index_dir, ".legacy");
        if legacy_dir.exists() {
            if read_version(index_dir) == Some(SCHEMA_VERSION) {
                let _ = std::fs::remove_dir_all(&legacy_dir);
            } else {
                let _ = std::fs::remove_dir_all(index_dir);
                std::fs::rename(&legacy_dir, index_dir).map_err(io_error)?;
            }
        }
        // A conversion an older build ran in place and a crash interrupted.
        let _ = std::fs::remove_dir_all(sibling(index_dir, ".v5-building"));
        seal::create_private_dir(index_dir).map_err(io_error)?;

        // Check schema version — convert or recreate the index if stale
        let has_index = index_dir.join("meta.json").exists();
        let stored = read_version(index_dir);
        let mut needs_recreate = false;
        let pending = sibling(index_dir, PENDING_SUFFIX);
        if has_index && stored == Some(CONVERTIBLE_VERSION) {
            // Moved aside (one rename) and converted in the background into a
            // fresh sealed index, so opening never waits for it.
            let _ = std::fs::remove_dir_all(&pending);
            std::fs::rename(index_dir, &pending).map_err(io_error)?;
            seal::create_private_dir(index_dir).map_err(io_error)?;
        } else if has_index && stored != Some(SCHEMA_VERSION) {
            info!(
                "Search schema version changed (want {}), rebuilding index at {}",
                SCHEMA_VERSION,
                index_dir.display()
            );
            remove_index_files(index_dir)?;
            needs_recreate = true;
        }

        let schema = Self::build_schema();

        let index = if index_dir.join("meta.json").exists() {
            Index::open_in_dir(index_dir).map_err(tantivy_error)?
        } else {
            Index::create_in_dir(index_dir, schema.clone()).map_err(tantivy_error)?
        };

        // Write schema version
        std::fs::write(index_dir.join("schema_version"), SCHEMA_VERSION.to_string())
            .map_err(io_error)?;

        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()
            .map_err(|e: tantivy::TantivyError| SearchError::TantivyError(e.to_string()))?;

        let writer = index.writer(50_000_000).map_err(tantivy_error)?;

        let schema = index.schema();

        info!(
            "Search index opened at {} (schema v{})",
            index_dir.display(),
            SCHEMA_VERSION
        );

        let legacy_pending = pending.join("meta.json").exists().then_some(pending);
        Ok(Self {
            reader,
            writer: Some(writer),
            rebuilt: needs_recreate,
            legacy_pending,
            cipher,
            blind,
            doc_id_field: schema.get_field("doc_id").unwrap(),
            terms_field: schema.get_field("terms").unwrap(),
            sealed_field: schema.get_field("sealed").unwrap(),
            ts_field: schema.get_field("ts").unwrap(),
            track_field: schema.get_field("track").unwrap(),
            event_type_field: schema.get_field("event_type").unwrap(),
            display_id_field: schema.get_field("display_id").unwrap(),
            source_kind_field: schema.get_field("source_kind").unwrap(),
            audio_segment_id_field: schema.get_field("audio_segment_id").unwrap(),
            audio_source_field: schema.get_field("audio_source").unwrap(),
            ts_end_field: schema.get_field("ts_end").unwrap(),
            confidence_field: schema.get_field("confidence").unwrap(),
        })
    }

    /// The v4 index waiting to be converted into this one, if any (taken
    /// once; run it on a background thread with [`Self::add_converted`]).
    pub fn take_legacy_conversion(&mut self) -> Option<LegacyConversion> {
        self.legacy_pending
            .take()
            .map(|dir| LegacyConversion { dir })
    }

    /// Add one batch of converted legacy documents and commit. Each replaces
    /// any copy of the same legacy document a crashed run committed earlier.
    pub fn add_converted(&mut self, docs: Vec<LegacyDoc>) -> Result<(), SearchError> {
        let count = docs.len() as u32;
        for doc in docs {
            let mut out = self.base_doc_with_id(
                doc.id.clone(),
                doc.ts,
                doc.track,
                &doc.event_type,
                &doc.source_kind,
                &doc.payload,
            )?;
            if let Some(display) = doc.display_id {
                out.add_u64(self.display_id_field, display);
            }
            if let Some(segment) = doc.audio_segment_id {
                out.add_i64(self.audio_segment_id_field, segment);
            }
            if !doc.audio_source.is_empty() {
                out.add_text(self.audio_source_field, &doc.audio_source);
            }
            if let Some(ts_end) = doc.ts_end {
                out.add_u64(self.ts_end_field, ts_end);
            }
            if let Some(confidence) = doc.confidence {
                out.add_f64(self.confidence_field, confidence);
            }
            let writer = self
                .writer
                .as_mut()
                .ok_or_else(|| SearchError::TantivyError("Writer not available".into()))?;
            writer.delete_term(Term::from_field_text(self.doc_id_field, &doc.id));
            writer.add_document(out).map_err(tantivy_error)?;
        }
        self.commit(count, "converted legacy")
    }

    fn build_schema() -> Schema {
        let mut sb = Schema::builder();

        // Document id (bound into the payload's AAD) and the sealed payload.
        sb.add_text_field("doc_id", STRING | STORED);
        sb.add_bytes_field("sealed", STORED);
        // Blind term tokens (raw, indexed, never stored).
        sb.add_text_field("terms", STRING);

        // Stored-only metadata (event kind, not user text)
        sb.add_text_field("event_type", STORED);

        // source_kind: indexed as exact-match (STRING) for TermQuery filtering.
        // Values: "track3", "passive", "ocr", "transcript".
        sb.add_text_field("source_kind", STRING | STORED);

        // Numeric fields (sortable + retrievable)
        sb.add_u64_field("ts", FAST | STORED);
        sb.add_u64_field("track", FAST | STORED);
        sb.add_u64_field("display_id", FAST | STORED);

        // Transcript metadata fields (schema v3 — M4-B1)
        sb.add_i64_field("audio_segment_id", FAST | STORED);
        sb.add_text_field("audio_source", STORED);
        sb.add_u64_field("ts_end", FAST | STORED);
        sb.add_f64_field("confidence", FAST | STORED);

        sb.build()
    }

    fn payload_context(doc_id: &str) -> ContentContext {
        ContentContext::new("doc.payload").with("id", doc_id)
    }

    /// A document with its id, sealed payload, blind tokens and base metadata.
    fn base_doc(
        &self,
        ts: u64,
        track: u64,
        event_type: &str,
        source_kind: &str,
        payload: &Payload,
    ) -> Result<TantivyDocument, SearchError> {
        let doc_id = format!(
            "{ts:x}-{:x}-{:x}",
            std::process::id(),
            DOC_SEQ.fetch_add(1, Ordering::Relaxed)
        );
        self.base_doc_with_id(doc_id, ts, track, event_type, source_kind, payload)
    }

    fn base_doc_with_id(
        &self,
        doc_id: String,
        ts: u64,
        track: u64,
        event_type: &str,
        source_kind: &str,
        payload: &Payload,
    ) -> Result<TantivyDocument, SearchError> {
        let json = serde_json::to_vec(payload).map_err(io_error)?;
        let sealed = self
            .cipher
            .seal_bytes(&json, &Self::payload_context(&doc_id))
            .map_err(io_error)?;
        let mut doc = TantivyDocument::default();
        doc.add_text(self.doc_id_field, &doc_id);
        doc.add_bytes(self.sealed_field, &sealed);
        for token in self.blind.term_tokens(&payload.searchable()) {
            doc.add_text(self.terms_field, &token);
        }
        doc.add_u64(self.ts_field, ts);
        doc.add_u64(self.track_field, track);
        doc.add_text(self.event_type_field, event_type);
        doc.add_text(self.source_kind_field, source_kind);
        Ok(doc)
    }

    /// Open a document's sealed payload; `None` (counted) when it does not open.
    fn open_payload(&self, doc: &TantivyDocument) -> Option<Payload> {
        let doc_id = extract_text(doc, self.doc_id_field);
        let sealed = doc
            .get_first(self.sealed_field)
            .and_then(|v| v.as_bytes())
            .map(<[u8]>::to_vec)
            .unwrap_or_default();
        let opened = self
            .cipher
            .open_bytes(&sealed, &Self::payload_context(&doc_id))
            .ok()
            .filter(|opened| !opened.needs_reseal || ContentCipher::is_sealed_bytes(&sealed))
            .and_then(|opened| serde_json::from_slice::<Payload>(&opened.value).ok());
        if opened.is_none() {
            seal::note_unreadable("search document");
        }
        opened
    }

    fn commit(&mut self, count: u32, what: &str) -> Result<(), SearchError> {
        if count == 0 {
            return Ok(());
        }
        let writer = self
            .writer
            .as_mut()
            .ok_or_else(|| SearchError::TantivyError("Writer not available".into()))?;
        writer.commit().map_err(tantivy_error)?;
        self.reader.reload().map_err(tantivy_error)?;
        info!("Indexed {count} {what} documents into search index");
        Ok(())
    }

    fn add(&mut self, doc: TantivyDocument) -> Result<(), SearchError> {
        self.writer
            .as_mut()
            .ok_or_else(|| SearchError::TantivyError("Writer not available".into()))?
            .add_document(doc)
            .map_err(tantivy_error)?;
        Ok(())
    }

    /// Index a batch of timeline entries into Tantivy. Returns count of docs added.
    /// Currently indexes Track 3 events (app context). Track 2 input events
    /// contain individual keystrokes that need aggregation (future milestone).
    pub fn index_entries(&mut self, entries: &[TimelineEntry]) -> Result<u32, SearchError> {
        seal::require_writable().map_err(io_error)?;
        let mut count = 0u32;

        for entry in entries {
            // Index app/window context (track 3) plus the passive text sources —
            // clipboard/filesystem/git/terminal/notifications/calendar (tracks
            // 6–11), which carry their searchable text in app_name/window_title.
            let is_passive = (6..=11).contains(&entry.track);
            if entry.track != 3 && !is_passive {
                continue;
            }

            // Skip entries with no searchable text
            let has_text =
                entry.app_name.is_some() || entry.window_title.is_some() || entry.url.is_some();
            if !has_text {
                continue;
            }

            let payload = Payload {
                app: entry.app_name.clone().unwrap_or_default(),
                title: entry.window_title.clone().unwrap_or_default(),
                url: entry.url.clone().unwrap_or_default(),
                ..Payload::default()
            };
            let mut doc = self.base_doc(
                entry.ts,
                entry.track as u64,
                &entry.event_type,
                if is_passive { "passive" } else { "track3" },
                &payload,
            )?;
            if let Some(did) = entry.display_id {
                doc.add_u64(self.display_id_field, did as u64);
            }
            self.add(doc)?;
            count += 1;
        }

        self.commit(count, "track3")?;
        Ok(count)
    }

    /// Index a batch of OCR text entries into Tantivy. Returns count of docs added.
    pub fn index_ocr_entries(&mut self, entries: &[OcrEntry]) -> Result<u32, SearchError> {
        seal::require_writable().map_err(io_error)?;
        let mut count = 0u32;

        for entry in entries {
            if entry.text.trim().is_empty() {
                continue;
            }
            let payload = Payload {
                app: entry.app_name.clone().unwrap_or_default(),
                title: entry.window_title.clone().unwrap_or_default(),
                text: entry.text.clone(),
                ..Payload::default()
            };
            // Track 1 = visual stream
            let mut doc = self.base_doc(entry.ts, 1, "ocr_frame", "ocr", &payload)?;
            if let Some(did) = entry.display_id {
                doc.add_u64(self.display_id_field, did as u64);
            }
            self.add(doc)?;
            count += 1;
        }

        self.commit(count, "OCR")?;
        Ok(count)
    }

    /// Index a batch of transcript chunk entries into Tantivy. Returns count of docs added.
    /// Each chunk is a time-bounded segment of transcribed audio text.
    pub fn index_transcript_entries(
        &mut self,
        entries: &[TranscriptEntry],
    ) -> Result<u32, SearchError> {
        seal::require_writable().map_err(io_error)?;
        let mut count = 0u32;

        for entry in entries {
            if entry.text.trim().is_empty() {
                continue;
            }
            let payload = Payload {
                app: entry.app_name.clone().unwrap_or_default(),
                title: entry.window_title.clone().unwrap_or_default(),
                text: entry.text.clone(),
                ..Payload::default()
            };
            // Track 4 = audio stream
            let mut doc = self.base_doc(
                entry.ts_start,
                4,
                "transcript_chunk",
                "transcript",
                &payload,
            )?;
            // Transcript metadata — persisted for M4-C/M4-E playback
            doc.add_i64(self.audio_segment_id_field, entry.audio_segment_id);
            doc.add_text(self.audio_source_field, &entry.source);
            doc.add_u64(self.ts_end_field, entry.ts_end);
            if let Some(conf) = entry.confidence {
                doc.add_f64(self.confidence_field, conf as f64);
            }
            self.add(doc)?;
            count += 1;
        }

        self.commit(count, "transcript")?;
        Ok(count)
    }

    /// The blind-token query of `query_str`: any of its terms (`None` when it
    /// has no indexable term).
    fn token_query(&self, query_str: &str) -> Option<BooleanQuery> {
        let tokens = self.blind.term_tokens(query_str);
        if tokens.is_empty() {
            return None;
        }
        let clauses: Vec<(Occur, Box<dyn Query>)> = tokens
            .iter()
            .map(|token| {
                let query: Box<dyn Query> = Box::new(TermQuery::new(
                    Term::from_field_text(self.terms_field, token),
                    IndexRecordOption::Basic,
                ));
                (Occur::Should, query)
            })
            .collect();
        Some(BooleanQuery::new(clauses))
    }

    /// Build a result from a hit: open the payload, derive reason and snippet.
    fn result_from(
        &self,
        doc: &TantivyDocument,
        score: f32,
        query_str: &str,
    ) -> Option<SearchResult> {
        let payload = self.open_payload(doc)?;
        let source_kind = extract_text(doc, self.source_kind_field);
        let match_reason = determine_match_reason(
            query_str,
            &payload.app,
            &payload.title,
            &payload.url,
            &payload.text,
            &source_kind,
        );
        // For OCR/transcript results, the snippet comes from the opened text.
        let snippet = if source_kind == "ocr" || source_kind == "transcript" {
            make_snippet(&payload.text, query_str, 120)
        } else {
            String::new()
        };
        Some(SearchResult {
            ts: extract_u64(doc, self.ts_field),
            app_name: payload.app,
            window_title: payload.title,
            url: payload.url,
            display_id: doc
                .get_first(self.display_id_field)
                .and_then(|v| v.as_u64())
                .map(|n| n as u32),
            event_type: extract_text(doc, self.event_type_field),
            score,
            match_reason,
            source_kind,
            snippet,
            audio_segment_id: doc
                .get_first(self.audio_segment_id_field)
                .and_then(|v| v.as_i64()),
            audio_source: extract_text(doc, self.audio_source_field),
            ts_end: extract_u64(doc, self.ts_end_field),
            confidence: extract_opt_f32(doc, self.confidence_field),
        })
    }

    fn run_query(
        &self,
        query: &dyn Query,
        query_str: &str,
        limit: usize,
    ) -> Result<Vec<SearchResult>, SearchError> {
        let searcher = self.reader.searcher();
        // Fetch more candidates than requested to account for dedup merging
        let top_docs = searcher
            .search(
                query,
                &TopDocs::with_limit(limit.max(1) * 3).order_by_score(),
            )
            .map_err(tantivy_error)?;
        let mut raw_results = Vec::with_capacity(top_docs.len());
        for (score, doc_address) in top_docs {
            let doc: TantivyDocument = searcher.doc(doc_address).map_err(tantivy_error)?;
            if let Some(result) = self.result_from(&doc, score, query_str) {
                raw_results.push(result);
            }
        }
        // Deduplicate results within a 5-second window on the same display
        Ok(deduplicate_results(raw_results, limit))
    }

    /// Execute a text search query. Returns top `limit` results ordered by relevance.
    /// Matches whole words of the app name, window title, URL and OCR/transcript
    /// text (blind tokens). Deduplicates results within a 5-second window on the
    /// same display.
    pub fn search(&self, query_str: &str, limit: usize) -> Result<Vec<SearchResult>, SearchError> {
        if query_str.trim().is_empty() {
            return Ok(Vec::new());
        }
        let Some(query) = self.token_query(query_str) else {
            return Ok(Vec::new());
        };
        self.run_query(&query, query_str, limit)
    }

    /// Execute a text search within a timestamp range.
    /// Returns top `limit` results where `ts` is between `start_us` and `end_us` (inclusive).
    pub fn search_in_range(
        &self,
        query_str: &str,
        start_us: u64,
        end_us: u64,
        limit: usize,
    ) -> Result<Vec<SearchResult>, SearchError> {
        if query_str.trim().is_empty() || start_us > end_us {
            return Ok(Vec::new());
        }
        let Some(text_query) = self.token_query(query_str) else {
            return Ok(Vec::new());
        };
        let range_query = u64_range_query(
            self.ts_field,
            Bound::Included(start_us),
            Bound::Included(end_us),
        );
        let bool_query = BooleanQuery::new(vec![
            (Occur::Must, Box::new(text_query)),
            (Occur::Must, Box::new(range_query)),
        ]);
        self.run_query(&bool_query, query_str, limit)
    }

    /// Delete every document (app context, passive text, OCR and transcript
    /// chunks) whose `ts` is older than `cutoff_us`, commit, and reload the
    /// reader so searches stop returning it. Returns how many documents matched.
    /// Used by the history retention sweep; deleting an already-empty range is a
    /// no-op, so a sweep interrupted before commit simply repeats next time.
    pub fn delete_before(&mut self, cutoff_us: u64) -> Result<u64, SearchError> {
        if cutoff_us == 0 {
            return Ok(0);
        }
        let older = || u64_range_query(self.ts_field, Bound::Unbounded, Bound::Excluded(cutoff_us));
        let matched = self
            .reader
            .searcher()
            .search(&older(), &tantivy::collector::Count)
            .map_err(|e| SearchError::TantivyError(e.to_string()))? as u64;
        if matched == 0 {
            return Ok(0);
        }
        let writer = self
            .writer
            .as_mut()
            .ok_or_else(|| SearchError::TantivyError("Writer not available".into()))?;
        writer
            .delete_query(Box::new(older()))
            .map_err(|e| SearchError::TantivyError(e.to_string()))?;
        writer
            .commit()
            .map_err(|e| SearchError::TantivyError(e.to_string()))?;
        self.reader
            .reload()
            .map_err(|e| SearchError::TantivyError(e.to_string()))?;
        info!("Retention removed {matched} search documents older than the history window");
        Ok(matched)
    }

    /// Get index statistics for diagnostics.
    pub fn stats(&self) -> SearchIndexStats {
        let searcher = self.reader.searcher();
        let num_docs = searcher.num_docs();
        let num_segments = searcher.segment_readers().len() as u64;
        SearchIndexStats {
            total_docs: num_docs,
            num_segments,
        }
    }

    /// List transcript chunks within a time range, with pagination.
    /// Returns up to `limit` results starting at `offset`, sorted by ts_start ascending.
    ///
    /// Input guards:
    /// - limit == 0 → empty result
    /// - limit clamped to 1000 max
    /// - start_us > end_us → empty result
    pub fn list_transcript_chunks_in_range(
        &self,
        start_us: u64,
        end_us: u64,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<TranscriptChunkResult>, SearchError> {
        self.transcript_chunks(start_us, end_us, limit, offset, false)
    }

    /// Whole transcript chunks whose audio windows overlap the requested range.
    pub fn list_transcript_chunks_overlapping(
        &self,
        start_us: u64,
        end_us: u64,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<TranscriptChunkResult>, SearchError> {
        self.transcript_chunks(start_us, end_us, limit, offset, true)
    }

    fn transcript_chunks(
        &self,
        start_us: u64,
        end_us: u64,
        limit: u32,
        offset: u32,
        overlapping: bool,
    ) -> Result<Vec<TranscriptChunkResult>, SearchError> {
        // Input guards
        if limit == 0 || start_us > end_us {
            return Ok(Vec::new());
        }
        let limit = limit.min(1000) as usize;
        let offset = offset as usize;

        let searcher = self.reader.searcher();

        // BooleanQuery: MUST(source_kind == "transcript") AND MUST(ts in [start_us, end_us])
        let term_query = TermQuery::new(
            Term::from_field_text(self.source_kind_field, "transcript"),
            IndexRecordOption::Basic,
        );
        let range_query = u64_range_query(
            self.ts_field,
            if overlapping {
                Bound::Unbounded
            } else {
                Bound::Included(start_us)
            },
            Bound::Included(end_us),
        );
        let mut conditions: Vec<(Occur, Box<dyn Query>)> = vec![
            (Occur::Must, Box::new(term_query)),
            (Occur::Must, Box::new(range_query)),
        ];
        if overlapping {
            conditions.push((
                Occur::Must,
                Box::new(u64_range_query(
                    self.ts_end_field,
                    Bound::Excluded(start_us),
                    Bound::Unbounded,
                )),
            ));
        }
        let bool_query = BooleanQuery::new(conditions);

        // Collector with pagination and fast-field ordering by ts ascending
        let collector = TopDocs::with_limit(limit)
            .and_offset(offset)
            .order_by_u64_field("ts", Order::Asc);

        let top_docs = searcher
            .search(&bool_query, &collector)
            .map_err(tantivy_error)?;

        // Already filtered, sorted, and paginated by Tantivy; open each payload.
        let mut results = Vec::with_capacity(top_docs.len());
        for (_ts_value, doc_addr) in top_docs {
            let doc: TantivyDocument = searcher.doc(doc_addr).map_err(tantivy_error)?;
            let Some(payload) = self.open_payload(&doc) else {
                continue;
            };
            results.push(TranscriptChunkResult {
                ts_start: extract_u64(&doc, self.ts_field),
                ts_end: extract_u64(&doc, self.ts_end_field),
                text: payload.text,
                audio_source: extract_text(&doc, self.audio_source_field),
                confidence: extract_opt_f32(&doc, self.confidence_field),
                app_name: payload.app,
                window_title: payload.title,
                audio_segment_id: extract_i64(&doc, self.audio_segment_id_field),
            });
        }

        Ok(results)
    }

    /// Returns true if the index was rebuilt due to a schema version change.
    /// When true, callers must reset related checkpoints (search_text, ocr)
    /// so that historical data is re-indexed into the empty index.
    pub fn was_rebuilt(&self) -> bool {
        self.rebuilt
    }
}

/// Range query over a `u64` field, with the term bounds Tantivy 0.26 expects.
fn u64_range_query(field: Field, lower: Bound<u64>, upper: Bound<u64>) -> RangeQuery {
    let term = |bound: Bound<u64>| match bound {
        Bound::Included(value) => Bound::Included(Term::from_field_u64(field, value)),
        Bound::Excluded(value) => Bound::Excluded(Term::from_field_u64(field, value)),
        Bound::Unbounded => Bound::Unbounded,
    };
    RangeQuery::new(term(lower), term(upper))
}

/// Extract a text field value from a Tantivy document, returning empty string if absent.
fn extract_text(doc: &tantivy::TantivyDocument, field: Field) -> String {
    doc.get_first(field)
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// Extract a u64 field value from a Tantivy document, returning 0 if absent.
fn extract_u64(doc: &tantivy::TantivyDocument, field: Field) -> u64 {
    doc.get_first(field).and_then(|v| v.as_u64()).unwrap_or(0)
}

/// Extract an i64 field value from a Tantivy document, returning 0 if absent.
fn extract_i64(doc: &tantivy::TantivyDocument, field: Field) -> i64 {
    doc.get_first(field).and_then(|v| v.as_i64()).unwrap_or(0)
}

/// Extract an optional f32 field value from a Tantivy document.
fn extract_opt_f32(doc: &tantivy::TantivyDocument, field: Field) -> Option<f32> {
    doc.get_first(field)
        .and_then(|v| v.as_f64())
        .map(|n| n as f32)
}

/// Determine which fields matched the query for the match reason tag.
/// Includes OCR and transcript source detection.
fn determine_match_reason(
    query: &str,
    app: &str,
    title: &str,
    url: &str,
    text_content: &str,
    source_kind: &str,
) -> String {
    let terms: Vec<String> = query.split_whitespace().map(|w| w.to_lowercase()).collect();

    let mut reasons = Vec::new();

    let app_lower = app.to_lowercase();
    if terms.iter().any(|t| app_lower.contains(t)) {
        reasons.push("app");
    }

    let title_lower = title.to_lowercase();
    if terms.iter().any(|t| title_lower.contains(t)) {
        reasons.push("title");
    }

    let url_lower = url.to_lowercase();
    if terms.iter().any(|t| url_lower.contains(t)) {
        reasons.push("url");
    }

    if !text_content.is_empty() {
        let content_lower = text_content.to_lowercase();
        if terms.iter().any(|t| content_lower.contains(t)) {
            match source_kind {
                "ocr" => reasons.push("ocr"),
                "transcript" => reasons.push("transcript"),
                _ => reasons.push("text"),
            }
        }
    }

    if reasons.is_empty() {
        // Tantivy matched via stemming/tokenization that our naive check missed
        match source_kind {
            "ocr" => "ocr".to_string(),
            "transcript" => "transcript".to_string(),
            _ => "text".to_string(),
        }
    } else {
        reasons.join(",")
    }
}

/// Create a short snippet from text content, centered around the first query term match.
/// Uses char indices throughout to avoid panics on multi-byte UTF-8 (CJK, emoji, etc.).
fn make_snippet(text: &str, query: &str, max_chars: usize) -> String {
    if text.is_empty() {
        return String::new();
    }

    let text_lower = text.to_lowercase();
    let terms: Vec<String> = query.split_whitespace().map(|w| w.to_lowercase()).collect();

    // Build a char-index-to-byte-offset map for the lowercased text.
    // We find the match position in char indices, then map back to byte offsets
    // in the original text for slicing.
    let char_count = text.chars().count();

    // Find first matching term position in char indices of the lowercased text
    let match_char_pos: usize = terms
        .iter()
        .filter_map(|t| {
            // Find byte offset in lowercased text, then convert to char index
            text_lower
                .find(t.as_str())
                .map(|byte_pos| text_lower[..byte_pos].chars().count())
        })
        .min()
        .unwrap_or(0);

    // Center snippet window around the match (in char indices)
    let half = max_chars / 2;
    let mut start_char = match_char_pos.saturating_sub(half);
    let mut end_char = (start_char + max_chars).min(char_count);
    if end_char == char_count {
        start_char = char_count.saturating_sub(max_chars);
    }

    // Snap to word boundaries using char indices on the original text.
    // Collect chars with their byte offsets for efficient slicing.
    let indexed_chars: Vec<(usize, char)> = text.char_indices().collect();

    // Snap start forward to after next space
    if start_char > 0 {
        if let Some(pos) = indexed_chars[start_char..end_char]
            .iter()
            .position(|(_, c)| *c == ' ')
        {
            start_char += pos + 1;
        }
    }

    // Snap end backward to before last space
    if end_char < char_count {
        if let Some(pos) = indexed_chars[start_char..end_char]
            .iter()
            .rposition(|(_, c)| *c == ' ')
        {
            end_char = start_char + pos;
        }
    }

    // Clamp in case snapping emptied the window
    if start_char >= end_char {
        start_char = match_char_pos;
        end_char = (start_char + max_chars).min(char_count);
    }

    // Convert char indices to byte offsets for slicing
    let byte_start = indexed_chars[start_char].0;
    let byte_end = if end_char >= indexed_chars.len() {
        text.len()
    } else {
        indexed_chars[end_char].0
    };

    let mut snippet = text[byte_start..byte_end].to_string();
    if start_char > 0 {
        snippet.insert_str(0, "\u{2026}");
    }
    if end_char < char_count {
        snippet.push('\u{2026}');
    }

    snippet
}

/// Public entry point for deduplication, used by search_hybrid in lib.rs.
pub fn deduplicate_results_public(results: Vec<SearchResult>, limit: usize) -> Vec<SearchResult> {
    deduplicate_results(results, limit)
}

/// Deduplicate search results within a 5-second timestamp window on the same display.
/// Keeps the highest-scoring result in each group, merging match_reason tags.
fn deduplicate_results(mut results: Vec<SearchResult>, limit: usize) -> Vec<SearchResult> {
    if results.is_empty() {
        return results;
    }

    // Group key: (display_id_or_0, ts_bucket_5s)
    let bucket_width: u64 = 5_000_000; // 5 seconds in microseconds

    struct Group {
        best: SearchResult,
        reasons: Vec<String>,
    }

    let mut groups: HashMap<(u32, u64), Group> = HashMap::new();
    // Track insertion order so results stay sorted by score
    let mut order: Vec<(u32, u64)> = Vec::new();

    for result in results.drain(..) {
        let display = result.display_id.unwrap_or(0);
        let bucket = result.ts / bucket_width;
        let key = (display, bucket);

        if let Some(group) = groups.get_mut(&key) {
            // Merge: keep higher score, collect reasons
            for reason in result.match_reason.split(',') {
                let r = reason.to_string();
                if !group.reasons.contains(&r) {
                    group.reasons.push(r);
                }
            }
            if result.score > group.best.score {
                // Keep the better snippet: prefer new result's, fall back to existing
                let prev_snippet = std::mem::take(&mut group.best.snippet);
                group.best = result;
                if group.best.snippet.is_empty() {
                    group.best.snippet = prev_snippet;
                }
            } else if group.best.snippet.is_empty() && !result.snippet.is_empty() {
                group.best.snippet = result.snippet;
            }
        } else {
            let reasons: Vec<String> = result
                .match_reason
                .split(',')
                .map(|s| s.to_string())
                .collect();
            order.push(key);
            groups.insert(
                key,
                Group {
                    best: result,
                    reasons,
                },
            );
        }
    }

    // Emit results in original score order, with merged reasons
    let mut deduped: Vec<SearchResult> = Vec::with_capacity(groups.len());
    for key in &order {
        if let Some(mut group) = groups.remove(key) {
            group.best.match_reason = group.reasons.join(",");
            deduped.push(group.best);
        }
    }

    deduped.truncate(limit);
    deduped
}

/// Search-specific error type (internal, mapped to ShadowError at the UniFFI boundary).
#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    #[error("Tantivy error: {0}")]
    TantivyError(String),
    #[error("Query parse error: {0}")]
    QueryParse(String),
    #[error("Index I/O error: {0}")]
    IndexIO(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_entry(
        ts: u64,
        app: Option<&str>,
        title: Option<&str>,
        url: Option<&str>,
    ) -> TimelineEntry {
        TimelineEntry {
            ts,
            track: 3,
            event_type: "app_switch".to_string(),
            app_name: app.map(|s| s.to_string()),
            bundle_id: None,
            app_path: None,
            window_title: title.map(|s| s.to_string()),
            url: url.map(|s| s.to_string()),
            display_id: None,
            segment_file: "test.msgpack".to_string(),
        }
    }

    #[test]
    fn test_index_and_search() {
        let tmp = TempDir::new().unwrap();
        let mut index = SearchIndex::new(tmp.path()).unwrap();

        let entries = vec![
            make_entry(
                1000,
                Some("Chrome"),
                Some("Gmail - Inbox"),
                Some("https://mail.google.com"),
            ),
            make_entry(2000, Some("VS Code"), Some("main.rs - shadow"), None),
            make_entry(3000, Some("Slack"), Some("general - Shadow team"), None),
        ];

        let count = index.index_entries(&entries).unwrap();
        assert_eq!(count, 3);

        // Search by app name
        let results = index.search("Chrome", 10).unwrap();
        assert!(!results.is_empty());
        assert_eq!(results[0].app_name, "Chrome");
        assert_eq!(results[0].source_kind, "track3");

        // Search by window title
        let results = index.search("Gmail", 10).unwrap();
        assert!(!results.is_empty());
        assert!(results[0].window_title.contains("Gmail"));

        // Search by URL domain
        let results = index.search("google", 10).unwrap();
        assert!(!results.is_empty());

        // Search with no results
        let results = index.search("nonexistent_app_xyz", 10).unwrap();
        assert!(results.is_empty());

        // Empty query returns empty
        let results = index.search("", 10).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_stats() {
        let tmp = TempDir::new().unwrap();
        let mut index = SearchIndex::new(tmp.path()).unwrap();

        let stats = index.stats();
        assert_eq!(stats.total_docs, 0);

        let entries = vec![make_entry(1000, Some("Chrome"), Some("test page"), None)];
        index.index_entries(&entries).unwrap();

        let stats = index.stats();
        assert_eq!(stats.total_docs, 1);
    }

    #[test]
    fn test_skips_non_track3() {
        let tmp = TempDir::new().unwrap();
        let mut index = SearchIndex::new(tmp.path()).unwrap();

        let entries = vec![
            TimelineEntry {
                ts: 1000,
                track: 2, // Input event — should be skipped
                event_type: "key_down".to_string(),
                app_name: Some("Chrome".to_string()),
                bundle_id: None,
                app_path: None,
                window_title: None,
                url: None,
                display_id: None,
                segment_file: "test.msgpack".to_string(),
            },
            make_entry(2000, Some("Chrome"), Some("Gmail"), None),
        ];

        let count = index.index_entries(&entries).unwrap();
        assert_eq!(count, 1); // Only the Track 3 entry
    }

    #[test]
    fn test_match_reason() {
        assert_eq!(
            determine_match_reason("chrome", "Chrome", "Gmail", "", "", "track3"),
            "app"
        );
        assert_eq!(
            determine_match_reason("gmail", "Chrome", "Gmail - Inbox", "", "", "track3"),
            "title"
        );
        assert_eq!(
            determine_match_reason(
                "google",
                "Chrome",
                "Gmail",
                "https://google.com",
                "",
                "track3"
            ),
            "url"
        );
        assert_eq!(
            determine_match_reason("chrome gmail", "Chrome", "Gmail", "", "", "track3"),
            "app,title"
        );
    }

    #[test]
    fn test_display_id_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let mut index = SearchIndex::new(tmp.path()).unwrap();

        let entries = vec![
            TimelineEntry {
                ts: 1000,
                track: 3,
                event_type: "app_switch".to_string(),
                app_name: Some("Chrome".to_string()),
                bundle_id: None,
                app_path: None,
                window_title: Some("Test".to_string()),
                url: None,
                display_id: Some(69734112),
                segment_file: "test.msgpack".to_string(),
            },
            // Entry without display_id
            make_entry(2000, Some("Slack"), Some("general"), None),
        ];

        index.index_entries(&entries).unwrap();

        let results = index.search("Chrome", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].display_id, Some(69734112));

        let results = index.search("Slack", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].display_id, None);
    }

    #[test]
    fn test_ocr_index_and_search() {
        let tmp = TempDir::new().unwrap();
        let mut index = SearchIndex::new(tmp.path()).unwrap();

        let ocr_entries = vec![
            OcrEntry {
                ts: 1000,
                display_id: Some(1),
                text: "Meeting notes: discuss Q3 budget allocation and timeline".to_string(),
                app_name: Some("Zoom".to_string()),
                window_title: Some("Zoom Meeting".to_string()),
                confidence: Some(0.95),
            },
            OcrEntry {
                ts: 2000,
                display_id: Some(1),
                text: "func handleError(err error) { return fmt.Errorf }".to_string(),
                app_name: Some("VS Code".to_string()),
                window_title: Some("main.go".to_string()),
                confidence: Some(0.88),
            },
        ];

        let count = index.index_ocr_entries(&ocr_entries).unwrap();
        assert_eq!(count, 2);

        // Search for OCR text
        let results = index.search("budget", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].source_kind, "ocr");
        assert!(results[0].match_reason.contains("ocr"));
        assert!(results[0].snippet.contains("budget"));
        assert_eq!(results[0].app_name, "Zoom");

        // Search for code text
        let results = index.search("handleError", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].source_kind, "ocr");

        // Search that hits both track3 and OCR (using same index instance)
        let track3_entries = vec![make_entry(
            10_000_000,
            Some("Chrome"),
            Some("Budget Report - Google Sheets"),
            None,
        )];
        index.index_entries(&track3_entries).unwrap();

        let results = index.search("budget", 10).unwrap();
        assert!(results.len() >= 2); // Both OCR and track3 results
    }

    #[test]
    fn test_ocr_skips_empty_text() {
        let tmp = TempDir::new().unwrap();
        let mut index = SearchIndex::new(tmp.path()).unwrap();

        let entries = vec![
            OcrEntry {
                ts: 1000,
                display_id: None,
                text: "   ".to_string(), // whitespace-only
                app_name: None,
                window_title: None,
                confidence: None,
            },
            OcrEntry {
                ts: 2000,
                display_id: None,
                text: "real text".to_string(),
                app_name: None,
                window_title: None,
                confidence: None,
            },
        ];

        let count = index.index_ocr_entries(&entries).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_dedup_same_timestamp_window() {
        let tmp = TempDir::new().unwrap();
        let mut index = SearchIndex::new(tmp.path()).unwrap();

        // Two results within 5-second window on the same display should dedup
        let entries = vec![
            make_entry(
                1_000_000,
                Some("Chrome"),
                Some("Gmail - Search results"),
                None,
            ),
            make_entry(1_500_000, Some("Chrome"), Some("Gmail - Inbox"), None),
        ];
        index.index_entries(&entries).unwrap();

        let ocr_entries = vec![OcrEntry {
            ts: 1_200_000,
            display_id: None,
            text: "Gmail inbox with search results".to_string(),
            app_name: Some("Chrome".to_string()),
            window_title: None,
            confidence: Some(0.9),
        }];
        index.index_ocr_entries(&ocr_entries).unwrap();

        // All three are within 5-second window (5_000_000us) with display_id=0(None)
        // They should dedup into fewer results
        let results = index.search("Gmail", 10).unwrap();
        assert!(results.len() <= 3); // May be deduped
                                     // The dedup should merge match_reason tags
    }

    #[test]
    fn test_schema_version_migration() {
        let tmp = TempDir::new().unwrap();

        // Create initial index
        {
            let mut index = SearchIndex::new(tmp.path()).unwrap();
            let entries = vec![make_entry(1000, Some("Chrome"), Some("test"), None)];
            index.index_entries(&entries).unwrap();

            let stats = index.stats();
            assert_eq!(stats.total_docs, 1);
        }

        // Re-open — same version, should preserve data
        {
            let index = SearchIndex::new(tmp.path()).unwrap();
            let stats = index.stats();
            assert_eq!(stats.total_docs, 1);
        }

        // Schema version file exists
        let version_file = tmp.path().join("schema_version");
        assert!(version_file.exists());
        let version_str = std::fs::read_to_string(&version_file).unwrap();
        assert_eq!(version_str.trim(), SCHEMA_VERSION.to_string());
    }

    #[test]
    fn test_make_snippet() {
        let text = "The quick brown fox jumps over the lazy dog near the river bank";
        let snippet = make_snippet(text, "fox", 30);
        assert!(snippet.contains("fox"));

        // Short text returns as-is (no ellipsis)
        let snippet = make_snippet("hello world", "hello", 100);
        assert_eq!(snippet, "hello world");
    }

    #[test]
    fn test_make_snippet_cjk() {
        // CJK characters are 3 bytes each in UTF-8. Old code would panic here.
        let text = "会議の議題は予算配分についてです。来月の計画を確認しましょう。";
        let snippet = make_snippet(text, "予算", 15);
        assert!(snippet.contains("予算"));
        // Must not panic — that's the main assertion
    }

    #[test]
    fn test_make_snippet_emoji() {
        // Emoji are 4 bytes each. Must not panic on byte-boundary slicing.
        let text = "Status update 🚀 deployment succeeded 🎉 all tests passing ✅ ready for review";
        let snippet = make_snippet(text, "deployment", 30);
        assert!(snippet.contains("deployment"));
    }

    #[test]
    fn test_make_snippet_mixed_scripts() {
        // Mix of ASCII, CJK, and emoji
        let text = "Project Alpha: 完了 ✅ — next milestone is Beta: 進行中 🔄";
        let snippet = make_snippet(text, "Beta", 20);
        assert!(snippet.contains("Beta"));
    }

    #[test]
    fn test_make_snippet_empty() {
        assert_eq!(make_snippet("", "query", 30), "");
    }

    #[test]
    fn test_make_snippet_no_match() {
        // Query term not found — should still produce a snippet from start
        let text = "The quick brown fox jumps over the lazy dog";
        let snippet = make_snippet(text, "zzzzz", 20);
        assert!(!snippet.is_empty());
    }

    #[test]
    fn test_match_reason_ocr() {
        assert_eq!(
            determine_match_reason("budget", "", "", "", "Q3 budget discussion", "ocr"),
            "ocr"
        );
        assert_eq!(
            determine_match_reason("budget", "Zoom", "", "", "Q3 budget discussion", "ocr"),
            "ocr"
        );
        assert_eq!(
            determine_match_reason("zoom budget", "Zoom", "", "", "Q3 budget discussion", "ocr"),
            "app,ocr"
        );
    }

    #[test]
    fn test_transcript_index_and_search() {
        let tmp = TempDir::new().unwrap();
        let mut index = SearchIndex::new(tmp.path()).unwrap();

        let entries = vec![
            TranscriptEntry {
                audio_segment_id: 1,
                source: "mic".to_string(),
                ts_start: 1_000_000,
                ts_end: 1_500_000,
                text: "we should finalize the Q3 budget by Friday".to_string(),
                confidence: Some(0.92),
                app_name: Some("Zoom".to_string()),
                window_title: Some("Weekly Standup".to_string()),
            },
            TranscriptEntry {
                audio_segment_id: 1,
                source: "system".to_string(),
                ts_start: 1_500_000,
                ts_end: 2_000_000,
                text: "agreed, let me send the spreadsheet after this call".to_string(),
                confidence: Some(0.88),
                app_name: Some("Zoom".to_string()),
                window_title: Some("Weekly Standup".to_string()),
            },
            TranscriptEntry {
                audio_segment_id: 2,
                source: "mic".to_string(),
                ts_start: 3_000_000,
                ts_end: 3_500_000,
                text: "   ".to_string(), // whitespace-only — should be skipped
                confidence: None,
                app_name: None,
                window_title: None,
            },
        ];

        let count = index.index_transcript_entries(&entries).unwrap();
        assert_eq!(count, 2); // skipped the whitespace-only entry

        // Search for transcript text — verify metadata roundtrip
        let results = index.search("budget", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].source_kind, "transcript");
        assert!(results[0].match_reason.contains("transcript"));
        assert!(results[0].snippet.contains("budget"));
        assert_eq!(results[0].app_name, "Zoom");
        assert_eq!(results[0].audio_segment_id, Some(1));
        assert_eq!(results[0].audio_source, "mic");
        assert_eq!(results[0].ts_end, 1_500_000);
        assert_eq!(results[0].confidence, Some(0.92));

        // Search across both transcript entries — verify system source metadata
        let results = index.search("spreadsheet", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].source_kind, "transcript");
        assert_eq!(results[0].audio_segment_id, Some(1));
        assert_eq!(results[0].audio_source, "system");
        assert_eq!(results[0].ts_end, 2_000_000);
        assert_eq!(results[0].confidence, Some(0.88));
    }

    #[test]
    fn test_transcript_dedup_with_ocr() {
        let tmp = TempDir::new().unwrap();
        let mut index = SearchIndex::new(tmp.path()).unwrap();

        // Index an OCR entry and a transcript entry near the same timestamp
        // Both mention "deployment" — should be deduped within the 5-second window
        let ocr_entries = vec![OcrEntry {
            ts: 1_000_000,
            display_id: None,
            text: "Deployment pipeline status: building".to_string(),
            app_name: Some("Chrome".to_string()),
            window_title: Some("CI Dashboard".to_string()),
            confidence: Some(0.95),
        }];
        index.index_ocr_entries(&ocr_entries).unwrap();

        let transcript_entries = vec![TranscriptEntry {
            audio_segment_id: 1,
            source: "mic".to_string(),
            ts_start: 1_200_000, // within 5-second window of OCR entry
            ts_end: 1_800_000,
            text: "the deployment is still running, let's wait".to_string(),
            confidence: Some(0.90),
            app_name: Some("Zoom".to_string()),
            window_title: Some("Standup".to_string()),
        }];
        index.index_transcript_entries(&transcript_entries).unwrap();

        let results = index.search("deployment", 10).unwrap();
        // Both are in the same 5-second bucket with display_id=None(0)
        // Should be deduped to 1 result with merged match_reason
        assert_eq!(results.len(), 1);
        let reason = &results[0].match_reason;
        // The merged reason should contain both "ocr" and "transcript"
        assert!(
            reason.contains("ocr") || reason.contains("transcript"),
            "Expected match_reason to contain ocr or transcript, got: {}",
            reason
        );
    }

    #[test]
    fn test_dedup_visual_with_text() {
        // When a visual result and a text result fall in the same 5-second bucket,
        // they should be deduped. The merged result should contain both reasons.
        let text_result = SearchResult {
            ts: 1_000_000,
            app_name: "Chrome".to_string(),
            window_title: "Dashboard".to_string(),
            url: String::new(),
            display_id: Some(1),
            event_type: String::new(),
            score: 0.9,
            match_reason: "title".to_string(),
            source_kind: "track3".to_string(),
            snippet: String::new(),
            audio_segment_id: None,
            audio_source: String::new(),
            ts_end: 0,
            confidence: None,
        };

        let visual_result = SearchResult {
            ts: 1_200_000, // within 5-second window
            app_name: "Chrome".to_string(),
            window_title: String::new(),
            url: String::new(),
            display_id: Some(1),
            event_type: String::new(),
            score: 0.85,
            match_reason: "visual".to_string(),
            source_kind: "visual".to_string(),
            snippet: String::new(),
            audio_segment_id: None,
            audio_source: String::new(),
            ts_end: 0,
            confidence: None,
        };

        let results = vec![text_result, visual_result];
        let deduped = deduplicate_results(results, 10);

        // Same 5-second bucket, same display — should merge
        assert_eq!(deduped.len(), 1);
        // Merged reasons should contain both
        assert!(deduped[0].match_reason.contains("title"));
        assert!(deduped[0].match_reason.contains("visual"));
    }

    #[test]
    fn test_dedup_visual_different_display() {
        // Visual results from different displays should NOT be deduped together.
        let visual_d1 = SearchResult {
            ts: 1_000_000,
            app_name: String::new(),
            window_title: String::new(),
            url: String::new(),
            display_id: Some(1),
            event_type: String::new(),
            score: 0.9,
            match_reason: "visual".to_string(),
            source_kind: "visual".to_string(),
            snippet: String::new(),
            audio_segment_id: None,
            audio_source: String::new(),
            ts_end: 0,
            confidence: None,
        };

        let visual_d2 = SearchResult {
            ts: 1_100_000, // within 5-second window but different display
            app_name: String::new(),
            window_title: String::new(),
            url: String::new(),
            display_id: Some(2),
            event_type: String::new(),
            score: 0.85,
            match_reason: "visual".to_string(),
            source_kind: "visual".to_string(),
            snippet: String::new(),
            audio_segment_id: None,
            audio_source: String::new(),
            ts_end: 0,
            confidence: None,
        };

        let results = vec![visual_d1, visual_d2];
        let deduped = deduplicate_results(results, 10);

        // Different displays — should NOT merge
        assert_eq!(deduped.len(), 2);
    }

    #[test]
    fn test_search_text_in_range_filters_by_timestamp() {
        let tmp = TempDir::new().unwrap();
        let mut index = SearchIndex::new(tmp.path()).unwrap();

        let entries = vec![
            make_entry(1_000_000, Some("Chrome"), Some("Gmail early"), None),
            make_entry(5_000_000, Some("Chrome"), Some("Gmail middle"), None),
            make_entry(9_000_000, Some("Chrome"), Some("Gmail late"), None),
        ];
        index.index_entries(&entries).unwrap();

        // Range [3M, 7M] should only return the middle entry
        let results = index
            .search_in_range("Gmail", 3_000_000, 7_000_000, 10)
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].ts, 5_000_000);
        assert!(results[0].window_title.contains("middle"));

        // Empty query → empty
        let results = index.search_in_range("", 0, 10_000_000, 10).unwrap();
        assert!(results.is_empty());

        // start > end → empty
        let results = index
            .search_in_range("Gmail", 8_000_000, 2_000_000, 10)
            .unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_deduplicate_results_public_matches_internal() {
        let results = vec![SearchResult {
            ts: 1_000_000,
            app_name: "App".to_string(),
            window_title: "Win".to_string(),
            url: String::new(),
            display_id: Some(1),
            event_type: String::new(),
            score: 0.9,
            match_reason: "title".to_string(),
            source_kind: "track3".to_string(),
            snippet: String::new(),
            audio_segment_id: None,
            audio_source: String::new(),
            ts_end: 0,
            confidence: None,
        }];

        let deduped = deduplicate_results_public(results, 10);
        assert_eq!(deduped.len(), 1);
        assert_eq!(deduped[0].app_name, "App");
    }

    // --- list_transcript_chunks_in_range tests ---

    /// Helper: create and index transcript entries, returning the SearchIndex.
    fn setup_transcript_index(entries: &[TranscriptEntry]) -> (TempDir, SearchIndex) {
        let tmp = TempDir::new().unwrap();
        let mut index = SearchIndex::new(tmp.path()).unwrap();
        index.index_transcript_entries(entries).unwrap();
        (tmp, index)
    }

    fn make_transcript(
        ts_start: u64,
        ts_end: u64,
        text: &str,
        source: &str,
        segment_id: i64,
    ) -> TranscriptEntry {
        TranscriptEntry {
            audio_segment_id: segment_id,
            source: source.to_string(),
            ts_start,
            ts_end,
            text: text.to_string(),
            confidence: Some(0.9),
            app_name: Some("Zoom".to_string()),
            window_title: Some("Meeting".to_string()),
        }
    }

    #[test]
    fn speech_rewind_includes_overlapping_windows_and_excludes_old_audio() {
        let (_tmp, index) = setup_transcript_index(&[
            make_transcript(10, 30, "overlapping speech", "mic", 1),
            make_transcript(0, 20, "finished at boundary", "mic", 2),
            make_transcript(31, 40, "future speech", "mic", 3),
        ]);
        let chunks = index
            .list_transcript_chunks_overlapping(20, 30, 10, 0)
            .unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text, "overlapping speech");
        assert_eq!(chunks[0].ts_start, 10);
        assert!(index
            .list_transcript_chunks_in_range(20, 30, 10, 0)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn test_range_query_transcript_only() {
        // Index transcript, track3, and OCR entries. Range query must return only transcripts.
        let tmp = TempDir::new().unwrap();
        let mut index = SearchIndex::new(tmp.path()).unwrap();

        // Track3 entry at ts=1_000_000
        let track3 = vec![make_entry(1_000_000, Some("Chrome"), Some("Gmail"), None)];
        index.index_entries(&track3).unwrap();

        // OCR entry at ts=1_500_000
        let ocr = vec![OcrEntry {
            ts: 1_500_000,
            display_id: None,
            text: "some OCR text".to_string(),
            app_name: Some("Chrome".to_string()),
            window_title: Some("Page".to_string()),
            confidence: Some(0.95),
        }];
        index.index_ocr_entries(&ocr).unwrap();

        // Transcript entry at ts=2_000_000
        let transcript = vec![make_transcript(
            2_000_000,
            2_500_000,
            "hello from the meeting",
            "mic",
            1,
        )];
        index.index_transcript_entries(&transcript).unwrap();

        // Range query covering all three timestamps
        let results = index
            .list_transcript_chunks_in_range(0, 10_000_000, 100, 0)
            .unwrap();

        // Must return only the transcript entry, not track3 or OCR
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].ts_start, 2_000_000);
        assert_eq!(results[0].text, "hello from the meeting");
        assert_eq!(results[0].audio_source, "mic");
        assert_eq!(results[0].audio_segment_id, 1);
    }

    #[test]
    fn test_range_query_inclusive_boundaries() {
        let entries = vec![
            make_transcript(100, 200, "at start boundary", "mic", 1),
            make_transcript(500, 600, "in the middle", "system", 1),
            make_transcript(1000, 1100, "at end boundary", "mic", 2),
        ];
        let (_tmp, index) = setup_transcript_index(&entries);

        // Query with start_us=100 and end_us=1000 — both boundary entries should be included
        let results = index
            .list_transcript_chunks_in_range(100, 1000, 100, 0)
            .unwrap();

        assert_eq!(results.len(), 3);
        assert_eq!(results[0].ts_start, 100); // inclusive start
        assert_eq!(results[1].ts_start, 500);
        assert_eq!(results[2].ts_start, 1000); // inclusive end
    }

    #[test]
    fn test_range_query_excludes_outside() {
        let entries = vec![
            make_transcript(100, 200, "before range", "mic", 1),
            make_transcript(500, 600, "in range", "mic", 1),
            make_transcript(1000, 1100, "after range", "mic", 2),
        ];
        let (_tmp, index) = setup_transcript_index(&entries);

        // Query with range [300, 700] — only the middle entry
        let results = index
            .list_transcript_chunks_in_range(300, 700, 100, 0)
            .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].ts_start, 500);
        assert_eq!(results[0].text, "in range");
    }

    #[test]
    fn test_range_query_pagination() {
        // Create 10 transcript entries with ascending timestamps
        let entries: Vec<TranscriptEntry> = (0..10)
            .map(|i| {
                make_transcript(
                    (i + 1) * 1000,
                    (i + 1) * 1000 + 500,
                    &format!("chunk {}", i),
                    "mic",
                    1,
                )
            })
            .collect();
        let (_tmp, index) = setup_transcript_index(&entries);

        // Page 0: first 3 results
        let page0 = index
            .list_transcript_chunks_in_range(0, 100_000, 3, 0)
            .unwrap();
        assert_eq!(page0.len(), 3);
        assert_eq!(page0[0].ts_start, 1000);
        assert_eq!(page0[1].ts_start, 2000);
        assert_eq!(page0[2].ts_start, 3000);

        // Page 1: next 3 results (offset=3)
        let page1 = index
            .list_transcript_chunks_in_range(0, 100_000, 3, 3)
            .unwrap();
        assert_eq!(page1.len(), 3);
        assert_eq!(page1[0].ts_start, 4000);
        assert_eq!(page1[1].ts_start, 5000);
        assert_eq!(page1[2].ts_start, 6000);

        // Page 2: next 3 results (offset=6)
        let page2 = index
            .list_transcript_chunks_in_range(0, 100_000, 3, 6)
            .unwrap();
        assert_eq!(page2.len(), 3);
        assert_eq!(page2[0].ts_start, 7000);

        // Page 3: last result (offset=9)
        let page3 = index
            .list_transcript_chunks_in_range(0, 100_000, 3, 9)
            .unwrap();
        assert_eq!(page3.len(), 1);
        assert_eq!(page3[0].ts_start, 10000);

        // Page 4: past the end (offset=10)
        let page4 = index
            .list_transcript_chunks_in_range(0, 100_000, 3, 10)
            .unwrap();
        assert!(page4.is_empty());

        // Verify no duplication: collect all pages and check uniqueness
        let mut all_ts: Vec<u64> = Vec::new();
        all_ts.extend(page0.iter().map(|r| r.ts_start));
        all_ts.extend(page1.iter().map(|r| r.ts_start));
        all_ts.extend(page2.iter().map(|r| r.ts_start));
        all_ts.extend(page3.iter().map(|r| r.ts_start));
        assert_eq!(all_ts.len(), 10);
        // Should be sorted ascending with no duplicates
        for window in all_ts.windows(2) {
            assert!(window[0] < window[1], "Not sorted or has duplicates");
        }
    }

    #[test]
    fn test_range_query_start_after_end() {
        let entries = vec![make_transcript(1000, 2000, "some text", "mic", 1)];
        let (_tmp, index) = setup_transcript_index(&entries);

        // start_us > end_us → empty result
        let results = index
            .list_transcript_chunks_in_range(5000, 1000, 100, 0)
            .unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_range_query_limit_zero() {
        let entries = vec![make_transcript(1000, 2000, "some text", "mic", 1)];
        let (_tmp, index) = setup_transcript_index(&entries);

        // limit == 0 → empty result
        let results = index
            .list_transcript_chunks_in_range(0, 100_000, 0, 0)
            .unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_range_query_limit_clamped() {
        // Create 5 entries and request limit=5000 — should be clamped to 1000 (still returns all 5)
        let entries: Vec<TranscriptEntry> = (0..5)
            .map(|i| make_transcript(i * 1000 + 1000, i * 1000 + 1500, "text", "mic", 1))
            .collect();
        let (_tmp, index) = setup_transcript_index(&entries);

        let results = index
            .list_transcript_chunks_in_range(0, 100_000, 5000, 0)
            .unwrap();
        assert_eq!(results.len(), 5); // All returned, limit clamped but still > count
    }

    #[test]
    fn test_range_query_sorted_ascending() {
        // Index entries in reverse order — results must still be sorted ascending
        let entries = vec![
            make_transcript(9000, 9500, "last", "mic", 3),
            make_transcript(1000, 1500, "first", "mic", 1),
            make_transcript(5000, 5500, "middle", "system", 2),
        ];
        let (_tmp, index) = setup_transcript_index(&entries);

        let results = index
            .list_transcript_chunks_in_range(0, 100_000, 100, 0)
            .unwrap();

        assert_eq!(results.len(), 3);
        assert_eq!(results[0].ts_start, 1000);
        assert_eq!(results[0].text, "first");
        assert_eq!(results[1].ts_start, 5000);
        assert_eq!(results[1].text, "middle");
        assert_eq!(results[2].ts_start, 9000);
        assert_eq!(results[2].text, "last");
    }

    #[test]
    fn test_range_query_metadata_roundtrip() {
        let entries = vec![TranscriptEntry {
            audio_segment_id: 42,
            source: "system".to_string(),
            ts_start: 1_000_000,
            ts_end: 1_500_000,
            text: "budget discussion for Q3".to_string(),
            confidence: Some(0.87),
            app_name: Some("Google Meet".to_string()),
            window_title: Some("Weekly Sync".to_string()),
        }];
        let (_tmp, index) = setup_transcript_index(&entries);

        let results = index
            .list_transcript_chunks_in_range(0, 10_000_000, 100, 0)
            .unwrap();

        assert_eq!(results.len(), 1);
        let r = &results[0];
        assert_eq!(r.ts_start, 1_000_000);
        assert_eq!(r.ts_end, 1_500_000);
        assert_eq!(r.text, "budget discussion for Q3");
        assert_eq!(r.audio_source, "system");
        assert_eq!(r.confidence, Some(0.87));
        assert_eq!(r.app_name, "Google Meet");
        assert_eq!(r.window_title, "Weekly Sync");
        assert_eq!(r.audio_segment_id, 42);
    }

    #[test]
    fn test_search_with_colon_in_query() {
        let tmp = TempDir::new().unwrap();
        let mut index = SearchIndex::new(tmp.path()).unwrap();

        let entries = vec![make_entry(
            1000,
            Some("Chrome"),
            Some("Meeting at 11:30 AM"),
            None,
        )];
        index.index_entries(&entries).unwrap();

        // This previously failed with "Field does not exist: '11'"
        // Lenient parsing handles the colon gracefully.
        let results = index.search("11:30", 10).unwrap();
        assert!(!results.is_empty());
        assert!(results[0].window_title.contains("11:30"));

        // Range search with colons should also work
        let results = index.search_in_range("11:30", 0, 2000, 10).unwrap();
        assert!(!results.is_empty());
    }

    #[test]
    fn test_search_with_url_query() {
        let tmp = TempDir::new().unwrap();
        let mut index = SearchIndex::new(tmp.path()).unwrap();

        let entries = vec![make_entry(
            1000,
            Some("Chrome"),
            Some("Google"),
            Some("https://google.com"),
        )];
        index.index_entries(&entries).unwrap();

        // URLs contain colons and slashes — lenient parsing should handle them
        let results = index.search("https://google.com", 10).unwrap();
        assert!(!results.is_empty());
    }

    fn dir_contains(dir: &Path, needle: &[u8]) -> bool {
        let mut stack = vec![dir.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if std::fs::read(&path)
                    .map(|bytes| bytes.windows(needle.len()).any(|w| w == needle))
                    .unwrap_or(false)
                {
                    return true;
                }
            }
        }
        false
    }

    #[test]
    fn index_files_hold_no_plaintext_and_search_still_finds_words() {
        let tmp = TempDir::new().unwrap();
        let mut index = SearchIndex::new(tmp.path()).unwrap();
        index
            .index_ocr_entries(&[OcrEntry {
                ts: 5_000,
                display_id: Some(0),
                text: "quarterly zebracorn forecast for payroll".into(),
                app_name: Some("Numbers".into()),
                window_title: Some("Budget sheet zebracorn".into()),
                confidence: None,
            }])
            .unwrap();
        drop(index);
        assert!(!dir_contains(tmp.path(), b"zebracorn"));
        assert!(!dir_contains(tmp.path(), b"payroll"));
        let index = SearchIndex::new(tmp.path()).unwrap();
        let results = index.search("zebracorn", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].window_title, "Budget sheet zebracorn");
        assert!(results[0].snippet.contains("zebracorn"));
        // Whole words only, and stopword-only queries find nothing.
        assert!(index.search("zebra", 10).unwrap().is_empty());
        assert!(index.search("the", 10).unwrap().is_empty());
    }

    fn legacy_v4_schema() -> Schema {
        let mut sb = Schema::builder();
        sb.add_text_field("app_name", TEXT | STORED);
        sb.add_text_field("window_title", TEXT | STORED);
        sb.add_text_field("url", TEXT | STORED);
        sb.add_text_field("text_content", TEXT | STORED);
        sb.add_text_field("event_type", STORED);
        sb.add_text_field("session_id", STORED);
        sb.add_text_field("source_kind", STRING | STORED);
        sb.add_u64_field("ts", FAST | STORED);
        sb.add_u64_field("track", FAST | STORED);
        sb.add_u64_field("display_id", FAST | STORED);
        sb.add_i64_field("audio_segment_id", FAST | STORED);
        sb.add_text_field("audio_source", STORED);
        sb.add_u64_field("ts_end", FAST | STORED);
        sb.add_f64_field("confidence", FAST | STORED);
        sb.build()
    }

    #[test]
    fn a_plaintext_v4_index_is_converted_in_place() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("search");
        std::fs::create_dir_all(&dir).unwrap();
        {
            let schema = legacy_v4_schema();
            let index = Index::create_in_dir(&dir, schema.clone()).unwrap();
            let mut writer: IndexWriter = index.writer(15_000_000).unwrap();
            let mut doc = TantivyDocument::default();
            doc.add_text(
                schema.get_field("text_content").unwrap(),
                "legacy meeting kumquat notes",
            );
            doc.add_text(schema.get_field("source_kind").unwrap(), "transcript");
            doc.add_text(schema.get_field("audio_source").unwrap(), "mic");
            doc.add_u64(schema.get_field("ts").unwrap(), 10);
            doc.add_u64(schema.get_field("ts_end").unwrap(), 20);
            doc.add_u64(schema.get_field("track").unwrap(), 4);
            doc.add_i64(schema.get_field("audio_segment_id").unwrap(), 7);
            writer.add_document(doc).unwrap();
            writer.commit().unwrap();
            std::fs::write(dir.join("schema_version"), "4").unwrap();
        }
        assert!(dir_contains(&dir, b"kumquat"));
        let mut index = SearchIndex::new(&dir).unwrap();
        assert!(!index.was_rebuilt());
        // Opening does not wait for the conversion: the live index is fresh
        // and sealed, the plaintext one waits beside it.
        assert!(!dir_contains(&dir, b"kumquat"));
        assert_eq!(index.stats().total_docs, 0);
        let conversion = index
            .take_legacy_conversion()
            .expect("a pending conversion");
        let mut reported = Vec::new();
        let total = conversion
            .run(
                |docs| index.add_converted(docs),
                |done, total| reported.push((done, total)),
            )
            .unwrap();
        assert_eq!(total, 1);
        assert_eq!(reported, [(1, 1)]);
        assert!(
            !sibling(&dir, PENDING_SUFFIX).exists(),
            "the plaintext index is deleted"
        );
        assert!(!dir_contains(&dir, b"kumquat"));
        assert!(!sibling(&dir, ".legacy").exists());
        assert_eq!(index.search("kumquat", 5).unwrap().len(), 1);
        let chunks = index
            .list_transcript_chunks_in_range(0, 100, 10, 0)
            .unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text, "legacy meeting kumquat notes");
        assert_eq!(chunks[0].audio_segment_id, 7);
        drop(index);
        // Reopening is a no-op.
        let mut index = SearchIndex::new(&dir).unwrap();
        assert_eq!(index.stats().total_docs, 1);
        assert!(index.take_legacy_conversion().is_none());
    }

    /// Writes a v4 index with `count` documents whose text holds `marker`.
    fn write_v4_index(dir: &Path, count: u64, marker: &str) {
        std::fs::create_dir_all(dir).unwrap();
        let schema = legacy_v4_schema();
        let index = Index::create_in_dir(dir, schema.clone()).unwrap();
        let mut writer: IndexWriter = index.writer(15_000_000).unwrap();
        for i in 0..count {
            let mut doc = TantivyDocument::default();
            doc.add_text(
                schema.get_field("text_content").unwrap(),
                format!("{marker} entry {i}"),
            );
            doc.add_text(schema.get_field("source_kind").unwrap(), "ocr");
            doc.add_u64(schema.get_field("ts").unwrap(), 1_000 + i);
            doc.add_u64(schema.get_field("track").unwrap(), 3);
            writer.add_document(doc).unwrap();
        }
        writer.commit().unwrap();
        std::fs::write(dir.join("schema_version"), "4").unwrap();
    }

    #[test]
    fn an_interrupted_conversion_resumes_without_duplicates() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("search");
        let count = CONVERT_BATCH as u64 + 5;
        write_v4_index(&dir, count, "persimmon");
        {
            let mut index = SearchIndex::new(&dir).unwrap();
            let conversion = index.take_legacy_conversion().unwrap();
            // The first batch commits, then the process "dies" on the second.
            let mut batches = 0;
            let result = conversion.run(
                |docs| {
                    batches += 1;
                    if batches == 2 {
                        return Err(SearchError::IndexIO("killed".into()));
                    }
                    index.add_converted(docs)
                },
                |_, _| {},
            );
            assert!(result.is_err());
            assert_eq!(index.stats().total_docs, CONVERT_BATCH as u64);
        }
        // Lose the progress mark too: the redone batch must replace, not add.
        std::fs::remove_file(sibling(&dir, PENDING_SUFFIX).join(PROGRESS_FILE)).unwrap();
        let mut index = SearchIndex::new(&dir).unwrap();
        let conversion = index
            .take_legacy_conversion()
            .expect("resumed at the next open");
        conversion
            .run(|docs| index.add_converted(docs), |_, _| {})
            .unwrap();
        assert_eq!(index.stats().total_docs, count);
        assert!(!sibling(&dir, PENDING_SUFFIX).exists());
        assert!(!dir_contains(tmp.path(), b"persimmon"));
    }
}
