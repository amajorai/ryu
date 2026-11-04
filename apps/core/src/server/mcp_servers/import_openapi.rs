//! MCP server CRUD, the MCP catalog and OpenAPI/GraphQL tool import: `validate_import_endpoint` through `import_graphql_tool`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Validate an endpoint that an imported API tool will call later.
///
/// The spec document itself is guarded by [`guarded_get_bytes`], but its
/// `servers`/host fields are attacker-controlled data and become future HTTP
/// runnable URLs. Re-parse the derived URL, reject credentials and non-HTTP
/// schemes, and resolve the host through the same private-address screen used by
/// other Core egress paths. Import endpoints intentionally do not honor the
/// agent egress allowlist: an imported API must be public by default.
pub(in crate::server) async fn validate_import_endpoint(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw.trim()).map_err(|e| format!("invalid endpoint URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("imported endpoints must use http:// or https://".to_owned());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("imported endpoints must not contain URL credentials".to_owned());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "imported endpoint URL has no host".to_owned())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "imported endpoint URL has no known port".to_owned())?;
    resolve_guarded_host(host, port).await?;
    Ok(url)
}

/// Synthesize the plugin governance record for an imported REST API: one `http`
/// tool runnable per operation + a single egress grant scoped to the API host.
/// Slugs are de-duplicated so no two runnables collide on the `app__<slug>` id.
pub(in crate::server) fn build_openapi_plugin_manifest(
    plugin_id: &str,
    api: &crate::openapi_import::ImportedApi,
) -> crate::plugin_manifest::PluginManifest {
    use crate::plugin_manifest::schema::RunnableEntry;
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let runnables = api
        .tools
        .iter()
        .map(|t| {
            let mut slug = t.slug.clone();
            let mut n = 2;
            while !seen.insert(slug.clone()) {
                slug = format!("{}_{n}", t.slug);
                n += 1;
            }
            RunnableEntry {
                id: format!("tool-{slug}"),
                name: t.name.clone(),
                kind: crate::runnable::RunnableKind::Tool,
                config: Some(json!({
                    "slug": slug,
                    "backend": "http",
                    "url": t.url,
                    "method": t.method,
                    "header_params": t.header_params,
                    "secret_headers": t.secret_headers,
                    "description": t.description,
                    "input_schema": t.input_schema,
                })),
            }
        })
        .collect();
    crate::plugin_manifest::PluginManifest {
        id: plugin_id.to_owned(),
        name: api.title.clone(),
        version: "0.0.0".to_owned(),
        runnables,
        permission_grants: vec![format!(
            "{}{}",
            crate::tool_exec::GRANT_HTTP_EGRESS_PREFIX,
            api.domain
        )],
        description: Some(format!("REST API tools imported from {}", api.domain)),
        category: Some("api".to_owned()),
        ..Default::default()
    }
}

/// `POST /api/tools/import/openapi` — turn a REST API's OpenAPI/Swagger spec into
/// a set of gateway-governed `http` tools. Resolves the spec (direct `spec_url` or
/// via apis.guru from `domain`), SSRF-guarded-fetches + parses it, and installs a
/// **disabled** plugin record whose runnables are one `http` tool per operation —
/// mirroring the MCP catalog install (the user enables it to activate the tools).
pub(in crate::server) async fn import_openapi_tools(
    State(state): State<ServerState>,
    Json(body): Json<ImportOpenApiBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    let bad =
        |status: StatusCode, msg: String| (status, Json(json!({ "success": false, "error": msg })));

    let spec_url = if let Some(u) = body
        .spec_url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
    {
        u.to_owned()
    } else if let Some(domain) = body
        .domain
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
        match resolve_apis_guru_spec_url(domain, body.hint.as_deref()).await {
            Some(u) => u,
            None => {
                return bad(
                    StatusCode::BAD_GATEWAY,
                    format!("could not resolve an OpenAPI spec for '{domain}'"),
                );
            }
        }
    } else if let Some(id) = body.id.as_deref().map(str::trim).filter(|i| !i.is_empty()) {
        match resolve_apis_guru_by_id(id).await {
            Some(u) => u,
            None => {
                return bad(
                    StatusCode::BAD_GATEWAY,
                    format!("could not resolve an OpenAPI spec for '{id}'"),
                );
            }
        }
    } else {
        return bad(
            StatusCode::BAD_REQUEST,
            "provide `spec_url`, `domain`, or `id`".to_owned(),
        );
    };

    let bytes = match guarded_get_bytes(&spec_url).await {
        Ok(b) => b,
        Err(e) => return bad(StatusCode::BAD_GATEWAY, format!("fetching spec: {e}")),
    };
    let spec = match crate::openapi_import::parse_spec(&bytes) {
        Ok(s) => s,
        Err(e) => return bad(StatusCode::UNPROCESSABLE_ENTITY, e),
    };
    let api = match crate::openapi_import::spec_to_api(&spec, crate::openapi_import::DEFAULT_OP_CAP)
    {
        Ok(a) => a,
        Err(e) => return bad(StatusCode::UNPROCESSABLE_ENTITY, e),
    };

    let base_url = match validate_import_endpoint(&api.base_url).await {
        Ok(url) => url,
        Err(error) => {
            return bad(
                StatusCode::BAD_REQUEST,
                format!("invalid imported API endpoint: {error}"),
            );
        }
    };
    let base_host = base_url.host_str().unwrap_or_default();
    if !base_host.eq_ignore_ascii_case(&api.domain) {
        return bad(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!(
                "OpenAPI base host '{}' does not match declared API domain '{}'",
                base_host, api.domain
            ),
        );
    }
    for tool in &api.tools {
        let tool_url = match validate_import_endpoint(&tool.url).await {
            Ok(url) => url,
            Err(error) => {
                return bad(
                    StatusCode::BAD_REQUEST,
                    format!("invalid imported operation endpoint: {error}"),
                );
            }
        };
        if tool_url
            .host_str()
            .map_or(true, |host| !host.eq_ignore_ascii_case(&api.domain))
        {
            return bad(
                StatusCode::UNPROCESSABLE_ENTITY,
                format!(
                    "operation endpoint host must remain on imported API domain '{}'",
                    api.domain
                ),
            );
        }
    }

    let plugin_id = format!("apiimport-{}", slugify_domain(&api.domain));
    if crate::plugin_manifest::validate_plugin_id(&plugin_id).is_err() {
        return bad(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("could not derive a valid plugin id from '{}'", api.domain),
        );
    }

    let tools = api.tools.len();
    let manifest = build_openapi_plugin_manifest(&plugin_id, &api);
    match persist_installed_plugin(&state, manifest, None, None).await {
        Ok(_) => (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "plugin_id": plugin_id,
                "title": api.title,
                "domain": api.domain,
                "tools": tools,
                "total_operations": api.total_operations,
                "dropped": api.dropped,
                // Installed disabled (mirrors MCP): enable it to activate the tools.
                "enabled": false,
            })),
        ),
        Err((StatusCode::CONFLICT, _)) => (
            StatusCode::CONFLICT,
            Json(
                json!({ "success": false, "error": format!("'{plugin_id}' is already installed") }),
            ),
        ),
        Err((status, msg)) => bad(status, msg),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct ImportGraphqlBody {
    /// The GraphQL endpoint URL (integrations.sh `graphql` entries carry it).
    pub(in crate::server) url: String,
    #[serde(default)]
    pub(in crate::server) name: Option<String>,
}

/// Synthesize the plugin record for a GraphQL endpoint: a single `http` POST tool
/// whose `{query, variables}` args become the JSON body (the GraphQL request shape).
pub(in crate::server) fn build_graphql_plugin_manifest(
    plugin_id: &str,
    name: &str,
    endpoint_url: &str,
    domain: &str,
) -> crate::plugin_manifest::PluginManifest {
    use crate::plugin_manifest::schema::RunnableEntry;
    let runnable = RunnableEntry {
        id: "tool-graphql".to_owned(),
        name: format!("{name} GraphQL"),
        kind: crate::runnable::RunnableKind::Tool,
        config: Some(json!({
            "slug": format!("{}_graphql", slugify_domain(domain)),
            "backend": "http",
            "url": endpoint_url,
            "method": "POST",
            "header_params": [],
            "description": format!("Run a GraphQL query or mutation against {domain}"),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "GraphQL query or mutation document" },
                    "variables": { "type": "object", "description": "Query variables" }
                },
                "required": ["query"]
            },
        })),
    };
    crate::plugin_manifest::PluginManifest {
        id: plugin_id.to_owned(),
        name: name.to_owned(),
        version: "0.0.0".to_owned(),
        runnables: vec![runnable],
        permission_grants: vec![format!(
            "{}{}",
            crate::tool_exec::GRANT_HTTP_EGRESS_PREFIX,
            domain
        )],
        description: Some(format!("GraphQL tool for {domain}")),
        category: Some("api".to_owned()),
        ..Default::default()
    }
}

/// `POST /api/tools/import/graphql { url, name? }` — install a GraphQL endpoint as
/// a single gateway-governed `http` tool. Disabled on install (mirrors the others).
pub(in crate::server) async fn import_graphql_tool(
    State(state): State<ServerState>,
    Json(body): Json<ImportGraphqlBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    let bad =
        |status: StatusCode, msg: String| (status, Json(json!({ "success": false, "error": msg })));
    let url = body.url.trim();
    if url.is_empty() {
        return bad(
            StatusCode::BAD_REQUEST,
            "`url` must not be empty".to_owned(),
        );
    }
    let endpoint = match validate_import_endpoint(url).await {
        Ok(endpoint) => endpoint,
        Err(error) => return bad(StatusCode::BAD_REQUEST, error),
    };
    let domain = endpoint
        .host_str()
        .map(str::to_ascii_lowercase)
        .filter(|h| !h.is_empty())
        .expect("validated import endpoint has a host");
    let name = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(&domain)
        .to_owned();
    let plugin_id = format!("graphql-{}", slugify_domain(&domain));
    if crate::plugin_manifest::validate_plugin_id(&plugin_id).is_err() {
        return bad(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("could not derive a valid plugin id from '{domain}'"),
        );
    }
    let manifest = build_graphql_plugin_manifest(&plugin_id, &name, url, &domain);
    match persist_installed_plugin(&state, manifest, None, None).await {
        Ok(_) => (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "plugin_id": plugin_id,
                "domain": domain,
                "tools": 1,
                "enabled": false,
            })),
        ),
        Err((StatusCode::CONFLICT, _)) => (
            StatusCode::CONFLICT,
            Json(
                json!({ "success": false, "error": format!("'{plugin_id}' is already installed") }),
            ),
        ),
        Err((status, msg)) => bad(status, msg),
    }
}
