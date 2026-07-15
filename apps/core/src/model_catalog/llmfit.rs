//! On-demand hardware fit + speed estimate via the optional `llmfit` sidecar
//! binary (`~/.ryu/bin/llmfit`).
//!
//! Unlike the always-on native [`super::device`] verdict (instant, universal, but
//! a coarse file-size heuristic), llmfit gives a bandwidth-based tok/s estimate
//! and a context/quant-aware fit. The trade-off is real: every `llmfit plan` call
//! is ~15s and networked (not cached), and llmfit only knows its own curated
//! model catalog (matched by name — arbitrary GGUF repos often miss). So this is
//! invoked ONLY on an explicit user request (the Model tab "Estimate speed"
//! button), never while listing models. All failures degrade to
//! `matched: false` / `installed: false` so the UI can fall back to the native
//! verdict.

use std::{path::PathBuf, time::Duration};

use serde::{Deserialize, Serialize};

use crate::win_process::NoWindow;

/// Default context length used for the estimate when the caller doesn't pin one.
/// KV-cache (and thus fit/speed) scales with context, so a representative value
/// keeps the estimate honest without the caller having to know the model's max.
const DEFAULT_CONTEXT: u32 = 8192;

/// How long to allow a single `llmfit plan` invocation before giving up. The call
/// is networked and typically ~15s; the ceiling guards against a hung process.
const PLAN_TIMEOUT: Duration = Duration::from_secs(35);

/// Path to the installed llmfit binary, when present (`~/.ryu/bin/llmfit`).
fn llmfit_binary() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "llmfit.exe"
    } else {
        "llmfit"
    };
    let path = crate::paths::ryu_dir().join("bin").join(name);
    path.exists().then_some(path)
}

/// The result the UI renders. `installed` gates the whole feature; `matched` says
/// whether llmfit's catalog actually recognised the model.
#[derive(Debug, Clone, Serialize)]
pub struct LlmFitEstimate {
    /// The llmfit binary is present on the node.
    pub installed: bool,
    /// llmfit's catalog recognised the model and produced an estimate.
    pub matched: bool,
    /// Estimated tokens/sec on the best feasible run path.
    pub tps: Option<f64>,
    /// llmfit's fit label for that path, e.g. `"Perfect"`, `"Marginal"`.
    pub fit_level: Option<String>,
    /// Minimum VRAM (GB) that path needs.
    pub min_vram_gb: Option<f64>,
    /// Which path the numbers describe: `"gpu"`, `"cpu_offload"`, `"cpu_only"`.
    pub path: Option<String>,
    /// The llmfit catalog name that matched (shown so the user can sanity-check
    /// the match against what they picked).
    pub model_name: Option<String>,
}

impl LlmFitEstimate {
    fn not_installed() -> Self {
        Self {
            installed: false,
            matched: false,
            tps: None,
            fit_level: None,
            min_vram_gb: None,
            path: None,
            model_name: None,
        }
    }

    fn unmatched() -> Self {
        Self {
            installed: true,
            ..Self::not_installed()
        }
    }
}

// ── `llmfit plan --json` shape (defensive: every field optional) ──────────────

#[derive(Debug, Deserialize)]
struct PlanOut {
    #[serde(default)]
    model_name: Option<String>,
    #[serde(default)]
    run_paths: Vec<RunPath>,
}

#[derive(Debug, Deserialize)]
struct RunPath {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    feasible: bool,
    #[serde(default)]
    estimated_tps: Option<f64>,
    #[serde(default)]
    fit_level: Option<String>,
    #[serde(default)]
    minimum: Option<HwReq>,
}

#[derive(Debug, Deserialize)]
struct HwReq {
    #[serde(default)]
    vram_gb: Option<f64>,
}

/// Candidate llmfit catalog names to try for a Ryu repo id, most-specific first.
/// Ryu browses GGUF repos (`unsloth/Qwen2.5-7B-Instruct-GGUF`) whereas llmfit
/// keys on the base model (`Qwen2.5-7B-Instruct`), so we peel the repo down.
fn candidate_names(repo: &str) -> Vec<String> {
    let mut out = vec![repo.to_string()];
    // Strip a trailing GGUF marker (case-insensitive) if present.
    let lower = repo.to_ascii_lowercase();
    let base: String = if lower.ends_with("-gguf") {
        repo[..repo.len() - "-gguf".len()].to_string()
    } else {
        repo.to_string()
    };
    if base != repo {
        out.push(base.clone());
    }
    // Strip the publisher prefix (`unsloth/Qwen2.5-7B` -> `Qwen2.5-7B`).
    if let Some((_, tail)) = base.split_once('/') {
        out.push(tail.to_string());
    }
    out.dedup();
    out
}

/// Best feasible run path, preferring full GPU, then CPU offload, then CPU only.
fn best_path(paths: &[RunPath]) -> Option<&RunPath> {
    for want in ["gpu", "cpu_offload", "cpu_only"] {
        if let Some(rp) = paths
            .iter()
            .find(|p| p.feasible && p.path.as_deref() == Some(want))
        {
            return Some(rp);
        }
    }
    paths.iter().find(|p| p.feasible).or_else(|| paths.first())
}

/// Run `llmfit plan <name> --json` once. Returns `None` on spawn failure, a
/// timeout, a non-zero exit, or output that isn't the expected JSON (e.g. llmfit
/// prints `Error: No model found …` for an unknown model).
async fn run_plan(bin: &PathBuf, name: &str, context: u32, quant: Option<&str>) -> Option<PlanOut> {
    let bin = bin.clone();
    let name = name.to_string();
    let quant = quant.map(str::to_string);
    let output = tokio::time::timeout(
        PLAN_TIMEOUT,
        tokio::task::spawn_blocking(move || {
            let mut cmd = std::process::Command::new(&bin);
            cmd.arg("plan")
                .arg(&name)
                .arg("--context")
                .arg(context.to_string())
                .arg("--json");
            if let Some(q) = quant.as_deref() {
                cmd.arg("--quant").arg(q);
            }
            cmd.no_window();
            cmd.output()
        }),
    )
    .await
    .ok()?
    .ok()?
    .ok()?;

    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str::<PlanOut>(stdout.trim()).ok()
}

/// Estimate fit + speed for `repo` (a Ryu HF repo id) at the given context/quant.
/// `context` falls back to [`DEFAULT_CONTEXT`] when `None`.
pub async fn estimate(repo: &str, context: Option<u32>, quant: Option<&str>) -> LlmFitEstimate {
    let Some(bin) = llmfit_binary() else {
        return LlmFitEstimate::not_installed();
    };
    let context = context.unwrap_or(DEFAULT_CONTEXT);

    for name in candidate_names(repo) {
        let Some(plan) = run_plan(&bin, &name, context, quant).await else {
            continue;
        };
        if let Some(rp) = best_path(&plan.run_paths) {
            return LlmFitEstimate {
                installed: true,
                matched: true,
                tps: rp.estimated_tps,
                fit_level: rp.fit_level.clone(),
                min_vram_gb: rp.minimum.as_ref().and_then(|m| m.vram_gb),
                path: rp.path.clone(),
                model_name: plan.model_name.clone(),
            };
        }
    }
    LlmFitEstimate::unmatched()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_names_peels_gguf_and_publisher() {
        let names = candidate_names("unsloth/Qwen2.5-7B-Instruct-GGUF");
        assert_eq!(names[0], "unsloth/Qwen2.5-7B-Instruct-GGUF");
        assert!(names.contains(&"unsloth/Qwen2.5-7B-Instruct".to_string()));
        assert!(names.contains(&"Qwen2.5-7B-Instruct".to_string()));
    }

    #[test]
    fn candidate_names_dedups_when_no_gguf_or_publisher() {
        let names = candidate_names("Qwen3-4B");
        assert_eq!(names, vec!["Qwen3-4B".to_string()]);
    }

    #[test]
    fn best_path_prefers_feasible_gpu() {
        let paths = vec![
            RunPath {
                path: Some("cpu_only".into()),
                feasible: true,
                estimated_tps: Some(10.0),
                fit_level: Some("Marginal".into()),
                minimum: None,
            },
            RunPath {
                path: Some("gpu".into()),
                feasible: true,
                estimated_tps: Some(180.0),
                fit_level: Some("Perfect".into()),
                minimum: None,
            },
        ];
        assert_eq!(best_path(&paths).unwrap().path.as_deref(), Some("gpu"));
    }
}
