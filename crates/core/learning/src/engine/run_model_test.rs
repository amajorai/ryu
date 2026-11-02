use serde_json::json;

use super::completion_text;

fn completion(content: &str, finish: serde_json::Value) -> serde_json::Value {
    json!({
        "choices": [{
            "message": { "role": "assistant", "content": content },
            "finish_reason": finish,
        }]
    })
}

#[test]
fn a_normal_stop_hands_the_reply_on() {
    for finish in ["stop", "end_turn", "eos", " STOP "] {
        assert_eq!(
            completion_text(&completion("0.82", json!(finish))),
            Ok("0.82".to_string()),
            "{finish:?}"
        );
    }
}

#[test]
fn an_abnormal_or_missing_finish_is_no_reply() {
    // A cut-off "0.95" would otherwise score as 0.9.
    for finish in [
        json!("length"),
        json!("content_filter"),
        json!("tool_calls"),
        json!(""),
        json!(null),
    ] {
        assert!(
            completion_text(&completion("0.9", finish.clone())).is_err(),
            "{finish:?} must not hand on a verdict"
        );
    }
}

#[test]
fn a_provider_refusal_is_no_reply() {
    let mut v = completion("0.9", json!("stop"));
    v["choices"][0]["message"]["refusal"] = json!("I can't help with that.");
    assert!(completion_text(&v).is_err());
    // An empty refusal field is not a refusal.
    v["choices"][0]["message"]["refusal"] = json!("");
    assert_eq!(completion_text(&v), Ok("0.9".to_string()));
}
