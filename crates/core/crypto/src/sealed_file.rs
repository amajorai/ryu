//! `RYU-SF01`: write-once sealed files with random-access reads.
//!
//! ```text
//! header (32 B, the AAD of every chunk):
//!   "RYU-SF01" | chunk_log2 u8 (10..=20) | flags u8 = 0 | reserved [0; 2] | salt [20]
//! file key K_f = HKDF-SHA256(K_s, salt = header.salt,
//!                            info = "ryu-sealed-file-v1" || AAD(context))
//! chunk i      = ChaCha20-Poly1305(K_f, nonce = i as 11-byte BE || last (1 final, else 0),
//!                                  chunk plaintext, aad = header)
//! ```
//!
//! Files are **write-once**: the writer buffers one chunk so it knows which chunk
//! is last and never seeks back; every modification writes a new file (new
//! random salt, so a new key) and renames it over the old one. Each
//! `(K_f, nonce)` therefore encrypts exactly one plaintext. There is no in-place
//! appender; append-only data uses [`crate::sealed_log`].
//!
//! The reader verifies the final chunk on open (so the plaintext length it
//! reports is trustworthy), then supports `Read + Seek` and
//! [`SealedFileReader::read_range`], which decrypts only the chunks it touches.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use rand::RngCore;
use sha2::Digest;

use crate::content::{hkdf32, ContentCipher, ContentContext, SEALED_FILE_MAGIC};
use crate::KEY_LEN;

/// Header length of a sealed file.
pub const SEALED_FILE_HEADER_LEN: usize = 32;
/// Default chunk size exponent (64 KiB chunks).
pub const DEFAULT_CHUNK_LOG2: u8 = 16;
const TAG_LEN: usize = 16;
const SALT_LEN: usize = 20;
const FILE_KDF_INFO: &[u8] = b"ryu-sealed-file-v1";
/// Free space required beyond a file's size before sealing it in place.
pub const SEAL_IN_PLACE_HEADROOM: u64 = 64 * 1024 * 1024;

/// Why a free-space check refused to start. Callers mark the work pending and
/// retry at the next start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InsufficientSpace {
    /// The directory checked.
    pub dir: PathBuf,
    /// Bytes required.
    pub needed: u64,
    /// Bytes available.
    pub available: u64,
}

impl std::fmt::Display for InsufficientSpace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "not enough free disk space in {}: need {} bytes, {} available",
            self.dir.display(),
            self.needed,
            self.available
        )
    }
}

impl std::error::Error for InsufficientSpace {}

/// Require `needed` bytes of free space in the file system holding `dir`.
/// Errors with [`InsufficientSpace`] (downcastable) when short.
pub fn ensure_free_space(dir: &Path, needed: u64) -> Result<()> {
    let available = fs4::available_space(dir)
        .with_context(|| format!("reading free space of {}", dir.display()))?;
    if available < needed {
        return Err(InsufficientSpace {
            dir: dir.to_path_buf(),
            needed,
            available,
        }
        .into());
    }
    Ok(())
}

fn file_key(cipher_key: &[u8; KEY_LEN], salt: &[u8], aad: &[u8]) -> ChaCha20Poly1305 {
    let key = hkdf32(cipher_key, salt, &[FILE_KDF_INFO, aad]);
    ChaCha20Poly1305::new(Key::from_slice(&key))
}

fn chunk_nonce(index: u64, last: bool) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[3..11].copy_from_slice(&index.to_be_bytes());
    nonce[11] = u8::from(last);
    nonce
}

fn build_header(chunk_log2: u8, salt: &[u8; SALT_LEN]) -> [u8; SEALED_FILE_HEADER_LEN] {
    let mut header = [0u8; SEALED_FILE_HEADER_LEN];
    header[..8].copy_from_slice(SEALED_FILE_MAGIC);
    header[8] = chunk_log2;
    header[12..].copy_from_slice(salt);
    header
}

/// A sink a sealed file can be written to; [`Self::sync_all`] makes the bytes
/// durable (a no-op for in-memory sinks).
pub trait SealedSink: Write {
    /// Flush the bytes to stable storage.
    fn sync_all(&mut self) -> io::Result<()> {
        self.flush()
    }
}

impl SealedSink for File {
    fn sync_all(&mut self) -> io::Result<()> {
        self.flush()?;
        File::sync_all(self)
    }
}

impl SealedSink for Vec<u8> {}
impl SealedSink for io::Cursor<Vec<u8>> {}

/// Streaming writer of one `RYU-SF01` file.
pub struct SealedFileWriter<W: SealedSink> {
    sink: W,
    aead: ChaCha20Poly1305,
    header: [u8; SEALED_FILE_HEADER_LEN],
    chunk_size: usize,
    buffer: Vec<u8>,
    next_index: u64,
    plaintext_len: u64,
    hasher: sha2::Sha256,
}

impl SealedFileWriter<File> {
    /// Create `path` (owner-only, must not exist) and start writing. Write to a
    /// temporary name in the destination directory, then rename it into place
    /// after [`Self::finish`].
    pub fn create(path: &Path, cipher: &ContentCipher, context: &ContentContext) -> Result<Self> {
        let file = create_private_file(path)?;
        Self::new(file, cipher, context)
    }
}

impl<W: SealedSink> SealedFileWriter<W> {
    /// Start a sealed file on an arbitrary sink with the default chunk size.
    pub fn new(sink: W, cipher: &ContentCipher, context: &ContentContext) -> Result<Self> {
        let mut salt = [0u8; SALT_LEN];
        rand::thread_rng().fill_bytes(&mut salt);
        Self::with_params(sink, cipher, context, DEFAULT_CHUNK_LOG2, salt)
    }

    /// Start a sealed file with an explicit chunk size exponent (10..=20).
    pub fn with_chunk_log2(
        sink: W,
        cipher: &ContentCipher,
        context: &ContentContext,
        chunk_log2: u8,
    ) -> Result<Self> {
        let mut salt = [0u8; SALT_LEN];
        rand::thread_rng().fill_bytes(&mut salt);
        Self::with_params(sink, cipher, context, chunk_log2, salt)
    }

    pub(crate) fn with_params(
        mut sink: W,
        cipher: &ContentCipher,
        context: &ContentContext,
        chunk_log2: u8,
        salt: [u8; SALT_LEN],
    ) -> Result<Self> {
        if !(10..=20).contains(&chunk_log2) {
            bail!("sealed file chunk_log2 must be 10..=20, got {chunk_log2}");
        }
        let header = build_header(chunk_log2, &salt);
        let aad = context.associated_data(cipher.store());
        let aead = file_key(&cipher.current_key().key, &salt, &aad);
        sink.write_all(&header)
            .context("writing sealed file header")?;
        Ok(Self {
            sink,
            aead,
            header,
            chunk_size: 1usize << chunk_log2,
            buffer: Vec::with_capacity(1usize << chunk_log2),
            next_index: 0,
            plaintext_len: 0,
            hasher: sha2::Sha256::new(),
        })
    }

    fn seal_chunk(&mut self, last: bool) -> Result<()> {
        let nonce = chunk_nonce(self.next_index, last);
        let sealed = self
            .aead
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &self.buffer,
                    aad: &self.header,
                },
            )
            .map_err(|_| anyhow!("sealed file chunk encryption failed"))?;
        self.sink
            .write_all(&sealed)
            .context("writing a sealed file chunk")?;
        self.next_index += 1;
        self.buffer.clear();
        Ok(())
    }

    /// Append plaintext.
    pub fn write_plain(&mut self, mut data: &[u8]) -> Result<()> {
        self.hasher.update(data);
        self.plaintext_len += data.len() as u64;
        while !data.is_empty() {
            if self.buffer.len() == self.chunk_size {
                // More data follows, so the buffered chunk is not the last one.
                self.seal_chunk(false)?;
            }
            let room = self.chunk_size - self.buffer.len();
            let take = room.min(data.len());
            self.buffer.extend_from_slice(&data[..take]);
            data = &data[take..];
        }
        Ok(())
    }

    /// Seal the final chunk, sync, and return the sink with the plaintext length
    /// and SHA-256.
    pub fn finish(mut self) -> Result<FinishedFile<W>> {
        self.seal_chunk(true)?;
        self.sink.sync_all().context("syncing sealed file")?;
        Ok(FinishedFile {
            sink: self.sink,
            plaintext_len: self.plaintext_len,
            plaintext_sha256: self.hasher.finalize().into(),
        })
    }
}

impl<W: SealedSink> Write for SealedFileWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.write_plain(buf).map_err(io::Error::other)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// What [`SealedFileWriter::finish`] returns.
pub struct FinishedFile<W> {
    /// The sink, positioned after the last chunk.
    pub sink: W,
    /// Plaintext length in bytes.
    pub plaintext_len: u64,
    /// SHA-256 of the plaintext.
    pub plaintext_sha256: [u8; 32],
}

/// Seal `plaintext` into an in-memory `RYU-SF01` file.
pub fn seal_file_bytes(
    plaintext: &[u8],
    cipher: &ContentCipher,
    context: &ContentContext,
) -> Result<Vec<u8>> {
    let mut writer = SealedFileWriter::new(Vec::new(), cipher, context)?;
    writer.write_plain(plaintext)?;
    Ok(writer.finish()?.sink)
}

/// Open an in-memory `RYU-SF01` file completely.
pub fn open_file_bytes(
    sealed: &[u8],
    cipher: &ContentCipher,
    context: &ContentContext,
) -> Result<Vec<u8>> {
    let mut reader = SealedFileReader::open(io::Cursor::new(sealed), cipher, context)?;
    let mut out = Vec::with_capacity(reader.plaintext_len() as usize);
    reader.read_to_end(&mut out)?;
    Ok(out)
}

/// Random-access reader of one `RYU-SF01` file.
pub struct SealedFileReader<R: Read + Seek> {
    inner: R,
    aead: ChaCha20Poly1305,
    header: [u8; SEALED_FILE_HEADER_LEN],
    chunk_size: u64,
    chunk_count: u64,
    plaintext_len: u64,
    position: u64,
    cached: Option<(u64, Vec<u8>)>,
    retired_key: bool,
}

impl SealedFileReader<File> {
    /// Open the sealed file at `path`.
    pub fn open_path(
        path: &Path,
        cipher: &ContentCipher,
        context: &ContentContext,
    ) -> Result<Self> {
        let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
        Self::open(file, cipher, context)
    }
}

impl<R: Read + Seek> SealedFileReader<R> {
    /// Read the header, compute the plaintext length, and verify the final chunk
    /// (under the current key, then retired keys). Errors on a truncated,
    /// malformed or foreign file.
    pub fn open(mut inner: R, cipher: &ContentCipher, context: &ContentContext) -> Result<Self> {
        let size = inner.seek(SeekFrom::End(0))?;
        inner.seek(SeekFrom::Start(0))?;
        if size < (SEALED_FILE_HEADER_LEN + TAG_LEN) as u64 {
            bail!("sealed file is truncated ({size} bytes)");
        }
        let mut header = [0u8; SEALED_FILE_HEADER_LEN];
        inner.read_exact(&mut header)?;
        if &header[..8] != SEALED_FILE_MAGIC {
            bail!("not an RYU-SF01 sealed file");
        }
        let chunk_log2 = header[8];
        if !(10..=20).contains(&chunk_log2) || header[9] != 0 || header[10..12] != [0, 0] {
            bail!("unsupported RYU-SF01 header");
        }
        let chunk_size = 1u64 << chunk_log2;
        let body = size - SEALED_FILE_HEADER_LEN as u64;
        let sealed_chunk = chunk_size + TAG_LEN as u64;
        let full = body / sealed_chunk;
        let rem = body % sealed_chunk;
        let (chunk_count, plaintext_len) = match rem {
            0 => (full, full * chunk_size),
            1..=15 => bail!("sealed file is truncated or malformed"),
            r => (full + 1, full * chunk_size + (r - TAG_LEN as u64)),
        };
        if chunk_count == 0 {
            bail!("sealed file has no chunks");
        }
        let aad = context.associated_data(cipher.store());
        let salt = &header[12..];
        let mut opened = None;
        for (key, retired) in cipher.candidate_keys() {
            let aead = file_key(&key.key, salt, &aad);
            let mut reader = Self {
                inner,
                aead,
                header,
                chunk_size,
                chunk_count,
                plaintext_len,
                position: 0,
                cached: None,
                retired_key: retired,
            };
            match reader.load_chunk(chunk_count - 1) {
                Ok(()) => {
                    opened = Some(reader);
                    break;
                }
                Err(_) => inner = reader.inner,
            }
        }
        opened.ok_or_else(|| {
            anyhow!(crate::content::ContentSealError::DoesNotOpen)
                .context("sealed file does not open (truncated, altered, or another key)")
        })
    }

    /// Plaintext length in bytes (verified on open).
    pub fn plaintext_len(&self) -> u64 {
        self.plaintext_len
    }

    /// Whether the file opened only under a retired key (rewrite it).
    pub fn needs_reseal(&self) -> bool {
        self.retired_key
    }

    fn load_chunk(&mut self, index: u64) -> Result<()> {
        if matches!(&self.cached, Some((cached, _)) if *cached == index) {
            return Ok(());
        }
        if index >= self.chunk_count {
            bail!("chunk {index} out of range");
        }
        let last = index + 1 == self.chunk_count;
        let sealed_chunk = self.chunk_size + TAG_LEN as u64;
        let offset = SEALED_FILE_HEADER_LEN as u64 + index * sealed_chunk;
        let len = if last {
            (self.plaintext_len - index * self.chunk_size) + TAG_LEN as u64
        } else {
            sealed_chunk
        };
        let mut sealed = vec![0u8; len as usize];
        self.inner.seek(SeekFrom::Start(offset))?;
        self.inner.read_exact(&mut sealed)?;
        let nonce = chunk_nonce(index, last);
        let plain = self
            .aead
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &sealed,
                    aad: &self.header,
                },
            )
            .map_err(|_| anyhow!("sealed file chunk {index} does not open"))?;
        self.cached = Some((index, plain));
        Ok(())
    }

    /// Decrypt exactly the plaintext range `start..start + len` (clamped to the
    /// end of the file), touching only the chunks it covers.
    pub fn read_range(&mut self, start: u64, len: u64) -> Result<Vec<u8>> {
        let end = start.saturating_add(len).min(self.plaintext_len);
        if start >= end {
            return Ok(Vec::new());
        }
        let mut out = Vec::with_capacity((end - start) as usize);
        let mut position = start;
        while position < end {
            let index = position / self.chunk_size;
            self.load_chunk(index)?;
            let (_, chunk) = self.cached.as_ref().expect("chunk loaded");
            let within = (position - index * self.chunk_size) as usize;
            let take = ((end - position) as usize).min(chunk.len() - within);
            out.extend_from_slice(&chunk[within..within + take]);
            position += take as u64;
        }
        Ok(out)
    }
}

impl<R: Read + Seek> Read for SealedFileReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.position >= self.plaintext_len || buf.is_empty() {
            return Ok(0);
        }
        let index = self.position / self.chunk_size;
        self.load_chunk(index).map_err(io::Error::other)?;
        let (_, chunk) = self.cached.as_ref().expect("chunk loaded");
        let within = (self.position - index * self.chunk_size) as usize;
        let take = buf.len().min(chunk.len() - within);
        buf[..take].copy_from_slice(&chunk[within..within + take]);
        self.position += take as u64;
        Ok(take)
    }
}

impl<R: Read + Seek> Seek for SealedFileReader<R> {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let target = match pos {
            SeekFrom::Start(offset) => i128::from(offset),
            SeekFrom::End(delta) => i128::from(self.plaintext_len) + i128::from(delta),
            SeekFrom::Current(delta) => i128::from(self.position) + i128::from(delta),
        };
        if target < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek before the start of a sealed file",
            ));
        }
        self.position = target as u64;
        Ok(self.position)
    }
}

/// Whether the file at `path` starts with the `RYU-SF01` magic.
pub fn is_sealed_file(path: &Path) -> io::Result<bool> {
    let mut magic = [0u8; 8];
    let mut file = File::open(path)?;
    let mut read = 0;
    while read < magic.len() {
        match file.read(&mut magic[read..])? {
            0 => return Ok(false),
            n => read += n,
        }
    }
    Ok(&magic == SEALED_FILE_MAGIC)
}

/// Create a new owner-only file (`0600` on Unix); fails if it exists.
pub(crate) fn create_private_file(path: &Path) -> Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).read(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .with_context(|| format!("creating {}", path.display()))
}

/// Fsync the directory holding `path` so a rename into it is durable.
pub(crate) fn sync_parent_dir(path: &Path) {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Outcome of [`seal_file_in_place`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SealInPlace {
    /// The file already was an `RYU-SF01` file; nothing changed.
    AlreadySealed,
    /// The plaintext file was replaced by its verified sealed form.
    Sealed {
        /// Plaintext bytes sealed.
        plaintext_len: u64,
    },
}

/// Replace the plaintext file at `path` with its sealed form, safely:
///
/// 1. require `file size + 64 MiB` free space ([`ensure_free_space`]);
/// 2. write `<name>.sealing` (`0600`) and fsync it;
/// 3. re-open it and compare the SHA-256 of the decrypted stream with the
///    original's;
/// 4. only then rename it over the original (and fsync the directory).
///
/// The original is never removed before the sealed copy is verified. A stale
/// `.sealing` file from a crash is replaced. Idempotent.
pub fn seal_file_in_place(
    path: &Path,
    cipher: &ContentCipher,
    context: &ContentContext,
) -> Result<SealInPlace> {
    if is_sealed_file(path).with_context(|| format!("reading {}", path.display()))? {
        return Ok(SealInPlace::AlreadySealed);
    }
    let size = std::fs::metadata(path)?.len();
    let dir = path
        .parent()
        .ok_or_else(|| anyhow!("{} has no parent directory", path.display()))?;
    ensure_free_space(dir, size.saturating_add(SEAL_IN_PLACE_HEADROOM))?;
    let mut temp_name = path
        .file_name()
        .ok_or_else(|| anyhow!("{} has no file name", path.display()))?
        .to_os_string();
    temp_name.push(".sealing");
    let temp = path.with_file_name(temp_name);
    match std::fs::remove_file(&temp) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("removing a stale .sealing file"),
    }
    let result = (|| -> Result<u64> {
        let mut source = File::open(path)?;
        let mut writer = SealedFileWriter::create(&temp, cipher, context)?;
        let mut buffer = vec![0u8; 1 << 16];
        loop {
            let n = source.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            writer.write_plain(&buffer[..n])?;
        }
        let finished = writer.finish()?;
        drop(finished.sink);
        // Verify the sealed copy decrypts to exactly the original.
        let mut reader = SealedFileReader::open_path(&temp, cipher, context)?;
        let mut hasher = sha2::Sha256::new();
        io::copy(&mut reader, &mut hasher)?;
        let digest: [u8; 32] = hasher.finalize().into();
        if digest != finished.plaintext_sha256 {
            bail!("sealed copy of {} does not verify", path.display());
        }
        Ok(finished.plaintext_len)
    })();
    match result {
        Ok(plaintext_len) => {
            std::fs::rename(&temp, path)
                .with_context(|| format!("replacing {} with its sealed form", path.display()))?;
            sync_parent_dir(path);
            Ok(SealInPlace::Sealed { plaintext_len })
        }
        Err(error) => {
            let _ = std::fs::remove_file(&temp);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cipher() -> ContentCipher {
        ContentCipher::from_root(&[5; KEY_LEN], "media")
    }

    fn ctx(id: &str) -> ContentContext {
        ContentContext::new("file").with("id", id)
    }

    fn sample(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i * 31 + 7) as u8).collect()
    }

    fn seal_with(plain: &[u8], log2: u8) -> Vec<u8> {
        let mut writer =
            SealedFileWriter::with_chunk_log2(Vec::new(), &cipher(), &ctx("m1"), log2).unwrap();
        // Write in odd pieces to cover chunk boundaries.
        for piece in plain.chunks(333) {
            writer.write_plain(piece).unwrap();
        }
        writer.finish().unwrap().sink
    }

    #[test]
    fn round_trips_every_length_around_chunk_boundaries() {
        for len in [0, 1, 1023, 1024, 1025, 2048, 2500, 4096 + 17] {
            let plain = sample(len);
            let sealed = seal_with(&plain, 10);
            let mut reader =
                SealedFileReader::open(io::Cursor::new(&sealed), &cipher(), &ctx("m1")).unwrap();
            assert_eq!(reader.plaintext_len(), len as u64);
            let mut out = Vec::new();
            reader.read_to_end(&mut out).unwrap();
            assert_eq!(out, plain, "len {len}");
        }
    }

    #[test]
    fn ranges_equal_plaintext_slices() {
        let plain = sample(5000);
        let sealed = seal_with(&plain, 10);
        let mut reader =
            SealedFileReader::open(io::Cursor::new(&sealed), &cipher(), &ctx("m1")).unwrap();
        for (start, len) in [
            (0, 10),
            (1000, 100),
            (1023, 2),
            (4990, 100),
            (6000, 5),
            (0, 5000),
        ] {
            let got = reader.read_range(start, len).unwrap();
            let s = (start as usize).min(plain.len());
            let e = ((start + len) as usize).min(plain.len());
            assert_eq!(got, plain[s..e]);
        }
        reader.seek(SeekFrom::Start(2047)).unwrap();
        let mut two = [0u8; 2];
        reader.read_exact(&mut two).unwrap();
        assert_eq!(two, plain[2047..2049]);
    }

    #[test]
    fn truncation_tampering_and_moves_are_detected() {
        let plain = sample(3000);
        let sealed = seal_with(&plain, 10);
        // Drop the final chunk exactly: the new last chunk was sealed as non-final.
        let cut = SEALED_FILE_HEADER_LEN + 2 * (1024 + TAG_LEN);
        assert!(
            SealedFileReader::open(io::Cursor::new(&sealed[..cut]), &cipher(), &ctx("m1")).is_err()
        );
        assert!(SealedFileReader::open(
            io::Cursor::new(&sealed[..sealed.len() - 1]),
            &cipher(),
            &ctx("m1")
        )
        .is_err());
        let mut flipped = sealed.clone();
        flipped[40] ^= 1;
        let mut reader =
            SealedFileReader::open(io::Cursor::new(&flipped), &cipher(), &ctx("m1")).unwrap();
        assert!(reader.read_range(0, 10).is_err());
        assert!(SealedFileReader::open(io::Cursor::new(&sealed), &cipher(), &ctx("m2")).is_err());
    }

    #[test]
    fn two_writes_of_the_same_file_use_different_keys() {
        let a = seal_with(b"same", 10);
        let b = seal_with(b"same", 10);
        assert_ne!(a[12..32], b[12..32], "fresh salt per file");
        assert_ne!(a[32..], b[32..]);
    }

    #[test]
    fn seal_in_place_replaces_only_after_verification_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob.bin");
        let plain = b"meeting notes about the merger".repeat(500);
        std::fs::write(&path, &plain).unwrap();
        let outcome = seal_file_in_place(&path, &cipher(), &ctx("blob")).unwrap();
        assert_eq!(
            outcome,
            SealInPlace::Sealed {
                plaintext_len: plain.len() as u64
            }
        );
        let on_disk = std::fs::read(&path).unwrap();
        assert!(on_disk.starts_with(SEALED_FILE_MAGIC));
        assert!(!on_disk.windows(7).any(|w| w == b"merger "));
        assert!(is_sealed_file(&path).unwrap());
        assert_eq!(
            seal_file_in_place(&path, &cipher(), &ctx("blob")).unwrap(),
            SealInPlace::AlreadySealed
        );
        assert_eq!(
            open_file_bytes(&on_disk, &cipher(), &ctx("blob")).unwrap(),
            plain
        );
        assert!(!dir.path().join("blob.bin.sealing").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn free_space_checks_refuse_impossible_requests() {
        let dir = tempfile::tempdir().unwrap();
        ensure_free_space(dir.path(), 1).unwrap();
        let error = ensure_free_space(dir.path(), u64::MAX).unwrap_err();
        assert!(error.downcast_ref::<InsufficientSpace>().is_some());
    }

    #[test]
    fn retired_keys_open_files_and_flag_them() {
        let old = ContentCipher::from_root(&[1; KEY_LEN], "media");
        let sealed = seal_file_bytes(b"old", &old, &ctx("a")).unwrap();
        let current =
            ContentCipher::from_root(&[2; KEY_LEN], "media").with_retired_roots(&[[1; KEY_LEN]]);
        let mut reader =
            SealedFileReader::open(io::Cursor::new(&sealed), &current, &ctx("a")).unwrap();
        assert!(reader.needs_reseal());
        let mut out = Vec::new();
        reader.read_to_end(&mut out).unwrap();
        assert_eq!(out, b"old");
    }
}
