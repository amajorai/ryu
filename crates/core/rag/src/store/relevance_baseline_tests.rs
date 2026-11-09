use super::*;
use std::sync::atomic::AtomicUsize;

/// Loopback `/v1/embeddings` that embeds every input to `vector`, counting
/// requests.
async fn spawn_flat_embeddings_server(vector: [f32; 2]) -> (String, Arc<AtomicUsize>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&requests);
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            counter.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                let mut raw = Vec::new();
                let mut buffer = [0_u8; 4096];
                let body = loop {
                    let read = socket.read(&mut buffer).await.unwrap();
                    raw.extend_from_slice(&buffer[..read]);
                    let text = String::from_utf8_lossy(&raw).to_string();
                    if let Some(split) = text.find("\r\n\r\n") {
                        let length = text[..split]
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|value| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if raw.len() >= split + 4 + length {
                            break raw[split + 4..split + 4 + length].to_vec();
                        }
                    }
                    if read == 0 {
                        return;
                    }
                };
                let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
                let inputs = request["input"].as_array().map_or(1, Vec::len);
                let data: Vec<_> = (0..inputs)
                    .map(|index| serde_json::json!({ "index": index, "embedding": vector }))
                    .collect();
                let payload = serde_json::json!({ "data": data }).to_string();
                let reply = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                let _ = socket.write_all(reply.as_bytes()).await;
            });
        }
    });
    (format!("http://{address}"), requests)
}

#[test]
fn the_two_sides_of_each_probe_share_no_word() {
    for (left, right) in UNRELATED_PROBES {
        let left: HashSet<String> = tokenize(left).into_iter().collect();
        let shared: Vec<String> = tokenize(right)
            .into_iter()
            .filter(|token| left.contains(token))
            .collect();
        assert!(shared.is_empty(), "{left:?} and {right:?} share {shared:?}");
    }
}

#[tokio::test]
async fn the_hashing_embedder_scores_unrelated_text_at_zero() {
    let baseline = measure_unrelated_baseline(&Embedder::Local { dims: 384 })
        .await
        .unwrap();
    assert_eq!(baseline, 0.0);
}

#[test]
fn the_baseline_is_the_closest_pair_kept_inside_its_range() {
    let pairs = vec![
        vec![1.0, 0.0],
        vec![0.0, 1.0],
        vec![1.0, 0.0],
        vec![0.6, 0.8],
    ];
    assert!((baseline_from_pairs(&pairs) - 0.6).abs() < 1e-6);
    let identical = vec![vec![1.0, 0.0], vec![1.0, 0.0]];
    assert_eq!(baseline_from_pairs(&identical), MAX_UNRELATED_BASELINE);
    let opposite = vec![vec![1.0, 0.0], vec![-1.0, 0.0]];
    assert_eq!(baseline_from_pairs(&opposite), 0.0);
    assert_eq!(baseline_from_pairs(&[]), 0.0);
}

#[tokio::test]
async fn a_remote_baseline_is_measured_once_and_cached() {
    let (url, requests) = spawn_flat_embeddings_server([0.8, 0.6]).await;
    let embedder = Embedder::remote(&url, "baseline-cache-probe", 2, None);
    let store =
        RetrievalStore::open_in_memory_with_embedder(embedder, "rerank".to_owned()).unwrap();

    let first = store.unrelated_similarity_baseline().await.unwrap();
    let second = store.unrelated_similarity_baseline().await.unwrap();

    assert_eq!(first, MAX_UNRELATED_BASELINE);
    assert_eq!(second, first);
    assert_eq!(
        requests.load(Ordering::SeqCst),
        1,
        "one batch, then the cache"
    );
}

#[tokio::test]
async fn a_failed_measurement_is_an_error_and_is_not_cached() {
    let unreachable = Embedder::remote("http://127.0.0.1:1", "baseline-failure-probe", 2, None);
    let store =
        RetrievalStore::open_in_memory_with_embedder(unreachable, "rerank".to_owned()).unwrap();
    assert!(store.unrelated_similarity_baseline().await.is_err());

    let (url, _) = spawn_flat_embeddings_server([1.0, 0.0]).await;
    store.set_embedder(Embedder::remote(&url, "baseline-failure-probe", 2, None));
    assert_eq!(
        store.unrelated_similarity_baseline().await.unwrap(),
        MAX_UNRELATED_BASELINE
    );
}
