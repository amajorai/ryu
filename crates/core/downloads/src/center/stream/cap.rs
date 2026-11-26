//! The byte cap of one transfer.
//!
//! The cap guards against a transfer that never ends, or that fills the disk
//! with bytes nobody asked for. A download whose bytes are pinned by a SHA-256
//! is a known artifact: whoever wrote the pin fixed its content, and bytes that
//! differ are deleted at the checksum, before anything is installed. Such a
//! download gets a larger cap, so a pinned model file over 4 GiB can install. A
//! download with no pin, or with a pin no checksum can ever match, keeps the
//! 4 GiB cap. The free-space check before the first byte applies to both.
//!
//! `stream_once` checks the cap three times. First against a `.part` left by an
//! earlier pass, then against the size the server announces (before any byte is
//! written), then against the bytes counted while streaming (for a server that
//! announces no size). A transfer refused by its cap can never complete, so its
//! `.part` is removed, and the error is terminal.

use super::*;

/// Cap for a download whose bytes are pinned by a SHA-256.
pub(super) const PINNED_TRANSFER_BYTES: u64 = 16 * 1024 * 1024 * 1024;

/// Whether `value` is a digest the checksum step can match: the 64 lowercase
/// hex digits `sha256_file` produces. Anything else fails verification for
/// certain, so it earns no extra bytes.
fn is_sha256_pin(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// The caps in force, as `(no pin, pinned)`.
#[cfg(not(test))]
fn limits(_dest: &Path) -> (u64, u64) {
    (MAX_TRANSFER_BYTES, PINNED_TRANSFER_BYTES)
}

/// The caps in force, as `(no pin, pinned)`. A test may shrink them for one
/// destination, so a loopback transfer of a few kilobytes can cross them.
#[cfg(test)]
fn limits(dest: &Path) -> (u64, u64) {
    tests::limits_for(dest).unwrap_or((MAX_TRANSFER_BYTES, PINNED_TRANSFER_BYTES))
}

/// The most bytes one transfer may write, and which rule set that number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct TransferCap {
    bytes: u64,
    pinned: bool,
}

impl TransferCap {
    /// The cap for one transfer of `spec`.
    pub(super) fn of(spec: &DownloadSpec) -> Self {
        let pinned = expected_checksum(spec).is_some_and(|pin| is_sha256_pin(&pin));
        let (unpinned_bytes, pinned_bytes) = limits(&spec.dest);
        Self {
            bytes: if pinned { pinned_bytes } else { unpinned_bytes },
            pinned,
        }
    }

    /// Refuse a `.part` that is already over the cap.
    pub(super) async fn check_part(
        self,
        part: &Path,
        existing: u64,
    ) -> std::result::Result<(), StreamErr> {
        if existing <= self.bytes {
            return Ok(());
        }
        discard(part).await;
        Err(self.refusal(&format!("partial download is {existing} bytes")))
    }

    /// Refuse the size the server announced, before any byte is written. An
    /// unknown size passes: the stream is counted instead.
    pub(super) async fn check_announced(
        self,
        part: &Path,
        total: Option<u64>,
    ) -> std::result::Result<(), StreamErr> {
        match total {
            Some(total) if total > self.bytes => {
                discard(part).await;
                Err(self.refusal(&format!("download is {total} bytes")))
            }
            _ => Ok(()),
        }
    }

    /// Whether `chunk` more bytes after `received` would pass the cap.
    pub(super) fn passed_by(self, received: u64, chunk: usize) -> bool {
        received.saturating_add(chunk as u64) > self.bytes
    }

    /// Refuse a stream that passed the cap while its `.part` is open.
    ///
    /// The bytes still buffered are dropped with the writer. `into_std` waits
    /// for a write that is still in flight, so the file is closed before it is
    /// removed and nothing can write to it afterwards.
    pub(super) async fn refuse_stream(
        self,
        file: tokio::io::BufWriter<tokio::fs::File>,
        part: &Path,
    ) -> StreamErr {
        drop(file.into_inner().into_std().await);
        discard(part).await;
        self.refusal("download did not end at the cap")
    }

    /// The terminal error: what was refused, the cap, and why that cap applies.
    fn refusal(self, what: &str) -> StreamErr {
        let rule = if self.pinned {
            "a download pinned by a SHA-256"
        } else {
            "a download with no valid SHA-256 pin"
        };
        StreamErr::Io(format!(
            "{what}; the transfer cap is {} bytes for {rule}",
            self.bytes
        ))
    }
}

/// Remove a `.part` that can never complete. A missing file is fine. Any other
/// failure is logged: the refusal is the error the caller needs to see.
async fn discard(part: &Path) {
    match tokio::fs::remove_file(part).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            tracing::warn!("could not remove {}: {error}", part.display());
        }
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod transfer_test;
