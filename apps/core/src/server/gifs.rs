//! GIF search proxy — a keyless-from-the-client lookup over a third-party GIF
//! provider (Klipy by default; Giphy or Tenor when configured).
//!
//! No major GIF API is truly unauthenticated, so rather than ship a dead public
//! key in the desktop bundle Core holds the (BYOK, free-tier) provider key and the
//! client calls `GET /api/gifs/search?q=...`. This keeps the key out of every
//! surface, makes the provider swappable, and routes GIF egress through the node
//! like the rest of the media path.
//!
//! Per the Core-vs-Gateway rule this is **Core** (it decides *what runs* — which
//! provider serves the lookup, from the node's own config); it is not an LLM call
//! and carries no policy of its own.
//!
//! Config (nothing hardcoded, all swappable):
//! - provider: pref `gif-provider` or env `RYU_GIF_PROVIDER` (default `klipy`).
//! - key: pref `gif-api-key`, else env `RYU_GIF_API_KEY`, else the provider's
//!   conventional env (`KLIPY_API_KEY` / `GIPHY_API_KEY` / `TENOR_API_KEY`).
//!
//! With no key configured the endpoint returns `{ "configured": false,
//! "results": [] }` (HTTP 200) so the picker can prompt the user to add a free
//! (BYOK) key rather than erroring.

use std::time::Duration;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Query for `GET /api/gifs/search`. An empty/absent `q` returns trending GIFs.
#[derive(Debug, Deserialize)]
pub struct GifSearchQuery {
    #[serde(default)]
    pub q: String,
    pub limit: Option<u32>,
}

/// One normalized GIF result. `preview_url` is a small looping GIF for the grid;
/// `url` is the full GIF to insert onto a board/canvas.
#[derive(Debug, Clone, Serialize)]
pub struct GifResult {
    pub id: String,
    pub title: String,
    pub preview_url: String,
    pub url: String,
    pub width: u32,
    pub height: u32,
}

/// Short-timeout client for the GIF provider (a quick JSON lookup, unlike the
/// minutes-long media generation client).
fn gif_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("ryu-core/0.1")
        .timeout(Duration::from_secs(15))
        .build()
        .expect("reqwest client")
}

/// Resolve the configured provider id (lowercased), defaulting to `klipy`.
async fn resolve_provider(state: &super::ServerState) -> String {
    if let Ok(Some(p)) = state.preferences.get("gif-provider").await {
        let p = p.trim().to_lowercase();
        if !p.is_empty() {
            return p;
        }
    }
    std::env::var("RYU_GIF_PROVIDER")
        .ok()
        .map(|p| p.trim().to_lowercase())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "klipy".to_string())
}

/// Resolve the provider API key: pref `gif-api-key` → env `RYU_GIF_API_KEY` →
/// the provider's conventional env var. Returns `None` when nothing is set.
async fn resolve_key(state: &super::ServerState, provider: &str) -> Option<String> {
    if let Ok(Some(k)) = state.preferences.get("gif-api-key").await {
        let k = k.trim().to_string();
        if !k.is_empty() {
            return Some(k);
        }
    }
    let provider_env = match provider {
        "tenor" => "TENOR_API_KEY",
        "giphy" => "GIPHY_API_KEY",
        _ => "KLIPY_API_KEY",
    };
    for var in ["RYU_GIF_API_KEY", provider_env] {
        if let Ok(k) = std::env::var(var) {
            let k = k.trim().to_string();
            if !k.is_empty() {
                return Some(k);
            }
        }
    }
    None
}

/// Stable per-node customer id Klipy requires on search/trending (used for its
/// own moderation + recommendations; not a user secret).
const KLIPY_CUSTOMER_ID: &str = "ryu";

/// Fetch + normalize results from Klipy. The app key is a URL *path* segment
/// (`/api/v1/<key>/gifs/...`), unlike the query-param keys of Giphy/Tenor.
async fn search_klipy(key: &str, q: &str, limit: u32) -> Result<Vec<GifResult>, String> {
    let action = if q.is_empty() { "trending" } else { "search" };
    let url = format!("https://api.klipy.com/api/v1/{key}/gifs/{action}");
    let mut req = gif_client().get(&url).query(&[
        ("per_page", limit.to_string()),
        ("page", "1".to_string()),
        ("customer_id", KLIPY_CUSTOMER_ID.to_string()),
    ]);
    if !q.is_empty() {
        req = req.query(&[("q", q)]);
    }
    let resp = req.send().await.map_err(|e| format!("klipy request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("klipy returned {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("klipy decode failed: {e}"))?;
    // Klipy wraps the list as `{ result, data: { data: [...] } }`.
    let items = body
        .get("data")
        .and_then(|d| d.get("data"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::with_capacity(items.len());
    for it in &items {
        let file = it.get("file");
        // Prefer the small variant for the grid preview, the hd/md for insertion.
        let preview = file
            .and_then(|f| f.get("sm").or_else(|| f.get("xs")))
            .and_then(|s| s.get("gif"))
            .and_then(|g| g.get("url"))
            .and_then(Value::as_str);
        let full_fmt = file
            .and_then(|f| f.get("hd").or_else(|| f.get("md")).or_else(|| f.get("sm")))
            .and_then(|s| s.get("gif"));
        let full = full_fmt.and_then(|g| g.get("url")).and_then(Value::as_str);
        let (Some(preview), Some(full)) = (preview, full) else {
            continue;
        };
        let id = it
            .get("id")
            .map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))
            .unwrap_or_default();
        out.push(GifResult {
            id,
            title: it.get("title").and_then(Value::as_str).unwrap_or("GIF").to_string(),
            preview_url: preview.to_string(),
            url: full.to_string(),
            width: full_fmt.and_then(|g| g.get("width")).and_then(str_num).unwrap_or(0),
            height: full_fmt.and_then(|g| g.get("height")).and_then(str_num).unwrap_or(0),
        });
    }
    Ok(out)
}

/// Fetch + normalize results from Giphy.
async fn search_giphy(key: &str, q: &str, limit: u32) -> Result<Vec<GifResult>, String> {
    let base = if q.is_empty() {
        "https://api.giphy.com/v1/gifs/trending".to_string()
    } else {
        "https://api.giphy.com/v1/gifs/search".to_string()
    };
    let mut req = gif_client()
        .get(&base)
        .query(&[("api_key", key), ("limit", &limit.to_string()), ("rating", "pg-13")]);
    if !q.is_empty() {
        req = req.query(&[("q", q)]);
    }
    let resp = req.send().await.map_err(|e| format!("giphy request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("giphy returned {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("giphy decode failed: {e}"))?;
    let items = body.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut out = Vec::with_capacity(items.len());
    for it in &items {
        let images = it.get("images");
        let preview = images
            .and_then(|i| i.get("fixed_width"))
            .and_then(|i| i.get("url"))
            .and_then(Value::as_str);
        let full = images
            .and_then(|i| i.get("original"))
            .and_then(|i| i.get("url"))
            .and_then(Value::as_str);
        let (Some(preview), Some(full)) = (preview, full) else {
            continue;
        };
        let dims = images.and_then(|i| i.get("original"));
        out.push(GifResult {
            id: it.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
            title: it.get("title").and_then(Value::as_str).unwrap_or("GIF").to_string(),
            preview_url: preview.to_string(),
            url: full.to_string(),
            width: dims.and_then(|d| d.get("width")).and_then(str_num).unwrap_or(0),
            height: dims.and_then(|d| d.get("height")).and_then(str_num).unwrap_or(0),
        });
    }
    Ok(out)
}

/// Fetch + normalize results from Tenor (v2).
async fn search_tenor(key: &str, q: &str, limit: u32) -> Result<Vec<GifResult>, String> {
    let base = if q.is_empty() {
        "https://tenor.googleapis.com/v2/featured".to_string()
    } else {
        "https://tenor.googleapis.com/v2/search".to_string()
    };
    let mut req = gif_client().get(&base).query(&[
        ("key", key),
        ("limit", &limit.to_string()),
        ("media_filter", "gif,tinygif"),
        ("contentfilter", "medium"),
    ]);
    if !q.is_empty() {
        req = req.query(&[("q", q)]);
    }
    let resp = req.send().await.map_err(|e| format!("tenor request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("tenor returned {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("tenor decode failed: {e}"))?;
    let items = body.get("results").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut out = Vec::with_capacity(items.len());
    for it in &items {
        let formats = it.get("media_formats");
        let preview = formats
            .and_then(|f| f.get("tinygif"))
            .and_then(|g| g.get("url"))
            .and_then(Value::as_str);
        let full = formats
            .and_then(|f| f.get("gif"))
            .and_then(|g| g.get("url"))
            .and_then(Value::as_str);
        let (Some(preview), Some(full)) = (preview, full) else {
            continue;
        };
        // Tenor dims live under the full format as `dims: [w, h]`.
        let dims = formats
            .and_then(|f| f.get("gif"))
            .and_then(|g| g.get("dims"))
            .and_then(Value::as_array);
        let width = dims.and_then(|d| d.first()).and_then(Value::as_u64).unwrap_or(0) as u32;
        let height = dims.and_then(|d| d.get(1)).and_then(Value::as_u64).unwrap_or(0) as u32;
        out.push(GifResult {
            id: it.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
            title: it
                .get("content_description")
                .and_then(Value::as_str)
                .unwrap_or("GIF")
                .to_string(),
            preview_url: preview.to_string(),
            url: full.to_string(),
            width,
            height,
        });
    }
    Ok(out)
}

/// Giphy reports dimensions as numeric strings; parse leniently.
fn str_num(v: &Value) -> Option<u32> {
    v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_u64().map(|n| n as u32))
}

/// `GET /api/gifs/search?q=&limit=` — search (or, with empty `q`, trending) GIFs
/// via the configured provider. Returns `{ configured, provider, results }`.
pub async fn search(
    State(state): State<super::ServerState>,
    Query(params): Query<GifSearchQuery>,
) -> impl IntoResponse {
    let provider = resolve_provider(&state).await;
    let limit = params.limit.unwrap_or(24).clamp(1, 50);
    let q = params.q.trim();

    let Some(key) = resolve_key(&state, &provider).await else {
        return (
            StatusCode::OK,
            Json(json!({
                "configured": false,
                "provider": provider,
                "results": [],
            })),
        );
    };

    let result = match provider.as_str() {
        "tenor" => search_tenor(&key, q, limit).await,
        "giphy" => search_giphy(&key, q, limit).await,
        _ => search_klipy(&key, q, limit).await,
    };

    match result {
        Ok(results) => (
            StatusCode::OK,
            Json(json!({ "configured": true, "provider": provider, "results": results })),
        ),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "configured": true, "provider": provider, "error": e, "results": [] })),
        ),
    }
}
