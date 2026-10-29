use super::*;
use futures_util::StreamExt;

#[tokio::test]
async fn cancelled_stream_releases_actual_pool_load() {
    use ryu_gw_router::pool::{PoolMember, PoolStrategy, ProviderPool};
    let pool = Arc::new(
        ProviderPool::new(
            vec![PoolMember {
                provider: "local".into(),
                model: "model".into(),
                priority: 0,
                weight: 1,
                enabled: true,
                last_resort: false,
            }],
            PoolStrategy::LeastUsed,
        )
        .unwrap(),
    );
    let lease = pool.acquire(0).unwrap();
    assert_eq!(pool.in_flight(0), Some(1));
    let body = hold_pool_load_until_stream_end(
        Body::from_stream(futures_util::stream::pending::<
            Result<axum::body::Bytes, std::io::Error>,
        >()),
        Some(lease),
    );
    drop(body);
    assert_eq!(pool.in_flight(0), Some(0));
}

#[tokio::test]
async fn final_stream_byte_cap_stops_without_replaying_source() {
    let body = Body::from_stream(futures_util::stream::iter(vec![
        Ok::<_, std::io::Error>(axum::body::Bytes::from_static(b"abc")),
        Ok(axum::body::Bytes::from_static(b"def")),
    ]));
    let bounded = bound_pool_stream(
        body,
        tokio::time::Instant::now() + std::time::Duration::from_secs(1),
        4,
    );
    let mut stream = bounded.into_data_stream();
    assert_eq!(
        stream.next().await.unwrap().unwrap(),
        axum::body::Bytes::from_static(b"abc")
    );
    assert!(stream.next().await.unwrap().is_err());
    assert!(stream.next().await.is_none());
}

#[tokio::test]
async fn final_stream_deadline_rejects_a_pending_source() {
    let body = Body::from_stream(futures_util::stream::pending::<
        Result<axum::body::Bytes, std::io::Error>,
    >());
    let bounded = bound_pool_stream(
        body,
        tokio::time::Instant::now() + std::time::Duration::from_millis(5),
        100,
    );
    assert!(bounded.into_data_stream().next().await.unwrap().is_err());
}
