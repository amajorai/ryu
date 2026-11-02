//! Out-of-catalog provenance, uninstall and on-disk stem discovery.

use super::*;

/// Record provenance for a model downloaded *outside* the catalog install path
/// (the onboarding default chat + embedding GGUFs). Derives the origin repo and
/// original filename from the Hugging Face `weight_url` so the installed view
/// resolves the same repo, friendly name, and quantization as a catalog install
/// — instead of a bare `local:<stem>` card with no metadata. Idempotent on
/// `stem`; best-effort (a write failure is logged by the caller, never fatal).
pub fn record_default_download(
    stem: &str,
    weight_url: &str,
    size_bytes: Option<u64>,
    mmproj: Option<String>,
) -> Result<()> {
    // Original filename = the URL's last path segment (drop any query string).
    let filename = weight_url
        .rsplit('/')
        .next()
        .map(|s| s.split('?').next().unwrap_or(s))
        .filter(|s| !s.is_empty())
        .unwrap_or(stem)
        .to_string();
    installed::record(installed::InstalledModel {
        repo_id: repo_from_hf_url(weight_url).unwrap_or_default(),
        filename,
        stem: stem.to_string(),
        size_bytes,
        format: ModelFormat::Gguf,
        mmproj,
        finetune_base: None,
    })
}

/// Delete an installed GGUF file and drop its provenance record. The on-disk
/// file is the source of truth for "installed", so it is removed first; the
/// provenance entry is then cleared and the relevant caches invalidated so the
/// catalog reflects the change on the next fetch. Idempotent: succeeds even if
/// the file (or record) was already gone. `repo_id` is used only to scope cache
/// invalidation, so it need not be a valid Hub id.
pub fn uninstall_file(repo_id: &str, filename: &str) -> Result<()> {
    // The filename's basename becomes the on-disk stem; reject traversal
    // before touching FS.
    validate_hub_gguf_path(filename)?;
    let stem = local_stem(filename);
    let path = installed::model_file_path(&stem);
    if path.exists() {
        std::fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?;
    }
    // Remove the bound vision adapter too, if this model had one — the projector
    // is keyed to the model's stem (`<stem>.mmproj.gguf`), so it would otherwise
    // be orphaned. Best-effort: a missing file is fine.
    let mmproj = installed::mmproj_file_path(&stem);
    if mmproj.exists() {
        if let Err(e) = std::fs::remove_file(&mmproj) {
            tracing::warn!("removing vision adapter {} failed: {e}", mmproj.display());
        }
    }
    installed::remove(&stem)?;

    // Installed state changed — drop cached detail for this repo + all lists.
    cache_invalidate(repo_id);
    cache_invalidate("list:");
    Ok(())
}

/// Extract the `author/name` repo id from a Hugging Face `resolve` URL, e.g.
/// `https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/x.gguf`.
pub fn repo_from_hf_url(url: &str) -> Option<String> {
    let rest = url.split("huggingface.co/").nth(1)?;
    let repo = rest.split("/resolve/").next()?;
    if repo.contains('/') && !repo.is_empty() {
        Some(repo.to_string())
    } else {
        None
    }
}

/// Stems of every runnable model `*.gguf` file currently in the catalog's model
/// directories ([`installed::catalog_gguf_dirs`]: `models/chat`, plus the bundled
/// embedding/reranker folders). Other modalities' folders (speech, image, video,
/// …) are never scanned, so a TTS vocoder or diffusion text encoder can never
/// surface as a chat card. Excludes vision adapters and importance matrices:
/// both are companions or quantization inputs, not selectable/activatable
/// models, so they must never surface as their own catalog card (or be served
/// as `--model`).
pub(crate) fn on_disk_gguf_stems() -> Vec<String> {
    let mut stems = Vec::new();
    for dir in installed::catalog_gguf_dirs() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            if !entry.file_type().is_ok_and(|t| t.is_file()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if is_mmproj_filename(&name) || is_imatrix_filename(&name) {
                continue;
            }
            if let Some(stem) = name.strip_suffix(".gguf") {
                stems.push(stem.to_string());
            }
        }
    }
    stems
}

#[cfg(test)]
#[path = "local_files_tests.rs"]
mod tests;
