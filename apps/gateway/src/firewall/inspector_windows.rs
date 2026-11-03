//! The inspector's window loop: each window judged as untrusted data, newest
//! content first, and the per-window results folded into one verdict.

use futures_util::future::join_all;
use serde_json::json;
use tracing::warn;

use super::{is_injection_only, InspectorOutcome, InspectorVerdict, WINDOW_CONCURRENCY};
use crate::{error::GatewayError, pipeline::inference_governance::InferenceClient};
use ryu_gw_screening::backends::inspector::{self as judge, JudgeReply};

/// Folds per-window results into one verdict.
#[derive(Default)]
struct Windows {
    /// Set for the Inspector stage under Sanitize, where an injection cannot
    /// be redacted: an injection-only flag is set aside instead of ending the
    /// judging, so the other windows are still judged for what Sanitize can
    /// act on, and their gaps still follow the fail mode.
    injection_continues: bool,
    flagged: bool,
    categories: Vec<String>,
    reason: String,
    /// Injection-only flags set aside under `injection_continues`.
    injection: Option<(Vec<String>, String)>,
    worst: Option<InspectorOutcome>,
}

fn merge_categories(into: &mut Vec<String>, categories: Vec<String>) {
    for category in categories {
        if !into.contains(&category) {
            into.push(category);
        }
    }
}

impl Windows {
    fn add(&mut self, window: Result<judge::JudgeVerdict, InspectorOutcome>) {
        match window {
            Ok(verdict)
                if verdict.flagged
                    && self.injection_continues
                    && is_injection_only(&verdict.categories) =>
            {
                let (categories, reason) = self.injection.get_or_insert_with(Default::default);
                merge_categories(categories, verdict.categories);
                if reason.is_empty() {
                    *reason = verdict.reason;
                }
            }
            Ok(verdict) if verdict.flagged => {
                self.flagged = true;
                merge_categories(&mut self.categories, verdict.categories);
                if self.reason.is_empty() {
                    self.reason = verdict.reason;
                }
            }
            Ok(verdict) => {
                if self.reason.is_empty() {
                    self.reason = verdict.reason;
                }
            }
            Err(outcome) => self.worst = self.worst.max(Some(outcome)),
        }
    }

    fn finish(mut self, complete: bool) -> InspectorVerdict {
        let mut worst = self.worst;
        if !complete {
            worst = worst.max(Some(InspectorOutcome::Incomplete));
        }
        let outcome = match (self.flagged, worst) {
            (true, _) | (false, None) => InspectorOutcome::Answered,
            (false, Some(outcome)) => outcome,
        };
        match self.injection.take() {
            // An injection-only flag is not a verdict on the rest of the
            // turn: the outcome is what the other windows gave.
            Some((categories, reason)) if !self.flagged => {
                warn!(
                    categories = ?categories,
                    %reason,
                    "inspector: injection flagged under Sanitize; not redactable, forwarded unchanged"
                );
                self.categories = categories;
                self.reason = reason;
            }
            Some((categories, _)) => merge_categories(&mut self.categories, categories),
            None => {}
        }
        InspectorVerdict {
            flagged: self.flagged,
            categories: self.categories,
            reason: self.reason,
            available: outcome == InspectorOutcome::Answered,
            outcome,
        }
    }
}

/// One judge's call settings; past `max_windows` the oldest text is unjudged.
#[derive(Clone, Copy)]
pub(super) struct Judge<'a> {
    pub(super) model: &'a str,
    pub(super) timeout_ms: u64,
    pub(super) max_windows: usize,
    pub(super) restrict_categories: bool,
    /// See [`Windows::injection_continues`].
    pub(super) injection_continues: bool,
}

/// Judge `text` window by window, newest content first, stopping at the
/// first flag. Provider failures are an outcome, not a clean verdict;
/// governance errors propagate. The client enforces DLP, budgets and
/// accounting without recursion.
pub(super) async fn run_inspection(
    system_prompt: &str,
    text: &str,
    Judge {
        model,
        timeout_ms,
        max_windows,
        restrict_categories,
        injection_continues,
    }: Judge<'_>,
    inference: &dyn InferenceClient,
) -> Result<InspectorVerdict, GatewayError> {
    let (windows, complete) = judge::inspect_windows(
        text,
        judge::MAX_INSPECT_CHARS,
        judge::WINDOW_OVERLAP_CHARS,
        max_windows,
    );
    if !complete {
        warn!(
            chars = text.chars().count(),
            windows = windows.len(),
            "inspector: text exceeds the window budget; the oldest content is not judged"
        );
    }
    let mut folded = Windows {
        injection_continues,
        ..Windows::default()
    };
    for batch in windows.chunks(WINDOW_CONCURRENCY) {
        let results = join_all(batch.iter().map(|window| {
            judge_window(
                system_prompt,
                window,
                model,
                timeout_ms,
                inference,
                restrict_categories,
            )
        }))
        .await;
        for result in results {
            folded.add(result?);
        }
        if folded.flagged {
            break;
        }
    }
    Ok(folded.finish(complete))
}

/// One judge call over one window.
async fn judge_window(
    system_prompt: &str,
    window: &str,
    model: &str,
    timeout_ms: u64,
    inference: &dyn InferenceClient,
    restrict_categories: bool,
) -> Result<Result<judge::JudgeVerdict, InspectorOutcome>, GatewayError> {
    let body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": judge::judge_user_content(window)},
        ],
        "temperature": 0,
        "max_tokens": 200,
        "stream": false,
    });
    let Some(response) = inference.complete(model, body, timeout_ms).await? else {
        warn!("inspector: judge provider unavailable; this window has no verdict");
        return Ok(Err(InspectorOutcome::ProviderUnavailable));
    };
    let outcome = match judge::classify_reply(&response, restrict_categories) {
        JudgeReply::Verdict(verdict) => return Ok(Ok(verdict)),
        JudgeReply::Refused(why) => {
            warn!(why, "inspector: the judge refused; not a clean verdict");
            InspectorOutcome::Refused
        }
        JudgeReply::Malformed(why) => {
            warn!(why, "inspector: the judge gave no usable verdict");
            InspectorOutcome::Malformed
        }
        JudgeReply::Unparseable => {
            warn!("inspector: the judge answered in prose with no verdict");
            InspectorOutcome::Unparseable
        }
        JudgeReply::OffVocabulary => {
            warn!("inspector: the judge flagged only topic words; not a verdict");
            InspectorOutcome::OffVocabulary
        }
    };
    Ok(Err(outcome))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flag(categories: &[&str]) -> Result<judge::JudgeVerdict, InspectorOutcome> {
        Ok(judge::JudgeVerdict {
            flagged: true,
            categories: categories.iter().map(|c| (*c).to_owned()).collect(),
            reason: format!("{categories:?}"),
        })
    }

    // Under Sanitize an injection-only flag is set aside: the outcome is what
    // the other windows gave, so a gap among them still follows the fail mode.
    #[test]
    fn a_set_aside_injection_flag_never_masks_a_gap() {
        let mut windows = Windows {
            injection_continues: true,
            ..Windows::default()
        };
        windows.add(flag(&["injection"]));
        let verdict = windows.finish(false);
        assert!(!verdict.flagged);
        assert_eq!(verdict.outcome, InspectorOutcome::Incomplete);
        assert_eq!(verdict.categories, vec!["injection"]);

        let mut windows = Windows {
            injection_continues: true,
            ..Windows::default()
        };
        windows.add(flag(&["injection"]));
        windows.add(flag(&["pii"]));
        let verdict = windows.finish(true);
        assert!(verdict.flagged);
        assert_eq!(verdict.categories, vec!["pii", "injection"]);

        // Without the setting an injection flag is a flag like any other.
        let mut windows = Windows::default();
        windows.add(flag(&["injection"]));
        let verdict = windows.finish(false);
        assert!(verdict.flagged);
        assert_eq!(verdict.outcome, InspectorOutcome::Answered);
    }
}
