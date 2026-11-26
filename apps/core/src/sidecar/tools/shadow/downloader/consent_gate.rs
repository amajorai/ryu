//! Core starts only a Shadow binary that has the capture consent gate.
//!
//! A Shadow built before the gate opens the screen, keyboard, mouse and
//! microphone devices at start without asking. A Shadow with the gate carries a
//! marker string (`GATE_MARKER` in `apps/shadow/src/capture_engine/consent.rs`).
//! Core looks for it in the installed binary before every spawn and refuses a
//! binary without it.

use std::io::Read;
use std::path::Path;

/// Must equal `GATE_MARKER` in Shadow's `capture_engine/consent.rs`.
const GATE_MARKER: &[u8] = b"ryu-shadow-capture-consent-gate-v1";

const CHUNK_BYTES: usize = 64 * 1024;

/// Whether the bytes of `reader` contain the marker.
fn contains_marker(mut reader: impl Read) -> std::io::Result<bool> {
    // The tail of each read is kept, so a marker split across two reads is
    // still found.
    let keep = GATE_MARKER.len() - 1;
    let mut buffer = vec![0u8; CHUNK_BYTES + keep];
    let mut filled = 0usize;
    loop {
        let read = reader.read(&mut buffer[filled..])?;
        if read == 0 {
            return Ok(false);
        }
        filled += read;
        if buffer[..filled]
            .windows(GATE_MARKER.len())
            .any(|window| window == GATE_MARKER)
        {
            return Ok(true);
        }
        let tail = filled.min(keep);
        buffer.copy_within(filled - tail..filled, 0);
        filled = tail;
    }
}

fn binary_has_gate(path: &Path) -> std::io::Result<bool> {
    contains_marker(std::fs::File::open(path)?)
}

/// Refuse the Shadow binary at `path` unless it has the capture consent gate.
pub(super) async fn require_gate(path: &Path) -> anyhow::Result<()> {
    let binary = path.to_path_buf();
    let has_gate = tokio::task::spawn_blocking(move || binary_has_gate(&binary))
        .await
        .map_err(|error| anyhow::anyhow!("checking the Shadow binary did not finish: {error}"))?
        .map_err(|error| {
            anyhow::anyhow!(
                "could not read the Shadow binary at {} to check its capture consent gate: {error}",
                path.display()
            )
        })?;
    if !has_gate {
        anyhow::bail!(
            "the Shadow binary at {} has no capture consent gate, so Ryu will not start it: \
             it would open capture devices without asking. Update Shadow to a build with the \
             gate (delete this file so Ryu downloads the current release, or point \
             RYU_SHADOW_RELEASE_URL at such a build)",
            path.display()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A reader that hands out one byte per read, so every marker is split.
    struct OneByte<'a>(&'a [u8]);

    impl Read for OneByte<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let Some((first, rest)) = self.0.split_first() else {
                return Ok(0);
            };
            buffer[0] = *first;
            self.0 = rest;
            Ok(1)
        }
    }

    fn with_marker_at(offset: usize, total: usize) -> Vec<u8> {
        let mut bytes = vec![0x90u8; total];
        bytes[offset..offset + GATE_MARKER.len()].copy_from_slice(GATE_MARKER);
        bytes
    }

    #[test]
    fn the_marker_matches_the_one_shadow_compiles_in() {
        assert_eq!(GATE_MARKER, b"ryu-shadow-capture-consent-gate-v1");
    }

    #[test]
    fn a_binary_without_the_marker_has_no_gate() {
        assert!(!contains_marker(std::io::Cursor::new(Vec::<u8>::new())).unwrap());
        assert!(!contains_marker(std::io::Cursor::new(vec![0x90u8; 3 * CHUNK_BYTES])).unwrap());
        // A cut-off marker is not the marker.
        let cut = &GATE_MARKER[..GATE_MARKER.len() - 1];
        assert!(!contains_marker(std::io::Cursor::new(cut.to_vec())).unwrap());
        assert!(!contains_marker(OneByte(cut)).unwrap());
    }

    #[test]
    fn the_marker_is_found_wherever_it_lies() {
        let total = 3 * CHUNK_BYTES;
        let last = total - GATE_MARKER.len();
        // Start, end, and every position around the first two read boundaries.
        let mut offsets = vec![0, last];
        for boundary in [
            CHUNK_BYTES,
            2 * CHUNK_BYTES,
            CHUNK_BYTES + GATE_MARKER.len() - 1,
        ] {
            for back in 0..=GATE_MARKER.len() + 1 {
                offsets.push(boundary - back);
            }
        }
        for offset in offsets {
            let bytes = with_marker_at(offset, total);
            assert!(
                contains_marker(std::io::Cursor::new(&bytes)).unwrap(),
                "offset {offset}"
            );
        }
        let small = with_marker_at(7, 100);
        assert!(contains_marker(OneByte(&small)).unwrap());
    }

    #[tokio::test]
    async fn an_old_shadow_binary_is_refused_and_a_gated_one_is_accepted() {
        let directory = tempfile::tempdir().unwrap();
        let old = directory.path().join("shadow-old");
        std::fs::write(&old, vec![0x90u8; 4096]).unwrap();
        let error = require_gate(&old).await.unwrap_err().to_string();
        assert!(error.contains("no capture consent gate"), "{error}");
        assert!(error.contains("will not start it"), "{error}");

        let gated = directory.path().join("shadow-new");
        std::fs::write(&gated, with_marker_at(1000, 4096)).unwrap();
        require_gate(&gated).await.unwrap();

        let missing = directory.path().join("shadow-missing");
        let error = require_gate(&missing).await.unwrap_err().to_string();
        assert!(
            error.contains("could not read the Shadow binary"),
            "{error}"
        );
    }
}
