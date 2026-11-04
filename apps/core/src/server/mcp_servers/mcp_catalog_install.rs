//! MCP server CRUD, the MCP catalog and OpenAPI/GraphQL tool import: `mcp_catalog_install` through `slugify_domain`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/mcp/catalog/install { id }` — resolve the chosen registry server to
/// a validated `~/.ryu/mcp.json` entry and hot-reload the MCP registry so its
/// tools are listable. Source-aware (#464).
///
/// Security: the entry is written **disabled** so install never auto-launches a
/// registry-supplied command. Package entries also require an exact version and
/// registry ownership proof before they become a command. Remote entries use
/// Core's native HTTP transport, so installing a hosted server never installs an
/// npm bridge. The resolved command/url is returned in the response so the user
/// can review it before enabling/starting the server through the existing
/// explicit path.
#[utoipa::path(
    post,
    path = "/api/mcp/catalog/install",
    tag = "MCP",
    summary = "Install an MCP server or preview the config",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn mcp_catalog_install(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<McpCatalogInstallBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_INSTALL,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(app_lifecycle_denied_value(
                crate::identity_verify::permissions::APP_INSTALL,
                crate::sidecar::control_plane::registered_node().as_ref(),
                "node_scope_or_acl_denied",
            )),
        );
    }

    let id = body.id.trim().to_string();
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "`id` must not be empty" })),
        );
    }

    // Forward the caller's bearer to the marketplace install handoff (#491) so a
    // PAID Ryu-Marketplace MCP server is denied unless the buyer org holds a
    // license.
    let buyer_token = buyer_bearer_from_headers(&headers);

    // Resolve the install plan through the requested source, else the active one
    // (never launches).
    let source = match body
        .source
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(source_id) => {
            let Some(source) = state
                .catalog_sources
                .source_by_id(crate::catalog_source::CatalogKind::Mcp, source_id)
            else {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(
                        json!({ "success": false, "error": format!("unknown MCP source '{source_id}'") }),
                    ),
                );
            };
            Some(source)
        }
        None => active_mcp_source(&state).await,
    };
    let plan = match source {
        Some(source) => match crate::catalog_source::with_buyer_token(
            buyer_token,
            source.install_mcp(&state.client, &id),
        )
        .await
        {
            Ok(Some(plan)) => plan,
            Ok(None) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(
                        json!({ "success": false, "error": "active MCP source does not support install" }),
                    ),
                );
            }
            Err(e) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "success": false, "error": e.to_string() })),
                );
            }
        },
        None => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "success": false, "error": "no active MCP source" })),
            );
        }
    };

    // Reject a name collision with an already-registered server (built-ins
    // included) before writing — unless this is a forced update overwrite.
    if !body.force && state.mcp.contains_server(&plan.server_name) {
        return (
            StatusCode::CONFLICT,
            Json(
                json!({ "success": false, "error": format!("MCP server '{}' is already registered", plan.server_name) }),
            ),
        );
    }

    // Build the disabled mcp.json entry from the plan. Stdio plans retain the
    // verified package runner. Hosted plans use Core's native HTTP transport and
    // never install or execute an npm bridge.
    let resolved = resolved_mcp_entry(&plan.entry);

    if body.dry_run {
        return (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "dryRun": true,
                "action": "install",
                "server": {
                    "name": plan.server_name,
                    "command": resolved.command,
                    "args": resolved.args,
                    "transport": resolved.transport,
                    "url": resolved.url,
                    "description": plan.description,
                    "enabled": false,
                },
                "writes": [],
            })),
        );
    }

    match write_mcp_entry(
        &plan.server_name,
        crate::sidecar::mcp::McpServerConfig {
            command: resolved.command.clone(),
            args: resolved.args.clone(),
            transport: resolved.transport.clone(),
            url: resolved.url.clone(),
            headers: std::collections::BTreeMap::new(),
            auth: None,
            owner_plugin_id: None,
            owner_server_name: None,
            cwd: None,
            env: std::collections::BTreeMap::new(),
            description: plan.description.clone(),
            // Overwritten to false by `write_mcp_entry`; stated for clarity.
            enabled: false,
            // Catalog provenance — lets the update check compare against the
            // registry's current version later.
            version: plan.version.clone(),
            catalog_id: Some(plan.catalog_id.clone()),
        },
        body.force,
    )
    .await
    {
        Ok(()) => {
            // Hot-reload so the new server's tools are listable without a restart.
            state.mcp.reload();
            // ONE plugin model: an installed MCP server also carries a plugin
            // lifecycle record (installed DISABLED, mirroring the mcp.json entry),
            // so requires/targets/grants/AppGate + the plugin disable/uninstall
            // lifecycle govern it — instead of a parallel registry with its own
            // install path. The mcp.json entry stays the spawn config + tool
            // executor (delegate); the record is additive governance metadata.
            // Best-effort: a failure here never fails the MCP install itself.
            persist_mcp_plugin_record(&state, &plan).await;
            (
                StatusCode::OK,
                Json(json!({
                    "success": true,
                    "server": {
                        "name": plan.server_name,
                        "command": resolved.command,
                        "args": resolved.args,
                        "transport": resolved.transport,
                        "url": resolved.url,
                        "description": plan.description,
                        // Installed disabled: the user must explicitly enable/start it.
                        "enabled": false,
                    },
                })),
            )
        }
        Err((status, msg)) => (status, Json(json!({ "success": false, "error": msg }))),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct ImportOpenApiBody {
    /// Direct OpenAPI/Swagger spec URL. Takes precedence when present.
    #[serde(default)]
    pub(in crate::server) spec_url: Option<String>,
    /// API host (e.g. an integrations.sh `openapi` entry's domain) to resolve a
    /// spec URL via the apis.guru registry when `spec_url` is absent.
    #[serde(default)]
    pub(in crate::server) domain: Option<String>,
    /// integrations.sh entry id (e.g. `openapi/1password-com-events-events`).
    /// Resolved against apis.guru by normalized-key prefix — lets the desktop pass
    /// just the entry id (which carries no domain field) with no extra lookup.
    #[serde(default)]
    pub(in crate::server) id: Option<String>,
    /// Optional disambiguation hint (id or display name) used to pick the right
    /// service when a domain hosts several apis.guru specs.
    #[serde(default)]
    pub(in crate::server) hint: Option<String>,
}

/// Fetch + parse the apis.guru registry (`list.json`). Shared by both resolvers.
pub(in crate::server) async fn apis_guru_registry(
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let bytes = guarded_get_bytes("https://api.apis.guru/v2/list.json")
        .await
        .ok()?;
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|v| v.as_object().cloned())
}

/// The preferred (else first) version's `swaggerUrl` for an apis.guru API entry.
pub(in crate::server) fn apis_guru_swagger_url(entry: &serde_json::Value) -> Option<String> {
    let versions = entry.get("versions")?.as_object()?;
    let version_key = entry
        .get("preferred")
        .and_then(serde_json::Value::as_str)
        .filter(|p| versions.contains_key(*p))
        .map(str::to_owned)
        .or_else(|| versions.keys().next().cloned())?;
    versions
        .get(&version_key)?
        .get("swaggerUrl")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

/// Lowercase, non-alphanumerics → single `-`, trimmed (so an apis.guru key like
/// `1password.com:events` and an integrations.sh slug `1password-com-events` compare).
pub(in crate::server) fn normalize_key(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_dash = false;
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_owned()
}

/// Resolve an apis.guru spec URL for a host. Keys are `domain` or `domain:service`;
/// `hint` picks the service when a host has several.
pub(in crate::server) async fn resolve_apis_guru_spec_url(
    domain: &str,
    hint: Option<&str>,
) -> Option<String> {
    let obj = apis_guru_registry().await?;
    let prefix = format!("{domain}:");
    let candidates: Vec<&String> = obj
        .keys()
        .filter(|k| k.as_str() == domain || k.starts_with(&prefix))
        .collect();
    if candidates.is_empty() {
        return None;
    }
    let chosen = hint
        .map(str::to_ascii_lowercase)
        .and_then(|h| {
            candidates
                .iter()
                .find(|k| {
                    k.split(':')
                        .nth(1)
                        .is_some_and(|svc| h.contains(&svc.to_ascii_lowercase()))
                })
                .copied()
        })
        .or_else(|| candidates.iter().find(|k| k.as_str() == domain).copied())
        .or_else(|| candidates.first().copied())?;
    apis_guru_swagger_url(obj.get(chosen)?)
}

/// Resolve an apis.guru spec URL from an integrations.sh `openapi/<slug>` id: the
/// longest apis.guru key whose normalized form is a prefix of the normalized slug.
pub(in crate::server) async fn resolve_apis_guru_by_id(id: &str) -> Option<String> {
    let slug = id.strip_prefix("openapi/").unwrap_or(id);
    let want = normalize_key(slug);
    if want.is_empty() {
        return None;
    }
    let obj = apis_guru_registry().await?;
    let mut best: Option<(&String, usize)> = None;
    for key in obj.keys() {
        let nk = normalize_key(key);
        if !nk.is_empty() && want.starts_with(&nk) {
            let len = nk.len();
            if best.map_or(true, |(_, best_len)| len > best_len) {
                best = Some((key, len));
            }
        }
    }
    apis_guru_swagger_url(obj.get(best?.0)?)
}

/// Slugify a host into a plugin-id-safe token (`api.example.com` → `api-example-com`).
pub(in crate::server) fn slugify_domain(domain: &str) -> String {
    let mut out = String::with_capacity(domain.len());
    let mut prev_dash = false;
    for ch in domain.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_owned()
}
