//! Skill detail, part 2: the GitHub cache files, the helpers that read the catalog
//! page, and the detail route's entry point.
// test-exempt: moved verbatim out of skills_catalog/mod.rs by the module split; covered by skills_catalog/tests.rs.

use super::*;

pub(crate) fn github_cache_path(name: &str) -> std::path::PathBuf {
    crate::paths::cache_dir()
        .join("skills-github")
        .join(safe_cache_segment(name))
}

pub(super) fn safe_cache_segment(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

pub(super) fn now_unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub(crate) fn read_fresh_cache<T>(path: &std::path::Path) -> Option<T>
where
    T: serde::de::DeserializeOwned,
{
    let envelope = read_cache::<T>(path)?;
    (now_unix_seconds().saturating_sub(envelope.fetched_at) <= GITHUB_CACHE_TTL_SECONDS)
        .then_some(envelope.value)
}

/// Read a GitHub cache without applying the freshness window.
///
/// GitHub-backed catalog metadata is safe to serve stale: it describes what was
/// seen previously, while the actual install path still fetches and validates the
/// source before writing anything locally. Keeping this separate from
/// [`read_fresh_cache`] lets callers choose stale-on-outage without weakening the
/// normal refresh cadence.
pub(crate) fn read_stale_cache<T>(path: &std::path::Path) -> Option<T>
where
    T: serde::de::DeserializeOwned,
{
    read_cache::<T>(path).map(|envelope| envelope.value)
}

fn read_cache<T>(path: &std::path::Path) -> Option<CacheEnvelope<T>>
where
    T: serde::de::DeserializeOwned,
{
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<CacheEnvelope<T>>(&raw).ok()
}

pub(crate) fn write_cache<T>(path: &std::path::Path, value: &T)
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let envelope = CacheEnvelope {
        fetched_at: now_unix_seconds(),
        value,
    };
    if let Ok(json) = serde_json::to_string(&envelope) {
        let _ = std::fs::write(path, json);
    }
}

pub(super) fn format_compact_count(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}K", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

pub(super) fn text_after_label(html: &str, label: &str) -> Option<String> {
    let idx = html.find(label)?;
    let after = &html[idx + label.len()..];
    let text = strip_tags(after);
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToString::to_string)
}

pub(super) fn repository_url(html: &str) -> Option<String> {
    let idx = html.find("Repository")?;
    let after = &html[idx..];
    let href_idx = after.find("href=\"")?;
    let href = &after[href_idx + 6..];
    let end = href.find('"')?;
    let url = href[..end].replace("&amp;", "&");
    // Parse and enforce scheme + exact host, not a substring match: a bare
    // `contains("github.com")` would accept `https://github.com.evil.com/...`,
    // `https://evil.com/?x=github.com`, or even a `javascript:` URL that happens
    // to contain the literal, which a client could bind to an `<a href>` (XSS /
    // phishing). Require https and a github.com (or *.github.com) host.
    let parsed = url::Url::parse(&url).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    if host == "github.com" || host.ends_with(".github.com") {
        Some(url)
    } else {
        None
    }
}

pub(super) fn security_audits(html: &str) -> Vec<SkillAudit> {
    let Some(idx) = html.find("Security Audits") else {
        return Vec::new();
    };
    let after = &html[idx..];
    let end = after.find("Browse").unwrap_or(after.len());
    let section = &after[..end];
    let mut audits = Vec::new();
    for marker in section.match_indices("<a ") {
        let anchor = &section[marker.0..];
        let anchor_end = anchor.find("</a>").unwrap_or(anchor.len());
        let anchor = &anchor[..anchor_end];
        let text = strip_tags(anchor);
        let lines: Vec<&str> = text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        let Some(name) = lines.first() else {
            continue;
        };
        let status = lines.get(1).copied().unwrap_or("");
        if ["Gen Agent Trust Hub", "Socket", "Snyk"].contains(name) {
            audits.push(SkillAudit {
                name: (*name).to_string(),
                status: status.to_string(),
                url: href_from_anchor(anchor),
                summary: None,
                risk_level: None,
                audited_at: None,
            });
        }
    }
    audits
}

pub(super) fn href_from_anchor(anchor: &str) -> Option<String> {
    let href_idx = anchor.find("href=\"")?;
    let href = &anchor[href_idx + 6..];
    let end = href.find('"')?;
    let href = href[..end].replace("&amp;", "&");
    if href.starts_with("http") {
        Some(href)
    } else {
        Some(format!("{}{}", api_base(), href))
    }
}

pub(super) fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push('\n');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    html_escape(&out)
}

pub(super) fn html_escape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
}

pub(super) fn parse_compact_count(value: Option<&str>) -> u64 {
    let Some(raw) = value else {
        return 0;
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return 0;
    }
    let (number, multiplier) = match trimmed.chars().last() {
        Some('K') | Some('k') => (&trimmed[..trimmed.len() - 1], 1_000.0),
        Some('M') | Some('m') => (&trimmed[..trimmed.len() - 1], 1_000_000.0),
        _ => (trimmed, 1.0),
    };
    number
        .replace(',', "")
        .parse::<f64>()
        .map(|n| (n * multiplier).round() as u64)
        .unwrap_or(0)
}

/// Fetch full detail: the SKILL.md docs + front-matter description + file list.
pub async fn skill_detail(client: &reqwest::Client, id: &str) -> Result<SkillDetail> {
    let files = enrich_file_contents_from_github(client, id, download(client, id).await?).await;
    let mut metadata = fetch_page_metadata(client, id).await;
    let slug = slug_of(id);
    let source = id.rsplitn(2, '/').nth(1).unwrap_or(id).to_string();

    let skill_md = entry_skill_doc_index(&files).map(|index| &files[index]);

    let (description, name, readme) = match skill_md {
        Some(f) => {
            let (fm, body) = split_front_matter(&f.contents);
            (
                front_matter_field(&fm, "description"),
                front_matter_field(&fm, "name").unwrap_or_else(|| slug.clone()),
                Some(body),
            )
        }
        None => (None, slug.clone(), None),
    };

    let installed = installed_slugs().contains(&slug);
    let catalog_installs = catalog_card_for_detail(client, id)
        .await
        .map(|item| item.installs)
        .unwrap_or(0);
    if metadata.installs.is_none() && catalog_installs > 0 {
        metadata.installs = Some(format_compact_count(catalog_installs));
    }
    let installs = catalog_installs.max(parse_compact_count(metadata.installs.as_deref()));
    let card = SkillCard {
        id: id.to_string(),
        source,
        installed,
        installs,
        downloads: installs,
        name,
        slug: slug.clone(),
        description: description.clone(),
        trust_level: Some("community".to_string()),
    };

    Ok(SkillDetail {
        card,
        description,
        readme,
        metadata,
        files: files
            .into_iter()
            .map(|f| SkillFile {
                path: f.path,
                contents: f.contents,
            })
            .collect(),
        url: format!("{}/{id}", api_base()),
    })
}
