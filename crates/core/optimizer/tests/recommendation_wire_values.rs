//! The desktop renders recommendation titles and summaries in the reader's
//! language from the typed fields below, not from the English `title`/`summary`
//! (see `apps/desktop/src/components/agents/optimizer-copy.ts`). These tests pin
//! the wire names and numeric values that rendering reads.

use ryu_optimizer::{recommend_model, recommend_tools, ModelScore, Session, Turn};
use serde_json::Value;

fn score(model: &str, quality: f64, cost: u64) -> ModelScore {
    ModelScore {
        model: model.to_owned(),
        quality: Some(quality),
        cost_micro_usd: Some(cost),
        cases: 8,
        errors: 0,
        mean_latency_ms: Some(400),
    }
}

#[test]
fn model_recommendation_json_carries_the_values_its_sentence_needs() {
    let scores = [score("big-model", 0.9, 1_000), score("small-model", 0.88, 250)];
    let rec = recommend_model("agent-1", "big-model", &scores, 0.05, 12, "2026-11-03T00:00:00Z")
        .expect("a cheaper model within tolerance is recommended");
    let json: Value = serde_json::to_value(&rec).unwrap();

    assert_eq!(json["kind"], "model");
    assert_eq!(json["change"]["type"], "set_model");
    assert_eq!(json["change"]["from"], "big-model");
    assert_eq!(json["change"]["to"], "small-model");
    let evidence = &json["evidence"];
    assert_eq!(evidence["cases"], 8);
    assert_eq!(evidence["sessions"], 12);
    // Ratios, not pre-formatted "75%" strings, so the client formats them.
    assert_eq!(evidence["savings"].as_f64(), Some(0.75));
    assert_eq!(evidence["candidateQuality"].as_f64(), Some(0.88));
    assert_eq!(evidence["baselineQuality"].as_f64(), Some(0.9));
    // The English fallback stays for older clients.
    assert_eq!(json["title"], "Switch to small-model");
}

fn session(id: &str, tools: &[&str]) -> Session {
    Session {
        id: id.to_owned(),
        turns: vec![Turn {
            prompt: "hello".to_owned(),
            reference: "hi".to_owned(),
            tools: tools.iter().map(|tool| (*tool).to_owned()).collect(),
        }],
        tool_calls: Vec::new(),
    }
}

#[test]
fn tools_recommendation_json_carries_the_removed_tools_and_session_count() {
    let sessions: Vec<Session> = (0..11)
        .map(|index| session(&format!("s{index}"), &["search.web"]))
        .collect();
    let allowed = ["search.web", "files.read", "mail.send"].map(str::to_owned);
    let rec = recommend_tools("agent-1", &allowed, &sessions, "2026-11-03T00:00:00Z")
        .expect("unused tools are recommended for removal");
    let json: Value = serde_json::to_value(&rec).unwrap();

    assert_eq!(json["kind"], "tools");
    assert_eq!(json["change"]["type"], "remove_tools");
    assert_eq!(
        json["change"]["remove"],
        serde_json::json!(["files.read", "mail.send"])
    );
    assert_eq!(json["evidence"]["sessions"], 11);
    assert_eq!(json["title"], "Remove 2 unused tools");
}
