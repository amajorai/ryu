//! Content sealing for `spaces.db` and the Spaces blob store.
//!
//! * **Columns.** Free text in `spaces.db` (document titles and bodies, chunk
//!   text, Space names and descriptions, link titles, version titles, bodies and
//!   payloads, import names and messages) is sealed per value: `encb:v1:` for
//!   TEXT, `RYU-CB01` for BLOB, under the `spaces.db` content key, bound to the
//!   row's explicit TEXT id (`ContentContext::for_id("<table>.<column>", id)`).
//!   The store's SQL reaches the cipher through application-defined functions
//!   registered on every connection ([`register_sql_functions`]):
//!   `ryu_seal(purpose, id, value)`, `ryu_open(purpose, id, value)` (errors when
//!   a sealed value does not open: get-by-id), `ryu_open_soft(...)` (NULL and a
//!   counted, logged skip: lists, search, export), `ryu_seal_blob` /
//!   `ryu_open_blob`, `ryu_bi(field, value)` (blind equality token) and
//!   `ryu_terms(purpose, id, value)` (blind term tokens for `spaces_terms`).
//!   Copies to a new id therefore re-seal inside the statement
//!   (`ryu_seal(p, new_id, ryu_open(p, old_id, col))`).
//! * **Blind equality columns** (`documents.title_bi`,
//!   `document_links.dst_title_bi`, `spaces.name_bi`) hold
//!   `bi1:` tokens of the case-folded value, one key per field. Graph entities
//!   are a derived index and hold only their blind token.
//! * **Blobs** (`files/blobs/<aa>/<sha256>`) are write-once `RYU-SF01` files
//!   under the `spaces-blobs` content key, named by the plaintext SHA-256 (also
//!   bound as the AAD id); readers verify the digest of the decrypted bytes.
//!   Legacy plaintext blobs still read and are sealed in place by the
//!   background migration.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::functions::{Context as FnContext, FunctionFlags};
use rusqlite::types::ValueRef;
use rusqlite::Connection;
use ryu_crypto::content::{is_content_seal_error, ContentCipher, ContentContext};
use ryu_crypto::content_sqlite::{ColumnPlan, KeyKind};
use ryu_crypto::sealed_file::{SealInPlace, SealedFileReader, SealedFileWriter};
use ryu_crypto::BlindIndex;
use sha2::{Digest, Sha256};

/// The registered content store of the Spaces database.
pub const SPACES_STORE: &str = "spaces.db";
/// The registered content store of the Spaces blob files.
pub const BLOB_STORE: &str = "spaces-blobs";

/// Blind-index field of document titles.
pub(crate) const FIELD_DOC_TITLE: &str = "documents.title";
/// Blind-index field of wiki-link target titles.
pub(crate) const FIELD_LINK_TITLE: &str = "document_links.dst_title";
/// Blind-index field of Space names.
pub(crate) const FIELD_SPACE_NAME: &str = "spaces.name";
/// Blind-index field of graph entities.
pub(crate) const FIELD_ENTITY: &str = "graph.entity";
/// Keyed content address of document history snapshots
/// (`document_version_blobs.hash`, `document_versions.blob_hash`).
pub(crate) const FIELD_HISTORY_HASH: &str = "document_version_blobs.hash";

/// The `(table, column)` pairs sealed as `encb:v1:` text, each bound to the
/// table's TEXT primary key (`id`).
pub(crate) const SEALED_TEXT_COLUMNS: [(&str, &str); 13] = [
    ("spaces", "name"),
    ("spaces", "description"),
    ("documents", "title"),
    ("documents", "source"),
    ("chunks", "content"),
    ("chunks", "metadata"),
    ("document_links", "dst_title"),
    ("document_versions", "title"),
    ("document_versions", "source"),
    ("document_versions", "label"),
    ("space_imports", "source_name"),
    ("space_imports", "message"),
    ("space_imports", "result_documents"),
];

/// The keys one Spaces store seals with.
#[derive(Clone, Debug)]
pub struct SpacesKeys {
    pub(crate) cipher: ContentCipher,
    pub(crate) blob_cipher: ContentCipher,
    pub(crate) doc_title: BlindIndex,
    pub(crate) link_title: BlindIndex,
    pub(crate) space_name: BlindIndex,
    pub(crate) entity: BlindIndex,
    pub(crate) terms: BlindIndex,
    pub(crate) history_hash: BlindIndex,
}

impl SpacesKeys {
    /// The keys of a process that holds the master key (Core). Fails closed.
    pub fn resolve() -> Result<Self> {
        let index = |field: &str| {
            ryu_crypto::blind_index(SPACES_STORE, field)
                .with_context(|| format!("resolving the Spaces blind index {field}"))
        };
        Ok(Self {
            cipher: ryu_crypto::content_cipher(SPACES_STORE)
                .context("resolving the Spaces content key")?,
            blob_cipher: ryu_crypto::content_cipher(BLOB_STORE)
                .context("resolving the Spaces blob key")?,
            doc_title: index(FIELD_DOC_TITLE)?,
            link_title: index(FIELD_LINK_TITLE)?,
            space_name: index(FIELD_SPACE_NAME)?,
            entity: index(FIELD_ENTITY)?,
            terms: index(ryu_crypto::blind_index::TERMS_FIELD)?,
            history_hash: index(FIELD_HISTORY_HASH)?,
        })
    }

    /// The keys under an explicit root (tests).
    pub fn from_root(root: &[u8; 32]) -> Self {
        let index = |field: &str| BlindIndex::from_root(root, SPACES_STORE, field);
        Self {
            cipher: ContentCipher::from_root(root, SPACES_STORE),
            blob_cipher: ContentCipher::from_root(root, BLOB_STORE),
            doc_title: index(FIELD_DOC_TITLE),
            link_title: index(FIELD_LINK_TITLE),
            space_name: index(FIELD_SPACE_NAME),
            entity: index(FIELD_ENTITY),
            terms: index(ryu_crypto::blind_index::TERMS_FIELD),
            history_hash: index(FIELD_HISTORY_HASH),
        }
    }

    /// The keys under `root` that still open values sealed under `retired`
    /// roots (tests of a key adoption). Blind indexes use `root` only, as in
    /// production.
    pub fn from_root_with_retired(root: &[u8; 32], retired: &[[u8; 32]]) -> Self {
        let mut keys = Self::from_root(root);
        keys.cipher = keys.cipher.with_retired_roots(retired);
        keys.blob_cipher = keys.blob_cipher.with_retired_roots(retired);
        keys
    }

    /// The blind index of a field name used in SQL.
    fn blind(&self, field: &str) -> Option<&BlindIndex> {
        match field {
            FIELD_DOC_TITLE => Some(&self.doc_title),
            FIELD_LINK_TITLE => Some(&self.link_title),
            FIELD_SPACE_NAME => Some(&self.space_name),
            FIELD_ENTITY => Some(&self.entity),
            _ => None,
        }
    }

    /// The equality token of a graph entity (already lowercase-normalized by
    /// the extractor, so no further folding).
    pub(crate) fn entity_token(&self, entity: &str) -> String {
        self.entity.token(entity)
    }

    /// The keyed content address of a serialized history snapshot: 32 hex of
    /// `HMAC-SHA256(K_bi(spaces.db, document_version_blobs.hash), raw)`.
    /// Deduplicates within one key generation; after a key adoption new
    /// snapshots stop deduplicating against old ones, which is harmless.
    pub(crate) fn history_hash(&self, raw: &[u8]) -> Result<String> {
        let text = std::str::from_utf8(raw).context("history snapshots are UTF-8 JSON")?;
        // `term_token` is the bare 32-hex HMAC of its input, no normalization.
        Ok(self.history_hash.term_token(text))
    }

    /// The `MATCH` expression of a body search, or `None` (no indexable term).
    pub(crate) fn terms_query(&self, query: &str) -> Option<String> {
        self.terms.fts_query(query)
    }
}

/// Health of the store's sealing: unreadable rows, the background migration and
/// the blob sweep.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct SealStatus {
    /// Sealed values that did not open and were skipped by a list, search or
    /// export (`spaces.db.unreadable_rows`).
    pub unreadable_rows: u64,
    /// Whether the store's recorded key matches a key this process holds.
    pub writable: bool,
    /// `pending`, `sealing`, `compacting`, `sealed` or `error: ...`.
    pub migration: String,
    /// Blob files sealed so far by the sweep.
    pub blobs_sealed: u64,
    /// Blob files the sweep found (sealed or not).
    pub blobs_total: u64,
    /// Why the blob sweep stopped early (for example low disk space), if it did.
    pub blobs_pending: Option<String>,
}

/// Shared sealing state of one store: keys, writability, counters.
#[derive(Clone, Debug)]
pub(crate) struct SealState {
    pub(crate) keys: Arc<SpacesKeys>,
    pub(crate) writable: Arc<AtomicBool>,
    pub(crate) unreadable: Arc<AtomicU64>,
    pub(crate) status: Arc<StdMutex<SealStatus>>,
}

impl SealState {
    pub(crate) fn new(keys: SpacesKeys, writable: bool) -> Self {
        Self {
            keys: Arc::new(keys),
            writable: Arc::new(AtomicBool::new(writable)),
            unreadable: Arc::new(AtomicU64::new(0)),
            status: Arc::new(StdMutex::new(SealStatus {
                writable,
                migration: "pending".to_owned(),
                ..SealStatus::default()
            })),
        }
    }

    pub(crate) fn snapshot(&self) -> SealStatus {
        let mut status = self
            .status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_default();
        status.unreadable_rows = self.unreadable.load(Ordering::Relaxed);
        status.writable = self.writable.load(Ordering::Relaxed);
        status
    }

    pub(crate) fn set_migration(&self, state: impl Into<String>) {
        if let Ok(mut status) = self.status.lock() {
            status.migration = state.into();
        }
    }

    pub(crate) fn note_unreadable(&self, what: &str) {
        let total = self.unreadable.fetch_add(1, Ordering::Relaxed) + 1;
        tracing::warn!(
            unreadable = total,
            "spaces store: skipped a {what} value that does not open"
        );
    }
}

fn user_error(error: anyhow::Error) -> rusqlite::Error {
    rusqlite::Error::UserFunctionError(error.into())
}

fn text_arg(ctx: &FnContext<'_>, index: usize) -> rusqlite::Result<Option<String>> {
    Ok(match ctx.get_raw(index) {
        ValueRef::Null => None,
        ValueRef::Text(text) => Some(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Blob(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Integer(n) => Some(n.to_string()),
        ValueRef::Real(r) => Some(r.to_string()),
    })
}

fn id_arg(ctx: &FnContext<'_>, index: usize) -> rusqlite::Result<String> {
    text_arg(ctx, index)?.ok_or_else(|| user_error(anyhow!("a sealed Spaces value needs a row id")))
}

fn bytes_arg(ctx: &FnContext<'_>, index: usize) -> Option<Vec<u8>> {
    match ctx.get_raw(index) {
        ValueRef::Null => None,
        ValueRef::Text(text) => Some(text.to_vec()),
        ValueRef::Blob(bytes) => Some(bytes.to_vec()),
        ValueRef::Integer(n) => Some(n.to_string().into_bytes()),
        ValueRef::Real(r) => Some(r.to_string().into_bytes()),
    }
}

/// Register the sealing functions (see the module docs) on `conn`. Call on
/// every connection that reads or writes the store's sealed columns, before
/// its first statement.
pub(crate) fn register_sql_functions(conn: &Connection, state: &SealState) -> Result<()> {
    let flags = FunctionFlags::SQLITE_UTF8;
    let deterministic = flags | FunctionFlags::SQLITE_DETERMINISTIC;

    let seal = state.clone();
    conn.create_scalar_function("ryu_seal", 3, flags, move |ctx| {
        let Some(value) = text_arg(ctx, 2)? else {
            return Ok(None);
        };
        if !seal.writable.load(Ordering::Relaxed) {
            return Err(user_error(ryu_crypto::content_sqlite::mismatch_error(
                SPACES_STORE,
            )));
        }
        let purpose = id_arg(ctx, 0)?;
        let id = id_arg(ctx, 1)?;
        seal.keys
            .cipher
            .seal_text(&value, &ContentContext::for_id(purpose, id))
            .map(Some)
            .map_err(user_error)
    })?;

    let open = state.clone();
    conn.create_scalar_function("ryu_open", 3, deterministic, move |ctx| {
        let Some(stored) = text_arg(ctx, 2)? else {
            return Ok(None);
        };
        let purpose = id_arg(ctx, 0)?;
        let id = id_arg(ctx, 1)?;
        open.keys
            .cipher
            .open_text(&stored, &ContentContext::for_id(purpose.clone(), id))
            .map(|opened| Some(opened.value))
            .map_err(|error| user_error(error.context(format!("opening {purpose}"))))
    })?;

    let soft = state.clone();
    conn.create_scalar_function("ryu_open_soft", 3, flags, move |ctx| {
        let Some(stored) = text_arg(ctx, 2)? else {
            return Ok(None);
        };
        let purpose = id_arg(ctx, 0)?;
        let id = id_arg(ctx, 1)?;
        match soft
            .keys
            .cipher
            .open_text(&stored, &ContentContext::for_id(purpose.clone(), id))
        {
            Ok(opened) => Ok(Some(opened.value)),
            Err(error) if is_content_seal_error(&error) => {
                soft.note_unreadable(&purpose);
                Ok(None)
            }
            Err(error) => Err(user_error(error)),
        }
    })?;

    let seal_blob = state.clone();
    conn.create_scalar_function("ryu_seal_blob", 3, flags, move |ctx| {
        let Some(value) = bytes_arg(ctx, 2) else {
            return Ok(None);
        };
        if !seal_blob.writable.load(Ordering::Relaxed) {
            return Err(user_error(ryu_crypto::content_sqlite::mismatch_error(
                SPACES_STORE,
            )));
        }
        let purpose = id_arg(ctx, 0)?;
        let id = id_arg(ctx, 1)?;
        seal_blob
            .keys
            .cipher
            .seal_bytes(&value, &ContentContext::for_id(purpose, id))
            .map(Some)
            .map_err(user_error)
    })?;

    let open_blob = state.clone();
    conn.create_scalar_function("ryu_open_blob", 3, deterministic, move |ctx| {
        let Some(stored) = bytes_arg(ctx, 2) else {
            return Ok(None);
        };
        let purpose = id_arg(ctx, 0)?;
        let id = id_arg(ctx, 1)?;
        open_blob
            .keys
            .cipher
            .open_bytes(&stored, &ContentContext::for_id(purpose.clone(), id))
            .map(|opened| Some(opened.value))
            .map_err(|error| user_error(error.context(format!("opening {purpose}"))))
    })?;

    let seal_vec = state.clone();
    conn.create_scalar_function("ryu_seal_vec", 3, flags, move |ctx| {
        let Some(value) = bytes_arg(ctx, 2) else {
            return Ok(None);
        };
        if !seal_vec.writable.load(Ordering::Relaxed) {
            return Err(user_error(ryu_crypto::content_sqlite::mismatch_error(
                SPACES_STORE,
            )));
        }
        let id = id_arg(ctx, 0)?;
        let model = text_arg(ctx, 1)?.unwrap_or_default();
        seal_vec
            .keys
            .cipher
            .seal_bytes(&value, &embedding_context(&id, &model))
            .map(Some)
            .map_err(user_error)
    })?;

    let blind = state.clone();
    conn.create_scalar_function("ryu_bi", 2, deterministic, move |ctx| {
        let field = id_arg(ctx, 0)?;
        let Some(value) = text_arg(ctx, 1)? else {
            return Ok(None);
        };
        let index = blind
            .keys
            .blind(&field)
            .ok_or_else(|| user_error(anyhow!("unknown Spaces blind-index field {field}")))?;
        Ok(Some(if field == FIELD_ENTITY {
            index.token(&value)
        } else {
            index.token_casefold(&value)
        }))
    })?;

    let history = state.clone();
    conn.create_scalar_function("ryu_history_hash", 1, deterministic, move |ctx| {
        let Some(raw) = bytes_arg(ctx, 0) else {
            return Ok(None);
        };
        history
            .keys
            .history_hash(&raw)
            .map(Some)
            .map_err(user_error)
    })?;

    let terms = state.clone();
    conn.create_scalar_function("ryu_terms", 3, flags, move |ctx| {
        let Some(stored) = text_arg(ctx, 2)? else {
            return Ok(String::new());
        };
        let purpose = id_arg(ctx, 0)?;
        let id = id_arg(ctx, 1)?;
        match terms
            .keys
            .cipher
            .open_text(&stored, &ContentContext::for_id(purpose.clone(), id))
        {
            Ok(opened) => Ok(term_document(
                &terms.keys.terms,
                &searchable_text(&opened.value),
            )),
            // A value that does not open contributes no terms (derived index).
            Err(error) if is_content_seal_error(&error) => {
                terms.note_unreadable(&purpose);
                Ok(String::new())
            }
            Err(error) => Err(user_error(error)),
        }
    })?;
    Ok(())
}

/// The content of one `spaces_terms` row for `text`: its term tokens, sorted
/// by token value. `spaces_terms` keeps each row's content, so the tokens must
/// not stay in the order of their plaintext words (the shared tokenizer sorts
/// the words before tokenizing them): a stored row would then be an
/// alphabetical chain of the plaintext vocabulary. Sorted by token, a row
/// reveals only which tokens a body or chunk holds.
pub(crate) fn term_document(index: &BlindIndex, text: &str) -> String {
    let mut tokens = index.term_tokens(text);
    tokens.sort_unstable();
    tokens.join(" ")
}

/// The text a body contributes to the term index: database/whiteboard/app JSON
/// is flattened to its strings so cells stay findable, markdown stays as is.
fn searchable_text(value: &str) -> String {
    let trimmed = value.trim_start();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(trimmed) {
            let mut out = String::new();
            crate::collect_json_strings(&json, &mut out);
            return out;
        }
    }
    value.to_owned()
}

/// The AAD context of a chunk embedding: the chunk id and the model that made
/// it, so a vector copied to another chunk or relabelled to another model does
/// not open.
pub(crate) fn embedding_context(chunk_id: &str, model: &str) -> ContentContext {
    ContentContext::new("chunk_embeddings.embedding")
        .with("id", chunk_id)
        .with("model", model)
}

/// Encode an f32 vector as little-endian bytes.
pub(crate) fn vec_to_bytes(vec: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(vec.len() * 4);
    for value in vec {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

/// Decode little-endian f32 bytes (`None` on a ragged length).
pub(crate) fn bytes_to_vec(bytes: &[u8]) -> Option<Vec<f32>> {
    if bytes.len() % 4 != 0 {
        return None;
    }
    Some(
        bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect(),
    )
}

/// The migration plans of every sealed column (cursor = the TEXT id).
pub(crate) fn seal_plans() -> Result<Vec<ColumnPlan>> {
    let mut plans = SEALED_TEXT_COLUMNS
        .iter()
        .map(|(table, column)| ColumnPlan::text(table, column, "id", KeyKind::Text))
        .collect::<Result<Vec<_>>>()?;
    plans.push(ColumnPlan::blob(
        "document_version_blobs",
        "payload",
        "hash",
        KeyKind::Text,
    )?);
    plans.push(
        ColumnPlan::blob("chunk_embeddings", "embedding", "chunk_id", KeyKind::Text)?
            .with_context(&["model"], |row| {
                embedding_context(&row.key(), &row.text("model"))
            })?,
    );
    Ok(plans)
}

// ── Blobs ─────────────────────────────────────────────────────────────────────

/// The AAD context of a blob: its content address.
pub(crate) fn blob_context(sha256: &str) -> ContentContext {
    ContentContext::for_id("blob", sha256)
}

/// On-disk path of a blob (`<root>/<aa>/<sha256>`).
pub(crate) fn blob_path(blob_root: &Path, sha256: &str) -> PathBuf {
    let shard = sha256.get(0..2).unwrap_or("00");
    blob_root.join(shard).join(sha256)
}

fn is_sha256_name(name: &str) -> bool {
    name.len() == 64
        && name
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn hex(digest: &[u8]) -> String {
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Lowercase hex sha256 of `bytes`.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn private_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("creating blob dir {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// Write `bytes` into the blob store as a write-once `RYU-SF01` file named by
/// the plaintext SHA-256 and return it. Content-addressed: a blob that already
/// exists (sealed, or legacy plaintext the migration will seal) is not
/// rewritten. The sealed bytes go to a unique `.part` sibling (owner-only),
/// are fsynced, then renamed into place, so neither a reader nor a crash ever
/// leaves plaintext or a partial blob behind.
pub(crate) fn write_blob(blob_root: &Path, cipher: &ContentCipher, bytes: &[u8]) -> Result<String> {
    let sha = sha256_hex(bytes);
    let path = blob_path(blob_root, &sha);
    if path.exists() {
        return Ok(sha);
    }
    let parent = path.parent().context("invalid blob path")?;
    private_dir(parent)?;
    let tmp = parent.join(format!("{sha}.{}.part", uuid::Uuid::new_v4().simple()));
    let result = (|| -> Result<()> {
        let mut writer = SealedFileWriter::create(&tmp, cipher, &blob_context(&sha))?;
        writer.write_plain(bytes)?;
        writer.finish()?;
        std::fs::rename(&tmp, &path).with_context(|| format!("finalizing blob {sha}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.map(|()| sha)
}

/// A readable blob: sealed (`RYU-SF01`) or legacy plaintext.
pub enum BlobReader {
    /// A sealed blob, decrypted chunk by chunk.
    Sealed(SealedFileReader<File>),
    /// A legacy plaintext blob (sealed in place by the migration).
    Plain {
        /// The open file.
        file: File,
        /// Its length.
        len: u64,
    },
}

impl BlobReader {
    /// Plaintext length in bytes (verified for sealed blobs).
    pub fn len(&self) -> u64 {
        match self {
            Self::Sealed(reader) => reader.plaintext_len(),
            Self::Plain { len, .. } => *len,
        }
    }

    /// Whether the blob is empty.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Decrypt exactly `start..start + len` (clamped to the end).
    pub fn read_range(&mut self, start: u64, len: u64) -> Result<Vec<u8>> {
        match self {
            Self::Sealed(reader) => reader.read_range(start, len),
            Self::Plain { file, len: total } => {
                let end = start.saturating_add(len).min(*total);
                if start >= end {
                    return Ok(Vec::new());
                }
                file.seek(SeekFrom::Start(start))?;
                let mut out = vec![0u8; (end - start) as usize];
                file.read_exact(&mut out)?;
                Ok(out)
            }
        }
    }
}

impl Read for BlobReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Self::Sealed(reader) => reader.read(buf),
            Self::Plain { file, .. } => file.read(buf),
        }
    }
}

impl Seek for BlobReader {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        match self {
            Self::Sealed(reader) => reader.seek(pos),
            Self::Plain { file, .. } => file.seek(pos),
        }
    }
}

/// Open a blob by its SHA-256 (`Ok(None)` when absent). The format is decided
/// from the open file descriptor, so a concurrent in-place seal (an atomic
/// rename) never mixes the two forms.
pub fn open_blob(
    blob_root: &Path,
    cipher: &ContentCipher,
    sha256: &str,
) -> Result<Option<BlobReader>> {
    if !is_sha256_name(sha256) {
        bail!("invalid blob address");
    }
    let path = blob_path(blob_root, sha256);
    let mut file = match File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("reading blob {sha256}")),
    };
    let len = file.metadata()?.len();
    let mut magic = [0u8; 8];
    let sealed = len >= 8 && {
        file.read_exact(&mut magic)?;
        &magic == ryu_crypto::content::SEALED_FILE_MAGIC
    };
    file.seek(SeekFrom::Start(0))?;
    if sealed {
        let reader = SealedFileReader::open(file, cipher, &blob_context(sha256))
            .with_context(|| format!("opening sealed blob {sha256}"))?;
        Ok(Some(BlobReader::Sealed(reader)))
    } else {
        Ok(Some(BlobReader::Plain { file, len }))
    }
}

/// Read a whole blob and verify that the SHA-256 of the decrypted bytes equals
/// its name. `Ok(None)` when absent.
pub(crate) fn read_blob(
    blob_root: &Path,
    cipher: &ContentCipher,
    sha256: &str,
) -> Result<Option<Vec<u8>>> {
    let Some(mut reader) = open_blob(blob_root, cipher, sha256)? else {
        return Ok(None);
    };
    let mut bytes = Vec::with_capacity(reader.len() as usize);
    reader
        .read_to_end(&mut bytes)
        .with_context(|| format!("reading blob {sha256}"))?;
    if sha256_hex(&bytes) != sha256 {
        bail!("blob {sha256} does not match its checksum");
    }
    Ok(Some(bytes))
}

/// Stream a blob into `out`, returning the SHA-256 of the decrypted bytes and
/// their length. The caller compares the digest with the blob's name.
pub(crate) fn copy_blob(
    blob_root: &Path,
    cipher: &ContentCipher,
    sha256: &str,
    out: &mut impl std::io::Write,
) -> Result<Option<(String, u64)>> {
    let Some(mut reader) = open_blob(blob_root, cipher, sha256)? else {
        return Ok(None);
    };
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    let mut total = 0u64;
    loop {
        let n = reader.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
        out.write_all(&buffer[..n])?;
        total += n as u64;
    }
    Ok(Some((hex(&hasher.finalize()), total)))
}

/// Read a blob of the store rooted at `blob_root` in a process that holds the
/// master key (Core's document parser). Verifies the digest.
pub fn read_blob_at(blob_root: &Path, sha256: &str) -> Result<Option<Vec<u8>>> {
    let cipher = ryu_crypto::content_cipher(BLOB_STORE).context("resolving the Spaces blob key")?;
    read_blob(blob_root, &cipher, sha256)
}

/// Decrypt a blob into `dest` (created owner-only, must not exist) for a tool
/// that needs a path, verifying the digest. Returns `Ok(false)` when the blob
/// is absent. On any error the partial file is removed.
pub fn decrypt_blob_to_path(blob_root: &Path, sha256: &str, dest: &Path) -> Result<bool> {
    let cipher = ryu_crypto::content_cipher(BLOB_STORE).context("resolving the Spaces blob key")?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(dest)
        .with_context(|| format!("creating {}", dest.display()))?;
    let result = copy_blob(blob_root, &cipher, sha256, &mut file);
    match result {
        Ok(Some((digest, _))) if digest == sha256 => Ok(true),
        Ok(None) => {
            drop(file);
            let _ = std::fs::remove_file(dest);
            Ok(false)
        }
        Ok(Some(_)) => {
            drop(file);
            let _ = std::fs::remove_file(dest);
            bail!("blob {sha256} does not match its checksum")
        }
        Err(error) => {
            drop(file);
            let _ = std::fs::remove_file(dest);
            Err(error)
        }
    }
}

/// Counters of one blob sweep.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BlobSweepReport {
    /// Blobs sealed by this sweep.
    pub sealed: u64,
    /// Blob files seen (sealed or not).
    pub total: u64,
    /// Crash leftovers (`.part`, `.sealing`, legacy `.tmp*`) removed.
    pub removed_leftovers: u64,
}

/// Seal every legacy plaintext blob under `blob_root` in place, one file at a
/// time: each original is replaced only after its sealed copy verified
/// ([`ryu_crypto::seal_file_in_place`], which also checks free space). Removes
/// crash leftovers (`.part` temp files older than an hour, `.sealing`
/// copies, and the plaintext `.tmp*` restore staging files of older builds). Stops at the first error (for example low disk space) and reports
/// it; the next start resumes. Idempotent.
pub fn seal_legacy_blobs(
    blob_root: &Path,
    cipher: &ContentCipher,
    mut progress: impl FnMut(&BlobSweepReport),
) -> Result<BlobSweepReport> {
    let mut report = BlobSweepReport::default();
    let shards = match std::fs::read_dir(blob_root) {
        Ok(shards) => shards,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(report),
        Err(error) => return Err(error).context("listing the blob store"),
    };
    let mut files = Vec::new();
    for shard in shards.flatten() {
        if !shard.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        for entry in std::fs::read_dir(shard.path())?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            if name.ends_with(".sealing") || name.starts_with(".tmp") {
                // `.tmp*`: older builds staged restored blobs in the shard as
                // `tempfile` files (plaintext); a crash left full copies.
                // Nothing current writes that name here.
                let _ = std::fs::remove_file(&path);
                report.removed_leftovers += 1;
            } else if name.ends_with(".part") {
                let stale = entry
                    .metadata()
                    .and_then(|meta| meta.modified())
                    .ok()
                    .and_then(|modified| modified.elapsed().ok())
                    .is_some_and(|age| age.as_secs() > 3600);
                if stale {
                    let _ = std::fs::remove_file(&path);
                    report.removed_leftovers += 1;
                }
            } else if is_sha256_name(&name) {
                files.push((name, path));
            }
        }
    }
    report.total = files.len() as u64;
    progress(&report);
    for (sha, path) in files {
        match ryu_crypto::seal_file_in_place(&path, cipher, &blob_context(&sha))
            .with_context(|| format!("sealing blob {sha}"))?
        {
            SealInPlace::AlreadySealed => {}
            SealInPlace::Sealed { .. } => report.sealed += 1,
        }
        progress(&report);
    }
    Ok(report)
}
