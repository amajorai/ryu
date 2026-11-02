//! Admission item limits and role-sized items: nothing a request sends is
//! dropped or left unread because of its size.

use std::sync::Arc;

use ryu_gw_screening::backends::test::{TestBackend, SENTINEL_HAZARD_S9};
use ryu_gw_screening::estimate_tokens;
use serde_json::{json, Value};

use super::fixture::ctx;
use super::health_tests::{attack_backend, attack_floor, chat, node_state};
use super::{screen_chat, Surface};
use crate::error::GatewayError;

/// A node never drops the tail past the item limit: the newest message (and
/// the decoded forms appended last) would go unread.
#[tokio::test]
async fn a_node_refuses_past_the_item_limit_instead_of_truncating() {
    let node = node_state(
        "node_fail_mode = \"degraded\"",
        Arc::new(TestBackend::new("decision_local")),
    );
    let mut messages: Vec<Value> = (0..330)
        .map(|i| {
            let role = if i % 2 == 0 { "user" } else { "assistant" };
            json!({ "role": role, "content": format!("filler message {i}") })
        })
        .collect();
    messages.push(json!({ "role": "user", "content": SENTINEL_HAZARD_S9 }));
    let body = json!({ "messages": messages });
    let result = screen_chat(&node, &ctx("node-items"), &body, Surface::Chat).await;
    assert!(
        matches!(
            result,
            Err(GatewayError::ScreeningCapacityExceeded | GatewayError::ContentBlocked(_))
        ),
        "{:?}",
        result.map(|r| r.blocked)
    );
}

/// A prompt-attack backend that reads 1,024 tokens (the inspector) is sent
/// every part of a long prompt in items it can read, never skipped as too
/// large and left unjudged.
#[tokio::test]
async fn a_prompt_attack_backend_reads_long_prompts_in_items_it_fits() {
    let attack = Arc::new(attack_backend().max_item_tokens(1_024));
    let state = attack_floor(Arc::clone(&attack), json!({}));
    let prompt = format!(
        "{} TAILMARKER",
        "the quick brown fox jumps over the lazy dog ".repeat(160)
    );
    let report = screen_chat(&state, &ctx("attack-long"), &chat(&prompt), Surface::Chat)
        .await
        .expect("screened");
    assert_eq!(report.degraded, None);
    let seen = attack.seen();
    assert!(
        !seen.is_empty(),
        "the long prompt never reached the backend"
    );
    assert!(seen.iter().all(|text| estimate_tokens(text) <= 1_024));
    assert!(seen.iter().any(|text| text.contains("TAILMARKER")));
}
