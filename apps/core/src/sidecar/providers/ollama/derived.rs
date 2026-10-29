//! Derived-model generation for Ollama launch settings (#mtp-advanced-inference).
//!
//! Ollama's daemon serves many models and takes no per-model launch CLI flags,
//! and its OpenAI-compat endpoint accepts no `options` passthrough. Launch knobs
//! (context size, GPU layers, batch, threads, mmap/mlock) therefore have to be
//! baked into a model: Core creates a *derived* model `FROM <base>` with the
//! matching `PARAMETER` directives via `POST /api/create`, then routes inference
//! for the base name to the derived name.
//!
//! The derived name is deterministic (`ryu-<base>-<hash of base + params>`), so a
//! repeat load with the same settings reuses the model Ollama already has instead
//! of creating a new one. Everything here fails soft: when the derived model
//! cannot be created, the caller logs, keeps serving the base model, and reports
//! a degraded status saying the settings were not applied.

use std::collections::{BTreeMap, HashMap};
use std::sync::{OnceLock, RwLock};

use anyhow::Context;
use sha2::{Digest, Sha256};

/// Prefix of every Ryu-derived Ollama model name.
const DERIVED_PREFIX: &str = "ryu-";
/// Max characters of the sanitized base name kept in a derived name, so a long
/// `hf.co/<org>/<repo>:<quant>` reference still yields a reasonable model name.
const MAX_BASE_CHARS: usize = 48;
/// Hex characters of the parameter hash kept in a derived name.
const HASH_CHARS: usize = 10;
/// `/api/create` copies no weights (the derived model reuses the base's blobs),
/// but a cold daemon can still take a while to write the manifest.
const CREATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
const SHOW_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Render the Modelfile for a derived model: `FROM <base>` followed by one
/// `PARAMETER <name> <value>` line per launch knob, in the given order.
pub fn render_modelfile(base: &str, params: &[(String, String)]) -> String {
    let mut out = format!("FROM {base}\n");
    for (name, value) in params {
        out.push_str("PARAMETER ");
        out.push_str(name);
        out.push(' ');
        out.push_str(value);
        out.push('\n');
    }
    out
}

/// Deterministic derived-model name for `base` + `params`.
///
/// The hash covers the base name and the parameters sorted by name, so the same
/// settings in any order map to the same model, and different settings (or a
/// different base) never collide. The base is lowercased and every character
/// outside `[a-z0-9._-]` (for example `:` and `/`) becomes `-`.
pub fn derived_model_name(base: &str, params: &[(String, String)]) -> String {
    let mut sorted: Vec<&(String, String)> = params.iter().collect();
    sorted.sort();
    let mut hasher = Sha256::new();
    hasher.update(base.trim().as_bytes());
    for (name, value) in sorted {
        hasher.update(b"\n");
        hasher.update(name.as_bytes());
        hasher.update(b"=");
        hasher.update(value.as_bytes());
    }
    let digest = hex::encode(hasher.finalize());

    let mut slug = String::with_capacity(base.len());
    for ch in base.trim().chars() {
        let ch = ch.to_ascii_lowercase();
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
            slug.push(ch);
        } else {
            slug.push('-');
        }
    }
    let slug: String = slug.chars().take(MAX_BASE_CHARS).collect();
    let slug = slug.trim_matches(|c| c == '-' || c == '.' || c == '_');
    let slug = if slug.is_empty() { "model" } else { slug };
    format!("{DERIVED_PREFIX}{slug}-{}", &digest[..HASH_CHARS])
}

/// `/api/create` takes `parameters` as a typed JSON object (`num_ctx: 8192`,
/// `use_mmap: false`), not the Modelfile's text form. Integers and booleans are
/// typed; anything else stays a string.
pub fn parameters_json(params: &[(String, String)]) -> serde_json::Map<String, serde_json::Value> {
    let mut out = serde_json::Map::new();
    for (name, value) in params {
        let typed = if let Ok(n) = value.parse::<i64>() {
            serde_json::Value::from(n)
        } else if let Ok(b) = value.parse::<bool>() {
            serde_json::Value::from(b)
        } else if let Ok(f) = value.parse::<f64>() {
            serde_json::Value::from(f)
        } else {
            serde_json::Value::from(value.clone())
        };
        out.insert(name.clone(), typed);
    }
    out
}

/// The request body for `POST /api/create` creating `derived` from `base`.
///
/// Uses the current structured shape (`model` + `from` + `parameters`), and also
/// sends the rendered `modelfile` so an older daemon that still parses Modelfile
/// text creates the same model. Unknown fields are ignored by both shapes.
pub fn create_request_body(
    derived: &str,
    base: &str,
    params: &[(String, String)],
) -> serde_json::Value {
    serde_json::json!({
        "model": derived,
        "name": derived,
        "from": base,
        "parameters": parameters_json(params),
        "modelfile": render_modelfile(base, params),
        "stream": false,
    })
}

/// Names a request might use for `base`: Ollama treats `llama3.2` and
/// `llama3.2:latest` as the same model, so both route to the derived model.
pub fn route_aliases(base: &str) -> Vec<String> {
    let base = base.trim();
    let mut out = vec![base.to_owned()];
    if let Some(stripped) = base.strip_suffix(":latest") {
        out.push(stripped.to_owned());
    } else if !base.rsplit('/').next().unwrap_or(base).contains(':') {
        out.push(format!("{base}:latest"));
    }
    out
}

async fn model_exists(
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
) -> anyhow::Result<bool> {
    let resp = client
        .post(format!("{base_url}/api/show"))
        .timeout(SHOW_TIMEOUT)
        .json(&serde_json::json!({ "model": model, "name": model }))
        .send()
        .await
        .with_context(|| format!("querying ollama for model '{model}'"))?;
    if resp.status().is_success() {
        return Ok(true);
    }
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(false);
    }
    anyhow::bail!("ollama /api/show for '{model}' returned {}", resp.status())
}

/// Ensure the derived model for `base` + `params` exists on the Ollama daemon at
/// `base_url` (e.g. `http://127.0.0.1:11434`) and return its name. Reuses an
/// existing derived model; errors when the base model is not in Ollama or the
/// create call fails, so the caller can fall back to the base model.
pub async fn ensure_derived_model(
    client: &reqwest::Client,
    base_url: &str,
    base: &str,
    params: &[(String, String)],
) -> anyhow::Result<String> {
    let derived = derived_model_name(base, params);
    if model_exists(client, base_url, &derived).await? {
        return Ok(derived);
    }
    if !model_exists(client, base_url, base).await? {
        anyhow::bail!("base model '{base}' is not available in Ollama (pull it first)");
    }
    let resp = client
        .post(format!("{base_url}/api/create"))
        .timeout(CREATE_TIMEOUT)
        .json(&create_request_body(&derived, base, params))
        .send()
        .await
        .with_context(|| format!("creating ollama model '{derived}'"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("ollama /api/create for '{derived}' returned {status}: {body}");
    }
    Ok(derived)
}

// ── Routing table + launch status (process-global) ─────────────────────────────

fn routes() -> &'static RwLock<HashMap<String, String>> {
    static ROUTES: OnceLock<RwLock<HashMap<String, String>>> = OnceLock::new();
    ROUTES.get_or_init(|| RwLock::new(HashMap::new()))
}

fn launch_status() -> &'static RwLock<Option<String>> {
    static STATUS: OnceLock<RwLock<Option<String>>> = OnceLock::new();
    STATUS.get_or_init(|| RwLock::new(None))
}

/// Route every alias of `base` to `derived` (replacing the previous table).
pub fn set_routes(base: &str, derived: &str) {
    let mut table = routes().write().unwrap_or_else(|e| e.into_inner());
    table.clear();
    for alias in route_aliases(base) {
        table.insert(alias, derived.to_owned());
    }
}

/// Drop every route (engine stopped, or no launch settings to apply).
pub fn clear_routes() {
    routes().write().unwrap_or_else(|e| e.into_inner()).clear();
}

/// The derived model a request for `model` should be served by, if any.
pub fn routed_model(model: &str) -> Option<String> {
    routes()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .get(model.trim())
        .cloned()
}

/// A sorted snapshot of the routing table, for the Gateway spawn env.
pub fn routes_snapshot() -> BTreeMap<String, String> {
    routes()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// Record why launch settings are not applied (`None` = applied or nothing set).
pub fn set_launch_status(message: Option<String>) {
    *launch_status().write().unwrap_or_else(|e| e.into_inner()) = message;
}

/// The current "launch settings not applied" message, if any.
pub fn launch_status_message() -> Option<String> {
    launch_status()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn modelfile_has_from_and_parameter_lines() {
        let p = params(&[("num_ctx", "8192"), ("use_mmap", "false")]);
        assert_eq!(
            render_modelfile("llama3.2:3b", &p),
            "FROM llama3.2:3b\nPARAMETER num_ctx 8192\nPARAMETER use_mmap false\n"
        );
    }

    #[test]
    fn derived_name_is_deterministic_and_order_independent() {
        let a = params(&[("num_ctx", "8192"), ("num_gpu", "20")]);
        let b = params(&[("num_gpu", "20"), ("num_ctx", "8192")]);
        let name = derived_model_name("llama3.2:3b", &a);
        assert_eq!(name, derived_model_name("llama3.2:3b", &b));
        assert!(name.starts_with("ryu-llama3.2-3b-"), "{name}");
        assert_eq!(name.len(), "ryu-llama3.2-3b-".len() + HASH_CHARS);
    }

    #[test]
    fn derived_name_changes_with_params_or_base() {
        let a = params(&[("num_ctx", "8192")]);
        let b = params(&[("num_ctx", "4096")]);
        assert_ne!(
            derived_model_name("llama3.2", &a),
            derived_model_name("llama3.2", &b)
        );
        assert_ne!(
            derived_model_name("llama3.2", &a),
            derived_model_name("qwen3", &a)
        );
    }

    #[test]
    fn derived_name_sanitizes_registry_paths() {
        let name = derived_model_name(
            "hf.co/Some-Org/Some.Repo-GGUF:Q4_K_M",
            &params(&[("num_ctx", "2048")]),
        );
        let (slug, hash) = name.rsplit_once('-').expect("hash suffix");
        assert_eq!(hash.len(), HASH_CHARS);
        assert!(name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c)));
        assert!(
            slug.starts_with("ryu-hf.co-some-org-some.repo-gguf-q4_k_m"),
            "{slug}"
        );
    }

    #[test]
    fn long_base_names_are_truncated() {
        let base = "a".repeat(200);
        let name = derived_model_name(&base, &params(&[("num_ctx", "1")]));
        assert_eq!(
            name.len(),
            DERIVED_PREFIX.len() + MAX_BASE_CHARS + 1 + HASH_CHARS
        );
    }

    #[test]
    fn parameters_are_typed_for_the_create_api() {
        let p = params(&[
            ("num_ctx", "8192"),
            ("num_gpu", "-1"),
            ("use_mlock", "true"),
            ("use_mmap", "false"),
        ]);
        let json = serde_json::Value::Object(parameters_json(&p));
        assert_eq!(
            json,
            serde_json::json!({
                "num_ctx": 8192,
                "num_gpu": -1,
                "use_mlock": true,
                "use_mmap": false,
            })
        );
    }

    #[test]
    fn create_body_names_derived_model_from_base() {
        let p = params(&[("num_ctx", "8192")]);
        let body = create_request_body("ryu-x-1", "llama3.2", &p);
        assert_eq!(body["model"], "ryu-x-1");
        assert_eq!(body["from"], "llama3.2");
        assert_eq!(body["parameters"]["num_ctx"], 8192);
        assert_eq!(body["stream"], false);
        assert_eq!(body["modelfile"], "FROM llama3.2\nPARAMETER num_ctx 8192\n");
    }

    #[test]
    fn routes_map_every_alias_and_clear() {
        set_routes("routetest-model", "ryu-routetest-model-0123456789");
        assert_eq!(
            routed_model("routetest-model:latest").as_deref(),
            Some("ryu-routetest-model-0123456789")
        );
        assert_eq!(
            routes_snapshot().get("routetest-model").map(String::as_str),
            Some("ryu-routetest-model-0123456789")
        );
        clear_routes();
        assert!(routed_model("routetest-model").is_none());
    }

    #[test]
    fn route_aliases_cover_the_latest_tag() {
        assert_eq!(
            route_aliases("llama3.2"),
            vec!["llama3.2", "llama3.2:latest"]
        );
        assert_eq!(
            route_aliases("llama3.2:latest"),
            vec!["llama3.2:latest", "llama3.2"]
        );
        assert_eq!(route_aliases("llama3.2:3b"), vec!["llama3.2:3b"]);
        assert_eq!(
            route_aliases("registry.local:5000/llama"),
            vec![
                "registry.local:5000/llama",
                "registry.local:5000/llama:latest"
            ]
        );
    }
}
