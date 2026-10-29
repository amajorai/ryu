//! OpenAPI → tool descriptors (Slice 2c of the integrations.sh install-abstraction).
//!
//! Pure, dependency-free (serde_json + noyalib) transform: a fetched
//! OpenAPI/Swagger document → a capped set of [`ImportedTool`]s, each of which
//! lowers directly onto Core's `http` tool backend (`ToolBackend::Http` +
//! `tool_exec::run_http_tool`, Slices 2a/2b). An operation's parameters
//! partition by location: `{name}` path placeholders in the URL, `in: header`
//! params + auth → `header_params`, the rest handled by the run_http_tool
//! convention (query for GET/HEAD, JSON body otherwise).
//!
//! Deliberately hand-parsed off `serde_json::Value` rather than the strict
//! `openapiv3` typed model: the apis.guru corpus (3806 specs) is full of minor
//! non-conformances, and a resilient best-effort parse yields more usable tools
//! than a strict parse that rejects the whole document on one bad field.
//!
//! This crate is pure so it is unit-testable headless; the install/persist wiring
//! (resolve the spec URL, synthesize a plugin manifest, write the governance
//! record) lives with Core's server, mirroring the MCP catalog install. Core
//! re-exports it as `crate::openapi_import`.
//!
//! These are also the parse rules of Ryu's generated tool catalog tier (Treg
//! parity C1, `docs/treg-parity.md`): `tools/tool-catalog-generate/openapi-rules.ts`
//! ports them to TypeScript, and both sides assert the golden cases in
//! `fixtures/openapi-import-cases-v1.json` (`tests/golden_cases.rs` here). Change
//! a rule on both sides and in the cases together.

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
    noyalib::compat::serde_yaml::from_str::<Value>(&text)
        .map_err(|e| format!("spec is neither valid JSON nor YAML: {e}"))
}

/// HTTP methods that carry an operation object under a path item.
const METHODS: [&str; 5] = ["get", "post", "put", "patch", "delete"];

/// Transform a parsed spec into an [`ImportedApi`], resolving the base URL from the
/// spec itself. Returns an error only when the spec has no resolvable base URL or no
/// operations — individual malformed operations are skipped, not fatal.
pub fn spec_to_api(spec: &Value, cap: usize) -> Result<ImportedApi, String> {
    spec_to_api_with_base(spec, cap, None)
}

/// [`spec_to_api`] with a caller-supplied base URL that wins over the spec's own
/// `servers` / `host` block.
///
/// WHY the override exists: our own app sidecars publish OpenAPI sub-documents that
/// carry NO `servers` entry, so [`resolve_base_url`] returns `None` and the import
/// dies before it looks at a single operation. The obvious "fix" — teaching each
/// sidecar to emit `servers(...)` — is the wrong one: an app under `apps-store/<app>`
/// is mirrored out as a standalone satellite repo that must build and ship from its
/// own tree alone (see AGENTS.md), and a hardcoded `servers` URL would bake this
/// Core's loopback host and ext-proxy port into all 22 published satellites. So the
/// address stays where it is actually known — in the Core that mounts the sidecar —
/// and is threaded in here instead.
///
/// `base_url_override` must be absolute (`http://127.0.0.1:<port>/...`): the derived
/// egress `domain` comes from [`host_of`], which cannot parse a host out of a
/// relative mount path.
pub fn spec_to_api_with_base(
    spec: &Value,
    cap: usize,
    base_url_override: Option<&str>,
) -> Result<ImportedApi, String> {
    let title = spec
        .pointer("/info/title")
        .and_then(Value::as_str)
        .unwrap_or("API")
        .to_owned();
    let base_url = base_url_override
        .map(str::to_owned)
        .or_else(|| resolve_base_url(spec))
        .ok_or("no resolvable server/base URL in spec")?;
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
        let path_level = collect_params(spec, item.get("parameters"));
        for method in METHODS {
            let Some(op) = item.get(method).and_then(Value::as_object) else {
                continue;
            };
            if let Some(tool) = build_tool(
                spec,
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

/// How many `$ref` hops [`resolve_ref`] will follow before giving up. Real specs
/// chain at most two or three (`parameter → schema → schema`); the cap is really a
/// cycle guard, since a self- or mutually-referential schema (a tree node whose
/// child is the same node) is legal OpenAPI and would otherwise loop forever.
const MAX_REF_DEPTH: usize = 8;
/// One level of `$ref` expansion inside an already-resolved object's `properties`.
/// Deliberately shallow: the point is to hand the model a readable schema for a
/// field, not to inline a whole recursive object graph into `input_schema`.
const NESTED_REF_DEPTH: usize = MAX_REF_DEPTH;

/// Follow a local `$ref` to the node it names, returning non-ref nodes unchanged.
///
/// Only same-document refs (`#/...`) resolve — an external one (`common.yaml#/x`)
/// fails `strip_prefix` and yields `None`, which every caller treats as "leave this
/// alone", the same best-effort posture as the rest of the module. `Value::pointer`
/// already implements RFC 6901, so `#/components/schemas/Foo` (OpenAPI 3) and
/// `#/definitions/Foo` (Swagger 2) both work without branching on the prefix.
/// A nullable wrapper also counts as a hop. An OPTIONAL body or field is not written
/// as a bare `$ref` by either generator we consume: FastAPI renders `Optional[Model]`
/// as `{"anyOf": [{"$ref": …}, {"type": "null"}]}`, and utoipa renders `Option<T>` as
/// the `oneOf` equivalent. Both put the ref one level down, where a top-of-node check
/// never sees it — so the schema resolves to a wrapper with no `properties`, and the
/// derived tool ships with zero arguments. That is precisely the failure this resolver
/// exists to prevent, arrived at from a direction the obvious implementation misses.
///
/// So: when a node is a `oneOf`/`anyOf` whose branches are exactly ONE meaningful
/// schema plus null-ish alternatives, unwrap to that branch and keep resolving. A
/// genuine union of several real schemas is left alone — there is no single correct
/// argument shape to pick, and inventing one would be worse than saying nothing.
fn unwrap_nullable(node: &Value) -> Option<&Value> {
    let branches = node
        .get("oneOf")
        .or_else(|| node.get("anyOf"))?
        .as_array()?;
    let mut meaningful = branches.iter().filter(|b| !is_null_schema(b));
    let only = meaningful.next()?;
    meaningful.next().is_none().then_some(only)
}

/// Whether a schema branch carries no information beyond "may be absent".
fn is_null_schema(node: &Value) -> bool {
    match node.get("type") {
        // OpenAPI 3.1 / JSON Schema 2020-12 spell it as a type.
        Some(Value::String(t)) => t == "null",
        Some(Value::Array(types)) => types.iter().all(|t| t.as_str() == Some("null")),
        // OpenAPI 3.0 has no null type; a nullable branch appears as `{"nullable": true}`
        // or, from some generators, an empty schema.
        None => {
            node.get("nullable").and_then(Value::as_bool) == Some(true)
                || node.as_object().is_some_and(serde_json::Map::is_empty)
        }
        _ => false,
    }
}

/// Follow a local `$ref` to the node it names, returning non-ref nodes unchanged.
///
/// Only same-document refs (`#/...`) resolve — an external one (`common.yaml#/x`)
/// fails `strip_prefix` and yields `None`, which every caller treats as "leave this
/// alone", the same best-effort posture as the rest of the module. `Value::pointer`
/// already implements RFC 6901, so `#/components/schemas/Foo` (OpenAPI 3) and
/// `#/definitions/Foo` (Swagger 2) both work without branching on the prefix.
///
/// Nullable `oneOf`/`anyOf` wrappers are transparent here — see [`unwrap_nullable`].
fn resolve_ref<'a>(spec: &'a Value, node: &'a Value, depth: usize) -> Option<&'a Value> {
    let mut cur = node;
    for _ in 0..depth {
        if let Some(target) = cur.get("$ref").and_then(Value::as_str) {
            cur = spec.pointer(target.strip_prefix('#')?)?;
            continue;
        }
        if let Some(inner) = unwrap_nullable(cur) {
            cur = inner;
            continue;
        }
        return Some(cur);
    }
    // Depth exhausted: the chain is cyclic (or absurdly deep). Bail rather than loop.
    None
}

fn collect_params(spec: &Value, raw: Option<&Value>) -> Vec<Param> {
    let mut out = Vec::new();
    let Some(arr) = raw.and_then(Value::as_array) else {
        return out;
    };
    for p in arr {
        // A parameter may itself be a `$ref` into `#/components/parameters` (or
        // Swagger 2's `#/parameters`); resolve it, and skip only if it does not.
        let Some(obj) = resolve_ref(spec, p, MAX_REF_DEPTH).and_then(Value::as_object) else {
            continue;
        };
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
                .and_then(|s| resolve_ref(spec, s, MAX_REF_DEPTH))
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
    spec: &Value,
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
    params.extend(collect_params(spec, op.get("parameters")));
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
    //
    // Both hops go through `resolve_ref`, and both are load-bearing. A generated
    // document almost never inlines the body schema here: FastAPI *always* emits
    // `{"$ref": "#/components/schemas/…"}`, and utoipa does the same as soon as a
    // handler declares a real `request_body` type instead of `serde_json::Value`.
    // A `$ref` node carries no `properties` key, so reading it unresolved yields a
    // tool the model can discover and call but can never fill in — every argument
    // silently invisible, with no error anywhere to explain why.
    if let Some(body_schema) = op
        .get("requestBody")
        .and_then(|rb| resolve_ref(spec, rb, MAX_REF_DEPTH))
        .and_then(|rb| rb.pointer("/content/application~1json/schema"))
        .and_then(|s| resolve_ref(spec, s, MAX_REF_DEPTH))
        .and_then(Value::as_object)
    {
        if let Some(props) = body_schema.get("properties").and_then(Value::as_object) {
            for (k, v) in props {
                // A property may itself be a `$ref` to a nested component. Resolve
                // one level so the model sees a usable schema rather than an opaque
                // pointer it cannot interpret; deeper nesting keeps the ref.
                let resolved = resolve_ref(spec, v, NESTED_REF_DEPTH).unwrap_or(v);
                properties
                    .entry(k.clone())
                    .or_insert_with(|| resolved.clone());
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

    /// A document with no `servers` block — the shape utoipa and FastAPI both
    /// generate. Without an override this fails at the first line of
    /// `spec_to_api_with_base`, which is what blocked deriving tools from an app
    /// sidecar's own spec.
    fn serverless_spec() -> Value {
        json!({
            "openapi": "3.0.0",
            "info": { "title": "Quests" },
            "paths": {
                "/api/quests/{id}": {
                    "get": {
                        "operationId": "get_quest",
                        "summary": "Read one quest",
                        "parameters": [
                            { "name": "id", "in": "path", "required": true, "schema": { "type": "string" } }
                        ]
                    }
                }
            }
        })
    }

    #[test]
    fn spec_to_api_with_base_overrides_missing_servers() {
        let spec = serverless_spec();
        assert!(
            spec_to_api(&spec, DEFAULT_OP_CAP).is_err(),
            "a serverless spec must still fail without an override"
        );

        let api =
            spec_to_api_with_base(&spec, DEFAULT_OP_CAP, Some("http://127.0.0.1:8011")).unwrap();
        assert_eq!(api.base_url, "http://127.0.0.1:8011");
        // Pins the `host_of` assumption: the override must be an ABSOLUTE URL, or
        // domain derivation (and with it the egress grant) has nothing to parse.
        assert_eq!(api.domain, "127.0.0.1");
        assert_eq!(api.tools.len(), 1);
        assert_eq!(api.tools[0].url, "http://127.0.0.1:8011/api/quests/{id}");
    }

    #[test]
    fn spec_to_api_still_reads_servers_when_no_override() {
        let api = spec_to_api_with_base(&petstore(), DEFAULT_OP_CAP, None).unwrap();
        assert_eq!(api.domain, "api.petstore.example");
        assert!(api
            .tools
            .iter()
            .all(|t| t.url.starts_with("https://api.petstore.example/v1")));
    }

    #[test]
    fn request_body_ref_is_resolved_into_properties() {
        let spec = json!({
            "openapi": "3.0.0",
            "info": { "title": "CRM" },
            "servers": [{ "url": "https://crm.example" }],
            "components": {
                "schemas": {
                    "CreateThing": {
                        "type": "object",
                        "required": ["title"],
                        "properties": {
                            "title": { "type": "string", "description": "Display name." },
                            "owner": { "$ref": "#/components/schemas/Owner" }
                        }
                    },
                    "Owner": { "type": "object", "properties": { "email": { "type": "string" } } }
                }
            },
            "paths": {
                "/things": {
                    "post": {
                        "operationId": "createThing",
                        "requestBody": {
                            "content": {
                                "application/json": {
                                    "schema": { "$ref": "#/components/schemas/CreateThing" }
                                }
                            }
                        }
                    }
                }
            }
        });

        let api = spec_to_api(&spec, DEFAULT_OP_CAP).unwrap();
        let tool = &api.tools[0];
        let props = tool.input_schema.pointer("/properties").unwrap();
        assert!(
            props.get("title").is_some(),
            "a $ref body must contribute its properties, got {props:#}"
        );
        assert_eq!(
            tool.input_schema
                .pointer("/required/0")
                .and_then(Value::as_str),
            Some("title")
        );
        // A property that is itself a `$ref` resolves one level, so the model sees a
        // real schema instead of an opaque pointer.
        assert_eq!(
            props
                .pointer("/owner/properties/email/type")
                .and_then(Value::as_str),
            Some("string")
        );
    }

    #[test]
    fn ref_cycle_does_not_hang() {
        let spec = json!({
            "openapi": "3.0.0",
            "info": { "title": "Loop" },
            "servers": [{ "url": "https://loop.example" }],
            "components": {
                "schemas": { "Node": { "$ref": "#/components/schemas/Node" } }
            },
            "paths": {
                "/n": {
                    "post": {
                        "operationId": "makeNode",
                        "requestBody": {
                            "content": {
                                "application/json": {
                                    "schema": { "$ref": "#/components/schemas/Node" }
                                }
                            }
                        }
                    }
                }
            }
        });

        // The cap bails instead of looping. `build_tool` does not treat a missing
        // body schema as fatal, so the tool still exists — just with no body args.
        let api = spec_to_api(&spec, DEFAULT_OP_CAP).unwrap();
        let props = api.tools[0].input_schema.pointer("/properties").unwrap();
        assert_eq!(props.as_object().map(serde_json::Map::len), Some(0));
    }

    #[test]
    fn swagger2_definitions_ref_is_resolved() {
        // `Value::pointer` is RFC 6901, so a `#/definitions/...` target resolves with
        // no prefix branching. This pins that, rather than Swagger 2 `in: body`
        // parameter flattening, which this importer deliberately does not do.
        let spec = json!({
            "openapi": "3.0.0",
            "info": { "title": "Legacy" },
            "servers": [{ "url": "https://legacy.example" }],
            "definitions": {
                "Thing": { "type": "object", "properties": { "sku": { "type": "string" } } }
            },
            "paths": {
                "/things": {
                    "post": {
                        "operationId": "addThing",
                        "requestBody": {
                            "content": {
                                "application/json": { "schema": { "$ref": "#/definitions/Thing" } }
                            }
                        }
                    }
                }
            }
        });

        let api = spec_to_api(&spec, DEFAULT_OP_CAP).unwrap();
        assert!(api.tools[0]
            .input_schema
            .pointer("/properties/sku")
            .is_some());
    }

    #[test]
    fn nullable_wrapped_body_ref_still_resolves() {
        // FastAPI writes `Optional[Model]` exactly like this, and utoipa writes
        // `Option<T>` as the `oneOf` equivalent. Before the wrapper was made
        // transparent, this produced a tool with zero arguments — discoverable and
        // uncallable — with nothing anywhere to say why.
        let body = |wrapper: &str| {
            json!({
                "openapi": "3.1.0",
                "info": { "title": "Opt" },
                "servers": [{ "url": "https://opt.example" }],
                "components": {
                    "schemas": {
                        "Patch": {
                            "type": "object",
                            "properties": { "title": { "type": "string" } }
                        }
                    }
                },
                "paths": {
                    "/things/{id}": {
                        "patch": {
                            "operationId": "patchThing",
                            "requestBody": {
                                "content": {
                                    "application/json": {
                                        "schema": {
                                            wrapper: [
                                                { "$ref": "#/components/schemas/Patch" },
                                                { "type": "null" }
                                            ]
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            })
        };

        for wrapper in ["anyOf", "oneOf"] {
            let api = spec_to_api(&body(wrapper), DEFAULT_OP_CAP).unwrap();
            assert!(
                api.tools[0]
                    .input_schema
                    .pointer("/properties/title")
                    .is_some(),
                "{wrapper}-wrapped body ref must still yield arguments"
            );
        }
    }

    #[test]
    fn a_real_union_body_is_left_alone() {
        // Two meaningful branches: there is no single correct argument shape, and
        // picking one would advertise arguments the endpoint may reject. Saying
        // nothing is the honest answer.
        let spec = json!({
            "openapi": "3.1.0",
            "info": { "title": "Union" },
            "servers": [{ "url": "https://u.example" }],
            "components": {
                "schemas": {
                    "A": { "type": "object", "properties": { "a": { "type": "string" } } },
                    "B": { "type": "object", "properties": { "b": { "type": "string" } } }
                }
            },
            "paths": {
                "/x": {
                    "post": {
                        "operationId": "postX",
                        "requestBody": {
                            "content": {
                                "application/json": {
                                    "schema": { "oneOf": [
                                        { "$ref": "#/components/schemas/A" },
                                        { "$ref": "#/components/schemas/B" }
                                    ]}
                                }
                            }
                        }
                    }
                }
            }
        });

        let api = spec_to_api(&spec, DEFAULT_OP_CAP).unwrap();
        let props = api.tools[0].input_schema.pointer("/properties").unwrap();
        assert_eq!(props.as_object().map(serde_json::Map::len), Some(0));
    }

    #[test]
    fn openapi_30_nullable_branch_is_also_transparent() {
        // OpenAPI 3.0 has no null type; generators emit `{"nullable": true}` instead.
        let spec = json!({
            "openapi": "3.0.0",
            "info": { "title": "Legacy opt" },
            "servers": [{ "url": "https://l.example" }],
            "components": {
                "schemas": {
                    "P": { "type": "object", "properties": { "n": { "type": "integer" } } }
                }
            },
            "paths": {
                "/p": {
                    "post": {
                        "operationId": "postP",
                        "requestBody": {
                            "content": {
                                "application/json": {
                                    "schema": { "anyOf": [
                                        { "$ref": "#/components/schemas/P" },
                                        { "nullable": true }
                                    ]}
                                }
                            }
                        }
                    }
                }
            }
        });

        let api = spec_to_api(&spec, DEFAULT_OP_CAP).unwrap();
        assert!(api.tools[0].input_schema.pointer("/properties/n").is_some());
    }

    #[test]
    fn ref_parameters_are_resolved_rather_than_skipped() {
        let spec = json!({
            "openapi": "3.0.0",
            "info": { "title": "Refs" },
            "servers": [{ "url": "https://refs.example" }],
            "components": {
                "parameters": {
                    "PageParam": {
                        "name": "page",
                        "in": "query",
                        "schema": { "type": "integer" },
                        "description": "1-based page number."
                    }
                }
            },
            "paths": {
                "/items": {
                    "get": {
                        "operationId": "listItems",
                        "parameters": [{ "$ref": "#/components/parameters/PageParam" }]
                    }
                }
            }
        });

        let api = spec_to_api(&spec, DEFAULT_OP_CAP).unwrap();
        assert_eq!(
            api.tools[0]
                .input_schema
                .pointer("/properties/page/type")
                .and_then(Value::as_str),
            Some("integer")
        );
    }
}
