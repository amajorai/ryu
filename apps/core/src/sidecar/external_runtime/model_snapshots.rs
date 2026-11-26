//! Fetch of the exact Hugging Face model files a runtime declares (`model_snapshots`).
// test-exempt: moved verbatim out of sidecar/external_runtime.rs by the module split; covered by sidecar/external_runtime/tests.rs.

use super::*;

#[derive(Debug, Deserialize)]
struct HfTreeEntry {
    #[serde(rename = "type")]
    kind: String,
    path: String,
    #[serde(default)]
    lfs: Option<HfLfsEntry>,
}

#[derive(Debug, Deserialize)]
struct HfLfsEntry {
    oid: String,
}

fn model_snapshot_tree_path(owner: &str, repo: &str, revision: &str) -> String {
    format!("/api/models/{owner}/{repo}/tree/{revision}")
}

pub(super) fn model_snapshot_tree_url(owner: &str, repo: &str, revision: &str) -> String {
    format!(
        "{HF_RESOLVE_HOST}{}?recursive=true&expand=true&limit={HF_TREE_PAGE_SIZE}",
        model_snapshot_tree_path(owner, repo, revision)
    )
}

pub(super) fn next_hf_tree_page_url(
    link_header: &str,
    expected_path: &str,
) -> Result<Option<url::Url>, &'static str> {
    for link in link_header.split(',') {
        let Some((target, parameters)) = link.split_once('>') else {
            continue;
        };
        let Some(target) = target.trim().strip_prefix('<') else {
            continue;
        };
        let is_next = parameters.split(';').any(|parameter| {
            let parameter = parameter.trim();
            parameter.eq_ignore_ascii_case("rel=next")
                || parameter.eq_ignore_ascii_case("rel=\"next\"")
        });
        if !is_next {
            continue;
        }

        let page = url::Url::parse(target.trim()).map_err(|_| "invalid next-page URL")?;
        if page.scheme() != "https"
            || page.host_str() != Some("huggingface.co")
            || page.port().is_some()
            || !page.username().is_empty()
            || page.password().is_some()
            || page.path() != expected_path
        {
            return Err("next-page URL left the pinned Hugging Face tree endpoint");
        }
        return Ok(Some(page));
    }
    Ok(None)
}

/// Fetch the exact files named by each model snapshot declaration. The Hub tree
/// listing is metadata only; every model byte still goes through DownloadCenter
/// for resume, progress, and checksum verification when the Hub exposes an LFS
/// digest.
pub(super) fn model_snapshot_download_spec(
    snapshot: &ModelSnapshotSpec,
    repository: (&str, &str),
    relative: &str,
    destination_path: PathBuf,
    checksum: Option<String>,
) -> crate::downloads::DownloadSpec {
    let (owner, repo) = repository;
    crate::downloads::DownloadSpec {
        kind: crate::downloads::DownloadKind::Model,
        role: crate::downloads::DownloadRole::PluginModel,
        label: format!("{} ({relative})", snapshot.source),
        url: format!(
            "{HF_RESOLVE_HOST}/{owner}/{repo}/resolve/{}/{relative}",
            snapshot.revision
        ),
        dest: destination_path,
        sha256: checksum,
        version_record: Some(crate::downloads::VersionRecord {
            store_key: format!("plugin-model:{}:{relative}", snapshot.source),
            version: snapshot.revision.clone(),
        }),
    }
}

pub(super) async fn fetch_model_snapshots(
    cfg: &ExternalRuntimeConfig,
    runtime_dir: &Path,
    downloads: &crate::downloads::DownloadCenter,
) -> Result<(), ProvisionError> {
    for snapshot in &cfg.model_snapshots {
        let (owner, repo) = parse_model_source(&snapshot.source)?;
        if !validate_model_revision(&snapshot.revision) {
            return Err(ProvisionError::InvalidModelSnapshot(format!(
                "revision '{}' is not a safe immutable Hub revision",
                snapshot.revision
            )));
        }
        let destination = Path::new(snapshot.dest_under_runtime.trim());
        if !is_safe_rel_dir(destination) || snapshot.dest_under_runtime.trim().is_empty() {
            return Err(ProvisionError::UnsafePackagePath(format!(
                "model destination '{}' is not traversal-safe",
                snapshot.dest_under_runtime
            )));
        }
        if snapshot.files.is_empty() {
            return Err(ProvisionError::InvalidModelSnapshot(format!(
                "{} declares no files",
                snapshot.source
            )));
        }

        let snapshot_root = runtime_dir.join(destination);
        let marker = snapshot_root.join(".ryu-model-snapshot");
        let marker_value = format!(
            "{}\n{}",
            snapshot.revision,
            snapshot
                .files
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        );
        let marker_matches = tokio::fs::read_to_string(&marker)
            .await
            .map(|contents| contents == marker_value)
            .unwrap_or(false);
        if marker_matches
            && snapshot
                .files
                .iter()
                .all(|relative| snapshot_root.join(relative).is_file())
        {
            tracing::info!(
                "model snapshot already provisioned, skipping Hub metadata: {}",
                snapshot.source
            );
            continue;
        }

        let tree_path = model_snapshot_tree_path(&owner, &repo, &snapshot.revision);
        let mut next_page = Some(model_snapshot_tree_url(&owner, &repo, &snapshot.revision));
        let mut page_count = 0;
        let mut files: HashMap<String, Option<String>> = HashMap::new();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| ProvisionError::AssetFetch {
                source: snapshot.source.clone(),
                reason: error.to_string(),
            })?;
        while let Some(api_url) = next_page.take() {
            page_count += 1;
            let parsed = crate::server::screen_agent_egress_url(&api_url)
                .await
                .map_err(|error| ProvisionError::AssetFetch {
                    source: snapshot.source.clone(),
                    reason: error.to_string(),
                })?;
            if parsed.scheme() != "https"
                || parsed.host_str() != Some("huggingface.co")
                || parsed.port().is_some()
                || parsed.path() != tree_path
            {
                return Err(ProvisionError::AssetFetch {
                    source: snapshot.source.clone(),
                    reason: "model snapshot metadata must stay on the expected https://huggingface.co tree endpoint".to_owned(),
                });
            }

            let response = crate::hf_auth::authorize(&api_url, client.get(&api_url))
                .send()
                .await
                .map_err(|error| ProvisionError::AssetFetch {
                    source: snapshot.source.clone(),
                    reason: error.to_string(),
                })?;
            if !response.status().is_success() {
                return Err(ProvisionError::AssetFetch {
                    source: snapshot.source.clone(),
                    reason: format!("Hub tree listing returned {}", response.status()),
                });
            }
            if response
                .content_length()
                .is_some_and(|length| length > MAX_HF_TREE_PAGE_BYTES as u64)
            {
                return Err(ProvisionError::AssetFetch {
                    source: snapshot.source.clone(),
                    reason: "Hub tree metadata page exceeds the 1 MiB limit".to_owned(),
                });
            }
            let link_header = response
                .headers()
                .get(reqwest::header::LINK)
                .and_then(|header| header.to_str().ok())
                .map(str::to_owned);
            let mut response = response;
            let mut body = Vec::new();
            while let Some(chunk) =
                response
                    .chunk()
                    .await
                    .map_err(|error| ProvisionError::AssetFetch {
                        source: snapshot.source.clone(),
                        reason: error.to_string(),
                    })?
            {
                if body.len().saturating_add(chunk.len()) > MAX_HF_TREE_PAGE_BYTES {
                    return Err(ProvisionError::AssetFetch {
                        source: snapshot.source.clone(),
                        reason: "Hub tree metadata page exceeds the 1 MiB limit".to_owned(),
                    });
                }
                body.extend_from_slice(&chunk);
            }
            let entries: Vec<HfTreeEntry> =
                serde_json::from_slice(&body).map_err(|error| ProvisionError::AssetFetch {
                    source: snapshot.source.clone(),
                    reason: format!("invalid Hub tree listing: {error}"),
                })?;
            for entry in entries {
                if entry.kind != "file" || !snapshot.files.contains(&entry.path) {
                    continue;
                }
                let checksum = entry
                    .lfs
                    .filter(|lfs| {
                        lfs.oid.len() == 64 && lfs.oid.bytes().all(|b| b.is_ascii_hexdigit())
                    })
                    .map(|lfs| lfs.oid);
                files.insert(entry.path, checksum);
            }
            if snapshot
                .files
                .iter()
                .all(|relative| files.contains_key(relative))
            {
                break;
            }
            if page_count >= MAX_HF_TREE_PAGES {
                return Err(ProvisionError::InvalidModelSnapshot(format!(
                    "Hub tree listing exceeded the {MAX_HF_TREE_PAGES}-page limit before all requested files were found"
                )));
            }
            next_page = match link_header.as_deref() {
                Some(header) => next_hf_tree_page_url(header, &tree_path)
                    .map_err(|reason| ProvisionError::AssetFetch {
                        source: snapshot.source.clone(),
                        reason: reason.to_owned(),
                    })?
                    .map(|url| url.to_string()),
                None => None,
            };
        }

        let mut seen = BTreeMap::new();
        for relative in &snapshot.files {
            if !is_safe_model_path(relative) {
                return Err(ProvisionError::InvalidModelSnapshot(format!(
                    "unsafe model file path '{relative}'"
                )));
            }
            if seen.insert(relative, ()).is_some() {
                return Err(ProvisionError::InvalidModelSnapshot(format!(
                    "duplicate model file path '{relative}'"
                )));
            }
            let Some(checksum) = files.get(relative) else {
                return Err(ProvisionError::InvalidModelSnapshot(format!(
                    "Hub repository does not contain '{relative}' at revision '{}'",
                    snapshot.revision
                )));
            };
            let destination_path = snapshot_root.join(relative);
            if let Some(parent) = destination_path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(ProvisionError::Mkdir)?;
            }
            if checksum.is_none() && destination_path.exists() {
                continue;
            }
            downloads
                .download_blocking(model_snapshot_download_spec(
                    snapshot,
                    (&owner, &repo),
                    relative,
                    destination_path,
                    checksum.clone(),
                ))
                .await
                .map_err(|error| ProvisionError::AssetFetch {
                    source: format!("{}:{relative}", snapshot.source),
                    reason: error.to_string(),
                })?;
        }

        let marker_tmp = marker.with_extension("part");
        tokio::fs::write(&marker_tmp, marker_value.as_bytes())
            .await
            .map_err(ProvisionError::Mkdir)?;
        tokio::fs::rename(&marker_tmp, &marker)
            .await
            .map_err(ProvisionError::Mkdir)?;
    }
    Ok(())
}
