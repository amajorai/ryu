//! CatalogSource seam (#459).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── CatalogSource seam (#459) ────────────────────────────────────────────────
//
// One adapter every catalog (model/skill/mcp/plugin/knowledge/agent) routes
// through. These
// endpoints list the sources per kind, add a user custom source, and persist
// the active selection. See `crate::catalog_source`.

/// Parse `?kind=` into a [`CatalogKind`], 400 on missing/unknown.
pub(in crate::server) fn parse_catalog_kind(
    s: Option<&str>,
) -> Result<crate::catalog_source::CatalogKind, StatusCode> {
    s.and_then(|v| v.parse().ok())
        .ok_or(StatusCode::BAD_REQUEST)
}

/// `GET /api/catalog/sources?kind=<model|skill|mcp|plugin|knowledge|agent>`
/// → `{ kind, active, sources: [{ id, display_name, builtin, base_url? }] }`
#[utoipa::path(
    get,
    path = "/api/catalog/sources",
    tag = "Catalog",
    summary = "List catalog sources for a kind + the active one",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn catalog_sources_list(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let kind = match parse_catalog_kind(params.get("kind").map(String::as_str)) {
        Ok(k) => k,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(
                    json!({ "error": "missing or unknown `kind` (model|skill|mcp|plugin|knowledge|agent)" }),
                ),
            );
        }
    };
    let sources = state.catalog_sources.sources_for(kind);
    let active = state
        .catalog_sources
        .active_id(kind, &state.preferences)
        .await;
    (
        StatusCode::OK,
        Json(json!({
            "kind": kind.as_str(),
            "active": active,
            "sources": sources,
        })),
    )
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct AddCatalogSourceBody {
    pub(in crate::server) kind: crate::catalog_source::CatalogKind,
    pub(in crate::server) id: String,
    pub(in crate::server) display_name: String,
    #[serde(default)]
    pub(in crate::server) base_url: Option<String>,
    /// Optional auth for a PRIVATE git/HTTP marketplace (Phase 5c). Prefer
    /// `${ENV_VAR}` templates so no secret is persisted to disk.
    #[serde(default)]
    pub(in crate::server) auth: Option<crate::catalog_source::SourceAuth>,
}

/// SSRF guard for a user-supplied custom MARKETPLACE source `base_url`
/// (Skill/Plugin kinds). A marketplace may be:
/// - a **local path** (user-local, read straight from disk — no outbound fetch,
///   so no SSRF surface), validated to exist,
/// - a **`git@` / `ssh://` clone URL** (the host is screened like any git clone),
/// - an **`https://`** repo or manifest URL (the full [`validate_remote_base_url`]
///   guard). `http://` is rejected like the https-only rule elsewhere.
/// Other kinds (model, mcp, …) keep the https-only [`validate_remote_base_url`].
pub(in crate::server) async fn validate_marketplace_base_url(raw: &str) -> Result<(), String> {
    let url = raw.trim();
    if url.is_empty() {
        return Ok(());
    }
    if crate::catalog_source::sources::is_local_marketplace_ref(url) {
        let path = crate::catalog_source::sources::expand_local_path(url);
        if !path.exists() {
            return Err(format!(
                "local marketplace path does not exist: {}",
                path.display()
            ));
        }
        return Ok(());
    }
    if url.starts_with("git@") || url.starts_with("ssh://") {
        let (host, port) =
            crate::skills_catalog::from_source::clone_host_port(url).map_err(|e| e.to_string())?;
        return resolve_guarded_host(&host, port).await.map(|_| ());
    }
    validate_remote_base_url(url).await
}

/// SSRF guard for a user-supplied custom catalog-source `base_url`. A custom
/// model source's base URL is interpolated into outbound fetch URLs and driven
/// by the shared client, so an unvalidated value is an SSRF / cloud-metadata
/// read primitive. Mirrors the [`install_app_from_url`] guard: require
/// `https://`, reject `localhost`, resolve the host (catching DNS names that
/// point inward), and reject if any resolved IP is loopback / private /
/// link-local / ULA / CGNAT. Residual: this validates at add-time; a full
/// defense against DNS-rebinding would also pin the model fetch client to the
/// validated IPs (tracked as a follow-up; the model fetch path re-resolves).
pub(in crate::server) async fn validate_remote_base_url(raw: &str) -> Result<(), String> {
    let url = raw.trim();
    if !url.starts_with("https://") {
        return Err("base_url must start with https://".to_owned());
    }
    let parsed = url::Url::parse(url).map_err(|e| format!("invalid base_url: {e}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "base_url has no host".to_owned())?
        .to_owned();
    if host.eq_ignore_ascii_case("localhost") {
        return Err("private/loopback base_url is not allowed".to_owned());
    }
    screen_guarded_hostname(&host)?;
    let port = parsed.port_or_known_default().unwrap_or(443);
    let resolve_host = host.clone();
    let resolved: Vec<std::net::SocketAddr> = tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        (resolve_host.as_str(), port)
            .to_socket_addrs()
            .map(|it| it.collect::<Vec<_>>())
    })
    .await
    .map_err(|e| format!("DNS resolution task failed: {e}"))?
    .map_err(|e| format!("failed to resolve base_url host: {e}"))?;
    if resolved.is_empty() {
        return Err("base_url host did not resolve".to_owned());
    }
    if resolved.iter().any(|addr| is_blocked_ip(addr.ip())) {
        return Err("private/loopback base_url is not allowed".to_owned());
    }
    Ok(())
}

/// Resolve + SSRF-validate a host, returning the validated socket addresses.
///
/// Shared by the catalog fetch paths (model-index + marketplace) and the
/// `git@`/`ssh://` clone guard. Requires `https`/`http` per the caller's own
/// scheme check (this only resolves + screens IPs): rejects `localhost`, hosts
/// that fail to resolve, and any host whose resolved IPs include a
/// loopback / private / link-local / ULA / CGNAT address. Catches DNS names
/// that point at internal addresses, not just literal IPs.
pub(crate) async fn resolve_guarded_host(
    host: &str,
    port: u16,
) -> Result<Vec<std::net::SocketAddr>, String> {
    if host.eq_ignore_ascii_case("localhost") {
        return Err("private/loopback host is not allowed".to_owned());
    }
    screen_guarded_hostname(host)?;
    let resolve_host = host.to_string();
    let resolved: Vec<std::net::SocketAddr> = tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        (resolve_host.as_str(), port)
            .to_socket_addrs()
            .map(|it| it.collect::<Vec<_>>())
    })
    .await
    .map_err(|e| format!("DNS resolution task failed: {e}"))?
    .map_err(|e| format!("failed to resolve host: {e}"))?;
    if resolved.is_empty() {
        return Err("host did not resolve".to_owned());
    }
    if resolved.iter().any(|addr| is_blocked_ip(addr.ip())) {
        return Err("private/loopback host is not allowed".to_owned());
    }
    Ok(resolved)
}
