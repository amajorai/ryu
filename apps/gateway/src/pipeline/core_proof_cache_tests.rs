//! The process-global Box org-budget cache stays bounded: an insert at the
//! cap drops expired entries, while fresh entries keep being served.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::{
    box_org_budget, insert_box_budget, BoxBudgetCache, BoxBudgetSource, BoxOrgBudget,
    BOX_BUDGET_CACHE_MAX, BOX_BUDGET_SOURCE_OVERRIDE, BOX_ORG_BUDGET_TTL,
};

fn budget() -> Arc<BoxOrgBudget> {
    Arc::new(serde_json::from_str("{}").expect("empty budget parses"))
}

fn expired_at() -> Instant {
    Instant::now()
        .checked_sub(BOX_ORG_BUDGET_TTL + Duration::from_secs(1))
        .expect("monotonic clock is past one TTL")
}

#[test]
fn insert_at_the_cap_drops_expired_entries() {
    let cache = BoxBudgetCache::new();
    let stale = expired_at();
    for index in 0..BOX_BUDGET_CACHE_MAX {
        cache.insert(format!("stale-{index}"), (stale, budget()));
    }
    insert_box_budget(&cache, "fresh".to_owned(), (Instant::now(), budget()));
    assert_eq!(cache.len(), 1);
    assert!(cache.contains_key("fresh"));
}

#[test]
fn insert_at_the_cap_keeps_fresh_entries() {
    let cache = BoxBudgetCache::new();
    let now = Instant::now();
    for index in 0..BOX_BUDGET_CACHE_MAX {
        cache.insert(format!("live-{index}"), (now, budget()));
    }
    cache.insert("stale".to_owned(), (expired_at(), budget()));
    insert_box_budget(&cache, "fresh".to_owned(), (Instant::now(), budget()));
    assert_eq!(cache.len(), BOX_BUDGET_CACHE_MAX + 1);
    assert!(cache.contains_key("fresh"));
    assert!(cache.contains_key("live-0"));
    assert!(!cache.contains_key("stale"));
}

#[test]
fn insert_below_the_cap_does_not_prune() {
    let cache = BoxBudgetCache::new();
    cache.insert("stale".to_owned(), (expired_at(), budget()));
    insert_box_budget(&cache, "fresh".to_owned(), (Instant::now(), budget()));
    assert_eq!(cache.len(), 2);
}

/// A fake control plane that counts the budget requests it answers.
async fn counting_plane(hits: Arc<AtomicUsize>) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            hits.fetch_add(1, Ordering::SeqCst);
            let mut buffer = [0_u8; 4096];
            let _ = stream.read(&mut buffer).await;
            let body = r#"{"managedInference":true}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
        }
    });
    format!("http://{address}/api")
}

#[tokio::test]
async fn a_fresh_budget_is_served_from_the_cache_within_the_ttl() {
    let hits = Arc::new(AtomicUsize::new(0));
    let url = counting_plane(Arc::clone(&hits)).await;
    BOX_BUDGET_SOURCE_OVERRIDE.with(|cell| {
        *cell.borrow_mut() = Some(BoxBudgetSource {
            url,
            header: "x-ryu-internal-secret",
            secret: "fleet-credits-secret".to_owned(),
        });
    });
    let http = reqwest::Client::new();
    let credits = crate::config::CreditsConfig::default();
    let org = format!("org-cache-{}", uuid::Uuid::new_v4());
    let (first, _) = box_org_budget(&http, &credits, &org, Some("member"))
        .await
        .expect("first budget read");
    let (second, _) = box_org_budget(&http, &credits, &org, Some("member"))
        .await
        .expect("cached budget read");
    BOX_BUDGET_SOURCE_OVERRIDE.with(|cell| *cell.borrow_mut() = None);
    assert!(first.managed_inference);
    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(hits.load(Ordering::SeqCst), 1);
}
