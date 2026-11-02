//! Retrain dispatch: the inline-dataset byte budget and the fine-tune handoff.

use serde_json::{json, Value};

use super::config::pref;
use super::LearningCtx;
use crate::host::LearningHost;
use crate::store::Experience;

pub(super) struct Dispatched {
    pub(super) dispatched: bool,
    pub(super) job_id: Option<String>,
    pub(super) error: Option<String>,
    pub(super) note: String,
    /// Samples actually placed in the dispatched body (after the byte budget).
    pub(super) sample_count: usize,
}

/// Byte budget for the serialized inline samples of one retrain dispatch. The
/// fine-tune app's control routes reject bodies over 4 MiB; this leaves room for
/// the envelope (base model, target, remote coordinates) and JSON overhead.
pub const INLINE_DATASET_BUDGET_BYTES: usize = 3 * 1024 * 1024 + 512 * 1024;

/// Serialize rows into chat samples, in order, stopping before the cumulative
/// serialized size would exceed `budget`. Rows come reward-descending, so the
/// kept prefix is the highest-reward subset that fits. Pure for testing.
pub fn inline_samples_within_budget(rows: &[Experience], budget: usize) -> Vec<Value> {
    let mut used = 0usize;
    let mut samples = Vec::new();
    for r in rows {
        let sample = json!({ "messages": [
            { "role": "user", "content": r.user_text },
            { "role": "assistant", "content": r.assistant_text },
        ] });
        // +1 for the separating comma inside the samples array.
        let size = serde_json::to_vec(&sample).map_or(usize::MAX, |b| b.len()) + 1;
        if used.saturating_add(size) > budget {
            break;
        }
        used += size;
        samples.push(sample);
    }
    samples
}

/// Build and dispatch the retrain. A real retrain always derives a FRESH LoRA
/// from the ORIGINAL base (never a previous merge — that drifts into collapse) via
/// Core's fine-tune dispatch path, which GPU-gates and records the job. Training
/// is async in the sidecar; the produced adapter is merged→served separately, so we
/// only dispatch and report the job id. Sets `error` (distinct from a benign no-op)
/// on any misconfig or dispatch failure so the scheduler can surface it.
pub(super) async fn dispatch_cycle(
    ctx: &LearningCtx,
    base_model: &Option<String>,
    rows: &[Experience],
) -> Dispatched {
    let mut out = Dispatched {
        dispatched: false,
        job_id: None,
        error: None,
        note: String::new(),
        sample_count: 0,
    };
    let fail = |out: &mut Dispatched, msg: String| {
        out.error = Some(msg.clone());
        out.note = msg;
    };

    let Some(base) = base_model.as_deref() else {
        fail(&mut out, "cannot dispatch: set the `learning.base-model` pref to the ORIGINAL base model to retrain from".to_string());
        return out;
    };
    if rows.is_empty() {
        // Not an error — just nothing cleared the reward filter this cycle.
        out.note = "nothing to train: no samples cleared the reward filter".to_string();
        return out;
    }

    // Effective target: honor `remote` only when a remote URL is actually
    // configured; a half-configured remote is a hard error, not a silent local run.
    let requested_remote = resolve_train_target(ctx.host()).await == "remote";
    let remote = resolve_remote(ctx.host()).await;
    if requested_remote && remote.is_none() {
        fail(
            &mut out,
            "cannot dispatch: learning.train-target=remote but learning.remote-url is unset"
                .to_string(),
        );
        return out;
    }
    let use_remote = requested_remote && remote.is_some();

    // Both targets receive the samples inline: a remote node cannot read a local
    // path, and the local sidecar must not need a plaintext dataset file on disk.
    // The fine-tune control routes cap request bodies, so keep the highest-reward
    // rows (they arrive reward-descending) that fit the inline budget.
    let samples = inline_samples_within_budget(rows, INLINE_DATASET_BUDGET_BYTES);
    let sent = samples.len();
    out.sample_count = sent;
    if sent == 0 {
        fail(
            &mut out,
            format!(
                "cannot dispatch: the top-reward sample alone exceeds the {INLINE_DATASET_BUDGET_BYTES}-byte inline dataset budget"
            ),
        );
        return out;
    }
    let dataset = json!({ "format": "chat", "samples": samples });

    let output_name = format!("learned-{}", chrono::Utc::now().timestamp());
    let mut body = json!({
        "base_model_id": base,
        "target": if use_remote { "remote" } else { "local" },
        "output_name": output_name,
        "dataset": dataset,
    });
    if let Some(r) = remote.filter(|_| use_remote) {
        body["remote"] = r;
    }

    // Fine-tuning runs OUT-OF-PROCESS in the `ryu-finetune` sidecar; the learning
    // retrain reaches it through Core's fine-tune dispatch seam.
    match ctx.host().dispatch_finetune(body).await {
        Ok(resp) => {
            out.dispatched = true;
            out.job_id = resp
                .get("job_id")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            out.note = if sent < rows.len() {
                format!(
                    "fine-tune dispatched from base '{base}' on {sent} of {} samples (the rest exceeded the {INLINE_DATASET_BUDGET_BYTES}-byte inline dataset budget; highest-reward samples kept)",
                    rows.len()
                )
            } else {
                format!("fine-tune dispatched from base '{base}' on {sent} samples")
            };
        }
        Err(err) => {
            fail(&mut out, format!("dispatch failed: {err}"));
        }
    }
    out
}

/// Where a retrain runs: `local` (default) or `remote` (a Ryu Cloud GPU node).
async fn resolve_train_target(host: &dyn LearningHost) -> String {
    pref(host, "learning.train-target")
        .await
        .filter(|t| t == "remote")
        .unwrap_or_else(|| "local".to_string())
}

/// Remote GPU-node coordinates for `target: remote`, from prefs. `None` unless a
/// URL is configured. The token is passed through to the finetune dispatch and is
/// never surfaced in the plan.
async fn resolve_remote(host: &dyn LearningHost) -> Option<Value> {
    let url = pref(host, "learning.remote-url").await?;
    let mut remote = json!({ "url": url });
    if let Some(token) = pref(host, "learning.remote-token").await {
        remote["token"] = json!(token);
    }
    Some(remote)
}
