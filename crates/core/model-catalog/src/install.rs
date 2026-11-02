//! Single-file GGUF install: download specs, projector pick and preflight.

use super::*;

/// The outcome of installing a GGUF file.
#[derive(Debug, Clone, Serialize)]
pub struct InstallResult {
    pub repo_id: String,
    pub filename: String,
    pub path: String,
}

/// The `models/<modality>` folder a single-file GGUF of `role` is stored in:
/// embedding/reranker/classifier weights get their own folders, every other
/// llama.cpp GGUF (chat, Speech Processing, draft heads) is a chat-engine model
/// in `models/chat`.
pub fn gguf_modality_for_role(role: ryu_downloads::DownloadRole) -> Modality {
    use ryu_downloads::DownloadRole;
    match role {
        DownloadRole::EmbeddingModel => Modality::Embedding,
        DownloadRole::RerankerModel => Modality::Rerank,
        DownloadRole::ClassifierModel => Modality::Classifier,
        _ => Modality::Chat,
    }
}

/// `<data dir>/models/<modality>` for [`gguf_modality_for_role`].
pub fn gguf_dir_for_role(role: ryu_downloads::DownloadRole) -> PathBuf {
    layout::models_dir(&ryu_dir(), gguf_modality_for_role(role))
}

/// Download + verify a specific GGUF file from a repo, reusing the shared
/// [`GgufDownloader`] (checksum-verified, atomic, retrying). Records provenance
/// so the catalog can show it as installed.
/// Build the [`ryu_downloads::DownloadSpec`] for a GGUF weight, matching the
/// version-store key (`gguf:<id>`) the old `GgufDownloader` used so the
/// fast-path checksum-skip and provenance stay consistent.
pub fn gguf_download_spec(
    id: &str,
    weight_url: &str,
    sha256: &str,
    label: &str,
    role: ryu_downloads::DownloadRole,
) -> ryu_downloads::DownloadSpec {
    ryu_downloads::DownloadSpec {
        kind: ryu_downloads::DownloadKind::Model,
        role,
        label: label.to_string(),
        url: weight_url.to_string(),
        // `models/<modality>/<id>.gguf`, the modality picked from `role` —
        // matches the local model registry's `LocalModelEntry::weight_path()`
        // so the file the downloader writes is the file the engine serves.
        dest: gguf_dir_for_role(role).join(format!("{id}.gguf")),
        sha256: (!sha256.is_empty()).then(|| sha256.to_string()),
        version_record: Some(ryu_downloads::VersionRecord {
            store_key: format!("gguf:{id}"),
            version: id.to_string(),
        }),
    }
}

/// Default multimodal-projector precision preference. `f16` is the standard,
/// widely-published mmproj precision and a safe default across uploaders;
/// overridable via `RYU_MMPROJ_QUANT` so nothing is hardcoded.
pub(crate) const DEFAULT_MMPROJ_QUANT: &str = "f16";

/// Whether a repo file is a multimodal projector ("vision adapter") rather than
/// a model weight quant. llama.cpp ships a vision model's projector as a
/// separate `mmproj-*.gguf` companion; uploaders name it inconsistently
/// (`mmproj-F16.gguf`, `mmproj-model-f16.gguf`, …) but every variant carries the
/// `mmproj` token, so a substring match is the dominant, uploader-agnostic
/// signal. Used both to detect a vision repo and to keep the projector out of
/// the user-facing quant picker.
pub(crate) fn is_mmproj_filename(name: &str) -> bool {
    name.to_ascii_lowercase().contains("mmproj")
}

/// Whether a GGUF file is an importance matrix produced for quantization. These
/// files commonly use names such as `imatrix_unsloth.gguf`; token matching keeps
/// a normal model name containing `imatrix` as a substring from being rejected
/// accidentally.
pub(crate) fn is_imatrix_filename(name: &str) -> bool {
    name.to_ascii_lowercase()
        .split(|c: char| c == '-' || c == '_' || c == '.' || c == '/' || c.is_whitespace())
        .any(|segment| segment == "imatrix")
}

/// Pick the best multimodal projector from a repo tree map (path → size/sha).
/// Prefers the configured precision (`RYU_MMPROJ_QUANT`, default `f16`), then any
/// `f16`, then the smallest remaining candidate (a deterministic tiebreak).
/// Returns the chosen `(filename, size_bytes, sha256)`, or `None` when the repo
/// ships no projector (a text-only model). Only single-component `.gguf`
/// filenames qualify, so a nested repo path can never become the on-disk adapter
/// name.
pub(crate) fn pick_mmproj(
    sizes: &std::collections::HashMap<String, (Option<u64>, Option<String>)>,
) -> Option<(String, Option<u64>, Option<String>)> {
    let pref = std::env::var("RYU_MMPROJ_QUANT")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_MMPROJ_QUANT.to_string())
        .to_ascii_lowercase();

    let mut candidates: Vec<(String, Option<u64>, Option<String>)> = sizes
        .iter()
        .filter(|(path, _)| {
            let lower = path.to_ascii_lowercase();
            is_mmproj_filename(&lower)
                && lower.ends_with(".gguf")
                && !path.contains('/')
                && !path.contains('\\')
        })
        .map(|(p, (s, sha))| (p.clone(), *s, sha.clone()))
        .collect();
    if candidates.is_empty() {
        return None;
    }

    // Stable sort by size first (smallest = the deterministic baseline), then by
    // precision score — the stable pass preserves smallest-first within a score.
    candidates.sort_by_key(|(_, size, _)| size.unwrap_or(u64::MAX));
    let score = |name: &str| -> u8 {
        let l = name.to_ascii_lowercase();
        if l.contains(&pref) {
            0
        } else if l.contains("f16") {
            1
        } else {
            2
        }
    };
    candidates.sort_by_key(|(name, _, _)| score(name));
    candidates.into_iter().next()
}

/// Download the multimodal projector `filename` from `repo_id` and store it as
/// the vision adapter bound to `model_stem` (`models/chat/<stem>.mmproj.gguf`),
/// through the shared verified [`ryu_downloads::DownloadCenter`]. The dest
/// name is built from the already-validated `model_stem`, so the (HF-supplied)
/// projector filename only reaches the download URL, never the on-disk path.
pub(crate) async fn download_mmproj(
    endpoint: &HfEndpoint,
    repo_id: &str,
    model_stem: &str,
    filename: &str,
    sha256: Option<String>,
    downloads: &ryu_downloads::DownloadCenter,
) -> Result<std::path::PathBuf> {
    let spec = ryu_downloads::DownloadSpec {
        kind: ryu_downloads::DownloadKind::Model,
        role: ryu_downloads::DownloadRole::VisionAdapter,
        label: format!("{repo_id} (vision adapter)"),
        url: format!("{}/{repo_id}/resolve/main/{filename}", endpoint.host),
        dest: installed::mmproj_file_path(model_stem),
        sha256: sha256.filter(|s| !s.is_empty()),
        version_record: Some(ryu_downloads::VersionRecord {
            store_key: format!("gguf-mmproj:{model_stem}"),
            version: filename.to_string(),
        }),
    };
    downloads
        .download_blocking(spec)
        .await
        .with_context(|| format!("downloading vision adapter {filename} from {repo_id}"))
}

/// Why Core refuses an install before downloading anything: the model would not
/// fit this node's memory (loading it could freeze or crash the machine) or its
/// free disk. Serialized as the body of the install route's HTTP 422.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallBlock {
    /// Stable machine code: `model_too_large` or `insufficient_disk`.
    pub code: &'static str,
    /// The [`FitVerdict`] wire string: `too_big` or `no_space`.
    pub verdict: &'static str,
    /// One human sentence with the real numbers.
    pub message: String,
    /// Bytes the install would download (weights plus any vision projector).
    pub size_bytes: u64,
}

/// Bytes an install of `file` (GGUF) or of the whole repo (snapshot) downloads,
/// from the same tree map [`model_detail`] sizes its picker from. A GGUF counts
/// the projector [`install_file`] adds beside it. `None` when the size is not
/// known, which never refuses an install.
pub(crate) fn planned_install_bytes(
    sizes: &std::collections::HashMap<String, (Option<u64>, Option<String>)>,
    file: &str,
    format: ModelFormat,
) -> Option<u64> {
    if !format.is_single_file() {
        let total: u64 = sizes.values().filter_map(|(size, _)| *size).sum();
        return (total > 0).then_some(total);
    }
    let weight = sizes.get(file).and_then(|(size, _)| *size)?;
    let projector = match pick_mmproj(sizes) {
        Some((name, size, _)) if name != file => size.unwrap_or(0),
        _ => 0,
    };
    Some(weight.saturating_add(projector))
}

/// The refusal for installing `bytes` on `device`, or `None` when it may go
/// ahead (including an unknown size or unknown hardware). An `installed` model
/// is judged on memory alone, like its row in [`model_detail`].
pub(crate) fn install_block_for(
    bytes: Option<u64>,
    device: &DeviceInfo,
    installed: bool,
) -> Option<InstallBlock> {
    let memory_only;
    let device = if installed {
        memory_only = DeviceInfo {
            disk_free_bytes: None,
            ..device.clone()
        };
        &memory_only
    } else {
        device
    };
    let message = device::install_block_reason(bytes, device)?;
    let size_bytes = bytes.unwrap_or(0);
    let verdict = estimate_install_fit(bytes, device);
    let code = match verdict {
        FitVerdict::NoSpace => "insufficient_disk",
        _ => "model_too_large",
    };
    Some(InstallBlock {
        code,
        verdict: verdict.as_str(),
        message,
        size_bytes,
    })
}

/// Pre-download check for the install route: sizes `file` (or the snapshot of
/// `repo_id`) from the Hub tree and tests it against this node's memory and
/// free disk. Best-effort by design: a failed tree lookup, an unlisted file, or
/// undetectable hardware returns `None` and the install proceeds.
pub async fn install_preflight(
    client: &reqwest::Client,
    endpoint: &HfEndpoint,
    repo_id: &str,
    file: &str,
    format: ModelFormat,
) -> Option<InstallBlock> {
    validate_repo_id(repo_id).ok()?;
    let sizes = fetch_tree_sizes(client, endpoint, repo_id, format)
        .await
        .ok()?;
    let bytes = planned_install_bytes(&sizes, file, format)?;
    // Already on disk (a re-install or an update): only memory is judged, as in
    // `model_detail`. A matching file is skipped by the download center, and an
    // update's new bytes meet the center's own free-space check.
    let installed = if format.is_single_file() {
        validate_hub_gguf_path(file).is_ok() && models_dir_has(&local_stem(file))
    } else {
        installed::installed_repo_ids().contains(repo_id)
    };
    install_block_for(Some(bytes), &DeviceInfo::detect(), installed)
}

/// Detect and install the multimodal projector ("vision adapter") for a GGUF
/// model in `repo_id`, binding it to `model_stem`. Fetches the repo tree, picks
/// the best projector ([`pick_mmproj`]), and downloads it. Returns the installed
/// projector filename, or `None` when the repo is text-only. Surfaces failures
/// as `Err` so callers can warn-and-continue — vision is a bonus, never a
/// blocker for chat. Reused by the onboarding default-model path.
pub async fn install_companion_mmproj(
    client: &reqwest::Client,
    endpoint: &HfEndpoint,
    repo_id: &str,
    model_stem: &str,
    downloads: &ryu_downloads::DownloadCenter,
) -> Result<Option<String>> {
    let sizes = fetch_tree_sizes(client, endpoint, repo_id, ModelFormat::Gguf).await?;
    let Some((filename, _size, sha)) = pick_mmproj(&sizes) else {
        return Ok(None);
    };
    download_mmproj(endpoint, repo_id, model_stem, &filename, sha, downloads).await?;
    Ok(Some(filename))
}

pub async fn install_file(
    client: &reqwest::Client,
    endpoint: &HfEndpoint,
    repo_id: &str,
    filename: &str,
    downloads: &ryu_downloads::DownloadCenter,
) -> Result<InstallResult> {
    // Security: both come straight from the install endpoint's JSON body. Reject
    // path-traversal filenames (the stem becomes an on-disk path) and malformed
    // repo ids (interpolated into Hub URLs) before any download or write. A
    // subfoldered Hub path is downloaded from its full path and stored under
    // its basename.
    validate_hub_gguf_path(filename)?;
    if is_imatrix_filename(filename) {
        anyhow::bail!("importance matrix files are not runnable model weights: {filename}");
    }
    validate_repo_id(repo_id)?;

    let stem = local_stem(filename);
    let url = format!("{}/{repo_id}/resolve/main/{filename}", endpoint.host);

    // Pull the expected sha256 (and size) from the tree so the download is
    // checksum-verified; empty sha falls back to no verification.
    //
    // A FAILED tree lookup during an UPDATE is an error, not "no checksum".
    // Defaulting it let an update with a rate-limited Hub skip the download (the
    // old file matched its own recorded checksum), report success, and record no
    // size — which then hid the model from `/api/models/updates` for good.
    //
    // A FIRST install keeps the old posture (download unverified, as before):
    // a gated repo, a Hub 429 or a mirror without the tree API must not make a
    // model uninstallable. Only an update of a file already on disk needs the
    // listing, because without it there is nothing to tell the old file apart.
    let sizes = match fetch_tree_sizes(client, endpoint, repo_id, ModelFormat::Gguf).await {
        Ok(sizes) => sizes,
        Err(error) if !installed::model_file_path(&stem).exists() => {
            tracing::warn!(
                "listing files in {repo_id} failed; installing {filename} unverified: {error:#}"
            );
            Default::default()
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("listing files in {repo_id} to update {filename}"))
        }
    };
    let (size_bytes, sha) = sizes.get(filename).cloned().unwrap_or((None, None));

    // Route through the global DownloadCenter: streams to a `.part` file with
    // live progress + pause/resume/cancel, verifies the checksum, and records the
    // version — replacing the old whole-file-into-RAM GgufDownloader path.
    let path = downloads
        .download_blocking(gguf_download_spec(
            &stem,
            &url,
            &sha.unwrap_or_default(),
            &format!("{repo_id} ({filename})"),
            // A user-installed GGUF from the catalog. `ggufFileRole` on the client
            // still refines a draft/MTP head out of the filename; the role here is
            // what the row badges by default.
            ryu_downloads::DownloadRole::ChatModel,
        ))
        .await
        .with_context(|| format!("downloading {filename} from {repo_id}"))?;

    // Auto-install the vision adapter when this repo ships a projector, binding
    // it to the model's stem (`<stem>.mmproj.gguf`) so the launch path loads it
    // automatically. Best-effort: a vision model still chats as text-only if the
    // adapter download fails, and a text-only repo simply has no projector. The
    // model quant itself never matches `mmproj`, so it is never re-fetched.
    let mmproj = match pick_mmproj(&sizes) {
        Some((mm_name, _sz, mm_sha)) if mm_name != filename => {
            match download_mmproj(endpoint, repo_id, &stem, &mm_name, mm_sha, downloads).await {
                Ok(p) => {
                    tracing::info!("installed vision adapter {mm_name} -> {}", p.display());
                    Some(mm_name)
                }
                Err(e) => {
                    tracing::warn!("vision adapter download failed for {repo_id}: {e:#}");
                    None
                }
            }
        }
        _ => None,
    };

    installed::record(installed::InstalledModel {
        repo_id: repo_id.to_string(),
        filename: filename.to_string(),
        stem,
        size_bytes,
        format: ModelFormat::Gguf,
        mmproj,
        finetune_base: None,
    })?;

    // The installed state just changed — drop cached detail for this repo and all
    // cached lists so the "Installed" badge is correct on the next fetch.
    cache_invalidate(repo_id);
    cache_invalidate("list:");

    Ok(InstallResult {
        repo_id: repo_id.to_string(),
        filename: filename.to_string(),
        path: path.to_string_lossy().to_string(),
    })
}

#[cfg(test)]
#[path = "install_tests.rs"]
mod tests;
