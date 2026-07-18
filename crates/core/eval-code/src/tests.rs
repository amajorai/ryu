//! Tests for P4 code evaluators. Runtime-dependent cases (deno for JS, python
//! for Python) are **skip-if-absent** so CI without those binaries still passes;
//! the pure merge/re-aggregate machinery is covered without any runtime.

use super::*;
use serde_json::json;

fn deno_available() -> bool {
    ryu_tool_exec::is_available()
}

fn sample_payload() -> Value {
    json!({ "input": "hi", "output": "hello", "expected": null, "vars": {} })
}

// ── JS runtime (skip-if-absent) ────────────────────────────────────────────────

#[tokio::test]
async fn js_evaluator_returning_score_one_scores_the_case() {
    if !deno_available() {
        eprintln!("skipping js_evaluator_returning_score_one: no deno backend available");
        return;
    }
    let out = run_code_evaluator(
        CodeEvalLang::Js,
        "return { score: 1.0, detail: 'perfect' };",
        &sample_payload(),
        Duration::from_secs(5),
    )
    .await;
    assert!(out.executed, "should have executed: {:?}", out.error);
    assert_eq!(out.score, Some(1.0));
    assert_eq!(out.pass, Some(true)); // derived from score >= 0.5
    assert_eq!(out.detail, "perfect");
}

#[tokio::test]
async fn js_evaluator_that_throws_is_not_executed() {
    if !deno_available() {
        eprintln!("skipping js_evaluator_that_throws: no deno backend available");
        return;
    }
    let out = run_code_evaluator(
        CodeEvalLang::Js,
        "throw new Error('boom');",
        &sample_payload(),
        Duration::from_secs(5),
    )
    .await;
    assert!(!out.executed);
    assert!(out.score.is_none());
    let err = out.error.unwrap_or_default();
    assert!(err.contains("boom"), "error should carry the throw: {err}");
}

#[tokio::test]
async fn js_evaluator_returning_non_object_is_malformed() {
    if !deno_available() {
        eprintln!("skipping js_evaluator_returning_non_object: no deno backend available");
        return;
    }
    // Returns a bare number, not a {score,...} object → unparseable as a score.
    let out = run_code_evaluator(
        CodeEvalLang::Js,
        "return 42;",
        &sample_payload(),
        Duration::from_secs(5),
    )
    .await;
    assert!(!out.executed);
    assert!(out.error.is_some());
}

#[tokio::test]
async fn js_evaluator_reads_ctx_fields() {
    if !deno_available() {
        eprintln!("skipping js_evaluator_reads_ctx_fields: no deno backend available");
        return;
    }
    let payload = json!({ "input": "q", "output": "the answer is 4", "expected": "4", "vars": {} });
    let out = run_code_evaluator(
        CodeEvalLang::Js,
        "return { score: ctx.output.includes(ctx.expected) ? 1.0 : 0.0 };",
        &payload,
        Duration::from_secs(5),
    )
    .await;
    assert!(out.executed, "should have executed: {:?}", out.error);
    assert_eq!(out.score, Some(1.0));
}

// ── Python runtime (skip-if-absent) ────────────────────────────────────────────

#[tokio::test]
async fn python_evaluator_printing_score_scores_the_case() {
    if !python_on_path() {
        eprintln!("skipping python_evaluator_printing_score: python not on PATH");
        return;
    }
    let out = run_code_evaluator(
        CodeEvalLang::Python,
        "print(json.dumps({\"score\": 0.0, \"pass\": False, \"detail\": \"nope\"}))",
        &sample_payload(),
        Duration::from_secs(5),
    )
    .await;
    assert!(out.executed, "should have executed: {:?}", out.error);
    assert_eq!(out.score, Some(0.0));
    assert_eq!(out.pass, Some(false));
    assert_eq!(out.detail, "nope");
}

#[tokio::test]
async fn python_evaluator_no_output_is_not_executed() {
    if !python_on_path() {
        eprintln!("skipping python_evaluator_no_output: python not on PATH");
        return;
    }
    // Prints nothing parseable → executed:false, honest error.
    let out = run_code_evaluator(
        CodeEvalLang::Python,
        "pass",
        &sample_payload(),
        Duration::from_secs(5),
    )
    .await;
    assert!(!out.executed);
    assert!(out.error.is_some());
}

// ── Pure merge / re-aggregate (no runtime) ─────────────────────────────────────

#[test]
fn insert_replaces_placeholder_and_preserves_category() {
    let mut case = json!({
        "prompt": "p",
        "response_text": "r",
        "evaluators": [{
            "id": "e", "category": "quality", "score": 0.0, "pass": false,
            "detail": "code evaluator execution lands in P4", "executed": false
        }]
    });
    insert_or_replace_score(
        &mut case,
        "e",
        &CodeEvalOutcome {
            score: Some(1.0),
            pass: Some(true),
            detail: "ok".to_owned(),
            executed: true,
            error: None,
        },
    );
    let evs = case["evaluators"].as_array().unwrap();
    assert_eq!(evs.len(), 1, "replaced in place, not appended");
    assert_eq!(evs[0]["category"], "quality", "gateway category preserved");
    assert_eq!(evs[0]["executed"], true);
    assert_eq!(evs[0]["score"], 1.0);
    assert_eq!(evs[0]["detail"], "ok");
}

#[test]
fn insert_without_placeholder_defaults_category_custom() {
    let mut case = json!({ "prompt": "p", "response_text": "r", "evaluators": [] });
    insert_or_replace_score(
        &mut case,
        "e",
        &CodeEvalOutcome {
            score: Some(0.0),
            pass: Some(false),
            detail: String::new(),
            executed: true,
            error: None,
        },
    );
    assert_eq!(case["evaluators"][0]["category"], "custom");
}

#[test]
fn reaggregate_uses_camelcase_keys_and_executed_only() {
    let case0 = json!({
        "prompt": "p1", "response_text": "good",
        "evaluators": [{ "id": "e", "category": "quality", "score": 1.0, "pass": true, "detail": "", "executed": true }]
    });
    let case1 = json!({
        "prompt": "p2", "response_text": "bad",
        "evaluators": [{ "id": "e", "category": "custom", "score": 0.0, "pass": false, "detail": "", "executed": true }]
    });
    // A third case where the evaluator did NOT execute must be excluded from means.
    let case2 = json!({
        "prompt": "p3", "response_text": "x",
        "evaluators": [{ "id": "e", "category": "custom", "score": 0.0, "pass": false, "detail": "skip", "executed": false }]
    });
    let mut block = json!({ "cases": [case0, case1, case2], "aggregate": {} });
    let specs = vec![CodeEvaluatorSpec {
        id: "e".to_owned(),
        lang: "js".to_owned(),
        source: String::new(),
    }];
    reaggregate(&mut block, &specs);
    let agg = &block["aggregate"]["evaluators"]["e"];
    assert_eq!(agg["executedCount"], 2, "only executed cases counted");
    assert_eq!(agg["meanScore"], 0.5);
    assert_eq!(agg["passRate"], 0.5);
}

#[tokio::test]
async fn no_code_evaluators_is_unchanged_passthrough() {
    let original = json!({
        "cases": [{ "prompt": "p", "response_text": "r", "evaluators": [] }],
        "aggregate": { "mean_overall": 0.7, "evaluators": {} }
    });
    let mut response = original.clone();
    merge_code_evaluators(&mut response, &[], &[]).await;
    assert_eq!(response, original, "empty specs must be a no-op");
}

#[tokio::test]
async fn merge_two_case_dataset_with_js_evaluator() {
    if !deno_available() {
        eprintln!("skipping merge_two_case_dataset: no deno backend available");
        return;
    }
    let mut response = json!({
        "cases": [
            { "prompt": "p1", "response_text": "good",
              "evaluators": [{ "id": "myeval", "category": "quality", "score": 0.0, "pass": false,
                               "detail": "code evaluator execution lands in P4", "executed": false }] },
            { "prompt": "p2", "response_text": "bad", "evaluators": [] }
        ],
        "aggregate": { "evaluators": {} }
    });
    let specs = vec![CodeEvaluatorSpec {
        id: "myeval".to_owned(),
        lang: "js".to_owned(),
        source: "return { score: ctx.output === 'good' ? 1.0 : 0.0, pass: ctx.output === 'good' };"
            .to_owned(),
    }];
    let dataset = vec![CaseInput::default(), CaseInput::default()];
    merge_code_evaluators(&mut response, &dataset, &specs).await;

    let cases = response["cases"].as_array().unwrap();
    let e0 = &cases[0]["evaluators"][0];
    assert_eq!(e0["executed"], true, "case0 executed: {:?}", e0);
    assert_eq!(e0["score"], 1.0);
    assert_eq!(e0["category"], "quality", "placeholder category preserved");

    let e1 = &cases[1]["evaluators"][0];
    assert_eq!(e1["executed"], true);
    assert_eq!(e1["score"], 0.0);
    assert_eq!(e1["category"], "custom", "no placeholder → custom");

    let agg = &response["aggregate"]["evaluators"]["myeval"];
    assert_eq!(agg["executedCount"], 2);
    assert_eq!(agg["meanScore"], 0.5);
    assert_eq!(agg["passRate"], 0.5);
}

#[test]
fn lang_parse_accepts_aliases_and_rejects_unknown() {
    assert_eq!(CodeEvalLang::parse("JS"), Some(CodeEvalLang::Js));
    assert_eq!(CodeEvalLang::parse("javascript"), Some(CodeEvalLang::Js));
    assert_eq!(CodeEvalLang::parse("Python"), Some(CodeEvalLang::Python));
    assert_eq!(CodeEvalLang::parse("py"), Some(CodeEvalLang::Python));
    assert_eq!(CodeEvalLang::parse("ruby"), None);
}
