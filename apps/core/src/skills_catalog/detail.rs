//! Skill detail, part 1: the catalog download, the page and audit metadata, and the
//! GitHub enrichment of a skill's file list.
// test-exempt: moved verbatim out of skills_catalog/mod.rs by the module split; covered by skills_catalog/tests.rs.

use super::*;

/// Split a full `owner/repo/slug` id into its three parts. The slug may itself
/// contain a colon (e.g. `react:components`) but never a slash, so the first two
/// segments are always owner + repo.
pub(super) fn split_id(id: &str) -> Option<(String, String, String)> {
    let mut parts = id.splitn(3, '/');
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.to_string();
    let slug = parts.next()?.to_string();
    if owner.is_empty() || repo.is_empty() || slug.is_empty() {
        return None;
    }
    Some((owner, repo, slug))
}

pub(super) async fn download(client: &reqwest::Client, id: &str) -> Result<Vec<DownloadFile>> {
    let (owner, repo, slug) = split_id(id).context("skill id must be owner/repo/slug")?;
    let url = format!(
        "{}/api/download/{}/{}/{}",
        api_base(),
        urlencoding::encode(&owner),
        urlencoding::encode(&repo),
        urlencoding::encode(&slug)
    );
    let resp = get(client, &url)
        .send()
        .await
        .context("requesting skill download")?;
    if !resp.status().is_success() {
        anyhow::bail!("skills.sh download returned HTTP {}", resp.status());
    }
    let parsed: DownloadResponse = resp.json().await.context("parsing skill download")?;
    Ok(parsed.files)
}

pub(super) async fn fetch_page_metadata(client: &reqwest::Client, id: &str) -> SkillDetailMetadata {
    let url = format!("{}/{id}", api_base());
    let Ok(resp) = get(client, &url).send().await else {
        return SkillDetailMetadata::default();
    };
    let Ok(html) = resp.text().await else {
        return SkillDetailMetadata::default();
    };

    let mut metadata = SkillDetailMetadata {
        installs: text_after_label(&html, "Installs"),
        github_stars: text_after_label(&html, "GitHub Stars"),
        first_seen: text_after_label(&html, "First Seen"),
        github_created_at: None,
        github_updated_at: None,
        github_pushed_at: None,
        repository_url: repository_url(&html),
        security_audits: security_audits(&html),
    };

    if metadata.security_audits.is_empty() {
        metadata.security_audits = fetch_audit_metadata(client, id).await;
    }
    enrich_github_metadata(client, id, &mut metadata).await;

    metadata
}

async fn fetch_audit_metadata(client: &reqwest::Client, id: &str) -> Vec<SkillAudit> {
    let url = format!("{}/api/v1/skills/audit/{id}", api_base());
    let Ok(resp) = get(client, &url).send().await else {
        return Vec::new();
    };
    if !resp.status().is_success() {
        return Vec::new();
    }
    let Ok(parsed) = resp.json::<AuditResponse>().await else {
        return Vec::new();
    };
    parsed
        .audits
        .into_iter()
        .map(|audit| SkillAudit {
            name: audit.provider,
            status: audit.status,
            url: Some(format!("{}/{id}/security/{}", api_base(), audit.slug)),
            summary: audit.summary,
            risk_level: audit.risk_level,
            audited_at: audit.audited_at,
        })
        .collect()
}

async fn enrich_github_metadata(
    client: &reqwest::Client,
    id: &str,
    metadata: &mut SkillDetailMetadata,
) {
    let Some((owner, repo, _slug)) = split_id(id) else {
        return;
    };
    let Ok(repo) = cached_github_repo(client, &owner, &repo).await else {
        return;
    };
    if metadata.github_stars.is_none() {
        metadata.github_stars = repo.stargazers_count.map(format_compact_count);
    }
    if metadata.repository_url.is_none() {
        metadata.repository_url = repo.html_url;
    }
    metadata.github_created_at = metadata.github_created_at.take().or(repo.created_at);
    metadata.github_updated_at = metadata.github_updated_at.take().or(repo.updated_at);
    metadata.github_pushed_at = metadata.github_pushed_at.take().or(repo.pushed_at);
}

pub(super) async fn catalog_card_for_detail(
    client: &reqwest::Client,
    id: &str,
) -> Option<SearchItem> {
    let slug = slug_of(id);
    let items = search_once(client, &slug, 20).await.ok()?;
    if let Some(item) = items.into_iter().find(|item| item.id == id) {
        return Some(item);
    }
    search_once(client, id, 1).await.ok()?.into_iter().next()
}

async fn cached_github_repo(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
) -> Result<GithubRepo> {
    let path = github_cache_path(&format!("{owner}__{repo}__repo.json"));
    if let Some(value) = read_fresh_cache::<GithubRepo>(&path) {
        return Ok(value);
    }
    let url = format!("https://api.github.com/repos/{owner}/{repo}");
    let fetched = async {
        let resp = get(client, &url)
            .send()
            .await
            .context("requesting GitHub repo metadata")?;
        if !resp.status().is_success() {
            anyhow::bail!("GitHub repo metadata returned HTTP {}", resp.status());
        }
        let repo = resp
            .json::<GithubRepo>()
            .await
            .context("parsing GitHub repo metadata")?;
        Ok::<GithubRepo, anyhow::Error>(repo)
    }
    .await;
    match fetched {
        Ok(repo) => {
            write_cache(&path, &repo);
            Ok(repo)
        }
        Err(error) => {
            if let Some(cached) = read_stale_cache::<GithubRepo>(&path) {
                tracing::warn!(
                    owner,
                    repo,
                    error = %error,
                    "GitHub repo metadata unavailable; using stale cached metadata"
                );
                Ok(cached)
            } else {
                Err(error)
            }
        }
    }
}

async fn cached_github_tree(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
) -> Result<Vec<GithubTreeItem>> {
    let path = github_cache_path(&format!("{owner}__{repo}__tree.json"));
    if let Some(value) = read_fresh_cache::<Vec<GithubTreeItem>>(&path) {
        return Ok(value);
    }
    let url = format!("https://api.github.com/repos/{owner}/{repo}/git/trees/HEAD?recursive=1");
    let fetched = async {
        let resp = get(client, &url)
            .send()
            .await
            .context("requesting GitHub repo tree")?;
        if !resp.status().is_success() {
            anyhow::bail!("GitHub repo tree returned HTTP {}", resp.status());
        }
        let parsed = resp
            .json::<GithubTreeResponse>()
            .await
            .context("parsing GitHub repo tree")?;
        Ok::<Vec<GithubTreeItem>, anyhow::Error>(
            parsed
                .tree
                .into_iter()
                .filter(|item| item.kind == "blob")
                .collect::<Vec<_>>(),
        )
    }
    .await;
    match fetched {
        Ok(tree) => {
            write_cache(&path, &tree);
            Ok(tree)
        }
        Err(error) => {
            if let Some(cached) = read_stale_cache::<Vec<GithubTreeItem>>(&path) {
                tracing::warn!(
                    owner,
                    repo,
                    error = %error,
                    "GitHub repo tree unavailable; using stale cached tree"
                );
                Ok(cached)
            } else {
                Err(error)
            }
        }
    }
}

pub(super) async fn enrich_file_contents_from_github(
    client: &reqwest::Client,
    id: &str,
    files: Vec<DownloadFile>,
) -> Vec<DownloadFile> {
    if files.iter().all(|file| !file.contents.is_empty()) {
        return files;
    }
    let Some((owner, repo, slug)) = split_id(id) else {
        return files;
    };
    let cache_path = github_cache_path(&format!(
        "{}__{}__{}__files.json",
        owner,
        repo,
        safe_cache_segment(&slug)
    ));
    if let Some(cached) = read_fresh_cache::<Vec<DownloadFile>>(&cache_path) {
        return merge_cached_file_contents(files, cached);
    }
    let tree = match cached_github_tree(client, &owner, &repo).await {
        Ok(tree) => tree,
        Err(error) => {
            if let Some(cached) = read_stale_cache::<Vec<DownloadFile>>(&cache_path) {
                tracing::warn!(
                    owner,
                    repo,
                    error = %error,
                    "GitHub skill files unavailable; using stale cached contents"
                );
                return merge_cached_file_contents(files, cached);
            }
            return files;
        }
    };
    let mut enriched = Vec::with_capacity(files.len());
    for mut file in files {
        if file.contents.is_empty() {
            if let Some(repo_path) = find_repo_file_path(&tree, &slug, &file.path) {
                if let Ok(contents) = fetch_github_raw_file(client, &owner, &repo, &repo_path).await
                {
                    file.contents = contents;
                }
            }
        }
        enriched.push(file);
    }
    write_cache(&cache_path, &enriched);
    enriched
}

fn merge_cached_file_contents(
    files: Vec<DownloadFile>,
    cached: Vec<DownloadFile>,
) -> Vec<DownloadFile> {
    let cached_by_path = cached
        .into_iter()
        .map(|file| (file.path.clone(), file.contents))
        .collect::<std::collections::HashMap<_, _>>();
    files
        .into_iter()
        .map(|mut file| {
            if file.contents.is_empty() {
                if let Some(contents) = cached_by_path.get(&file.path) {
                    file.contents = contents.clone();
                }
            }
            file
        })
        .collect()
}

pub(super) fn find_repo_file_path(
    tree: &[GithubTreeItem],
    slug: &str,
    package_path: &str,
) -> Option<String> {
    let normalized_package_path = package_path.replace('\\', "/");
    let slug_prefix = format!("{slug}/");
    let suffix = format!("/{slug}/{}", normalized_package_path);
    tree.iter()
        .find(|item| item.path == normalized_package_path)
        .or_else(|| {
            tree.iter().find(|item| {
                item.path.ends_with(&suffix)
                    || (item.path.starts_with(&slug_prefix)
                        && item.path.ends_with(&normalized_package_path))
            })
        })
        .or_else(|| {
            tree.iter().find(|item| {
                item.path
                    .ends_with(&format!("/{}", normalized_package_path))
            })
        })
        .map(|item| item.path.clone())
}

async fn fetch_github_raw_file(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    path: &str,
) -> Result<String> {
    let encoded_path = path
        .split('/')
        .map(|segment| urlencoding::encode(segment).into_owned())
        .collect::<Vec<_>>()
        .join("/");
    let url = format!("https://raw.githubusercontent.com/{owner}/{repo}/HEAD/{encoded_path}");
    let resp = get(client, &url)
        .send()
        .await
        .context("requesting GitHub raw file")?;
    if !resp.status().is_success() {
        anyhow::bail!("GitHub raw file returned HTTP {}", resp.status());
    }
    let bytes = resp.bytes().await.context("reading GitHub raw file")?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
