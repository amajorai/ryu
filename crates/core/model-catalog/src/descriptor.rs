//! Install from a source-supplied descriptor (non-HF model sources).

use super::*;

/// Normalise a descriptor's `sha256` pin to lower-case hex, refusing a missing,
/// empty or malformed one. A seam source (model index, marketplace) supplies an
/// arbitrary download URL, so the pin is the only thing binding the bytes Core
/// writes to what the source vouched for: without it the downloader would accept
/// whatever the URL serves. Surrounding whitespace is ignored; anything other
/// than exactly 64 hex digits is an error.
pub(crate) fn require_sha256_pin(sha256: Option<&str>) -> Result<String> {
    let pin = sha256.map(str::trim).unwrap_or_default();
    if pin.is_empty() {
        anyhow::bail!(
            "model descriptor has no sha256 pin; refusing to download an unverifiable file"
        );
    }
    if pin.len() != 64 || !pin.bytes().all(|b| b.is_ascii_hexdigit()) {
        anyhow::bail!("model descriptor sha256 pin is not 64 hex digits; refusing to download");
    }
    Ok(pin.to_ascii_lowercase())
}

/// Download + verify a GGUF from an arbitrary, source-supplied descriptor (URL +
/// required sha256 + destination filename) through the same privileged
/// [`GgufDownloader`] path as [`install_file`]. This is the install handoff for
/// non-HF model sources (e.g. a Ryu model-index): the the active catalog source
/// resolves *what* to install (the descriptor), and Core performs the verified
/// download here so the source itself never touches the disk.
///
/// `repo_id` is the descriptor's `repo_id` (used only for provenance + cache
/// invalidation, so it is *not* required to be a Hub `author/name`). The `url`
/// must be `https://` and is validated against the SSRF guard by the caller
/// (the route) before this runs; `dest_filename` is path-traversal-guarded here
/// since it becomes the on-disk stem. `sha256` must be a 64-hex pin: a missing,
/// empty or malformed pin is refused before any network request (see
/// [`require_sha256_pin`]), and the downloader then rejects any bytes whose
/// digest differs.
pub async fn install_from_descriptor(
    repo_id: &str,
    url: &str,
    sha256: Option<&str>,
    dest_filename: &str,
    downloads: &ryu_downloads::DownloadCenter,
) -> Result<InstallResult> {
    // Security: dest_filename becomes the on-disk stem, so it must be a single
    // safe `.gguf` component (no traversal, no separators).
    validate_gguf_filename(dest_filename)?;
    if is_imatrix_filename(dest_filename) {
        anyhow::bail!("importance matrix files are not runnable model weights: {dest_filename}");
    }

    let sha256 = require_sha256_pin(sha256)?;
    let stem = local_stem(dest_filename);

    let path = downloads
        .download_blocking(gguf_download_spec(
            &stem,
            url,
            &sha256,
            &format!("{repo_id} ({dest_filename})"),
            ryu_downloads::DownloadRole::ChatModel,
        ))
        .await
        .with_context(|| format!("downloading {dest_filename} from {url}"))?;

    installed::record(installed::InstalledModel {
        repo_id: repo_id.to_string(),
        filename: dest_filename.to_string(),
        stem,
        size_bytes: None,
        format: ModelFormat::Gguf,
        // Single-URL descriptor installs (non-HF seam sources) carry no repo
        // tree to discover a companion projector — text-only binding.
        mmproj: None,
        // Plain weight install, not a fine-tune merge.
        finetune_base: None,
    })?;

    // Installed state changed — drop cached detail for this repo + all lists.
    cache_invalidate(repo_id);
    cache_invalidate("list:");

    Ok(InstallResult {
        repo_id: repo_id.to_string(),
        filename: dest_filename.to_string(),
        path: path.to_string_lossy().to_string(),
    })
}

#[cfg(test)]
#[path = "descriptor_tests.rs"]
mod tests;
