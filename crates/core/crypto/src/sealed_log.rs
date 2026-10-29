//! `RYU-SL01`: append-only sealed logs (meeting PCM, Shadow's open segment).
//!
//! ```text
//! header (32 B): "RYU-SL01" | version u8 = 1 | flags u8 = 0 | reserved [0; 2] | salt [20]
//! log key K_l  = HKDF-SHA256(K_s, salt = header.salt,
//!                            info = "ryu-sealed-log-v1" || AAD(context))
//! record j     = u32 BE body_len || nonce12 (random) || ciphertext || tag16
//!                (body_len counts nonce + ciphertext + tag; aad = header || u64 BE j)
//! ```
//!
//! Records are never rewritten. Re-opening a log for append scans and verifies
//! it to the end: a torn tail (a short length or body, or a FINAL record that
//! fails to open) is bytes that never formed a committed record and is
//! truncated; a failing record followed by more data is corruption (an error).
//! Random 96-bit nonces under a per-file key are safe far beyond any realistic
//! record count (writers rotate files: one per meeting, one per Shadow hour).
//!
//! Truncation exactly at a record boundary is not detectable by the format;
//! callers that need completeness persist the committed record count next to
//! the log.

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use rand::RngCore;

use crate::content::{hkdf32, ContentCipher, ContentContext, SEALED_LOG_MAGIC};
use crate::sealed_file::{create_private_file, sync_parent_dir, SealedFileWriter};
use crate::NONCE_LEN;

/// Header length of a sealed log.
pub const SEALED_LOG_HEADER_LEN: usize = 32;
/// Largest record body (nonce + ciphertext + tag) a log accepts: 16 MiB.
pub const MAX_RECORD_BODY: usize = 16 * 1024 * 1024;
const TAG_LEN: usize = 16;
const SALT_LEN: usize = 20;
const LOG_VERSION: u8 = 1;
const LOG_KDF_INFO: &[u8] = b"ryu-sealed-log-v1";

fn log_key(key: &[u8; 32], salt: &[u8], aad: &[u8]) -> ChaCha20Poly1305 {
    let key = hkdf32(key, salt, &[LOG_KDF_INFO, aad]);
    ChaCha20Poly1305::new(Key::from_slice(&key))
}

fn record_aad(header: &[u8; SEALED_LOG_HEADER_LEN], index: u64) -> [u8; SEALED_LOG_HEADER_LEN + 8] {
    let mut aad = [0u8; SEALED_LOG_HEADER_LEN + 8];
    aad[..SEALED_LOG_HEADER_LEN].copy_from_slice(header);
    aad[SEALED_LOG_HEADER_LEN..].copy_from_slice(&index.to_be_bytes());
    aad
}

fn parse_header(bytes: &[u8; SEALED_LOG_HEADER_LEN]) -> Result<()> {
    if &bytes[..8] != SEALED_LOG_MAGIC {
        bail!("not an RYU-SL01 sealed log");
    }
    if bytes[8] != LOG_VERSION || bytes[9] != 0 || bytes[10..12] != [0, 0] {
        bail!("unsupported RYU-SL01 header (written by a newer Ryu?)");
    }
    Ok(())
}

/// Whether the file at `path` starts with the `RYU-SL01` magic.
pub fn is_sealed_log(path: &Path) -> io::Result<bool> {
    let mut magic = [0u8; 8];
    let mut file = File::open(path)?;
    match file.read_exact(&mut magic) {
        Ok(()) => Ok(&magic == SEALED_LOG_MAGIC),
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => Ok(false),
        Err(error) => Err(error),
    }
}

/// How a log scan ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tail {
    /// Exactly at a record boundary.
    Clean,
    /// A short length or body (an interrupted write), or a zero-filled tail.
    Short,
    /// A complete final record that does not open: torn, or the wrong key.
    FinalFailed,
}

/// Result of scanning a log from the start.
struct Scan {
    records: Vec<Vec<u8>>,
    /// Byte offset just past the last committed record.
    committed_end: u64,
    tail: Tail,
}

impl Scan {
    fn torn_tail(&self) -> bool {
        self.tail != Tail::Clean
    }
}

/// One opened log: the header, the key that opened it, and its records.
struct OpenedLog {
    header: [u8; SEALED_LOG_HEADER_LEN],
    aead: ChaCha20Poly1305,
    retired: bool,
    scan: Scan,
}

fn scan_with(
    bytes: &[u8],
    header: &[u8; SEALED_LOG_HEADER_LEN],
    aead: &ChaCha20Poly1305,
    keep_records: bool,
) -> Result<Scan> {
    let mut position = SEALED_LOG_HEADER_LEN;
    let mut records = Vec::new();
    let mut index: u64 = 0;
    loop {
        let finish = |records, tail| Scan {
            records,
            committed_end: position as u64,
            tail,
        };
        if position == bytes.len() {
            return Ok(finish(records, Tail::Clean));
        }
        if bytes.len() - position < 4 {
            return Ok(finish(records, Tail::Short));
        }
        let body_len =
            u32::from_be_bytes(bytes[position..position + 4].try_into().expect("4 bytes")) as usize;
        let body_start = position + 4;
        if !(NONCE_LEN + TAG_LEN..=MAX_RECORD_BODY).contains(&body_len) {
            // Our writer never produces such a length. A zero-filled tail (left by
            // a crash while the file was being extended) is a torn tail; anything
            // else is corruption.
            if bytes[position..].iter().all(|byte| *byte == 0) {
                return Ok(finish(records, Tail::Short));
            }
            bail!("sealed log record {index} has an invalid length");
        }
        if bytes.len() - body_start < body_len {
            return Ok(finish(records, Tail::Short));
        }
        let body = &bytes[body_start..body_start + body_len];
        let (nonce, ciphertext) = body.split_at(NONCE_LEN);
        let opened = aead.decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: &record_aad(header, index),
            },
        );
        let end = body_start + body_len;
        match opened {
            Ok(plain) => {
                if keep_records {
                    records.push(plain);
                }
                position = end;
                index += 1;
            }
            Err(_) if end == bytes.len() => return Ok(finish(records, Tail::FinalFailed)),
            Err(_) => bail!("sealed log record {index} does not open and is followed by more data"),
        }
    }
}

fn open_log(
    bytes: &[u8],
    cipher: &ContentCipher,
    context: &ContentContext,
    keep_records: bool,
) -> Result<OpenedLog> {
    if bytes.len() < SEALED_LOG_HEADER_LEN {
        bail!("sealed log is shorter than its header");
    }
    let header: [u8; SEALED_LOG_HEADER_LEN] = bytes[..SEALED_LOG_HEADER_LEN]
        .try_into()
        .expect("header length");
    parse_header(&header)?;
    let aad = context.associated_data(cipher.store());
    let salt = &header[12..];
    let mut first_error = None;
    for (key, retired) in cipher.candidate_keys() {
        let aead = log_key(&key.key, salt, &aad);
        match scan_with(bytes, &header, &aead, keep_records) {
            // A complete first record that does not open means this key (or
            // context) is wrong, not that the log is torn: try the next key.
            Ok(scan)
                if scan.tail == Tail::FinalFailed
                    && scan.committed_end == SEALED_LOG_HEADER_LEN as u64 => {}
            Ok(scan) => {
                return Ok(OpenedLog {
                    header,
                    aead,
                    retired,
                    scan,
                })
            }
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    Err(first_error.unwrap_or_else(|| {
        anyhow!(crate::content::ContentSealError::DoesNotOpen)
            .context("sealed log does not open (another key, store or record)")
    }))
}

/// Read every record of a sealed log, strictly: a torn tail is an error.
pub fn read_log_bytes(
    bytes: &[u8],
    cipher: &ContentCipher,
    context: &ContentContext,
) -> Result<Vec<Vec<u8>>> {
    let opened = open_log(bytes, cipher, context, true)?;
    if opened.scan.torn_tail() {
        bail!("sealed log ends in an incomplete record");
    }
    Ok(opened.scan.records)
}

/// What [`open_recovering`] returns. Its `Debug` redacts the records: they are
/// decrypted content.
pub struct RecoveredLog {
    /// Every committed record, in order.
    pub records: Vec<Vec<u8>>,
    /// Whether the file ended in a torn (uncommitted) tail, which was ignored.
    pub torn_tail: bool,
    /// Whether the log opened only under a retired key.
    pub needs_reseal: bool,
}

impl std::fmt::Debug for RecoveredLog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let bytes: usize = self.records.iter().map(Vec::len).sum();
        f.debug_struct("RecoveredLog")
            .field(
                "records",
                &format_args!("<{} records, {bytes} bytes redacted>", self.records.len()),
            )
            .field("torn_tail", &self.torn_tail)
            .field("needs_reseal", &self.needs_reseal)
            .finish()
    }
}

/// Read every committed record of the log at `path`, ignoring a torn tail
/// (crash recovery for readers). Mid-file corruption is an error.
pub fn open_recovering(
    path: &Path,
    cipher: &ContentCipher,
    context: &ContentContext,
) -> Result<RecoveredLog> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let opened = open_log(&bytes, cipher, context, true)?;
    let torn_tail = opened.scan.torn_tail();
    Ok(RecoveredLog {
        records: opened.scan.records,
        torn_tail,
        needs_reseal: opened.retired,
    })
}

/// Read every record of the log at `path`, strictly.
pub fn read_log(
    path: &Path,
    cipher: &ContentCipher,
    context: &ContentContext,
) -> Result<Vec<Vec<u8>>> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    read_log_bytes(&bytes, cipher, context)
}

/// Appending writer of one sealed log file.
pub struct SealedLogWriter {
    file: File,
    header: [u8; SEALED_LOG_HEADER_LEN],
    aead: ChaCha20Poly1305,
    next_index: u64,
}

impl std::fmt::Debug for SealedLogWriter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SealedLogWriter")
            .field("records", &self.next_index)
            .finish_non_exhaustive()
    }
}

impl SealedLogWriter {
    /// Create a new log at `path` (owner-only; fails if it exists).
    pub fn create(path: &Path, cipher: &ContentCipher, context: &ContentContext) -> Result<Self> {
        let mut salt = [0u8; SALT_LEN];
        rand::thread_rng().fill_bytes(&mut salt);
        Self::create_with_salt(path, cipher, context, salt)
    }

    pub(crate) fn create_with_salt(
        path: &Path,
        cipher: &ContentCipher,
        context: &ContentContext,
        salt: [u8; SALT_LEN],
    ) -> Result<Self> {
        let mut header = [0u8; SEALED_LOG_HEADER_LEN];
        header[..8].copy_from_slice(SEALED_LOG_MAGIC);
        header[8] = LOG_VERSION;
        header[12..].copy_from_slice(&salt);
        let aad = context.associated_data(cipher.store());
        let aead = log_key(&cipher.current_key().key, &salt, &aad);
        let mut file = create_private_file(path)?;
        file.write_all(&header)
            .context("writing sealed log header")?;
        file.sync_all().context("syncing sealed log header")?;
        sync_parent_dir(path);
        Ok(Self {
            file,
            header,
            aead,
            next_index: 0,
        })
    }

    /// Open an existing log for append: verify every record, truncate a torn
    /// tail, and continue after the last committed record. A log that opens only
    /// under a retired key is refused (compact it first); mid-file corruption is
    /// an error. Creates the log when `path` does not exist.
    pub fn open_append(
        path: &Path,
        cipher: &ContentCipher,
        context: &ContentContext,
    ) -> Result<Self> {
        if !path.exists() {
            return Self::create(path, cipher, context);
        }
        let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        let opened = open_log(&bytes, cipher, context, false)?;
        if opened.retired {
            bail!("sealed log was written under a retired key; compact it before appending");
        }
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .with_context(|| format!("opening {}", path.display()))?;
        if opened.scan.torn_tail() {
            tracing::warn!(
                path = %path.display(),
                dropped_bytes = bytes.len() as u64 - opened.scan.committed_end,
                "sealed log: truncating a torn tail left by an interrupted write"
            );
            file.set_len(opened.scan.committed_end)?;
            file.sync_all()?;
        }
        file.seek(SeekFrom::Start(opened.scan.committed_end))?;
        let next_index = count_records(&bytes[..opened.scan.committed_end as usize]);
        Ok(Self {
            file,
            header: opened.header,
            aead: opened.aead,
            next_index,
        })
    }

    /// Number of committed records.
    pub fn record_count(&self) -> u64 {
        self.next_index
    }

    /// Append one record (written with one `write_all`); returns its index. Call
    /// [`Self::sync`] for durability.
    pub fn append(&mut self, record: &[u8]) -> Result<u64> {
        let mut nonce = [0u8; NONCE_LEN];
        rand::thread_rng().fill_bytes(&mut nonce);
        self.append_with_nonce(record, &nonce)
    }

    pub(crate) fn append_with_nonce(
        &mut self,
        record: &[u8],
        nonce: &[u8; NONCE_LEN],
    ) -> Result<u64> {
        if record.len() + NONCE_LEN + TAG_LEN > MAX_RECORD_BODY {
            bail!("sealed log records are limited to 16 MiB");
        }
        let index = self.next_index;
        let ciphertext = self
            .aead
            .encrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: record,
                    aad: &record_aad(&self.header, index),
                },
            )
            .map_err(|_| anyhow!("sealed log encryption failed"))?;
        let body_len = (NONCE_LEN + ciphertext.len()) as u32;
        let mut frame = Vec::with_capacity(4 + body_len as usize);
        frame.extend_from_slice(&body_len.to_be_bytes());
        frame.extend_from_slice(nonce);
        frame.extend_from_slice(&ciphertext);
        self.file
            .write_all(&frame)
            .context("appending a sealed log record")?;
        self.next_index += 1;
        Ok(index)
    }

    /// Flush appended records to stable storage.
    pub fn sync(&mut self) -> Result<()> {
        self.file.sync_data().context("syncing sealed log")
    }
}

fn count_records(bytes: &[u8]) -> u64 {
    let mut position = SEALED_LOG_HEADER_LEN;
    let mut count = 0;
    while position + 4 <= bytes.len() {
        let len = u32::from_be_bytes(bytes[position..position + 4].try_into().expect("4 bytes"));
        position += 4 + len as usize;
        count += 1;
    }
    count
}

/// Convert a closed log into a write-once `RYU-SF01` file holding the
/// concatenation of its records (strict read: a torn tail is an error; call
/// [`SealedLogWriter::open_append`] first to recover one). Writes
/// `<dest>.sealing`, verifies nothing is left half-written, and renames it to
/// `dest`. The log itself is left for the caller to delete. Returns the
/// plaintext length.
pub fn compact_to_sealed_file(
    log_path: &Path,
    dest: &Path,
    cipher: &ContentCipher,
    log_context: &ContentContext,
    file_context: &ContentContext,
) -> Result<u64> {
    let records = read_log(log_path, cipher, log_context)?;
    let mut temp_name = dest
        .file_name()
        .ok_or_else(|| anyhow!("{} has no file name", dest.display()))?
        .to_os_string();
    temp_name.push(".sealing");
    let temp = dest.with_file_name(temp_name);
    let _ = std::fs::remove_file(&temp);
    let result = (|| -> Result<u64> {
        let mut writer = SealedFileWriter::create(&temp, cipher, file_context)?;
        for record in &records {
            writer.write_plain(record)?;
        }
        Ok(writer.finish()?.plaintext_len)
    })();
    match result {
        Ok(len) => {
            std::fs::rename(&temp, dest)
                .with_context(|| format!("publishing {}", dest.display()))?;
            sync_parent_dir(dest);
            Ok(len)
        }
        Err(error) => {
            let _ = std::fs::remove_file(&temp);
            Err(error)
        }
    }
}

/// Raw scan helper for tests: every record's nonce.
#[cfg(test)]
pub(crate) fn record_nonces(bytes: &[u8]) -> Vec<[u8; NONCE_LEN]> {
    let mut position = SEALED_LOG_HEADER_LEN;
    let mut nonces = Vec::new();
    while position + 4 + NONCE_LEN <= bytes.len() {
        let len = u32::from_be_bytes(bytes[position..position + 4].try_into().unwrap()) as usize;
        nonces.push(
            bytes[position + 4..position + 4 + NONCE_LEN]
                .try_into()
                .unwrap(),
        );
        position += 4 + len;
    }
    nonces
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::KEY_LEN;

    fn cipher() -> ContentCipher {
        ContentCipher::from_root(&[9; KEY_LEN], "meetings.db")
    }

    fn ctx() -> ContentContext {
        ContentContext::new("log").with("id", "meeting-1")
    }

    #[test]
    fn recovered_log_debug_redacts_the_records() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.pcm");
        let mut writer = SealedLogWriter::create(&path, &cipher(), &ctx()).unwrap();
        writer.append(b"secret-words").unwrap();
        writer.sync().unwrap();
        drop(writer);
        let recovered = open_recovering(&path, &cipher(), &ctx()).unwrap();
        let shown = format!("{recovered:?}");
        assert!(shown.contains("<1 records, 12 bytes redacted>"), "{shown}");
        assert!(!shown.contains("secret-words"));
        // The byte-array form `{:?}` of the record would print as numbers.
        let as_numbers = format!("{:?}", b"secret-words".to_vec());
        assert!(!shown.contains(&as_numbers[1..as_numbers.len() - 1]));
        assert!(shown.contains("torn_tail: false"));
    }

    #[test]
    fn appends_survive_reopen_and_read_back_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.pcm");
        let mut writer = SealedLogWriter::create(&path, &cipher(), &ctx()).unwrap();
        writer.append(b"one").unwrap();
        writer.append(b"").unwrap();
        writer.sync().unwrap();
        drop(writer);
        let mut writer = SealedLogWriter::open_append(&path, &cipher(), &ctx()).unwrap();
        assert_eq!(writer.record_count(), 2);
        assert_eq!(writer.append(b"three").unwrap(), 2);
        drop(writer);
        let records = read_log(&path, &cipher(), &ctx()).unwrap();
        assert_eq!(
            records,
            vec![b"one".to_vec(), Vec::new(), b"three".to_vec()]
        );
        let raw = std::fs::read(&path).unwrap();
        assert!(!raw.windows(5).any(|w| w == b"three"));
        assert!(is_sealed_log(&path).unwrap());
    }

    #[test]
    fn two_appends_never_reuse_a_key_nonce_pair() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.pcm");
        let mut writer = SealedLogWriter::create(&path, &cipher(), &ctx()).unwrap();
        writer.append(b"a").unwrap();
        drop(writer);
        // A second session appends to the same file: same key, so nonces must differ.
        let mut writer = SealedLogWriter::open_append(&path, &cipher(), &ctx()).unwrap();
        writer.append(b"b").unwrap();
        drop(writer);
        let raw = std::fs::read(&path).unwrap();
        let nonces = record_nonces(&raw);
        assert_eq!(nonces.len(), 2);
        assert_ne!(nonces[0], nonces[1]);
        // Two files for the same context get different keys (fresh salt).
        let other = dir.path().join("n.pcm");
        SealedLogWriter::create(&other, &cipher(), &ctx())
            .unwrap()
            .append(b"a")
            .unwrap();
        let other_raw = std::fs::read(&other).unwrap();
        assert_ne!(raw[12..32], other_raw[12..32]);
    }

    #[test]
    fn a_torn_tail_is_truncated_but_mid_file_corruption_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.pcm");
        let mut writer = SealedLogWriter::create(&path, &cipher(), &ctx()).unwrap();
        writer.append(b"first").unwrap();
        writer.append(b"second").unwrap();
        drop(writer);
        let full = std::fs::read(&path).unwrap();
        // Torn: drop the last 3 bytes of the final record.
        std::fs::write(&path, &full[..full.len() - 3]).unwrap();
        assert!(read_log(&path, &cipher(), &ctx()).is_err());
        let recovered = open_recovering(&path, &cipher(), &ctx()).unwrap();
        assert!(recovered.torn_tail);
        assert_eq!(recovered.records, vec![b"first".to_vec()]);
        let mut writer = SealedLogWriter::open_append(&path, &cipher(), &ctx()).unwrap();
        assert_eq!(writer.record_count(), 1);
        writer.append(b"again").unwrap();
        drop(writer);
        assert_eq!(
            read_log(&path, &cipher(), &ctx()).unwrap(),
            vec![b"first".to_vec(), b"again".to_vec()]
        );
        // Corrupt the first record while a second follows: an error, never truncation.
        let mut corrupt = std::fs::read(&path).unwrap();
        corrupt[SEALED_LOG_HEADER_LEN + 4 + NONCE_LEN] ^= 1;
        std::fs::write(&path, &corrupt).unwrap();
        assert!(SealedLogWriter::open_append(&path, &cipher(), &ctx()).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), corrupt, "never rewritten");
    }

    #[test]
    fn the_wrong_key_or_context_does_not_open_and_is_not_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.pcm");
        let mut writer = SealedLogWriter::create(&path, &cipher(), &ctx()).unwrap();
        writer.append(b"payload").unwrap();
        drop(writer);
        let before = std::fs::read(&path).unwrap();
        let other = ContentContext::new("log").with("id", "meeting-2");
        assert!(SealedLogWriter::open_append(&path, &cipher(), &other).is_err());
        let wrong = ContentCipher::from_root(&[1; KEY_LEN], "meetings.db");
        assert!(SealedLogWriter::open_append(&path, &wrong, &ctx()).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn compaction_produces_a_sealed_file_with_the_concatenated_records() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("09.msgpack");
        let mut writer = SealedLogWriter::create(&path, &cipher(), &ctx()).unwrap();
        writer.append(b"abc").unwrap();
        writer.append(b"def").unwrap();
        drop(writer);
        let dest = dir.path().join("09.msgpack.zst");
        let file_ctx = ContentContext::new("file").with("id", "2026-10-19/09");
        let len = compact_to_sealed_file(&path, &dest, &cipher(), &ctx(), &file_ctx).unwrap();
        assert_eq!(len, 6);
        let sealed = std::fs::read(&dest).unwrap();
        assert_eq!(
            crate::sealed_file::open_file_bytes(&sealed, &cipher(), &file_ctx).unwrap(),
            b"abcdef"
        );
    }
}
