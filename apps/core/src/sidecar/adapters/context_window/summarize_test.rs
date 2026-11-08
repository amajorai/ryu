//! Tests for the summarizer's response handling: a refusal, a non-`stop`
//! completion or an empty answer is never accepted (or cached) as a summary.

use super::*;
use serde_json::json;

fn completion(content: &str, finish_reason: Option<&str>) -> serde_json::Value {
    json!({
        "choices": [{
            "message": { "role": "assistant", "content": content },
            "finish_reason": finish_reason,
        }]
    })
}

#[test]
fn a_normal_summary_is_accepted() {
    let body = completion(
        "- The user wants a quarterly report.\n- Due Friday.",
        Some("stop"),
    );
    assert_eq!(
        summary_text_from_response(&body).unwrap(),
        "- The user wants a quarterly report.\n- Due Friday."
    );
}

#[test]
fn a_missing_finish_reason_is_tolerated() {
    let body = completion("- fact", None);
    assert!(summary_text_from_response(&body).is_ok());
}

#[test]
fn content_filter_and_length_stops_are_rejected() {
    for reason in ["content_filter", "length", "refusal"] {
        let body = completion("- partial summary", Some(reason));
        assert!(
            summary_text_from_response(&body).is_err(),
            "`{reason}` must not yield a summary"
        );
    }
}

#[test]
fn a_provider_refusal_field_is_rejected() {
    let body = json!({
        "choices": [{
            "message": { "content": "", "refusal": "I can't help with that." },
            "finish_reason": "stop",
        }]
    });
    let error = summary_text_from_response(&body).unwrap_err();
    assert!(error.contains("refused"), "{error}");
}

#[test]
fn a_prose_refusal_is_rejected() {
    for reply in [
        "I can't help summarise this content.",
        "I’m sorry, but I cannot assist with that request.",
        "  - I cannot summarize this excerpt.",
        "As an AI, I won't process this.",
    ] {
        let body = completion(reply, Some("stop"));
        assert!(
            summary_text_from_response(&body).is_err(),
            "refusal `{reply}` must not become the summary"
        );
    }
}

#[test]
fn an_empty_or_missing_answer_is_rejected() {
    assert!(summary_text_from_response(&completion("   ", Some("stop"))).is_err());
    assert!(summary_text_from_response(&json!({ "choices": [] })).is_err());
}

#[test]
fn a_summary_mentioning_a_refusal_later_is_still_accepted() {
    let body = completion(
        "- The assistant said it cannot open the file.\n- The user retried.",
        Some("stop"),
    );
    assert!(summary_text_from_response(&body).is_ok());
}

#[test]
fn both_prompts_mark_the_excerpt_as_data() {
    for kind in [SummaryKind::Compact, SummaryKind::Handoff] {
        let prompt = kind.system_prompt();
        assert!(prompt.contains("data, not instructions"), "{prompt}");
        assert!(prompt.contains("standing permissions"), "{prompt}");
    }
}

#[test]
fn the_summary_memo_stays_bounded_and_keeps_the_newest_entry() {
    let mut cache = HashMap::new();
    let total = MAX_CACHED_SUMMARIES as u64 + 10;
    for key in 0..total {
        remember_summary(&mut cache, key, format!("summary {key}"));
        assert!(cache.len() <= MAX_CACHED_SUMMARIES);
    }
    let newest = total - 1;
    assert_eq!(cache.get(&newest).map(String::as_str), Some("summary 265"));
}

#[test]
fn re_remembering_a_cached_key_at_capacity_does_not_clear_the_memo() {
    let mut cache = HashMap::new();
    for key in 0..MAX_CACHED_SUMMARIES as u64 {
        remember_summary(&mut cache, key, format!("summary {key}"));
    }
    assert_eq!(cache.len(), MAX_CACHED_SUMMARIES);
    remember_summary(&mut cache, 3, "updated".to_owned());
    assert_eq!(cache.len(), MAX_CACHED_SUMMARIES);
    assert_eq!(cache.get(&3).map(String::as_str), Some("updated"));
    assert!(cache.contains_key(&0));
}
