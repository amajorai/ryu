use anyhow::Result;
use serde_json::{json, Value};
use std::collections::HashMap;

use ghost_core::recipe::{
    engine::{substitute_step, validate_params},
    store::RecipeStore,
    types::{RecipeRunResult, RecipeStepResult},
};

pub async fn ghost_recipes(_params: Value) -> Result<Value> {
    let store = RecipeStore::open()?;
    let recipes = store.list()?;

    let list: Vec<Value> = recipes.iter().map(|r| json!({
        "name":        r.name,
        "description": r.description,
        "app":         r.app,
        "params":      r.params.as_ref().map(|p| p.keys().collect::<Vec<_>>()),
        "step_count":  r.steps.len(),
    })).collect();

    Ok(json!({ "count": list.len(), "recipes": list }))
}

pub async fn ghost_run(params: Value) -> Result<Value> {
    let recipe_name = params["recipe"].as_str()
        .ok_or_else(|| anyhow::anyhow!("'recipe' required"))?;

    let provided_params: HashMap<String, String> = params["params"]
        .as_object()
        .map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
        .unwrap_or_default();

    let store = RecipeStore::open()?;
    let recipe = store.get(recipe_name)?;

    validate_params(&recipe, &provided_params)?;

    // Check recipe-level preconditions before executing any steps
    if let Some(pre) = &recipe.preconditions {
        if let Some(app) = &pre.app_running {
            use ghost_eyes::AXTree;
            let ax = ghost_eyes::PlatformAXTree::new()
                .map_err(|e| anyhow::anyhow!("AX unavailable: {e}"))?;
            let running_apps = ax.list_apps().await;
            let app_lc = app.to_lowercase();
            // Each entry is { "pid": N, "name": "process.exe" }
            let running = running_apps.iter().any(|a| {
                a["name"].as_str()
                    .map(|n| n.to_lowercase().contains(&app_lc))
                    .unwrap_or(false)
            });
            if !running {
                let names: Vec<&str> = running_apps.iter()
                    .filter_map(|a| a["name"].as_str())
                    .collect();
                return Err(anyhow::anyhow!(
                    "Precondition failed: app '{}' is not running. Running: {:?}",
                    app, names
                ));
            }
        }
        if let Some(url_substr) = &pre.url_contains {
            use ghost_eyes::{PlatformWindowTracker, WindowTracker};
            let tracker = PlatformWindowTracker::new()
                .map_err(|e| anyhow::anyhow!("WindowTracker unavailable: {e}"))?;
            let current_url = tracker.get_active_window().await
                .and_then(|w| w.url)
                .unwrap_or_default();
            if !current_url.contains(url_substr.as_str()) {
                return Err(anyhow::anyhow!(
                    "Precondition failed: current URL '{}' does not contain '{}'",
                    current_url, url_substr
                ));
            }
        }
    }

    let mut step_results = vec![];
    let total = recipe.steps.len() as u32;

    for step in &recipe.steps {
        let step_sub = substitute_step(step, &provided_params);
        let start = std::time::Instant::now();

        // Execute the step by mapping action to tool calls
        let result = execute_step(&step_sub, &provided_params).await;
        let duration_ms = start.elapsed().as_millis() as u64;

        let (success, error) = match result {
            Ok(_)  => (true,  None),
            Err(e) => (false, Some(e.to_string())),
        };

        step_results.push(RecipeStepResult {
            step_id: step_sub.id,
            action:  step_sub.action.clone(),
            success,
            duration_ms,
            error: error.clone(),
            note: step_sub.note.clone(),
        });

        // Handle step failure
        if !success {
            let on_fail = step_sub.on_failure.as_deref().or(recipe.on_failure.as_deref()).unwrap_or("abort");
            if on_fail == "abort" || on_fail == "fail" {
                let run_result = RecipeRunResult {
                    recipe_name: recipe_name.to_string(),
                    success: false,
                    steps_completed: step_results.len() as u32,
                    total_steps: total,
                    step_results,
                    error,
                };
                return Ok(serde_json::to_value(run_result)?);
            }
            // "continue" -> keep going
        }

        // Wait after step if configured — delegate to ghost_wait for real condition polling
        if let Some(wait) = &step_sub.wait_after {
            let wp = serde_json::json!({
                "condition": wait.condition,
                "value":     wait.value,
                "timeout":   wait.timeout.unwrap_or(5.0),
                "interval":  0.5,
            });
            // Ignore timeout/not-met result — recipe on_failure handles step failure
            let _ = crate::tools::wait::ghost_wait(wp).await;
        }
    }

    let steps_completed = step_results.iter().filter(|r| r.success).count() as u32;
    Ok(serde_json::to_value(RecipeRunResult {
        recipe_name: recipe_name.to_string(),
        success: steps_completed == total,
        steps_completed,
        total_steps: total,
        step_results,
        error: None,
    })?)
}

pub async fn ghost_recipe_show(params: Value) -> Result<Value> {
    let name = params["name"].as_str().ok_or_else(|| anyhow::anyhow!("'name' required"))?;
    let store = RecipeStore::open()?;
    let recipe = store.get(name)?;
    Ok(serde_json::to_value(&recipe)?)
}

pub async fn ghost_recipe_save(params: Value) -> Result<Value> {
    let json_str = params["recipe_json"].as_str()
        .ok_or_else(|| anyhow::anyhow!("'recipe_json' required"))?;
    let store = RecipeStore::open()?;
    let recipe = store.save_json(json_str)?;
    Ok(json!({ "saved": true, "name": recipe.name }))
}

pub async fn ghost_recipe_delete(params: Value) -> Result<Value> {
    let name = params["name"].as_str().ok_or_else(|| anyhow::anyhow!("'name' required"))?;
    let store = RecipeStore::open()?;
    store.delete(name)?;
    Ok(json!({ "deleted": true, "name": name }))
}

// ─── Step execution ───────────────────────────────────────────────────────────

async fn execute_step(
    step: &ghost_core::recipe::types::RecipeStep,
    _params: &HashMap<String, String>,
) -> Result<()> {
    use crate::tools::{actions, perception};

    let target_query     = step.target.as_ref().and_then(|t| t.query.as_deref()).unwrap_or("");
    let target_app       = step.target.as_ref().and_then(|t| t.app.as_deref());
    let target_dom_id    = step.target.as_ref().and_then(|t| t.dom_id.as_deref());
    let target_dom_class = step.target.as_ref().and_then(|t| t.dom_class.as_deref());
    let step_params      = step.params.as_ref();

    match step.action.as_str() {
        "click" => {
            let mut call = json!({ "query": target_query });
            if let Some(app) = target_app       { call["app"]       = json!(app); }
            if let Some(id)  = target_dom_id    { call["dom_id"]    = json!(id); }
            if let Some(cls) = target_dom_class { call["dom_class"] = json!(cls); }
            actions::ghost_click(call).await.map(|_| ())
        }
        "type" => {
            let text = step_params.and_then(|p| p.get("text")).map(|s| s.as_str()).unwrap_or("");
            let mut call = json!({ "text": text, "into": target_query });
            if let Some(app) = target_app    { call["app"]    = json!(app); }
            if let Some(id)  = target_dom_id { call["dom_id"] = json!(id); }
            if let Some(p) = step_params { if p.contains_key("clear") { call["clear"] = json!(true); } }
            actions::ghost_type(call).await.map(|_| ())
        }
        "hotkey" | "keyboard_shortcut" => {
            let keys_str = step_params.and_then(|p| p.get("keys")).map(|s| s.as_str()).unwrap_or("");
            let keys: Vec<&str> = keys_str.split('+').map(|s| s.trim()).collect();
            let mut call = json!({ "keys": keys });
            if let Some(app) = target_app { call["app"] = json!(app); }
            actions::ghost_hotkey(call).await.map(|_| ())
        }
        "press" => {
            let key = step_params.and_then(|p| p.get("key")).map(|s| s.as_str()).unwrap_or("return");
            let mut call = json!({ "key": key });
            if let Some(app) = target_app { call["app"] = json!(app); }
            actions::ghost_press(call).await.map(|_| ())
        }
        "scroll" => {
            let dir = step_params.and_then(|p| p.get("direction")).map(|s| s.as_str()).unwrap_or("down");
            let amt = step_params.and_then(|p| p.get("amount")).and_then(|s| s.parse::<i64>().ok()).unwrap_or(3);
            let mut call = json!({ "direction": dir, "amount": amt });
            if let Some(app) = target_app { call["app"] = json!(app); }
            actions::ghost_scroll(call).await.map(|_| ())
        }
        "focus" => {
            let app = target_app.or_else(|| step_params.and_then(|p| p.get("app")).map(|s| s.as_str())).unwrap_or("");
            actions::ghost_focus(json!({ "app": app })).await.map(|_| ())
        }
        "wait" => {
            let secs = step_params.and_then(|p| p.get("seconds")).and_then(|s| s.parse::<f64>().ok()).unwrap_or(1.0);
            tokio::time::sleep(tokio::time::Duration::from_secs_f64(secs)).await;
            Ok(())
        }
        "hover" => {
            let mut call = json!({ "query": target_query });
            if let Some(app) = target_app       { call["app"]       = json!(app); }
            if let Some(id)  = target_dom_id    { call["dom_id"]    = json!(id); }
            if let Some(cls) = target_dom_class { call["dom_class"] = json!(cls); }
            if let Some(x) = param_f64(step_params, "x") { call["x"] = json!(x); }
            if let Some(y) = param_f64(step_params, "y") { call["y"] = json!(y); }
            actions::ghost_hover(call).await.map(|_| ())
        }
        "long_press" => {
            let mut call = json!({ "query": target_query });
            if let Some(app) = target_app       { call["app"]       = json!(app); }
            if let Some(id)  = target_dom_id    { call["dom_id"]    = json!(id); }
            if let Some(cls) = target_dom_class { call["dom_class"] = json!(cls); }
            if let Some(x) = param_f64(step_params, "x") { call["x"] = json!(x); }
            if let Some(y) = param_f64(step_params, "y") { call["y"] = json!(y); }
            if let Some(d) = param_f64(step_params, "duration") { call["duration"] = json!(d); }
            if let Some(b) = step_params.and_then(|p| p.get("button")).map(|s| s.as_str()) { call["button"] = json!(b); }
            actions::ghost_long_press(call).await.map(|_| ())
        }
        "drag" => {
            let mut call = json!({});
            if !target_query.is_empty() { call["query"] = json!(target_query); }
            if let Some(app) = target_app { call["app"] = json!(app); }
            if let Some(x) = param_f64(step_params, "from_x") { call["from_x"] = json!(x); }
            if let Some(y) = param_f64(step_params, "from_y") { call["from_y"] = json!(y); }
            if let Some(x) = param_f64(step_params, "to_x")   { call["to_x"]   = json!(x); }
            if let Some(y) = param_f64(step_params, "to_y")   { call["to_y"]   = json!(y); }
            if let Some(d) = param_f64(step_params, "duration") { call["duration"] = json!(d); }
            actions::ghost_drag(call).await.map(|_| ())
        }
        "delay" | "sleep" => {
            let secs = param_f64(step_params, "duration").unwrap_or(1.0);
            tokio::time::sleep(tokio::time::Duration::from_secs_f64(secs)).await;
            Ok(())
        }
        "screenshot" => {
            perception::ghost_screenshot(json!({})).await.map(|_| ())
        }
        "double_click" => {
            let mut call = json!({ "query": target_query, "count": 2 });
            if let Some(app) = target_app    { call["app"]    = json!(app); }
            if let Some(id)  = target_dom_id { call["dom_id"] = json!(id); }
            actions::ghost_click(call).await.map(|_| ())
        }
        "window" => {
            let action = step_params.and_then(|p| p.get("action")).map(|s| s.as_str()).unwrap_or("focus");
            let app = target_app
                .or_else(|| step_params.and_then(|p| p.get("app")).map(|s| s.as_str()))
                .unwrap_or("");
            let mut call = json!({ "action": action, "app": app });
            if let Some(title) = step_params.and_then(|p| p.get("window")).map(|s| s.as_str()) {
                call["window"] = json!(title);
            }
            actions::ghost_window(call).await.map(|_| ())
        }
        unknown => Err(anyhow::anyhow!("Unknown recipe action: '{unknown}'")),
    }
}

fn param_f64(params: Option<&std::collections::HashMap<String, String>>, key: &str) -> Option<f64> {
    params?.get(key)?.parse().ok()
}
