use super::super::{OnlineEvalsConfig, LOCAL_TENANT};
use super::*;
use crate::EvaluatorScore;

fn enabled_config() -> OnlineEvalsConfig {
    OnlineEvalsConfig {
        enabled: true,
        sample_rate: 0.5,
        evaluators: vec!["pii_leakage".to_owned()],
        ..OnlineEvalsConfig::default()
    }
}

fn job(request_id: &str) -> OnlineEvalJob {
    OnlineEvalJob {
        request_id: request_id.to_owned(),
        trace_id: None,
        tenant: LOCAL_TENANT.to_owned(),
        agent_id: Some("agent-a".to_owned()),
        model: "m".to_owned(),
        provider: "p".to_owned(),
        prompt: "hi".to_owned(),
        response: "hello".to_owned(),
        evaluators: vec!["pii_leakage".to_owned()],
        judge_model: None,
        max_judge_calls_per_minute: 1,
        enqueued_at_ms: 1,
        context: (),
    }
}

fn score(id: &str, pass: bool, executed: bool) -> EvaluatorScore {
    EvaluatorScore {
        id: id.to_owned(),
        category: "security".to_owned(),
        score: if pass { 1.0 } else { 0.0 },
        pass,
        detail: String::new(),
        executed,
    }
}

#[tokio::test]
async fn bounded_queue_drops_when_full() {
    let mut config = enabled_config();
    config.queue_capacity = 1;
    let (online, receiver) = OnlineEvals::<()>::new(&config);
    let mut receiver = receiver.expect("enabled config creates a queue");
    assert_eq!(online.offer(job("a")), OfferOutcome::Enqueued);
    assert_eq!(online.offer(job("b")), OfferOutcome::QueueFull);
    assert_eq!(receiver.recv().await.expect("job").request_id, "a");
    assert_eq!(online.offer(job("c")), OfferOutcome::Enqueued);
    let stats = online.stats();
    assert_eq!(stats.enqueued, 2);
    assert_eq!(stats.dropped_queue_full, 1);
}

#[test]
fn disabled_config_has_no_queue() {
    let (online, receiver) = OnlineEvals::<()>::new(&OnlineEvalsConfig::default());
    assert!(receiver.is_none());
    assert!(!online.is_running());
    assert_eq!(online.offer(job("a")), OfferOutcome::Closed);
}

#[test]
fn judge_budget_is_per_tenant_and_windowed() {
    let (online, _rx) = OnlineEvals::<()>::new(&enabled_config());
    assert!(online.try_acquire_judge("t1", 2, 0));
    assert!(online.try_acquire_judge("t1", 2, 10));
    assert!(!online.try_acquire_judge("t1", 2, 20));
    assert!(online.try_acquire_judge("t2", 2, 20));
    assert!(online.try_acquire_judge("t1", 2, 60_000));
    assert!(!online.try_acquire_judge("t3", 0, 0));
    assert_eq!(online.stats().judge_budget_skipped, 2);
}

#[test]
fn store_is_bounded_and_queryable_newest_first() {
    let mut config = enabled_config();
    config.store_capacity = 2;
    let (online, _rx) = OnlineEvals::<()>::new(&config);
    let mut first = job("r1");
    first.trace_id = Some("t".repeat(32));
    online.record(OnlineEvalRecord::from_job(
        &first,
        vec![score("pii_leakage", true, true)],
        2,
    ));
    online.record(OnlineEvalRecord::from_job(
        &job("r2"),
        vec![
            score("pii_leakage", false, true),
            score("toxicity", false, false),
        ],
        3,
    ));
    online.record(OnlineEvalRecord::from_job(
        &job("r3"),
        vec![score("pii_leakage", true, true)],
        4,
    ));
    let all = online.query(&OnlineEvalQuery::default());
    assert_eq!(
        all.iter()
            .map(|r| r.request_id.as_str())
            .collect::<Vec<_>>(),
        vec!["r3", "r2"]
    );
    let failed = online.query(&OnlineEvalQuery {
        failed_only: true,
        ..OnlineEvalQuery::default()
    });
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0].request_id, "r2");
    assert!(!failed[0].pass);
    let by_eval = online.query(&OnlineEvalQuery {
        evaluator: Some("toxicity".to_owned()),
        ..OnlineEvalQuery::default()
    });
    assert_eq!(by_eval.len(), 1);
    assert_eq!(online.stats().stored, 2);
    assert_eq!(online.stats().scored, 3);
}
