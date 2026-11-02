//! Model detail (info, tree sizes, README) and the cached JSON wrappers.

use super::*;

#[derive(serde::Deserialize)]
pub(crate) struct HfModelInfo {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) downloads: u64,
    #[serde(default)]
    pub(crate) likes: u64,
    #[serde(default)]
    pub(crate) tags: Vec<String>,
    #[serde(default)]
    pub(crate) pipeline_tag: Option<String>,
    #[serde(default)]
    pub(crate) gated: serde_json::Value,
    #[serde(default, rename = "lastModified")]
    pub(crate) last_modified: Option<String>,
    #[serde(default, rename = "createdAt")]
    pub(crate) created_at: Option<String>,
    #[serde(default)]
    pub(crate) gguf: Option<HfGguf>,
    #[serde(default)]
    pub(crate) siblings: Vec<HfSibling>,
}

#[derive(serde::Deserialize)]
pub(crate) struct HfSibling {
    pub(crate) rfilename: String,
}

#[derive(serde::Deserialize)]
pub(crate) struct HfTreeEntry {
    #[serde(default)]
    pub(crate) path: String,
    #[serde(default)]
    pub(crate) size: u64,
    #[serde(default)]
    pub(crate) lfs: Option<HfLfs>,
}

#[derive(serde::Deserialize)]
pub(crate) struct HfLfs {
    #[serde(default)]
    pub(crate) oid: Option<String>,
    #[serde(default)]
    pub(crate) size: u64,
}

/// Fetch the full detail for one model. For GGUF this is the per-file quant list
/// with device-fit; for a snapshot format (safetensors/MLX) `files` is empty and
/// the repo-level `repo_*` fields carry the total size + a **conservative** fit
/// verdict (these engines load the whole repo, so the optimistic GGUF
/// "partial offload" copy must not be reused). `format` is the facet the client
/// was browsing.
pub async fn model_detail(
    client: &reqwest::Client,
    endpoint: &HfEndpoint,
    id: &str,
    format: ModelFormat,
) -> Result<ModelDetail> {
    // Defense-in-depth: the id is interpolated into the info/tree/README URLs.
    // The install path already validates, but with a custom (user-supplied) host
    // the detail path is also attacker-reachable, so reject unsafe ids here too.
    validate_repo_id(id)?;
    let info_url = format!("{}/models/{id}", endpoint.api_base);
    let resp = hf_get(client, &info_url)
        .send()
        .await
        .context("requesting model info")?;
    if !resp.status().is_success() {
        anyhow::bail!("Hugging Face model info returned HTTP {}", resp.status());
    }
    let info: HfModelInfo = resp.json().await.context("parsing model info")?;

    let device = DeviceInfo::detect();
    let installed_set = installed::installed_repo_ids();
    let (author, name) = split_id(&info.id);

    // File sizes + LFS checksums come from the tree endpoint (siblings carry
    // only filenames). Best-effort: if the tree call fails we still list files
    // without sizes rather than failing the whole detail view. The tree is
    // filtered to this format's weight files.
    let sizes = fetch_tree_sizes(client, endpoint, id, format)
        .await
        .unwrap_or_default();

    // GGUF: per-file quant list with per-file device-fit (unchanged behaviour).
    // Snapshot: no per-file picker — leave `files` empty and use repo-level fit.
    // A GGUF vision model ships its projector as a separate `mmproj-*.gguf`. It
    // is not a selectable weight quant, so keep it out of the picker — but record
    // that the repo is vision-capable so the UI can badge it and the user knows
    // the adapter is auto-installed alongside whichever quant they pick.
    let vision = format == ModelFormat::Gguf
        && info.siblings.iter().any(|s| {
            s.rfilename.to_lowercase().ends_with(".gguf") && is_mmproj_filename(&s.rfilename)
        });

    // The projector the install adds beside whichever quant is picked: it needs
    // disk and memory too, so a vision quant's fit counts both.
    let mmproj_bytes = if vision {
        pick_mmproj(&sizes).and_then(|(_, size, _)| size)
    } else {
        None
    };

    let mut files: Vec<GgufFile> = if format == ModelFormat::Gguf {
        info.siblings
            .iter()
            .filter(|s| {
                s.rfilename.to_lowercase().ends_with(".gguf")
                    && !is_mmproj_filename(&s.rfilename)
                    && !is_imatrix_filename(&s.rfilename)
            })
            .map(|s| {
                let (size_bytes, sha256) = sizes.get(&s.rfilename).cloned().unwrap_or((None, None));
                let stem = local_stem(&s.rfilename);
                let installed = models_dir_has(&stem);
                let fit_bytes = size_bytes.map(|b| b.saturating_add(mmproj_bytes.unwrap_or(0)));
                // On disk already: only memory matters. Not yet: free disk too.
                let fit = if installed {
                    estimate_fit(fit_bytes, &device)
                } else {
                    estimate_install_fit(fit_bytes, &device)
                };
                GgufFile {
                    quant: parse_quant(&s.rfilename),
                    size_human: size_bytes.map(human_bytes).unwrap_or_default(),
                    size_bytes,
                    sha256,
                    url: format!("{}/{id}/resolve/main/{}", endpoint.host, s.rfilename),
                    installed,
                    fit: fit.as_str().to_string(),
                    fit_label: fit.label().to_string(),
                    filename: s.rfilename.clone(),
                }
            })
            .collect()
    } else {
        Vec::new()
    };

    // Installed files float to the top (so what you have is always visible
    // first); within each group, smallest-first puts the friendliest (most
    // likely to fit) option on top.
    files.sort_by(|a, b| {
        b.installed.cmp(&a.installed).then(
            a.size_bytes
                .unwrap_or(u64::MAX)
                .cmp(&b.size_bytes.unwrap_or(u64::MAX)),
        )
    });

    // Repo-level snapshot size + conservative fit (empty for GGUF).
    let (repo_size_bytes, repo_fit, repo_fit_label) = if format == ModelFormat::Gguf {
        (None, String::new(), String::new())
    } else {
        let total: u64 = sizes.values().filter_map(|(s, _)| *s).sum();
        let total = (total > 0).then_some(total);
        let (fit, label) = snapshot_fit(total, &device, installed_set.contains(&info.id));
        (total, fit, label)
    };

    let readme = fetch_readme(client, endpoint, id).await;
    let stats = aa::stats_for(client, &name, &info.id).await;

    let (compatible, needs_engine) = format_compat(format);
    let (context_length, architecture, params) = gguf_fields(&info.gguf);
    let diffusion = info
        .pipeline_tag
        .as_deref()
        .map(is_diffusion_pipeline_tag)
        .unwrap_or_else(|| {
            architecture
                .as_deref()
                .is_some_and(gguf::is_diffusion_architecture)
        });
    let card = ModelCard {
        installed: installed_set.contains(&info.id) || files.iter().any(|f| f.installed),
        author,
        name,
        downloads: info.downloads,
        likes: info.likes,
        pipeline_tag: info.pipeline_tag,
        tags: info.tags,
        gated: gated_to_bool(&info.gated),
        last_modified: info.last_modified,
        created_at: info.created_at,
        context_length,
        architecture,
        params,
        id: info.id.clone(),
        format,
        compatible,
        needs_engine,
        diffusion,
    };

    Ok(ModelDetail {
        card,
        readme,
        format,
        files,
        vision,
        repo_size_bytes,
        repo_fit,
        repo_fit_label,
        stats,
        stats_api_key_present: aa::has_api_key(),
        device,
    })
}

/// Repo-level fit verdict for a snapshot model. Unlike GGUF, vLLM/MLX load the
/// whole repo into memory, so anything short of a clean GPU fit gets an explicit
/// "may be slow" sentence rather than the optimistic "partial offload" copy, and
/// only a repo that overflows system memory reads `too_big` (blocked, matching
/// the install refusal in [`install_preflight`]).
/// A repo not yet `installed` that cannot be stored reads `no_space` (with the
/// numbers) ahead of any memory verdict.
pub(crate) fn snapshot_fit(
    total: Option<u64>,
    device: &DeviceInfo,
    installed: bool,
) -> (String, String) {
    let Some(bytes) = total else {
        return (
            "unknown".to_string(),
            "Size unknown — check the model card before installing.".to_string(),
        );
    };
    let verdict = if installed {
        estimate_fit(Some(bytes), device)
    } else {
        estimate_install_fit(Some(bytes), device)
    };
    match verdict {
        FitVerdict::Great | FitVerdict::Ok => {
            (verdict.as_str().to_string(), verdict.label().to_string())
        }
        FitVerdict::NoSpace => (
            verdict.as_str().to_string(),
            format!(
                "Not enough free disk space — this {} model needs {} free, only {} is free.",
                human_bytes(bytes),
                human_bytes(bytes.saturating_add(device::DISK_HEADROOM_BYTES)),
                device.disk_free_human
            ),
        ),
        FitVerdict::Unknown => (
            "unknown".to_string(),
            "Can't check your device — verify the model fits before installing.".to_string(),
        ),
        FitVerdict::TooBig => (
            verdict.as_str().to_string(),
            format!(
                "This {} model won't fit — these engines load the whole repo into memory, and \
                 that needs about {} on this {} device.",
                human_bytes(bytes),
                human_bytes(device::system_ram_need_bytes(bytes)),
                device.ram_human
            ),
        ),
        // Partial / Cpu: it fits in system memory, so it is allowed, but these
        // engines want the whole repo on the GPU — warn that it may be slow.
        FitVerdict::Partial | FitVerdict::Cpu => (
            verdict.as_str().to_string(),
            format!(
                "This {} model doesn't fully fit your GPU — it may be slow, since these engines \
                 load the whole repo into memory.",
                human_bytes(bytes)
            ),
        ),
    }
}

/// Map of repo-relative path → (size_bytes, sha256) from the Hub tree endpoint,
/// restricted to the weight + config files of `format`. The keys are the
/// recursive repo-relative paths, so a snapshot install can mirror the tree
/// under the snapshot dir. GGUF callers pass `ModelFormat::Gguf` for identical
/// `.gguf`-only behaviour.
pub(crate) async fn fetch_tree_sizes(
    client: &reqwest::Client,
    endpoint: &HfEndpoint,
    id: &str,
    format: ModelFormat,
) -> Result<std::collections::HashMap<String, (Option<u64>, Option<String>)>> {
    let url = format!("{}/models/{id}/tree/main?recursive=true", endpoint.api_base);
    let resp = hf_get(client, &url).send().await?;
    if !resp.status().is_success() {
        anyhow::bail!("tree HTTP {}", resp.status());
    }
    let entries: Vec<HfTreeEntry> = resp.json().await?;
    let mut map = std::collections::HashMap::new();
    for e in entries {
        let lower = e.path.to_lowercase();
        if !format
            .weight_extensions()
            .iter()
            .any(|ext| lower.ends_with(ext))
        {
            continue;
        }
        // Importance matrices are GGUF-shaped quantization inputs, not model
        // weights. Keep them out of the GGUF size/checksum map while preserving
        // mmproj files for the companion-adapter picker below.
        if format == ModelFormat::Gguf && is_imatrix_filename(&e.path) {
            continue;
        }
        let (size, sha) = match e.lfs {
            // LFS files: the lfs block carries the real size + sha256 oid.
            Some(lfs) => (Some(if lfs.size > 0 { lfs.size } else { e.size }), lfs.oid),
            None => (if e.size > 0 { Some(e.size) } else { None }, None),
        };
        map.insert(e.path, (size, sha));
    }
    Ok(map)
}

/// Fetch + clean the README. Strips a leading YAML front-matter block (the
/// `--- ... ---` metadata) that only adds noise for a reader. Returns `None`
/// when the repo has no README or the fetch fails.
pub(crate) async fn fetch_readme(
    client: &reqwest::Client,
    endpoint: &HfEndpoint,
    id: &str,
) -> Option<String> {
    let url = format!("{}/{id}/raw/main/README.md", endpoint.host);
    let resp = hf_get(client, &url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let raw = resp.text().await.ok()?;
    Some(strip_front_matter(&raw))
}

/// Remove a leading `---\n...\n---\n` YAML front-matter block if present.
pub(crate) fn strip_front_matter(md: &str) -> String {
    let trimmed = md.trim_start();
    if let Some(rest) = trimmed.strip_prefix("---") {
        // Find the closing delimiter on its own line.
        if let Some(end) = rest.find("\n---") {
            let after = &rest[end + 4..];
            return after.trim_start_matches(['\n', '\r']).to_string();
        }
    }
    md.to_string()
}

/// Cached form of [`search_models`], returning
/// `{ "models": [...], "next_cursor": "…"|null }`. The installed-only view is
/// never cached (it's local + must stay fresh).
pub async fn search_models_json(
    client: &reqwest::Client,
    endpoint: &HfEndpoint,
    query: &str,
    sort: CatalogSort,
    format: ModelFormat,
    limit: usize,
    installed_only: bool,
    task: &str,
    author: &str,
    cursor: Option<&str>,
) -> Result<serde_json::Value> {
    // `format`, `task`, `author` and `cursor` are part of the cache key: without
    // them, switching format/category/org or paging would collide on the same
    // cached list. The endpoint host is prefixed so two sources never serve each
    // other's cached results.
    let key = format!(
        "list:{}:{}:{}:{limit}:{task}:{author}:{}:{query}",
        endpoint.cache_tag(),
        format.as_str(),
        sort.hf_key(),
        cursor.unwrap_or("")
    );
    if !installed_only {
        if let Some(v) = cache_get(&key, LIST_TTL) {
            return Ok(v);
        }
    }
    let page = search_models(
        client,
        endpoint,
        query,
        sort,
        format,
        limit,
        installed_only,
        task,
        author,
        cursor,
    )
    .await?;
    let value = serde_json::json!({ "models": page.models, "next_cursor": page.next_cursor });
    if !installed_only {
        cache_put(key, value.clone());
    }
    Ok(value)
}

/// Cached form of [`model_detail`], returning the serialized detail object.
pub async fn model_detail_json(
    client: &reqwest::Client,
    endpoint: &HfEndpoint,
    id: &str,
    format: ModelFormat,
) -> Result<serde_json::Value> {
    let key = format!("detail:{}:{}:{id}", endpoint.cache_tag(), format.as_str());
    if let Some(v) = cache_get(&key, DETAIL_TTL) {
        return Ok(v);
    }
    let detail = model_detail(client, endpoint, id, format).await?;
    let value = serde_json::to_value(detail)?;
    cache_put(key, value.clone());
    Ok(value)
}

#[cfg(test)]
#[path = "detail_tests.rs"]
mod tests;
