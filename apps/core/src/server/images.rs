//! Image catalog search for companion asset pickers.
//!
//! Openverse is keyless. Unsplash uses the node's configured access key and is
//! deliberately reported as unavailable when no key is present. The companion
//! host, rather than the sandboxed frame, fetches the returned media and turns it
//! into a `data:` URL before handing it to an app.

use std::time::Duration;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

const OPENVERSE_API: &str = "https://api.openverse.org/v1/images/";
const OPENVERSE_THUMBNAIL_PREFIX: &str = "https://api.openverse.org/v1/images/";
const UNSPLASH_API: &str = "https://api.unsplash.com/search/photos";

#[derive(Debug, Deserialize)]
pub struct ImageSearchQuery {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub q: String,
    pub limit: Option<u32>,
    /// 1-based result page, so pickers can load more as the user scrolls.
    pub page: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ImageResult {
    pub id: String,
    pub title: String,
    pub preview_url: String,
    pub url: String,
    pub width: u32,
    pub height: u32,
    pub attribution: String,
    pub source_url: String,
    pub license_url: Option<String>,
    pub rights: String,
}

fn image_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("ryu-core/0.1")
        .timeout(Duration::from_secs(15))
        .build()
        .expect("reqwest client")
}

fn normalize_provider(provider: &str) -> &'static str {
    match provider.trim().to_ascii_lowercase().as_str() {
        "unsplash" | "unsplash.image" => "unsplash",
        _ => "openverse",
    }
}

async fn resolve_unsplash_key(state: &super::ServerState) -> Option<String> {
    if let Ok(Some(value)) = state.preferences.get("unsplash-access-key").await {
        let value = value.trim().to_owned();
        if !value.is_empty() {
            return Some(value);
        }
    }
    ["RYU_UNSPLASH_ACCESS_KEY", "UNSPLASH_ACCESS_KEY"]
        .into_iter()
        .find_map(|name| {
            std::env::var(name)
                .ok()
                .map(|value| value.trim().to_owned())
        })
        .filter(|value| !value.is_empty())
}

fn bounded_query(query: &str) -> String {
    query.trim().chars().take(120).collect()
}

fn bounded_limit(limit: Option<u32>) -> u32 {
    limit.unwrap_or(12).clamp(1, 24)
}

fn bounded_page(page: Option<u32>) -> u32 {
    page.unwrap_or(1).clamp(1, 50)
}

fn https_url(value: Option<&Value>) -> Option<String> {
    let value = value.and_then(Value::as_str)?.trim();
    let parsed = url::Url::parse(value).ok()?;
    (parsed.scheme() == "https").then(|| parsed.to_string())
}

fn u32_value(value: Option<&Value>) -> u32 {
    value
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0)
}

async fn search_openverse(query: &str, limit: u32, page: u32) -> Result<Vec<ImageResult>, String> {
    let response = image_client()
        .get(OPENVERSE_API)
        .query(&[
            ("q", query),
            ("page_size", &limit.to_string()),
            ("page", &page.to_string()),
        ])
        .send()
        .await
        .map_err(|error| format!("openverse request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("openverse returned {}", response.status()));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("openverse decode failed: {error}"))?;
    let Some(items) = body.get("results").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut results = Vec::with_capacity(items.len());
    for item in items {
        let Some(id) = item.get("id").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        let Some(url) = https_url(item.get("url")) else {
            continue;
        };
        let thumbnail = https_url(item.get("thumbnail"))
            .unwrap_or_else(|| format!("{OPENVERSE_THUMBNAIL_PREFIX}{id}/thumb/"));
        let title = item
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Openverse image")
            .to_owned();
        let creator = item
            .get("creator")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Unknown creator");
        let provider = item
            .get("provider")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Openverse");
        let license = [
            item.get("license").and_then(Value::as_str),
            item.get("license_version").and_then(Value::as_str),
        ]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
        let source_url = https_url(item.get("foreign_landing_url"))
            .unwrap_or_else(|| "https://openverse.org/".to_owned());
        results.push(ImageResult {
            id: id.to_owned(),
            title,
            preview_url: thumbnail,
            url,
            width: u32_value(item.get("width")),
            height: u32_value(item.get("height")),
            attribution: format!("{creator} · {provider}"),
            source_url,
            license_url: https_url(item.get("license_url")),
            rights: if license.is_empty() {
                "Openverse license metadata was not provided. Review the source before publication."
                    .to_owned()
            } else {
                format!("{license}. Review the linked license before publication.")
            },
        });
    }
    Ok(results)
}

async fn search_unsplash(
    key: &str,
    query: &str,
    limit: u32,
    page: u32,
) -> Result<Vec<ImageResult>, String> {
    let response = image_client()
        .get(UNSPLASH_API)
        .query(&[
            ("client_id", key),
            ("query", query),
            ("per_page", &limit.to_string()),
            ("page", &page.to_string()),
        ])
        .send()
        .await
        .map_err(|error| format!("unsplash request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("unsplash returned {}", response.status()));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("unsplash decode failed: {error}"))?;
    let Some(items) = body.get("results").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut results = Vec::with_capacity(items.len());
    for item in items {
        let Some(id) = item.get("id").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        let Some(preview_url) = https_url(item.get("urls").and_then(|urls| urls.get("small")))
        else {
            continue;
        };
        let url = https_url(item.get("urls").and_then(|urls| urls.get("regular")))
            .unwrap_or_else(|| preview_url.clone());
        let title = item
            .get("alt_description")
            .and_then(Value::as_str)
            .or_else(|| item.get("description").and_then(Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Unsplash photo")
            .to_owned();
        let user = item.get("user");
        let creator = user
            .and_then(|user| user.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Unsplash photographer");
        let source_url = https_url(item.get("links").and_then(|links| links.get("html")))
            .unwrap_or_else(|| format!("https://unsplash.com/photos/{id}"));
        results.push(ImageResult {
            id: id.to_owned(),
            title,
            preview_url,
            url,
            width: u32_value(item.get("width")),
            height: u32_value(item.get("height")),
            attribution: format!("{creator} · Unsplash"),
            source_url,
            license_url: Some("https://unsplash.com/license".to_owned()),
            rights: "Unsplash License. Review the source before publication.".to_owned(),
        });
    }
    Ok(results)
}

/// `GET /api/assets/images/search?provider=openverse|unsplash&q=&limit=&page=`.
#[utoipa::path(
    get,
    path = "/api/assets/images/search",
    operation_id = "search_image_assets",
    tag = "Media",
    summary = "Search Openverse or Unsplash image catalogs",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn search(
    State(state): State<super::ServerState>,
    Query(params): Query<ImageSearchQuery>,
) -> impl IntoResponse {
    let provider = normalize_provider(&params.provider);
    let query = bounded_query(&params.q);
    let limit = bounded_limit(params.limit);
    let page = bounded_page(params.page);
    if provider == "unsplash" {
        let Some(key) = resolve_unsplash_key(&state).await else {
            return (
                StatusCode::OK,
                Json(json!({
                    "configured": false,
                    "provider": "unsplash",
                    "results": [],
                })),
            );
        };
        return match search_unsplash(&key, &query, limit, page).await {
            Ok(results) => (
                StatusCode::OK,
                Json(json!({
                    "configured": true,
                    "provider": "unsplash",
                    "page": page,
                    "has_more": results.len() as u32 >= limit,
                    "results": results,
                })),
            ),
            Err(error) => (
                StatusCode::BAD_GATEWAY,
                Json(
                    json!({ "configured": true, "provider": "unsplash", "error": error, "results": [] }),
                ),
            ),
        };
    }

    match search_openverse(&query, limit, page).await {
        Ok(results) => (
            StatusCode::OK,
            Json(json!({
                "configured": true,
                "provider": "openverse",
                "page": page,
                "has_more": results.len() as u32 >= limit,
                "results": results,
            })),
        ),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(
                json!({ "configured": true, "provider": "openverse", "error": error, "results": [] }),
            ),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn page_defaults_to_first_and_is_bounded() {
        assert_eq!(bounded_page(None), 1);
        assert_eq!(bounded_page(Some(0)), 1);
        assert_eq!(bounded_page(Some(3)), 3);
        assert_eq!(bounded_page(Some(500)), 50);
    }

    #[test]
    fn provider_defaults_to_openverse_and_aliases_unsplash() {
        assert_eq!(normalize_provider(""), "openverse");
        assert_eq!(normalize_provider("openverse.image"), "openverse");
        assert_eq!(normalize_provider("Unsplash"), "unsplash");
        assert_eq!(normalize_provider("unsplash.image"), "unsplash");
    }

    #[test]
    fn query_and_limit_are_bounded() {
        assert_eq!(bounded_query("  mountains  "), "mountains");
        assert_eq!(bounded_query(&"x".repeat(200)).len(), 120);
        assert_eq!(bounded_limit(None), 12);
        assert_eq!(bounded_limit(Some(0)), 1);
        assert_eq!(bounded_limit(Some(100)), 24);
    }

    #[test]
    fn openverse_item_requires_https_media_url() {
        assert_eq!(https_url(Some(&json!("http://example.com/a.jpg"))), None);
        assert_eq!(
            https_url(Some(&json!("https://example.com/a.jpg"))),
            Some("https://example.com/a.jpg".to_owned())
        );
    }
}
