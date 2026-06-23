//! Clipboard capture — polls the system clipboard and emits an event whenever the
//! text content changes. Cross-platform via `arboard` (Windows/macOS/Linux-X11).

use std::time::Duration;

const POLL_INTERVAL: Duration = Duration::from_millis(1500);
const MAX_CHARS: usize = 4000;

/// FNV-1a hash for cheap change detection without storing the full clipboard.
fn hash_text(text: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Start clipboard monitoring on a dedicated thread.
///
/// `arboard::Clipboard` is not guaranteed `Send` across all backends, so it lives
/// entirely on one OS thread rather than a tokio task.
pub fn start() {
    std::thread::Builder::new()
        .name("shadow-clipboard".into())
        .spawn(move || {
            let mut clipboard = match arboard::Clipboard::new() {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!("Clipboard capture unavailable: {e}");
                    return;
                }
            };
            tracing::info!("Clipboard capture started");
            let mut last_hash = 0u64;
            loop {
                std::thread::sleep(POLL_INTERVAL);
                if crate::server::is_capture_paused() {
                    continue;
                }
                let text = match clipboard.get_text() {
                    Ok(t) => t,
                    Err(_) => continue, // empty / non-text clipboard
                };
                if text.trim().is_empty() {
                    continue;
                }
                let hash = hash_text(&text);
                if hash == last_hash {
                    continue;
                }
                last_hash = hash;
                let char_count = text.chars().count() as u64;
                let snippet = super::truncate(&text, MAX_CHARS);
                super::emit(
                    super::TRACK_CLIPBOARD,
                    "clipboard_change",
                    "Clipboard",
                    &snippet,
                    vec![("char_count", rmpv::Value::from(char_count))],
                );
            }
        })
        .ok();
}
