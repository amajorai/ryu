//! The document.parse facade: `builtin_parse` through `release_input`.
// test-exempt: moved verbatim out of document_parse.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use crate::document_parse::*;

/// Decode bytes Core can read itself, or say precisely why it cannot.
///
/// The floor, as a typed call. Differs from [`builtin_markdown`] in exactly one way:
/// a *mis-encoded* input is decoded anyway (BOM'd UTF-16 properly, anything else
/// lossily) with the compromise recorded in `warnings`, because this caller CAN carry
/// that nuance where an HTTP status code cannot. That tolerance stops at bytes which
/// are not text at all — those are [`ParseFailureReason::NotText`], see [`decode_text`].
/// A non-floor extension is [`ParseFailureReason::Unsupported`] — never an empty
/// string, which is the one answer that would let a document disappear silently.
pub fn builtin_parse(filename: &str, bytes: &[u8]) -> Result<ParseOutcome, ParseFailure> {
    if bytes.len() > MAX_BLOB_PARSE_BYTES {
        return Err(ParseFailure::new(
            ParseFailureReason::TooLarge,
            // No file name: this message is stored in the file-index status.
            format!(
                "the file is {} bytes, over the {}-byte limit",
                bytes.len(),
                MAX_BLOB_PARSE_BYTES
            ),
        ));
    }
    if !is_builtin_readable(filename) {
        return Err(ParseFailure::new(
            ParseFailureReason::Unsupported,
            format!(
                "Core reads no text out of {} on its own",
                display_extension(filename)
            ),
        ));
    }

    let (text, mut warnings) = decode_text(bytes)?;
    let (markdown, truncated) = truncate_markdown(&apply_html_strip(filename, &text));
    if truncated {
        warnings.push(format!(
            "output was truncated at {MAX_MARKDOWN_BYTES} bytes"
        ));
    }
    Ok(ParseOutcome {
        markdown,
        backend_id: BUILTIN_BACKEND_ID.to_owned(),
        backend_version: env!("CARGO_PKG_VERSION").to_owned(),
        source_sha256: sha256_hex(bytes),
        parsed_at: chrono::Utc::now(),
        warnings,
        truncated,
    })
}

/// `".pdf"`, or `"this file"` when there is no extension — for a message a human reads.
pub(in crate::document_parse) fn display_extension(filename: &str) -> String {
    let ext = extension_of(filename);
    if ext.is_empty() {
        "this file".to_owned()
    } else {
        ext
    }
}

/// How many leading bytes the NUL probe in [`decode_text`] looks at.
///
/// 8 KiB, the same window `git` uses to call a blob binary. Bounded rather than
/// whole-file for one reason: a NUL is only *evidence* of a binary, and a text file
/// with one stray NUL a megabyte in is still a text file. Every real container puts
/// its NULs in the header — a zip's local file header has them by byte 30, PNG's
/// IHDR length by byte 8 — so a window this size costs nothing in detection.
pub(in crate::document_parse) const BINARY_SNIFF_BYTES: usize = 8 * 1024;

/// The share of decoded characters that may be U+FFFD before [`decode_text`] calls
/// the input binary rather than merely mis-encoded.
///
/// 10% is where "a legacy encoding we are approximating" stops and "these bytes are
/// not prose" starts. A latin-1 document decoded lossily loses only its accented
/// characters — a few percent of a European-language page — while a binary that
/// happens to carry no NUL in its first 8 KiB (a JPEG, a bare `%PDF` header) shreds
/// into replacement characters at several times this rate. The threshold is over
/// **decoded characters, not bytes**, because `from_utf8_lossy` collapses a run of
/// invalid bytes into one U+FFFD and the ratio must not depend on how they clump.
pub(in crate::document_parse) const MAX_REPLACEMENT_RATIO: f64 = 0.10;

/// UTF-8 first, BOM'd UTF-16 second, lossy last — with a warning for anything but the
/// first. Returns the text and whatever had to be compromised to get it, or
/// [`ParseFailureReason::NotText`] when the bytes are not plausibly text at all.
///
/// # Why this refuses rather than always decoding
///
/// The lossy last resort used to be unconditional, and the floor's `is_builtin_readable`
/// gate was the only thing standing between a binary and it. That gate is keyed on the
/// **name**, and a name is client-supplied:
///
/// - `payload.txt` holding a zip takes the extension arm;
/// - `notes` + `mime: text/plain` takes the [`mime_floor_name`] arm, and title and mime
///   arrive independently from the same request body (`POST /api/spaces/:id/files`), the
///   same tool arguments (`artifact.create`), or the request's own `content-type`
///   (`POST /api/uploads`).
///
/// Either way the bytes reached the decoder and came back as a page of replacement
/// characters, which [`crate::space_file_index`] then chunked, embedded and stored **as
/// the document's contents**. Mojibake presented as prose is worse than an unreadable
/// file, because a model will reason about it and a user cannot tell it happened.
///
/// # The two signals, and why they are only these two
///
/// This is not a content sniffer and must not grow into one — guessing formats is what
/// a `document.parse` provider is for. It refuses the *obvious* case on two cheap,
/// standard tests: a NUL byte in the first [`BINARY_SNIFF_BYTES`] (no text encoding
/// this floor accepts produces one — UTF-16, which does, is decoded on the arm above
/// and never reaches the probe), and a decoded U+FFFD share over
/// [`MAX_REPLACEMENT_RATIO`]. Anything subtler is allowed through with the warning it
/// always had; the compromise stays visible either way.
pub(in crate::document_parse) fn decode_text(
    bytes: &[u8],
) -> Result<(String, Vec<String>), ParseFailure> {
    // UTF-16 leads, because its ASCII content is half NUL bytes and the probe below
    // would refuse a legitimately-decodable file. A BOM'd stream is never valid UTF-8
    // (0xFF/0xFE cannot start one), so testing it before or after the UTF-8 arm is the
    // same answer — but it MUST come before the NUL probe.
    if let Some(text) = decode_utf16_bom(bytes) {
        return Ok((text, vec!["input was UTF-16; decoded to UTF-8".to_owned()]));
    }
    if let Some(at) = nul_byte_offset(bytes) {
        return Err(ParseFailure::new(
            ParseFailureReason::NotText,
            format!(
                "these bytes are not text: a NUL byte at offset {at} means the file is \
                 binary, whatever its name or declared type says"
            ),
        ));
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok((text.to_owned(), Vec::new()));
    }

    let text = String::from_utf8_lossy(bytes).into_owned();
    let ratio = replacement_ratio(&text);
    if ratio > MAX_REPLACEMENT_RATIO {
        return Err(ParseFailure::new(
            ParseFailureReason::NotText,
            format!(
                "these bytes are not text: {:.0}% of them do not decode as UTF-8, so \
                 reading this file would store replacement characters as its contents",
                ratio * 100.0
            ),
        ));
    }
    Ok((
        text,
        vec!["input was not valid UTF-8; undecodable bytes were replaced".to_owned()],
    ))
}

/// Offset of the first NUL byte within the sniff window, or `None`.
pub(in crate::document_parse) fn nul_byte_offset(bytes: &[u8]) -> Option<usize> {
    bytes.iter().take(BINARY_SNIFF_BYTES).position(|b| *b == 0)
}

/// The share of `text`'s characters that are U+FFFD. `0.0` for empty input — an empty
/// file is not binary, it is empty, and [`crate::space_file_index`] already has a state
/// for that (`skipped/empty_document`).
pub(in crate::document_parse) fn replacement_ratio(text: &str) -> f64 {
    let mut total = 0usize;
    let mut replacements = 0usize;
    for c in text.chars() {
        total += 1;
        if c == '\u{FFFD}' {
            replacements += 1;
        }
    }
    if total == 0 {
        return 0.0;
    }
    replacements as f64 / total as f64
}

/// Decode a BOM-prefixed UTF-16 stream, or `None` when there is no BOM.
///
/// BOM-only: sniffing UTF-16 without one means guessing from byte statistics, and a
/// wrong guess produces confident nonsense. No BOM ⇒ fall through to lossy, which at
/// least says so.
pub(in crate::document_parse) fn decode_utf16_bom(bytes: &[u8]) -> Option<String> {
    let (rest, big_endian) = match bytes {
        [0xFF, 0xFE, rest @ ..] => (rest, false),
        [0xFE, 0xFF, rest @ ..] => (rest, true),
        _ => return None,
    };
    if rest.len() % 2 != 0 {
        return None;
    }
    let units: Vec<u16> = rest
        .chunks_exact(2)
        .map(|p| {
            if big_endian {
                u16::from_be_bytes([p[0], p[1]])
            } else {
                u16::from_le_bytes([p[0], p[1]])
            }
        })
        .collect();
    Some(String::from_utf16_lossy(&units))
}

/// Lowercase hex sha256. Mirrors the Spaces store's blob addressing so a caller can
/// hand us a sha and get the same one back on the outcome.
pub(in crate::document_parse) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// The on-disk path of a content-addressed blob, after validating the address.
///
/// **The validation is the point.** `sha256` reaches us from a store row that
/// ultimately came from a client, and the result is joined onto a filesystem root
/// and handed to another process to open. A 64-lowercase-hex check makes traversal
/// unrepresentable — there is no `..`, no separator, and no absolute path in the
/// accepted alphabet — which is a stronger guarantee than sanitising after the fact.
/// (The sidecar re-checks containment on its side; this is the near half of the same
/// fence.)
///
/// A rejected address is [`ParseFailureReason::BlobUnavailable`], **not**
/// `Unsupported`: the commonest way to get here is a file document whose `sha256` is
/// empty, and calling that "no parser can read this format" sent the user to the
/// Store to fix a broken storage row.
pub fn blob_input_path(sha256: &str) -> Result<std::path::PathBuf, ParseFailure> {
    let valid = sha256.len() == 64
        && sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !valid {
        return Err(ParseFailure::new(
            ParseFailureReason::BlobUnavailable,
            if sha256.is_empty() {
                "this document has no stored blob to read".to_owned()
            } else {
                "blob address is not a 64-character lowercase hex sha256".to_owned()
            },
        ));
    }
    let shard = &sha256[..2];
    Ok(crate::paths::files_path("blobs").join(shard).join(sha256))
}

/// Owner of the decrypted parser inputs under `tmp/`.
pub(in crate::document_parse) const PARSE_TMP_OWNER: &str = "document-parse";

/// Decrypted inputs older than this are crash or abandoned-job leftovers.
pub(in crate::document_parse) const PARSE_INPUT_MAX_AGE: std::time::Duration =
    std::time::Duration::from_secs(6 * 60 * 60);

/// A blob decrypted for a parser that needs a path: an owner-only (`0600`) file
/// in `tmp/document-parse/` (`0700`), removed when this value drops.
///
/// Blobs are sealed (`RYU-SF01`) at rest, so a provider can no longer open the
/// stored file. This is the plaintext-in-flight copy the design allows for tools
/// that need a path: unique name, owner-only, deleted when the job ends or its
/// poller gives up ([`release_input`]). A crash leaves no job to finish, so Core
/// empties the directory at startup ([`sweep_on_start`]), and every submission
/// removes any file no running job holds.
pub(in crate::document_parse) struct DecryptedBlobInput {
    pub(in crate::document_parse) path: std::path::PathBuf,
    pub(in crate::document_parse) created: std::time::Instant,
}

impl DecryptedBlobInput {
    /// Claim `path` before anything is written to it, so a concurrent sweep
    /// never removes a copy whose job id is not known yet.
    pub(in crate::document_parse) fn claim(path: std::path::PathBuf) -> Self {
        if let Ok(mut live) = live_parse_inputs().lock() {
            live.insert(path.clone());
        }
        Self {
            path,
            created: std::time::Instant::now(),
        }
    }
}

impl Drop for DecryptedBlobInput {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        if let Ok(mut live) = live_parse_inputs().lock() {
            live.remove(&self.path);
        }
    }
}

/// Paths of every decrypted input alive in this process (submitting or
/// waiting for its job).
pub(in crate::document_parse) fn live_parse_inputs(
) -> &'static std::sync::Mutex<HashSet<std::path::PathBuf>> {
    static LIVE: std::sync::OnceLock<std::sync::Mutex<HashSet<std::path::PathBuf>>> =
        std::sync::OnceLock::new();
    LIVE.get_or_init(Default::default)
}

/// Decrypted inputs of provider jobs still running, by job id.
pub(in crate::document_parse) fn pending_parse_inputs(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, DecryptedBlobInput>> {
    static PENDING: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, DecryptedBlobInput>>,
    > = std::sync::OnceLock::new();
    PENDING.get_or_init(Default::default)
}

/// Drop decrypted inputs of jobs nobody polled for a long time, and remove
/// every file in the scratch directory that no running job holds (crash
/// leftovers), whatever its age.
pub(in crate::document_parse) fn sweep_parse_inputs(dir: &std::path::Path) {
    if let Ok(mut pending) = pending_parse_inputs().lock() {
        pending.retain(|_, input| input.created.elapsed() < PARSE_INPUT_MAX_AGE);
    }
    let held: HashSet<std::path::PathBuf> = live_parse_inputs()
        .lock()
        .map(|live| live.clone())
        .unwrap_or_default();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !held.contains(&path) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Empty the decrypted-input directory at Core startup. No provider job
/// survives a restart (the job map lives in memory), so anything there is a
/// plaintext copy a crash or kill left behind. Call before any parse can be
/// submitted.
pub fn sweep_on_start() {
    sweep_parse_inputs(&crate::paths::tmp_dir_for(PARSE_TMP_OWNER));
}

/// Release the decrypted input of a job its poller abandoned (poll budget
/// spent): the file is deleted now rather than when the job map entry ages
/// out. Harmless for an unknown or already finished job.
pub fn release_input(job_id: &str) {
    if let Ok(mut pending) = pending_parse_inputs().lock() {
        pending.remove(job_id);
    }
}
