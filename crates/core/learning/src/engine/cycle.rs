//! The reward-filtered learning cycle and the merge handoff.

use std::collections::HashMap;

use anyhow::{Context, Result};
use ryu_improvement_contracts::ImprovementRunRef;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::config::{
    conversation_excluded, resolve_base_model, resolve_enabled, resolve_min_reward,
};
use super::dispatch::dispatch_cycle;
use super::score::{score_buffer, sweep_into_buffer, visible_conversation_ids};
use super::LearningCtx;
use crate::store::Experience;

// ---------------------------------------------------------------------------
// Cycle: reward-filtered SFT dataset derived from the ORIGINAL base (scaffold)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct CyclePlan {
    /// Optional correlation id for the shared recursive-improvement contract.
    /// Learning does not own the run store; it carries the validated reference
    /// so the caller can join the cycle to a Research campaign or another
    /// owning-surface record.
    #[serde(rename = "improvementRunId", skip_serializing_if = "Option::is_none")]
    pub improvement_run_id: Option<String>,
    pub base_model: Option<String>,
    pub swept: usize,
    pub scored: usize,
    pub sample_count: usize,
    pub min_reward: f64,
    /// Always `None`: datasets are no longer written to disk (a retrain sends
    /// its samples inline). Kept so existing API clients keep parsing the plan.
    pub dataset_path: Option<String>,
    /// Whether a fine-tune was actually dispatched (false = dry-run preview).
    pub dispatched: bool,
    /// Fine-tune job id when a training run was dispatched (`execute: true`).
    pub job_id: Option<String>,
    /// Set when an `execute` cycle FAILED to dispatch (misconfig, GPU gate,
    /// sidecar/remote error). Distinct from a legitimate no-op (nothing to train):
    /// the scheduler surfaces this as a job failure. `None` on success/dry-run/no-op.
    pub error: Option<String>,
    pub note: String,
}

/// One SFT example in the chat-messages shape the Unsloth sidecar consumes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftSample {
    pub messages: Vec<SftMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftMessage {
    pub role: String,
    pub content: String,
}

/// Build a reward-filtered SFT dataset (one JSON object per line) from the
/// trainable rows. Pure: takes rows, returns JSONL — unit-testable.
pub fn build_jsonl(rows: &[Experience]) -> String {
    let mut out = String::new();
    for r in rows {
        let sample = SftSample {
            messages: vec![
                SftMessage {
                    role: "user".into(),
                    content: r.user_text.clone(),
                },
                SftMessage {
                    role: "assistant".into(),
                    content: r.assistant_text.clone(),
                },
            ],
        };
        if let Ok(line) = serde_json::to_string(&sample) {
            out.push_str(&line);
            out.push('\n');
        }
    }
    out
}

/// Run the reward-filtered learning cycle. By default a **dry run**: sweep, score,
/// assemble the dataset, and return the plan WITHOUT dispatching a fine-tune
/// (training needs a GPU and is the opt-in heavy step). `execute` dispatches the
/// fine-tune through Core's fine-tune path.
pub async fn run_cycle(ctx: &LearningCtx, execute: bool) -> Result<CyclePlan> {
    run_cycle_with_improvement(ctx, execute, None).await
}

/// Run the cycle with an optional shared improvement-run correlation id.
///
/// The Learning crate validates the opaque reference but deliberately does not
/// persist or promote it. Research or the owning app remains responsible for
/// the improvement record's lifecycle and rollback decision.
pub async fn run_cycle_with_improvement(
    ctx: &LearningCtx,
    execute: bool,
    improvement_run_id: Option<&str>,
) -> Result<CyclePlan> {
    let improvement_run_id = improvement_run_id
        .map(|id| ImprovementRunRef::new(id.to_owned()).map(|reference| reference.id))
        .transpose()?;
    if !resolve_enabled(ctx.host()).await {
        return Ok(CyclePlan {
            improvement_run_id,
            base_model: None,
            swept: 0,
            scored: 0,
            sample_count: 0,
            min_reward: 0.0,
            dataset_path: None,
            dispatched: false,
            job_id: None,
            error: None,
            note: "learning is disabled (global opt-in off)".to_string(),
        });
    }
    let swept = sweep_into_buffer(ctx).await?;
    let scored = score_buffer(ctx, 256).await?;
    let min_reward = resolve_min_reward(ctx.host()).await;
    let base_model = resolve_base_model(ctx.host()).await;
    let visible_conversation_ids = visible_conversation_ids(ctx).await?;

    let candidate_rows = ctx
        .store
        .list_for_training_visible(min_reward, 4096, &visible_conversation_ids)
        .await
        .context("collecting training set")?;
    // Defense-in-depth: drop any row whose conversation is excluded by PREF, not
    // just the row flag — so an excluded chat can never enter the training set
    // even if a prior row-flip failed.
    let mut exclude_cache: HashMap<String, bool> = HashMap::new();
    let mut rows = Vec::with_capacity(candidate_rows.len());
    for r in candidate_rows {
        if !conversation_excluded(ctx.host(), &r.conversation_id, &mut exclude_cache).await {
            rows.push(r);
        }
    }
    // The dataset is never written to disk: it is a plaintext copy of the
    // (sealed) buffer, and both the local fine-tune sidecar and a remote node
    // accept the samples inline, so dispatch sends them in the request body.
    let mut dispatched = false;
    let mut job_id = None;
    let mut error = None;
    let mut sample_count = rows.len();
    let note = if execute {
        let d = dispatch_cycle(ctx, &base_model, &rows).await;
        dispatched = d.dispatched;
        job_id = d.job_id;
        error = d.error;
        if d.dispatched {
            sample_count = d.sample_count;
        }
        d.note
    } else {
        "dry run — dataset assembled; review, then re-run with execute:true to train".to_string()
    };

    Ok(CyclePlan {
        improvement_run_id,
        base_model,
        swept,
        scored,
        sample_count,
        min_reward,
        dataset_path: None,
        dispatched,
        job_id,
        error,
        note,
    })
}

/// Merge a completed learning adapter and return the registered model stem.
/// Serving-model switching stays an explicit Core-owned transaction.
pub async fn merge_cycle_output(ctx: &LearningCtx, mut body: Value) -> Result<Value> {
    let has_adapter = body
        .get("adapter_name")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
        || body
            .get("adapter_path")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty());
    if !has_adapter {
        anyhow::bail!("need `adapter_name` or `adapter_path`");
    }

    if body.get("output_name").is_none() {
        body["output_name"] = json!("learning-merged");
    }

    let merged = ctx
        .host()
        .merge_finetune(body)
        .await
        .map_err(|error| anyhow::anyhow!(error))?;
    let model_id = merged
        .get("stem")
        .or_else(|| merged.get("model_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("merge response did not include a model stem"))?;

    Ok(json!({
        "merged": true,
        "model_id": model_id,
        "serving": false,
        "merge": merged,
        "activate_with": "/api/models/active"
    }))
}
