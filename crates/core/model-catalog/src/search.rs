//! Hub search and the installed-only card view.

use super::*;

#[derive(serde::Deserialize)]
pub(crate) struct HfListItem {
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
}

/// The Hub's parsed GGUF metadata block (`gguf` on a model). The Hub reads this
/// from a representative GGUF file in the repo, so it is repo-level, not
/// per-quant. Returned in detail by default and in list responses when the
/// `gguf` expand field is requested (see [`search_models`]).
#[derive(serde::Deserialize)]
pub(crate) struct HfGguf {
    /// Context window in tokens (the single prompt+completion budget).
    #[serde(default)]
    pub(crate) context_length: Option<u64>,
    /// Architecture id, e.g. `"llama"`, `"gemma3"`.
    #[serde(default)]
    pub(crate) architecture: Option<String>,
    /// Total parameter count.
    #[serde(default)]
    pub(crate) total: Option<u64>,
}

/// Restrict a search to one Hugging Face task. `task` is a raw HF `pipeline_tag`
/// value (e.g. `"sentence-similarity"` for embeddings, `"text-generation"` for
/// chat, `"automatic-speech-recognition"` for speech-to-text). The friendly
/// category → tag mapping lives in the client; Core just forwards the tag so the
/// taxonomy stays swappable and no category is hardcoded here. An empty string
/// means "any task". HF accepts a single `pipeline_tag` value, so this filter is
/// single-select by nature.
pub(crate) fn sanitize_task(task: &str) -> Option<String> {
    let t = task.trim();
    if t.is_empty() {
        return None;
    }
    // Pipeline tags are lowercase ASCII words joined by hyphens; reject anything
    // else so the value can't smuggle extra query parameters into the Hub URL.
    let ok = t
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    ok.then(|| t.to_string())
}

/// Restrict a search to one Hugging Face org/user (the "browse this org" filter).
/// `author` is a Hub namespace (e.g. `google`, `unsloth`). HF usernames/org names
/// are ASCII alphanumerics with `-`, `_`, and `.`; reject anything else so the
/// value can't smuggle extra query parameters into the Hub URL. Empty = no filter.
pub(crate) fn sanitize_author(author: &str) -> Option<String> {
    let a = author.trim();
    if a.is_empty() {
        return None;
    }
    let ok = a
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.');
    ok.then(|| a.to_string())
}

/// One page of search results: the cards plus an opaque cursor for the next page
/// (`None` when there are no more results, or for the local installed view).
pub struct ModelPage {
    pub models: Vec<ModelCard>,
    pub next_cursor: Option<String>,
}

/// Search the Hub for GGUF models. When `installed_only` is true we bypass the
/// network entirely and return exactly the models the user has downloaded, so
/// the installed view works offline. `task` optionally narrows results to one
/// Hugging Face pipeline tag (see [`sanitize_task`]).
///
/// `cursor` drives infinite-scroll pagination: pass `None` for the first page,
/// then the `next_cursor` of the previous page for each subsequent page. The Hub
/// returns the cursor in a `Link: rel="next"` header (see [`parse_next_cursor`]);
/// it is opaque and already percent-encoded, so we forward it verbatim and never
/// re-encode it. The base params (filter/sort/task/search) must stay identical
/// across pages, which is naturally the case since they form the cache/query key.
pub async fn search_models(
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
) -> Result<ModelPage> {
    if installed_only {
        return Ok(ModelPage {
            models: installed_cards_enriched(client, endpoint).await,
            next_cursor: None,
        });
    }

    let limit = limit.clamp(1, 100);
    let api_base = &endpoint.api_base;
    // Format is a per-call facet (one clean HF cursor per format); the desktop
    // fans out across formats. `filter=gguf` is no longer hardcoded — each
    // format supplies its own Hub filter, and MLX (which has none) is scoped to
    // the `mlx-community` org when the caller didn't already pick an author.
    let mut url = format!(
        "{api_base}/models?sort={}&direction=-1&limit={limit}",
        sort.hf_key()
    );
    if let Some(f) = format.hf_filter() {
        url.push_str(&format!("&filter={f}"));
    }
    if format == ModelFormat::Mlx && sanitize_author(author).is_none() {
        url.push_str("&author=mlx-community");
    }
    // Request the extra columns the cards render via the Hub's `expand`
    // projection — most importantly `gguf` (the context window). `expand`
    // returns *only* the listed fields, so every column the cards use must
    // appear here. An HF-compatible mirror that ignores `expand` simply returns
    // its default shape and the missing fields deserialize to `None` (graceful).
    for field in [
        "gguf",
        "downloads",
        "likes",
        "tags",
        "pipeline_tag",
        "gated",
        "createdAt",
        "lastModified",
    ] {
        url.push_str(&format!("&expand[]={field}"));
    }
    if let Some(tag) = sanitize_task(task) {
        url.push_str(&format!("&pipeline_tag={}", urlencoding::encode(&tag)));
    }
    // Org/user browse filter — restricts to one Hub namespace.
    if let Some(org) = sanitize_author(author) {
        url.push_str(&format!("&author={}", urlencoding::encode(&org)));
    }
    if !query.trim().is_empty() {
        url.push_str(&format!("&search={}", urlencoding::encode(query.trim())));
    }
    // The cursor arrives already percent-encoded (extracted verbatim from the
    // Hub's Link header, decoded exactly once by the client/axum round-trip), so
    // it is appended as-is — re-encoding here would double-encode and break it.
    if let Some(c) = cursor.filter(|c| !c.is_empty()) {
        url.push_str(&format!("&cursor={c}"));
    }

    let resp = hf_get(client, &url)
        .send()
        .await
        .context("requesting Hugging Face model list")?;
    if !resp.status().is_success() {
        anyhow::bail!("Hugging Face list returned HTTP {}", resp.status());
    }
    // Read the pagination cursor from the headers before `.json()` consumes the body.
    let next_cursor = parse_next_cursor(resp.headers().get(reqwest::header::LINK));
    let items: Vec<HfListItem> = resp.json().await.context("parsing model list")?;

    let installed = installed::installed_repo_ids();
    let (compatible, needs_engine) = format_compat(format);
    let models = items
        .into_iter()
        .map(|it| {
            let (author, name) = split_id(&it.id);
            let installed = installed.contains(&it.id);
            let (context_length, architecture, params) = gguf_fields(&it.gguf);
            // Detect diffusion from pipeline_tag first (reliable); fall back to
            // architecture for repos where the tag is absent but the gguf block is.
            let diffusion = it
                .pipeline_tag
                .as_deref()
                .map(is_diffusion_pipeline_tag)
                .unwrap_or_else(|| {
                    architecture
                        .as_deref()
                        .is_some_and(gguf::is_diffusion_architecture)
                });
            ModelCard {
                installed,
                author,
                name,
                downloads: it.downloads,
                likes: it.likes,
                pipeline_tag: it.pipeline_tag,
                tags: it.tags,
                gated: gated_to_bool(&it.gated),
                last_modified: it.last_modified,
                created_at: it.created_at,
                context_length,
                architecture,
                params,
                id: it.id,
                format,
                compatible,
                needs_engine: needs_engine.clone(),
                diffusion,
            }
        })
        .collect();
    Ok(ModelPage {
        models,
        next_cursor,
    })
}

/// Extract the `cursor` value from a Hugging Face `Link` header's `rel="next"`
/// entry, returning it in its original percent-encoded form (so it can be
/// forwarded verbatim into the next request URL). Returns `None` when there is no
/// next page. We extract only the cursor — not the whole next URL — so a malicious
/// header can never redirect the follow-up request elsewhere (SSRF-safe).
pub(crate) fn parse_next_cursor(link: Option<&reqwest::header::HeaderValue>) -> Option<String> {
    let header = link?.to_str().ok()?;
    // A Link header may hold several comma-separated entries; the cursor is
    // base64url+percent-encoded, so it never contains a raw comma.
    for part in header.split(',') {
        if !part.contains("rel=\"next\"") {
            continue;
        }
        let start = part.find('<')? + 1;
        let end = part[start..].find('>')? + start;
        let next_url = &part[start..end];
        let cpos = next_url.find("cursor=")? + "cursor=".len();
        let value = next_url[cpos..]
            .split('&')
            .next()
            .unwrap_or(&next_url[cpos..]);
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

/// Build cards for the offline installed view by scanning the catalog's model
/// directories (`models/{chat,embedding,rerank}/*.gguf`, see
/// [`installed::CATALOG_GGUF_MODALITIES`]) — the same source of truth the per-model
/// `installed` badge uses — and resolving each file's origin repo from the
/// provenance store, falling back to the bundled-default registry entry. Files
/// with no known origin still appear as local entries so nothing the user has
/// downloaded is hidden.
pub(crate) fn installed_cards() -> Vec<ModelCard> {
    // stem → repo_id, from recorded provenance.
    let mut stem_to_repo: std::collections::HashMap<String, String> = installed::load_present()
        .into_iter()
        .map(|m| (m.stem, m.repo_id))
        .collect();

    // The bundled default chat + embedding models are downloaded at onboarding
    // (not via the catalog install endpoint). Newer installs record provenance
    // there, but derive the repo from the registry's weight URL as a fallback so
    // pre-existing installs (and the nomic embedding GGUF) resolve to their real
    // Hugging Face repo instead of showing up as an origin-less `local:` card.
    for (id, weight_url) in host().default_model_repos() {
        if let Some(repo) = repo_from_hf_url(&weight_url) {
            stem_to_repo.entry(id).or_insert(repo);
        }
    }

    // De-dupe by repo (or by stem for origin-less local files), preserving a
    // stable alphabetical order.
    let (gguf_compatible, gguf_needs) = format_compat(ModelFormat::Gguf);
    let mut seen = std::collections::BTreeMap::<String, ModelCard>::new();
    for stem in on_disk_gguf_stems() {
        let (key, id, author, name) = match stem_to_repo.get(&stem) {
            Some(repo) => {
                let (author, name) = split_id(repo);
                (repo.clone(), repo.clone(), author, name)
            }
            None => (
                format!("local:{stem}"),
                String::new(),
                "local".to_string(),
                stem.clone(),
            ),
        };
        // Detect diffusion from the on-disk GGUF metadata (secondary probe; the
        // enriched path below overwrites this with the Hub pipeline_tag when online).
        let diffusion = capabilities::detect_local_is_diffusion(&stem);
        seen.entry(key).or_insert(ModelCard {
            id,
            author,
            name,
            downloads: 0,
            likes: 0,
            pipeline_tag: None,
            tags: Vec::new(),
            gated: false,
            last_modified: None,
            created_at: None,
            context_length: None,
            architecture: None,
            params: None,
            installed: true,
            format: ModelFormat::Gguf,
            compatible: gguf_compatible,
            needs_engine: gguf_needs.clone(),
            diffusion,
        });
    }

    // Snapshot installs (safetensors / MLX) live in a directory, not as a
    // `.gguf` file, so `on_disk_gguf_stems` never sees them — add them from the
    // provenance index (which `load_present` already filters to present-on-disk).
    for m in installed::load_present() {
        if m.format == ModelFormat::Gguf {
            continue;
        }
        let key = if m.repo_id.is_empty() {
            format!("local:{}", m.stem)
        } else {
            m.repo_id.clone()
        };
        let (author, name) = split_id(&m.repo_id);
        let (compatible, needs_engine) = format_compat(m.format);
        seen.entry(key).or_insert(ModelCard {
            id: m.repo_id.clone(),
            author,
            name,
            downloads: 0,
            likes: 0,
            pipeline_tag: None,
            tags: Vec::new(),
            gated: false,
            last_modified: None,
            created_at: None,
            context_length: None,
            architecture: None,
            params: None,
            installed: true,
            format: m.format,
            compatible,
            needs_engine,
            diffusion: false,
        });
    }
    seen.into_values().collect()
}

/// Enrich the offline installed cards with live Hugging Face metadata
/// (downloads, likes, tags, task, gated, dates) so the installed-only view shows
/// the same numbers as the browse list instead of zeros. Best-effort and
/// per-card: a card whose repo can't be resolved (an origin-less `local:` file)
/// or whose fetch fails (offline) keeps its local values, so the installed view
/// still works with no network — it just shows zero counts until reconnected.
pub(crate) async fn installed_cards_enriched(
    client: &reqwest::Client,
    endpoint: &HfEndpoint,
) -> Vec<ModelCard> {
    let mut cards = installed_cards();
    for card in &mut cards {
        // Origin-less local files have no Hub repo to enrich from.
        if card.id.is_empty() {
            continue;
        }
        if let Some(meta) = fetch_card_meta(client, endpoint, &card.id).await {
            card.downloads = meta.downloads;
            card.likes = meta.likes;
            card.tags = meta.tags;
            card.gated = gated_to_bool(&meta.gated);
            card.last_modified = meta.last_modified;
            card.created_at = meta.created_at;
            let (context_length, architecture, params) = gguf_fields(&meta.gguf);
            card.context_length = context_length;
            card.params = params;
            // Refresh diffusion from the Hub pipeline_tag (more reliable than
            // GGUF architecture for models whose metadata omits the arch key).
            let tag = meta.pipeline_tag;
            card.diffusion = tag
                .as_deref()
                .map(is_diffusion_pipeline_tag)
                .unwrap_or_else(|| {
                    architecture
                        .as_deref()
                        .is_some_and(gguf::is_diffusion_architecture)
                })
                || card.diffusion; // keep local detection if Hub provides nothing
            card.architecture = architecture;
            card.pipeline_tag = tag;
        }
    }
    cards
}

/// Best-effort fetch of one model's Hub metadata (the info endpoint only — no
/// tree/README round-trips), used to enrich installed cards. `None` on any
/// failure so the caller falls back to the local card.
pub(crate) async fn fetch_card_meta(
    client: &reqwest::Client,
    endpoint: &HfEndpoint,
    id: &str,
) -> Option<HfModelInfo> {
    if validate_repo_id(id).is_err() {
        return None;
    }
    let url = format!("{}/models/{id}", endpoint.api_base);
    let resp = hf_get(client, &url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<HfModelInfo>().await.ok()
}

#[cfg(test)]
#[path = "search_tests.rs"]
mod tests;
