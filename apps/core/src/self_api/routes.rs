//! The CoreApi route model built from the OpenAPI spec, and its catalog surface.

use super::*;

// ── Route model ───────────────────────────────────────────────────────────────

/// One CoreApi tool: an OpenAPI operation reduced to what dispatch needs.
#[derive(Debug, Clone)]
pub struct CoreApiRoute {
    /// `ryu_api.<method>_<path_slug>`.
    pub id: String,
    /// Uppercase HTTP method (`GET`/`POST`/…).
    pub method: String,
    /// The OpenAPI path template, e.g. `/api/quests/{id}`.
    pub path_template: String,
    /// Human summary (from the operation summary/description).
    pub summary: String,
    /// Path-parameter names (all required by construction).
    pub path_params: Vec<String>,
    /// Query-parameter names.
    pub query_params: Vec<String>,
    /// Whether the operation takes a request body (sent as the `body` arg).
    pub has_body: bool,
    /// A JSON-schema `object` describing the args (path + query + `body`), reused
    /// for both the descriptor arg summary and the full `describe` output.
    pub input_schema: Value,
}

/// Build the route table once from the generated OpenAPI spec. Cached: the spec
/// is stable for a build. Walks the serialized JSON (version-robust) rather than
/// the utoipa Rust type API.
pub fn routes() -> &'static [CoreApiRoute] {
    static ROUTES: OnceLock<Vec<CoreApiRoute>> = OnceLock::new();
    ROUTES.get_or_init(|| {
        let spec = serde_json::to_value(crate::server::openapi::api_doc()).unwrap_or(Value::Null);
        build_routes(&spec)
    })
}

/// Pure route extraction from an OpenAPI JSON value (unit-testable).
pub fn build_routes(spec: &Value) -> Vec<CoreApiRoute> {
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let Some(paths) = spec.get("paths").and_then(Value::as_object) else {
        return out;
    };
    for (path, item) in paths {
        for &method in METHODS {
            let Some(op) = item.get(method) else {
                continue;
            };
            if is_denied(path, method) {
                continue;
            }

            let summary = op
                .get("summary")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .or_else(|| op.get("description").and_then(Value::as_str))
                .unwrap_or_default()
                .to_string();

            let mut path_params = Vec::new();
            let mut query_params = Vec::new();
            let mut props = serde_json::Map::new();
            let mut required: Vec<String> = Vec::new();

            if let Some(params) = op.get("parameters").and_then(Value::as_array) {
                for p in params {
                    let Some(name) = p.get("name").and_then(Value::as_str) else {
                        continue;
                    };
                    let loc = p.get("in").and_then(Value::as_str).unwrap_or_default();
                    let req = p.get("required").and_then(Value::as_bool).unwrap_or(false);
                    let desc = p
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let ty = p
                        .get("schema")
                        .and_then(|s| s.get("type"))
                        .and_then(Value::as_str)
                        .unwrap_or("string");
                    match loc {
                        "path" => {
                            path_params.push(name.to_string());
                            required.push(name.to_string()); // path params are always required
                        }
                        "query" => {
                            query_params.push(name.to_string());
                            if req {
                                required.push(name.to_string());
                            }
                        }
                        // header/cookie params are not agent-controllable — skip.
                        _ => continue,
                    }
                    props.insert(name.to_string(), json!({ "type": ty, "description": desc }));
                }
            }

            let has_body = op.get("requestBody").is_some();
            if has_body {
                props.insert(
                    "body".to_string(),
                    json!({
                        "type": "object",
                        "description": "JSON request body (shallow: the whole body as one argument)."
                    }),
                );
                let body_required = op
                    .get("requestBody")
                    .and_then(|b| b.get("required"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if body_required {
                    required.push("body".to_string());
                }
            }

            let id = format!("{ID_PREFIX}{method}_{}", slug(path));
            if !seen.insert(id.clone()) {
                // Two operations slugged to the same id — keep the first, warn.
                // Deterministic (METHODS order + IndexMap path order) so the same
                // one always wins.
                debug_assert!(false, "duplicate core-api tool id: {id} ({method} {path})");
                tracing::warn!(
                    "self_api: duplicate core-api tool id {id} ({method} {path}); keeping first"
                );
                continue;
            }

            let input_schema = json!({
                "type": "object",
                "properties": Value::Object(props),
                "required": required,
            });

            out.push(CoreApiRoute {
                id,
                method: method.to_ascii_uppercase(),
                path_template: path.clone(),
                summary,
                path_params,
                query_params,
                has_body,
                input_schema,
            });
        }
    }
    out
}

/// Slugify an OpenAPI path into the id tail: lowercase, non-alphanumerics → `_`,
/// runs of `_` collapsed, edges trimmed. `/api/quests/{id}` → `api_quests_id`.
pub(super) fn slug(path: &str) -> String {
    let mut s = String::with_capacity(path.len());
    let mut prev_us = false;
    for c in path.chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
            prev_us = false;
        } else if !prev_us {
            s.push('_');
            prev_us = true;
        }
    }
    s.trim_matches('_').to_string()
}

// ── Catalog surface (search / describe) ───────────────────────────────────────

/// Every CoreApi tool as a [`ToolDescriptor`] for the unified catalog. Merged
/// into `McpRegistry::search_scoped`'s `builtins` so it ranks with everything else.
pub fn descriptors() -> Vec<ToolDescriptor> {
    routes()
        .iter()
        .map(|r| {
            let (arg_names, arg_descriptions) = arg_summary(Some(&r.input_schema));
            ToolDescriptor {
                id: r.id.clone(),
                name: format!("{} {}", r.method, r.path_template),
                description: r.summary.clone(),
                kind: ToolKind::CoreApi,
                arg_names,
                arg_descriptions,
                score: None,
                meta: None,
                widget_accessible: false,
                output_template: None,
            }
        })
        .collect()
}

/// Describe one CoreApi tool by id (`None` when the id is unknown / not CoreApi).
pub fn describe(id: &str) -> Option<DescribedTool> {
    let normalized_id = crate::sidecar::mcp::canonical_tool_id(id);
    let r = routes().iter().find(|r| r.id == normalized_id)?;
    Some(describe_from_parts(
        &r.id,
        &format!("{} {}", r.method, r.path_template),
        &r.summary,
        ToolKind::CoreApi,
        Some(&r.input_schema),
    ))
}

/// The route behind a CoreApi tool id (`None` when unknown / not CoreApi). Used
/// to show the user which endpoint an in-chat permission prompt would call.
pub fn route_for(id: &str) -> Option<&'static CoreApiRoute> {
    let normalized_id = crate::sidecar::mcp::canonical_tool_id(id);
    routes().iter().find(|r| r.id == normalized_id)
}
