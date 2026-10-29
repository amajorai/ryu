use super::*;

use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use regex::Regex;
use serde_json::{json, Value};
use tokio::sync::RwLock;

use crate::plugin_manifest::PluginManifest;

// ── Deterministic tool building (write → verify → install) ───────────────────
//
// The runtime twin of `tools/toolsmith`. The three tools below close the loop
// that makes a self-building agent trustworthy on critical business workflows:
// the AI authors a tool body + its case table, the determinism gate (purity
// scan + golden cases run twice in the deny-all sandbox) decides whether it is
// safe to call, and ONLY a passing tool is ever made callable.
//
// Load-bearing boundary: `write_tool` never hot-reloads. A tool does not enter
// the live registry until `install_tool` has re-run the gate and refused-or-
// passed. There is deliberately no "write and trust me" path.

pub(super) async fn write_tool(args: Value) -> Result<Value> {
    let id = args["id"].as_str().ok_or_else(|| anyhow!("missing 'id'"))?;
    let slug = args["slug"]
        .as_str()
        .ok_or_else(|| anyhow!("missing 'slug'"))?;
    let body = args["body"]
        .as_str()
        .ok_or_else(|| anyhow!("missing 'body'"))?;
    let description = args["description"]
        .as_str()
        .ok_or_else(|| anyhow!("missing 'description'"))?;
    let input_schema = args["input_schema"].clone();
    let cases = args["cases"].clone();

    if !input_schema.is_object() {
        return Err(anyhow!("'input_schema' must be a JSON Schema object"));
    }
    let cases_arr = cases
        .as_array()
        .ok_or_else(|| anyhow!("'cases' must be an array of case objects"))?;
    if cases_arr.len() < 3 {
        return Err(anyhow!(
            "'cases' needs at least 3 entries (happy path, edge case, failure); got {}",
            cases_arr.len()
        ));
    }
    if !Regex::new(r"^[a-z0-9][a-z0-9_.-]*$")
        .expect("static slug regex")
        .is_match(slug)
    {
        return Err(anyhow!("'slug' must match [a-z0-9][a-z0-9_.-]*"));
    }
    if body.trim().is_empty() {
        return Err(anyhow!("'body' must not be empty"));
    }
    if description.trim().is_empty() || description.trim_start().starts_with("TODO") {
        return Err(anyhow!(
            "'description' must be a real one-liner, not a TODO"
        ));
    }

    // Authorization before any write.
    check_self_build_grant(id).await?;

    // Confinement (also yields the target dir).
    let app_dir = validate_write_target(id)?;

    // Build + validate the sealed manifest exactly as Core will load it.
    let manifest_json =
        crate::runnable::tool_build::tool_manifest_json(id, slug, description, input_schema, body);
    crate::runnable::tool_build::validate_tool_config(&manifest_json["runnables"][0]["config"])
        .map_err(|e| anyhow!("{e}"))?;
    let manifest: PluginManifest = serde_json::from_value(manifest_json)
        .with_context(|| "manifest is not a valid PluginManifest")?;
    semver::Version::parse(&manifest.version).with_context(|| {
        format!(
            "manifest.version '{}' is not valid semver",
            manifest.version
        )
    })?;

    // Write the three files. NO hot-reload: nothing is callable until install_tool
    // passes the gate.
    write_manifest_to_disk(&manifest).await?;
    write_tool_sources(&app_dir, slug, body, cases).await?;

    tracing::info!(app_id = id, "self-build: write_tool completed");

    Ok(json!({
        "success": true,
        "app_id": id,
        "path": app_dir.to_string_lossy(),
        "message": "Tool authored and sealed. NOT yet callable — run verify_tool (the determinism gate), fix anything it flags, then install_tool to make it live.",
        "next": ["verify_tool", "install_tool"]
    }))
}

/// Write the authored half of a tool package — the body file (`tools/<slug>.js`,
/// the source form) and `cases.json` (the case table) — beside the manifest
/// `write_manifest_to_disk` already laid down.
async fn write_tool_sources(app_dir: &Path, slug: &str, body: &str, cases: Value) -> Result<()> {
    let tools_dir = app_dir.join("tools");
    let code_path = tools_dir.join(format!("{slug}.js"));
    let cases_path = app_dir.join("cases.json");
    let cases_json = serde_json::to_string_pretty(&json!({
        "tool": slug,
        "kind": "inline_tool",
        "code_file": format!("tools/{slug}.js"),
        "cases": cases,
    }))
    .context("serializing cases.json")?;

    tokio::task::spawn_blocking({
        let tools_dir = tools_dir.clone();
        let code_path = code_path.clone();
        let cases_path = cases_path.clone();
        let body = body.to_owned();
        let cases_json = cases_json.clone();
        move || {
            std::fs::create_dir_all(&tools_dir)
                .with_context(|| format!("creating {}", tools_dir.display()))?;
            write_secret_file(&code_path, body.as_bytes())?;
            write_secret_file(&cases_path, cases_json.as_bytes())?;
            Ok::<_, anyhow::Error>(())
        }
    })
    .await
    .context("write tool sources task panicked")??;
    Ok(())
}

/// The determinism gate. Read-only (no grant needed): it scans the body and runs
/// the cases, but never writes and never makes anything callable.
pub(super) async fn verify_tool(args: Value) -> Result<Value> {
    let id = args["id"].as_str().ok_or_else(|| anyhow!("missing 'id'"))?;
    let app_dir = validate_write_target(id)?;

    let report = crate::runnable::tool_build::verify_tool_package(&app_dir, id)
        .await
        .map_err(|e| anyhow!("{e}"))?;
    let report_value = serde_json::to_value(&report).unwrap_or_default();

    Ok(json!({
        "success": report.passed,
        "app_id": id,
        "report": report_value,
        "message": if report.passed {
            format!("Tool '{id}' is deterministic and passes all cases. Run install_tool to make it live.")
        } else {
            format!("Tool '{id}' does NOT pass the determinism gate. Fix the flagged items and re-run verify_tool.")
        }
    }))
}

/// Make a self-built tool callable. Re-runs the gate and REFUSES on failure —
/// this is the only path that ever exposes an AI-authored tool, so the gate is
/// load-bearing rather than advisory.
pub(super) async fn install_tool(
    args: Value,
    hot_manifests: Arc<RwLock<Vec<PluginManifest>>>,
    app_store: Arc<crate::plugins::PluginStore>,
) -> Result<Value> {
    let id = args["id"].as_str().ok_or_else(|| anyhow!("missing 'id'"))?;

    // Authorization before the tool is made live.
    check_self_build_grant(id).await?;

    let app_dir = validate_write_target(id)?;
    let report = crate::runnable::tool_build::verify_tool_package(&app_dir, id)
        .await
        .map_err(|e| anyhow!("{e}"))?;
    if !report.passed {
        let detail = serde_json::to_string_pretty(&report).unwrap_or_else(|_| "".to_owned());
        return Err(anyhow!(
            "refusing to install '{id}': the tool does not pass the determinism gate.\n{detail}"
        ));
    }

    let manifest = load_and_hot_reload_from_disk(id, Arc::clone(&hot_manifests)).await?;
    let record = crate::plugins::lifecycle::install_app(&app_store, &manifest)
        .await
        .with_context(|| format!("install failed for '{id}'"))?;

    Ok(json!({
        "success": true,
        "app_id": id,
        "record": serde_json::to_value(&record).unwrap_or_default(),
        "message": format!("Tool '{id}' verified deterministic and installed. Enable via POST /api/apps/{id}/enable.")
    }))
}
