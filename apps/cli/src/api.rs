use std::time::Duration;

use crate::app::{App, ConversationSummary, GatewayStatus, SidecarStatus, Space, SpaceDocument};
use crate::nodes;

/// Builds a reqwest client that attaches an Authorization: Bearer header
/// for the given token (if any).
pub fn authed_client(token: Option<&str>) -> reqwest::Client {
    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(10));
    if let Some(t) = token {
        let mut headers = reqwest::header::HeaderMap::new();
        if let Ok(val) = reqwest::header::HeaderValue::from_str(&format!("Bearer {}", t)) {
            headers.insert(reqwest::header::AUTHORIZATION, val);
        }
        builder = builder.default_headers(headers);
    }
    builder.build().unwrap_or_else(|_| reqwest::Client::new())
}

/// Returns the active node's (url, Option<token>) for use in commands.
pub fn active_url_and_token() -> (String, Option<String>) {
    let node = nodes::active_node();
    (node.url, node.token)
}

/// Ping `GET {node.url}/api/health` with a short timeout (1 s).
/// Returns `true` when the node answers with a 2xx status, `false` otherwise.
pub async fn health_check_node(node: &nodes::Node) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let mut req = client.get(format!("{}/api/health", node.url));
    if let Some(t) = &node.token {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    req.send().await.map(|r| r.status().is_success()).unwrap_or(false)
}

/// Health-checks all configured nodes concurrently, selects the preferred one
/// (first reachable non-local, else local), persists it as the new default, and
/// returns the chosen node.
pub async fn select_preferred_node() -> nodes::Node {
    let config = nodes::load();
    let checks: Vec<_> = config.nodes.iter().map(|n| health_check_node(n)).collect();
    let reachable: Vec<bool> = futures_util::future::join_all(checks).await;
    let chosen = nodes::select_preferred(&config.nodes, &reachable);
    // Persist only if the selection differs from the current default to avoid
    // unnecessary disk writes on every startup.
    if chosen.name != config.default {
        let _ = nodes::set_active(&chosen.name);
    }
    chosen
}

/// A trimmed update verdict from Core's `GET /api/update/check`.
pub struct UpdateNotice {
    pub current: String,
    pub latest: String,
    pub available: bool,
    pub html_url: Option<String>,
}

/// Ask Core whether a newer Ryu release is available. Returns `None` on any
/// error (Core down, no network) so a startup notice never blocks the CLI.
pub async fn fetch_update_check(url: &str, token: Option<&str>) -> Option<UpdateNotice> {
    let client = authed_client(token);
    let resp = client
        .get(format!("{url}/api/update/check"))
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let json: serde_json::Value = resp.json().await.ok()?;
    Some(UpdateNotice {
        current: json["current"].as_str().unwrap_or_default().to_string(),
        latest: json["latest"].as_str().unwrap_or_default().to_string(),
        available: json["update_available"].as_bool().unwrap_or(false),
        html_url: json["html_url"].as_str().map(str::to_string),
    })
}

pub async fn fetch_status(app: &mut App) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let resp = client
        .get(&format!("{}/api/sidecar/status", app.api_url))
        .timeout(Duration::from_secs(2))
        .send()
        .await?;

    if resp.status().is_success() {
        let json: serde_json::Value = resp.json().await?;
        if let Some(sidecars) = json.get("sidecars").and_then(|v| v.as_array()) {
            app.statuses = sidecars
                .iter()
                .filter_map(|s| {
                    let name = s.get("name")?.as_str()?.to_string();
                    let running = s.get("running")?.as_bool().unwrap_or(false);
                    Some(SidecarStatus { name, running })
                })
                .collect();
        }
    }
    Ok(())
}

pub async fn start_sidecar(url: &str, name: &str) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    client
        .post(&format!("{url}/api/sidecar/{name}/start"))
        .timeout(Duration::from_secs(10))
        .send()
        .await?;
    Ok(())
}

pub async fn stop_sidecar(url: &str, name: &str) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    client
        .post(&format!("{url}/api/sidecar/{name}/stop"))
        .timeout(Duration::from_secs(10))
        .send()
        .await?;
    Ok(())
}

pub async fn restart_sidecar_runtime(url: &str, name: &str) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    client
        .post(&format!("{url}/api/sidecar/{name}/restart"))
        .timeout(Duration::from_secs(10))
        .send()
        .await?;
    Ok(())
}

pub async fn start_all(url: &str) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    client
        .post(&format!("{url}/api/sidecar/start-all"))
        .timeout(Duration::from_secs(10))
        .send()
        .await?;
    Ok(())
}

pub async fn stop_all(url: &str) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    client
        .post(&format!("{url}/api/sidecar/stop-all"))
        .timeout(Duration::from_secs(10))
        .send()
        .await?;
    Ok(())
}

pub async fn check_dependencies(app: &mut App) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let resp = client
        .get(&format!("{}/api/dependencies/check", app.api_url))
        .timeout(Duration::from_secs(5))
        .send()
        .await?;

    if resp.status().is_success() {
        let json: serde_json::Value = resp.json().await?;
        if let Some(deps) = json.get("dependencies") {
            if let Some(git) = deps.get("git").and_then(|v| v.as_bool()) {
                app.dependencies[0].installed = git;
            }
            if let Some(rust) = deps.get("rust").and_then(|v| v.as_bool()) {
                app.dependencies[1].installed = rust;
            }
            if let Some(npm) = deps.get("npm").and_then(|v| v.as_bool()) {
                app.dependencies[2].installed = npm;
            }
            if let Some(python) = deps.get("python").and_then(|v| v.as_bool()) {
                app.dependencies[3].installed = python;
            }
        }
    }
    Ok(())
}

pub async fn install_dependencies(app: &mut App) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let resp = client
        .post(&format!("{}/api/dependencies/install", app.api_url))
        .timeout(Duration::from_secs(120))
        .send()
        .await?;

    if resp.status().is_success() {
        check_dependencies(app).await?;
    }
    Ok(())
}

pub async fn fetch_installed(app: &mut App) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let resp = client
        .get(&format!("{}/api/setup/list", app.api_url))
        .timeout(Duration::from_secs(2))
        .send()
        .await?;

    if resp.status().is_success() {
        let json: serde_json::Value = resp.json().await?;
        if let Some(installed) = json.get("installed").and_then(|o| o.as_array()) {
            for sidecar in &mut app.providers {
                sidecar.installed = installed
                    .iter()
                    .any(|s| s.as_str() == Some(&sidecar.name));
            }
            for sidecar in &mut app.tools {
                sidecar.installed = installed
                    .iter()
                    .any(|s| s.as_str() == Some(&sidecar.name));
            }
            for sidecar in &mut app.agents {
                sidecar.installed = installed
                    .iter()
                    .any(|s| s.as_str() == Some(&sidecar.name));
            }
        }
    }
    Ok(())
}

pub async fn fetch_install_status(app: &mut App) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let resp = client
        .get(&format!("{}/api/setup/status", app.api_url))
        .timeout(Duration::from_secs(2))
        .send()
        .await?;

    if resp.status().is_success() {
        let json: serde_json::Value = resp.json().await?;
        if let Some(states) = json.get("states").and_then(|v| v.as_object()) {
            for (name, value) in states {
                if let Ok(state) = serde_json::from_value(value.clone()) {
                    app.install_states.insert(name.clone(), state);
                }
            }
        }
    }
    Ok(())
}

pub async fn install_sidecar(url: &str, name: &str) -> anyhow::Result<bool> {
    let client = reqwest::Client::new();
    let resp = client
        .post(&format!("{url}/api/setup/{name}/install"))
        .timeout(Duration::from_secs(10))
        .send()
        .await?;
    Ok(resp.status().is_success())
}

pub async fn fetch_workflows(api_url: &str, token: Option<&str>) -> anyhow::Result<Vec<crate::app::Workflow>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut req = client.get(format!("{api_url}/workflows"));
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    let resp = req.send().await?.error_for_status()?;
    let json: serde_json::Value = resp.json().await?;
    let workflows: Vec<crate::app::Workflow> =
        serde_json::from_value(json["workflows"].clone()).unwrap_or_default();
    Ok(workflows)
}

/// Trigger a workflow run via `POST /workflows/:id/run`.
/// Returns the run id on success.
pub async fn trigger_workflow_run(
    api_url: &str,
    token: Option<&str>,
    workflow_id: &str,
) -> anyhow::Result<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut req = client
        .post(format!("{api_url}/workflows/{workflow_id}/run"))
        .header("Content-Type", "application/json")
        .body("{}");
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    let resp = req.send().await?.error_for_status()?;
    let json: serde_json::Value = resp.json().await?;
    let run_id = json["run_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("missing run_id in response"))?
        .to_string();
    Ok(run_id)
}

/// Poll run status from `GET /workflows/runs/:run_id`.
/// Returns (state, output) where state is e.g. "running", "completed", "failed".
pub async fn fetch_workflow_run(
    api_url: &str,
    token: Option<&str>,
    run_id: &str,
) -> anyhow::Result<(String, Option<String>)> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut req = client.get(format!("{api_url}/workflows/runs/{run_id}"));
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    let resp = req.send().await?.error_for_status()?;
    let json: serde_json::Value = resp.json().await?;
    let state = json["run"]["state"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    let output = json["run"]["output"].as_str().map(|s| s.to_string());
    Ok((state, output))
}

/// Fetch the engines list from `GET /api/engines`.
/// Returns the raw JSON value for the `engines` array so the caller can
/// layer it with the active-engine marker from `/api/engine/active`.
pub async fn fetch_engines(api_url: &str, token: Option<&str>) -> anyhow::Result<Vec<crate::app::EngineInfo>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut req = client.get(format!("{api_url}/api/engines"));
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    let resp = req.send().await?.error_for_status()?;
    let json: serde_json::Value = resp.json().await?;
    let engines: Vec<crate::app::EngineInfo> =
        serde_json::from_value(json["engines"].clone()).unwrap_or_default();
    Ok(engines)
}

/// Fetch the active engine from `GET /api/engine/active`.
/// Returns the name of the active engine, whether it is running, and the
/// names of available (installed) local engines.
pub async fn fetch_active_engine(api_url: &str, token: Option<&str>) -> anyhow::Result<crate::app::EngineActiveInfo> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut req = client.get(format!("{api_url}/api/engine/active"));
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    let resp = req.send().await?.error_for_status()?;
    let info: crate::app::EngineActiveInfo = resp.json().await?;
    Ok(info)
}

/// POST `{ "name": engine_name }` to `/api/engine/active` to swap the active engine.
/// The selection is persisted by Core, not the CLI.
pub async fn post_active_engine(api_url: &str, token: Option<&str>, name: &str) -> anyhow::Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let body = serde_json::json!({ "name": name });
    let mut req = client
        .post(format!("{api_url}/api/engine/active"))
        .header("Content-Type", "application/json")
        .body(body.to_string());
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    req.send().await?.error_for_status()?;
    Ok(())
}

/// Fetch scheduled jobs from `GET /heartbeat/jobs`.
/// No job definitions are hardcoded — all data comes from Core.
pub async fn fetch_scheduled_jobs(api_url: &str, token: Option<&str>) -> anyhow::Result<Vec<crate::app::ScheduledJobInfo>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut req = client.get(format!("{api_url}/heartbeat/jobs"));
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    let resp = req.send().await?.error_for_status()?;
    let json: serde_json::Value = resp.json().await?;
    let jobs: Vec<crate::app::ScheduledJobInfo> =
        serde_json::from_value(json["jobs"].clone()).unwrap_or_default();
    Ok(jobs)
}

pub async fn uninstall_sidecar(url: &str, name: &str) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    client
        .post(&format!("{url}/api/setup/{name}/uninstall"))
        .timeout(Duration::from_secs(10))
        .send()
        .await?;
    Ok(())
}

/// Fetch the gateway status from Core's `GET /api/gateway/status`.
/// On success, stores the result in `app.gateway_status`.
/// On any error (Core unreachable, gateway down), clears the field — the UI
/// renders an explicit offline state rather than stale data.
pub async fn fetch_gateway_status(app: &mut App) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let resp = client
        .get(&format!("{}/api/gateway/status", app.api_url))
        .timeout(Duration::from_secs(3))
        .send()
        .await?;

    if resp.status().is_success() {
        let status: GatewayStatus = resp.json().await?;
        app.gateway_status = Some(status);
    } else {
        app.gateway_status = None;
    }
    Ok(())
}

/// Fetch all spaces from `GET /api/spaces`.
pub async fn fetch_spaces(api_url: &str) -> anyhow::Result<Vec<Space>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let resp = client
        .get(format!("{api_url}/api/spaces"))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Ok(Vec::new());
    }
    let json: serde_json::Value = resp.json().await?;
    // Core returns `{ "spaces": [...] }` or a bare array.
    let arr = json.get("spaces").and_then(|v| v.as_array()).cloned()
        .or_else(|| json.as_array().cloned())
        .unwrap_or_default();
    let spaces: Vec<Space> = arr
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect();
    Ok(spaces)
}

/// Fetch documents for a single space from `GET /api/spaces/:id/documents`.
pub async fn fetch_space_documents(api_url: &str, space_id: &str) -> anyhow::Result<Vec<SpaceDocument>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let resp = client
        .get(format!("{api_url}/api/spaces/{space_id}/documents"))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Ok(Vec::new());
    }
    let json: serde_json::Value = resp.json().await?;
    let arr = json.get("documents").and_then(|v| v.as_array()).cloned()
        .or_else(|| json.as_array().cloned())
        .unwrap_or_default();
    let docs: Vec<SpaceDocument> = arr
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect();
    Ok(docs)
}

/// Fetch conversations from `GET /api/conversations`.
pub async fn fetch_conversations(api_url: &str) -> anyhow::Result<Vec<ConversationSummary>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let resp = client
        .get(format!("{api_url}/api/conversations"))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Ok(Vec::new());
    }
    let json: serde_json::Value = resp.json().await?;
    let arr = json.get("conversations").and_then(|v| v.as_array()).cloned()
        .or_else(|| json.as_array().cloned())
        .unwrap_or_default();
    let convs: Vec<ConversationSummary> = arr
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect();
    Ok(convs)
}

// ── Chat: goal + sessions ─────────────────────────────────────────────────────
//
// Goal set/clear are quick awaited calls (the judge loop runs as a background
// task in chat.rs). Sessions is a read-only run history for a conversation.

/// Set or replace the goal on a conversation (`PUT .../goal`).
pub async fn set_goal(
    api_url: &str,
    token: Option<&str>,
    conversation_id: &str,
    goal: &str,
) -> anyhow::Result<()> {
    let client = authed_client(token);
    let body = serde_json::json!({ "goal": goal });
    client
        .put(format!("{api_url}/api/conversations/{conversation_id}/goal"))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

/// Clear an active goal on a conversation (`DELETE .../goal`).
pub async fn clear_goal(
    api_url: &str,
    token: Option<&str>,
    conversation_id: &str,
) -> anyhow::Result<()> {
    let client = authed_client(token);
    client
        .delete(format!("{api_url}/api/conversations/{conversation_id}/goal"))
        .send()
        .await?;
    Ok(())
}

/// List a conversation's runs/sessions (`GET .../sessions`). Parsed leniently —
/// Core's row shape evolves; only the few display fields are pulled out.
pub async fn fetch_sessions(
    api_url: &str,
    token: Option<&str>,
    conversation_id: &str,
) -> anyhow::Result<Vec<crate::app::SessionRow>> {
    let client = authed_client(token);
    let resp = client
        .get(format!("{api_url}/api/conversations/{conversation_id}/sessions"))
        .send()
        .await?
        .error_for_status()?;
    let json: serde_json::Value = resp.json().await?;
    let arr = json
        .get("sessions")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(arr
        .iter()
        .map(|s| crate::app::SessionRow {
            id: s
                .get("id")
                .or_else(|| s.get("run_id"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            status: s.get("status").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            created_at: s
                .get("created_at")
                .or_else(|| s.get("started_at"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            branch: s.get("branch").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        })
        .collect())
}

// ── Generic data-driven list tabs ─────────────────────────────────────────────
//
// One fetcher backs every new list tab (Models / Skills / Tools / Monitors /
// Teams / Meetings / Recipes). Core's list shapes differ, so this pulls the
// array out of the first matching container key (or a bare top-level array) and
// maps each element to a `ListRow` by trying a list of candidate field names —
// nothing about a specific endpoint's schema is hardcoded here.

/// Render a JSON value as a short display string (string verbatim, number/bool
/// stringified, array as its length). Empty when no candidate key matches.
fn pick_field(v: &serde_json::Value, keys: &[&str]) -> String {
    for k in keys {
        match v.get(k) {
            Some(serde_json::Value::String(s)) if !s.is_empty() => return s.clone(),
            Some(serde_json::Value::Number(n)) => return n.to_string(),
            Some(serde_json::Value::Bool(b)) => return b.to_string(),
            Some(serde_json::Value::Array(a)) => return a.len().to_string(),
            _ => {}
        }
    }
    String::new()
}

/// GET a Core list endpoint and map it to `ListRow`s. `container_keys` are tried
/// in order to find the array; a bare top-level array is the fallback. Plain
/// string array elements (e.g. recipe names) are supported.
#[allow(clippy::too_many_arguments)]
pub async fn fetch_feature_list(
    api_url: &str,
    token: Option<&str>,
    path: &str,
    container_keys: &[&str],
    title_keys: &[&str],
    subtitle_keys: &[&str],
    badge_keys: &[&str],
    id_keys: &[&str],
) -> anyhow::Result<Vec<crate::app::ListRow>> {
    let client = authed_client(token);
    let resp = client
        .get(format!("{api_url}{path}"))
        .send()
        .await?
        .error_for_status()?;
    let json: serde_json::Value = resp.json().await?;

    let arr = container_keys
        .iter()
        .find_map(|k| json.get(*k).and_then(|v| v.as_array()).cloned())
        .or_else(|| json.as_array().cloned())
        .unwrap_or_default();

    Ok(arr
        .iter()
        .map(|v| {
            if let Some(s) = v.as_str() {
                // Plain string element (e.g. a recipe name).
                return crate::app::ListRow {
                    title: s.to_string(),
                    id: s.to_string(),
                    ..Default::default()
                };
            }
            let title = {
                let t = pick_field(v, title_keys);
                if t.is_empty() { "—".to_string() } else { t }
            };
            crate::app::ListRow {
                title,
                subtitle: pick_field(v, subtitle_keys),
                badge: pick_field(v, badge_keys),
                id: pick_field(v, id_keys),
            }
        })
        .collect())
}

/// Install a model by catalog id (`POST /api/models/catalog/install`).
pub async fn install_model_by_id(
    api_url: &str,
    token: Option<&str>,
    id: &str,
) -> anyhow::Result<()> {
    let client = authed_client(token);
    client
        .post(format!("{api_url}/api/models/catalog/install"))
        .header("Content-Type", "application/json")
        .body(serde_json::json!({ "id": id }).to_string())
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

/// Set the active served chat model (`POST /api/models/active`).
pub async fn set_active_model(api_url: &str, token: Option<&str>, id: &str) -> anyhow::Result<()> {
    let client = authed_client(token);
    client
        .post(format!("{api_url}/api/models/active"))
        .header("Content-Type", "application/json")
        .body(serde_json::json!({ "id": id }).to_string())
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

/// Toggle a skill active/inactive (`POST /api/skills/activate`).
pub async fn set_skill_active(
    api_url: &str,
    token: Option<&str>,
    id: &str,
    active: bool,
) -> anyhow::Result<()> {
    let client = authed_client(token);
    client
        .post(format!("{api_url}/api/skills/activate"))
        .header("Content-Type", "application/json")
        .body(serde_json::json!({ "id": id, "active": active }).to_string())
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

/// Run a monitor check now (`POST /api/monitors/:id/run`).
pub async fn run_monitor(api_url: &str, token: Option<&str>, id: &str) -> anyhow::Result<()> {
    let client = authed_client(token);
    client
        .post(format!("{api_url}/api/monitors/{id}/run"))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

/// Replay a recipe by name (`POST /api/recipes/:name/run`).
pub async fn run_recipe(api_url: &str, token: Option<&str>, name: &str) -> anyhow::Result<()> {
    let client = authed_client(token);
    client
        .post(format!("{api_url}/api/recipes/{}/run", urlencode(name)))
        .header("Content-Type", "application/json")
        .body(serde_json::json!({ "params": {} }).to_string())
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

// ── Marketplace catalog (skills + MCP) ───────────────────────────────────────
//
// Browse + install from Core's Skills and MCP catalogs over the active node.
// ALL ranking/installed/install logic lives in Core; these helpers only shape
// the request and parse the response, matching the desktop reference clients
// (apps/desktop/src/lib/api/{skills,mcp}.ts).

/// A skill row from `GET /api/skills/catalog`. The catalog payload carries
/// `installed` per card, so it is trusted directly (unlike MCP, below).
pub struct SkillCatalogCard {
    pub id: String,
    pub name: String,
    pub installs: u64,
    pub installed: bool,
}

/// Browse the skills catalog. `query` is an optional free-text filter.
pub async fn fetch_skill_catalog(
    api_url: &str,
    token: Option<&str>,
    query: Option<&str>,
) -> anyhow::Result<Vec<SkillCatalogCard>> {
    let client = authed_client(token);
    let mut url = format!("{api_url}/api/skills/catalog?limit=50");
    if let Some(q) = query {
        url.push_str(&format!("&query={}", urlencode(q)));
    }
    let resp = client.get(url).send().await?.error_for_status()?;
    let json: serde_json::Value = resp.json().await?;
    let arr = json["skills"].as_array().cloned().unwrap_or_default();
    Ok(arr
        .iter()
        .filter_map(|s| {
            let id = s.get("id")?.as_str()?.to_string();
            let name = s
                .get("name")
                .and_then(|v| v.as_str())
                .or_else(|| s.get("slug").and_then(|v| v.as_str()))
                .unwrap_or(&id)
                .to_string();
            let installs = s
                .get("installs")
                .or_else(|| s.get("downloads"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let installed = s.get("installed").and_then(|v| v.as_bool()).unwrap_or(false);
            Some(SkillCatalogCard { id, name, installs, installed })
        })
        .collect())
}

/// Install a skill by catalog id via `POST /api/skills/catalog/install`.
/// Returns the installed slug on success.
pub async fn install_skill_by_id(
    api_url: &str,
    token: Option<&str>,
    id: &str,
) -> anyhow::Result<String> {
    let client = authed_client(token);
    let body = serde_json::json!({ "id": id });
    let resp = client
        .post(format!("{api_url}/api/skills/catalog/install"))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await?;
    let json: serde_json::Value = resp.json().await?;
    if json.get("success").and_then(|v| v.as_bool()) == Some(false) {
        let err = json.get("error").and_then(|v| v.as_str()).unwrap_or("install failed");
        anyhow::bail!("{err}");
    }
    let slug = json["result"]["slug"]
        .as_str()
        .or_else(|| json["id"].as_str())
        .unwrap_or(id)
        .to_string();
    Ok(slug)
}

/// Install a skill from a source reference (repo or URL) via
/// `POST /api/skills/install-from-source`. Returns the installed slug.
pub async fn install_skill_from_source(
    api_url: &str,
    token: Option<&str>,
    source: &str,
) -> anyhow::Result<String> {
    let client = authed_client(token);
    let body = serde_json::json!({ "source": source });
    let resp = client
        .post(format!("{api_url}/api/skills/install-from-source"))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await?;
    let json: serde_json::Value = resp.json().await?;
    if json.get("success").and_then(|v| v.as_bool()) == Some(false) {
        let err = json.get("error").and_then(|v| v.as_str()).unwrap_or("install failed");
        anyhow::bail!("{err}");
    }
    let slug = json["result"]["slug"]
        .as_str()
        .or_else(|| json["id"].as_str())
        .unwrap_or(source)
        .to_string();
    Ok(slug)
}

/// A server row from `GET /api/mcp/catalog`. Installed-state is NOT carried by
/// the catalog payload (Core hardcodes `installed: false`); the caller derives
/// it from the registered-server set (see `fetch_installed_mcp_names`).
pub struct McpCatalogCard {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub installed: bool,
}

/// The set of registered MCP server names from `GET /api/mcp/servers`. A catalog
/// card is installed iff its id is in this set (install writes the entry under
/// the sanitized name == trimmed catalog id, slashes preserved).
pub async fn fetch_installed_mcp_names(
    api_url: &str,
    token: Option<&str>,
) -> std::collections::HashSet<String> {
    let client = authed_client(token);
    let resp = match client.get(format!("{api_url}/api/mcp/servers")).send().await {
        Ok(r) if r.status().is_success() => r,
        // Treat an unreachable servers endpoint as "none installed" rather than
        // failing the browse — the catalog list is still useful.
        _ => return std::collections::HashSet::new(),
    };
    let json: serde_json::Value = resp.json().await.unwrap_or_default();
    json["servers"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s.get("name").and_then(|v| v.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Browse the MCP catalog and fold in derived installed-state.
pub async fn fetch_mcp_catalog(
    api_url: &str,
    token: Option<&str>,
    query: Option<&str>,
) -> anyhow::Result<Vec<McpCatalogCard>> {
    let installed = fetch_installed_mcp_names(api_url, token).await;
    let client = authed_client(token);
    let mut url = format!("{api_url}/api/mcp/catalog?limit=50");
    if let Some(q) = query {
        url.push_str(&format!("&query={}", urlencode(q)));
    }
    let resp = client.get(url).send().await?.error_for_status()?;
    let json: serde_json::Value = resp.json().await?;
    let arr = json["servers"].as_array().cloned().unwrap_or_default();
    Ok(arr
        .iter()
        .filter_map(|s| {
            let id = s.get("id")?.as_str()?.to_string();
            let name = s
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&id)
                .to_string();
            let description = s
                .get("description")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let is_installed = installed.contains(id.trim());
            Some(McpCatalogCard { id, name, description, installed: is_installed })
        })
        .collect())
}

/// Install an MCP server by catalog id via `POST /api/mcp/catalog/install`. Core
/// writes a DISABLED `~/.ryu/mcp.json` entry and never auto-launches it. Returns
/// the written server name.
pub async fn install_mcp_server(
    api_url: &str,
    token: Option<&str>,
    id: &str,
) -> anyhow::Result<String> {
    let client = authed_client(token);
    let body = serde_json::json!({ "id": id });
    let resp = client
        .post(format!("{api_url}/api/mcp/catalog/install"))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await?;
    let json: serde_json::Value = resp.json().await?;
    if json.get("success").and_then(|v| v.as_bool()) == Some(false) {
        let err = json.get("error").and_then(|v| v.as_str()).unwrap_or("install failed");
        anyhow::bail!("{err}");
    }
    let name = json["server"]["name"].as_str().unwrap_or(id).to_string();
    Ok(name)
}

/// Summary of a completed OKF export: where it was written and what it contains.
pub struct OkfExportResult {
    pub target_dir: String,
    pub concepts: usize,
    pub files: Vec<String>,
}

/// Export indexed knowledge as an OKF bundle directory via Core.
///
/// Calls `POST {api_url}/api/okf/export` with `{ scope: "bundle", bundle_id }`
/// (or the agent default when `bundle_id` is `None`, which Core rejects until a
/// broader scope lands). Core reconstructs the concepts, writes the bundle to
/// `target_dir`, and returns the file listing.
pub async fn export_okf_bundle(
    api_url: &str,
    token: Option<&str>,
    target_dir: &str,
    bundle_id: Option<&str>,
) -> anyhow::Result<OkfExportResult> {
    let client = authed_client(token);
    let mut body = serde_json::json!({
        "target_dir": target_dir,
        "scope": "bundle",
    });
    if let Some(id) = bundle_id {
        body["bundle_id"] = serde_json::Value::String(id.to_string());
    }
    let resp = client
        .post(format!("{api_url}/api/okf/export"))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await?;
    let json: serde_json::Value = resp.json().await?;
    if json.get("success").and_then(|v| v.as_bool()) != Some(true) {
        let err = json
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("export failed");
        anyhow::bail!("{err}");
    }
    let target_dir = json
        .get("target_dir")
        .and_then(|v| v.as_str())
        .unwrap_or(target_dir)
        .to_string();
    let concepts = json
        .get("concepts")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0) as usize;
    let files = json
        .get("files")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    Ok(OkfExportResult {
        target_dir,
        concepts,
        files,
    })
}

/// Minimal percent-encoding for a query-string value (no extra deps). Encodes
/// everything outside the unreserved set so spaces, slashes, etc. survive.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        let unreserved = byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'_' | b'.' | b'~');
        if unreserved {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub async fn install_selected(app: &mut App) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let mut results: Vec<(String, bool)> = Vec::new();

    // Install selected provider
    if let Some(provider) = app.providers.iter().find(|p| p.selected) {
        let url = format!("{}/api/setup/{}/install", app.api_url, provider.name);
        let queued = client
            .post(&url)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        results.push((provider.name.clone(), queued));
    }

    // Install selected tools
    for tool in app.tools.iter().filter(|t| t.selected) {
        let url = format!("{}/api/setup/{}/install", app.api_url, tool.name);
        let queued = client
            .post(&url)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        results.push((tool.name.clone(), queued));
    }

    // Install selected agent
    if let Some(agent) = app.agents.iter().find(|a| a.selected) {
        let url = format!("{}/api/setup/{}/install", app.api_url, agent.name);
        let queued = client
            .post(&url)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        results.push((agent.name.clone(), queued));
    }

    app.install_results = results;
    let _ = fetch_installed(app).await;
    Ok(())
}