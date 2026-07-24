//! OpenAPI → tool descriptors (Slice 2c of the integrations.sh install-abstraction).
//!
//! Pure, dependency-free (serde_json + serde_yml, both already deps) transform: a
//! fetched OpenAPI/Swagger document → a capped set of [`ImportedTool`]s, each of
//! which lowers directly onto the existing `http` tool backend
//! (`ToolBackend::Http` + [`crate::tool_exec::run_http_tool`], Slices 2a/2b). An
//! operation's parameters partition by location: `{name}` path placeholders in the
//! URL, `in: header` params + auth → `header_params`, the rest handled by the
//! run_http_tool convention (query for GET/HEAD, JSON body otherwise).
//!
//! Deliberately hand-parsed off `serde_json::Value` rather than the strict
//! `openapiv3` typed model: the apis.guru corpus (3806 specs) is full of minor
//! non-conformances, and a resilient best-effort parse yields more usable tools
//! than a strict parse that rejects the whole document on one bad field.
//!
//! This module is pure so it is unit-testable headless; the install/persist wiring
//! (resolve the spec URL, synthesize a plugin manifest, write the governance
//! record) lives with the server, mirroring the MCP catalog install.

use serde_json::{json, Map, Value};

/// Default per-API operation cap. Big specs (some apis.guru entries have hundreds
/// of operations) would otherwise flood the tool registry; the importer keeps the
/// first `cap` after prioritising GETs and reports the rest as `dropped`.
pub const DEFAULT_OP_CAP: usize = 40;

/// One OpenAPI operation lowered to an `http` tool. Field names match the manifest
/// `ToolConfig` the install step synthesizes.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportedTool {
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub method: String,
    /// Base URL + path, keeping `{name}` path placeholders for run_http_tool.
    pub url: String,
    /// Arg names sent as request headers (`in: header` params). Auth headers are
    /// NOT here — they live in [`secret_headers`], sourced server-side.
    ///
    /// [`secret_headers`]: ImportedTool::secret_headers
    pub header_params: Vec<String>,
    /// Auth headers whose VALUES are injected server-side and never model-visible:
    /// wire header name → `env:RYU_TOOL_<SLUG>_AUTH` source (the connect flow
    /// populates that env). Keeps the token out of `input_schema`/`header_params`.
    pub secret_headers: std::collections::BTreeMap<String, String>,
    /// JSON Schema (`type: object`) for discovery; unions path/query/header params
    /// and the JSON request body's properties. NEVER contains an auth header.
    pub input_schema: Value,
}

/// The result of importing one spec: the callable tools plus what the cap dropped.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportedApi {
    pub title: String,
    /// Egress host (drives the `tool:http-egress:<domain>` grant).
    pub domain: String,
    pub base_url: String,
    pub tools: Vec<ImportedTool>,
    pub total_operations: usize,
    pub dropped: usize,
}

/// Parse spec bytes as JSON, falling back to YAML (both formats appear in the
/// wild; apis.guru serves JSON, other feeds serve YAML).
pub fn parse_spec(bytes: &[u8]) -> Result<Value, String> {
    if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
        return Ok(value);
    }
    let text = String::from_utf8_lossy(bytes);
    serde_yml::from_str::<Value>(&text)
        .map_err(|e| format!("spec is neither valid JSON nor YAML: {e}"))
}

/// HTTP methods that carry an operation object under a path item.
const METHODS: [&str; 5] = ["get", "post", "put", "patch", "delete"];

/// Transform a parsed spec into an [`ImportedApi`]. Returns an error only when the
/// spec has no resolvable base URL or no operations — individual malformed
/// operations are skipped, not fatal.
pub fn spec_to_api(spec: &Value, cap: usize) -> Result<ImportedApi, String> {
    let title = spec
        .pointer("/info/title")
        .and_then(Value::as_str)
        .unwrap_or("API")
        .to_owned();
    let base_url = resolve_base_url(spec).ok_or("no resolvable server/base URL in spec")?;
    let domain =
        host_of(&base_url).ok_or_else(|| format!("could not parse host from '{base_url}'"))?;
    let schemes = security_schemes(spec);
    let global_security = spec.get("security");

    let paths = spec
        .get("paths")
        .and_then(Value::as_object)
        .ok_or("spec has no paths")?;

    let mut all: Vec<ImportedTool> = Vec::new();
    for (path, item) in paths {
        let Some(item) = item.as_object() else {
            continue;
        };
        let path_level = collect_params(item.get("parameters"));
        for method in METHODS {
            let Some(op) = item.get(method).and_then(Value::as_object) else {
                continue;
            };
            if let Some(tool) = build_tool(
                method,
                path,
                op,
                &path_level,
                &base_url,
                &schemes,
                global_security,
            ) {
                all.push(tool);
            }
        }
    }

    if all.is_empty() {
        return Err("spec produced no importable operations".to_owned());
    }
    let total = all.len();
    // Prioritise GETs (read-only, safest + most useful first), stable within group.
    all.sort_by_key(|t| u8::from(t.method != "GET"));
    let dropped = total.saturating_sub(cap);
    all.truncate(cap);

    Ok(ImportedApi {
        title,
        domain,
        base_url,
        tools: all,
        total_operations: total,
        dropped,
    })
}

/// A single OpenAPI parameter reduced to what the importer needs.
struct Param {
    name: String,
    location: String,
    required: bool,
    schema: Value,
    description: Option<String>,
}

fn collect_params(raw: Option<&Value>) -> Vec<Param> {
    let mut out = Vec::new();
    let Some(arr) = raw.and_then(Value::as_array) else {
        return out;
    };
    for p in arr {
        let Some(obj) = p.as_object() else { continue };
        // `$ref` params are skipped (best-effort — resolving refs is out of scope).
        let (Some(name), Some(location)) = (
            obj.get("name").and_then(Value::as_str),
            obj.get("in").and_then(Value::as_str),
        ) else {
            continue;
        };
        out.push(Param {
            name: name.to_owned(),
            location: location.to_owned(),
            required: obj
                .get("required")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            schema: obj
                .get("schema")
                .cloned()
                .unwrap_or(json!({ "type": "string" })),
            description: obj
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_owned),
        });
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn build_tool(
    method: &str,
    path: &str,
    op: &Map<String, Value>,
    path_level: &[Param],
    base_url: &str,
    schemes: &Map<String, Value>,
    global_security: Option<&Value>,
) -> Option<ImportedTool> {
    let slug = op
        .get("operationId")
        .and_then(Value::as_str)
        .map(slugify)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| slugify(&format!("{method}_{path}")));
    if slug.is_empty() {
        return None;
    }
    let name = op
        .get("summary")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| slug.clone());
    let description = op
        .get("description")
        .or_else(|| op.get("summary"))
        .and_then(Value::as_str)
        .map(str::to_owned);

    let mut properties = Map::new();
    let mut required: Vec<String> = Vec::new();
    let mut header_params: Vec<String> = Vec::new();
    let mut secret_headers: std::collections::BTreeMap<String, String> =
        std::collections::BTreeMap::new();

    // Merge path-level then operation-level params (op wins on name+in collision).
    let mut params = Vec::new();
    params.extend(collect_params(op.get("parameters")));
    for p in path_level {
        if !params
            .iter()
            .any(|q| q.name == p.name && q.location == p.location)
        {
            params.push(Param {
                name: p.name.clone(),
                location: p.location.clone(),
                required: p.required,
                schema: p.schema.clone(),
                description: p.description.clone(),
            });
        }
    }
    for p in &params {
        let mut schema = p.schema.clone();
        if let (Some(obj), Some(desc)) = (schema.as_object_mut(), p.description.as_ref()) {
            obj.entry("description")
                .or_insert_with(|| Value::String(desc.clone()));
        }
        properties.insert(p.name.clone(), schema);
        if p.required || p.location == "path" {
            required.push(p.name.clone());
        }
        if p.location == "header" {
            header_params.push(p.name.clone());
        }
    }

    // Request body: merge a JSON object body's properties as top-level args (they
    // flow to the JSON body via run_http_tool for non-GET methods).
    if let Some(body_schema) = op
        .get("requestBody")
        .and_then(|rb| rb.pointer("/content/application~1json/schema"))
        .and_then(Value::as_object)
    {
        if let Some(props) = body_schema.get("properties").and_then(Value::as_object) {
            for (k, v) in props {
                properties.entry(k.clone()).or_insert_with(|| v.clone());
            }
        }
        if let Some(req) = body_schema.get("required").and_then(Value::as_array) {
            for r in req.iter().filter_map(Value::as_str) {
                if !required.iter().any(|x| x == r) {
                    required.push(r.to_owned());
                }
            }
        }
    }

    // Security → auth headers. A header apiKey / http-bearer scheme becomes a
    // SERVER-SIDE secret header (never a model-visible arg); a query apiKey stays a
    // normal query arg. The secret's value is sourced from `env:RYU_TOOL_<SLUG>_AUTH`,
    // which the connect flow populates — the token never enters `input_schema`.
    apply_security(
        op.get("security").or(global_security),
        schemes,
        &slug,
        &mut properties,
        &mut secret_headers,
    );

    let input_schema = json!({
        "type": "object",
        "properties": Value::Object(properties),
        "required": required,
    });

    Some(ImportedTool {
        slug,
        name,
        description,
        method: method.to_ascii_uppercase(),
        url: format!("{}{}", base_url.trim_end_matches('/'), path),
        header_params,
        secret_headers,
        input_schema,
    })
}

/// The per-tool env var name the connect flow populates with an imported tool's
/// auth header value: `RYU_TOOL_<SLUG>_AUTH` (slug uppercased, non-alnum → `_`).
fn auth_env_var(slug: &str) -> String {
    let up: String = slug
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect();
    format!("RYU_TOOL_{up}_AUTH")
}

/// Map the operation's security requirements onto auth args. A HEADER apiKey or an
/// http-bearer scheme becomes a SERVER-SIDE [`ImportedTool::secret_headers`] entry
/// (wire header name → `env:RYU_TOOL_<SLUG>_AUTH`) so the token is NEVER exposed in
/// the model-visible `input_schema`/`header_params`. A QUERY apiKey stays a normal
/// (non-secret) query arg — it is a locator, not a bearer secret, and lowers onto
/// the query string like any other arg.
fn apply_security(
    security: Option<&Value>,
    schemes: &Map<String, Value>,
    slug: &str,
    properties: &mut Map<String, Value>,
    secret_headers: &mut std::collections::BTreeMap<String, String>,
) {
    let Some(reqs) = security.and_then(Value::as_array) else {
        return;
    };
    let source = format!("env:{}", auth_env_var(slug));
    for req in reqs {
        let Some(obj) = req.as_object() else { continue };
        for scheme_name in obj.keys() {
            let Some(scheme) = schemes.get(scheme_name).and_then(Value::as_object) else {
                continue;
            };
            let kind = scheme.get("type").and_then(Value::as_str).unwrap_or("");
            match kind {
                "apiKey" => {
                    let loc = scheme.get("in").and_then(Value::as_str).unwrap_or("header");
                    let name = scheme
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("api_key")
                        .to_owned();
                    if loc == "header" {
                        // Header apiKey = a secret, sourced server-side. Not a model arg.
                        secret_headers.entry(name).or_insert_with(|| source.clone());
                    } else {
                        // Query apiKey stays a normal query arg.
                        properties.entry(name).or_insert_with(
                            || json!({ "type": "string", "description": "API key" }),
                        );
                    }
                }
                "http" => {
                    let bearer = scheme
                        .get("scheme")
                        .and_then(Value::as_str)
                        .is_none_or(|s| s.eq_ignore_ascii_case("bearer"));
                    if bearer {
                        // Bearer token = a secret header, sourced server-side. The
                        // env value must include the `Bearer ` prefix (spliced
                        // verbatim by `run_http_tool`).
                        secret_headers
                            .entry("Authorization".to_owned())
                            .or_insert_with(|| source.clone());
                    }
                }
                _ => {}
            }
        }
    }
}

fn security_schemes(spec: &Value) -> Map<String, Value> {
    // OpenAPI 3: components.securitySchemes; Swagger 2: securityDefinitions.
    spec.pointer("/components/securitySchemes")
        .or_else(|| spec.get("securityDefinitions"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// Resolve the request base URL from either OpenAPI 3 `servers` or Swagger 2
/// `host`/`basePath`/`schemes`. Prefers an `https` server; skips templated/relative
/// server URLs (best-effort — they can't be called without variable substitution).
fn resolve_base_url(spec: &Value) -> Option<String> {
    if let Some(servers) = spec.get("servers").and_then(Value::as_array) {
        let urls: Vec<&str> = servers
            .iter()
            .filter_map(|s| s.get("url").and_then(Value::as_str))
            .filter(|u| u.starts_with("http") && !u.contains('{'))
            .collect();
        if let Some(https) = urls.iter().find(|u| u.starts_with("https")) {
            return Some((*https).to_owned());
        }
        if let Some(first) = urls.first() {
            return Some((*first).to_owned());
        }
    }
    // Swagger 2 fallback.
    let host = spec.get("host").and_then(Value::as_str)?;
    let base_path = spec.get("basePath").and_then(Value::as_str).unwrap_or("");
    let scheme = spec
        .get("schemes")
        .and_then(Value::as_array)
        .and_then(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .find(|s| *s == "https")
                .or_else(|| a.iter().filter_map(Value::as_str).next())
        })
        .unwrap_or("https");
    Some(format!("{scheme}://{host}{base_path}"))
}

/// Extract the host from a base URL (`https://api.x.com/v1` → `api.x.com`).
fn host_of(base_url: &str) -> Option<String> {
    let after_scheme = base_url.split("://").nth(1).unwrap_or(base_url);
    let host = after_scheme
        .split(['/', '?', '#'])
        .next()?
        .split('@')
        .next_back()?
        .split(':')
        .next()?;
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

/// Lowercase, keep `[a-z0-9_]`, collapse other runs to a single `_`, trim `_`.
fn slugify(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_us = false;
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_us = false;
        } else if !prev_us {
            out.push('_');
            prev_us = true;
        }
    }
    out.trim_matches('_').to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn petstore() -> Value {
        json!({
            "openapi": "3.0.0",
            "info": { "title": "Pet Store" },
            "servers": [{ "url": "https://api.petstore.example/v1" }],
            "components": {
                "securitySchemes": {
                    "key": { "type": "apiKey", "in": "header", "name": "X-API-Key" }
                }
            },
            "security": [{ "key": [] }],
            "paths": {
                "/pets/{petId}": {
                    "get": {
                        "operationId": "getPet",
                        "summary": "Get a pet",
                        "parameters": [
                            { "name": "petId", "in": "path", "required": true, "schema": { "type": "string" } },
                            { "name": "verbose", "in": "query", "schema": { "type": "boolean" } }
                        ]
                    }
                },
                "/pets": {
                    "post": {
                        "operationId": "createPet",
                        "summary": "Create a pet",
                        "requestBody": {
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "required": ["name"],
                                        "properties": { "name": { "type": "string" } }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        })
    }

    #[test]
    fn imports_base_url_and_domain() {
        let api = spec_to_api(&petstore(), DEFAULT_OP_CAP).unwrap();
        assert_eq!(api.base_url, "https://api.petstore.example/v1");
        assert_eq!(api.domain, "api.petstore.example");
        assert_eq!(api.title, "Pet Store");
        assert_eq!(api.total_operations, 2);
        assert_eq!(api.dropped, 0);
        // GET is prioritised to the front.
        assert_eq!(api.tools[0].method, "GET");
    }

    #[test]
    fn get_op_maps_path_query_and_auth_header() {
        let api = spec_to_api(&petstore(), DEFAULT_OP_CAP).unwrap();
        let get = api.tools.iter().find(|t| t.slug == "getpet").unwrap();
        assert_eq!(get.method, "GET");
        assert_eq!(get.url, "https://api.petstore.example/v1/pets/{petId}");
        // apiKey HEADER from the security scheme is routed to secret_headers
        // (server-side sourced), NOT to header_params or the model-visible schema.
        assert!(!get.header_params.contains(&"X-API-Key".to_owned()));
        assert_eq!(
            get.secret_headers.get("X-API-Key").map(String::as_str),
            Some("env:RYU_TOOL_GETPET_AUTH")
        );
        let props = get.input_schema.pointer("/properties").unwrap();
        assert!(props.get("petId").is_some());
        assert!(props.get("verbose").is_some());
        // The auth header must NOT leak into the model-visible input schema.
        assert!(props.get("X-API-Key").is_none());
        let required = get
            .input_schema
            .pointer("/required")
            .unwrap()
            .as_array()
            .unwrap();
        assert!(required.iter().any(|r| r == "petId"));
    }

    #[test]
    fn post_op_merges_request_body_props() {
        let api = spec_to_api(&petstore(), DEFAULT_OP_CAP).unwrap();
        let post = api.tools.iter().find(|t| t.slug == "createpet").unwrap();
        assert_eq!(post.method, "POST");
        assert_eq!(post.url, "https://api.petstore.example/v1/pets");
        let props = post.input_schema.pointer("/properties").unwrap();
        assert!(props.get("name").is_some());
        // Body-declared `required` propagates.
        let required = post
            .input_schema
            .pointer("/required")
            .unwrap()
            .as_array()
            .unwrap();
        assert!(required.iter().any(|r| r == "name"));
    }

    #[test]
    fn cap_drops_and_reports() {
        let api = spec_to_api(&petstore(), 1).unwrap();
        assert_eq!(api.tools.len(), 1);
        assert_eq!(api.total_operations, 2);
        assert_eq!(api.dropped, 1);
        // The kept one is the GET (prioritised).
        assert_eq!(api.tools[0].method, "GET");
    }

    #[test]
    fn swagger2_host_basepath_base_url() {
        let spec = json!({
            "swagger": "2.0",
            "info": { "title": "Legacy" },
            "host": "api.legacy.example",
            "basePath": "/v2",
            "schemes": ["https", "http"],
            "paths": {
                "/ping": { "get": { "operationId": "ping" } }
            }
        });
        let api = spec_to_api(&spec, DEFAULT_OP_CAP).unwrap();
        assert_eq!(api.base_url, "https://api.legacy.example/v2");
        assert_eq!(api.domain, "api.legacy.example");
        assert_eq!(api.tools[0].url, "https://api.legacy.example/v2/ping");
    }

    #[test]
    fn parse_spec_accepts_yaml() {
        let yaml = b"openapi: 3.0.0\ninfo:\n  title: Y\nservers:\n  - url: https://y.example\npaths:\n  /a:\n    get:\n      operationId: aGet\n";
        let spec = parse_spec(yaml).unwrap();
        let api = spec_to_api(&spec, DEFAULT_OP_CAP).unwrap();
        assert_eq!(api.domain, "y.example");
        assert_eq!(api.tools[0].slug, "aget");
    }
}
