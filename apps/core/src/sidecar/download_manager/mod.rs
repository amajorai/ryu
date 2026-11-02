//! Generic sidecar download manager.
//!
//! The shared helpers every engine, agent and tool downloader installs through:
//! data-dir paths, the HTTP client and retry policy, checksum discovery
//! ([`checksums`]), bounded archive extraction ([`archive`] and
//! [`archive_flatten`]), and the `versions.json` record ([`version_store`]).
//! Every executable these helpers fetch goes through `DownloadCenter` with a
//! SHA-256 pin; there is no unverified install path here.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};

use ryu_sidecar_runtime::layout;

mod archive;
mod archive_flatten;
mod checksums;
mod version_store;

pub(crate) use archive::{
    extract_from_tar_gz, extract_from_zip, extract_tar_bz2_to_dir, extract_tar_gz_to_dir,
    extract_zip_to_dir, DEFAULT_EXTRACT_CAP_BYTES,
};
pub(crate) use archive_flatten::{
    extract_all_to_dir_from, extract_binary_with_libs, extract_binary_with_libs_from,
};
pub(crate) use checksums::{
    fetch_github_release, fetch_sibling_sha256, require_release_asset_sha256, sha256_sibling_url,
};
pub use version_store::VersionStore;

// ── Platform helpers ──────────────────────────────────────────────────────────

pub(crate) fn ryu_dir() -> PathBuf {
    crate::paths::ryu_dir()
}

/// `<data dir>/bin` — small standalone tools. Inference engines live under
/// `engines/<group>/<engine>/` instead (see [`engine_dir`]).
pub(crate) fn bin_dir() -> PathBuf {
    layout::bin_dir(&ryu_dir())
}

/// `<data dir>/engines/<group>/<engine>` — one folder per inference engine.
pub(crate) fn engine_dir(group: layout::EngineGroup, engine: &str) -> PathBuf {
    layout::engine_dir(&ryu_dir(), group, engine)
}

/// `<data dir>/models/<modality>` — the weights folder for one modality.
pub(crate) fn models_dir(modality: layout::Modality) -> PathBuf {
    layout::models_dir(&ryu_dir(), modality)
}

/// `<data dir>/models/<modality>/<family>` — one engine's/family's weights.
pub(crate) fn model_family_dir(modality: layout::Modality, family: &str) -> PathBuf {
    layout::model_family_dir(&ryu_dir(), modality, family)
}

/// `<data dir>/tmp/downloads` — staging for archives and partial downloads.
pub(crate) fn tmp_dir() -> PathBuf {
    layout::tmp_dir_for(&ryu_dir(), "downloads")
}

fn versions_path() -> PathBuf {
    layout::state_path(&ryu_dir(), "versions.json")
}

// ── Shared download utilities ─────────────────────────────────────────────────

/// Deadline for the small metadata requests an install makes before its
/// transfer starts (release JSON, checksum files). [`build_http_client`] sets no
/// timeout and DownloadCenter's own deadlines only cover the transfer, so a
/// stalled host here would otherwise hang the install indefinitely. A reqwest
/// request timeout also covers reading the response body.
const METADATA_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Build a shared `reqwest::Client` with the standard ryu user-agent.
pub(crate) fn build_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("ryu-core/0.1")
        .build()
        .expect("reqwest client")
}

/// Retry `f` up to `max_attempts` times with exponential backoff.
/// `label` is used only in log messages (e.g. `"zeroclaw"`).
pub(crate) async fn retry_download<F, Fut, T>(
    label: &str,
    max_attempts: u32,
    mut f: F,
) -> anyhow::Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<T>>,
{
    let mut last_err = anyhow::anyhow!("no attempts made");
    for attempt in 1..=max_attempts {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last_err = e;
                if attempt < max_attempts {
                    let delay = std::time::Duration::from_secs(1u64 << (attempt - 1));
                    tracing::warn!(
                        "{label}: attempt {attempt}/{max_attempts} failed, retrying in {}s: {last_err:#}",
                        delay.as_secs()
                    );
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }
    Err(last_err)
}

/// Issue a GET, attaching the Hugging Face access token for Hub hosts and
/// turning a gated `401`/`403` into an actionable error (token + license terms),
/// rather than a bare HTTP status. Non-HF hosts pass through unchanged.
async fn hf_aware_get(client: &reqwest::Client, url: &str) -> anyhow::Result<reqwest::Response> {
    let is_hf = crate::hf_auth::is_hf_url(url);
    let req = crate::hf_auth::authorize(url, client.get(url));
    let response = req.send().await.with_context(|| format!("GET {url}"))?;
    let status = response.status();
    if is_hf
        && (status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN)
    {
        anyhow::bail!(
            "Hugging Face refused this download (HTTP {}). This model is gated — \
             set a Hugging Face access token in Settings → Integrations and accept \
             the model's terms on its Hugging Face page, then try again.",
            status.as_u16()
        );
    }
    response
        .error_for_status()
        .with_context(|| format!("HTTP error for {url}"))
}

/// Download `url` entirely into memory, emitting progress events tagged with `name`.
pub(crate) async fn download_to_memory(
    client: &reqwest::Client,
    url: &str,
    name: &str,
    on_progress: Option<&ProgressCallback>,
) -> anyhow::Result<Vec<u8>> {
    let response = hf_aware_get(client, url).await?;

    let total = response.content_length();
    let mut downloaded: u64 = 0;
    let mut data = Vec::with_capacity(total.unwrap_or(0) as usize);
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("stream error")?;
        data.extend_from_slice(&chunk);
        downloaded += chunk.len() as u64;

        if let Some(cb) = on_progress {
            cb(ProgressEvent {
                name: name.to_string(),
                total_bytes: total,
                downloaded_bytes: downloaded,
                done: false,
            });
        }
    }

    if let Some(cb) = on_progress {
        cb(ProgressEvent {
            name: name.to_string(),
            total_bytes: total,
            downloaded_bytes: downloaded,
            done: true,
        });
    }

    Ok(data)
}

// ── Progress reporting ────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ProgressEvent {
    pub name: String,
    pub total_bytes: Option<u64>,
    pub downloaded_bytes: u64,
    pub done: bool,
}

pub type ProgressCallback = Arc<dyn Fn(ProgressEvent) + Send + Sync>;

// ── Core download logic ───────────────────────────────────────────────────────

/// SHA-256 of a file, streamed through a fixed buffer on the blocking pool so
/// verifying a large engine or model archive never loads it whole into memory.
pub(crate) async fn compute_sha256(path: &Path) -> Result<String> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<String> {
        use std::io::Read;
        let mut file = std::fs::File::open(&path)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0_u8; 4 * 1024 * 1024];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(hex::encode(hasher.finalize()))
    })
    .await?
}

#[cfg(test)]
mod tests;
